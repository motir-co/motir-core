// The SCHEDULE TABLE (MOTIR-1970) — every cron job's id paired with its cron
// expression, populated by `defineJob` itself as each definition module loads.
//
// WHY IT SELF-REGISTERS. The schedule-health check needs to iterate the cron
// jobs, and every other way of getting that list can drift from reality: a
// hand-maintained array is a second source of truth that a new job forgets to
// join, and reading the crons back off the built Inngest function objects means
// reaching into SDK internals that an upgrade can rename. Registering from
// inside `defineJob` makes the table complete BY CONSTRUCTION — a job cannot
// declare a cron without appearing here, which is exactly the property the
// check depends on.
//
// COMPLETENESS DEPENDS ON IMPORT. The table only holds jobs whose definition
// module has been evaluated. `lib/jobs/registry.ts` imports all of them, so any
// consumer MUST import the registry before reading this — `jobScheduleHealth
// Service` does, deliberately and with a comment saying why.

import { parseCron } from './cron';

const schedules = new Map<string, string>();

/**
 * Record that `id` is a cron job on `cron`. Called by `defineJob`; not part of
 * the public job-authoring surface. Idempotent — a re-registration under the
 * same id (module re-evaluation under HMR or a test harness) overwrites rather
 * than duplicating.
 */
export function registerSchedule(id: string, cron: string): void {
  schedules.set(id, cron);
}

/** One row of the schedule table: a scheduled job's id and its cron expression. */
export interface JobSchedule {
  functionId: string;
  cron: string;
}

/** Every scheduled job registered so far, sorted by id for a stable report. */
export function jobSchedules(): ReadonlyArray<JobSchedule> {
  return [...schedules.entries()]
    .map(([functionId, cron]) => ({ functionId, cron }))
    .sort((a, b) => a.functionId.localeCompare(b.functionId));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CADENCE INVARIANT (MOTIR-6893 · MOTIR-6932) — one sub-hourly cadence
//
// Every `system.*` job that fires more than once an hour fires EXACTLY on
// `SUB_HOURLY_CADENCE` — every 5 minutes — unless its id is named in
// `SUB_HOURLY_CADENCE_EXCEPTIONS` with a reason. Hourly and slower jobs keep
// whatever cron their own definition argues for.
//
// It replaced the :00/:30 CLUSTER invariant (MOTIR-3314), which spaced every
// wake half an hour apart so a suspend-when-idle Postgres could sleep between
// ticks. That saving stopped existing when scheduling moved onto the job worker
// (MOTIR-3418): the worker polls the database every ≤ 5 s, so the compute never
// suspends whatever the cron shape, and the cluster was buying nothing while
// costing every sweep up to half an hour of latency. The decision is
// `docs/decisions/always-on-database-job-cadence.md`.
//
// Why an invariant at all, once the bill is gone: one cadence is what makes the
// schedule legible — a reader, the health check's overdue arithmetic and every
// worst-case comment in a definition can assume it — and a job that needs a
// different one has to SAY so, here, where the next reader will look. The
// assertion is `tests/jobs/schedule-cadence.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** The one cadence a sub-hourly `system.*` job runs at. */
export const SUB_HOURLY_CADENCE = '*/5 * * * *';

/**
 * Sub-hourly jobs allowed a cadence other than `SUB_HOURLY_CADENCE`, each with a
 * one-line reason. Three today: the fleet headroom pass, the growth pass acting
 * on it, and the capacity alert pass. A job
 * joins only when its own decision derives a different cadence — never to make a
 * test pass.
 */
export const SUB_HOURLY_CADENCE_EXCEPTIONS: Readonly<Record<string, string>> = {
  // MOTIR-8969 · `fleet-per-org-pool.md` AMENDMENT 1 §A1.10.
  'system.fleet-shard-headroom':
    'a 5-minute registration window must be read inside its own window',
  // MOTIR-9462 · the growth pass acts on that reading, so it runs at its cadence.
  'system.fleet-pool-growth': 'pool growth acts on the every-minute headroom reading',
  // MOTIR-9582 · a Host purchase starts a days-long quota wait at account
  // creation, so the reconcile runs at the growth pass's cadence.
  'system.host-account-reconcile': 'a Host purchase starts its quota wait at account creation',
  // MOTIR-9585 · the state pass follows the every-minute quota reads it derives from.
  'system.host-account-state': 'an own account follows the every-minute quota reads',
  // MOTIR-9942 · an enterprise tenant's AWS deploys wait on its account being
  // ready, so the reconcile runs at the Host reconcile's cadence.
  'system.hosting-tenant-account-reconcile':
    "an enterprise tenant's deploys wait on its account being ready",
  // MOTIR-9612 · the gateway capacity contract §3 *Lanes*.
  'system.capacity-alert-evaluation':
    'the gateway counts rpm/tpm per fixed clock minute, so one late read per minute is one reading per window',
};

/**
 * True when `cron` can fire more than once in some hour — i.e. its MINUTE field
 * holds more than one value. Reads the minute field alone: a `0,30 9 * * *` job
 * fires twice in the 09:00 hour, and that is sub-hourly for that hour.
 */
export function firesMoreThanOncePerHour(cron: string): boolean {
  return parseCron(cron).minute.size > 1;
}

/**
 * Every schedule that breaks the cadence invariant: sub-hourly, not exactly
 * `SUB_HOURLY_CADENCE`, and not named in `SUB_HOURLY_CADENCE_EXCEPTIONS`.
 * Empty on a conforming table.
 */
export function subHourlyCadenceViolations(
  schedules: ReadonlyArray<JobSchedule> = jobSchedules(),
  exceptions: Readonly<Record<string, string>> = SUB_HOURLY_CADENCE_EXCEPTIONS,
): JobSchedule[] {
  return schedules.filter(
    ({ functionId, cron }) =>
      firesMoreThanOncePerHour(cron) &&
      cron !== SUB_HOURLY_CADENCE &&
      !Object.hasOwn(exceptions, functionId),
  );
}
