import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { AgentInstancesUnavailableError } from '@/lib/agentInstances/errors';
import { imageCatalog, imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import {
  INSTALL_FLEET_SHARD_ID,
  INSTALL_FLEET_TAG,
  isOnInstallFleet,
} from '@/lib/ciFleet/installFleet';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { fakePersistentOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import {
  agentInstanceLaneMissing,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService as runs } from '@/lib/services/agentInstanceRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// AN AGENT OFF THE FLY LANE IS REACHED WITHOUT A FLY TOKEN (MOTIR-10803). After
// MOTIR-10801 an install with no Fly lane creates its agents on the install fleet
// or an AWS hoster account. Two paths still read "no Fly instances token" as "no
// lane": the run start refused an install-fleet agent with "an agent cannot be
// reached to start a run", and the agent list answered every agent's image
// version and update offer as unknown. Both now ask where the ROW is hosted.
//
// The Fly token being unset is modelled at the one switch both paths read,
// `isPersistentOrchestratorConfigured`, so the install fleet and the accounts stay
// on their fakes. Off the fake, the install fleet's orchestrator is real AWS.

const lane = vi.hoisted(() => ({ configured: null as boolean | null }));
vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orchestrator')>();
  return {
    ...real,
    isPersistentOrchestratorConfigured: () =>
      lane.configured ?? real.isPersistentOrchestratorConfigured(),
  };
});

/** The deployment has no Fly instances token from here on. */
const noFlyLane = () => {
  lane.configured = false;
};

const MASTER = 'm'.repeat(48);
const REGION = 'us-east-1';

function stubInstallFleet(): void {
  vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'agent_instance');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SUBNET_IDS', 'subnet-a,subnet-b');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID', 'sg-install');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
    'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', REGION);
}

/** The fixture's organisation becomes the install's own (the meta org on cloud). */
async function makeInstallOrg(): Promise<void> {
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId! },
    data: { isMeta: true },
  });
}

