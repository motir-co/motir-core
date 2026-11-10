import { defineJob } from '../defineJob';
import type { PullRequestBaseMovedData } from '../types';

// THE BASE-BRANCH MERGEABILITY RE-READ (MOTIR-5914, for bug MOTIR-5907; design/github
// § 30 rule 1) — one run per push to a repository's default branch. The policy is all in
// `pullRequestMergeabilityService`; this file is the trigger, the wait and the dedup key.
//
// ⚠️ WHY IT WAITS. GitHub computes `mergeable` LAZILY after the base moves: an immediate
// read mostly answers `null`. So a member still `null` is asked again after a durable
// sleep, a bounded number of times; one still `null` after the last wait is left to the
// 5-minute `system.pull-request-reconcile` tick (`PULL_REQUEST_RECONCILE_CRON`), which
// re-reads open delivering pull requests anyway and applies the same withdrawal — that
// tick is this job's failure path, and no dead-letter queue is added for it.
//
// ⚠️ EVERY HOST READ IS INSIDE A `step.run`. The engine resumes a run after `step.sleep` by
// re-running the handler and serving completed steps from their memo, so a read left
// outside a step would be repeated on every resume.
//
// `idempotency` on `<repoId>:<baseHeadSha>`: a redelivered push for the same head
// enqueues nothing new. `retryPolicy: 'idempotent'` because a pass is safe to repeat — a
// gate already superseded is not awaiting, so the withdrawal matches nothing, and a card
// already at Implemented is not moved again.

/** The waits between passes, in ms. Three more asks after the first; the exact spacing is
 *  a judgement about how long GitHub takes, not a contract. */
export const BASE_MOVED_RETRY_WAITS_MS = [10_000, 30_000, 90_000] as const;

export const pullRequestBaseMoved = defineJob(
  {
    id: 'pull-request/base-moved',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as PullRequestBaseMovedData;
    let pending = await ctx.step.run('list-members', () =>
      services.pullRequestMergeability.listBaseMembers(data),
    );
    const total = { members: pending.length, conflicted: 0, withdrawn: 0, held: 0, failed: 0 };
    for (let pass = 0; pass <= BASE_MOVED_RETRY_WAITS_MS.length && pending.length > 0; pass++) {
      if (pass > 0) await ctx.step.sleep(`wait-${pass}`, BASE_MOVED_RETRY_WAITS_MS[pass - 1]!);
      const members = pending;
      const summary = await ctx.step.run(`settle-${pass}`, () =>
        services.pullRequestMergeability.settleBaseMembers(data.workspaceId, members),
      );
      total.conflicted += summary.conflicted;
      total.withdrawn += summary.withdrawn;
      total.held += summary.held;
      total.failed += summary.failed;
      pending = summary.unknown;
    }
    return { ...total, stillUnknown: pending.length };
  },
);
