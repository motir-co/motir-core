import type { Prisma } from '@/generated/prisma/client';
import { toPlanItemDto } from '@/lib/mappers/planMappers';
import { UNDECIDED_PLAN_STATUSES } from '@/lib/planChange/sessionWaitingState';
import { carryOverVerdict, type CarryOverVerdict } from '@/lib/plans/authorFinishedCarryOver';
import { requireExplanationFor } from '@/lib/plans/planProgress';
import { DEFAULT_PROPOSED_KIND } from '@/lib/plans/validateProposals';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { sectionFindingsFor } from '@/lib/workItems/sections/validity';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// CARRY THE PLANS ALREADY OPEN OVER TO `authorFinished` (Task MOTIR-10491).
//
// ── Why a carry-over is owed ────────────────────────────────────────────────
// MOTIR-10490 stores `authorFinished` on a proposal; a driver sends it when an
// author session finishes, and core stamps a card written by hand. A card that
// was finished BEFORE that shipped carries no key, and nothing will ever send it:
// its session has already ended. Once the readers switch to the stored state,
// every such card on an open plan reads as unwritten and the next resume authors
// it again from scratch. This sweep records the state on those cards, once.
//
// ── ONE PREDICATE FOR BOTH RUNS ─────────────────────────────────────────────
// Which card is stamped is `carryOverVerdict` (`lib/plans/authorFinishedCarryOver.ts`),
// and the dry run and the real run make the SAME reads and ask it the same
// question. The dry run then writes nothing, so it predicts the real run exactly.
//
// ── IT STAMPS ONE KEY AND NOTHING ELSE ──────────────────────────────────────
// The write goes straight to `planItemRepository.update`, adding `authorFinished:
// true` to the proposed fields it just read. No door runs, so no plan activity
// moves, no revision row is written and the plan keeps its status. `PlanItem` has
// no updated-at column. The plan gate's digest leaves the key out
// (`planApprovalDigest.ts`), so a reader holding a `planned` plan open is not
// refused as stale when it presses Approve.
//
// ── UNDER THE PLAN LOCK ─────────────────────────────────────────────────────
// A stamp rewrites the WHOLE proposed-fields object, so it is a read-derived
// write: fields read before the lock could put back a body a door has just
// changed. The real run takes `planRepository.lockById` — the lock every door
// takes — and re-reads the plan and its proposals under it. A plan that left
// the undecided statuses after the scan is counted `noLongerOpen` and left alone.
//
// ── LIVE STEPS ──────────────────────────────────────────────────────────────
// Steps are read only on a `generating` plan: a row left on a plan that closed
// is not a live session (the same rule as MOTIR-10490's hand-stamp). A card a
// session is writing is that session's driver's to state.
//
// ── ONE TRANSACTION PER PLAN, CROSS-TENANT, UNDER RLS ───────────────────────
// The scan reads `plan` under `withSystemContext` (its `plan_system_read` arm).
// Each plan's transaction then BINDS that plan's workspace before its first
// tenant statement: `plan_item`, `plan_step` and `project` are tenant reads, and
// an unbound read returns ZERO ROWS, which would read as an empty plan. A plan
// that fails is recorded and the sweep moves on; its transaction rolls back and
// nobody else's does. An interrupted run keeps every stamp it wrote, and a
// re-run finds those cards `already_has_state`.
//
// Modelled on `planGateBackfillService` (MOTIR-6039).

/** One plan the sweep stamped (or, dry, would stamp) at least one card on. */
export interface AuthorFinishedBackfillPlan {
  planId: string;
  workspaceId: string;
  projectId: string;
  /** The plan's status as read under its own transaction. */
  status: string;
  /** The `PlanItem` ids stamped — or, dry, that a real run would stamp. */
  stamped: string[];
}

export interface AuthorFinishedBackfillFailure {
  planId: string;
  workspaceId: string;
  error: string;
}

/** The card counts by verdict — every verdict but `stamp`, which is listed per plan. */
export interface AuthorFinishedCardCounts {
  stamp: number;
  alreadyHasState: number;
  inFlight: number;
  notComplete: number;
  boundaryOnly: number;
  /** A `modify` or `remove`: never stamped. */
  notAdd: number;
}