async function seedHosterAccount(name: string) {
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: '444400000001',
      awsRegion: 'eu-west-1',
      credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
      machineLimit: 10,
    },
  });
}

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') return ok();
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: 'signed_in' })}\n`);
  }
  if (line.includes('motir agent-terminal run ')) return ok('{"session":"sess-1"}\n');
  return ok();
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const execsOn = (shardId: string) =>
  fakePersistentOrchestratorForShard(shardId).calls.filter((c) => c === 'exec').length;

async function createAgent(name = 'yue-claude'): Promise<string> {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
}

async function installFleetAgent(): Promise<string> {
  stubInstallFleet();
  await makeInstallOrg();
  const id = await createAgent();
  expect(await rowOf(id)).toMatchObject({ fleetShardId: null, flyApp: INSTALL_FLEET_TAG });
  return id;
}

const card = () =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'a card' },
    fx.ctx,
  );

const start = async (agentInstanceId: string) =>
  runs.start({ workItemKey: (await card()).identifier, agentInstanceId }, fx.ctx);

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  lane.configured = null;
  imageCatalogSeam.reset();
  resetShardFakes();
  wireFleetKindSwitch('agent_instance', null);
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
});

afterEach(async () => {
  vi.restoreAllMocks();
  lane.configured = null;
  wireFleetKindSwitch('agent_instance', null);
  imageCatalogSeam.reset();
  resetShardFakes();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('which rows are out of reach without the Fly lane', () => {
  it('only a row on the process-wide lane, and only while that lane is not configured', () => {
    const processWide = { fleetShardId: null, flyApp: 'motir-instances' };
    const unplaced = { fleetShardId: null, flyApp: null };
    const installFleet = { fleetShardId: null, flyApp: INSTALL_FLEET_TAG };
    const onAccount = { fleetShardId: 'shard-1', flyApp: INSTALL_FLEET_TAG };

    expect(isOnInstallFleet(installFleet)).toBe(true);
    expect(isOnInstallFleet(onAccount)).toBe(false);
    expect(isOnInstallFleet(processWide)).toBe(false);
    expect(isOnInstallFleet({ fleetShardId: null })).toBe(false);

    for (const row of [processWide, unplaced, installFleet, onAccount]) {
      expect(agentInstanceLaneMissing(row)).toBe(false);
    }
    noFlyLane();
    expect(agentInstanceLaneMissing(processWide)).toBe(true);
    expect(agentInstanceLaneMissing(unplaced)).toBe(true);
    expect(agentInstanceLaneMissing(installFleet)).toBe(false);
    expect(agentInstanceLaneMissing(onAccount)).toBe(false);
  });
});

describe('a run starts on an agent off the Fly lane with no Fly token', () => {
  it('on the install fleet: opened, and launched through the install fleet', async () => {
    const id = await installFleetAgent();
    noFlyLane();

    const { dispatchRunId, created } = await start(id);

    expect(created).toBe(true);
    const before = execsOn(INSTALL_FLEET_SHARD_ID);
    expect(await runs.launchNow(dispatchRunId)).toBe('launched');
    expect(execsOn(INSTALL_FLEET_SHARD_ID)).toBeGreaterThan(before);
  });

  it('on an AWS hoster account: opened', async () => {
    await seedHosterAccount('agent-hoster-eu');
    wireFleetKindSwitch('agent_instance', () => true);
    const id = await createAgent();
    noFlyLane();

    expect((await start(id)).created).toBe(true);
  });

  it('on the process-wide lane: still refused, with nothing opened', async () => {
    const id = await createAgent();
    noFlyLane();

    await expect(start(id)).rejects.toThrow(
      new AgentInstancesUnavailableError('an agent cannot be reached to start a run'),
    );
    expect(await adminDb.dispatchRun.count({ where: { agentInstanceId: id } })).toBe(0);
  });
});

describe('the agent list asks the image catalog for every agent it can reach', () => {
  /** An agent on the process-wide lane, written straight to the table. */
  async function seedProcessWideAgent(name: string, imageDigest: string): Promise<void> {
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId!,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name,
        profileId: 'claude',
        imageTag: sandboxImageTag('claude'),
        imageDigest,
        region: 'iad',
        state: 'hibernated',
      },
    });
  }

  const list = async () =>
    new Map(
      (await lifecycle.list(fx.projectIdentifier, { take: 50, skip: 0 }, fx.ctx)).instances.map(
        (i) => [i.name, i],
      ),
    );

  it('an install-fleet agent gets its update offer; a Fly-lane agent reads unknown, unasked', async () => {
    const id = await installFleetAgent();
    const installDigest = (await rowOf(id)).imageDigest;
    const flyDigest = `sha256:${'f'.repeat(64)}`;
    await seedProcessWideAgent('on-fly', flyDigest);
    noFlyLane();
    const offer = { version: '9.9.9', digest: `sha256:${'9'.repeat(64)}` };
    const updateFor = vi
      .spyOn(imageCatalog, 'updateFor')
      .mockResolvedValue({ imageVersion: '9.0.0', update: offer });

    const rows = await list();

    expect(rows.get('yue-claude')).toMatchObject({ update: offer });
    expect(rows.get('yue-claude')?.imageVersion).not.toBeNull();
    expect(rows.get('on-fly')).toMatchObject({ imageVersion: null, update: 'unknown' });
    expect(updateFor).toHaveBeenCalledWith('claude', installDigest);
    expect(updateFor).not.toHaveBeenCalledWith('claude', flyDigest);
  });

  it('a deployment with no reachable agent asks the catalog nothing', async () => {
    await seedProcessWideAgent('on-fly', `sha256:${'f'.repeat(64)}`);
    noFlyLane();
    const updateFor = vi.spyOn(imageCatalog, 'updateFor');

    expect((await list()).get('on-fly')).toMatchObject({ update: 'unknown' });
    expect(updateFor).not.toHaveBeenCalled();
  });
});
