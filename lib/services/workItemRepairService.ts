import type {
  AcceptanceRefusalDto,
  OpenRepairRunDto,
  RepairCloseOutcome,
  RepairPullRequestDto,
  ReviewRefusalDto,
  WorkItemRepairClaimDto,
  WorkItemRepairClass,
  WorkItemRepairRefusal,
  WorkItemRepairRunDto,
  WorkItemRepairViewDto,
} from '@/lib/dto/workItemRepair';
import type { ClaimActorDto } from '@/lib/dto/claim';
import type { DispatchRun, DispatchStopReason, Prisma } from '@/generated/prisma/client';
import { readStandingReviewRefusal } from '@/lib/approvalGates/reviewRefusal';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import { dispatchRunLabel } from '@/lib/howToTest/author';
import { toOpenRepairRuns } from '@/lib/mappers/repairRunMappers';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import {
  DispatchRunAgentBusyError,
  DispatchRunTerminalError,
  RepairRunRefusedError,
} from '@/lib/dispatchRuns/errors';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { evaluateRepair } from '@/lib/services/repairPredicate';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464) — hand an `implemented` card's
// red pull requests to ONE fixing agent, after the run that opened them has ended.
// Since MOTIR-5803 it also takes an `in_review` card the merge queue EJECTED (a
// standing failure exit at a member's head), where a manual ejection now leaves it —
// and since MOTIR-7491 an `in_review` card with a member red or conflicted at its head,
// which a hand move to In Review can leave there with nothing holding it back.
//
// ── Why the keyed claim cannot do it ────────────────────────────────────────
// `workItemsService.claimWorkItem` admits the to-do category (or the caller's own
// `in_progress`) and FLIPS the card to `in_progress`. An `implemented` card is
// `not_claimable` there, and moving it would say the work was never finished —
// which contradicts `packages/cli/src/ciWatch.ts`'s rule that red CI leaves a card
// at `implemented`. So a repair is recorded as a dispatch RUN (command `fix`), and
// the run's open state is the lock. Nothing here writes the card's status or its
// assignee; `ciPromotion` moves the card when the build goes green.
//
// ── An acceptance sent back with Re-run is a repair too (MOTIR-6502) ────────
// A story run whose acceptance video was refused with **Re-run** has GREEN checks and
// is admitted as the `acceptance_rerun` class (`acceptance-refusal-verdict.md` §4):
// every open member is handed over with the reviewer's reason, and the class ends when
// a newer receipt asks again (`lib/approvalGates/acceptanceRefusal.ts`).
//
// ── Why one transaction under the CARD's lock ───────────────────────────────
// The lock read is "is an open `fix` run holding this card?", and it guards the
// insert of exactly that run. Both claimants lock the card's row first, so the
// second one waits for the first one's COMMIT and then reads the run it wrote —
// which is what lets `taken` name the holder, and what keeps it to ONE run.
// `lockById` filters on `id` alone, for the reason `claimWorkItem` records.
//
// ── The PREDICATE is `repairPredicate.evaluateRepair` ───────────────────────
// Both methods below decide through it, and so does the stored `WorkItem.fixReason`
// (MOTIR-6600) — three readers, one rule, which is why it is not in this file.

/** A refusal: no run, no pull requests, only the reason. */
function refused(
  item: { identifier: string; title: string },
  reason: WorkItemRepairRefusal,
  runTargetKey: string | null = null,
): WorkItemRepairClaimDto {
  return {
    key: item.identifier,
    title: item.title,
    outcome: 'not_repairable',
    reason,
    runTargetKey,
    runId: null,
    holder: null,
    startedAt: null,
    repairClass: 'ci',
    acceptanceRefusal: null,
    reviewRefusal: null,
    pullRequests: [],
  };
}

/** The `attempts` a `ci_gave_up` event carries, or null when it carries none. */
function attemptsOf(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null;
  const attempts = (data as { attempts?: unknown }).attempts;
  return typeof attempts === 'number' && Number.isInteger(attempts) ? attempts : null;
}

/**
 * How an agent's repair outcome is recorded — the CLI's `CI_WATCH_STOP_REASON`
 * vocabulary (`packages/cli/src/commands/dispatch.ts`), so the item page reads a
 * repair closed over the MCP exactly as it reads a `motir fix` one: `halted` is a
 * `failed` run, which the Development block draws as *gave up*.
 */
