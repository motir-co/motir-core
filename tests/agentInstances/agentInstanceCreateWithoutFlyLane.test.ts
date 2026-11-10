import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import {
  AgentInstancesUnavailableError,
  AgentInstanceNotFoundError,
} from '@/lib/agentInstances/errors';
import { INSTALL_FLEET_SHARD_ID, INSTALL_FLEET_TAG } from '@/lib/ciFleet/installFleet';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { fakePersistentOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstancePlacementService } from '@/lib/services/agentInstancePlacementService';
import { adminDb } from '../helpers/adminDb';
import { fx, setUpHarness, tearDownHarness } from './_harness';

// CREATE NEVER ASKS THE FLY LANE IT DOES NOT PLACE ON (MOTIR-10801). Creating an
// agent instance resolved the process-wide persistent orchestrator for a default
// region before placement chose where the instance goes, and gated the whole
// lifecycle on `FLY_INSTANCES_API_TOKEN`. On an install with no Fly lane — a
// cloud-off install on the install fleet, or production once Fly is gone — every
// create threw, even one the placement would have put on the install fleet or an
// AWS hoster account. Now the region is the placement's, written with the handle,
// and the lane gate asks the placement's own reads.

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

async function seedHosterAccount(name: string, machineLimit = 10) {
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
      machineLimit,
    },
  });
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

const create = (name = 'yue-claude') =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);

beforeEach(async () => {
  await setUpHarness();
  resetShardFakes();
  wireFleetKindSwitch('agent_instance', null);
});

afterEach(async () => {
  wireFleetKindSwitch('agent_instance', null);
  resetShardFakes();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('create writes the placement’s region and never asks the process-wide lane for one', () => {
  it('on the install fleet: running, its region the install fleet’s, no default region read', async () => {
    stubInstallFleet();
    await makeInstallOrg();
    const defaultRegion = vi.spyOn(fleet, 'defaultRegion');

    const dto = await create();

    expect(dto.state).toBe('running');
    expect(dto.region).toBe(REGION);
    expect(await rowOf(dto.id)).toMatchObject({
      fleetShardId: null,
      flyApp: INSTALL_FLEET_TAG,
      region: REGION,
    });
    expect(fakePersistentOrchestratorForShard(INSTALL_FLEET_SHARD_ID).calls).toContain(
      'provisionPersistent',
    );
    expect(defaultRegion).not.toHaveBeenCalled();
  });

  it('on an AWS hoster account: its region the account’s, no default region read', async () => {
    const account = await seedHosterAccount('agent-hoster-eu');
    wireFleetKindSwitch('agent_instance', () => true);
    const defaultRegion = vi.spyOn(fleet, 'defaultRegion');

    const dto = await create();

    expect(dto.state).toBe('running');
    expect(await rowOf(dto.id)).toMatchObject({
      fleetShardId: account.id,
      availabilityZone: 'eu-west-1a',
      region: 'eu-west-1',
    });
    expect(defaultRegion).not.toHaveBeenCalled();
  });

  it('waiting for room: the row has no region until a placement writes one', async () => {
    const account = await seedHosterAccount('agent-hoster-full');
    await adminDb.fleetShard.update({
      where: { id: account.id },
      data: { admissionPausedUntil: new Date('2999-01-01T00:00:00Z') },
    });
    wireFleetKindSwitch('agent_instance', () => true);

    const dto = await create();

    expect(dto.state).toBe('starting');
    expect(dto.region).toBeNull();
    expect(await rowOf(dto.id)).toMatchObject({ machineId: null, region: null });
  });

  it('on the process-wide lane: the region its provision answered in', async () => {
    const dto = await create();
    expect(dto.state).toBe('running');
    expect((await rowOf(dto.id)).region).toBe(fleet.defaultRegion());
  });
});

describe('the lane gate asks the placement’s own reads, not only the Fly token', () => {
  // Off the fake with no Fly instances token: the process-wide lane is absent.
  function noFlyLane(): void {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', '');
  }

  // A lifecycle call past the gate reads the instance, and one that does not
  // exist answers not-found; refused AT the gate, it answers unavailable.
  const pastTheGate = () =>
    lifecycle.hibernate(fx.projectIdentifier, 'no-such-instance', fx.ctx).catch((e: unknown) => e);

  it('refuses with nothing to place on', async () => {
    noFlyLane();
    const orgId = fx.workspace.organizationId!;
    expect(await agentInstancePlacementService.placesOffProcessWideLane(orgId)).toBe(false);
    const err = await pastTheGate();
    expect(err).toBeInstanceOf(AgentInstancesUnavailableError);
    expect((err as Error).message).toMatch(/no instance fleet is configured/);
  });

  it('admits the install org when the install fleet takes agent hosts', async () => {
    noFlyLane();
    stubInstallFleet();
    await makeInstallOrg();
    expect(
      await agentInstancePlacementService.placesOffProcessWideLane(fx.workspace.organizationId!),
    ).toBe(true);
    expect(await pastTheGate()).toBeInstanceOf(AgentInstanceNotFoundError);
  });

  it('still refuses a tenant org the install fleet does not take, with the switch off', async () => {
    noFlyLane();
    stubInstallFleet();
    expect(await pastTheGate()).toBeInstanceOf(AgentInstancesUnavailableError);
  });

  it('admits any org while the agent hoster is on the AWS pool', async () => {
    noFlyLane();
    wireFleetKindSwitch('agent_instance', () => true);
    expect(
      await agentInstancePlacementService.placesOffProcessWideLane(fx.workspace.organizationId!),
    ).toBe(true);
    expect(await pastTheGate()).toBeInstanceOf(AgentInstanceNotFoundError);
  });

  it('admits every org while the Fly lane is configured, without reading the placement', async () => {
    const placement = vi.spyOn(agentInstancePlacementService, 'placesOffProcessWideLane');
    expect(await pastTheGate()).toBeInstanceOf(AgentInstanceNotFoundError);
    expect(placement).not.toHaveBeenCalled();
  });
});
