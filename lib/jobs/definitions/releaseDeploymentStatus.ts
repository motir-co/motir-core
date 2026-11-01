import type { ReleaseStatusRequestedData } from '@/lib/services/releaseDeploymentStatusService';
import { defineJob } from '../defineJob';

// EVERY RELEASE POSTS ITS GITHUB DEPLOYMENT STATUS (Story MOTIR-9797 ·
// MOTIR-10033) — one run per release state change. The decision is all in
// `releaseDeploymentStatusService.postReleaseDeploymentStatus`, which reads the
// release as it stands when the run starts and converges on it, so a late,
// repeated or retried run posts the current state and nothing older.
//
// ⚠️ DEBOUNCED PER RELEASE, not keyed for idempotency. A release's creation and
// its first move commit together, and a rollback can bring a release back to a
// state it was in before, so `<release>:<state>` would both duplicate and wrongly
// drop work. A short debounce folds the burst into one run with the latest
// event; the run's own read decides what to post.
//
// `retryPolicy: 'idempotent'`: a GitHub outage or a missing credential is
// retried, and a retry reuses the deployment the release row already names.

export const releaseDeploymentStatus = defineJob(
  {
    id: 'hosted-release.status',
    retryPolicy: 'idempotent',
    debounce: { key: 'event.data.releaseId', period: '2s', timeout: '30s' },
  },
  async (ctx, services) => {
    const data = ctx.event.data as ReleaseStatusRequestedData;
    return ctx.step.run('post-release-status', () =>
      services.releaseDeploymentStatus.postReleaseDeploymentStatus(data.releaseId),
    );
  },
);
