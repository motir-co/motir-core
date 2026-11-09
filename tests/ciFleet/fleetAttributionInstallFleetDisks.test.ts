import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ec2Api, Ec2Instance, Ec2Tag, Ec2Volume } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { INSTALL_FLEET_TAG } from '@/lib/ciFleet/installFleet';
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

// THE INSTALL FLEET'S DISKS ARE SWEPT (MOTIR-10828) against real Postgres. The
// install fleet (MOTIR-10794) runs the meta org's agent hosts in core's OWN
// account, tagged `motir-shard=motir-install-fleet`, with no fleet account row.
// A provision that gives its machine back terminates it and leaves the home disk
// (`DeleteOnTermination: false`), and before this card no pass ever listed that
// account's disks: the process-wide lane skips the fleet's app, and the hoster
// disk pass ran only for an account row. Here the REAL composition root builds
// the install fleet's listing (`installFleetInventory` → `createEc2Api` on the
// default credential chain), answered by one in-memory EC2; Sentry is observed
// at its call.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here: the EC2 fake
// throws the source's `Ec2ApiError`, and the inventory types refusals by
// `instanceof`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

interface Ec2Fake extends Ec2Api {
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string;
  plantVolume(volume?: Partial<Ec2Volume>): string;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
  liveInstanceIds(): string[];
  liveVolumeIds(): string[];
}

const world = vi.hoisted(() => ({
  ec2: null as unknown,
  configs: [] as Array<Record<string, unknown>>,
}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  return {
    ...source,
    createEc2Api: (config: Record<string, unknown>) => {
      world.configs.push(config);
      return world.ec2;
    },
  };
});

let AwsEc2Fake: new () => Ec2Fake;
let ec2: Ec2Fake;
const MINUTE = 60_000;
const NOW = Date.now();
const now = () => new Date(NOW + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);
const OLD = new Date(NOW - MINUTE);
const YOUNG = new Date(NOW + FLEET_ATTRIBUTION_GRACE_MS);
const FLEET_TAGS: Ec2Tag[] = [{ key: 'motir-shard', value: INSTALL_FLEET_TAG }];

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `install-disk-${suffix}@example.com`,
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
    name: 'Meta',
    identifier: `I${randomInt(100, 1000)}`,
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
  values: {
    volumeId: string;
    machineId?: string | null;
    app?: string;
    fleetShardId?: string | null;
    state?: 'running' | 'hibernated';
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
      flyApp: values.app ?? INSTALL_FLEET_TAG,
      machineId: values.machineId ?? null,
      volumeId: values.volumeId,
      region: 'us-east-1',
      fleetShardId: values.fleetShardId ?? null,
      availabilityZone: values.fleetShardId ? 'us-east-1a' : null,
      state: values.state ?? 'hibernated',
      deletedAt: values.deleted ? new Date() : null,
    },
  });
}

async function seedHosterAccount(): Promise<string> {
  const row = await adminDb.fleetShard.create({
    data: {
      name: 'agent-hoster-elsewhere',
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: '555500000001',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_HOSTER_ELSEWHERE',
    },
  });
  return row.id;
}

const alerts = (): string[] => captureException.mock.calls.map(([err]) => (err as Error).message);
const alertNames = (): string[] => captureException.mock.calls.map(([err]) => (err as Error).name);

// Only the install fleet's listing is walked: no Fly organisation, no account rows.
const reconcile = () =>
  fleetAttributionService.reconcile({ now, inventory: null, accounts: [], listingRetryDelayMs: 0 });

