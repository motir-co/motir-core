import {
  ReviewAgainForbiddenError,
  ReviewAgainGateNotFoundError,
  ReviewAgainNotOfferedError,
} from '@/lib/agentReview/errors';
import { reviewAgainKey, reviewRaiseKey, reviewRunKeyPrefix } from '@/lib/agentReview/reviewRunKey';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { resolveGateAuthority } from '@/lib/services/approvalGatesService';
import { hostedRunService, type HostedRunStartOptions } from '@/lib/services/hostedRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE REVIEW RUN'S LIFECYCLE AROUND ITS GATE (Story MOTIR-1626 · MOTIR-6820; ADR
// `docs/decisions/hosted-agent-run.md` §8.1, §8.4 and `approval-gates.md` §12.5–§12.6).
//
// Three doors, one rule — a review run exists only for an AWAITING `agent_review` gate:
//
//   · START — the `agent-review/requested` job: ONE hosted `review` run for the gate the
//     event names, while that gate is still awaiting at the event's version. A refusal
//     before anything boots is written onto the gate as its `reviewUnavailableReason`
//     (the refusal's own code), and the gate stays awaiting. Nothing retries it.
//   · REVIEW AGAIN — the routed person's press on a review that could not run: it clears
//     the reason and requests ONE new run for the same gate and version (§12.6).
//   · CANCEL — a superseded gate's run in flight is cancelled (§12.5): the withdrawal and
//     the switch-off seams call {@link agentReviewStartService.cancelRunsAfterCommit}.
//
// A run's END without a verdict is written by the hosted end path itself
// (`hostedRunService.endHostedRun`), which every way a run ends goes through.
//
// ⚠️ IDEMPOTENT PER REQUEST, NOT PER GATE. The raise and each *Review again* press are
// separate requests with keys of their own (`lib/agentReview/reviewRunKey.ts`); the key
// is the job's dedup and the run's idempotency key. So a redelivered event starts nothing
// twice, and *Review again* can still start a new attempt for the same gate.

/** What {@link agentReviewStartService.startRequested} did — JSON, for the job's ledger. */
export type AgentReviewStartOutcome =
  | { outcome: 'started'; dispatchRunId: string }
  | { outcome: 'already_started'; dispatchRunId: string }
  | {
      outcome: 'skipped';
      why:
        | 'gate_missing'
        | 'not_awaiting'
        | 'version_moved'
        | 'could_not_run'
        | 'run_in_flight'
        | 'source_own';
    }
  | { outcome: 'refused'; reason: string };

/** The reason code a start refusal is recorded under — the refusal's own `code`. */
function refusalCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'review_start_failed';
}

/** WHO a review run is attributed to (§8.1): the card's assignee, else its reporter, else
 *  the workspace's stand-in manager — the actor the CI-feedback path writes as. */
async function attributedUserId(
  item: { assigneeId: string | null; reporterId: string | null },
  workspaceId: string,
): Promise<string | null> {
  if (item.assigneeId) return item.assigneeId;
  if (item.reporterId) return item.reporterId;
  const manager = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx),
  );
  return manager?.userId ?? null;
}

/** The running review runs of each gate, by the key prefix every one of them carries. */
async function runningReviewRuns(
  workspaceId: string,
  gateIds: readonly string[],
): Promise<string[]> {
  if (gateIds.length === 0) return [];
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const ids: string[] = [];
    for (const gateId of gateIds) {
      const runs = await dispatchRunRepository.listRunningByIdempotencyKeyPrefix(
        workspaceId,
        reviewRunKeyPrefix(gateId),
        tx,
      );
      ids.push(...runs.map((r) => r.id));
    }
    return ids;
  });
}

