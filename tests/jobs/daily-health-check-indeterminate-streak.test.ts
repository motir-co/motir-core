import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, seedHealthyJobSchedules } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { db } from '@/lib/db';
import { Prisma } from '@/generated/prisma/client';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_NESTED_PROBES,
  DAILY_HEALTH_CHECK_PROBES,
  indeterminateReadings,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { PROBE_INDETERMINATE_STREAK_CODE } from '@/lib/dto/indeterminateStreak';
import {
  DAILY_HEALTH_CHECK_FUNCTION_ID,
  INDETERMINATE_STREAK_THRESHOLD,
  indeterminateStreakService,
} from '@/lib/services/indeterminateStreakService';
import { runnerImageFreshnessProbeService } from '@/lib/services/runnerImageFreshnessProbeService';
import { LIVE_STEP_SHAPES } from './stepResultShapePins';

// MOTIR-10429 — a probe of `system.daily-health-check` that reads "could not
// tell" run after run must fail the check, naming the probe.
//
// Every probe with an `indeterminate` arm records it on the run and stays green,
// on purpose (one GHCR or GitHub blip must not page anyone). The defect was that
// nothing read the RUN of them: a read that failed every day — an expired
// token, a revoked App installation, a rate-limited anonymous GitHub read — hid
// the fault the probe exists to find for as long as it lasted. The first
// `describe` block below is that reproduction: N indeterminate mornings in a row,
// and before this change every one of them succeeded.

const RUNNER_IMAGE = 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d';

const indeterminateFreshness = {
  verdict: 'indeterminate' as const,
  checkedAt: '2026-11-05T09:00:00.000Z',
  image: RUNNER_IMAGE,
  phase: 'github' as const,
  detail: 'GitHub answered 403 (rate limit) listing commits',
  ami: { state: 'unset' as const },
};

/** A succeeded daily-check row from `daysAgo` days back, carrying `output`. */
async function seedRun(
  daysAgo: number,
  output: Record<string, unknown> | null,
  status = 'succeeded',
  failure: Record<string, unknown> | null = null,
) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: null,
      functionId: DAILY_HEALTH_CHECK_FUNCTION_ID,
      eventName: `scheduled.${DAILY_HEALTH_CHECK_FUNCTION_ID}`,
      eventId: `seed-${daysAgo}-${status}`,
      lane: 'engine',
      attempt: 1,
      status: status as 'succeeded' | 'failed',
      startedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      finishedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 + 1000),
      output: output === null ? Prisma.DbNull : (output as Prisma.InputJsonValue),
      failure: failure === null ? Prisma.DbNull : (failure as Prisma.InputJsonValue),
    },
  });
}

const stillIndeterminate = { runnerImageFreshness: { verdict: 'indeterminate' } };
const answered = { runnerImageFreshness: { verdict: 'current' } };

beforeEach(async () => {
  await truncateJobRuns();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the daily check fails on a probe that cannot tell on N runs in a row', () => {
  it('stays green below the threshold, and records the streak on the row', async () => {
    await seedHealthyJobSchedules();
    for (let day = INDETERMINATE_STREAK_THRESHOLD - 2; day >= 1; day -= 1) {
      await seedRun(day, stillIndeterminate);
    }
    vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue(indeterminateFreshness);

    const { result, error } = await new JobTestEngine({ function: dailyHealthCheck }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      indeterminateStreak: {
        verdict: 'ok',
        threshold: INDETERMINATE_STREAK_THRESHOLD,
        streaks: [
          {
            probe: 'runnerImageFreshness',
            step: 'runner-image-freshness-v2',
            consecutive: INDETERMINATE_STREAK_THRESHOLD - 1,
            phase: 'github',
          },
        ],
      },
    });
  });

  it('FAILS on the Nth run, naming the probe, the streak and the latest read', async () => {
    await seedHealthyJobSchedules();
    for (let day = INDETERMINATE_STREAK_THRESHOLD - 1; day >= 1; day -= 1) {
      await seedRun(day, stillIndeterminate);
    }
    vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue(indeterminateFreshness);

    const { result, error, ctx } = await new JobTestEngine({
      function: dailyHealthCheck,
    }).execute();

    expect(result).toBeUndefined();
    expect(error?.name).toBe('ProbeIndeterminateStreakError');
    expect(error?.message).toContain(
      `runnerImageFreshness (step runner-image-freshness-v2) on ${INDETERMINATE_STREAK_THRESHOLD} runs in a row`,
    );
    expect(error?.message).toContain(
      `latest read failed at github: ${RUNNER_IMAGE}: GitHub answered 403 (rate limit) listing commits`,
    );
    expect(error?.message).toContain('⚠️ SCOPE:');
    // What the failed row records, so the next run counts through this one.
    expect(error).toMatchObject({
      code: PROBE_INDETERMINATE_STREAK_CODE,
      failureData: { indeterminateProbes: ['runnerImageFreshness'] },
    });
    const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
    expect(stepIds).toContain('indeterminate-streak');
  });

  it('a definite verdict in between resets the streak', async () => {
    await seedHealthyJobSchedules();
    await seedRun(4, stillIndeterminate);
    await seedRun(3, stillIndeterminate);
    await seedRun(2, answered);
    await seedRun(1, stillIndeterminate);
    vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue(indeterminateFreshness);

    const { result, error } = await new JobTestEngine({ function: dailyHealthCheck }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      indeterminateStreak: { verdict: 'ok', streaks: [{ consecutive: 2 }] },
    });
  });

  it('a definite verdict on THIS run is no streak at all, whatever came before', async () => {
    await seedHealthyJobSchedules();
    for (let day = 5; day >= 1; day -= 1) await seedRun(day, stillIndeterminate);

    const { result, error } = await new JobTestEngine({ function: dailyHealthCheck }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ indeterminateStreak: { verdict: 'ok', streaks: [] } });
  });
});

