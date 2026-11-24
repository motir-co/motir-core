// MOTIR-12108 — the production usage meter over real Postgres (Decision
// MOTIR-12100). The deploy and database ports are the orchestrator's fakes, with
// `usageSince` answering the windows each case sets; motir-ai is `fetch`: its
// balance read and its `hosting_production` debit, recorded. What is pinned: one
// slice per unit per window, priced at the derived factor with Motir's cost
// beside it; a window counted once; one whole-credit charge per application per
// ended UTC day, asked again with the same day after a transport failure; the
// stop rules; the below-zero transition and the 7-day switch to suspend; the
// outgoing release's final slice; and the hourly job.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DatabaseUsage,
  FakeHostingControls,
  HostingDeployPort,
  ReleaseUsage,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { productionUsageAccrual } from '@/lib/jobs/definitions/productionUsageAccrual';
import { HOSTED_IDLE_SECONDS_DEFAULT } from '@/lib/hosting/idlePolicy';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { linuxMinutesPerUnit, PRODUCTION_USAGE_RATES } from '@/lib/hosting/productionRates';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { getAwsDatabaseUsageReader } from '@/lib/orchestrator/awsHosting';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedIdlePolicyService } from '@/lib/services/hostedIdlePolicyService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionUsageSliceRepository } from '@/lib/repositories/productionUsageSliceRepository';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { productionUsageMeterService as meter } from '@/lib/services/productionUsageMeterService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { releaseDeploymentStatusService } from '@/lib/services/releaseDeploymentStatusService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * How far back to move a window that ends an hour after `liveAt` (≈ now) so
 * its charge day has ENDED, whatever the time of day. A bare `DAY` lands it on
 * today during the last UTC hour, where `chargeEndedDays` rightly skips it.
 */
const ENDED_DAY_SHIFT = DAY + 2 * HOUR;
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly', 'serverless'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'none' },
};

interface DebitBody {
  coreOrganizationId: string;
  applicationId: string;
  day: string;
  credits: number;
  linuxEquivalentMinutes: number;
}

let debits: DebitBody[];
let balance: number;
/** What the next debit answers instead of 200: a status and its problem. */
let debitFailures: Array<{ status: number; code: string }>;
let usageReadFails: boolean;

