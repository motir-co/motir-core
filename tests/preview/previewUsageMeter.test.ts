import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FakeDatabaseControls,
  FakeHostingControls,
  HostingDeployPort,
  HostingDeployTarget,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { PREVIEW_USAGE_RATES, priceSlice } from '@/lib/ciMetering/previewRates';
import { previewUsageAccrual } from '@/lib/jobs/definitions/previewUsageAccrual';
// The composition root: loading it binds the meter to the ports' destroys.
import {
  getDatabasePort,
  getHostingDeployPort,
  observeDatabaseBranchDelete,
  observeHostingDestroyApp,
  resetDatabaseFakes,
  resetHostingFakes,
} from '@/lib/orchestrator';
import {
  createPreviewBranch,
  deletePreviewBranch,
  ensurePreviewDatabase,
} from '@/lib/preview/previewDatabase';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { previewUsageRepository } from '@/lib/repositories/previewUsageRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { ciPreviewUsageMeterService } from '@/lib/services/ciPreviewUsageMeterService';
import { previewRuntime } from '@/lib/services/previewLifecycleService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';

// PREVIEW USAGE METERED INTO THE CI POOL over real Postgres (Story MOTIR-5766 ·
// MOTIR-5777). The deploy and database ports are the orchestrator's fakes, with
// their clocks set to the pinned instant, and motir-ai is `fetch`: its balance
// read and its `ci_overage` debit, recorded. The destroys go through the
// composition root, as the lifecycle's do.

const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-07-15T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

const RUNTIME = previewRuntime({
  schemaVersion: 1,
  targets: ['fly', 'serverless'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
});

let debits: Array<Record<string, unknown>>;
let installations = 0;

function stubMotirAi(balance = 1000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (u.includes('/v1/usage')) return json({ balance });
      if (u.includes('/v1/credits/ci-overage')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        debits.push(body);
        return json({
          transactionId: `tx_${debits.length}`,
          aiOrganizationId: 'ai_org',
          credits: -Number(body.credits),
          balanceAfter: balance - Number(body.credits),
          exhausted: false,
          idempotent: false,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const fly = () => getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
const neon = () => getDatabasePort('neon') as unknown as FakeDatabaseControls;

interface LivePreview {
  previewId: string;
  rowId: string;
  appRef: string;
  organizationId: string;
}

/** A Motir-hosted repository on `target` with one ready preview: its app
 *  started and, off AWS, its Neon branch made — both at `NOW`. */
async function livePreview(
  fx: WorkItemFixture,
  target: HostingDeployTarget = 'fly',
  options: { branch?: boolean; deploy?: boolean; listed?: boolean } = {},
): Promise<LivePreview> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: String(556_600 + (installations += 1)),
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: String(9000 + installations),
      owner: MOTIR_ORG,
      name: 'acme-web',
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'acme-web' },
    fx.ctx,
  );
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  if (options.listed !== false) {
    await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
    await projectRepoSetService.setHosting(
      row.id,
      { target, useCase: 'mvp', size: 'small' },
      fx.ctx,
    );
  }

  const port = getHostingDeployPort(target);
  const environment = { kind: 'preview' as const, pullRequest: 7 };
  const app = await port.ensureApp({ repositoryId: row.id, environment });
  if (options.deploy !== false)
    await port.deploy({
      appRef: app.appRef,
      environment,
      artifact: { kind: 'image', ref: `registry.test/mh-${row.id}-pv:${'a'.repeat(40)}` },
      runtime: RUNTIME,
      env: [],
      idle: target === 'aws' ? { mode: 'always_on' } : { mode: 'suspend', idleSeconds: 300 },
      ...(target === 'aws' ? { shape: 'container' as const } : {}),
    });

  let neonIds: { neonProjectId: string; neonBranchId: string } | null = null;
  if (options.branch !== false && target !== 'aws') {
    const database = await ensurePreviewDatabase(row.id);
    const created = await createPreviewBranch(database, 7);
    neonIds = { neonProjectId: database.databaseRef, neonBranchId: created.branch.branchRef };
  }
  const preview = await adminDb.previewDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId: mirror.id,
      pullRequestNumber: 7,
      headSha: 'a'.repeat(40),
      host: `pr-7--acme-web-${row.id}.preview.motir.site`,
      state: 'ready',
      flyAppName: app.appRef,
      ...neonIds,
      createdAt: NOW,
    },
  });
  return {
    previewId: preview.id,
    rowId: row.id,
    appRef: app.appRef,
    organizationId: fx.workspace.organizationId,
  };
}