describe('a nested judgement keeps its own streak', () => {
  it('FAILS when the AMI read cannot tell on N runs while the image is current', async () => {
    await seedHealthyJobSchedules();
    const amiStuck = {
      runnerImageFreshness: { verdict: 'current', ami: { state: 'indeterminate' } },
    };
    for (let day = INDETERMINATE_STREAK_THRESHOLD - 1; day >= 1; day -= 1) {
      await seedRun(day, amiStuck);
    }
    vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
      verdict: 'current',
      checkedAt: '2026-11-05T09:00:00.000Z',
      build: { image: RUNNER_IMAGE, commit: 'abc', source: 'label' },
      ami: { state: 'indeterminate', amiId: 'ami-0123', phase: 'ec2', detail: 'AccessDenied' },
    } as never);

    const { error } = await new JobTestEngine({ function: dailyHealthCheck }).execute();

    expect(error?.name).toBe('ProbeIndeterminateStreakError');
    expect(error?.message).toContain(
      `runnerImageFreshness.ami (step runner-image-freshness-v2) on ${INDETERMINATE_STREAK_THRESHOLD} runs in a row`,
    );
    expect(error?.message).toContain('latest read failed at ami ec2: ami-0123: AccessDenied');
  });
});

describe('indeterminateStreakService.check', () => {
  const reading = {
    probe: 'runnerImageFreshness',
    step: 'runner-image-freshness-v2',
    indeterminate: { phase: 'registry', detail: 'no answer' },
  };

  it('skips a FAILED run — it recorded no verdicts — rather than letting it break the streak', async () => {
    await seedRun(3, stillIndeterminate);
    await seedRun(2, null, 'failed');
    await seedRun(1, stillIndeterminate);

    const verdict = await indeterminateStreakService.check([reading]);

    expect(verdict).toMatchObject({ verdict: 'persistent', runsRead: 3 });
    expect(verdict.streaks[0]).toMatchObject({ consecutive: 3, phase: 'registry' });
    expect(verdict.blindSpot).toContain('FAILED');
  });

  it('counts THROUGH the runs the alarm itself failed, so the streak keeps growing', async () => {
    // Day 5 and 4 seeded the streak; days 3..1 are the alarm firing. Before
    // MOTIR-10429's review fix those three were skipped, the count stuck at the
    // threshold, and once retention pruned days 5 and 4 the check went green.
    const streakFailure = {
      message: 'health probe(s) could not tell',
      code: PROBE_INDETERMINATE_STREAK_CODE,
      data: { indeterminateProbes: ['runnerImageFreshness'] },
    };
    await seedRun(5, stillIndeterminate);
    await seedRun(4, stillIndeterminate);
    for (const day of [3, 2, 1]) await seedRun(day, null, 'failed', streakFailure);

    const verdict = await indeterminateStreakService.check([reading]);

    expect(verdict).toMatchObject({ verdict: 'persistent', runsRead: 5 });
    expect(verdict.streaks[0]).toMatchObject({ consecutive: 6 });
  });

  it('keeps the alarm on after the rows that seeded the streak are pruned', async () => {
    const streakFailure = {
      message: 'health probe(s) could not tell',
      code: PROBE_INDETERMINATE_STREAK_CODE,
      data: { indeterminateProbes: ['runnerImageFreshness'] },
    };
    for (const day of [2, 1]) await seedRun(day, null, 'failed', streakFailure);

    const verdict = await indeterminateStreakService.check([reading]);

    expect(verdict).toMatchObject({ verdict: 'persistent', streaks: [{ consecutive: 3 }] });
  });

  it('a streak-failed run that does NOT list the probe means it answered there', async () => {
    await seedRun(3, stillIndeterminate);
    await seedRun(2, stillIndeterminate);
    await seedRun(1, null, 'failed', {
      message: 'health probe(s) could not tell',
      code: PROBE_INDETERMINATE_STREAK_CODE,
      data: { indeterminateProbes: ['fleet'] },
    });

    const verdict = await indeterminateStreakService.check([reading]);

    expect(verdict).toMatchObject({ verdict: 'ok', streaks: [{ consecutive: 1 }] });
  });

  it('ends a streak at a run from before the probe existed', async () => {
    await seedRun(2, { fleet: { verdict: 'bootable' } });
    await seedRun(1, stillIndeterminate);

    const verdict = await indeterminateStreakService.check([reading]);

    expect(verdict).toMatchObject({ verdict: 'ok', streaks: [{ consecutive: 2 }] });
  });

  it('reports since = the oldest run in the streak, and orders the longest streak first', async () => {
    await seedRun(2, { ...stillIndeterminate, fleet: { verdict: 'bootable' } });
    await seedRun(1, { ...stillIndeterminate, fleet: { verdict: 'indeterminate' } });
    const now = new Date();

    const verdict = await indeterminateStreakService.check(
      [
        { probe: 'fleet', step: 'fleet-boot-preflight', indeterminate: reading.indeterminate },
        reading,
        { probe: 'indexFleet', step: 'index-fleet-boot-preflight', indeterminate: null },
      ],
      now,
    );

    expect(verdict.verdict).toBe('persistent');
    expect(verdict.streaks.map((s) => [s.probe, s.consecutive])).toEqual([
      ['runnerImageFreshness', 3],
      ['fleet', 2],
    ]);
    const rows = await adminDb.jobRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(verdict.streaks[0]!.since).toBe(rows[0]!.startedAt.toISOString());
    expect(verdict.streaks[1]!.since).toBe(rows[1]!.startedAt.toISOString());
    if (verdict.verdict === 'persistent') {
      expect(verdict.offenders.map((o) => o.probe)).toEqual(['runnerImageFreshness']);
    }
  });
});