function stubMotirAi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': status === 200 ? 'application/json' : 'application/problem+json',
          },
        });
      if (u.includes('/v1/usage')) {
        if (usageReadFails) return json({ type: 'about:blank', title: 'down', status: 503 }, 503);
        return json({ balance });
      }
      if (u.includes('/v1/credits/hosting-production')) {
        const failure = debitFailures.shift();
        if (failure) {
          return json(
            {
              type: 'about:blank',
              title: failure.code,
              status: failure.status,
              code: failure.code,
            },
            failure.status,
          );
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as DebitBody;
        debits.push(body);
        balance -= body.credits;
        return json({
          transactionId: `tx_${debits.length}`,
          aiOrganizationId: 'ai_org',
          credits: -body.credits,
          balanceAfter: balance,
          exhausted: balance <= 0,
          idempotent: false,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const port = (target: HostingTarget = 'fly') =>
  getHostingDeployPort(target) as HostingDeployPort & FakeHostingControls;

beforeEach(async () => {
  await truncateAuthTables();
  debits = [];
  balance = 10_000;
  debitFailures = [];
  usageReadFails = false;
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', 'cd'.repeat(32));
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  resetHostingFakes();
  resetDatabaseFakes();
  stubMotirAi();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockResolvedValue();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Live {
  fx: WorkItemFixture;
  rowId: string;
  appId: string;
  releaseId: string;
  liveAt: Date;
  organizationId: string;
}

/** A Motir repository on `target` with its first production release live. */
async function liveApp(
  opts: { target?: HostingTarget; identifier?: string; size?: 'small' | 'medium' } = {},
): Promise<Live> {
  const fx = await makeWorkItemFixture({
    name: opts.identifier ?? 'Acme',
    identifier: opts.identifier ?? 'ACME',
  });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'repo-web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      seedSource: 'initialised',
      state: 'created',
      hostingTarget: opts.target ?? 'fly',
      hostingSize: opts.size ?? null,
    },
  });
  await productionReleaseService.deployProductionRelease({
    projectRepositoryId: row.id,
    commitSha: SHA_A,
    artifactRef: `registry.example/mh-${row.id}:${SHA_A}`,
    cause: 'merge',
  });
  const app = await adminDb.hostedApplication.findUniqueOrThrow({
    where: { projectRepositoryId: row.id },
    include: { currentRelease: true, workspace: true },
  });
  expect(app.currentRelease?.state).toBe('live');
  return {
    fx,
    rowId: row.id,
    appId: app.id,
    releaseId: app.currentRelease!.id,
    liveAt: app.currentRelease!.liveAt!,
    organizationId: app.workspace.organizationId,
  };
}

/** `usageSince` answers `seconds` of running time up to `until` for every window. */
function releaseUsage(
  until: Date,
  seconds = 3600,
  target: HostingTarget = 'fly',
  extra: Partial<ReleaseUsage> = {},
) {
  return vi.spyOn(port(target), 'usageSince').mockImplementation(async (handle, since) => ({
    target: handle.target,
    appRef: handle.appRef,
    releaseId: handle.releaseId,
    since,
    until,
    runningSeconds: seconds,
    ...extra,
  }));
}

const slices = (applicationId?: string) =>
  adminDb.productionUsageSlice.findMany({
    where: applicationId ? { applicationId } : {},
    orderBy: [{ sliceEnd: 'asc' }, { unit: 'asc' }],
  });

/** Move every slice of the application back by `ms` — a window that ended earlier. */
async function shiftSlices(applicationId: string, ms: number): Promise<void> {
  await adminDb.$executeRaw`
    UPDATE "production_usage_slice"
       SET "slice_start" = "slice_start" - (${ms} * INTERVAL '1 millisecond'),
           "slice_end" = "slice_end" - (${ms} * INTERVAL '1 millisecond'),
           "charge_day" = date_trunc('day', ("slice_end" - (${ms} * INTERVAL '1 millisecond')) - INTERVAL '1 millisecond')
     WHERE "application_id" = ${applicationId}`;
}

describe('slicing a live release', () => {
  it('writes one slice per unit for the window since the release went live, priced and costed', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);

    const result = await meter.accrue({ now: () => until });

    expect(result).toMatchObject({ applications: 1, slices: 1, failed: 0, skipped: 0 });
    const [slice] = await slices(live.appId);
    expect(slice).toMatchObject({
      applicationId: live.appId,
      releaseId: live.releaseId,
      workspaceId: live.fx.workspaceId,
      organizationId: live.organizationId,
      unit: 'fly_small_seconds',
      sliceStart: live.liveAt,
      sliceEnd: until,
      chargeState: 'pending',
      idempotencyKey: `${live.appId}:fly_small_seconds:${until.toISOString()}`,
    });
    expect(slice!.quantity.toNumber()).toBeCloseTo(3600, 6);
    expect(slice!.credits.toNumber()).toBeCloseTo(
      3600 * linuxMinutesPerUnit('fly_small_seconds'),
      6,
    );
    expect(slice!.motirCostUsd.toNumber()).toBeCloseTo(
      3600 * PRODUCTION_USAGE_RATES.fly_small_seconds.usdPerUnit,
      9,
    );
  });

  it('prices a medium Fly release at its size', async () => {
    const live = await liveApp({ size: 'medium' });
    releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    await meter.accrue();

    expect((await slices(live.appId)).map((s) => s.unit)).toEqual(['fly_medium_seconds']);
  });

  it('counts a window once: the next pass reads from the last slice’s end', async () => {
    const live = await liveApp();
    const first = new Date(live.liveAt.getTime() + HOUR);
    const usageSince = releaseUsage(first);
    await meter.accrue({ now: () => first });

    // The port has nothing newer: no second slice.
    await meter.accrue({ now: () => first });
    expect(await slices(live.appId)).toHaveLength(1);

    const second = new Date(first.getTime() + HOUR);
    releaseUsage(second);
    await meter.accrue({ now: () => second });

    const all = await slices(live.appId);
    expect(all.map((s) => [s.sliceStart, s.sliceEnd])).toEqual([
      [live.liveAt, first],
      [first, second],
    ]);
    expect(usageSince.mock.calls.at(-1)?.[1]).toEqual(first);
  });

  it('writes nothing for a window whose usage is only a residue', async () => {
    const live = await liveApp();
    releaseUsage(new Date(live.liveAt.getTime() + HOUR), 0);

    expect((await meter.accrue()).slices).toBe(0);
    expect(await slices(live.appId)).toEqual([]);
  });

  it('slices the production database’s compute and storage on Neon', async () => {
    const live = await liveApp();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: { databaseProjectId: 'neon-shop' },
    });
    const until = new Date(live.liveAt.getTime() + 2 * HOUR);
    releaseUsage(until);
    const database = getDatabasePort();
    const dbUsage = vi.spyOn(database, 'usageSince').mockImplementation(
      async (handle, since): Promise<DatabaseUsage> => ({
        provider: handle.provider,
        applicationRef: handle.applicationRef,
        since,
        until,
        computeSeconds: 1800,
        storageBytes: 2 ** 30,
      }),
    );

    await meter.accrue({ now: () => until });

    expect(dbUsage).toHaveBeenCalledWith(
      expect.objectContaining({ applicationRef: live.rowId, databaseRef: 'neon-shop' }),
      live.liveAt,
    );
    const byUnit = Object.fromEntries(
      (await slices(live.appId)).map((s) => [s.unit, s.quantity.toNumber()]),
    );
    expect(byUnit).toEqual({
      fly_small_seconds: 3600,
      neon_compute_hours: 0.5,
      neon_storage_gb_hours: 2,
    });
  });

  it('bills Motir’s serverless account in GB-seconds and requests', async () => {
    const live = await liveApp({ target: 'serverless' });
    releaseUsage(new Date(live.liveAt.getTime() + HOUR), 100, 'serverless', { invocations: 500 });

    await meter.accrue();

    expect((await slices(live.appId)).map((s) => s.unit)).toEqual([
      'lambda_gb_seconds',
      'lambda_requests',
    ]);
  });
});

