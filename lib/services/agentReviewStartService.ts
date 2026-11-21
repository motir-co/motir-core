import type { DispatchRunOrigin } from '@/generated/prisma/client';
import { ReviewStartForbiddenError, ReviewStartNotOfferedError } from '@/lib/agentReview/errors';
import {
  reviewItemRunKey,
  reviewItemRunKeyPrefix,
  reviewPressKey,
  reviewRunKeyPrefix,
} from '@/lib/agentReview/reviewRunKey';
import { ownDeliverySetVersion } from '@/lib/agentReview/ownVersion';
import { assertWorkspaceFeatureEnabled } from '@/lib/featureFlags/evaluate';
import { HostedRunBootFailedError } from '@/lib/hostedRuns/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { resolveGateAuthority } from '@/lib/services/approvalGatesService';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { hostedRunService, type HostedRunStartOptions } from '@/lib/services/hostedRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE REVIEW RUN'S LIFECYCLE (Story MOTIR-1626 · MOTIR-6820, reshaped by Story MOTIR-11941 ·
// MOTIR-11944; `approval-gates.md` §12.5, §12.18 and `hosted-agent-run.md` §8.8).
//
//   · START — *Review with Motir agent*, a person's press: ONE hosted `review` run for the
//     item, gate on or off ({@link agentReviewStartService.startRequested}). NOTHING starts
//     a review by itself: the gate's raise only notifies the routed person
//     (`reviewToRunService.notifyRaised`). The press replaced *Review again* — a review that
//     could not run is started again by the same press, which clears the gate's reason.
//   · CANCEL — a superseded gate's run in flight is cancelled (§12.5): the withdrawal and the
//     switch-off seams call {@link agentReviewStartService.cancelRunsAfterCommit}.
//
// A run's END without a verdict is written by the hosted end path itself
// (`hostedRunService.endHostedRun`), which every way a run ends goes through.
//
// ⚠️ ONE AT A TIME, WITHOUT A LOCK ACROSS THE BOOT. The in-flight check is the cheap path;
// the guarantee is the run's key, DETERMINISTIC per attempt (`reviewPressKey`,
// `reviewItemRunKey`): two presses racing past the check compute the same key, and
// `dispatch_run`'s `(workspace_id, idempotency_key)` unique makes the second answer the
// first's run (`created: false`).

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** What a press did: the run it started, or the run it collapsed into (`created: false`). */
export interface ReviewStartResult {
  dispatchRunId: string;
  created: boolean;
  /** The gate the run answers; null for a review with no gate (Review off). */
  gateId: string | null;
}

/** What one press asks for — the item by its KEY, and optionally the model the person picked. */
export interface ReviewStartInput {
  workItemKey: string;
  model?: string;
  /** Accepted for parity with Run hosted's body; the attempt key is what collapses a retry. */
  idempotencyKey?: string;
}

/** What is reviewed: the gate and its version (Review on), or the item at its version. */
type ReviewSubject =
  | { gateId: string; subjectVersion: string; prefix: string; keyOf: (attempt: number) => string }
  | {
      gateId: null;
      subjectVersion: string;
      prefix: string;
      keyOf: (attempt: number) => string;
    };

/** The running review runs of each gate, by the key prefix every one of them carries. */
async function runningReviewRuns(
  workspaceId: string,
  gateIds: readonly string[],
): Promise<Array<{ id: string; origin: DispatchRunOrigin }>> {
  if (gateIds.length === 0) return [];
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const runs: Array<{ id: string; origin: DispatchRunOrigin }> = [];
    for (const gateId of gateIds) {
      runs.push(
        ...(await dispatchRunRepository.listRunningByIdempotencyKeyPrefix(
          workspaceId,
          reviewRunKeyPrefix(gateId),
          tx,
        )),
      );
    }
    return runs;
  });
}