function advance(seconds: number): void {
  for (const target of ['fly', 'serverless', 'aws'] as const) {
    (getHostingDeployPort(target) as HostingDeployPort & FakeHostingControls).advanceSeconds(
      seconds,
    );
  }
  neon().advanceSeconds(seconds);
}

async function slices(previewId?: string) {
  return adminDb.previewUsage.findMany({
    where: previewId ? { previewDeploymentId: previewId } : {},
    orderBy: [{ sliceEnd: 'asc' }, { kind: 'asc' }],
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  debits = [];
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  resetHostingFakes();
  resetDatabaseFakes();
  for (const target of ['fly', 'serverless', 'aws'] as const) {
    const fake = getHostingDeployPort(target) as HostingDeployPort & FakeHostingControls;
    fake.advanceSeconds((NOW.getTime() - fake.now().getTime()) / 1000);
  }
  neon().setClock(NOW);
  stubMotirAi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the rates are the decision page’s', () => {
  it('converts each kind at MOTIR-5769 §9’s factor and list price', () => {
    // 0.0140 Linux-min per running minute; ≈ $0.0000014 a second.
    expect(priceSlice('machine_seconds', 60)).toEqual({
      linuxEquivalentMinutes: expect.closeTo(0.014, 10),
      motirCostUsd: expect.closeTo(0.000084, 12),
    });
    // 17.7 per CU-hour at $0.106.
    expect(priceSlice('neon_compute_hours', 1)).toEqual({
      linuxEquivalentMinutes: 17.7,
      motirCostUsd: 0.106,
    });
    // 0.167 per GB-minute; 33.3 per million requests.
    expect(priceSlice('lambda_gb_seconds', 60).linuxEquivalentMinutes).toBeCloseTo(0.167, 10);
    expect(priceSlice('lambda_requests', 1_000_000).linuxEquivalentMinutes).toBeCloseTo(33.3, 10);
    expect(priceSlice('lambda_requests', 1_000_000).motirCostUsd).toBeCloseTo(0.2, 10);
    expect(Object.keys(PREVIEW_USAGE_RATES).sort()).toEqual([
      'lambda_gb_seconds',
      'lambda_requests',
      'machine_seconds',
      'neon_compute_hours',
    ]);
  });
});

describe('the hourly accrual', () => {
  it('records the release’s running time and the branch’s compute, with Motir’s cost', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx);
    advance(3600);

    const outcome = await new JobTestEngine({ function: previewUsageAccrual }).execute();
    expect(outcome.result).toEqual({ previews: 1, slices: 2, failed: 0 });

    const [machine, branch] = (await slices()).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(machine).toMatchObject({
      previewDeploymentId: live.previewId,
      organizationId: live.organizationId,
      kind: 'machine_seconds',
      sourceRef: live.appRef,
      periodStart: JULY_2026,
      sliceStart: NOW,
      sliceEnd: new Date(NOW.getTime() + 3_600_000),
    });
    expect(Number(machine!.quantity)).toBe(3600);
    expect(Number(machine!.linuxEquivalentMinutes)).toBeCloseTo(0.84, 4);
    expect(Number(machine!.motirCostUsd)).toBeCloseTo(0.00504, 10);
    expect(branch).toMatchObject({ kind: 'neon_compute_hours' });
    expect(Number(branch!.quantity)).toBe(1);
    expect(Number(branch!.linuxEquivalentMinutes)).toBeCloseTo(17.7, 4);
    expect(Number(branch!.motirCostUsd)).toBeCloseTo(0.106, 10);
  });

  it('two runs over the same interval write one slice of each kind', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx);
    advance(1800);

    expect(await ciPreviewUsageMeterService.accrue()).toMatchObject({ slices: 2 });
    expect(await ciPreviewUsageMeterService.accrue()).toMatchObject({ slices: 0 });
    // The unique key is the backstop: a replayed slice is skipped, not doubled.
    const [first] = await slices();
    const replayed = await withSystemContext((tx) =>
      previewUsageRepository.insertSlices(
        [
          {
            ...first!,
            quantity: Number(first!.quantity),
            linuxEquivalentMinutes: Number(first!.linuxEquivalentMinutes),
            motirCostUsd: Number(first!.motirCostUsd),
          },
        ],
        tx,
      ),
    );
    expect(replayed).toBe(0);
    expect(await slices()).toHaveLength(2);
  });

  it('the next hour charges only the next window', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    advance(3600);
    await ciPreviewUsageMeterService.accrue();
    advance(1200);
    await ciPreviewUsageMeterService.accrue();

    const machine = await slices(live.previewId);
    expect(machine.map((s) => Number(s.quantity))).toEqual([3600, 1200]);
    expect(machine[1]!.sliceStart).toEqual(machine[0]!.sliceEnd);
  });

  it('writes nothing for a window another writer moved on meanwhile', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    advance(600);
    const usageSince = fly().usageSince.bind(fly());
    vi.spyOn(fly(), 'usageSince').mockImplementationOnce(async (handle, since) => {
      // The final slice of a concurrent destroy lands while this one measures.
      await ciPreviewUsageMeterService.recordDestroyedApp({
        target: 'fly',
        appRef: live.appRef,
        usage: [await usageSince(handle, since)],
      });
      return usageSince(handle, since);
    });

    expect(await ciPreviewUsageMeterService.accrue()).toMatchObject({ slices: 0 });
    expect((await slices()).map((s) => Number(s.quantity))).toEqual([600]);
  });

  it('meters nothing for an AWS preview, which runs in the tenant’s own account', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx, 'aws');
    advance(3600);
    expect(await ciPreviewUsageMeterService.accrue()).toEqual({
      previews: 1,
      slices: 0,
      failed: 0,
    });
  });

  it('counts a preview it cannot read and moves on', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx, 'fly', { branch: false });
    vi.spyOn(fly(), 'listReleases').mockRejectedValueOnce('fly is down');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await ciPreviewUsageMeterService.accrue()).toMatchObject({ failed: 1, slices: 0 });
  });

  it('skips a preview with no release yet, and one whose repository is in no project', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx, 'fly', { branch: false, deploy: false });
    const other = await makeWorkItemFixture();
    await livePreview(other, 'fly', { branch: false, listed: false });
    advance(3600);
    expect(await ciPreviewUsageMeterService.accrue()).toEqual({
      previews: 2,
      slices: 0,
      failed: 0,
    });
  });

  it('is inert off-cloud', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx);
    advance(3600);
    vi.stubEnv('MOTIR_CLOUD', 'false');
    expect(await ciPreviewUsageMeterService.accrue()).toEqual({
      previews: 0,
      slices: 0,
      failed: 0,
    });
  });
});

