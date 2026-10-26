import { defineJob } from '../defineJob';

/**
 * THE CAPACITY ALERT PASS'S SCHEDULE (Story MOTIR-9539 · MOTIR-9612).
 *
 * Every minute: the capacity alert evaluation
 * (`capacityAlertEvaluationService.evaluate`, through `capacityAlertJobService`),
 * so an over-share limit is raised and cleared with nobody on the screen.
 *
 * ⚠️ EVERY MINUTE, BECAUSE THE GATEWAY COUNTS FIXED CLOCK MINUTES. `rpm` and
 * `tpm` count the current clock minute (the capacity contract §3, *Lanes*), so
 * one pass per minute is one reading per window. A faster pass shows nothing
 * new; a slower one could miss a minute that went over and came back.
 *
 * ⚠️ AND THE READ IS TAKEN AT SECOND 45, NOT WHEN THE CRON FIRES. A cron fires at
 * second 0, exactly when the per-minute counters have just reset: a read there
 * would never raise a per-minute limit. The handler sleeps (a durable
 * checkpoint, so a resume keeps the deadline) into the last quarter of the
 * window first; 45 rather than 55 leaves room for the resume latency.
 */
export const CAPACITY_ALERT_EVALUATION_CRON = '* * * * *';

/** The second of its minute the pass reads the gateway at. */
export const CAPACITY_ALERT_READ_SECOND = 45;

/** How long to sleep from `now` to second 45 of its minute — 0 when already past it. */
export function msUntilReadSecond(now: Date): number {
  const intoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return Math.max(0, CAPACITY_ALERT_READ_SECOND * 1000 - intoMinute);
}

export const capacityAlertEvaluation = defineJob(
  {
    id: 'system.capacity-alert-evaluation',
    cron: CAPACITY_ALERT_EVALUATION_CRON,
    // `latest`: a pass reads the CURRENT state, so a missed one is not work to
    // replay — the next one raises whatever is still over.
    catchUp: 'latest',
    // `idempotent`: the raise is exactly-once in the store, so a retried pass
    // re-raises nothing and alerts nothing new.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    await ctx.step.sleep('align-to-late-minute', msUntilReadSecond(new Date()));
    return ctx.step.run('capacity-alert-evaluation', () => services.capacityAlertJob.run());
  },
);
