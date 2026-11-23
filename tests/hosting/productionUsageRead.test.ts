// MOTIR-12108 — a production application's usage this period, as the Production
// panel's Usage section reads it, over real Postgres (Decision MOTIR-12100):
// the calendar month in UTC, each day's credits rounded up once, Motir's cost
// recorded but never returned, and `credits_exhausted` as the meter's stored
// transition confirmed by a live balance read. Plus the slice table's tenancy:
// one workspace never reads another's slices.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { HostingManifest } from '@/lib/hosting/manifest';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { resetHostingFakes } from '@/lib/orchestrator/hosting';
import { productionUsageSliceRepository } from '@/lib/repositories/productionUsageSliceRepository';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import {
  EXHAUSTED_SUSPEND_AFTER_MS,
  productionCreditBalanceService,
} from '@/lib/services/productionCreditBalanceService';
import { productionUsageService as usage } from '@/lib/services/productionUsageService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { releaseDeploymentStatusService } from '@/lib/services/releaseDeploymentStatusService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const NOW = new Date('2026-11-23T15:00:00Z');
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'none' },
};

let balance: number | 'down';

beforeEach(async () => {
  await truncateAuthTables();
  balance = 100;
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  resetHostingFakes();
  resetDatabaseFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockResolvedValue();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      if (!String(u).includes('/v1/usage')) throw new Error(`unexpected fetch: ${u}`);
      if (balance === 'down') return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ balance }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
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

async function liveApp(identifier = 'ACME', target: HostingTarget = 'fly', shape?: 'container') {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'repo-web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource: 'initialised', state: 'created', hostingTarget: 'fly' },
  });
  await productionReleaseService.deployProductionRelease({
    projectRepositoryId: row.id,
    commitSha: 'a'.repeat(40),
    artifactRef: `registry.example/x:${'a'.repeat(40)}`,
    cause: 'merge',
  });
  const app = await adminDb.hostedApplication.findUniqueOrThrow({
    where: { projectRepositoryId: row.id },
    include: { workspace: true },
  });
  if (target !== 'fly') {
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { hostingTarget: target, hostingShape: shape ?? null },
    });
    await adminDb.hostedApplication.update({ where: { id: app.id }, data: { target } });
  }
  return { fx, rowId: row.id, app, organizationId: app.workspace.organizationId };
}

type Live = Awaited<ReturnType<typeof liveApp>>;

async function slice(
  live: Live,
  end: Date,
  credits: number,
  unit: 'fly_small_seconds' | 'neon_compute_hours' = 'fly_small_seconds',
  motirCostUsd = 0.01,
) {
  const day = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  await adminDb.productionUsageSlice.create({
    data: {
      workspaceId: live.app.workspaceId,
      organizationId: live.organizationId,
      applicationId: live.app.id,
      releaseId: live.app.currentReleaseId,
      unit,
      quantity: 3600,
      credits,
      motirCostUsd,
      periodStart: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)),
      chargeDay: day,
      sliceStart: new Date(end.getTime() - 3_600_000),
      sliceEnd: end,
      idempotencyKey: `${live.app.id}:${unit}:${end.toISOString()}`,
    },
  });
}

describe('this period’s usage', () => {
  it('answers the calendar month in UTC, per unit, and each day rounded up once', async () => {
    const live = await liveApp();
    await slice(live, new Date('2026-11-01T01:00:00Z'), 0.4);
    await slice(live, new Date('2026-11-01T02:00:00Z'), 0.4);
    await slice(live, new Date('2026-11-22T10:00:00Z'), 1.25, 'neon_compute_hours');
    // Last month's slice (ends exactly at the period's start) is not this period's.
    await slice(live, new Date('2026-11-01T00:00:00Z'), 50);

    const read = await usage.getCurrentPeriod(live.app.id, { now: NOW });

    expect(read).toEqual({
      period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
      usage: [
        { unit: 'fly_small_seconds', quantity: 7200, credits: 0.8 },
        { unit: 'neon_compute_hours', quantity: 3600, credits: 1.25 },
      ],
      credits: 1 + 2,
      motirCostRecorded: true,
      state: 'ok',
      exhausted: null,
    });
    expect(JSON.stringify(read)).not.toMatch(/motirCostUsd|0\.01\b/);
  });

  it('counts today’s open day in the rows but not yet in the credits charged', async () => {
    const live = await liveApp();
    await slice(live, new Date('2026-11-22T10:00:00Z'), 0.5);
    await slice(live, new Date('2026-11-23T10:00:00Z'), 0.5);

    const read = await usage.getCurrentPeriod(live.app.id, { now: NOW });

    expect(read.usage).toEqual([{ unit: 'fly_small_seconds', quantity: 7200, credits: 1 }]);
    expect(read.credits).toBe(1);
  });

  it('answers the empty period for an unknown application', async () => {
    expect(await usage.getCurrentPeriod('missing', { now: NOW })).toMatchObject({
      usage: [],
      credits: 0,
      motirCostRecorded: false,
      state: 'no_release',
    });
  });

  it('answers no_release for an application whose release is gone', async () => {
    const live = await liveApp();
    await adminDb.hostedApplication.update({
      where: { id: live.app.id },
      data: { currentReleaseId: null },
    });

    expect((await usage.getCurrentPeriod(live.app.id, { now: NOW })).state).toBe('no_release');
  });
});