describe('the stop rules', () => {
  it('never meters a customer repository', async () => {
    const live = await liveApp();
    await adminDb.projectRepo.update({
      where: { id: live.rowId },
      data: { seedSource: 'organization' },
    });
    const usageSince = releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    expect(await meter.accrue()).toMatchObject({ applications: 1, skipped: 1, slices: 0 });
    expect(usageSince).not.toHaveBeenCalled();
  });

  it('slices nothing for an application with no live release, but still charges its ended days', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    await shiftSlices(live.appId, 2 * DAY);
    await adminDb.hostedRelease.update({
      where: { id: live.releaseId },
      data: { state: 'replaced' },
    });
    const usageSince = releaseUsage(new Date(until.getTime() + HOUR));
    usageSince.mockClear();

    const result = await meter.accrue({ now: () => until });

    expect(usageSince).not.toHaveBeenCalled();
    expect(result).toMatchObject({ slices: 0, charged: 1 });
    expect(debits).toHaveLength(1);
  });

  it('gives an AWS application whose organisation’s tenant account is not ready no new slice', async () => {
    const live = await liveApp();
    await adminDb.hostedApplication.update({ where: { id: live.appId }, data: { target: 'aws' } });
    const usageSince = vi.spyOn(port('aws'), 'usageSince');
    const auroraUsage = vi.spyOn(getAwsDatabaseUsageReader(), 'usageSince');

    expect((await meter.accrue()).slices).toBe(0);
    expect(usageSince).not.toHaveBeenCalled();
    expect(auroraUsage).not.toHaveBeenCalled();
  });

  /** An AWS application whose organisation's tenant account is ready, and an
   *  Aurora read answering `computeSeconds` ACU-seconds and `storageBytes` up
   *  to `until` for every window (MOTIR-12191). */
  async function awsAppWithAurora(computeSeconds: number, storageBytes: number, until: Date) {
    const live = await liveApp();
    await adminDb.hostedApplication.update({ where: { id: live.appId }, data: { target: 'aws' } });
    await adminDb.hostingTenantAccount.create({
      data: {
        organizationId: live.organizationId,
        awsAccountId: '210987654321',
        state: 'ready',
        region: 'us-east-1',
      },
    });
    // The release's own units are pinned elsewhere; here it reports none.
    vi.spyOn(port('aws'), 'usageSince').mockImplementation(async (handle, since) => ({
      target: handle.target,
      appRef: handle.appRef,
      releaseId: handle.releaseId,
      since,
      until: since,
      runningSeconds: 0,
    }));
    const aurora = vi
      .spyOn(getAwsDatabaseUsageReader(), 'usageSince')
      .mockImplementation(async ({ repositoryId }, since) => ({
        provider: 'aws',
        applicationRef: repositoryId,
        since,
        until,
        computeSeconds,
        storageBytes,
      }));
    return { live, aurora };
  }

  it('slices an AWS application’s Aurora compute and storage at the decision’s factors', async () => {
    const liveAt = new Date();
    const until = new Date(liveAt.getTime() + HOUR);
    // 2 ACU for the hour, and 3 GiB stored.
    const { live, aurora } = await awsAppWithAurora(2 * 3600, 3 * 2 ** 30, until);

    const result = await meter.accrue({ now: () => until });

    expect(result).toMatchObject({ slices: 2, failed: 0 });
    expect(aurora).toHaveBeenCalledWith({ repositoryId: live.rowId }, live.liveAt);
    const written = await slices(live.appId);
    expect(written.map((s) => s.unit)).toEqual(['aurora_compute_hours', 'aurora_storage_gb_hours']);
    const [compute, storage] = written;
    expect(compute).toMatchObject({
      sliceStart: live.liveAt,
      sliceEnd: until,
      releaseId: live.releaseId,
    });
    expect(compute!.quantity.toNumber()).toBeCloseTo(2, 9);
    expect(compute!.credits.toNumber()).toBeCloseTo(
      2 * linuxMinutesPerUnit('aurora_compute_hours'),
      6,
    );
    expect(compute!.motirCostUsd.toNumber()).toBeCloseTo(
      2 * PRODUCTION_USAGE_RATES.aurora_compute_hours.usdPerUnit,
      9,
    );
    const storedHours = (until.getTime() - live.liveAt.getTime()) / HOUR;
    expect(storage!.quantity.toNumber()).toBeCloseTo(3 * storedHours, 6);
    expect(storage!.credits.toNumber()).toBeCloseTo(
      3 * storedHours * linuxMinutesPerUnit('aurora_storage_gb_hours'),
      6,
    );
  });

  it('writes no Aurora slice for a replayed window, and reads on from the last one', async () => {
    const liveAt = new Date();
    const until = new Date(liveAt.getTime() + HOUR);
    const { live, aurora } = await awsAppWithAurora(3600, 2 ** 30, until);
    await meter.accrue({ now: () => until });

    // The read has nothing newer than the window already sliced.
    expect((await meter.accrue({ now: () => until })).slices).toBe(0);

    expect(await slices(live.appId)).toHaveLength(2);
    expect(aurora.mock.calls.at(-1)?.[1]).toEqual(until);
  });

  it('writes no Aurora slice while the cluster has nothing to report', async () => {
    const live = await liveApp();
    await adminDb.hostedApplication.update({ where: { id: live.appId }, data: { target: 'aws' } });
    await adminDb.hostingTenantAccount.create({
      data: {
        organizationId: live.organizationId,
        awsAccountId: '210987654321',
        state: 'ready',
        region: 'us-east-1',
      },
    });

    // The fake reader measures nothing: its window ends where it starts.
    expect((await meter.accrue()).slices).toBe(0);
    expect(await slices(live.appId)).toEqual([]);
  });

  it('counts one application’s failure and moves on', async () => {
    const live = await liveApp();
    vi.spyOn(port(), 'usageSince').mockRejectedValue(new Error('fly down'));

    expect(await meter.accrue()).toMatchObject({ applications: 1, failed: 1, slices: 0 });
    expect(await slices(live.appId)).toEqual([]);
  });
});