/** Per-workspace tallies — what an operator reads before applying. */
export interface AuthorFinishedBackfillWorkspaceCounts extends AuthorFinishedCardCounts {
  workspaceId: string;
  /** Undecided plans examined in this workspace. */
  examined: number;
  /** Left the undecided statuses between the scan and their own transaction. */
  noLongerOpen: number;
  failed: number;
}

export interface AuthorFinishedBackfillReport extends AuthorFinishedCardCounts {
  dryRun: boolean;
  /** Undecided plans the scan found. */
  total: number;
  /** Plans the sweep reached (all of them, unless interrupted). */
  examined: number;
  /** Every plan with at least one stamp, in scan order. */
  plans: AuthorFinishedBackfillPlan[];
  noLongerOpen: number;
  failed: AuthorFinishedBackfillFailure[];
  byWorkspace: AuthorFinishedBackfillWorkspaceCounts[];
  /** True when `signal` stopped the sweep before every candidate was reached. */
  interrupted: boolean;
}

export interface AuthorFinishedBackfillProgress {
  examined: number;
  total: number;
  stamped: number;
  failed: number;
}

export const AUTHOR_FINISHED_BACKFILL_PROGRESS_EVERY = 100;

export interface AuthorFinishedBackfillOptions {
  dryRun: boolean;
  /** Narrow to one tenant; omitted = every workspace. */
  workspaceId?: string;
  onProgress?: (progress: AuthorFinishedBackfillProgress) => void;
  progressEvery?: number;
  /** Checked BEFORE each plan; once aborted, the partial report is returned. */
  signal?: AbortSignal;
}

type CandidatePlan = Awaited<
  ReturnType<typeof planRepository.listOpenForAuthorFinishedBackfill>
>[number];

type PlanOutcome =
  | { kind: 'no_longer_open' }
  | { kind: 'judged'; status: string; verdicts: Array<{ id: string; verdict: CarryOverVerdict }> };

const UNDECIDED: ReadonlySet<string> = new Set(UNDECIDED_PLAN_STATUSES);

const VERDICT_COUNTER: Record<CarryOverVerdict, keyof AuthorFinishedCardCounts> = {
  stamp: 'stamp',
  already_has_state: 'alreadyHasState',
  in_flight: 'inFlight',
  not_complete: 'notComplete',
  boundary_only: 'boundaryOnly',
  skipped: 'notAdd',
};

const emptyCardCounts = (): AuthorFinishedCardCounts => ({
  stamp: 0,
  alreadyHasState: 0,
  inFlight: 0,
  notComplete: 0,
  boundaryOnly: 0,
  notAdd: 0,
});

/**
 * Judge every proposal of ONE plan — and, unless `dryRun`, stamp the finished
 * ones — inside the caller's transaction, with the plan's workspace already bound.
 */
async function judgePlan(
  plan: CandidatePlan,
  dryRun: boolean,
  tx: Prisma.TransactionClient,
): Promise<PlanOutcome> {
  // The real run writes from what it reads, so it reads under the doors' lock.
  if (!dryRun) await planRepository.lockById(plan.id, tx);
  const fresh = await planRepository.findById(plan.id, plan.workspaceId, tx);
  if (!fresh || !UNDECIDED.has(fresh.status)) return { kind: 'no_longer_open' };

  const rows = await planItemRepository.findByPlan(plan.id, tx);
  const items = rows.map(toPlanItemDto);
  const settings =
    fresh.authorSource === 'mcp'
      ? null
      : await projectRepository.findAiSettings(fresh.projectId, tx);
  const requireExplanation = requireExplanationFor({
    authorSource: fresh.authorSource,
    projectAiGenerateExplanations: settings?.aiGenerateExplanations ?? false,
  });
  const steps =
    fresh.status === 'generating' ? await planStepRepository.listByPlan(plan.id, tx) : [];
  const liveAuthorTargets = new Set(
    steps.filter((s) => s.kind === 'author' && s.targetRef !== null).map((s) => s.targetRef!),
  );
  const findingRefs = new Set(
    sectionFindingsFor(
      items
        .filter((i) => i.op === 'add')
        .map((i) => {
          const f = (i.proposedFields ?? {}) as Record<string, unknown>;
          return {
            item: `planItem:${i.id}`,
            kind: typeof f.kind === 'string' ? f.kind : DEFAULT_PROPOSED_KIND,
            type: typeof f.type === 'string' ? f.type : null,
            descriptionMd: typeof f.descriptionMd === 'string' ? f.descriptionMd : null,
          };
        }),
    ).map((finding) => finding.item),
  );

  const verdicts: Array<{ id: string; verdict: CarryOverVerdict }> = [];
  for (const [index, item] of items.entries()) {
    const verdict = carryOverVerdict({
      item,
      items,
      findingRefs,
      requireExplanation,
      liveAuthorTargets,
    });
    verdicts.push({ id: item.id, verdict });
    if (verdict !== 'stamp' || dryRun) continue;
    // The STORED object, not the DTO's redacted read of it: one key is added and
    // every other byte of the row stays as it was.
    const stored = (rows[index]!.proposedFields ?? {}) as Record<string, unknown>;
    await planItemRepository.update(
      item.id,
      { proposedFields: { ...stored, authorFinished: true } as Prisma.InputJsonValue },
      tx,
    );
  }
  return { kind: 'judged', status: fresh.status, verdicts };
}