export const REPAIR_CLOSE_STOP_REASON = {
  green: 'completed',
  gave_up: 'halted',
  halted: 'halted',
  interrupted: 'interrupted',
} as const satisfies Record<RepairCloseOutcome, DispatchStopReason>;

function toRepairRunDto(key: string, run: DispatchRun): WorkItemRepairRunDto {
  return {
    key,
    runId: run.id,
    open: run.status === 'running',
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
  };
}

const refOf = (pr: RepairPullRequestDto) => ({
  repo: pr.repo,
  number: pr.number,
  ci: pr.ci,
  queueExit:
    pr.queueExit === null
      ? null
      : {
          rawReason: pr.queueExit.rawReason,
          disposition: pr.queueExit.disposition,
          failingCheckName: pr.queueExit.failingCheckName,
        },
  conflict: pr.conflicted ? { baseRef: pr.baseRef } : null,
  outOfDate: pr.outOfDate ? { baseRef: pr.baseRef } : null,
});

/**
 * A HOSTED repair's opening (Story MOTIR-1626 · MOTIR-6928; `hosted-agent-run.md` §8.6).
 * The hosted start hands it to the claim so the lock it takes IS the hosted run: one
 * `fix` row, recorded `origin: 'hosted'` with the agent and model it runs on, and
 * idempotent on the start's key — the continue claim's hosted opening (MOTIR-6790),
 * for the repair. Server-internal: the v1 repair route never accepts one.
 */
export interface HostedRepairOpening {
  origin: 'hosted';
  agent: 'opencode';
  model: string;
  idempotencyKey: string;
}

/**
 * A repair opened in the person's OWN agent (Story MOTIR-8981 · MOTIR-9049): the
 * `instance` twin of {@link HostedRepairOpening}. The claim opens the run the agent will
 * execute — `fix`, `origin: 'instance'`, carrying the agent instance and its profile — so
 * the lock and the run are one insert under the card's row lock. `agent` is the instance's
 * `profileId`, never a literal.
 */
export interface AgentRepairOpening {
  origin: 'instance';
  agent: string;
  model?: string | null | undefined;
  agentInstanceId: string;
  idempotencyKey: string;
  /**
   * The card's last run's agent profile and recorded session, read BEFORE this run opened
   * (Story MOTIR-8981 · MOTIR-9052) — what the CLI needs to resume that conversation
   * instead of starting a fresh one. Null when the card has no earlier agent run.
   */
  resume?: { profile: string; sessionId: string | null; canResume: boolean } | null | undefined;
}

export interface ClaimRepairOptions {
  opening?: HostedRepairOpening | AgentRepairOpening | undefined;
  /**
   * Asked under the lock with the class the claim is about to open a run for, BEFORE
   * anything is written; a throw aborts the claim with nothing written. The hosted
   * start refuses every class but `review` through it (§12.4b), so a card whose class
   * changed between its preview and the lock never gets a hosted run.
   */
  admit?: ((repairClass: WorkItemRepairClass) => void) | undefined;
  /** Told when the opening's key was ALREADY used: the answer replays that run, so a
   *  hosted start racing its own repeat never boots it a second container. */
  onReplay?: ((runId: string) => void) | undefined;
}

/**
 * What a hosted repair's preview found (MOTIR-6928) — the claim's own evaluation and
 * its lock read, WITHOUT the lock and writing nothing. The claim decides again under
 * its lock; this is a pre-flight, never the decision.
 */
export type HostedRepairPreview =
  | {
      ok: true;
      key: string;
      workItemId: string;
      repairClass: WorkItemRepairClass;
      pullRequests: RepairPullRequestDto[];
    }
  | {
      ok: false;
      key: string;
      /** `taken` — an open `fix` run holds the card (whoever's, the caller's included). */
      refusal:
        | { kind: 'not_repairable'; reason: WorkItemRepairRefusal; runTargetKey: string | null }
        | { kind: 'not_sent_back'; repairClass: WorkItemRepairClass }
        | { kind: 'taken'; holder: ClaimActorDto | null; startedAt: string };
    };

/** One pull request as a hosted repair's `run_opened` records it — the claim's row,
 *  with its OWN branch named as such and the head it was handed at. */
interface RecordedRepairPullRequest extends RepairPullRequestDto {
  branch: string;
  headSha: string | null;
}

