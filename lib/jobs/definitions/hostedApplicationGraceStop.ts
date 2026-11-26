import { ApplicationNotFoundError, ApplicationNotStoppableError } from '@/lib/hosting/errors';
import { defineJob } from '../defineJob';

// THE END OF A GRACE WINDOW (Story MOTIR-9800 · MOTIR-12135).
//
// `system.hosting-application-grace-stop` finds every `grace` application whose
// `stopsAt` has passed and stops each one through
// `hostedApplicationHandoverService.stopApplication`, in a step of its own, so
// a stop that fails never blocks the others. A failed stop is ANSWERED in its
// step, not thrown: the application stays `grace`, and the next hourly fire
// finds it again and continues from the step that failed. A stop the sweep
// raced with an admin's Stop now answers `already_stopped`, and an application
// that left `grace` between the list and its step answers `skipped`.
//
// Only `stopsAt` ends a window here: nothing in this job, or in the stop, reads
// an organisation's credit balance.

/** Minute 35 of every hour: a window ends within the hour of its `stopsAt`.
 *  Off the :00 and :30 marks the other hourly sweeps share. */
export const HOSTED_APPLICATION_GRACE_STOP_CRON = '35 * * * *';

export const hostedApplicationGraceStop = defineJob(
  {
    id: 'system.hosting-application-grace-stop',
    cron: HOSTED_APPLICATION_GRACE_STOP_CRON,
    // `latest`: the predicate is "stopsAt has passed now", so one pass after the
    // worker returns covers every fire it missed.
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const due = await ctx.step.run('list-grace-applications-due', () =>
      services.hostedApplicationHandover.listApplicationsDueToStop(),
    );
    let stopped = 0;
    let failed = 0;
    for (const applicationId of due) {
      const result = await ctx.step.run(`grace-stop:${applicationId}`, async () => {
        try {
          const outcome = await services.hostedApplicationHandover.stopApplication(applicationId, {
            kind: 'system',
          });
          return { outcome: outcome.outcome };
        } catch (err) {
          if (
            err instanceof ApplicationNotStoppableError ||
            err instanceof ApplicationNotFoundError
          ) {
            return { outcome: 'skipped' as const };
          }
          const code = (err as { code?: unknown } | null)?.code;
          console.warn('[hostedApplicationGraceStop] a stop failed; the next sweep retries it', {
            applicationId,
            code: typeof code === 'string' ? code : 'UNKNOWN',
          });
          return { outcome: 'failed' as const };
        }
      });
      if (result.outcome === 'stopped') stopped += 1;
      if (result.outcome === 'failed') failed += 1;
    }
    return { due: due.length, stopped, failed };
  },
);