export const planAuthorFinishedBackfillService = {
  /**
   * Stamp `authorFinished: true` on every finished `add` of every undecided plan
   * that carries no state yet — or, `dryRun`, report exactly which cards a real
   * run would stamp, writing nothing.
   */
  async backfill(opts: AuthorFinishedBackfillOptions): Promise<AuthorFinishedBackfillReport> {
    const candidates = await withSystemContext((tx) =>
      planRepository.listOpenForAuthorFinishedBackfill(
        opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
        tx,
      ),
    );

    const report: AuthorFinishedBackfillReport = {
      dryRun: opts.dryRun,
      total: candidates.length,
      examined: 0,
      plans: [],
      ...emptyCardCounts(),
      noLongerOpen: 0,
      failed: [],
      byWorkspace: [],
      interrupted: false,
    };
    const perWorkspace = new Map<string, AuthorFinishedBackfillWorkspaceCounts>();
    const countsOf = (workspaceId: string) => {
      let counts = perWorkspace.get(workspaceId);
      if (!counts) {
        counts = { workspaceId, examined: 0, ...emptyCardCounts(), noLongerOpen: 0, failed: 0 };
        perWorkspace.set(workspaceId, counts);
      }
      return counts;
    };
    const every = Math.max(1, opts.progressEvery ?? AUTHOR_FINISHED_BACKFILL_PROGRESS_EVERY);

    for (const plan of candidates) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      const counts = countsOf(plan.workspaceId);
      report.examined += 1;
      counts.examined += 1;
      try {
        const outcome = await withSystemContext(async (tx) => {
          // ⚠️ BIND BEFORE THE FIRST TENANT STATEMENT (see the header).
          await bindWorkspaceContext(tx, plan.workspaceId);
          return judgePlan(plan, opts.dryRun, tx);
        });

        if (outcome.kind === 'no_longer_open') {
          counts.noLongerOpen += 1;
          report.noLongerOpen += 1;
          continue;
        }
        const stamped: string[] = [];
        for (const { id, verdict } of outcome.verdicts) {
          const counter = VERDICT_COUNTER[verdict];
          counts[counter] += 1;
          report[counter] += 1;
          if (verdict === 'stamp') stamped.push(id);
        }
        if (stamped.length > 0) {
          report.plans.push({
            planId: plan.id,
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            status: outcome.status,
            stamped,
          });
        }
      } catch (err) {
        counts.failed += 1;
        report.failed.push({
          planId: plan.id,
          workspaceId: plan.workspaceId,
          /* v8 ignore next -- `catch` binds `unknown`; every throw on this path is an Error. */
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (
          opts.onProgress &&
          (report.examined % every === 0 || report.examined === candidates.length)
        ) {
          opts.onProgress({
            examined: report.examined,
            total: candidates.length,
            stamped: report.stamp,
            failed: report.failed.length,
          });
        }
      }
    }

    report.byWorkspace = [...perWorkspace.values()].sort((a, b) =>
      a.workspaceId < b.workspaceId ? -1 : 1,
    );
    return report;
  },
};
