import { defineJob } from '../defineJob';

/**
 * THE GROWTH PASS'S SCHEDULE (Story MOTIR-9362 · MOTIR-9462).
 *
 * Every minute, like the headroom pass whose reading it acts on: each fleet kind
 * on its AWS pool reads its accounts' live quotas, refreshes its quota raises and
 * runs at most one growth (`fleetPoolGrowthPassService.runGrowthPass`).
 *
 * ⚠️ SINGLE-FLIGHT IS THE PASS'S OWN. The runner has no single-flight option and
 * a pass can outlast a minute (it creates AWS accounts), so the pass takes a
 * lease row and an overlapping run returns `{ ran: false }` at once.
 */
export const FLEET_POOL_GROWTH_CRON = '* * * * *';

export const fleetPoolGrowth = defineJob(
  {
    id: 'system.fleet-pool-growth',
    cron: FLEET_POOL_GROWTH_CRON,
    // `latest`: a pass decides from the CURRENT readings, so a missed one is not
    // work to replay — the next one grows whatever is still over 70%.
    catchUp: 'latest',
    // `none`: a pass creates AWS accounts. The next minute's pass is its retry,
    // once the growth claim and the lease have settled.
    retryPolicy: 'none',
  },
  (ctx, services) => {
    return ctx.step.run('fleet-pool-growth', () => services.fleetPoolGrowthPass.runGrowthPass());
  },
);
