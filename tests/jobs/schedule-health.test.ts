import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, seedHealthyJobSchedules } from '../helpers/jobs';
import { db } from '@/lib/db';
// Importing the registry is what evaluates every definition module, which is
// what populates the schedule table via `defineJob`. The coverage test below
// depends on that having happened; so does production, where the serve route
// does the same import.
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobSchedules, registerSchedule } from '@/lib/jobs/schedules';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_PAYLOAD,
  ScheduledJobsOverdueError,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// THE DETECTION SEAM for a stale Inngest app registry (MOTIR-1970).
//
// Production ran from 2026-07-02 to 2026-08-01 with five jobs registered
// nowhere: their events were accepted and consumed by nothing, no run created,
// no ledger row written, no error raised. Nothing in the system could tell a
// dead job from an untriggered one. These tests pin the machinery that now can.
//
// The clock is INJECTED into every check — a detector whose verdict depends on
// when the suite happens to run is a detector that goes red for the wrong
// reason (auto-memory: timestamp assertions are windows, never wall-clock
// equalities).

/** Insert a completed ledger row for a scheduled job at a given instant. */
async function recordScheduledRun(functionId: string, startedAt: Date): Promise<void> {
  await adminDb.jobRun.create({
    data: {
      workspaceId: null,
      functionId,
      // The synthetic name `defineJob` records for a cron run — the key the
      // check groups on.
      eventName: `scheduled.${functionId}`,
      eventId: `evt-${functionId}-${startedAt.getTime()}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    },
  });
}

beforeEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the schedule table', () => {
  it('covers EVERY cron job in the registry', () => {
    // This is the completeness guarantee the service deliberately does NOT get
    // by importing the registry itself (that import would be a cycle). If a
    // future job declares a cron by some route that bypasses `defineJob`, the
    // health check would silently stop watching it — and silence is exactly the
    // fault being defended against. So the assertion lives here.
    const registered = new Set(jobSchedules().map((s) => s.functionId));

    // Read the cron ids straight off the shipped definitions, which is an
    // INDEPENDENT source from the table under test. (It used to read them off the
    // vendor function objects' `opts.triggers`, and the ids there were
    // app-prefixed — `prodect-core-system.foo` — so this loop stripped the prefix.
    // A definition carries the bare id, so there is nothing to strip.)
    const cronJobIds = jobDefinitions.filter((d) => d.cron !== undefined).map((d) => d.id);

    // Guard the guard: this test would pass vacuously on an empty list. Motir has
    // had cron jobs since 1.6.4.
    expect(cronJobIds.length).toBeGreaterThan(0);

    for (const id of cronJobIds) {
      expect(registered, `cron job ${id} is missing from the schedule table`).toContain(id);
    }
  });

  it('is sorted by id, so a report reads the same way twice', () => {
    const ids = jobSchedules().map((s) => s.functionId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('pairs each id with a parseable cron expression', () => {
    for (const { functionId, cron } of jobSchedules()) {
      expect(cron, `${functionId} has no cron`).toMatch(/\S/);
    }
  });
});

describe('jobScheduleHealthService.check', () => {
  it('reports every scheduled job, healthy or not', async () => {
    const report = await jobScheduleHealthService.check(new Date('2026-08-01T22:00:00Z'));
    expect(report.entries.map((e) => e.functionId)).toEqual(
      jobSchedules().map((s) => s.functionId),
    );
    expect(report.checkedAt).toBe('2026-08-01T22:00:00.000Z');
  });

  it('flags a cron job the ledger has NEVER seen', async () => {
    // The MOTIR-1970 shape exactly: the job exists in code, is never registered
    // with Inngest, and so has no run at all. With an empty ledger every cron
    // job is in this state.
    const report = await jobScheduleHealthService.check(new Date('2026-08-01T22:00:00Z'));

    const gateSweep = report.overdue.find((e) => e.functionId === 'system.ci-actions-gate-sweep');
    expect(gateSweep).toBeDefined();
    expect(gateSweep!.lastRunAt).toBeNull();
    expect(gateSweep!.cron).toBe('30 * * * *');
  });

  it('clears an hourly job that ran on the most recent tick', async () => {
    const now = new Date('2026-08-01T22:05:00Z');
    // `30 * * * *` — the most recent tick before 22:05 is 21:30.
    await recordScheduledRun('system.ci-actions-gate-sweep', new Date('2026-08-01T21:30:05Z'));

    const report = await jobScheduleHealthService.check(now);
    expect(report.overdue.map((e) => e.functionId)).not.toContain('system.ci-actions-gate-sweep');

    const entry = report.entries.find((e) => e.functionId === 'system.ci-actions-gate-sweep')!;
    expect(entry.lastRunAt).toBe('2026-08-01T21:30:05.000Z');
    // Judged against the tick BEFORE the most recent one — 20:30.
    expect(entry.judgedAgainst).toBe('2026-08-01T20:30:00.000Z');
  });

  it('FORGIVES exactly one missed tick', async () => {
    const now = new Date('2026-08-01T22:05:00Z');
    // Ran at 20:30 — it has missed 21:30, but only that one. One tick of slack
    // absorbs a deploy window or a transient Inngest delay.
    await recordScheduledRun('system.ci-actions-gate-sweep', new Date('2026-08-01T20:30:05Z'));

    const report = await jobScheduleHealthService.check(now);
    expect(report.overdue.map((e) => e.functionId)).not.toContain('system.ci-actions-gate-sweep');
  });

  it('FLAGS two consecutive missed ticks', async () => {
    const now = new Date('2026-08-01T22:05:00Z');
    // Ran at 19:30 — 20:30 and 21:30 both missed. Two in a row is a fault.
    await recordScheduledRun('system.ci-actions-gate-sweep', new Date('2026-08-01T19:30:05Z'));

    const report = await jobScheduleHealthService.check(now);
    const entry = report.overdue.find((e) => e.functionId === 'system.ci-actions-gate-sweep');
    expect(entry).toBeDefined();
    expect(entry!.lastRunAt).toBe('2026-08-01T19:30:05.000Z');
  });

  it('scales the tolerance to the PERIOD, not to a fixed number of minutes', async () => {
    // The same 26-hour-old run is fine for a monthly job and a fault for an
    // hourly one. That is the property a hardcoded staleness ceiling could not
    // express, and the reason the check does cron arithmetic at all.
    const now = new Date('2026-08-01T22:05:00Z');
    const twentySixHoursAgo = new Date('2026-07-31T20:00:00Z');
    await recordScheduledRun('system.ci-minutes-reconcile', twentySixHoursAgo); // 0 4 3 * *
    await recordScheduledRun('system.auto-plan-cadence-tick', twentySixHoursAgo); // 20 * * * *

    const report = await jobScheduleHealthService.check(now);
    const overdueIds = report.overdue.map((e) => e.functionId);
    expect(overdueIds).toContain('system.auto-plan-cadence-tick');
    expect(overdueIds).not.toContain('system.ci-minutes-reconcile');
  });

  it('counts only SCHEDULED runs — a manual replay of the same function does not clear it', async () => {
    const now = new Date('2026-08-01T22:05:00Z');
    // A DLQ replay writes the function's own id as the event name, not the
    // synthetic `scheduled.` one. It proves someone poked the job by hand; it
    // does not prove the cron is firing.
    await adminDb.jobRun.create({
      data: {
        workspaceId: null,
        functionId: 'system.ci-actions-gate-sweep',
        eventName: 'system.ci-actions-gate-sweep',
        eventId: 'evt-replay',
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        startedAt: new Date('2026-08-01T22:00:00Z'),
      },
    });

    const report = await jobScheduleHealthService.check(now);
    expect(report.overdue.map((e) => e.functionId)).toContain('system.ci-actions-gate-sweep');
  });

  it('does not judge a schedule that has not yet owed a second tick', async () => {
    // A schedule whose second-most-recent fire falls outside the search horizon
    // is reported but never flagged — holding a brand-new or extremely sparse
    // job to a deadline it was never given would make the report noise, and a
    // noisy detector gets ignored.
    const report = await jobScheduleHealthService.check(new Date('2026-08-01T22:00:00Z'));
    for (const entry of report.entries) {
      if (entry.judgedAgainst === null) {
        expect(report.overdue).not.toContain(entry);
      }
    }
  });
});

describe('system.daily-health-check', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive the real job and assert it resolved clean, with nothing overdue. */
  async function expectHealthyRun(): Promise<void> {
    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    // Assert the error FIRST: when the run throws, `result` is undefined and a
    // payload assertion fails as a bare TypeError that hides the offenders.
    expect(error?.message).toBeUndefined();
    const payload = result as { ok: boolean; check: string; schedules: { overdue: unknown[] } };
    expect(payload.ok).toBe(DAILY_HEALTH_CHECK_PAYLOAD.ok);
    expect(payload.check).toBe(DAILY_HEALTH_CHECK_PAYLOAD.check);
    expect(payload.schedules.overdue).toEqual([]);
  }

  it('resolves with the schedule report when every cron is firing', async () => {
    // Give every registered cron a run "just now" through the shared fixture,
    // then drive the real job. The fixture seeds at `now`, not `now - 60s`
    // (MOTIR-2013): an every-minute cron is held to `floor_to_minute(check) -
    // 60s`, so a run seeded a minute back misses that deadline whenever a
    // minute boundary falls between the seed and the check (MOTIR-11822).
    await seedHealthyJobSchedules();

    await expectHealthyRun();
  });

  it('stays green when a minute boundary falls between the seed and the check', async () => {
    // The CI failure MOTIR-11822 was filed from, made deterministic: the seed
    // lands at hh:mm:59.900 and the check reads the clock at hh:(mm+1):00.920 —
    // the instant the failing shard finished. A seed at `now - 60s` sits before
    // the every-minute crons' deadline (hh:mm:00) here and turns the run red;
    // the shared fixture's seed at `now` clears it with the full margin.
    vi.setSystemTime(new Date('2026-11-19T12:41:59.900Z'));
    await seedHealthyJobSchedules();

    vi.setSystemTime(new Date('2026-11-19T12:42:00.920Z'));
    await expectHealthyRun();
  });

  it('FAILS the run when a cron job has stopped firing', async () => {
    // The ledger is empty (truncated in beforeEach), so every cron job reads as
    // never-run — the MOTIR-1970 state. The health check must NOT return ok.
    //
    // This is the assertion the whole card exists for. Delete the throw in
    // dailyHealthCheck.ts and this test goes green-to-red: that is the
    // mutation-check that the alarm is actually wired to something.
    //
    // `the in-process JobTestEngine` CAPTURES a handler throw onto `error` rather than
    // rejecting `execute()`, and hands it back SERIALIZED (a plain
    // `{ name, message, stack }`, the same round-trip the real executor does) —
    // so assert on the shape, not on `instanceof Error`, and assert `result` is
    // absent. (`rejects.toThrow` here would pass vacuously in the healthy case
    // and fail confusingly in the broken one.)
    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { name?: string; message?: string };
    };

    // The serialization FLATTENS the subclass name to plain `Error` — which is
    // precisely why `ScheduledJobsOverdueError` puts the offenders in the
    // MESSAGE rather than on a typed field. The message is the only part that
    // survives to the DLQ row (`defineJob`'s serializeFailure reads
    // `err.message`), so the message is what gets asserted.
    expect(result).toBeUndefined();
    expect(error!.message).toMatch(/have not run since their previous tick/);
    // The three crons that were actually dead in production are each named, so
    // the DLQ row an operator opens is the whole diagnosis.
    expect(error!.message).toContain('system.auto-plan-cadence-tick');
    expect(error!.message).toContain('system.ci-actions-gate-sweep');
    expect(error!.message).toContain('system.ci-minutes-reconcile');
    // The check clears ITSELF — `recordStart` writes its row before the handler
    // body runs — so it is never among the offenders.
    expect(error!.message).not.toContain('system.daily-health-check');
  });

  it('names the offenders in the error, so the DLQ row is actionable', () => {
    const error = new ScheduledJobsOverdueError({
      checkedAt: '2026-08-01T22:00:00.000Z',
      entries: [],
      overdue: [
        {
          functionId: 'system.code-graph-index',
          cron: '0 * * * *',
          lastRunAt: null,
          judgedAgainst: '2026-08-01T20:00:00.000Z',
        },
      ],
    });

    // An operator reading the DLQ tab should learn WHICH job stopped and what to
    // do about it without opening a database.
    expect(error.message).toContain('system.code-graph-index');
    expect(error.message).toContain('last run never');
    // ⚠️ THIS USED TO ASSERT `PUT /api/inngest` — the re-sync an operator ran when
    // a stale vendor app registry had stranded a cron (MOTIR-1970). There is no
    // registry to re-sync (MOTIR-3418), so an overdue verdict now means a dead
    // worker or a stalled scheduler, and the message names the two commands that
    // distinguish them. The assertion is that it still says what to DO, which is
    // the property the original line was protecting.
    expect(error.message).toContain('worker process group');
    expect(error.message).toContain('[job-scheduler]');
    expect(error.name).toBe('ScheduledJobsOverdueError');
  });
});

// LAST in the file on purpose: it adds a row to the module-level schedule table,
// which every earlier test reads. (Vitest isolates modules per file, so it
// cannot leak into another suite.)
describe('a schedule with no fire inside the horizon', () => {
  it('is reported, but never flagged', async () => {
    // 31 February never occurs. A cron nobody could satisfy must not read as a
    // fault: a detector that cries wolf about an undeliverable schedule is a
    // detector that gets muted, which is how the original silence comes back.
    registerSchedule('system.never-fires', '0 9 31 2 *');

    const report = await jobScheduleHealthService.check(new Date('2026-08-01T22:00:00Z'));
    const entry = report.entries.find((e) => e.functionId === 'system.never-fires');

    expect(entry).toBeDefined();
    expect(entry!.judgedAgainst).toBeNull();
    expect(entry!.lastRunAt).toBeNull();
    expect(report.overdue.map((e) => e.functionId)).not.toContain('system.never-fires');
  });
});
