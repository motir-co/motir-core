import { defineJob } from '../defineJob';

// THE GRACE-WINDOW REMINDERS (Story MOTIR-9800 · MOTIR-12136) — the clock behind
// decision MOTIR-9802's "7 days and 1 day before the stop".
//
// The policy — which applications are due a reminder, the smallest threshold
// reached, the ledger that makes each go out once — is all in
// `hostedApplicationGraceNotifier.sendDueReminders`, which enqueues the
// `hosting.application-grace.notice` job for each. This file is the schedule.
//
// SYSTEM-scoped: the due set spans tenants. `idempotent`: a reminder already
// recorded is never enqueued again, and one enqueued but not yet sent collapses
// on its `<applicationId>:<kind>` key, so re-running the tick is free.

/** Minute 25 of every hour: `stopsAt` is a timestamp, not a date, so a reminder
 *  goes out within the hour of crossing its threshold. Off the :00 and :30
 *  marks the other hourly sweeps share, and ten minutes before the stop sweep
 *  (:35). */
export const HOSTED_APPLICATION_GRACE_NOTICE_SWEEP_CRON = '25 * * * *';

export const hostedApplicationGraceNoticeSweep = defineJob(
  {
    id: 'system.hosted-application-grace-notice-sweep',
    cron: HOSTED_APPLICATION_GRACE_NOTICE_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('enqueue-due-grace-reminders', () =>
      services.hostedApplicationGraceNotifier.sendDueReminders(),
    );
  },
);
