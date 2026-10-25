import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ec2Api, Ec2Instance, Ec2Tag, Ec2Volume } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
  HOSTER_VOLUME_KILL_NAME,
} from '@/lib/services/fleetAttributionService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// THE RECONCILER READS EVERY AGENT-HOSTER ACCOUNT (Story MOTIR-9361 · MOTIR-9476)
// against real Postgres. Each hoster account is an `AwsEc2Fake`, reached through
// the real composition root (`inventoryForShard` → `createEc2Api`, answered here
// by the account's access key id); the Fly side is the fake fleet inventory.
// Sentry is observed at its call.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here: the EC2 fake
// throws the source's `Ec2ApiError`, and the inventory types refusals by
// `instanceof`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance>;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string;
  plantVolume(volume?: Partial<Ec2Volume>): string;
  backdateVolume(volumeId: string, createTime: Date | null): void;
  liveInstanceIds(): string[];
  liveVolumeIds(): string[];
}

const world = vi.hoisted(() => ({ accounts: new Map<string, unknown>() }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  return {
    ...source,
    createEc2Api: (credentials: { accessKeyId: string }) =>
      world.accounts.get(credentials.accessKeyId),
  };
});

let AwsEc2Fake: new () => Ec2Fake;
const MINUTE = 60_000;
const NOW = Date.now();
const now = () => new Date(NOW + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);
const OLD = new Date(NOW - MINUTE);
const YOUNG = new Date(NOW + FLEET_ATTRIBUTION_GRACE_MS);
const MARKER = 'SECRET-MARKER-9476';

interface Account {
  id: string;
  name: string;
  ec2: Ec2Fake;
}