describe('the final slice, through the composition root', () => {
  it('a destroyed app writes one slice for what the accrual had not yet counted', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx);
    advance(3600);
    await ciPreviewUsageMeterService.accrue();
    advance(600);

    await getHostingDeployPort('fly').destroyApp({ appRef: live.appRef });
    const machine = (await slices(live.previewId)).filter((s) => s.kind === 'machine_seconds');
    expect(machine.map((s) => Number(s.quantity))).toEqual([3600, 600]);

    await deletePreviewBranch({
      database: { provider: 'neon', applicationRef: `${live.rowId}-pv`, databaseRef: '' },
      branchRef: 'unknown',
      name: 'pr-7',
    });
    const row = await adminDb.previewDeployment.findUniqueOrThrow({
      where: { id: live.previewId },
    });
    const database = await ensurePreviewDatabase(live.rowId);
    await deletePreviewBranch({ database, branchRef: row.neonBranchId!, name: 'pr-7' });
    const branch = (await slices(live.previewId)).filter((s) => s.kind === 'neon_compute_hours');
    // 4,200 seconds of branch life, 3,600 of them already charged.
    expect(branch.map((s) => Number(s.quantity).toFixed(6))).toEqual([
      (1).toFixed(6),
      (600 / 3600).toFixed(6),
    ]);
  });

  it('a serverless app is charged in GB-seconds and requests', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'serverless', { branch: false });
    const usage = {
      target: 'serverless' as const,
      appRef: live.appRef,
      releaseId: 'r1',
      since: NOW,
      until: new Date(NOW.getTime() + 3_600_000),
      runningSeconds: 3600,
      invocations: 2_000_000,
      compute: { unit: 'lambda' as const, gbSeconds: 6_369 },
    };
    expect(
      await ciPreviewUsageMeterService.recordDestroyedApp({
        target: 'serverless',
        appRef: live.appRef,
        usage: [usage, { ...usage, releaseId: 'r0', invocations: undefined, compute: undefined }],
      }),
    ).toBe(2);
    const written = await slices(live.previewId);
    expect(written.map((s) => [s.kind, Number(s.quantity)])).toEqual([
      ['lambda_gb_seconds', 6369],
      ['lambda_requests', 2_000_000],
    ]);
    expect(Number(written[1]!.linuxEquivalentMinutes)).toBeCloseTo(66.6, 4);
  });

  it('a destroy reporting no time past the last slice writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    advance(600);
    await ciPreviewUsageMeterService.accrue();
    expect(
      await ciPreviewUsageMeterService.recordDestroyedApp({
        target: 'fly',
        appRef: live.appRef,
        usage: [
          {
            target: 'fly',
            appRef: live.appRef,
            releaseId: 'r1',
            since: NOW,
            until: new Date(NOW.getTime() + 600_000),
            runningSeconds: 900,
          },
        ],
      }),
    ).toBe(0);
  });

  it('a branch no preview holds is not metered', async () => {
    const database = await ensurePreviewDatabase('cmloose');
    const { branch } = await createPreviewBranch(database, 3);
    advance(600);
    expect((await deletePreviewBranch(branch)).computeSeconds).toBe(600);
    expect(await slices()).toEqual([]);
  });

  it('an unbound composition root destroys and meters nothing', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx);
    advance(600);
    observeHostingDestroyApp(null);
    observeDatabaseBranchDelete(null);
    try {
      await getHostingDeployPort('fly').destroyApp({ appRef: live.appRef });
      const row = await adminDb.previewDeployment.findUniqueOrThrow({
        where: { id: live.previewId },
      });
      const database = await ensurePreviewDatabase(live.rowId);
      await deletePreviewBranch({ database, branchRef: row.neonBranchId!, name: 'pr-7' });
      expect(await slices()).toEqual([]);
    } finally {
      observeHostingDestroyApp((input) => ciPreviewUsageMeterService.recordDestroyedApp(input));
      observeDatabaseBranchDelete((input) => ciPreviewUsageMeterService.recordDeletedBranch(input));
    }
  });

  it('the preview lifecycle’s own code calls no billing', () => {
    const dir = path.join(process.cwd(), 'lib/services');
    const files = readdirSync(dir).filter((f) => f.startsWith('preview'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(path.join(dir, file), 'utf8')).not.toMatch(
        /ciAllowanceService|debitCiOverage/,
      );
    }
  });

  it('an app that is no preview’s, or a target with no factor, is not metered', async () => {
    const fx = await makeWorkItemFixture();
    await livePreview(fx, 'fly', { branch: false });
    advance(60);
    expect(
      await ciPreviewUsageMeterService.recordDestroyedApp({
        target: 'fly',
        appRef: 'mh-somebody-pv',
        usage: [
          {
            target: 'fly',
            appRef: 'mh-somebody-pv',
            releaseId: 'r1',
            since: NOW,
            until: new Date(NOW.getTime() + 60_000),
            runningSeconds: 60,
          },
        ],
      }),
    ).toBe(0);
    expect(
      await ciPreviewUsageMeterService.recordDestroyedApp({
        target: 'aws',
        appRef: 'x',
        usage: [],
      }),
    ).toBe(0);
    expect(await slices()).toEqual([]);
  });

  it('a failure to record is logged with its figures, never thrown at the destroy', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx);
    advance(300);
    vi.spyOn(previewUsageRepository, 'findMetered').mockRejectedValue(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      getHostingDeployPort('fly').destroyApp({ appRef: live.appRef }),
    ).resolves.toHaveLength(1);
    const row = await adminDb.previewDeployment.findUniqueOrThrow({
      where: { id: live.previewId },
    });
    const database = await ensurePreviewDatabase(live.rowId);
    await deletePreviewBranch({ database, branchRef: row.neonBranchId!, name: 'pr-7' });
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]![1]).toMatchObject({ appRef: live.appRef });
  });
});

