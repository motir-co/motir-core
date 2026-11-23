import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { INSTALL_FLEET_TAG } from '@/lib/ciFleet/installFleet';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { InstallFleetBlockDTO, ShardBlockDTO, ShardPoolDTO } from '@/lib/dto/fleetStatusPools';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import type { Ec2VcpuQuotaReader } from '@/lib/awsServices/ec2VcpuQuotaReader';
import { setAwsEc2OverrideForTests } from '@/lib/orchestrator';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET STATUS PAGE'S POOLS READ (MOTIR-10887; design MOTIR-10885) against a
// REAL Postgres: the admission records (slots, intents, agent instances), the
// accounts, the `platform_aws_read` mark and the `fleet.status.read` audit row
// are real. Faked: the platform session gate and the EC2 vCPU quota reader (a
// test double passed in), and the AWS seams, installed THROWING — the add-shard
// read must not reach AWS at all.

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const {
  fleetStatusPoolsService: service,
  judgeCiSpot,
  judgeInstallBlock,
} = await import('@/lib/services/fleetStatusPoolsService');
const { platformFleetPoolsService } = await import('@/lib/services/platformFleetPoolsService');

const NOW = new Date('2026-11-11T12:00:00.000Z');
const MIN = 60_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const earlier = (ms: number) => new Date(NOW.getTime() - ms);
const QUOTA_SUBJECT = 'servicequotas:ec2/L-1216C47A';
let seq = 0;

const quota = (vcpu: number): Ec2VcpuQuotaReader => ({
  readStandardVcpuQuota: vi.fn(async () => vcpu),
});
const unanswered = (): Ec2VcpuQuotaReader => ({
  readStandardVcpuQuota: vi.fn(async () => {
    throw Object.assign(new Error('arn:aws:iam::123:role/x is not authorized'), {
      name: 'AccessDeniedException',
    });
  }),
});

async function tenant(isMeta: boolean): Promise<WorkItemFixture> {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: `Pools ${seq}`, identifier: `PL${seq}` });
  if (isMeta) {
    await adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return fx;
}

async function slot(
  fx: WorkItemFixture,
  workload: FleetWorkloadKind,
  options: { shardId?: string | null; expiresAt?: Date } = {},
) {
  seq += 1;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: `ref-${seq}`,
      organizationId: fx.workspace.organizationId,
      workspaceId: fx.workspaceId,
      fleetShardId: options.shardId ?? null,
      expiresAt: options.expiresAt ?? later(30 * MIN),
    },
  });
}

async function instance(
  fx: WorkItemFixture,
  state: 'running' | 'hibernated',
  options: { flyApp?: string | null; shardId?: string | null; deleted?: boolean } = {},
) {
  seq += 1;
  await adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name: `agent-${seq}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      flyApp: options.flyApp === undefined ? INSTALL_FLEET_TAG : options.flyApp,
      fleetShardId: options.shardId ?? null,
      state,
      deletedAt: options.deleted ? earlier(MIN) : null,
    },
  });
}

async function account(
  name: string,
  options: {
    granted?: number | null;
    role?: 'primary' | 'spare';
    state?: 'active' | 'provisioning' | 'disabled';
    fleetKind?: FleetWorkloadKind;
    override?: number;
    machineLimit?: number;
    pausedUntil?: Date;
    pausedReason?: 'capacity_refused' | 'provider_unavailable';
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
    awsAccountId: `4444555566${String(seq % 100).padStart(2, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SECRET_NEVER_ON_THE_PAGE',
    limits: granted === null ? {} : { vcpuQuota: granted },
    limitsSource: granted === null ? {} : { vcpuQuota: 'provider_read' },
  });
  if (options.override !== undefined || options.pausedUntil || options.machineLimit !== undefined) {
    await adminDb.fleetShard.update({
      where: { id: shard.id },
      data: {
        machineLimit: options.machineLimit ?? null,
        admissionCeilingOverride: options.override ?? null,
        admissionPausedUntil: options.pausedUntil ?? null,
        admissionPausedReason: options.pausedReason ?? null,
      },
    });
  }
  return shard;
}

