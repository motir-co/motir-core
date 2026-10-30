import {
  MERGE_RELEASE_IN_PROGRESS_WAIT_MS,
  MERGE_RELEASE_MAX_ATTEMPTS,
  type MergeReleaseRequestedData,
  type RunMergeReleaseOutcome,
} from '@/lib/services/productionMergeReleaseService';
import { defineJob } from '../defineJob';

// A MERGE STARTS A RELEASE (Story MOTIR-9797 · MOTIR-10031) — one run per
// completed `production-image` run of a repository with production switched on.
// The decision is all in `productionMergeReleaseService.runMergeRelease`; this
// file is the trigger, the wait and the dedup key.
//
// ⚠️ WHY IT WAITS. The release service refuses a release while another of the
// same application is building or releasing (`ReleaseInProgressError`), and the
// service answers that as `deferred_in_progress`. The job sleeps durably and asks
// again, up to `MERGE_RELEASE_MAX_ATTEMPTS` tries; the last one records a failed
// release rather than deferring, so the loop always ends.
//
// ⚠️ EVERY TRY IS ITS OWN `step.run`. The engine resumes a run after `step.sleep`
// by re-running the handler and serving completed steps from their memo, so a
// release that already ran is never started twice.
//
// `idempotency` on `<runId>:<runAttempt>:<projectRepositoryId>`: a redelivered
// webhook enqueues nothing new, while a re-run of the workflow is a new attempt.
// `retryPolicy: 'none'` because the release service's own failures are returned
// failed releases, and anything it throws past them is not made right by
// starting the same release again.

export const productionMergeRelease = defineJob(
  {
    id: 'hosting/merge-release.requested',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as MergeReleaseRequestedData;
    let result: RunMergeReleaseOutcome = { outcome: 'deferred_in_progress' };
    for (let attempt = 0; attempt < MERGE_RELEASE_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0)
        await ctx.step.sleep(`in-progress-wait-${attempt}`, MERGE_RELEASE_IN_PROGRESS_WAIT_MS);
      result = await ctx.step.run(`merge-release-${attempt}`, () =>
        services.productionMergeRelease.runMergeRelease({
          projectRepositoryId: data.projectRepositoryId,
          headSha: data.headSha,
          conclusion: data.conclusion,
          attempt,
        }),
      );
      if (result.outcome !== 'deferred_in_progress') break;
    }
    return result;
  },
);