describe('the pool read, and the charge past it', () => {
  it('getOrgPeriodConsumption returns CI minutes plus preview minutes, by source', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: live.organizationId,
          periodStart: JULY_2026,
          billableMinutes: 100,
          rawWallClockSeconds: 6000,
          linearEquivalentMinutes: 100,
        },
        tx,
      ),
    );
    advance(60_000); // 14 Linux-equivalent minutes of running time
    await ciPreviewUsageMeterService.accrue();

    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      live.organizationId,
      NOW,
    );
    expect(consumption.linearEquivalentMinutes).toBeCloseTo(114, 4);
    expect(consumption.bySource).toEqual({ ci: 100, preview: expect.closeTo(14, 4) });
    const state = await ciAllowanceService.getEntitlementState(live.organizationId, NOW);
    expect(state.consumedBySource).toEqual({ ci: 100, preview: expect.closeTo(14, 4) });
  });

  it('CI inside the pool plus previews past it debits exactly the overage as ci_overage', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    // One member: the 1,000-minute floor. CI alone is inside it.
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: live.organizationId,
          periodStart: JULY_2026,
          billableMinutes: 990,
          rawWallClockSeconds: 59_400,
          linearEquivalentMinutes: 990,
        },
        tx,
      ),
    );
    expect(
      await ciAllowanceService.chargeForMeteredRun({
        organizationId: live.organizationId,
        periodStart: JULY_2026,
      }),
    ).toMatchObject({ outcome: 'within_allowance' });
    expect(debits).toEqual([]);

    advance(60_000); // + 14 minutes: 1,004, four past the pool
    await ciPreviewUsageMeterService.accrue();

    expect(debits).toEqual([expect.objectContaining({ credits: 4 })]);
    const state = await ciAllowanceService.getEntitlementState(live.organizationId, NOW);
    expect(state).toMatchObject({ overageMinutes: expect.closeTo(4, 4), chargedCredits: 4 });
  });

  it('a charge motir-ai refuses is logged and leaves the slices in place', async () => {
    const fx = await makeWorkItemFixture();
    const live = await livePreview(fx, 'fly', { branch: false });
    vi.spyOn(ciAllowanceService, 'chargeForMeteredRun').mockRejectedValueOnce(new Error('down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    advance(600);
    expect(await ciPreviewUsageMeterService.accrue()).toMatchObject({ slices: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not charge'),
      expect.objectContaining({ organizationId: live.organizationId }),
    );
  });
});