// ── THE GUARD: every probe with an `indeterminate` arm is covered ─────────────
//
// The streak is generic, but it can only read a probe the handler NAMES, so a
// probe added later and left out of `DAILY_HEALTH_CHECK_PROBES` would be exactly
// as quiet as every probe was before this card. The table is typed over every
// field of the result, which catches a new FIELD at compile time; these catch the
// rest — a new step, and an `indeterminate` arm the table describes as `null`.

const HANDLER = readFileSync(
  join(process.cwd(), 'lib/jobs/definitions/dailyHealthCheck.ts'),
  'utf8',
);
const handlerStepIds = [...HANDLER.matchAll(/ctx\.step\.run\(\s*'([^']+)'/g)].map((m) => m[1]!);

describe('every probe of the daily check is in the streak table', () => {
  it('finds the handler step ids — a scan that finds nothing passes vacuously', () => {
    expect(handlerStepIds.length).toBeGreaterThanOrEqual(11);
  });

  it("names every probe step the handler runs, and nothing it doesn't", () => {
    const tableSteps = Object.values(DAILY_HEALTH_CHECK_PROBES).map((p) => p.step);
    expect(
      [...tableSteps].sort(),
      'a probe step is missing from DAILY_HEALTH_CHECK_PROBES, so a streak of indeterminates ' +
        'from it would never fail the check (MOTIR-10429)',
    ).toEqual(handlerStepIds.filter((id) => id !== 'indeterminate-streak').sort());
  });

  it('describes every probe whose pinned result shape has an indeterminate arm', () => {
    for (const [probe, entry] of Object.entries(DAILY_HEALTH_CHECK_PROBES)) {
      const pin = LIVE_STEP_SHAPES[entry.step];
      expect(pin, `no step-shape pin for ${entry.step}`).toBeDefined();
      const hasArm = pin!.shape.includes('verdict: "indeterminate"');
      expect(
        entry.describeIndeterminate !== null,
        `${probe} (${entry.step}): ${hasArm ? 'has' : 'has no'} indeterminate arm`,
      ).toBe(hasArm);
    }
  });

  it('turns each indeterminate arm into a reading with its phase and detail', () => {
    const readings = indeterminateReadings({
      schedules: { checkedAt: '', entries: [], overdue: [] },
      fleet: { verdict: 'indeterminate', reference: 'ghcr.io/a', detail: 'timeout' },
      indexFleet: { verdict: 'indeterminate', reference: 'registry.fly.io/b', detail: '503' },
      hostedAgentImage: { verdict: 'bootable', reference: 'ghcr.io/c', digest: null },
      indexContainerAi: { verdict: 'indeterminate', address: 'https://ai', detail: 'ECONNRESET' },
      indexRebuildStreak: { verdict: 'not_applicable', detail: '', checkedAt: '', blindSpot: '' },
      monitorConfig: { verdict: 'not_applicable', detail: '', providers: [], blindSpot: '' },
      credentialExpiry: { verdict: 'ok', checkedAt: '', entries: [], skipped: [] },
      hostedRuns: {
        verdict: 'not_applicable',
        checkedAt: '',
        ownedOrgs: [],
        runsChecked: 0,
        windowStart: '',
      },
      fleetImageCoverage: {
        verdict: 'indeterminate',
        checkedAt: '',
        pairs: [
          {
            projectKey: 'MOTIR',
            org: 'motir-co',
            state: 'unknown',
            reasonCode: 'x',
            message: 'no read',
          },
          { projectKey: 'ACME', org: 'acme', state: 'met', reasonCode: 'y', message: 'fine' },
        ],
        targetsUnreadable: null,
      },
      runnerImageFreshness: indeterminateFreshness,
      runnerVersionSupport: {
        verdict: 'indeterminate',
        checkedAt: '',
        phase: 'releases',
        detail: "actions/runner's releases could not be read",
      },
    });

    expect(readings.map((r) => [r.probe, r.indeterminate])).toEqual([
      ['fleet', { phase: 'registry', detail: 'ghcr.io/a: timeout' }],
      ['indexFleet', { phase: 'registry', detail: 'registry.fly.io/b: 503' }],
      ['hostedAgentImage', null],
      ['indexContainerAi', { phase: 'address', detail: 'https://ai: ECONNRESET' }],
      ['fleetImageCoverage', { phase: 'pairs', detail: 'MOTIR on motir-co: no read' }],
      [
        'runnerImageFreshness',
        {
          phase: 'github',
          detail: `${RUNNER_IMAGE}: GitHub answered 403 (rate limit) listing commits`,
        },
      ],
      [
        'runnerVersionSupport',
        { phase: 'releases', detail: "actions/runner's releases could not be read" },
      ],
      ['runnerImageFreshness.ami', null],
    ]);
  });

  it('reads every nested judgement whose pinned shape has an indeterminate state', () => {
    // A step that judges two things — the runner image AND its AMI (MOTIR-10395)
    // — carries a second `indeterminate`, as a `state` inside the verdict. The
    // top-level table cannot see it, so it must be in the nested one.
    const nestedSteps = new Set(DAILY_HEALTH_CHECK_NESTED_PROBES.map((n) => n.step));
    for (const entry of Object.values(DAILY_HEALTH_CHECK_PROBES)) {
      const hasNested = LIVE_STEP_SHAPES[entry.step]!.shape.includes('state: "indeterminate"');
      expect(
        nestedSteps.has(entry.step),
        `${entry.step}: ${hasNested ? 'has' : 'has no'} nested indeterminate state`,
      ).toBe(hasNested);
    }
  });

  it('describes an indeterminate AMI read by its phase and the AMI', () => {
    const [ami] = DAILY_HEALTH_CHECK_NESTED_PROBES;
    expect(
      ami!.read({
        runnerImageFreshness: {
          ...indeterminateFreshness,
          verdict: 'current',
          build: { image: RUNNER_IMAGE, commit: 'abc', source: 'label' },
          ami: { state: 'indeterminate', amiId: 'ami-0123', phase: 'ec2', detail: 'AccessDenied' },
        },
      } as never),
    ).toEqual({ phase: 'ami ec2', detail: 'ami-0123: AccessDenied' });
  });

  it('describes an unreadable target list by the status GitHub gave', () => {
    const describe = DAILY_HEALTH_CHECK_PROBES.fleetImageCoverage.describeIndeterminate;
    const base = { verdict: 'indeterminate' as const, checkedAt: '', pairs: [] };
    expect(describe({ ...base, targetsUnreadable: { status: 502 } })).toEqual({
      phase: 'targets',
      detail: 'GitHub answered 502 listing the pairs',
    });
    expect(describe({ ...base, targetsUnreadable: { status: null } }).detail).toBe(
      'GitHub answered nothing listing the pairs',
    );
  });
});