describe('the daily charge', () => {
  async function slicedYesterday(): Promise<Live> {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until, 3600);
    await meter.accrue({ now: () => until });
    await shiftSlices(live.appId, ENDED_DAY_SHIFT);
    return live;
  }

  it('charges an ended day once, its credits summed and rounded up, keyed by application and day', async () => {
    const live = await slicedYesterday();
    const [slice] = await slices(live.appId);
    const now = new Date();

    const charged = await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      now,
    );

    expect(charged).toBe(1);
    expect(debits).toEqual([
      {
        coreOrganizationId: live.organizationId,
        applicationId: live.appId,
        day: slice!.chargeDay.toISOString().slice(0, 10),
        credits: Math.ceil(slice!.credits.toNumber()),
        linuxEquivalentMinutes: expect.closeTo(slice!.credits.toNumber(), 6),
        reason: 'production hosting',
      },
    ]);
    expect((await slices(live.appId)).map((s) => s.chargeState)).toEqual(['charged']);

    // A second pass finds nothing open.
    await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      now,
    );
    expect(debits).toHaveLength(1);
  });

  // MOTIR-12172 — the cases above read the real clock, so the last UTC hour
  // (where a window ending an hour ahead is tomorrow) and the first one (where
  // a day back is barely yesterday) were only ever exercised by whoever ran the
  // suite then. Pin the clock to each edge and charge the fixture's day there.
  it.each([
    ['in the last UTC hour', '2026-11-23T23:30:00.000Z'],
    ['in the first UTC hour', '2026-11-24T00:30:00.000Z'],
  ])('charges the fixture’s ended day when the pass runs %s', async (_edge, at) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    const live = await slicedYesterday();
    const now = new Date();

    const charged = await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      now,
    );

    const [slice] = await slices(live.appId);
    expect(slice!.chargeDay.getTime()).toBeLessThan(Date.parse(at.slice(0, 10)));
    expect(charged).toBe(1);
    expect(slice!.chargeState).toBe('charged');
    expect(debits).toHaveLength(1);
  });

  it('leaves today open until it has ended', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);

    const result = await meter.accrue({ now: () => until });

    expect(result.charged).toBe(0);
    expect(debits).toEqual([]);
  });

  it('keeps a day closed and owed after a transport failure, and asks again with the same day', async () => {
    const live = await slicedYesterday();
    const target = {
      id: live.appId,
      workspaceId: live.fx.workspaceId,
      organizationId: live.organizationId,
    };
    debitFailures.push({ status: 503, code: 'UNAVAILABLE' });

    expect(await meter.chargeEndedDays(target, new Date())).toBe(0);
    const owed = await slices(live.appId);
    expect(owed.map((s) => [s.chargeState, s.chargeAttempts])).toEqual([['charging', 1]]);

    // No new slice joins the closed day.
    expect(await meter.chargeEndedDays(target, new Date())).toBe(1);
    expect(debits).toHaveLength(1);
    expect((await slices(live.appId)).map((s) => [s.chargeState, s.chargeAttempts])).toEqual([
      ['charged', 2],
    ]);
  });

  it('treats a motir-ai that does not serve the route yet as owed, not refused', async () => {
    const live = await slicedYesterday();
    debitFailures.push({ status: 404, code: 'NOT_FOUND' });

    await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      new Date(),
    );

    expect((await slices(live.appId))[0]!.chargeState).toBe('charging');
  });

  it('records a refusal and does not ask again', async () => {
    const live = await slicedYesterday();
    debitFailures.push({ status: 400, code: 'VALIDATION_FAILED' });
    const target = {
      id: live.appId,
      workspaceId: live.fx.workspaceId,
      organizationId: live.organizationId,
    };

    await meter.chargeEndedDays(target, new Date());
    await meter.chargeEndedDays(target, new Date());

    const [slice] = await slices(live.appId);
    expect(slice).toMatchObject({ chargeState: 'refused', chargeAttempts: 1 });
    expect(slice!.chargeDetail).toMatch(/MotirAi/);
    expect(debits).toEqual([]);
  });

  it('marks the day not charged when motir-ai is not configured', async () => {
    const live = await slicedYesterday();
    vi.stubEnv('MOTIR_AI_URL', '');

    await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      new Date(),
    );

    expect((await slices(live.appId))[0]).toMatchObject({
      chargeState: 'not_charged',
      chargeDetail: 'motir-ai is not configured',
    });
  });

  it('closes a day whose slices round to nothing without a debit', async () => {
    const live = await slicedYesterday();
    await adminDb.productionUsageSlice.updateMany({
      where: { applicationId: live.appId },
      data: { credits: 0 },
    });

    await meter.chargeEndedDays(
      { id: live.appId, workspaceId: live.fx.workspaceId, organizationId: live.organizationId },
      new Date(),
    );

    expect(debits).toEqual([]);
    expect((await slices(live.appId))[0]).toMatchObject({
      chargeState: 'charged',
      chargeDetail: 'nothing to charge',
    });
  });

  it('writes no slice into a day already being charged', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    await adminDb.productionUsageSlice.updateMany({
      where: { applicationId: live.appId },
      data: { chargeState: 'charging' },
    });
    releaseUsage(new Date(until.getTime() + 60_000));

    await meter.accrue({ now: () => until });

    expect(await slices(live.appId)).toHaveLength(1);
  });
});

