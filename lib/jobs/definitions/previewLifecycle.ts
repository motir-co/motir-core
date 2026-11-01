import { defineJob } from '../defineJob';
import type { PreviewEffectRequestedData, PreviewStartRequestedData } from '../types';
import { PREVIEW_START_POLL_MS, PREVIEW_START_POLLS } from '@/lib/services/previewLifecycleService';

// THE PREVIEW LIFECYCLE's background half (Story MOTIR-5766 · MOTIR-5776). The
// webhook commits a preview's transition and enqueues what follows from it; these
// run it, so no GitHub delivery waits on a Fly, Neon or GitHub call. The policy is
// all in `previewLifecycleService`; each file here is a trigger, a retry budget
// and a dedup key.

/**
 * One effect of a committed transition: the deployment and its `in_progress`
 * (`announce`), the `failure` of a build that did not push (`report_failure`), or
 * a closed preview's teardown. Each re-reads the row and acts only while it is in
 * the state that ordered it, so a redelivered or overtaken event does nothing.
 */
export const previewEffect = defineJob(
  {
    id: 'preview/effect.requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  (ctx, services) => {
    const data = ctx.event.data as PreviewEffectRequestedData;
    return ctx.step.run(`preview-${data.effect}`, () =>
      services.previewLifecycle.runEffect(data.previewId, data.effect),
    );
  },
);

/**
 * Start a head's release and wait for its health check — a BOUNDED wait of
 * `PREVIEW_START_POLLS` × `PREVIEW_START_POLL_MS`, each sleep the engine's durable
 * yield so a waiting start holds no worker slot, each read its own memoized step
 * so a resume never deploys twice. Then settle: `ready` + `success`, or `failed` +
 * `failure`. A start the job never settles (a lost worker) is the reaper's.
 */
export const previewStart = defineJob(
  {
    id: 'preview/start.requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const { previewId, headSha } = ctx.event.data as PreviewStartRequestedData;
    const started = await ctx.step.run('preview-start', () =>
      services.previewLifecycle.start(previewId, headSha),
    );
    if (started.status !== 'deployed') return { started: started.status };
    for (let poll = 0; poll < PREVIEW_START_POLLS; poll += 1) {
      if (poll > 0) await ctx.step.sleep(`preview-health-wait-${poll}`, PREVIEW_START_POLL_MS);
      const health = await ctx.step.run(`preview-health-${poll}`, () =>
        services.previewLifecycle.checkStart(started.handle),
      );
      if (health === 'pending') continue;
      const settled = await ctx.step.run('preview-settle', () =>
        services.previewLifecycle.settleStart(previewId, headSha, health),
      );
      return { started: started.status, settled: settled.status };
    }
    const settled = await ctx.step.run('preview-settle', () =>
      services.previewLifecycle.settleStart(previewId, headSha, 'timed_out'),
    );
    return { started: started.status, settled: settled.status };
  },
);

/**
 * THE PREVIEW REAPER — hourly. Finishes the teardowns a crash interrupted, closes
 * previews whose close was missed, re-announces a deployment that was never made
 * and fails a start nobody settled. Within the hourly cadence, so it needs no
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` entry.
 */
export const PREVIEW_REAPER_CRON = '41 * * * *';

export const previewReaper = defineJob(
  {
    id: 'system.preview-reaper',
    cron: PREVIEW_REAPER_CRON,
    // `latest`: the reaper selects from the CURRENT rows; a missed tick is not
    // work to replay.
    catchUp: 'latest',
    // Every step re-reads its row and acts only on the state it finds.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => ctx.step.run('preview-reaper', () => services.previewLifecycle.reap()),
);
