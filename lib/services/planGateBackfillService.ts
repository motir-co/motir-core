import { resolvePlanGateRoute } from '@/lib/approvalGates/planApprovalHandler';
import { planRepository } from '@/lib/repositories/planRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { planGateService, type PlanGateAssessment } from './planGateService';

// BACKFILL THE PLAN GATES FOR PLANS ALREADY `planned` (Story MOTIR-6012 · Subtask
// MOTIR-6039; ADR `approval-gates.md` §11.9).
//
// ── Why a backfill is owed ──────────────────────────────────────────────────
// MOTIR-6036 raises a plan's `plan_approval` gate when the plan reaches `planned`.
// A plan that was ALREADY `planned` when that shipped has no gate, so it is missing
// from To approve and — after the decide doors (MOTIR-6038) — reads as "not
// decidable yet". No future event will fix it: the close that raises has happened.
//
// ── IT NEVER RE-IMPLEMENTS THE RAISE ────────────────────────────────────────
// Each plan is handed to `planGateService.raise` — the SAME function `markPlanned`
// calls — which takes the plan lock itself (plan row, then gate row, §11.5), routes
// per §11.6, stamps the digest and inserts through the card-less awaiting-uniqueness
// index. A raise written here in SQL would be a second opinion about the gate, and
// the two would drift on the first amendment to either.
//
// ── `--dry-run` PREDICTS THE REAL RUN ───────────────────────────────────────
// The dry run asks `planGateService.assess`, which shares the raise's own "is this
// plan a question?" predicate and adds only the awaiting-row read the raise's
// `ON CONFLICT DO NOTHING` would collide with. So the population the dry run counts
// and the population the real run raises are one predicate, not two.
//
// ── ONE TRANSACTION PER PLAN ────────────────────────────────────────────────
// A plan that fails is recorded with its error and the sweep moves on; its own
// transaction rolls back and nobody else's does. An interrupted run keeps every gate
// it already raised, and the re-run resumes from the rest — IDEMPOTENT BY THE INDEX:
// a plan that already has an awaiting gate is a no-op.
//
// ── CROSS-TENANT, UNDER RLS ─────────────────────────────────────────────────
// The candidate scan reads `plan` under `withSystemContext` (its `plan_system_read`
// arm). Every per-plan transaction then BINDS the plan's own workspace before its
// first statement, because `plan_item`, `approval_gate` and `workspace_membership`
// (the owner route) are tenant tables: an unbound read there returns ZERO ROWS and
// raises nothing, which would read as "no proposals" and silently skip the plan.

/** One plan the sweep raised (or, dry, would raise). */
export interface PlanGateBackfillRaise {
  planId: string;
  workspaceId: string;
  projectId: string;
  /** Who the gate is (would be) routed to — null when the workspace has no owner. */
  routedToId: string | null;
}

export interface PlanGateBackfillFailure {
  planId: string;
  workspaceId: string;
  error: string;
}

/** Per-workspace tallies — what an operator reads before applying. */
export interface PlanGateBackfillWorkspaceCounts {
  workspaceId: string;
  /** `planned` plans examined in this workspace. */
  examined: number;
  /** Gates raised — or, dry, that a real run would raise. */
  raise: number;
  alreadyAwaiting: number;
  noProposals: number;
  /** Bug MOTIR-11701: `planned`, but its walk is owed a card — asked nothing. */
  walkIncomplete: number;
  /** Left `planned` between the scan and its own transaction. */
  notPlanned: number;
  failed: number;
}

export interface PlanGateBackfillReport {
  dryRun: boolean;
  /** `planned` plans the scan found. */
  total: number;
  /** Plans the sweep reached (all of them, unless interrupted). */
  examined: number;
  raised: PlanGateBackfillRaise[];
  alreadyAwaiting: number;
  noProposals: number;
  /** Bug MOTIR-11701: `planned` plans whose walk is owed a card — never asked. */
  walkIncomplete: number;
  notPlanned: number;
  failed: PlanGateBackfillFailure[];
  byWorkspace: PlanGateBackfillWorkspaceCounts[];
  /** True when `signal` stopped the sweep before every candidate was reached. */
  interrupted: boolean;
}

export interface PlanGateBackfillProgress {
  examined: number;
  total: number;
  raised: number;
  failed: number;
}