describe('out of credits (§9)', () => {
  it('records the transition below zero on the organisation’s applications, and clears it on a top-up', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    await shiftSlices(live.appId, DAY);
    balance = 1;

    await meter.accrue({ now: () => until });

    const exhausted = await adminDb.hostedApplication.findUniqueOrThrow({
      where: { id: live.appId },
    });
    expect(exhausted.creditsExhaustedSince).toEqual(until);

    // A later pass below zero keeps the first date.
    await meter.accrue({ now: () => new Date(until.getTime() + HOUR) });
    expect(
      (await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: live.appId } }))
        .creditsExhaustedSince,
    ).toEqual(until);

    balance = 500;
    await meter.accrue({ now: () => new Date(until.getTime() + 2 * HOUR) });
    expect(
      (await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: live.appId } }))
        .creditsExhaustedSince,
    ).toBeNull();
  });

  it('keeps the stored state when the balance cannot be read', async () => {
    const live = await liveApp();
    const since = new Date(live.liveAt.getTime() - DAY);
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: { creditsExhaustedSince: since },
    });
    releaseUsage(live.liveAt);
    usageReadFails = true;

    await meter.accrue();

    expect(
      (await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: live.appId } }))
        .creditsExhaustedSince,
    ).toEqual(since);
  });

  it('switches an always-on application to suspend when idle after 7 days below zero', async () => {
    const live = await liveApp();
    const now = new Date();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: {
        idleMode: 'always_on',
        idleSeconds: null,
        creditsExhaustedSince: new Date(now.getTime() - 7 * DAY - HOUR),
      },
    });
    releaseUsage(live.liveAt);
    balance = -40;
    const apply = vi.spyOn(hostedIdlePolicyService, 'applyIdlePolicyAsSystem');

    const result = await meter.accrue({ now: () => now });

    expect(apply).toHaveBeenCalledWith(live.rowId, {
      mode: 'suspend',
      idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT,
    });
    expect(result.suspended).toBe(1);
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: live.appId } }),
    ).toMatchObject({ idleMode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT });
  });

  it('does not switch before 7 days, nor an AWS container, which cannot suspend', async () => {
    const live = await liveApp();
    const now = new Date();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: {
        idleMode: 'always_on',
        idleSeconds: null,
        creditsExhaustedSince: new Date(now.getTime() - 6 * DAY),
      },
    });
    releaseUsage(live.liveAt);
    balance = -40;
    const apply = vi.spyOn(hostedIdlePolicyService, 'applyIdlePolicyAsSystem');

    expect((await meter.accrue({ now: () => now })).suspended).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('logs a switch that fails and goes on', async () => {
    const live = await liveApp();
    const now = new Date();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: {
        idleMode: 'always_on',
        idleSeconds: null,
        creditsExhaustedSince: new Date(now.getTime() - 8 * DAY),
      },
    });
    releaseUsage(live.liveAt);
    balance = -40;
    vi.spyOn(hostedIdlePolicyService, 'applyIdlePolicyAsSystem').mockRejectedValue(
      new Error('port'),
    );

    expect(await meter.accrue({ now: () => now })).toMatchObject({ suspended: 0, failed: 0 });
  });
});

