import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { OrgIndexPools } from '@/lib/ciFleet/indexAllowance';
import type { RawUsageResponse } from '@/lib/ai/types';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { ContainerUsage } from '@motir/orchestrator';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE ORG PAGE'S INDEX & FLEET COST CARD — the service (MOTIR-5341 · Story MOTIR-4335;
// design Panel 14), against a REAL Postgres. motir-ai and the session gate are mocked;
// the fleet cost rows are written through the real meter writer.
//
// ⚠️ Motir does not charge for code indexing. Everything here is internal.

const poolsMock = vi.fn<(id: string) => Promise<OrgIndexPools | null>>();
const usageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  fetchOrgIndexPools: (id: string) => poolsMock(id),
  getOrgUsage: (q: unknown) => usageMock(q),
}));

let currentPrincipal: PlatformPrincipal;
const gate = vi.fn(async () => currentPrincipal);
vi.mock('@/lib/platform/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/auth')>()),
  requirePlatformStaff: () => gate(),
}));

const { platformOrgIndexCostService } = await import('@/lib/services/platformOrgIndexCostService');
const { ciFleetCostMeterService } = await import('@/lib/services/ciFleetCostMeterService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { usdCents } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/OrgIndexCostCard');

const NOW = new Date('2026-09-15T12:00:00.000Z');
let seq = 0;

async function seedOrg() {
  const owner = await createTestUser({ email: `org-cost-${seq++}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${seq}`,
    ownerUserId: owner.id,
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `inst-cost-${seq++}`,
      accountLogin: `acme${seq}`,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: `${5000 + seq}`,
        owner: `acme${seq}`,
        name: 'web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { organizationId: workspace.organizationId, workspaceId: workspace.id };
}

async function recordContainer(
  fx: { organizationId: string; workspaceId: string },
  workload: 'code_graph_index' | 'ci_runner',
  seconds: number,
  costUsd: string,
) {
  const usage: ContainerUsage = {
    handleId: `m-${seq++}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: null as unknown as string,
    repoFullName: 'acme/web',
    workload,
    workflowJobId: workload === 'ci_runner' ? 44001 : null,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 4096,
    createdAt: new Date(NOW.getTime() - 600_000),
    startedAt: new Date(NOW.getTime() - seconds * 1000),
    stoppedAt: NOW,
    billableSeconds: seconds,
    usdPerSecond: '0.000031636049',
    costUsd,
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
  };
  expect((await ciFleetCostMeterService.recordContainerUsage(usage)).outcome).toBe('recorded');
}

const OVER: OrgIndexPools = {
  known: true,
  isMeta: false,
  tier: { key: 'pro', name: 'Pro', cadence: 'monthly', allotmentCredits: 8000 },
  credit: { balanceCredits: 6240 },
  index: {
    window: '2026-09',
    grantedCredits: 1600,
    consumedCredits: 1792,
    remainingCredits: 0,
    crossingRecorded: true,
  },
  state: 'over_still_indexing',
};

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_audit_log", "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  const staff = await createTestUser({ email: `ops+cost${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'support' };
  gate.mockClear();
  poolsMock.mockReset().mockResolvedValue(OVER);
  usageMock.mockReset().mockResolvedValue({ monthSpend: 1760 } as RawUsageResponse);
  vi.stubEnv('MOTIR_CLOUD', 'true');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function enabled(organizationId: string) {
  const dto = await platformOrgIndexCostService.read(currentPrincipal, organizationId, NOW);
  if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
  return dto;
}

describe('both pools, never conflated (AC 1)', () => {
  it('draws the credit balance from the balance and the token spend, and the allowance from the allowance alone', async () => {
    const org = await seedOrg();
    const dto = await enabled(org.organizationId);
    if (dto.pools.state !== 'read') throw new Error('expected read pools');

    expect(poolsMock).toHaveBeenCalledWith(org.organizationId);
    expect(dto.pools.credit).toEqual({ remaining: 6240, granted: 8000, consumed: 1760, pct: 22 });
    expect(dto.pools.index).toMatchObject({
      window: '2026-09',
      remaining: 0,
      granted: 1600,
      consumed: 1792,
    });
    expect(dto.pools.index?.pct).toBeCloseTo(112, 6);
    // The allowance's consumption is nowhere in the visible pool, and vice versa.
    expect(JSON.stringify(dto.pools.credit)).not.toContain('1792');
    expect(JSON.stringify(dto.pools.index)).not.toContain('6240');
  });
});

describe('the three threshold states are told apart (AC 2)', () => {
  it.each([
    ['under', 'under'],
    ['over_still_indexing', 'over_still_indexing'],
    ['stopped_no_credit', 'stopped_no_credit'],
    ['stopped_allowance_exhausted', 'stopped_allowance_exhausted'],
    ['exempt', 'exempt'],
    ['hard_stop_headroom_future', 'other'],
  ])('motir-ai %s reads as %s', async (state, expected) => {
    const org = await seedOrg();
    poolsMock.mockResolvedValue({ ...OVER, state } as OrgIndexPools);
    const dto = await enabled(org.organizationId);
    expect(dto.pools.state === 'read' && dto.pools.indexState).toBe(expected);
  });

  it('a stopped org carries its recorded pause', async () => {
    const org = await seedOrg();
    const pausedAt = new Date('2026-09-10T08:00:00.000Z');
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: org.workspaceId },
      data: { indexPausedReason: 'paused_index_no_credit', indexPausedAt: pausedAt },
    });
    poolsMock.mockResolvedValue({ ...OVER, state: 'stopped_no_credit' });
    expect((await enabled(org.organizationId)).pause).toEqual({
      reason: 'no_credit',
      since: pausedAt.toISOString(),
    });
  });

  it('a full indexer pool is not the org’s pause: the card reads no pause (MOTIR-9451)', async () => {
    const org = await seedOrg();
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: org.workspaceId },
      data: { indexPausedReason: 'paused_index_pool_full', indexPausedAt: new Date() },
    });
    expect((await enabled(org.organizationId)).pause).toBeNull();
  });

  it('the card renders state (b) in the INFO family and the stops in danger — never (b) as a failure', () => {
    const source = readFileSync(
      'app/(admin)/admin/tenants/[orgId]/_components/OrgIndexCostCard.tsx',
      'utf8',
    );
    expect(source).toMatch(/state === 'over_still_indexing'\) return <Pill severity="info">/);
    expect(source).toMatch(
      /stopped_no_credit' \|\| state === 'stopped_allowance_exhausted'\)\s*return <Pill severity="danger">/,
    );
  });
});