export const agentReviewStartService = {
  /**
   * THE `agent-review/requested` JOB's body — start ONE hosted review run for the gate.
   *
   * Starts nothing — and writes nothing — when the gate is gone, no longer awaiting, at
   * another version, already carries a could-not-run reason (only *Review again* clears
   * it; nothing retries by itself), or already has a review run in flight. A refusal
   * before the run boots writes its code onto the gate and is returned, never thrown: a
   * refused review is an answer, not a job failure to retry.
   */
  async startRequested(
    data: AgentReviewRequestedData,
    options: HostedRunStartOptions = {},
  ): Promise<AgentReviewStartOutcome> {
    const { workspaceId, gateId, subjectVersion } = data;
    const idempotencyKey = data.idempotencyKey ?? reviewRaiseKey(gateId);

    const read = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const gate = await approvalGateRepository.findById(gateId, tx);
      const item = gate?.workItemId ? await workItemRepository.findById(gate.workItemId, tx) : null;
      const already = await dispatchRunRepository.findByIdempotencyKey(
        workspaceId,
        idempotencyKey,
        tx,
      );
      // The source is read HERE, at start time, and not at the raise: every raise path
      // funnels through this job, so a request queued before a switch to `own` is
      // skipped, and no raise site can still start a run (§12.10).
      const settings = item ? await projectRepository.findMergeSettings(item.projectId, tx) : null;
      return { gate, item, already, source: settings?.reviewAgentSource ?? 'hosted' };
    });
    // A redelivery of a request whose run was opened: it is that run, whatever it did.
    if (read.already) return { outcome: 'already_started', dispatchRunId: read.already.id };

    const { gate, item } = read;
    if (!gate || gate.kind !== 'agent_review' || !item || gate.workspaceId !== workspaceId) {
      return { outcome: 'skipped', why: 'gate_missing' };
    }
    if (gate.state !== 'awaiting') return { outcome: 'skipped', why: 'not_awaiting' };
    if (gate.subjectVersion !== subjectVersion) return { outcome: 'skipped', why: 'version_moved' };
    if (gate.reviewUnavailableReason !== null) return { outcome: 'skipped', why: 'could_not_run' };
    // `own`: the gate waits for a verdict through the user-token door. Nothing is
    // started, billed or recorded as could-not-run (§12.6 is a hosted-only state).
    if (read.source === 'own') return { outcome: 'skipped', why: 'source_own' };
    if ((await runningReviewRuns(workspaceId, [gateId])).length > 0) {
      return { outcome: 'skipped', why: 'run_in_flight' };
    }

    const record = async (reason: string): Promise<AgentReviewStartOutcome> => {
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        approvalGateRepository.setReviewUnavailableReason(gateId, reason, tx),
      );
      return { outcome: 'refused', reason };
    };

    const userId = await attributedUserId(item, workspaceId);
    if (!userId) return record('review_no_actor');

    try {
      const started = await hostedRunService.startReview(
        { workItemId: item.id, gateId, subjectVersion, idempotencyKey },
        { userId, workspaceId },
        options,
      );
      return started.created
        ? { outcome: 'started', dispatchRunId: started.dispatchRunId }
        : { outcome: 'already_started', dispatchRunId: started.dispatchRunId };
    } catch (err) {
      // Every refusal before the boot, and a start that failed after the run opened (the
      // end path has already closed that run): the review could not run.
      return record(refusalCodeOf(err));
    }
  },

  /**
   * *REVIEW AGAIN* (`approval-gates.md` §12.6) — the routed person re-requests ONE review
   * run for the SAME gate and version, and the could-not-run reason is cleared while it
   * runs. Offered only on an awaiting `agent_review` that carries a reason and has no
   * review run in flight; authorised exactly as *Continue without the review* is (§12.3):
   * the kind's `work_item:edit` floor, then `resolveGateAuthority`'s routed set.
   *
   * The clear and the request are one decision: the request is emitted only once the
   * clear has committed, under a key of its own.
   */
  async reviewAgain(gateId: string, ctx: ServiceContext): Promise<{ gateId: string }> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const locked = await approvalGateRepository.lockById(gateId, tx);
        if (!locked || locked.kind !== 'agent_review' || !locked.workItemId) {
          throw new ReviewAgainGateNotFoundError(gateId);
        }
        const item = await workItemRepository.findById(locked.workItemId, tx);
        if (!item) throw new ReviewAgainGateNotFoundError(gateId);

        let held;
        try {
          held = await projectAccessService.getPermissions(item.projectId, ctx, tx);
        } catch (err) {
          if (err instanceof ProjectNotFoundError) throw new ReviewAgainGateNotFoundError(gateId);
          throw err;
        }
        if (!held.has('project:browse')) throw new ReviewAgainGateNotFoundError(gateId);
        if (!held.has('work_item:edit') || !(await resolveGateAuthority(item, ctx, tx, held))) {
          throw new ReviewAgainForbiddenError(gateId);
        }

        if (locked.state !== 'awaiting' || locked.subjectVersion === null) {
          throw new ReviewAgainNotOfferedError(gateId, 'not_awaiting');
        }
        const settings = await projectRepository.findMergeSettings(item.projectId, tx);
        if (settings?.reviewAgentSource === 'own') {
          throw new ReviewAgainNotOfferedError(gateId, 'source_own');
        }
        const gate = await approvalGateRepository.findById(gateId, tx);
        if (!gate?.reviewUnavailableReason)
          throw new ReviewAgainNotOfferedError(gateId, 'no_reason');
        const inFlight = await dispatchRunRepository.listRunningByIdempotencyKeyPrefix(
          ctx.workspaceId,
          reviewRunKeyPrefix(gateId),
          tx,
        );
        if (inFlight.length > 0) throw new ReviewAgainNotOfferedError(gateId, 'run_in_flight');

        await approvalGateRepository.setReviewUnavailableReason(gateId, null, tx);
        const request: AgentReviewRequestedData = {
          workspaceId: ctx.workspaceId,
          gateId,
          workItemId: item.id,
          subjectVersion: locked.subjectVersion,
          idempotencyKey: reviewAgainKey(gateId),
        };
        deferUntilCommit(() => sendEvent('agent-review/requested', request));
        return { gateId };
      },
    );
  },

  /**
   * CANCEL the review runs in flight for `gateIds` — the gates a withdrawal or the
   * switch-off has just superseded (`approval-gates.md` §12.5: *a superseded review's RUN
   * is cancelled*). Each run is ended through the hosted end path as `cancelled`: its key,
   * credential and git tokens are revoked at once and its supervisor tears the container
   * down at the next poll. Never a throw. Returns the runs it ended.
   */
  async cancelRunsForGates(workspaceId: string, gateIds: readonly string[]): Promise<string[]> {
    const runIds = await runningReviewRuns(workspaceId, gateIds);
    for (const runId of runIds) {
      await hostedRunService.endHostedRun(
        runId,
        'cancelled',
        'its review was superseded before a verdict',
      );
    }
    return runIds;
  },

  /**
   * {@link cancelRunsForGates}, once the transaction superseding those gates COMMITS — the
   * seam `withdrawAgentReview` and the switch-off call from inside their transactions. A
   * supersede that rolls back cancels nothing. Outside a transaction helper's scope it
   * cancels nothing here, and says so: the review run's supervisor still reads its gate
   * before every poll and tears a superseded review down itself.
   */
  cancelRunsAfterCommit(workspaceId: string, gateIds: readonly string[]): void {
    if (gateIds.length === 0) return;
    const deferred = deferUntilCommit(async () => {
      await agentReviewStartService.cancelRunsForGates(workspaceId, gateIds);
    });
    if (!deferred) {
      console.warn(
        '[agentReviewStartService] review gates were superseded outside a transaction scope; ' +
          'their runs are cancelled by their supervisors instead',
        { gateIds },
      );
    }
  },
};
