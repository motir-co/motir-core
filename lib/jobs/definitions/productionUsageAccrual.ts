import { defineJob } from '../defineJob';

/**
 * THE PRODUCTION USAGE ACCRUAL (Story MOTIR-9799 · MOTIR-12108; Decision
 * MOTIR-12100).
 *
 * Every hour, `productionUsageMeterService.accrue` writes one slice per unit of
 * every Motir-hosted production application's usage — its live release's
 * compute and its database's compute and storage, since its last slice — priced
 * in credits with Motir's own cost beside it; charges each application's ended
 * UTC days once, rounded up, as `hosting_production`; and refreshes each
 * organisation's below-zero state, switching an always-on application to
 * suspend when idle after 7 days below zero.
 *
 * Hourly: within the hourly cadence, so it needs no
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` entry.
 */
export const PRODUCTION_USAGE_ACCRUAL_CRON = '47 * * * *';

export const productionUsageAccrual = defineJob(
  {
    id: 'system.production-usage-accrual',
    cron: PRODUCTION_USAGE_ACCRUAL_CRON,
    // `latest`: a slice measures from where the application's slices end, so a
    // missed tick is folded into the next one rather than owed.
    catchUp: 'latest',
    // A replayed window writes nothing (its key is taken, or another writer has
    // moved the window on), and a replayed day's debit is answered idempotently.
    retryPolicy: 'idempotent',
  },
  (ctx, services) =>
    ctx.step.run('production-usage-accrual', () => services.productionUsageMeter.accrue()),
);
