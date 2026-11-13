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

const { fleetStatusPoolsService: service, judgeInstallBlock } =
  await import('@/lib/services/fleetStatusPoolsService');
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
  options: { installFleet?: boolean; status?: string } = {},
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
      bootedAt: earlier(2 * MIN),
      startedAt: earlier(2 * MIN),
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
  process.env.MOTIR_INSTALL_FLEET_KINDS = 'code_graph_index,agent_instance,hosted_agent';
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
  for (const kind of ['ci_runner', 'hosted_agent', 'code_graph_index', 'agent_instance'] as const)
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
  it('reads 1 running with its machine’s vCPU for a meta-org index, an awake instance and a hosted run, and the CI runners on the install fleet', async () => {
    process.env.MOTIR_INSTALL_FLEET_KINDS =
      'ci_runner,code_graph_index,agent_instance,hosted_agent';
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
    await slot(meta, 'code_graph_index');
    await slot(meta, 'agent_instance');
    await slot(meta, 'hosted_agent');
    // Not the install fleet: another org, a slot placed on an account, an expired slot.
    const shard = await account('cgi-iad-1', { fleetKind: 'code_graph_index' });
    await slot(other, 'code_graph_index');
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
        fleetKind: 'code_graph_index',
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
    expect(block).toMatchObject({ usedVcpu: 10, percent: 3, nearQuota: false, leftVcpu: 374 });

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
    process.env.MOTIR_INSTALL_FLEET_KINDS = 'code_graph_index, ci_runner, nonsense';
    const a = await tenant(false);
    const b = await tenant(false);
    await slot(a, 'code_graph_index');
    await slot(b, 'code_graph_index');
    await slot(a, 'hosted_agent');
    await instance(a, 'hibernated');
    await ciJob(b, null, { installFleet: true });

    const block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(10) }),
    );
    expect(block.pools).toEqual([
      expect.objectContaining({ fleetKind: 'ci_runner', running: 1, vcpu: 2 }),
      { fleetKind: 'hosted_agent', enabled: false },
      expect.objectContaining({ fleetKind: 'code_graph_index', running: 2, vcpu: 4 }),
      { fleetKind: 'agent_instance', enabled: false },
    ]);
    expect(block).toMatchObject({ usedVcpu: 6, percent: 60, nearQuota: false, leftVcpu: 4 });
  });

  it('counts nothing on cloud with no meta org, and nothing is enabled with the variable unset', async () => {
    const plain = await tenant(false);
    await slot(plain, 'code_graph_index');
    let block = okInstall(
      await service.readInstallFleet(currentPrincipal, { now: NOW, reader: quota(32) }),
    );
    expect(block.pools.find((p) => p.fleetKind === 'code_graph_index')).toMatchObject({
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
    await slot(meta, 'code_graph_index');

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
    expect(block.pools.find((p) => p.fleetKind === 'code_graph_index')).toMatchObject({
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
      { running: new Map([['code_graph_index', 3]]), hibernated: 0 },
      { status: 'ok', vcpu: 0, readAt: NOW.toISOString() },
    );
    expect(block.pools.find((p) => p.fleetKind === 'code_graph_index')).toMatchObject({
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
    ).toEqual(['hosted_agent', 'code_graph_index', 'agent_instance']);
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
    wireFleetKindSwitch('code_graph_index', () => true);
    const fx = await tenant(false);
    const ci = await account('ci-iad-1', { granted: 8 }); // 4 machines
    for (let i = 0; i < 4; i += 1) await ciJob(fx, ci.id);
    const cgi = await account('cgi-iad-1', { granted: 20, fleetKind: 'code_graph_index' }); // 10
    for (let i = 0; i < 7; i += 1) await slot(fx, 'code_graph_index', { shardId: cgi.id });

    const block = await service.readAddShard(currentPrincipal, { now: NOW });
    expect(awsPool(block, 'ci_runner')).toMatchObject({ percent: 100, flag: 'atSize' });
    expect(awsPool(block, 'code_graph_index')).toMatchObject({ percent: 70, flag: 'near' });
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