async function ciJob(
  fx: WorkItemFixture,
  shardId: string | null,
  options: {
    installFleet?: boolean;
    status?: string;
    /** When it booted; null = never booted. Default: 2 minutes before NOW. */
    bootedAt?: Date | null;
    capacity?: 'spot' | 'on_demand' | null;
    teardownReason?: string;
  } = {},
) {
  seq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: '1',
      runId: `run-${seq}`,
      runAttempt: 1,
      jobId: `job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: earlier(10 * MIN),
      status: options.status ?? 'running',
      fleetShardId: shardId,
      installFleet: options.installFleet ?? false,
      bootedAt: options.bootedAt === undefined ? earlier(2 * MIN) : options.bootedAt,
      startedAt: earlier(2 * MIN),
      capacity: options.capacity ?? null,
      teardownReason: options.teardownReason ?? null,
    },
  });
}

const okInstall = (block: InstallFleetBlockDTO) => {
  if (block.status !== 'ok') throw new Error('the install block did not read');
  return block;
};
const okShard = (block: ShardBlockDTO) => {
  if (block.status !== 'ok') throw new Error('the add-shard block did not read');
  return block;
};
const awsPool = (block: ShardBlockDTO, kind: FleetWorkloadKind) => {
  const pool = okShard(block).pools.find((p) => p.fleetKind === kind);
  if (!pool || pool.provider !== 'aws') throw new Error(`${kind} is not an AWS pool`);
  return pool as Extract<ShardPoolDTO, { provider: 'aws' }>;
};
const audits = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.status.read' },
    orderBy: { createdAt: 'asc' },
  });

let unregisterProvider: () => void;
const throwing = vi.fn(() => {
  throw new Error('the pools read must not reach AWS');
});
const env = { kinds: process.env.MOTIR_INSTALL_FLEET_KINDS, cloud: process.env.MOTIR_CLOUD };

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformAuditLog.deleteMany();
  await adminDb.platformAwsRead.deleteMany();
  const staff = await createTestUser({ email: `fleet-pools-${seq++}@example.com` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'superadmin' };
  process.env.MOTIR_INSTALL_FLEET_KINDS = 'agent_instance,hosted_agent';
  process.env.MOTIR_CLOUD = 'true';
  setAwsEc2OverrideForTests(throwing as never);
  unregisterProvider = registerShardProvisioningProvider({
    name: 'aws',
    options: [],
    requiredEnv: () => [],
    validate: () => [],
    location: throwing as never,
    matchesRow: () => false,
    account: throwing as never,
    network: throwing as never,
    readQuota: throwing as never,
    runtimeCredential: throwing as never,
    manualCredentialStep: () => '',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const kind of ['ci_runner', 'hosted_agent', 'agent_instance'] as const)
    wireFleetKindSwitch(kind, null);
  setAwsEc2OverrideForTests(null);
  unregisterProvider();
  if (env.kinds === undefined) delete process.env.MOTIR_INSTALL_FLEET_KINDS;
  else process.env.MOTIR_INSTALL_FLEET_KINDS = env.kinds;
  if (env.cloud === undefined) delete process.env.MOTIR_CLOUD;
  else process.env.MOTIR_CLOUD = env.cloud;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('fleetStatusPoolsService.readInstallFleet', () => {
  it('reads 1 running with its machine’s vCPU for an awake meta-org instance and a hosted run, and the CI runners on the install fleet', async () => {
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'ci_runner,agent_instance,hosted_agent';
    const meta = await tenant(true);
    const other = await tenant(false);
    // Two meta-org CI runners on the install fleet (MOTIR-11232) — a provisioning
    // one counts as in flight too. Not counted: a meta-org runner on a pool
    // account, a settled one, and another org's.
    const ciPool = await account('ci-iad-1', { fleetKind: 'ci_runner' });
    await ciJob(meta, null, { installFleet: true });
    await ciJob(meta, null, { installFleet: true, status: 'provisioning' });
    await ciJob(meta, ciPool.id);
    await ciJob(meta, null, { installFleet: true, status: 'completed' });
    await ciJob(other, null, { installFleet: true });
    await slot(meta, 'agent_instance');
    await slot(meta, 'hosted_agent');
    // Not the install fleet: another org, a slot placed on an account, an expired slot.
    const shard = await account('agent-iad-1', { fleetKind: 'hosted_agent' });
    await slot(other, 'hosted_agent');
    await slot(meta, 'hosted_agent', { shardId: shard.id });
    await slot(meta, 'agent_instance', { expiresAt: earlier(MIN) });
    // Hibernated on the install fleet counts beside, never in, the running figure.
    await instance(meta, 'running');
    await instance(meta, 'hibernated');
    await instance(meta, 'hibernated');
    await instance(meta, 'hibernated', { deleted: true });
    await instance(meta, 'hibernated', { flyApp: 'some-fly-app' });

    const block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(384) }),
    );

    expect(block.pools).toEqual([
      {
        fleetKind: 'ci_runner',
        enabled: true,
        running: 2,
        hibernated: null,
        machineVcpu: 2,
        vcpu: 4,
        sharePercent: 1,
        // CI Spot use (MOTIR-11729): the meta org's three booted install-fleet
        // runners, the settled one included; none recorded a capacity.
        ciSpot: {
          status: 'ok',
          windowDays: 7,
          setting: 'off',
          counts: { launched: 3, spot: 0, onDemand: 0, notRecorded: 3, interrupted: 0 },
          allFellBack: false,
        },
      },
      {
        fleetKind: 'hosted_agent',
        enabled: true,
        running: 1,
        hibernated: null,
        machineVcpu: 2,
        vcpu: 2,
        sharePercent: 1,
      },
      {
        fleetKind: 'agent_instance',
        enabled: true,
        running: 1,
        hibernated: 2,
        machineVcpu: 2,
        vcpu: 2,
        sharePercent: 1,
      },
    ]);
    expect(block.quota).toEqual({ status: 'ok', vcpu: 384, readAt: NOW.toISOString() });
    expect(block).toMatchObject({ usedVcpu: 8, percent: 2, nearQuota: false, leftVcpu: 376 });

    // One audit row, and the mark records WHEN only.
    const [audit, ...rest] = await audits();
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({
      targetKind: 'platform',
      targetId: 'fleet_pools.install',
      metadata: { quotaRead: true },
    });
    const mark = await adminDb.platformAwsRead.findUniqueOrThrow({
      where: { subject: QUOTA_SUBJECT },
    });
    expect(mark.readAt.toISOString()).toBe(NOW.toISOString());
    expect(JSON.stringify(mark)).not.toContain('384');
  });

  it('counts any org’s unplaced slots with cloud off, and only the kinds the install fleet takes', async () => {
    process.env.MOTIR_CLOUD = 'false';
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'hosted_agent, ci_runner, nonsense';
    const a = await tenant(false);
    const b = await tenant(false);
    await slot(a, 'hosted_agent');
    await slot(b, 'hosted_agent');
    await slot(a, 'agent_instance');
    await instance(a, 'hibernated');
    await ciJob(b, null, { installFleet: true });

    const block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(10) }),
    );
    expect(block.pools).toEqual([
      expect.objectContaining({ fleetKind: 'ci_runner', running: 1, vcpu: 2 }),
      expect.objectContaining({ fleetKind: 'hosted_agent', running: 2, vcpu: 4 }),
      { fleetKind: 'agent_instance', enabled: false },
    ]);
    expect(block).toMatchObject({ usedVcpu: 6, percent: 60, nearQuota: false, leftVcpu: 4 });
  });

  it('counts nothing on cloud with no meta org, and nothing is enabled with the variable unset', async () => {
    const plain = await tenant(false);
    await slot(plain, 'hosted_agent');
    let block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(32) }),
    );
    expect(block.pools.find((p) => p.fleetKind === 'hosted_agent')).toMatchObject({
      running: 0,
    });

    delete process.env.MOTIR_INSTALL_FLEET_KINDS;
    block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(32) }),
    );
    expect(block.pools.every((p) => !p.enabled)).toBe(true);
    expect(block).toMatchObject({ usedVcpu: 0, percent: 0, leftVcpu: 32 });
  });

  it('flags near the quota at 70%', async () => {
    const meta = await tenant(true);
    for (let i = 0; i < 4; i += 1) await slot(meta, 'hosted_agent');
    const block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(10) }),
    );
    expect(block).toMatchObject({ usedVcpu: 8, percent: 80, nearQuota: true, leftVcpu: 2 });
  });

  it('keeps the counts when AWS does not answer: the quota is Not read with its last read, every figure from it Not available', async () => {
    const meta = await tenant(true);
    await slot(meta, 'hosted_agent');

    // Never read: no last read.
    let block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: unanswered() }),
    );
    expect(block.quota).toEqual({ status: 'notRead', lastReadAt: null });

    // A good read, then one that fails: the last read is the good one's time.
    await service.readInstallFleet(currentPrincipal, {
      now: earlier(120 * MIN),
      reader: quota(64),
    });
    block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: unanswered() }),
    );
    expect(block.quota).toEqual({
      status: 'notRead',
      lastReadAt: earlier(120 * MIN).toISOString(),
    });
    expect(block.pools.find((p) => p.fleetKind === 'hosted_agent')).toMatchObject({
      running: 1,
      vcpu: 2,
      sharePercent: null,
    });
    expect(block).toMatchObject({ usedVcpu: 2, percent: null, nearQuota: false, leftVcpu: null });
    expect((await audits()).map((a) => a.metadata)).toEqual([
      { quotaRead: false },
      { quotaRead: true },
      { quotaRead: false },
    ]);
    // The failure is logged by its error NAME — never the message, which names an ARN.
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('arn:aws');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('AccessDeniedException');
  });

  it('is the block error when the records do not answer, and when the audited read fails', async () => {
    const { fleetInFlightSlotRepository } =
      await import('@/lib/repositories/fleetInFlightSlotRepository');
    const spy = vi
      .spyOn(fleetInFlightSlotRepository, 'countLiveUnplacedForWorkload')
      .mockRejectedValueOnce(new Error('connection reset'));
    expect(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(8) }),
    ).toEqual({ status: 'unavailable' });
    spy.mockRestore();

    const { platformAwsReadRepository } =
      await import('@/lib/repositories/platformAwsReadRepository');
    vi.spyOn(platformAwsReadRepository, 'markRead').mockRejectedValueOnce('not an error');
    expect(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(8) }),
    ).toEqual({ status: 'unavailable' });
  });

  it('is refused below superadmin, and reads nothing', async () => {
    currentPrincipal = { ...currentPrincipal, role: 'operator' };
    const reader = quota(8);
    await expect(
      service.readInstallFleet(currentPrincipal, { now: NOW, reader }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(service.readAddShard(currentPrincipal, { now: NOW })).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(reader.readStandardVcpuQuota).not.toHaveBeenCalled();
    expect(await audits()).toHaveLength(0);
  });
});

describe('judgeInstallBlock', () => {
  it('has no used vCPU when a running pool’s machine size is unknown', async () => {
    const installFleet = await import('@/lib/ciFleet/installFleet');
    vi.spyOn(installFleet, 'installFleetMachineVcpu').mockReturnValue(null);
    const block = judgeInstallBlock(
      { running: new Map([['hosted_agent', 3]]), hibernated: 0 },
      { status: 'ok', vcpu: 0, readAt: NOW.toISOString() },
    );
    expect(block.pools.find((p) => p.fleetKind === 'hosted_agent')).toMatchObject({
      running: 3,
      machineVcpu: null,
      vcpu: null,
      sharePercent: null,
    });
    expect(block).toMatchObject({
      usedVcpu: null,
      percent: null,
      nearQuota: false,
      leftVcpu: null,
    });
  });
});

describe('fleetStatusPoolsService.readAddShard', () => {
  it('sizes a pool by its active shared accounts’ ceilings and counts what runs on them', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await tenant(false);
    // 256 granted vCPU ÷ 2 per machine = 128 machines.
    const iad1 = await account('ci-iad-1', { granted: 256 });
    const iad2 = await account('ci-iad-2', {
      granted: 64,
      override: 64,
      pausedUntil: later(48 * MIN),
      pausedReason: 'capacity_refused',
    });
    // A pause that has passed is not shown.
    const iad3 = await account('ci-iad-3', {
      granted: 32,
      pausedUntil: earlier(MIN),
      pausedReason: 'provider_unavailable',
    });
    await account('ci-iad-spare', { granted: 256, role: 'spare' });
    for (let i = 0; i < 3; i += 1) await ciJob(fx, iad1.id);
    await ciJob(fx, iad2.id);
    void iad3;

    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    const pool = awsPool(block, 'ci_runner');

    expect(
      pool.accounts.map((a) => [a.name, a.role, a.sizeMachines, a.sizeSource, a.running]),
    ).toEqual([
      ['ci-iad-1', 'shared', 128, 'granted', 3],
      ['ci-iad-2', 'shared', 64, 'override', 1],
      ['ci-iad-3', 'shared', 16, 'granted', 0],
      ['ci-iad-spare', 'spare', 128, 'granted', 0],
    ]);
    const paused = pool.accounts.find((a) => a.name === 'ci-iad-2');
    expect(paused).toMatchObject({
      pausedUntil: later(48 * MIN).toISOString(),
      pausedReason: 'capacity_refused',
    });
    expect(pool.accounts.find((a) => a.name === 'ci-iad-3')).toMatchObject({
      pausedUntil: null,
      pausedReason: null,
    });
    expect(pool).toMatchObject({
      sharedCount: 3,
      spareNames: ['ci-iad-spare'],
      sizeMachines: 208,
      notReadCount: 0,
      running: 4,
      percent: 2,
      flag: null,
    });
    expect(okShard(block).nearCount).toBe(0);
    // Fly kinds pass through with no figures.
    expect(
      okShard(block)
        .pools.filter((p) => p.provider === 'fly')
        .map((p) => p.fleetKind),
    ).toEqual(['hosted_agent', 'agent_instance']);
    expect(throwing).not.toHaveBeenCalled();
  });

  it('says the machine limit sets an account’s size when it binds or no quota is read', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    // 256 granted ÷ 2 = 128, under a limit of 200: the quota binds.
    await account('ci-quota', { granted: 256, machineLimit: 200 });
    // 256 granted ÷ 2 = 128, over a limit of 40: the limit binds.
    await account('ci-limit', { granted: 256, machineLimit: 40 });
    // No quota read, only a limit.
    await account('ci-limit-only', { granted: null, machineLimit: 12 });

    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    expect(
      awsPool(block, 'ci_runner').accounts.map((a) => [
        a.name,
        a.sizeMachines,
        a.sizeSource,
        a.grantedVcpu,
      ]),
    ).toEqual([
      ['ci-quota', 128, 'granted', 256],
      ['ci-limit', 40, 'machineLimit', 256],
      ['ci-limit-only', 12, 'machineLimit', null],
    ]);
  });

  it('flags near size at 70% and at size at 100%', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    wireFleetKindSwitch('hosted_agent', () => true);
    const fx = await tenant(false);
    const ci = await account('ci-iad-1', { granted: 8 }); // 4 machines
    for (let i = 0; i < 4; i += 1) await ciJob(fx, ci.id);
    const agents = await account('agent-iad-1', { granted: 20, fleetKind: 'hosted_agent' }); // 10
    for (let i = 0; i < 7; i += 1) await slot(fx, 'hosted_agent', { shardId: agents.id });

    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    expect(awsPool(block, 'ci_runner')).toMatchObject({ percent: 100, flag: 'atSize' });
    expect(awsPool(block, 'hosted_agent')).toMatchObject({ percent: 70, flag: 'near' });
    expect(okShard(block).nearCount).toBe(2);
  });

  it('has no size with an account whose quota is not read, and none with no account', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    wireFleetKindSwitch('hosted_agent', () => true);
    await account('ci-iad-1', { granted: 64 });
    await account('ci-iad-2', { granted: null });
    // A disabled account and a provisioning one are shown but never sized in.
    await account('ci-iad-off', { granted: null, state: 'disabled' });

    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    const ci = awsPool(block, 'ci_runner');
    expect(ci).toMatchObject({ sizeMachines: null, notReadCount: 1, percent: null, flag: null });
    expect(ci.accounts.find((a) => a.name === 'ci-iad-2')).toMatchObject({
      sizeMachines: null,
      sizeSource: null,
      grantedVcpu: null,
    });
    expect(awsPool(block, 'hosted_agent')).toMatchObject({
      accounts: [],
      sharedCount: 0,
      spareNames: [],
      sizeMachines: null,
      running: 0,
      percent: null,
    });
  });

  it('marks one pool unavailable when its own read fails, and the block when the pools read fails', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    await account('ci-iad-1', { granted: 64 });
    const { fleetShardRepository } = await import('@/lib/repositories/fleetShardRepository');
    const listByRole = vi
      .spyOn(fleetShardRepository, 'listByRole')
      .mockRejectedValueOnce(new Error('timeout'));
    let block = okShard(await service.readAddShard(currentPrincipal, { now: NOW }));
    expect(block.pools[0]).toEqual({ fleetKind: 'ci_runner', provider: 'unavailable' });
    listByRole.mockRestore();

    vi.spyOn(platformFleetPoolsService, 'listPools').mockRejectedValueOnce(new Error('down'));
    expect(await service.readAddShard(currentPrincipal, { now: NOW })).toEqual({
      status: 'unavailable',
    });

    vi.spyOn(platformFleetPoolsService, 'listPools').mockResolvedValueOnce({
      blocks: [{ fleetKind: 'ci_runner', provider: 'unavailable' }],
    } as never);
    block = okShard(await service.readAddShard(currentPrincipal, { now: NOW }));
    expect(block.pools).toEqual([{ fleetKind: 'ci_runner', provider: 'unavailable' }]);
  });

  it('skips an account the pools read names but this read cannot find', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    await account('ci-iad-1', { granted: 64 });
    const { blocks } = await platformFleetPoolsService.listPools(currentPrincipal, NOW);
    const ci = blocks[0] as Extract<(typeof blocks)[number], { provider: 'aws' }>;
    vi.spyOn(platformFleetPoolsService, 'listPools').mockResolvedValueOnce({
      blocks: [
        {
          ...ci,
          accounts: [...ci.accounts, { ...ci.accounts[0]!, name: 'ci-gone' }],
          spares: [{ ...ci.accounts[0]!, name: 'ci-gone-spare' }],
        },
      ],
    } as never);
    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');
    expect(pool.accounts.map((a) => a.name)).toEqual(['ci-iad-1']);
    expect(pool).toMatchObject({ sharedCount: 1, spareNames: ['ci-gone-spare'], sizeMachines: 32 });
  });
});

// ── CI Spot use (MOTIR-11729; design MOTIR-11726) ─────────────────────────────

const DAY = 24 * 60 * MIN;
const NONE = { launched: 0, spot: 0, onDemand: 0, notRecorded: 0, interrupted: 0 };

async function spotSettingOn() {
  const { ciSpotSettingService } = await import('@/lib/services/ciSpotSettingService');
  return vi
    .spyOn(ciSpotSettingService, 'read')
    .mockResolvedValue({ enabled: true, instanceTypes: ['m7i.large'] });
}

describe('fleetStatusPoolsService.readAddShard — CI Spot use', () => {
  it('counts each account’s launches of the last 7 days by capacity across workspaces, and the pool is the sum of its accounts', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    // TWO workspaces: a read under either one's context would miss the other's.
    const a = await tenant(false);
    const b = await tenant(false);
    const iad1 = await account('ci-iad-1', { granted: 256 });
    const iad2 = await account('ci-iad-2', { granted: 64 });
    const spare = await account('ci-iad-spare', { granted: 64, role: 'spare' });
    await account('ci-iad-3', { granted: 64 });
    // ci-iad-1: Spot, on-demand and not recorded in workspace A; a Spot runner
    // EC2 reclaimed in workspace B. Out of the window: one booted 8 days ago,
    // one that never booted.
    await ciJob(a, iad1.id, { capacity: 'spot', status: 'completed' });
    await ciJob(a, iad1.id, { capacity: 'on_demand', bootedAt: earlier(6 * DAY) });
    await ciJob(a, iad1.id, { capacity: null });
    await ciJob(b, iad1.id, {
      capacity: 'spot',
      status: 'completed',
      teardownReason: 'spot_interrupted',
    });
    await ciJob(a, iad1.id, { capacity: 'spot', bootedAt: earlier(8 * DAY) });
    await ciJob(b, iad1.id, { capacity: 'spot', bootedAt: null, status: 'pending' });
    // ci-iad-2 and the spare launched in workspace B; an install-fleet runner
    // is no account's.
    await ciJob(b, iad2.id, { capacity: 'on_demand', teardownReason: 'job_completed' });
    await ciJob(b, spare.id, { capacity: 'spot' });
    await ciJob(a, null, { installFleet: true, capacity: 'spot' });

    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');

    expect(pool.accounts.map((acct) => [acct.name, acct.ciSpot])).toEqual([
      ['ci-iad-1', { launched: 4, spot: 2, onDemand: 1, notRecorded: 1, interrupted: 1 }],
      ['ci-iad-2', { launched: 1, spot: 0, onDemand: 1, notRecorded: 0, interrupted: 0 }],
      ['ci-iad-3', null],
      ['ci-iad-spare', { launched: 1, spot: 1, onDemand: 0, notRecorded: 0, interrupted: 0 }],
    ]);
    expect(pool.ciSpot).toEqual({
      status: 'ok',
      windowDays: 7,
      setting: 'off',
      counts: { launched: 6, spot: 3, onDemand: 2, notRecorded: 1, interrupted: 1 },
      allFellBack: false,
    });
    // The pool figure is the sum of its account rows.
    const sum = { ...NONE };
    for (const acct of pool.accounts) {
      for (const key of Object.keys(sum) as (keyof typeof sum)[])
        sum[key] += acct.ciSpot?.[key] ?? 0;
    }
    expect(pool.ciSpot).toMatchObject({ counts: sum });
    // The pool's own figures are as they were.
    expect(pool).toMatchObject({ sharedCount: 3, spareNames: ['ci-iad-spare'] });
  });

  it('reads a pool with no launch in the window as zero launches, each account a null', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await tenant(false);
    const iad1 = await account('ci-iad-1', { granted: 64 });
    await ciJob(fx, iad1.id, { capacity: 'spot', bootedAt: earlier(7 * DAY + MIN) });
    // A boot after `now` is outside `[now − 7 days, now]` too.
    await ciJob(fx, iad1.id, { capacity: 'spot', bootedAt: later(MIN) });

    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');
    expect(pool.ciSpot).toEqual({
      status: 'ok',
      windowDays: 7,
      setting: 'off',
      counts: NONE,
      allFellBack: false,
    });
    expect(pool.accounts.map((acct) => acct.ciSpot)).toEqual([null]);
  });

  it('is unavailable alone when the window count fails: the pool’s figures and the setting still read', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await tenant(false);
    const iad1 = await account('ci-iad-1', { granted: 64 });
    await ciJob(fx, iad1.id, { capacity: 'spot' });
    await spotSettingOn();
    const { ciRunnerProvisioningIntentRepository } =
      await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countCiSpotWindowByShardInTx',
    ).mockRejectedValueOnce(
      Object.assign(new Error('arn:aws:secret in a message'), {
        name: 'PrismaClientKnownRequestError',
      }),
    );

    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');
    expect(pool.ciSpot).toEqual({ status: 'unavailable', setting: 'on' });
    expect(pool).toMatchObject({ running: 1, sizeMachines: 32, percent: 3 });
    expect(pool.accounts).toHaveLength(1);
    expect(pool.accounts[0]).not.toHaveProperty('ciSpot');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(
      'PrismaClientKnownRequestError',
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('arn:aws');
  });

  it('reads the setting as notRead when it fails, and still returns the counts', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await tenant(false);
    const iad1 = await account('ci-iad-1', { granted: 64 });
    await ciJob(fx, iad1.id, { capacity: 'on_demand' });
    const { ciSpotSettingService } = await import('@/lib/services/ciSpotSettingService');
    vi.spyOn(ciSpotSettingService, 'read').mockRejectedValueOnce(new Error('connection reset'));

    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');
    expect(pool.ciSpot).toEqual({
      status: 'ok',
      windowDays: 7,
      setting: 'notRead',
      counts: { launched: 1, spot: 0, onDemand: 1, notRecorded: 0, interrupted: 0 },
      // Every launch on-demand, but nobody read Spot as on.
      allFellBack: false,
    });
  });

  it('says every launch fell back when Spot is on and none got Spot', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await tenant(false);
    const iad1 = await account('ci-iad-1', { granted: 64 });
    await ciJob(fx, iad1.id, { capacity: 'on_demand' });
    await ciJob(fx, iad1.id, { capacity: null });
    await spotSettingOn();

    const pool = awsPool(await service.readAddShard(currentPrincipal, { now: NOW }), 'ci_runner');
    expect(pool.ciSpot).toMatchObject({ status: 'ok', setting: 'on', allFellBack: true });
  });

  it('puts no ciSpot on a pool other than the CI runner’s', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    wireFleetKindSwitch('hosted_agent', () => true);
    await account('ci-iad-1', { granted: 64 });
    await account('agent-iad-1', { granted: 64, fleetKind: 'hosted_agent' });
    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    expect(awsPool(block, 'ci_runner')).toHaveProperty('ciSpot');
    const agents = awsPool(block, 'hosted_agent');
    expect(agents).not.toHaveProperty('ciSpot');
    expect(agents.accounts[0]).not.toHaveProperty('ciSpot');
  });
});

describe('judgeCiSpot', () => {
  const counts = { launched: 3, spot: 0, onDemand: 2, notRecorded: 1, interrupted: 0 };
  it.each([
    ['on', counts, true],
    ['off', counts, false],
    ['notRead', counts, false],
    ['on', NONE, false],
    ['on', { ...counts, spot: 1, launched: 4 }, false],
  ] as const)('setting %s with %o → allFellBack %s', (setting, c, expected) => {
    expect(judgeCiSpot(setting, c)).toEqual({
      status: 'ok',
      windowDays: 7,
      setting,
      counts: c,
      allFellBack: expected,
    });
  });
});

describe('fleetStatusPoolsService.readInstallFleet — CI Spot use', () => {
  it('counts the install fleet’s launches of the install’s own orgs, and no other pool carries it', async () => {
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'ci_runner,hosted_agent';
    const meta = await tenant(true);
    const other = await tenant(false);
    const shard = await account('ci-iad-1', { fleetKind: 'ci_runner' });
    await ciJob(meta, null, { installFleet: true, capacity: 'spot', status: 'completed' });
    await ciJob(meta, null, {
      installFleet: true,
      capacity: 'spot',
      status: 'completed',
      teardownReason: 'spot_interrupted',
    });
    await ciJob(meta, null, { installFleet: true, capacity: 'on_demand', status: 'completed' });
    // Not counted: another org's, an account's, one booted 8 days ago.
    await ciJob(other, null, { installFleet: true, capacity: 'spot' });
    await ciJob(meta, shard.id, { capacity: 'spot' });
    await ciJob(meta, null, { installFleet: true, capacity: 'spot', bootedAt: earlier(8 * DAY) });
    await spotSettingOn();

    const block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(64) }),
    );
    expect(block.pools.find((p) => p.fleetKind === 'ci_runner')).toMatchObject({
      enabled: true,
      ciSpot: {
        status: 'ok',
        windowDays: 7,
        setting: 'on',
        counts: { launched: 3, spot: 2, onDemand: 1, notRecorded: 0, interrupted: 1 },
        allFellBack: false,
      },
    });
    expect(block.pools.find((p) => p.fleetKind === 'hosted_agent')).not.toHaveProperty('ciSpot');
  });

  it('is unavailable alone when the count fails, and absent when the install fleet takes no CI runner', async () => {
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'ci_runner';
    const meta = await tenant(true);
    await ciJob(meta, null, { installFleet: true, capacity: 'spot' });
    const { ciRunnerProvisioningIntentRepository } =
      await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countCiSpotWindowOnInstallFleetInTx',
    ).mockRejectedValueOnce(new Error('timeout'));

    let block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(64) }),
    );
    expect(block.pools.find((p) => p.fleetKind === 'ci_runner')).toMatchObject({
      running: 1,
      vcpu: 2,
      ciSpot: { status: 'unavailable', setting: 'off' },
    });

    process.env.MOTIR_INSTALL_FLEET_KINDS = 'hosted_agent';
    block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(64) }),
    );
    expect(block.pools.every((p) => !('ciSpot' in p))).toBe(true);
  });

  it('settles the CI Spot read before answering an install block whose records did not read', async () => {
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'ci_runner';
    const { ciRunnerProvisioningIntentRepository } =
      await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countInFlightOnInstallFleetInTx',
    ).mockRejectedValueOnce(new Error('connection reset'));
    expect(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(8) }),
    ).toEqual({ status: 'unavailable' });
  });
});

describe('ciRunnerProvisioningIntentRepository — the CI Spot window count', () => {
  it('groups by account in one read, leaves an account with no launch absent, and answers an empty list without a query', async () => {
    const { ciRunnerProvisioningIntentRepository: repo } =
      await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
    const { withSystemContext } = await import('@/lib/workspaces/context');
    const fx = await tenant(false);
    const iad1 = await account('ci-iad-1');
    const iad2 = await account('ci-iad-2');
    const quiet = await account('ci-iad-3');
    await ciJob(fx, iad1.id, { capacity: 'spot', teardownReason: 'spot_interrupted' });
    await ciJob(fx, iad1.id, { capacity: 'spot', teardownReason: 'job_completed' });
    await ciJob(fx, iad2.id, { capacity: null, teardownReason: 'spot_interrupted' });

    const since = earlier(7 * DAY);
    const counts = await withSystemContext((tx) =>
      repo.countCiSpotWindowByShardInTx([iad1.id, iad2.id, quiet.id], since, NOW, tx),
    );
    expect(Object.fromEntries(counts)).toEqual({
      [iad1.id]: { launched: 2, spot: 2, onDemand: 0, notRecorded: 0, interrupted: 1 },
      [iad2.id]: { launched: 1, spot: 0, onDemand: 0, notRecorded: 1, interrupted: 1 },
    });
    expect(
      await withSystemContext((tx) => repo.countCiSpotWindowByShardInTx([], since, NOW, tx)),
    ).toEqual(new Map());
    // With cloud off the install-fleet read counts every org.
    await ciJob(fx, null, { installFleet: true, capacity: 'on_demand' });
    expect(
      await withSystemContext((tx) =>
        repo.countCiSpotWindowOnInstallFleetInTx(null, since, NOW, tx),
      ),
    ).toEqual({ launched: 1, spot: 0, onDemand: 1, notRecorded: 0, interrupted: 0 });
  });
});