describe('the outgoing release’s final slice', () => {
  it('slices the serving release’s window before a replacing deploy', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);

    await productionReleaseService.deployProductionRelease({
      projectRepositoryId: live.rowId,
      commitSha: SHA_B,
      artifactRef: `registry.example/mh-${live.rowId}:${SHA_B}`,
      cause: 'merge',
    });

    expect((await slices(live.appId)).map((s) => s.releaseId)).toEqual([live.releaseId]);
  });

  it('charges every open day, today’s included, when asked to charge now', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);

    const answer = await meter.accrueOutgoingRelease(live.releaseId, {
      chargeNow: true,
      now: () => until,
    });

    expect(answer).toEqual({ outcome: 'accrued', slices: 1 });
    expect(debits).toHaveLength(1);
    expect((await slices(live.appId))[0]!.chargeState).toBe('charged');
  });

  it('skips a release that is not the one serving, and an unknown one', async () => {
    const live = await liveApp();
    releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    expect(await meter.accrueOutgoingRelease('no-such-release')).toEqual({
      outcome: 'skipped',
      slices: 0,
    });
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: { currentReleaseId: null },
    });
    expect(await meter.accrueOutgoingRelease(live.releaseId)).toEqual({
      outcome: 'skipped',
      slices: 0,
    });
  });

  it('never throws: a port that cannot answer is logged and the release goes on', async () => {
    const live = await liveApp();
    vi.spyOn(port(), 'usageSince').mockRejectedValue(new Error('fly down'));

    expect(await meter.accrueOutgoingRelease(live.releaseId)).toEqual({
      outcome: 'failed',
      slices: 0,
    });
  });
});