/**
 * What a repair's claim DECIDED, as its ONE `run_opened` records it (MOTIR-6928)
 * — so the container ADOPTS the run and reads the decision back rather than claiming a
 * second time (the continue precedent, MOTIR-6795): the class, every pull request on its
 * own branch at its head, and the findings with who decided them and under what authority.
 */
async function repairOpenedData(
  item: { id: string; identifier: string; title: string },
  opening: HostedRepairOpening | AgentRepairOpening,
  decided: {
    repairClass: WorkItemRepairClass;
    pullRequests: RepairPullRequestDto[];
    reviewRefusal: ReviewRefusalDto | null;
    acceptanceRefusal: AcceptanceRefusalDto | null;
  },
  tx: Prisma.TransactionClient,
): Promise<Prisma.InputJsonObject> {
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
  const headOf = new Map(
    deliveries.map((d) => [
      `${d.repo.owner}/${d.repo.name}#${d.pullRequest.number}`,
      pullRequestHead(d.pullRequest),
    ]),
  );
  const pullRequests: RecordedRepairPullRequest[] = decided.pullRequests.map((pr) => ({
    ...pr,
    branch: pr.headRef,
    headSha: headOf.get(`${pr.repo}#${pr.number}`) ?? null,
  }));
  // The gate itself, for what the DTO leaves out: which gate, at which version, and the
  // authority it was decided under (`review_agent` for the agent, a person's otherwise).
  const gate =
    decided.repairClass === 'review'
      ? await readStandingReviewRefusal(item.id, deliveries, tx)
      : null;
  const findings =
    decided.reviewRefusal === null
      ? null
      : {
          ...decided.reviewRefusal,
          gateId: gate?.id ?? null,
          subjectVersion: gate?.subjectVersion ?? null,
          decidedByLabel: gate?.decidedByLabel ?? null,
          decidedUnderAuthority: gate?.decidedUnderAuthority ?? null,
        };
  return JSON.parse(
    JSON.stringify({
      command: 'fix',
      key: item.identifier,
      title: item.title,
      origin: opening.origin,
      // The agent door's run names the agent it runs in; the hosted payload has no
      // `agent` key (its agent lives on the run row).
      ...(opening.origin === 'instance'
        ? {
            agent: opening.agent,
            agentInstanceId: opening.agentInstanceId,
            resume: opening.resume ?? null,
          }
        : {}),
      model: opening.model,
      repairClass: decided.repairClass,
      findings,
      acceptanceRefusal: decided.acceptanceRefusal,
      pullRequests,
    }),
  ) as Prisma.InputJsonObject;
}

