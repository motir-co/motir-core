import { defineJob } from '../defineJob';

/**
 * THE AWS COST FETCH'S SCHEDULE (MOTIR-11712) — every 6 hours, Cost Explorer's
 * daily cost for the current and the previous month is read and stored
 * (`awsCostService.fetchRecent`), so the console's Costs page shows AWS cost
 * without ever calling Cost Explorer on a page load. At :20, away from the top of
 * the hour where the hourly sweeps sit.
 *
 * Four reads a day is the card's cadence: AWS refreshes Cost Explorer data at
 * least once every 24 hours, so a fresher schedule would mostly pay (each request
 * is billed) to read the same figures again.
 */
export const AWS_COST_FETCH_CRON = '20 */6 * * *';

export const awsCostFetch = defineJob(
  {
    id: 'system.aws-cost-fetch',
    cron: AWS_COST_FETCH_CRON,
    // `latest`: a fetch re-reads two whole months as they stand now, so one fire
    // covers every fire a gap missed.
    catchUp: 'latest',
    // `idempotent`: a fetch replaces the days it read in one transaction, so a
    // retry after a failed read or write converges on the same rows.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => ctx.step.run('fetch-aws-costs', () => services.awsCost.fetchRecent()),
);
