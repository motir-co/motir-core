import * as Sentry from '@sentry/nextjs';

export type CapacityAlertJobProblem = 'auth_refused' | 'bad_response' | 'failed';

/**
 * Tell the platform admin the scheduled capacity alert pass cannot do its job
 * (Story MOTIR-9539 · MOTIR-9612): the gateway refused the capacity token or
 * answered something unreadable — a configuration fault nobody else sees — or
 * the evaluation itself threw.
 *
 * ⚠️ FINGERPRINTED PER KIND, so a fault that persists is one issue that keeps
 * getting events, not a new issue every minute. The event carries the error and
 * the kind tag only: no token, no response body, no tenant.
 *
 * NEVER THROWS: a report is not allowed to stop the pass that made it.
 */
export function reportCapacityAlertJobProblem(
  kind: CapacityAlertJobProblem,
  error?: unknown,
): void {
  try {
    const captured =
      error ?? new Error(`capacity alert job: the gateway capacity read was ${kind}`);
    Sentry.captureException(captured, {
      level: kind === 'failed' ? 'error' : 'warning',
      tags: { capacity_alert_job: kind },
      fingerprint: ['capacity-alert-job', kind],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}