export const workItemRepairService = {
  /**
   * CLAIM the repair of one `implemented` card's failing pull requests.
   *
   * The decision order is the contract (the card's table), and each step reads
   * only what the steps before it left standing: archived / not implemented →
   * not the run target → no pull requests → nothing failing → somebody holds it →
   * open the run.
   */
  async claimRepair(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    options: ClaimRepairOptions = {},
  ): Promise<WorkItemRepairClaimDto> {
    const { opening, admit, onReplay } = options;
    // Tenancy + browse, with the 404-not-403 answer for a foreign key — the same
    // read every keyed operation opens with.
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    // The CI-credit gate, BEFORE the transaction, as the keyed claim runs it: a
    // refused dispatch takes no lock and opens no run.
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // ⚠️ THE EDIT GATE IS UP FRONT, where the keyed claim asserts it only on its
    // write arm. That claim's refusal is a read a browse-only caller may make;
    // this operation exists to START WORK on the card, so a caller who may not
    // edit the project has no answer here worth giving.
    await projectAccessService.assertCanEdit(projectId, ctx);

    // The project's statuses depend only on its workflow — read once, outside the
    // lock. The Implemented rung is resolved by KEY PRESENCE, as the approval-gate
    // guard in `applyStatusTransition` resolves it: a workflow with no status
    // keyed `implemented` has nothing at that rung, so nothing there is repairable.
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        await workItemRepository.lockById(item.id, tx);
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);

        // The same hosted press again, raced past the hosted start's own short-circuit:
        // answered with the run its key already opened, under this lock, before the lock
        // read below would call that very run `mine`.
        // A hosted start answers a known key before it claims, so only a race reaches this
        // for it; the agent door's repeated press reaches it too.
        if (opening) {
          const replayed = await dispatchRunRepository.findByIdempotencyKey(
            ctx.workspaceId,
            opening.idempotencyKey,
            tx,
          );
          if (replayed) {
            onReplay?.(replayed.id);
            return {
              ...refused(item, 'not_failing'),
              outcome: 'claimed',
              reason: null,
              runId: replayed.id,
              startedAt: replayed.startedAt.toISOString(),
            };
          }
        }

        const verdict = await evaluateRepair(
          { id: item.id, status: state.status, archivedAt: state.archivedAt },
          statuses,
          ctx,
          tx,
        );
        if (!verdict.ok) return refused(item, verdict.reason, verdict.runTargetKey);
        const pullRequests = verdict.pullRequests;
        const { repairClass, acceptanceRefusal, reviewRefusal } = verdict;

        const held = await dispatchRunRepository.findRunningByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (held) {
          // ⚠️ A HOSTED repair is never `mine` to a claim, even the presser's own: its
          // container is working those branches, and a local `motir fix` resuming it
          // would put two agents on one pull request (§8.6 — one repair at a time).
          // Only a local run its own operator re-claims is a resume. An `instance`
          // run (MOTIR-7023) is its agent's for the same reason a hosted one is the
          // container's, so it is never `mine` either.
          const mine = held.createdById === ctx.userId && held.origin === 'local';
          return {
            key: item.identifier,
            title: item.title,
            outcome: mine ? 'mine' : 'taken',
            reason: null,
            runTargetKey: null,
            runId: held.id,
            holder: held.createdBy,
            startedAt: held.startedAt.toISOString(),
            repairClass,
            // The holder is handed the reason and the branches again; a rival nothing.
            acceptanceRefusal: mine ? acceptanceRefusal : null,
            reviewRefusal: mine ? reviewRefusal : null,
            pullRequests: mine ? pullRequests : [],
          };
        }

        // Asked before anything is written: a throw rolls the whole claim back.
        admit?.(repairClass);

        // A hosted opening rides on the SAME insert, so the lock and the hosted run are
        // one row (§8.6) — a local `motir fix` and a hosted press exclude each other
        // through the lock read above, in both directions.
        const openedRun = await dispatchRunService.openWithin(
          projectId,
          {
            command: 'fix',
            reportedBy: 'cli',
            cards: [{ key: item.identifier, disposition: 'queued' }],
            ...(opening
              ? {
                  origin: opening.origin,
                  agent: opening.agent,
                  ...(opening.model ? { model: opening.model } : {}),
                  idempotencyKey: opening.idempotencyKey,
                  ...(opening.origin === 'instance'
                    ? { agentInstanceId: opening.agentInstanceId }
                    : {}),
                }
              : {}),
          },
          ctx,
          tx,
        );
        // A LOCAL claim writes no event: `motir fix` appends its own `run_opened`. A
        // HOSTED one writes the ONE `run_opened` the container reads back.
        if (opening) {
          await dispatchRunEventRepository.createMany(
            [
              {
                workspaceId: ctx.workspaceId,
                dispatchRunId: openedRun.run.id,
                seq: 1,
                kind: 'run_opened',
                reportedBy: 'cli',
                data: await repairOpenedData(
                  item,
                  opening,
                  { repairClass, pullRequests, reviewRefusal, acceptanceRefusal },
                  tx,
                ),
              },
            ],
            tx,
          );
        }
        // Read back through the SAME lock read, so `claimed` names its holder
        // exactly as a later `taken` will — one projection, not two.
        const opened = await dispatchRunRepository.findRunningByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        /* v8 ignore next -- the run was just written inside this transaction */
        if (!opened) throw new WorkItemNotFoundError(identifier);
        return {
          key: item.identifier,
          title: item.title,
          outcome: 'claimed',
          reason: null,
          runTargetKey: null,
          runId: opened.id,
          holder: opened.createdBy,
          startedAt: opened.startedAt.toISOString(),
          repairClass,
          acceptanceRefusal,
          reviewRefusal,
          pullRequests,
        };
      },
    );
  },

  /**
   * Whether a HOSTED repair of `identifier` would be admitted, and over which pull
   * requests (Story MOTIR-1626 · MOTIR-6928) — {@link claimRepair}'s evaluation and lock
   * read WITHOUT the lock, writing nothing. The claim decides again under its lock, so
   * this is the hosted start's pre-flight, never the decision.
   *
   * Asserts what the claim asserts up front — tenancy + browse (the keyed read) and edit
   * — so a person who could not press gets the claim's own answer, not a preview.
   */
  async previewHostedRepair(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<HostedRepairPreview> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    await projectAccessService.assertCanEdit(projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx): Promise<HostedRepairPreview> => {
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);
        const key = item.identifier;
        const verdict = await evaluateRepair(
          { id: item.id, status: state.status, archivedAt: state.archivedAt },
          statuses,
          ctx,
          tx,
        );
        if (!verdict.ok) {
          return {
            ok: false,
            key,
            refusal: {
              kind: 'not_repairable',
              reason: verdict.reason,
              runTargetKey: verdict.runTargetKey,
            },
          };
        }
        // The lock read BEFORE the class: a repair already running is the truer answer
        // whatever the class, and it names who to ask.
        const held = await dispatchRunRepository.findRunningByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (held) {
          return {
            ok: false,
            key,
            refusal: {
              kind: 'taken',
              holder: held.createdBy,
              startedAt: held.startedAt.toISOString(),
            },
          };
        }
        if (verdict.repairClass !== 'review') {
          return {
            ok: false,
            key,
            refusal: { kind: 'not_sent_back', repairClass: verdict.repairClass },
          };
        }
        return {
          ok: true,
          key,
          workItemId: item.id,
          repairClass: verdict.repairClass,
          pullRequests: verdict.pullRequests,
        };
      },
    );
  },

  /**
   * The repair claim as an AGENT makes it over the MCP (Story MOTIR-6804 ·
   * MOTIR-6807): {@link claimRepair} unchanged, then — on `claimed` and `mine`
   * only — ONE heartbeat on the run it answers.
   *
   * ⚠️ WHY THE FIRST BEAT IS HERE. A run with no heartbeat at all is on the
   * 12-hour AGE reap, not the five-minute lapse (`isRunAlive`,
   * `lib/runs/runLiveness.ts`), because a CLI that never heartbeats must not be
   * reaped from under itself. An agent that claims and then dies before its first
   * `touch_work_item_repair` would therefore hold the card *being fixed* for half a
   * day. Beating once at the claim puts the run on the lapse rule from its first
   * second, which is what the tools' contract (touch at least every two minutes)
   * assumes. The claim's rules, its DTO and its refusals are untouched.
   */
  async claimRepairAsAgent(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemRepairClaimDto> {
    const claim = await workItemRepairService.claimRepair(projectId, identifier, ctx);
    if ((claim.outcome === 'claimed' || claim.outcome === 'mine') && claim.runId !== null) {
      try {
        await dispatchRunService.heartbeat(claim.runId, ctx);
      } catch (err) {
        // A `mine` run the reap closed between the claim's read and this beat.
        // The claim's answer stands; the agent's first touch reads `open: false`.
        /* v8 ignore next -- only a reap landing inside that window reaches here */
        if (!(err instanceof DispatchRunTerminalError)) throw err;
      }
    }
    return claim;
  },

  /**
   * The repair claim as the AGENT DOOR makes it (Story MOTIR-8981 · MOTIR-9049) —
   * pressing **Fix in my agent**: {@link claimRepair} with an `instance` opening and NO
   * `admit`, so every class the predicate returns (`ci`, `acceptance_rerun`, `review`)
   * is admitted — the `review`-only rule is the hosted lane's, not this door's — then,
   * on `claimed`, ONE heartbeat on the run it opened (the reason is
   * {@link claimRepairAsAgent}'s: a run with no beat is on the 12-hour age reap).
   *
   * A busy agent is refused naming the BUSY run's own card: `openWithin` raises
   * {@link DispatchRunAgentBusyError} with no card key, and naming the pressed card would
   * be wrong whenever the agent is busy elsewhere.
   */
  async openAgentRepair(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    opening: AgentRepairOpening,
  ): Promise<WorkItemRepairClaimDto> {
    let claim: WorkItemRepairClaimDto;
    try {
      claim = await workItemRepairService.claimRepair(projectId, identifier, ctx, { opening });
    } catch (err) {
      // A lost race carries no run id (the transaction aborted): left as it is rather
      // than naming a card that may not be the busy one.
      if (err instanceof DispatchRunAgentBusyError && err.runId && err.workItemKey === null) {
        const runId = err.runId;
        const keys = await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId },
          (tx) => dispatchRunRepository.findTargetKeys([runId], tx),
        );
        throw new DispatchRunAgentBusyError(err.agentInstanceId, runId, keys.get(runId) ?? null);
      }
      throw err;
    }
    if (claim.outcome === 'claimed' && claim.runId !== null) {
      try {
        await dispatchRunService.heartbeat(claim.runId, ctx);
      } catch (err) {
        // The run was closed between the claim and this beat; the answer stands.
        /* v8 ignore next -- only a close landing inside that window reaches here */
        if (!(err instanceof DispatchRunTerminalError)) throw err;
      }
    }
    return claim;
  },

  /**
   * KEEP a claimed repair ALIVE (MOTIR-6807) — `touch_work_item_repair`.
   *
   * Only the caller's own `fix` run on THIS card is touched
   * ({@link RepairRunRefusedError} otherwise, before anything is written). An
   * open run is beaten through `dispatchRunService.heartbeat` — the one heartbeat
   * there is, under the lock it shares with the reap — and a closed one is
   * ANSWERED rather than refused, `open: false` with how it ended, because the
   * agent's next move is to stop, and an error would read as something to retry.
   */
  async touchRepair(
    projectId: string,
    identifier: string,
    runId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemRepairRunDto> {
    const { key, run } = await readOwnRepairRun(projectId, identifier, runId, ctx);
    if (run.status !== 'running') return toRepairRunDto(key, run);
    try {
      await dispatchRunService.heartbeat(runId, ctx);
    } catch (err) {
      // Closed between the read above and the heartbeat's lock — by the reap,
      // usually. The same answer as a run that was already closed.
      if (!(err instanceof DispatchRunTerminalError)) throw err;
    }
    return toRepairRunDto(key, (await readOwnRepairRun(projectId, identifier, runId, ctx)).run);
  },

  /**
   * CLOSE a claimed repair with how it ended (MOTIR-6807) —
   * `close_work_item_repair`.
   *
   * Through `dispatchRunService.close`, so the run's status, stop reason and legs
   * are settled by the one close there is. IDEMPOTENT: a run that is already
   * closed — by this caller's own earlier close, or by the reap — is answered
   * as it stands and changed by nothing, because an agent that retries after a
   * timeout must not be told it failed.
   */
  async closeRepair(
    projectId: string,
    identifier: string,
    runId: string,
    outcome: RepairCloseOutcome,
    ctx: ServiceContext,
  ): Promise<WorkItemRepairRunDto> {
    const { key, run } = await readOwnRepairRun(projectId, identifier, runId, ctx);
    if (run.status !== 'running') return toRepairRunDto(key, run);
    try {
      await dispatchRunService.close(runId, { stopReason: REPAIR_CLOSE_STOP_REASON[outcome] }, ctx);
    } catch (err) {
      if (!(err instanceof DispatchRunTerminalError)) throw err;
    }
    return toRepairRunDto(key, (await readOwnRepairRun(projectId, identifier, runId, ctx)).run);
  },

  /**
   * What the item page's Development block draws about a repair (MOTIR-5466) —
   * the claim's own evaluation, WITHOUT a lock and without opening anything, plus
   * the card's latest `fix` run.
   *
   * A read a browse-only viewer may make: it names who is fixing the card and
   * offers a command, and the command itself is what asks for edit.
   */
  async getRepairView(workItemId: string, ctx: ServiceContext): Promise<WorkItemRepairViewDto> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    await projectAccessService.assertCanBrowse(item.projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      async (tx): Promise<WorkItemRepairViewDto> => {
        const verdict = await evaluateRepair(item, statuses, ctx, tx);
        if (!verdict.ok) {
          // A child is pointed at its run target only when it has something red
          // of its own to point about; every other refusal is state 5.
          return verdict.reason === 'repair_on_run_target' && verdict.failing.length > 0
            ? {
                state: 'pointer',
                failing: verdict.failing.map(refOf),
                runTargetKey: verdict.runTargetKey as string,
              }
            : { state: 'hidden' };
        }
        // ⚠️ A `review` CLAIM IS DRAWN AS THE SENT-BACK PART (MOTIR-6930; design
        // `design/github` § 30 Panels 3–3e). Its checks are usually green, so — as for
        // an acceptance Re-run — EVERY open member is handed over and the part names the
        // review, never failing checks; the part's own filter keeps only the red members
        // for its failing lines. It is where *Fix on the hosted agent* and `motir fix`
        // sit, so a green sent-back card must not read `hidden` (MOTIR-6822 drew it so
        // only while no frame could say who sent it back).
        const failing = verdict.pullRequests.map(refOf);
        /* v8 ignore next -- NO PRODUCER: an `ok` verdict always hands over a member —
           `ci` only when one is failing, `acceptance_rerun` / `review` only over open rows. */
        if (failing.length === 0) return { state: 'hidden' };
        const { repairClass, acceptanceRefusal } = verdict;

        const latest = await dispatchRunRepository.findLatestByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (latest?.status === 'running') {
          return {
            state: 'in_progress',
            repairClass,
            acceptanceRefusal,
            failing,
            holder: latest.createdBy,
            byViewer: latest.createdById === ctx.userId,
            startedAt: latest.startedAt.toISOString(),
            run: {
              id: latest.id,
              label: dispatchRunLabel('fix', latest.startedAt),
              // `instance` is not hosted — it is drawn as the agent's run by the
              // card UI (MOTIR-7028), never with the hosted run link.
              hosted: latest.origin === 'hosted',
            },
          };
        }
        // Only a run that FAILED gave up. A stopped (cancelled) or reaped repair
        // draws F1 with no history line — nothing is running and nothing gave up.
        if (latest?.status === 'failed') {
          const event = await dispatchRunEventRepository.findLatestOfKind(
            latest.id,
            'ci_gave_up',
            tx,
          );
          return {
            state: 'offer',
            repairClass,
            acceptanceRefusal,
            failing,
            lastGaveUp: {
              attempts: attemptsOf(event?.data ?? null),
              endedAt: (latest.endedAt ?? latest.startedAt).toISOString(),
            },
          };
        }
        return { state: 'offer', repairClass, acceptanceRefusal, failing, lastGaveUp: null };
      },
    );
  },

  /**
   * THE OPEN REPAIR on each of these cards (Story MOTIR-1626 · MOTIR-6930) — what the
   * To fix banner and the Workbench To fix row draw in place of *Fix on the hosted
   * agent* and `motir fix` while a repair holds the lock (`design/workbench` § 32).
   * ONE read for a page of rows. The caller has already resolved the cards under the
   * reader's own access (the Workbench's membership read, the item page's gate), so
   * this names only runs on cards it was handed. Keyed by work item id; a card with no
   * open `fix` run is absent.
   */
  async findOpenRepairRuns(
    workItemIds: readonly string[],
    ctx: ServiceContext,
  ): Promise<Map<string, OpenRepairRunDto>> {
    if (workItemIds.length === 0) return new Map();
    const runs = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => dispatchRunRepository.findRunningByCommandForWorkItems(workItemIds, 'fix', tx),
    );
    return toOpenRepairRuns(runs, ctx.userId);
  },
};

/**
 * Resolve the card and read the named run, refusing anything that is not the
 * CALLER's `fix` run on that card (MOTIR-6807). The card read carries the
 * tenancy + browse gate (a foreign key is not found), and the edit gate is the
 * one `claimRepair` asserts — keeping a repair alive or closing it is starting
 * and ending work on the card, and a caller who could not have claimed it may
 * not do either.
 */
async function readOwnRepairRun(
  projectId: string,
  identifier: string,
  runId: string,
  ctx: ServiceContext,
): Promise<{ key: string; run: DispatchRun }> {
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
  await projectAccessService.assertCanEdit(projectId, ctx);
  const run = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
    (tx) => dispatchRunRepository.findByIdWithCards(runId, tx),
  );
  const holdsCard =
    run !== null &&
    run.projectId === projectId &&
    run.command === 'fix' &&
    run.cards.some((leg) => leg.workItemId === item.id);
  if (!run || !holdsCard) throw new RepairRunRefusedError(runId, item.identifier, 'not_found');
  if (run.createdById !== ctx.userId) {
    throw new RepairRunRefusedError(runId, item.identifier, 'not_yours');
  }
  return { key: item.identifier, run };
}
