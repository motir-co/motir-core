import { defineJob } from '../defineJob';

/**
 * THE PREVIEW USAGE ACCRUAL (Story MOTIR-5766 · MOTIR-5777).
 *
 * Every hour, `ciPreviewUsageMeterService.accrue` records one slice of every
 * live preview's usage — its release's running time since its last slice, its
 * Neon branch's compute beyond what was recorded — into the CI-minutes pool, and
 * charges any organisation the slices took past it. So a preview that lives for
 * weeks is charged in the month it ran, not at teardown; the final slice at
 * teardown is the destroy's, through the composition root.
 *
 * Hourly: within the hourly cadence, so it needs no
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` entry.
 */
export const PREVIEW_USAGE_ACCRUAL_CRON = '53 * * * *';

export const previewUsageAccrual = defineJob(
  {
    id: 'system.preview-usage-accrual',
    cron: PREVIEW_USAGE_ACCRUAL_CRON,
    // `latest`: a slice measures from where the preview's slices end, so a
    // missed tick is folded into the next one rather than owed.
    catchUp: 'latest',
    // A replayed window writes nothing: its key is taken, or another writer
    // has moved the window on.
    retryPolicy: 'idempotent',
  },
  (ctx, services) =>
    ctx.step.run('preview-usage-accrual', () => services.ciPreviewUsageMeter.accrue()),
);
