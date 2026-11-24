import { defineJob } from '../defineJob';

/**
 * THE PRODUCTION HEALTH PROBER (Story MOTIR-9799 · MOTIR-12106).
 *
 * Every minute, `productionHealthService.probeAll` reads every Motir-hosted
 * production application's runtime through the deploy port and probes its
 * manifest's health-check path, stores its one health state, and records a
 * crash event — with its masked last log lines — for each transition into
 * `crashed` or `unhealthy`, notifying the project's administrators.
 *
 * Every minute, so a state changes within two minutes of the app changing
 * (`unhealthy` takes two consecutive failed probes); listed in
 * `SUB_HOURLY_CADENCE_EXCEPTIONS`.
 *
 * Overlapping runs are safe without a lease: each application's write is
 * serialised by a transaction-scoped lock and recomputed against the locked
 * state, and an event's `(application, transitionKey)` is unique, so a second
 * run records nothing twice.
 */
export const PRODUCTION_HEALTH_PROBE_CRON = '* * * * *';

export const productionHealthProbe = defineJob(
  {
    id: 'system.production-health-probe',
    cron: PRODUCTION_HEALTH_PROBE_CRON,
    // `latest`: a run reads the applications as they are NOW, so a missed
    // minute is not work owed.
    catchUp: 'latest',
    // A replayed run writes nothing twice: a transition already stored is not
    // a transition, and an event's key is taken.
    retryPolicy: 'idempotent',
  },
  (ctx, services) =>
    ctx.step.run('production-health-probe', () => services.productionHealth.probeAll()),
);