describe('credits exhausted', () => {
  const since = new Date('2026-11-20T08:00:00Z');

  async function below(target: HostingTarget = 'fly', shape?: 'container') {
    const live = await liveApp('ACME', target, shape);
    await adminDb.hostedApplication.update({
      where: { id: live.app.id },
      data: { creditsExhaustedSince: since, idleMode: 'always_on', idleSeconds: null },
    });
    return live;
  }

  it('says since when, the balance, and when an always-on app that can suspend is switched', async () => {
    const live = await below();
    balance = -30;

    expect(await usage.getCurrentPeriod(live.app.id, { now: NOW })).toMatchObject({
      state: 'credits_exhausted',
      exhausted: {
        since: since.toISOString(),
        balance: -30,
        canSuspend: true,
        suspendsAt: new Date(since.getTime() + EXHAUSTED_SUSPEND_AFTER_MS).toISOString(),
      },
    });
  });

  it('names no switch for an AWS container, which keeps running always on', async () => {
    const live = await below('aws', 'container');
    balance = -30;

    expect((await usage.getCurrentPeriod(live.app.id, { now: NOW })).exhausted).toMatchObject({
      canSuspend: false,
      suspendsAt: null,
    });
  });

  it('reads a top-up at once, before the meter’s next pass', async () => {
    const live = await below();
    balance = 20;

    expect(await usage.getCurrentPeriod(live.app.id, { now: NOW })).toMatchObject({
      state: 'ok',
      exhausted: null,
    });
  });

  it('keeps the stored state when the balance cannot be read, and never reads an outage as exhaustion', async () => {
    const live = await below();
    balance = 'down';

    expect((await usage.getCurrentPeriod(live.app.id, { now: NOW })).exhausted).toMatchObject({
      balance: null,
    });

    await adminDb.hostedApplication.update({
      where: { id: live.app.id },
      data: { creditsExhaustedSince: null },
    });
    expect((await usage.getCurrentPeriod(live.app.id, { now: NOW })).state).toBe('ok');
    expect(await productionCreditBalanceService.isBelowZero(live.organizationId, null)).toEqual({
      below: false,
      balance: null,
    });
  });
});

describe('the slice table’s tenancy', () => {
  it('shows one workspace none of another’s slices', async () => {
    const a = await liveApp('ACME');
    const b = await liveApp('BETA');
    await slice(a, new Date('2026-11-22T10:00:00Z'), 3);
    const window = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };

    const own = await withWorkspaceServiceContext(a.app.workspaceId, (tx) =>
      productionUsageSliceRepository.sumByUnit(a.app.id, window, tx),
    );
    const foreign = await withWorkspaceServiceContext(b.app.workspaceId, async (tx) => ({
      sums: await productionUsageSliceRepository.sumByUnit(a.app.id, window, tx),
      rows: await tx.productionUsageSlice.count(),
    }));

    expect(own).toHaveLength(1);
    expect(foreign).toEqual({ sums: [], rows: 0 });
  });

  it('refuses a slice written under another workspace', async () => {
    const a = await liveApp('ACME');
    const b = await liveApp('BETA');

    await expect(
      withWorkspaceServiceContext(b.app.workspaceId, (tx) =>
        productionUsageSliceRepository.insertSlices(
          [
            {
              workspaceId: a.app.workspaceId,
              organizationId: a.organizationId,
              applicationId: a.app.id,
              releaseId: null,
              unit: 'fly_small_seconds',
              quantity: 1,
              credits: 1,
              motirCostUsd: 0,
              periodStart: new Date('2026-11-01T00:00:00Z'),
              chargeDay: new Date('2026-11-22T00:00:00Z'),
              sliceStart: new Date('2026-11-22T09:00:00Z'),
              sliceEnd: new Date('2026-11-22T10:00:00Z'),
              idempotencyKey: 'x',
            },
          ],
          tx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