export const agentReviewStartService = {
  /**
   * *REVIEW WITH MOTIR AGENT* (§12.18, `hosted-agent-run.md` §8.8) — a person's press starts
   * ONE hosted review run for the item, with the model they picked, gate on or off. `ctx` is
   * the PRESSER: the run's creator, its run token's owner and the one whose organisation's
   * AI credits pay. In order:
   *
   *   1. WHO — `project:browse` (else the item's not-found, no leak), then `work_item:edit`
   *      and `resolveGateAuthority`'s routed set ({@link ReviewStartForbiddenError});
   *   2. the `hosted_runs` lane (the org-feature-disabled refusal Run hosted gives);
   *   3. WHAT — the item In review; with Review on its awaiting `agent_review` gate at its
   *      version, with Review off the item at its own current version
   *      ({@link ReviewStartNotOfferedError}: `not_in_review`, `gate_not_awaiting`,
   *      `no_pull_request`);
   *   4. one at a time — a run already running under the subject's prefix is
   *      `review_in_flight`;
   *   5. the DETERMINISTIC attempt key — one more than the runs opened under the prefix;
   *   6. `hostedRunService.startReview`, whose pre-flight refusals are THROWN to the caller
   *      (the person is told why on the spot, and nothing is written onto the gate);
   *   7. once a run is open (`created: true`), the gate's could-not-run reason is cleared.
   */
  async startRequested(
    input: ReviewStartInput,
    ctx: ServiceContext,
    options: HostedRunStartOptions = {},
  ): Promise<ReviewStartResult> {
    const identifier = input.workItemKey.trim().toUpperCase();
    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    // 1 · WHO may press — the authority *Continue without the review* takes.
    const item = await withWorkspaceContext(scope, async (tx) => {
      const project = await projectRepository.findByIdentifier(
        ctx.workspaceId,
        projectKeyOf(identifier),
        tx,
      );
      const found = project
        ? await workItemRepository.findByIdentifier(project.id, identifier, tx)
        : null;
      if (!project || !found) throw new WorkItemNotFoundError(identifier);
      let held;
      try {
        held = await projectAccessService.getPermissions(found.projectId, ctx, tx);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(identifier);
        /* v8 ignore next -- a database fault mid-read; nothing to translate */
        throw err;
      }
      if (!held.has('project:browse')) throw new WorkItemNotFoundError(identifier);
      if (!held.has('work_item:edit') || !(await resolveGateAuthority(found, ctx, tx, held))) {
        throw new ReviewStartForbiddenError(identifier);
      }
      return { ...found, reviewAgentEnabled: project.reviewAgentEnabled };
    });

    // 2 · The hosted lane.
    await assertWorkspaceFeatureEnabled(ctx.workspaceId, 'hosted_runs');

    // 3–5 · WHAT is reviewed, one at a time, under the attempt's key.
    const { subject, attempt } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      if (item.status !== 'in_review') {
        throw new ReviewStartNotOfferedError(identifier, 'not_in_review');
      }
      let found: ReviewSubject;
      if (item.reviewAgentEnabled) {
        const gate = await approvalGateRepository.findLatestByWorkItem(item.id, 'agent_review', tx);
        if (!gate || gate.state !== 'awaiting' || gate.subjectVersion === null) {
          throw new ReviewStartNotOfferedError(identifier, 'gate_not_awaiting');
        }
        found = {
          gateId: gate.id,
          subjectVersion: gate.subjectVersion,
          prefix: reviewRunKeyPrefix(gate.id),
          keyOf: (n) => reviewPressKey(gate.id, n),
        };
      } else {
        const version = await ownDeliverySetVersion(item, ctx.workspaceId, tx);
        if (version === null) throw new ReviewStartNotOfferedError(identifier, 'no_pull_request');
        found = {
          gateId: null,
          subjectVersion: version,
          prefix: reviewItemRunKeyPrefix(item.id, version),
          keyOf: (n) => reviewItemRunKey(item.id, version, String(n)),
        };
      }
      const running = await dispatchRunRepository.listRunningByIdempotencyKeyPrefix(
        ctx.workspaceId,
        found.prefix,
        tx,
      );
      if (running.length > 0) throw new ReviewStartNotOfferedError(identifier, 'review_in_flight');
      const opened = await dispatchRunRepository.countByIdempotencyKeyPrefix(
        ctx.workspaceId,
        found.prefix,
        tx,
      );
      return { subject: found, attempt: opened + 1 };
    });

    // 6 · Start — the presser's context, the picked model. A refusal is thrown. A boot the
    // fleet refused happened AFTER the run opened, so it is a review that could not run: its
    // end path left the generic `no_verdict`, and the boot's own reason is the specific one.
    let started: { dispatchRunId: string; created: boolean };
    try {
      started = await hostedRunService.startReview(
        {
          workItemId: item.id,
          gateId: subject.gateId,
          subjectVersion: subject.subjectVersion,
          idempotencyKey: subject.keyOf(attempt),
          ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        },
        ctx,
        options,
      );
    } catch (err) {
      if (err instanceof HostedRunBootFailedError && subject.gateId !== null) {
        const gateId = subject.gateId;
        await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
          approvalGateRepository.setReviewUnavailableReason(gateId, err.code, tx),
        );
      }
      throw err;
    }

    // 7 · A fresh attempt after *Review could not run* reads *Agent reviewing* again.
    if (started.created && subject.gateId !== null) {
      const gateId = subject.gateId;
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        approvalGateRepository.setReviewUnavailableReason(gateId, null, tx),
      );
    }
    return {
      dispatchRunId: started.dispatchRunId,
      created: started.created,
      gateId: subject.gateId,
    };
  },

  /**
   * The shipped *Review again* route's press (MOTIR-11944), until the review doors UI card
   * deletes it: the gate's item, started by {@link startRequested} with no model. The gate is
   * read under the caller's own workspace, so a gate of another workspace or another kind is
   * the item's not-found.
   */
  async startForGate(gateId: string, ctx: ServiceContext): Promise<ReviewStartResult> {
    const key = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const gate = await approvalGateRepository.findById(gateId, tx);
        if (!gate || gate.kind !== 'agent_review' || !gate.workItemId) return null;
        return (await workItemRepository.findById(gate.workItemId, tx))?.identifier ?? null;
      },
    );
    if (!key) throw new WorkItemNotFoundError(gateId);
    return agentReviewStartService.startRequested({ workItemKey: key }, ctx);
  },

  /**
   * CANCEL the review runs in flight for `gateIds` — the gates a withdrawal or the
   * switch-off has just superseded (`approval-gates.md` §12.5: *a superseded review's RUN
   * is cancelled*). A hosted run is ended through the hosted end path as `cancelled`: its
   * key, credential and git tokens are revoked at once and its supervisor tears the
   * container down at the next poll. A run in a person's own agent (*Review in my agent*,
   * MOTIR-11945) is ended through `agentInstanceRunService.end`, which stops its session in
   * the agent. Never a throw. Returns the runs it ended.
   */
  async cancelRunsForGates(workspaceId: string, gateIds: readonly string[]): Promise<string[]> {
    const runs = await runningReviewRuns(workspaceId, gateIds);
    const detail = 'its review was superseded before a verdict';
    for (const run of runs) {
      // A review in a person's own agent (MOTIR-11945) is ended through the agent's end
      // path, which also stops its session in the agent; a hosted one through the hosted end.
      if (run.origin === 'instance') {
        await agentInstanceRunService.end(run.id, 'cancelled', detail, { stopSession: true });
      } else {
        await hostedRunService.endHostedRun(run.id, 'cancelled', detail);
      }
    }
    return runs.map((r) => r.id);
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