export const PLAN_GATE_BACKFILL_PROGRESS_EVERY = 100;

export interface PlanGateBackfillOptions {
  dryRun: boolean;
  /** Narrow to one tenant; omitted = every workspace. */
  workspaceId?: string;
  onProgress?: (progress: PlanGateBackfillProgress) => void;
  progressEvery?: number;
  /** Checked BEFORE each plan; once aborted, the partial report is returned. */
  signal?: AbortSignal;
}

type Outcome =
  | { kind: 'raise'; routedToId: string | null }
  | { kind: Exclude<PlanGateAssessment, 'raise'> };

export const planGateBackfillService = {
  /**
   * Raise the missing `plan_approval` gate on every `planned` plan with at least one
   * proposal and no awaiting gate — or, `dryRun`, report exactly which plans a real
   * run would raise, writing nothing.
   */
  async backfill(opts: PlanGateBackfillOptions): Promise<PlanGateBackfillReport> {
    const candidates = await withSystemContext((tx) =>
      planRepository.listPlannedForGateBackfill(
        opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
        tx,
      ),
    );

    const report: PlanGateBackfillReport = {
      dryRun: opts.dryRun,
      total: candidates.length,
      examined: 0,
      raised: [],
      alreadyAwaiting: 0,
      noProposals: 0,
      walkIncomplete: 0,
      notPlanned: 0,
      failed: [],
      byWorkspace: [],
      interrupted: false,
    };
    const perWorkspace = new Map<string, PlanGateBackfillWorkspaceCounts>();
    const countsOf = (workspaceId: string) => {
      let counts = perWorkspace.get(workspaceId);
      if (!counts) {
        counts = {
          workspaceId,
          examined: 0,
          raise: 0,
          alreadyAwaiting: 0,
          noProposals: 0,
          walkIncomplete: 0,
          notPlanned: 0,
          failed: 0,
        };
        perWorkspace.set(workspaceId, counts);
      }
      return counts;
    };
    const every = Math.max(1, opts.progressEvery ?? PLAN_GATE_BACKFILL_PROGRESS_EVERY);

    for (const plan of candidates) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      const counts = countsOf(plan.workspaceId);
      report.examined += 1;
      counts.examined += 1;
      try {
        const outcome = await withSystemContext(async (tx): Promise<Outcome> => {
          // ⚠️ BIND BEFORE THE FIRST TENANT STATEMENT (see the header).
          await bindWorkspaceContext(tx, plan.workspaceId);
          if (opts.dryRun) {
            const verdict = await planGateService.assess(plan, tx);
            return verdict === 'raise'
              ? { kind: 'raise', routedToId: await resolvePlanGateRoute(plan, tx) }
              : { kind: verdict };
          }
          const result = await planGateService.raise(plan, tx);
          if (result.raised) return { kind: 'raise', routedToId: result.gate!.routedToId };
          // Not raised: classify under the lock `raise` took in THIS transaction, so the
          // answer is the one the raise acted on. Under that lock a question with no
          // awaiting row cannot exist — the raise would have inserted it.
          const verdict = await planGateService.assess(plan, tx);
          /* v8 ignore next 3 -- an invariant guard: reaching it means `raise` and
             `assess` disagree, which is exactly the drift this pair exists to prevent;
             it is reported as a FAILURE rather than silently counted. */
          if (verdict === 'raise') {
            throw new Error('raise skipped a plan that assess says needs a gate');
          }
          return { kind: verdict };
        });

        switch (outcome.kind) {
          case 'raise':
            counts.raise += 1;
            report.raised.push({
              planId: plan.id,
              workspaceId: plan.workspaceId,
              projectId: plan.projectId,
              routedToId: outcome.routedToId,
            });
            break;
          case 'already_awaiting':
            counts.alreadyAwaiting += 1;
            report.alreadyAwaiting += 1;
            break;
          case 'no_proposals':
            counts.noProposals += 1;
            report.noProposals += 1;
            break;
          case 'walk_incomplete':
            counts.walkIncomplete += 1;
            report.walkIncomplete += 1;
            break;
          case 'not_planned':
            counts.notPlanned += 1;
            report.notPlanned += 1;
            break;
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
            raised: report.raised.length,
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