describe('the hourly job', () => {
  it('runs the pass and returns its counts', async () => {
    const live = await liveApp();
    releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    const outcome = await new JobTestEngine({ function: productionUsageAccrual }).execute();

    expect(outcome.result).toEqual({
      applications: 1,
      slices: 1,
      charged: 0,
      skipped: 0,
      failed: 0,
      suspended: 0,
    });
  });
});

describe('the meter’s edges', () => {
  const target = (live: Live) => ({
    id: live.appId,
    workspaceId: live.fx.workspaceId,
    organizationId: live.organizationId,
  });

  it('slices nothing for a release the port was never given ids for', async () => {
    const live = await liveApp();
    await adminDb.hostedRelease.update({
      where: { id: live.releaseId },
      data: { providerReleaseId: null },
    });
    const usageSince = releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    expect((await meter.accrue()).slices).toBe(0);
    expect(usageSince).not.toHaveBeenCalled();
  });

  it('writes no database slice for an empty or zero database window', async () => {
    const live = await liveApp();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: { databaseProjectId: 'neon-shop' },
    });
    releaseUsage(new Date(live.liveAt.getTime() + HOUR), 0);
    const database = vi.spyOn(getDatabasePort(), 'usageSince');
    database.mockImplementationOnce(async (handle, since) => ({
      provider: handle.provider,
      applicationRef: handle.applicationRef,
      since,
      until: since,
      computeSeconds: 10,
      storageBytes: 10,
    }));
    await meter.accrue();
    database.mockImplementationOnce(async (handle, since) => ({
      provider: handle.provider,
      applicationRef: handle.applicationRef,
      since,
      until: new Date(since.getTime() + HOUR),
      computeSeconds: 0,
      storageBytes: 0,
    }));
    await meter.accrue();

    expect(database).toHaveBeenCalledTimes(2);
    expect(await slices(live.appId)).toEqual([]);
  });

  it('measures a raced window again from where the other writer left it', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    const real = productionUsageSliceRepository.lastSliceEnd.bind(productionUsageSliceRepository);
    // Under the lock, the watermark has moved since it was read: another writer.
    vi.spyOn(productionUsageSliceRepository, 'lastSliceEnd')
      .mockImplementationOnce(real)
      .mockImplementationOnce(async () => new Date(live.liveAt.getTime() + 60_000));

    expect(await meter.accrueOutgoingRelease(live.releaseId, { now: () => until })).toEqual({
      outcome: 'accrued',
      slices: 1,
    });
  });

  it('charges a removed repository’s days at the time of the call when no clock is given', async () => {
    const live = await liveApp();
    // The window ends NOW, not an hour ahead: an hour ahead is tomorrow during
    // the last UTC hour, and a charge "at the time of the call" covers today.
    releaseUsage(new Date(Math.max(Date.now(), live.liveAt.getTime() + 1)));

    await meter.accrueOutgoingRelease(live.releaseId, { chargeNow: true });

    expect(debits).toHaveLength(1);
  });

  it('neither slices nor charges a customer repository’s outgoing release', async () => {
    const live = await liveApp();
    await adminDb.projectRepo.update({
      where: { id: live.rowId },
      data: { seedSource: 'organization' },
    });
    const usageSince = releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    expect(
      await meter.accrueOutgoingRelease(live.releaseId, { chargeNow: true, now: () => new Date() }),
    ).toEqual({ outcome: 'skipped', slices: 0 });
    expect(usageSince).not.toHaveBeenCalled();
    expect(debits).toEqual([]);
  });

  it('logs a failure that is not an Error by its kind alone', async () => {
    const live = await liveApp();
    vi.spyOn(port(), 'usageSince').mockRejectedValue('a string, not an Error');

    expect(await meter.accrue()).toMatchObject({ failed: 1 });
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), {
      applicationId: live.appId,
      error: 'UNKNOWN',
    });
  });

  it('keeps a day owed when motir-ai cannot be reached at all, or answers a job it cannot find', async () => {
    const live = await liveApp();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    await shiftSlices(live.appId, ENDED_DAY_SHIFT);
    debitFailures.push({ status: 404, code: 'not_found' });

    await meter.chargeEndedDays(target(live), new Date());
    expect((await slices(live.appId))[0]!.chargeState).toBe('charging');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await meter.chargeEndedDays(target(live), new Date());
    expect((await slices(live.appId))[0]).toMatchObject({
      chargeState: 'charging',
      chargeAttempts: 2,
    });
  });

  it('counts no switch when the idle-policy path changed nothing', async () => {
    const live = await liveApp();
    const now = new Date();
    await adminDb.hostedApplication.update({
      where: { id: live.appId },
      data: {
        idleMode: 'always_on',
        idleSeconds: null,
        creditsExhaustedSince: new Date(now.getTime() - 8 * DAY),
      },
    });
    releaseUsage(live.liveAt);
    balance = -40;
    vi.spyOn(hostedIdlePolicyService, 'applyIdlePolicyAsSystem').mockResolvedValue('stored');

    expect((await meter.accrue({ now: () => now })).suspended).toBe(0);
  });

  it('inserts nothing for no slices', async () => {
    const live = await liveApp();
    expect(
      await adminDb.$transaction((tx) => productionUsageSliceRepository.insertSlices([], tx)),
    ).toBe(0);
    expect(await slices(live.appId)).toEqual([]);
  });
});
