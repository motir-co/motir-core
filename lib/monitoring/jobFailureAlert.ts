import * as Sentry from '@sentry/nextjs';

import type { JobRunLane } from '@/lib/dto/jobs';

// A TERMINALLY FAILED JOB REACHES A PERSON (MOTIR-3606) — the delivery half of
// the background-job failure surface.
//
// ⚠️ WHY THIS FILE EXISTS, stated as the fault rather than as the feature.
// `system.daily-health-check` failed every single morning from 2026-08-04 to
// 2026-08-26 and nobody found out for 23 days. The probe was not broken in the
// sense that mattered — it was doing exactly what it was built to do, writing a
// `failed` row and a dead-letter row and putting a diagnosis in the message. The
// defect was that **its verdict had no consumer**: the only surfaces carrying it
// were `job_run` and the DLQ tab of the then-tenant Job runs page, both of which
// are places a person has to decide to go and look. A correct alarm nobody hears
// and a silent one are the same alarm from outside, and this deployment ran the
// whole job-substrate migration with the second kind.
//
// So the fix that matters is not a greener probe, it is a signal that LEAVES the
// database. Sentry is that signal: it is already provisioned (MOTIR-1161), already
// wired for the server and edge runtimes (MOTIR-1162), already has a recorded
// transfer basis for error payloads, and already mails a project member when an
// issue is created. It needed two things it did not have — to be initialised in
// the process that actually runs jobs, and to be told when one terminally fails.
// This is the second; `lib/monitoring/config.ts`'s `serverSentryInitOptions()`
// and `scripts/worker.ts` are the first.
//
// ⚠️ IT IS A POST-COMMIT SIDE EFFECT AND IS BEST-EFFORT, WITHOUT EXCEPTION. The
// ledger row is the durable record and the alert is a notification about it, so a
// transport that hiccups must never turn a recorded failure into an unrecorded
// one. Every call is wrapped, nothing is awaited into the caller's transaction,
// and the function has no failure mode of its own.
//
// ⚠️ AND IT IS DELIBERATELY NOT A NEW `type: manual` OPERATOR STEP. There is no
// alert-routing variable to set and no dashboard to configure: `SENTRY_DSN` is
// already a deployed secret on `motir-core` (read from the platform 2026-08-27),
// so this ships wired. A build with no DSN — the self-host path — calls a no-op,
// which is the same contract every other Sentry entry point holds.

/** One terminally-failed job run, as the alert needs to describe it. */
export interface TerminalJobFailureAlert {
  /** The job id — `system.daily-health-check`, `system.code-graph-refresh`, … */
  readonly functionId: string;
  /** The ledger event name (the synthetic `scheduled.{id}` for a cron job). */
  readonly eventName: string;
  /** Tenancy of the run; null for a system / cross-workspace job. */
  readonly workspaceId: string | null;
  /** Total attempts made before the retry budget was spent, including the first. */
  readonly attempts: number;
  /**
   * Which runtime executed it — the two lanes fail for different reasons.
   *
   * ⚠️ TYPED AS `JobRunLane`, NOT AS ITS OWN UNION (MOTIR-3683). This alert and
   * the `job_run.lane` column landed within an hour of each other and were two
   * spellings of one axis; a second definition is how the two would eventually
   * disagree about what a lane is. Same values, one type — the FIELD keeps its
   * own name because `engine` reads correctly beside `job_engine` on the Sentry
   * tag, and a rename would churn a surface an on-call person already knows.
   */
  readonly engine: JobRunLane;
  /** The final thrown value, unserialized, so Sentry gets a real stack. */
  readonly error: unknown;
}

/**
 * Report a terminally-failed job run to error monitoring.
 *
 * ⚠️ FINGERPRINTED BY JOB ID AND ERROR NAME, not by stack. A scheduled job that
 * fails the same way every morning must collapse into ONE issue that keeps
 * getting louder, because that is the shape of the fault this exists to catch —
 * 23 identical failures are one problem, and 23 separate issues are a mailbox a
 * person learns to filter. Sentry's default grouping would split them on frame
 * addresses; naming the fingerprint is what makes the recurrence legible.
 *
 * NEVER THROWS and never returns a promise the caller must await: a notification
 * is not allowed to fail a ledger write (`lib/services/jobRunsService.ts` owns
 * the durable half). A build with no DSN never called `Sentry.init`, so every
 * call here is a no-op — the self-host contract, unchanged.
 */
export function alertTerminalJobFailure(alert: TerminalJobFailureAlert): void {
  try {
    Sentry.captureException(alert.error, {
      level: 'error',
      // `job_id` is the tag an alert rule filters on, and the one a person
      // reading the issue list needs to see without opening anything.
      tags: {
        job_id: alert.functionId,
        job_engine: alert.engine,
        job_terminal_failure: 'true',
      },
      fingerprint: ['job-terminal-failure', alert.functionId, errorName(alert.error)],
      extra: {
        eventName: alert.eventName,
        workspaceId: alert.workspaceId,
        attempts: alert.attempts,
      },
    });
  } catch {
    // Swallowed on purpose — see the header. There is nowhere better for this to
    // go: the caller is the code that records failures, so a throw here would
    // land in the one path whose job is to survive a failure.
  }
}

/** The error's CLASS, which is what distinguishes two faults on one job.
 *
 *  `IndexFleetImageUnpullableError` and `ScheduledJobsOverdueError` both come out
 *  of `system.daily-health-check` and are unrelated problems; folding them into
 *  one issue because they share a job id would hide the second behind the first
 *  for as long as the first took to fix — which is precisely what happened for 23
 *  days on the ROW, and would be a poor thing to reproduce in the alert. */
function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'UnknownError';
}