let seq = 0;
async function seedAccount(name: string, state = 'active'): Promise<Account> {
  seq += 1;
  const credentialRef = `FLEET_SHARD_HOSTER_${seq}`;
  const keyId = `AKIA-${name}`;
  vi.stubEnv(`${credentialRef}_ACCESS_KEY_ID`, keyId);
  vi.stubEnv(`${credentialRef}_SECRET_ACCESS_KEY`, MARKER);
  const ec2 = new AwsEc2Fake();
  world.accounts.set(keyId, ec2);
  const row = await adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: state as 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: `5555${String(seq).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef,
    },
  });
  return { id: row.id, name, ec2 };
}

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `hoster-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `H${randomInt(100, 1000)}`,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let instanceSeq = 0;
async function seedInstance(
  fx: Fixture,
  account: Account,
  values: {
    machineId: string | null;
    volumeId?: string | null;
    state?: 'running' | 'hibernated' | 'failed';
    deleted?: boolean;
  },
) {
  instanceSeq += 1;
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      ownerId: fx.userId,
      name: `agent-${instanceSeq}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      flyApp: account.name,
      machineId: values.machineId,
      volumeId: values.volumeId ?? null,
      region: 'us-east-1',
      fleetShardId: account.id,
      availabilityZone: 'us-east-1a',
      state: values.state ?? 'running',
      deletedAt: values.deleted ? new Date() : null,
    },
  });
}

const alerts = (): string[] => captureException.mock.calls.map(([err]) => (err as Error).message);
const alertNames = (): string[] => captureException.mock.calls.map(([err]) => (err as Error).name);

beforeEach(async () => {
  AwsEc2Fake ??= (await import(/* @vite-ignore */ paths.ec2Fake)).AwsEc2Fake;
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  world.accounts.clear();
  captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  wireFleetKindSwitch('agent_instance', null);
  await adminDb.fleetMachineKill.deleteMany({});
  await truncateAuthTables();
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  wireFleetKindSwitch('agent_instance', null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const reconcile = () => fleetAttributionService.reconcile({ now, listingRetryDelayMs: 0 });

describe('machines in every hoster account', () => {
  it('lists both accounts and the Fly app in one pass; an untracked, untagged machine is destroyed past the grace and a young one spared', async () => {
    const a = await seedAccount('agent-hoster-a');
    const b = await seedAccount('agent-hoster-b');
    const stray = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const young = b.ec2.plantInstance({ tags: [], launchTime: YOUNG });

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 2, spared: 1 });
    if (result.outcome !== 'reconciled') return;
    expect(result.killed).toEqual([
      { app: a.name, machineId: stray, reason: 'no_record', action: 'destroyed', workload: null },
    ]);
    expect(a.ec2.liveInstanceIds()).toEqual([]);
    expect(b.ec2.liveInstanceIds()).toEqual([young]);
    const [kill] = await adminDb.fleetMachineKill.findMany();
    expect(kill).toMatchObject({ app: a.name, machineId: stray, reason: 'no_record' });
    expect(kill!.completedAt).not.toBeNull();
    expect(alertNames()).toContain('UnattributedMachineDestroyedError');
    expect(alerts().find((m) => m.includes(stray))).toContain(`AWS instance ${stray}`);
  });

  it('a failed listing of one account alerts and skips only that account', async () => {
    const a = await seedAccount('agent-hoster-a');
    const b = await seedAccount('agent-hoster-b');
    const keptA = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const strayB = b.ec2.plantInstance({ tags: [], launchTime: OLD });
    a.ec2.failNext('describeInstances', 'UnauthorizedOperation', 403);

    const result = await reconcile();

    expect(result).toMatchObject({ unavailableApps: [a.name] });
    expect(a.ec2.liveInstanceIds()).toEqual([keptA]);
    expect(b.ec2.liveInstanceIds()).toEqual([]);
    expect(alerts().some((m) => m.includes(a.name) && m.includes('Nothing was destroyed'))).toBe(
      true,
    );
    expect((await adminDb.fleetMachineKill.findMany()).map((k) => k.machineId)).toEqual([strayB]);
  });

  it('judges by machine id AND account: live, resting, deleted and another account’s record', async () => {
    const fx = await seedTenant();
    const a = await seedAccount('agent-hoster-a');
    const b = await seedAccount('agent-hoster-b');
    const live = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const restingStopped = a.ec2.plantInstance({ tags: [], launchTime: OLD, state: 'stopped' });
    const restingRunning = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const ended = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const elsewhere = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    await seedInstance(fx, a, { machineId: live });
    await seedInstance(fx, a, { machineId: restingStopped, state: 'hibernated' });
    const resting = await seedInstance(fx, a, { machineId: restingRunning, state: 'failed' });
    await adminDb.agentInstance.update({
      where: { id: resting.id },
      data: { stateChangedAt: new Date(NOW - 2 * FLEET_ATTRIBUTION_GRACE_MS) },
    });
    await seedInstance(fx, a, { machineId: ended, deleted: true });
    // The same id recorded on account B's instance does not attribute A's machine.
    await seedInstance(fx, b, { machineId: elsewhere });

    const result = await reconcile();
    if (result.outcome !== 'reconciled') throw new Error(result.outcome);

    const byMachine = new Map(result.killed.map((k) => [k.machineId, k]));
    expect(byMachine.has(live)).toBe(false);
    expect(byMachine.has(restingStopped)).toBe(false);
    expect(byMachine.get(restingRunning)).toMatchObject({
      reason: 'record_ended',
      action: 'stopped',
    });
    expect(byMachine.get(ended)).toMatchObject({ reason: 'record_ended', action: 'destroyed' });
    expect(byMachine.get(elsewhere)).toMatchObject({ reason: 'no_record', action: 'destroyed' });
    expect(a.ec2.instances.get(restingRunning)!.state).toBe('stopped');
    expect(a.ec2.instances.get(live)!.state).toBe('running');
  });

  it('an undated machine is alerted and left; a failed record read leaves it running', async () => {
    const a = await seedAccount('agent-hoster-a');
    const undated = a.ec2.plantInstance({ tags: [], launchTime: null });
    const other = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const judge = vi
      .spyOn(fleetAttributionService, 'judge')
      .mockRejectedValueOnce(new Error('the database is gone'));

    const result = await reconcile();

    expect(result).toMatchObject({ undated: 1, failures: 1, killed: [] });
    expect(a.ec2.liveInstanceIds().sort()).toEqual([undated, other].sort());
    expect(alerts().some((m) => m.includes(undated) && m.includes('cannot be aged'))).toBe(true);
    judge.mockRestore();
  });
});

describe('disks in every hoster account', () => {
  it('destroys an unattached, aged disk no live instance names — and touches no other', async () => {
    const fx = await seedTenant();
    const a = await seedAccount('agent-hoster-a');
    const machine = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    await seedInstance(fx, a, { machineId: machine });
    const orphan = a.ec2.plantVolume({ createTime: OLD });
    const attached = a.ec2.plantVolume({ createTime: OLD, attachedInstanceId: machine });
    const owned = a.ec2.plantVolume({ createTime: OLD });
    await seedInstance(fx, a, { machineId: null, volumeId: owned, state: 'hibernated' });
    const ownedByDeleted = a.ec2.plantVolume({ createTime: OLD });
    await seedInstance(fx, a, { machineId: null, volumeId: ownedByDeleted, deleted: true });
    const young = a.ec2.plantVolume({ createTime: YOUNG });
    const undated = a.ec2.plantVolume();
    a.ec2.backdateVolume(undated, null);

    const result = await reconcile();

    expect(result).toMatchObject({ orphanedVolumesDestroyed: 2, undated: 1 });
    expect(a.ec2.liveVolumeIds().sort()).toEqual([attached, owned, young, undated].sort());
    const kills = await adminDb.fleetMachineKill.findMany({ orderBy: { machineId: 'asc' } });
    expect(kills.map((k) => k.machineId).sort()).toEqual([orphan, ownedByDeleted].sort());
    expect(kills[0]).toMatchObject({
      app: a.name,
      machineName: HOSTER_VOLUME_KILL_NAME,
      reason: 'no_record',
      workload: 'agent_instance',
    });
    expect(kills.every((k) => k.completedAt !== null)).toBe(true);
    expect(alertNames().filter((n) => n === 'UnattributedVolumeDestroyedError')).toHaveLength(2);
    expect(alerts().find((m) => m.includes(orphan))).toContain(
      `Destroyed EBS volume ${orphan} in ${a.name}`,
    );
    expect(alerts().some((m) => m.includes(undated) && m.includes('cannot be aged'))).toBe(true);
  });

  it('a home disk detached by this pass’s own machine kill waits for the next pass', async () => {
    const a = await seedAccount('agent-hoster-a');
    const machine = a.ec2.plantInstance({ tags: [], launchTime: OLD });
    const home = a.ec2.plantVolume({ createTime: OLD, attachedInstanceId: machine });

    await reconcile();
    expect(a.ec2.liveInstanceIds()).toEqual([]);
    expect(a.ec2.liveVolumeIds()).toEqual([home]);

    await reconcile();
    expect(a.ec2.liveVolumeIds()).toEqual([]);
  });

  it('a failed disk listing deletes nothing and is alerted; a refused delete is recorded failed', async () => {
    const a = await seedAccount('agent-hoster-a');
    const orphan = a.ec2.plantVolume({ createTime: OLD });
    a.ec2.failNext('describeVolumes', 'UnauthorizedOperation', 403);
    expect(await reconcile()).toMatchObject({ failures: 1, orphanedVolumesDestroyed: 0 });
    expect(a.ec2.liveVolumeIds()).toEqual([orphan]);
    expect(alerts().some((m) => m.includes(`${a.name} volumes`))).toBe(true);

    a.ec2.failNext('deleteVolume', 'InternalError', 500);
    expect(await reconcile()).toMatchObject({ failures: 1, orphanedVolumesDestroyed: 0 });
    const [kill] = await adminDb.fleetMachineKill.findMany();
    expect(kill).toMatchObject({ machineId: orphan, completedAt: null });
    expect(kill!.failureDetail).not.toBeNull();
  });
});

describe('which accounts a pass reads', () => {
  it('reads the hoster accounts with the switch off and on, with the same result', async () => {
    const a = await seedAccount('agent-hoster-a');
    for (const on of [false, true]) {
      wireFleetKindSwitch('agent_instance', () => on);
      const stray = a.ec2.plantInstance({ tags: [], launchTime: OLD });
      const result = await reconcile();
      expect(result).toMatchObject({ accounts: 1, killed: [{ machineId: stray }] });
    }
  });

  it('reads a hoster account in any state; one with missing credentials is skipped with an alert', async () => {
    const provisioning = await seedAccount('agent-hoster-new', 'provisioning');
    const disabled = await seedAccount('agent-hoster-old', 'disabled');
    const straysOf = [provisioning, disabled].map((acct) =>
      acct.ec2.plantInstance({ tags: [], launchTime: OLD }),
    );
    await adminDb.fleetShard.create({
      data: {
        name: 'agent-hoster-unkeyed',
        fleetKind: 'agent_instance',
        provider: 'aws',
        state: 'active',
        githubOrg: 'motir-co',
        githubInstallationId: '556677',
        awsAccountId: '555599999999',
        awsRegion: 'us-east-1',
        credentialRef: 'FLEET_SHARD_HOSTER_UNKEYED',
      },
    });

    const result = await reconcile();

    expect(result).toMatchObject({ accounts: 2 });
    if (result.outcome !== 'reconciled') return;
    expect(result.killed.map((k) => k.machineId).sort()).toEqual([...straysOf].sort());
    expect(
      alerts().some(
        (m) => m.includes('agent-hoster-unkeyed') && m.includes('FLEET_SHARD_HOSTER_UNKEYED'),
      ),
    ).toBe(true);
  });

  it('no alert or kill row carries a credential value', async () => {
    const fx = await seedTenant();
    const a = await seedAccount('agent-hoster-a');
    a.ec2.plantInstance({ tags: [{ key: 'Name', value: 'by-hand' }], launchTime: OLD });
    a.ec2.plantVolume({ createTime: OLD });
    await seedInstance(fx, a, { machineId: null });
    await reconcile();
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills).toHaveLength(2);
    expect(JSON.stringify(kills)).not.toContain(MARKER);
    expect(JSON.stringify(captureException.mock.calls)).not.toContain(MARKER);
    expect(alerts().join('\n')).not.toContain(MARKER);
  });
});