describe('the ways this card can lie (AC 3)', () => {
  it('workload lines come from the real rollup, and a line that did not run is ABSENT, not zero', async () => {
    const org = await seedOrg();
    await recordContainer(org, 'code_graph_index', 1840, '0.058210330160');
    const dto = await enabled(org.organizationId);
    expect(dto.workloads).toEqual([
      { workload: 'ci', containerCount: null, containerSeconds: null, costUsd: null },
      { workload: 'index', containerCount: 1, containerSeconds: 1840, costUsd: expect.any(String) },
      { workload: 'agent', containerCount: null, containerSeconds: null, costUsd: null },
      // Agent instances (MOTIR-6872) meter under their own line.
      { workload: 'instance', containerCount: null, containerSeconds: null, costUsd: null },
    ]);
    const index = dto.workloads.find((w) => w.workload === 'index')!;
    expect(new Prisma.Decimal(index.costUsd!).equals(new Prisma.Decimal('0.058210330160'))).toBe(
      true,
    );
  });

  it('a failed motir-ai read is UNKNOWN; a failed usage read leaves the spend unknown; an unseen org is absent', async () => {
    const org = await seedOrg();
    poolsMock.mockResolvedValueOnce(null);
    expect((await enabled(org.organizationId)).pools).toEqual({ state: 'unknown' });

    usageMock.mockRejectedValueOnce(new Error('motir-ai down'));
    const noSpend = await enabled(org.organizationId);
    expect(noSpend.tokenSpendCredits).toBeNull();
    expect(noSpend.pools.state === 'read' && noSpend.pools.credit).toMatchObject({
      consumed: null,
      pct: null,
    });

    poolsMock.mockResolvedValueOnce({ known: false });
    expect((await enabled(org.organizationId)).pools).toEqual({ state: 'absent' });
  });

  it('off-cloud the meter is DISABLED and nothing is read', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    const org = await seedOrg();
    expect(
      await platformOrgIndexCostService.read(currentPrincipal, org.organizationId, NOW),
    ).toEqual({ meter: 'disabled' });
    expect(poolsMock).not.toHaveBeenCalled();
    expect(usageMock).not.toHaveBeenCalled();
  });

  it('money is rounded to cents from the decimal string, never through a float', () => {
    expect(usdCents('0.058210330160')).toBe('$0.06');
    expect(usdCents('4.125')).toBe('$4.13');
    expect(usdCents('12345678.994999999999')).toBe('$12,345,678.99');
    expect(usdCents('0')).toBe('$0.00');
  });
});

describe('only platform staff reach it (AC 4)', () => {
  it('re-asserts the gate, records the read against the org, and a refusal reads nothing', async () => {
    const org = await seedOrg();
    await platformOrgIndexCostService.read(currentPrincipal, org.organizationId, NOW);
    expect(gate).toHaveBeenCalledTimes(1);
    const audit = await adminDb.platformAuditLog.findMany({
      where: { actorUserId: currentPrincipal.userId },
    });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'estate.read',
          targetKind: 'organization',
          targetId: org.organizationId,
        }),
      ]),
    );

    poolsMock.mockClear();
    gate.mockRejectedValueOnce(new Error('NEXT_NOT_FOUND'));
    await expect(
      platformOrgIndexCostService.read(currentPrincipal, org.organizationId, NOW),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(poolsMock).not.toHaveBeenCalled();
  });

  it('the org pools read is imported only by the staff-gated service and the admin org page', () => {
    const importers = execSync(
      `git grep -l -E "fetchOrgIndexPools|platformOrgIndexCostService" -- 'app' 'lib' 'components'`,
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(importers).toEqual([
      'app/(admin)/admin/tenants/[orgId]/page.tsx',
      'lib/ai/motirAiClient.ts',
      'lib/services/platformOrgIndexCostService.ts',
    ]);
  });
});

describe('the words (AC 6)', () => {
  it('no identifier, copy string or test name describes index cost as charged, billed or priced', () => {
    const affirmative = /\b(charg\w*|bill(ed|ing)?|pric(e|ed|ing))\b/i;
    const negated = /\b(not|never|no|nothing|none)\b/i;
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).platformAdmin.orgs.indexCost;
    for (const text of [
      JSON.stringify(en, null, 1),
      readFileSync('lib/services/platformOrgIndexCostService.ts', 'utf8'),
      readFileSync('app/(admin)/admin/tenants/[orgId]/_components/OrgIndexCostCard.tsx', 'utf8'),
    ]) {
      const real = text
        .split('\n')
        .filter(
          (l) => affirmative.test(l) && !negated.test(l) && !/isCloudBilling|lib\/billing/.test(l),
        );
      expect(real).toEqual([]);
    }
  });
});