beforeEach(async () => {
  AwsEc2Fake ??= (await import(/* @vite-ignore */ paths.ec2Fake)).AwsEc2Fake;
  ec2 = new AwsEc2Fake();
  world.ec2 = ec2;
  world.configs = [];
  // The real selector (not the fake), with no Fly lane and no fake EC2 seam.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', '');
  vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', '');
  vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'agent_instance');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SUBNET_IDS', 'subnet-install-a');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID', 'sg-install');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
    'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', 'us-east-1');
  captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await adminDb.fleetMachineKill.deleteMany({});
  await truncateAuthTables();
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the install fleet’s disks', () => {
  it('destroys an unattached, aged, tagged disk no live install-fleet instance names, recorded like a hoster account’s', async () => {
    const fx = await seedTenant();
    const machine = ec2.plantInstance({ tags: FLEET_TAGS, launchTime: OLD });
    await seedInstance(fx, { volumeId: 'vol-unused', machineId: machine, state: 'running' });
    // A provision that gave its machine back: the home disk stays, named by nothing.
    const leftover = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    const attached = ec2.plantVolume({
      createTime: OLD,
      tags: FLEET_TAGS,
      attachedInstanceId: machine,
    });
    const owned = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    await seedInstance(fx, { volumeId: owned });
    const ownedByDeleted = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    await seedInstance(fx, { volumeId: ownedByDeleted, deleted: true });
    const young = ec2.plantVolume({ createTime: YOUNG, tags: FLEET_TAGS });
    // Core's own account holds disks that are not the fleet's: never listed.
    const stranger = ec2.plantVolume({ createTime: OLD, tags: [] });

    const result = await reconcile();

    expect(result).toMatchObject({
      outcome: 'reconciled',
      accounts: 1,
      orphanedVolumesDestroyed: 2,
      failures: 0,
    });
    expect(ec2.liveVolumeIds().sort()).toEqual([attached, owned, young, stranger].sort());
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills.map((k) => k.machineId).sort()).toEqual([leftover, ownedByDeleted].sort());
    for (const kill of kills) {
      expect(kill).toMatchObject({
        app: INSTALL_FLEET_TAG,
        machineName: HOSTER_VOLUME_KILL_NAME,
        reason: 'no_record',
        action: 'destroyed',
        workload: 'agent_instance',
      });
      expect(kill.completedAt).not.toBeNull();
    }
    expect(alertNames().filter((n) => n === 'UnattributedVolumeDestroyedError')).toHaveLength(2);
    expect(alerts().find((m) => m.includes(leftover))).toContain(
      `Destroyed EBS volume ${leftover} in ${INSTALL_FLEET_TAG}`,
    );
    // Built on core's own identity: nothing assumed.
    expect(world.configs.every((c) => c.defaultCredentials === true)).toBe(true);
  });

  it('a record of the same disk id in another app or on a fleet account does not hold it', async () => {
    const fx = await seedTenant();
    const shardId = await seedHosterAccount();
    const onAccount = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    await seedInstance(fx, {
      volumeId: onAccount,
      app: 'agent-hoster-elsewhere',
      fleetShardId: shardId,
    });
    const inOtherApp = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    await seedInstance(fx, { volumeId: inOtherApp, app: 'motir-agents' });

    const result = await reconcile();

    expect(result).toMatchObject({ orphanedVolumesDestroyed: 2 });
    expect(ec2.liveVolumeIds()).toEqual([]);
  });

  it('a home disk detached by this pass’s own machine kill waits for the next pass', async () => {
    const machine = ec2.plantInstance({ tags: FLEET_TAGS, launchTime: OLD });
    const home = ec2.plantVolume({
      createTime: OLD,
      tags: FLEET_TAGS,
      attachedInstanceId: machine,
    });

    await reconcile();
    expect(ec2.liveInstanceIds()).toEqual([]);
    expect(ec2.liveVolumeIds()).toEqual([home]);

    await reconcile();
    expect(ec2.liveVolumeIds()).toEqual([]);
  });

  it('a failed disk listing deletes nothing and is alerted; a refused delete is recorded failed', async () => {
    const leftover = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    ec2.failNext('describeVolumes', 'UnauthorizedOperation', 403);
    expect(await reconcile()).toMatchObject({ failures: 1, orphanedVolumesDestroyed: 0 });
    expect(ec2.liveVolumeIds()).toEqual([leftover]);
    expect(alerts().some((m) => m.includes(`${INSTALL_FLEET_TAG} volumes`))).toBe(true);

    ec2.failNext('deleteVolume', 'InternalError', 500);
    expect(await reconcile()).toMatchObject({ failures: 1, orphanedVolumesDestroyed: 0 });
    const [kill] = await adminDb.fleetMachineKill.findMany();
    expect(kill).toMatchObject({ machineId: leftover, completedAt: null });
    expect(kill!.failureDetail).not.toBeNull();
  });

  it('a failed record read leaves the disk in place', async () => {
    const leftover = ec2.plantVolume({ createTime: OLD, tags: FLEET_TAGS });
    const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
    const read = vi
      .spyOn(agentInstanceRepository, 'findByVolumeInUnshardedApp')
      .mockRejectedValueOnce(new Error('the database is gone'));

    expect(await reconcile()).toMatchObject({ failures: 1, orphanedVolumesDestroyed: 0 });
    expect(ec2.liveVolumeIds()).toEqual([leftover]);
    expect(await adminDb.fleetMachineKill.count()).toBe(0);
    read.mockRestore();
  });
});
