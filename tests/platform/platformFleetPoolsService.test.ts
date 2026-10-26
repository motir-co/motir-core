import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { setAwsEc2OverrideForTests } from '@/lib/orchestrator';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { fleetPoolStatusService } from '@/lib/services/fleetPoolStatusService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import type { PlatformPoolBlockDTO } from '@/lib/dto/platformFleetPools';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE POOLS READ (Story MOTIR-9367 · MOTIR-9562) against a REAL Postgres. Mocked:
// the platform session gate. Real: the shard rows, the CI intents the headroom
// pass reads use from, the quota requests, the growth events and the audit trail.
// The AWS seams are installed THROWING, so a call to either fails the test.

let currentPrincipal: PlatformPrincipal;
const gate = vi.fn(async () => currentPrincipal);
vi.mock('@/lib/platform/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/auth')>()),
  requirePlatformStaff: () => gate(),
}));

const { platformFleetPoolsService, poolTotal } =
  await import('@/lib/services/platformFleetPoolsService');
const { workspacesService } = await import('@/lib/services/workspacesService');

const NOW = new Date('2026-10-25T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const SECRET = 'FLEET_SECRET_NEVER_ON_THE_PAGE';
const ACCOUNT_ID = '444455556666';
let seq = 0;
let ownerEmails: string[] = [];

const ec2Factory = vi.fn(() => {
  throw new Error('the pools read must not reach EC2');
});
const quotaRead = vi.fn(async () => {
  throw new Error('the pools read must not read Service Quotas');
});
let unregisterProvider: () => void;

interface Tenant {
  organizationId: string;
  workspaceId: string;
}

async function seedTenant(): Promise<Tenant> {
  seq += 1;
  const email = `pools-owner-${seq}@example.com`;
  ownerEmails.push(email);
  const owner = await createTestUser({ email });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Pools ${seq}`,
    ownerUserId: owner.id,
  });
  return { organizationId: workspace.organizationId, workspaceId: workspace.id };
}

async function account(
  name: string,
  options: {
    granted?: number | null;
    role?: 'primary' | 'spare';
    state?: 'active' | 'provisioning' | 'disabled';
    fleetKind?: string;
  } = {},
) {
  seq += 1;
  const granted = options.granted === undefined ? 100 : options.granted;
  const shard = await fleetShardService.createShard({
    name,
    fleetKind: options.fleetKind ?? 'ci_runner',
    provider: 'aws',
    role: options.role ?? 'primary',
    state: options.state ?? 'active',
    githubOrg: 'motir-fleet-use1-1',
    githubInstallationId: '9001',
    awsAccountId: `${ACCOUNT_ID.slice(0, 10)}${String(seq).padStart(2, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: SECRET,
    limits: granted === null ? {} : { vcpuQuota: granted },
    limitsSource: granted === null ? {} : { vcpuQuota: 'provider_read' },
  });
  return shard;
}

/** One CI job running on the account now — 2 vCPU of its peak. */
async function runningJob(t: Tenant, shardId: string) {
  seq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.organizationId,
      installationId: '1',
      runId: `run-${seq}`,
      runAttempt: 1,
      jobId: `job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: ago(10 * MIN),
      status: 'running',
      fleetShardId: shardId,
      bootedAt: ago(2 * MIN),
      startedAt: ago(2 * MIN),
    },
  });
}

async function quotaRequest(
  shardId: string,
  options: {
    status?: 'pending' | 'case_opened' | 'approved' | 'denied';
    desired?: number;
    granted?: number | null;
    createdAt: Date;
    closedAt?: Date | null;
  },
) {
  seq += 1;
  return adminDb.fleetQuotaRequest.create({
    data: {
      shardId,
      fleetKind: 'ci_runner',
      quotaCode: 'L-1216C47A',
      desiredValue: options.desired ?? 128,
      awsRequestId: `req-${seq}`,
      status: options.status ?? 'pending',
      grantedValue: options.granted ?? null,
      createdAt: options.createdAt,
      lastReadAt: ago(MIN),
      closedAt: options.closedAt ?? null,
    },
  });
}

const aws = (blocks: PlatformPoolBlockDTO[], kind: string) => {
  const block = blocks.find((b) => b.fleetKind === kind);
  if (!block || block.provider !== 'aws') throw new Error(`${kind} is not on AWS`);
  return block;
};

const audits = () => adminDb.platformAuditLog.findMany({ where: { action: 'estate.read' } });

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformAuditLog.deleteMany();
  ownerEmails = [];
  const staff = await createTestUser({ email: `pools-staff-${seq++}@example.com` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'support' };
  gate.mockReset().mockImplementation(async () => currentPrincipal);
  ec2Factory.mockClear();
  quotaRead.mockClear();
  setAwsEc2OverrideForTests(ec2Factory as never);
  unregisterProvider = registerShardProvisioningProvider({
    name: 'aws',
    options: [],
    requiredEnv: () => [],
    validate: () => [],
    location: () => {
      throw new Error('the pools read must not provision');
    },
    matchesRow: () => false,
    account: quotaRead as never,
    network: quotaRead as never,
    readQuota: quotaRead as never,
    runtimeCredential: quotaRead as never,
    manualCredentialStep: () => '',
  });
  wireFleetKindSwitch('ci_runner', () => true);
});

afterEach(() => {
  wireFleetKindSwitch('ci_runner', null);
  setAwsEc2OverrideForTests(null);
  unregisterProvider();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformFleetPoolsService.listPools', () => {
  it('is refused without platform staff, and writes no audit entry', async () => {
    gate.mockRejectedValue(new NotPlatformStaffError());
    await expect(platformFleetPoolsService.listPools(currentPrincipal, NOW)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(await audits()).toHaveLength(0);
  });

  it('reads every kind in page order: a Fly kind carries no figures, an AWS kind its pool across every tenant', async () => {
    const [a, b, c] = [await seedTenant(), await seedTenant(), await seedTenant()];
    const iad1 = await account('ci-iad-1', { granted: 8 });
    const iad2 = await account('ci-iad-2', { granted: 16 });
    // A disabled account and the spare are not part of the pool's capacity.
    await account('ci-iad-off', { granted: 64, state: 'disabled' });
    const spare = await account('ci-iad-spare', { granted: 200, role: 'spare' });
    // Three tenants in three workspaces on iad-1 (6 vCPU), two on iad-2 (4 vCPU).
    for (const t of [a, b, c]) await runningJob(t, iad1.id);
    for (const t of [a, b]) await runningJob(t, iad2.id);

    const old = await quotaRequest(iad1.id, {
      status: 'approved',
      granted: 8,
      createdAt: ago(40 * DAY),
      closedAt: ago(39 * DAY),
    });
    const denied = await quotaRequest(iad2.id, {
      status: 'denied',
      desired: 512,
      createdAt: ago(3 * DAY),
      closedAt: ago(2 * DAY),
    });
    const open = await quotaRequest(iad1.id, { status: 'pending', createdAt: ago(10 * DAY) });
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: iad1.id,
        vcpuInUse: 6,
        grantedQuota: 8,
        outcome: 'spare_promoted',
        spareShardId: iad2.id,
        createdAt: ago(5 * DAY),
      },
    });
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: iad2.id,
        vcpuInUse: 12,
        grantedQuota: 16,
        outcome: 'refused',
        reason: 'You have exceeded the allowed number of AWS accounts.',
        createdAt: ago(1 * DAY),
      },
    });

    const { blocks } = await platformFleetPoolsService.listPools(currentPrincipal, NOW);

    expect(blocks.map((b) => [b.fleetKind, b.provider])).toEqual([
      ['ci_runner', 'aws'],
      ['hosted_agent', 'fly'],
      ['code_graph_index', 'fly'],
      ['agent_instance', 'fly'],
    ]);
    for (const block of blocks.slice(1))
      expect(Object.keys(block).sort()).toEqual(['fleetKind', 'provider']);

    const ci = aws(blocks, 'ci_runner');
    // Every tenant's jobs are counted: 6 + 4 vCPU, never the subset one workspace sees.
    expect(ci.pool).toEqual({ grantedVcpu: 24, usedVcpu: 10, percent: 42, complete: true });
    expect(ci.accounts.map((x) => x.name)).toEqual(['ci-iad-1', 'ci-iad-2']);
    const [one, two] = ci.accounts;
    expect(one).toMatchObject({
      role: 'shared',
      grantedVcpu: 8,
      usedVcpu: 6,
      percent: 75,
      toThreshold: 0,
      overThreshold: true,
    });
    expect(one!.grantedReadAt).not.toBeNull();
    expect(two).toMatchObject({ usedVcpu: 4, percent: 25, toThreshold: 8, overThreshold: false });

    expect(ci.spares).toEqual([
      {
        name: 'ci-iad-spare',
        state: 'active',
        grantedVcpu: 200,
        grantedReadAt: expect.any(String),
        ready: true,
      },
    ]);
    void spare;

    // Every request, the one closed 39 days ago included: open first, then newest.
    expect(ci.requests.map((r) => [r.status, r.open])).toEqual([
      ['pending', true],
      ['denied', false],
      ['approved', false],
    ]);
    expect(ci.requests[1]).toMatchObject({
      account: 'ci-iad-2',
      desiredValue: 512,
      grantedValue: null,
      createdAt: denied.createdAt.toISOString(),
    });
    expect(ci.requests[0]!.createdAt).toBe(open.createdAt.toISOString());
    expect(ci.requests[2]!.createdAt).toBe(old.createdAt.toISOString());
    expect(ci.requests[0]!.lastReadAt).toBe(ago(MIN).toISOString());

    expect(ci.growthEvents.map((e) => [e.outcome, e.triggeringAccount, e.reason])).toEqual([
      ['refused', 'ci-iad-2', 'You have exceeded the allowed number of AWS accounts.'],
      ['spare_promoted', 'ci-iad-1', null],
    ]);
    expect(ci.growthEvents[1]).toMatchObject({ vcpuInUse: 6, grantedQuota: 8 });

    // One audit entry, no AWS call, and nothing secret on the way out.
    expect(await audits()).toHaveLength(1);
    expect(ec2Factory).not.toHaveBeenCalled();
    expect(quotaRead).not.toHaveBeenCalled();
    const text = JSON.stringify(blocks);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCOUNT_ID.slice(0, 10));
    for (const email of [...ownerEmails, currentPrincipal.email]) expect(text).not.toContain(email);
  });

  it('keeps an unread quota null all the way out, and the pool total incomplete', async () => {
    const t = await seedTenant();
    const read = await account('ci-read', { granted: 10 });
    const failed = await account('ci-failed', { granted: null });
    const lastGood = ago(3 * DAY);
    // A read that once succeeded and has since failed: the stored value is gone,
    // the time of the last good read stays.
    await adminDb.fleetShard.update({
      where: { id: failed.id },
      data: { limitsSource: { vcpuQuota: 'provider_read' }, limitsVerifiedAt: lastGood },
    });
    await account('ci-never', { granted: null });
    await runningJob(t, read.id);
    await runningJob(t, failed.id);
    const waiting = await account('ci-spare', { granted: 5, role: 'spare', state: 'provisioning' });
    await quotaRequest(waiting.id, { status: 'pending', createdAt: ago(MIN) });

    const ci = aws(
      (await platformFleetPoolsService.listPools(currentPrincipal, NOW)).blocks,
      'ci_runner',
    );

    const byName = Object.fromEntries(ci.accounts.map((x) => [x.name, x]));
    expect(byName['ci-failed']).toMatchObject({
      grantedVcpu: null,
      grantedReadAt: lastGood.toISOString(),
      usedVcpu: 2,
      percent: null,
      toThreshold: null,
      overThreshold: false,
    });
    expect(byName['ci-never']).toMatchObject({
      grantedVcpu: null,
      grantedReadAt: null,
      percent: null,
      toThreshold: null,
    });
    expect(ci.pool).toEqual({ grantedVcpu: 10, usedVcpu: 4, percent: null, complete: false });
    // A spare waiting on its raise is not ready.
    expect(ci.spares).toEqual([
      expect.objectContaining({ name: 'ci-spare', grantedVcpu: 5, ready: false }),
    ]);
  });

  it('keeps one kind’s failed read inside its own block', async () => {
    await account('ci-iad-1', { granted: 8 });
    wireFleetKindSwitch('hosted_agent', () => true);
    try {
      const real = fleetPoolStatusService.getPoolStatus.bind(fleetPoolStatusService);
      vi.spyOn(fleetPoolStatusService, 'getPoolStatus').mockImplementation(async (kind, deps) => {
        if (kind === 'hosted_agent') throw new Error('the agent runner read broke');
        return real(kind, deps);
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { blocks } = await platformFleetPoolsService.listPools(currentPrincipal, NOW);
      expect(blocks.map((b) => [b.fleetKind, b.provider])).toEqual([
        ['ci_runner', 'aws'],
        ['hosted_agent', 'unavailable'],
        ['code_graph_index', 'fly'],
        ['agent_instance', 'fly'],
      ]);
      expect(aws(blocks, 'ci_runner').accounts).toHaveLength(1);
    } finally {
      // The agent runner's real reader is the env var; put it back.
      const { agentRunnerOnPool } = await import('@/lib/ciFleet/fleetKindSwitches');
      wireFleetKindSwitch('hosted_agent', agentRunnerOnPool);
    }
  });

  it('answers the indexer’s switch, though nothing in this read places an index', async () => {
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
    try {
      const { blocks } = await platformFleetPoolsService.listPools(currentPrincipal, NOW);
      expect(blocks.find((b) => b.fleetKind === 'code_graph_index')!.provider).toBe('aws');
    } finally {
      vi.unstubAllEnvs();
    }
    const { blocks } = await platformFleetPoolsService.listPools(currentPrincipal, NOW);
    expect(blocks.find((b) => b.fleetKind === 'code_graph_index')!.provider).toBe('fly');
  });

  it('a pool with no account yet is incomplete, with nothing to sum', () => {
    expect(poolTotal([])).toEqual({ grantedVcpu: 0, usedVcpu: 0, percent: null, complete: false });
  });
});
