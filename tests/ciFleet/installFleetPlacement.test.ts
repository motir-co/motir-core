import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorNotConfiguredError,
  type FleetWorkloadKind,
  type PersistentContainerHandle,
  type PersistentContainerOrchestrator,
  type PersistentContainerSpec,
} from '@motir/orchestrator';
import type { AgentInstance, FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import {
  INSTALL_FLEET_SHARD_ID,
  INSTALL_FLEET_TAG,
  installFleetConfig,
  installFleetKinds,
  isInstallFleetEnabled,
  isInstallFleetShardId,
  isInstallOrganization,
} from '@/lib/ciFleet/installFleet';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { agentInstancePlacementService } from '@/lib/services/agentInstancePlacementService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { resetShardFakes } from '@/lib/orchestrator';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE INSTALL FLEET'S PLACEMENT (Story MOTIR-10792 · MOTIR-10794), against real
// Postgres: a job of the install's own org — the meta org on cloud, any org with
// cloud off — for the index, the agent host or the agent run is placed on the
// install fleet before any pool choice and with no `fleet_shard` read; every
// other org's job, and every CI job, is placed exactly as before; an unset or
// unlisted kind changes nothing; and the database admits one meta org.

const NOW = new Date('2026-11-09T12:00:00.000Z');
const INSTALL_KINDS: FleetWorkloadKind[] = ['code_graph_index', 'agent_instance', 'hosted_agent'];
const ALL_KINDS: FleetWorkloadKind[] = [...INSTALL_KINDS, 'ci_runner'];

let seq = 0;

interface Fixture {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
}

async function seedOrg(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const tag = `${seq++}-${randomUUID().slice(0, 6)}`;
  const owner = await adminDb.user.create({
    data: { name: 'Owner', email: `install-${tag}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `org ${tag}`, slug: `org-${tag}`, isMeta: options.isMeta ?? false },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `ws ${tag}`, slug: `ws-${tag}`, organizationId: org.id },
  });
  const project = await adminDb.project.create({
    data: { name: `P ${tag}`, slug: `p-${tag}`, identifier: `IF${seq}`, workspaceId: workspace.id },
  });
  return {
    organizationId: org.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
  };
}

/** A shared AWS account of a kind, with room. */
async function shared(fleetKind: FleetWorkloadKind): Promise<FleetShard> {
  const slug = `${seq++}${randomUUID().slice(0, 4)}`;
  return adminDb.fleetShard.create({
    data: {
      name: `shared-${slug}`,
      fleetKind,
      provider: 'aws',
      role: 'primary',
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      awsAccountId: `3333${String(seq).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
      vcpuQuota: 640,
    },
  });
}

const choose = (fleetKind: FleetWorkloadKind, organizationId: string) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind, organizationId }, NOW, tx),
  );

const onPool = () => {
  for (const kind of ALL_KINDS) wireFleetKindSwitch(kind, async () => true);
};

/** Every `fleet_shard` read the placement could make. */
function spyShardReads() {
  return [
    vi.spyOn(fleetShardRepository, 'listActiveForKindInTx'),
    vi.spyOn(fleetShardRepository, 'findLiveOrgOwnedInTx'),
    vi.spyOn(fleetShardRepository, 'findById'),
  ];
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_KINDS',
    'code_graph_index, agent_instance,hosted_agent,ci_runner',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_SUBNET_IDS', 'subnet-a,subnet-b');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID', 'sg-install');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
    'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', 'us-east-1');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
});

afterEach(async () => {
  for (const kind of ALL_KINDS) wireFleetKindSwitch(kind, null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the install fleet module', () => {
  it('lists only the three kinds it can run, and none when unset', () => {
    expect([...installFleetKinds()].sort()).toEqual([...INSTALL_KINDS].sort());
    expect(isInstallFleetEnabled()).toBe(true);
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'ci_runner, nonsense');
    expect(installFleetKinds().size).toBe(0);
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', '');
    expect(isInstallFleetEnabled()).toBe(false);
  });

  it('reads its network, profile and region, and names every missing variable at once', () => {
    expect(installFleetConfig()).toEqual({
      region: 'us-east-1',
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupId: 'sg-install',
      instanceProfileArn: 'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
    });
    for (const name of [
      'MOTIR_INSTALL_FLEET_SUBNET_IDS',
      'MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID',
      'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
      'MOTIR_INSTALL_FLEET_REGION',
    ]) {
      vi.stubEnv(name, '');
    }
    // Unset reads as blank.
    vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', undefined);
    expect(() => installFleetConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => installFleetConfig()).toThrow(
      /MOTIR_INSTALL_FLEET_SUBNET_IDS, MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID, MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN, MOTIR_INSTALL_FLEET_REGION/,
    );
  });

  it('knows its pseudo-account id and the install org', () => {
    expect(isInstallFleetShardId(INSTALL_FLEET_SHARD_ID)).toBe(true);
    expect(isInstallFleetShardId('cmshard000')).toBe(false);
    expect(isInstallFleetShardId(null)).toBe(false);
    expect(isInstallOrganization({ isMeta: true })).toBe(true);
    expect(isInstallOrganization({ isMeta: false })).toBe(false);
    expect(isInstallOrganization(null)).toBe(false);
    vi.stubEnv('MOTIR_CLOUD', '');
    expect(isInstallOrganization({ isMeta: false })).toBe(true);
  });
});

describe('a meta-org job on cloud', () => {
  it.each(INSTALL_KINDS)(
    '%s is placed on the install fleet with no fleet_shard read, whatever the switch says',
    async (kind) => {
      const meta = await seedOrg({ isMeta: true });
      await shared(kind);
      const reads = spyShardReads();

      expect(await choose(kind, meta.organizationId)).toEqual({
        shardId: null,
        installFleet: true,
      });
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(
        await withSystemContext((tx) =>
          fleetShardAdmissionService.outsideSharedCapsInTx(
            { fleetKind: kind, organizationId: meta.organizationId },
            tx,
          ),
        ),
      ).toBe(true);
    },
  );

  it('a meta-org CI job goes to the pool as before, even with ci_runner listed', async () => {
    onPool();
    const meta = await seedOrg({ isMeta: true });
    const pool = await shared('ci_runner');
    expect(await choose('ci_runner', meta.organizationId)).toEqual({ shardId: pool.id });
  });

  it.each(INSTALL_KINDS)('a tenant %s job goes to the pool as before', async (kind) => {
    onPool();
    await seedOrg({ isMeta: true });
    const tenant = await seedOrg();
    const pool = await shared(kind);
    expect(await choose(kind, tenant.organizationId)).toEqual({ shardId: pool.id });
    expect(
      await withSystemContext((tx) =>
        fleetShardAdmissionService.outsideSharedCapsInTx(
          { fleetKind: kind, organizationId: tenant.organizationId },
          tx,
        ),
      ),
    ).toBe(false);
  });
});

describe('with cloud off', () => {
  it.each(INSTALL_KINDS)("every org's %s job is placed on the install fleet", async (kind) => {
    vi.stubEnv('MOTIR_CLOUD', '');
    onPool();
    const org = await seedOrg();
    await shared(kind);
    const reads = spyShardReads();
    expect(await choose(kind, org.organizationId)).toEqual({ shardId: null, installFleet: true });
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  it('a CI job is still placed as before', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    const org = await seedOrg();
    expect(await choose('ci_runner', org.organizationId)).toEqual({ shardId: null });
  });
});

describe('with the kinds unset or a kind not listed, placement is unchanged', () => {
  it.each(INSTALL_KINDS)('unset: a meta-org %s job takes the pool', async (kind) => {
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', '');
    onPool();
    const meta = await seedOrg({ isMeta: true });
    const pool = await shared(kind);
    expect(await choose(kind, meta.organizationId)).toEqual({ shardId: pool.id });
  });

  it('a kind not listed takes the pool while a listed one takes the install fleet', async () => {
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'hosted_agent');
    onPool();
    const meta = await seedOrg({ isMeta: true });
    const pool = await shared('code_graph_index');
    expect(await choose('code_graph_index', meta.organizationId)).toEqual({ shardId: pool.id });
    expect(await choose('hosted_agent', meta.organizationId)).toEqual({
      shardId: null,
      installFleet: true,
    });
  });

  it('with the switch off and nothing listed, the answer is still Fly', async () => {
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', '');
    const meta = await seedOrg({ isMeta: true });
    expect(await choose('hosted_agent', meta.organizationId)).toEqual({ shardId: null });
  });
});

describe('the index admission', () => {
  const request = (fx: Fixture, dispatchId: string, repoRef = 'motir-co/motir-core') => ({
    projectId: fx.projectId,
    repoRef,
    dispatchId,
    workspaceId: fx.workspaceId,
    organizationId: fx.organizationId,
    containerTimeoutMs: 600_000,
  });

  it('admits a meta-org index onto the install fleet, with a slot on no account and outside the global cap', async () => {
    onPool();
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const meta = await seedOrg({ isMeta: true });
    const tenant = await seedOrg();
    const pool = await shared('code_graph_index');

    const first = await codeGraphIndexAdmissionService.admit(request(meta, 'd-1'), NOW);
    expect(first.outcome).toBe('admitted');
    if (first.outcome !== 'admitted') return;
    expect(first.admission).toMatchObject({ shardId: null, installFleet: true });
    expect(first.admission.detail).toContain('on the install fleet');
    const slot = await adminDb.fleetInFlightSlot.findFirstOrThrow({
      where: { organizationId: meta.organizationId },
    });
    expect(slot.fleetShardId).toBeNull();

    // A replay of the same dispatch is told the same place.
    const replay = await codeGraphIndexAdmissionService.admit(request(meta, 'd-1'), NOW);
    expect(replay).toMatchObject({
      outcome: 'already_held',
      admission: { shardId: null, installFleet: true },
    });
    // Another dispatch of the same repo waits for it.
    expect((await codeGraphIndexAdmissionService.admit(request(meta, 'd-2'), NOW)).outcome).toBe(
      'deferred',
    );

    // The global cap is 1 and the meta org holds one index: a tenant's still
    // fits, on the pool, because the install fleet's slot is not counted.
    const other = await codeGraphIndexAdmissionService.admit(request(tenant, 'd-3'), NOW);
    expect(other).toMatchObject({ outcome: 'admitted', admission: { shardId: pool.id } });
    expect(other.outcome === 'admitted' && other.admission.installFleet).toBeFalsy();
  });
});

describe('the agent run slot', () => {
  it('reserves a meta-org run on the install fleet, its slot on no account', async () => {
    onPool();
    const meta = await seedOrg({ isMeta: true });
    await shared('hosted_agent');
    const verdict = await fleetCeilingService.reserve(
      {
        workload: 'hosted_agent',
        ref: 'dispatch-1',
        ownerRef: 'run-1',
        organizationId: meta.organizationId,
        workspaceId: meta.workspaceId,
      },
      NOW,
    );
    expect(verdict).toMatchObject({
      outcome: 'reserved',
      fleetShardId: null,
      installFleet: true,
      pool: null,
    });
    const slot = await adminDb.fleetInFlightSlot.findFirstOrThrow({ where: { ref: 'dispatch-1' } });
    expect(slot.fleetShardId).toBeNull();
  });

  it("reserves a tenant's run on the pool as before", async () => {
    onPool();
    await seedOrg({ isMeta: true });
    const tenant = await seedOrg();
    const pool = await shared('hosted_agent');
    const verdict = await fleetCeilingService.reserve(
      {
        workload: 'hosted_agent',
        ref: 'dispatch-2',
        ownerRef: 'run-2',
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
      },
      NOW,
    );
    expect(verdict).toMatchObject({ outcome: 'reserved', fleetShardId: pool.id });
    expect(verdict.outcome === 'reserved' && verdict.installFleet).toBeFalsy();
  });
});

describe('the agent host', () => {
  function createInstance(f: Fixture): Promise<AgentInstance> {
    return withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.create(
        {
          workspaceId: f.workspaceId,
          organizationId: f.organizationId,
          projectId: f.projectId,
          ownerId: f.ownerId,
          name: `agent-${seq++}`,
          profileId: 'claude',
          imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
          imageDigest: 'sha256:' + 'a'.repeat(64),
          region: 'iad',
        },
        tx,
      ),
    );
  }

  function recordingOrchestrator() {
    const provisioned: PersistentContainerSpec[] = [];
    const destroyed: PersistentContainerHandle[] = [];
    const orchestrator = {
      provider: 'aws',
      async provisionPersistent(spec: PersistentContainerSpec) {
        provisioned.push(spec);
        return {
          provider: 'aws',
          app: INSTALL_FLEET_TAG,
          machineId: `i-install-${provisioned.length}`,
          volumeId: `vol-install-${provisioned.length}`,
          region: spec.region,
          createdAt: NOW,
        } satisfies PersistentContainerHandle;
      },
      async destroyPersistent(handle: PersistentContainerHandle) {
        destroyed.push(handle);
      },
    } as unknown as PersistentContainerOrchestrator;
    return { orchestrator, provisioned, destroyed };
  }

  const input = (f: Fixture, row: AgentInstance) => ({
    instanceId: row.id,
    organizationId: f.organizationId,
    workspaceId: f.workspaceId,
    spec: {
      orgId: f.organizationId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      instanceId: row.id,
      image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'a'.repeat(64),
      size: { cpuKind: 'shared' as const, cpus: 2, memoryMb: 8192 },
      env: {},
      volumeSizeGb: 20,
      mountPath: '/home/agent',
      terminal: null,
      idleCommand: null,
    },
  });

  it('places a meta-org instance on the install fleet, recording no account', async () => {
    const meta = await seedOrg({ isMeta: true });
    const row = await createInstance(meta);
    const install = recordingOrchestrator();
    const reads = spyShardReads();
    const outcome = await agentInstancePlacementService.placeAndProvision(input(meta, row), {
      persistentOrchestratorForShard: () => {
        throw new Error('no pool account');
      },
      processWideOrchestrator: () => {
        throw new Error('not Fly');
      },
      installFleetOrchestrator: () => install.orchestrator,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ outcome: 'install_fleet', availabilityZone: 'us-east-1a' });
    expect(install.provisioned[0]).toMatchObject({
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
    });
    for (const read of reads) expect(read).not.toHaveBeenCalled();

    const placed = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: row.id } });
    expect(placed).toMatchObject({
      fleetShardId: null,
      flyApp: INSTALL_FLEET_TAG,
      machineId: 'i-install-1',
      volumeId: 'vol-install-1',
      region: 'us-east-1',
      // The table admits a zone only beside an account; it served the provision.
      availabilityZone: null,
    });
    // Every later operation reaches it through the install fleet.
    const routed = await fleetShardOrchestratorService.persistentOrchestratorFor(placed);
    expect(routed).toBeDefined();
    expect((routed as unknown as { calls: string[] }).calls).toEqual([]);

    // A second placement of the same instance finds it placed and leaves nothing.
    const again = await agentInstancePlacementService.placeAndProvision(input(meta, row), {
      persistentOrchestratorForShard: () => {
        throw new Error('no pool account');
      },
      processWideOrchestrator: () => {
        throw new Error('not Fly');
      },
      installFleetOrchestrator: () => install.orchestrator,
    });
    expect(again).toEqual({
      outcome: 'install_fleet',
      availabilityZone: null,
      handle: null,
      placedElsewhere: true,
    });
    expect(install.destroyed).toHaveLength(1);
  });
});

describe('the database admits one meta org', () => {
  it('refuses a second isMeta organization, and takes any number of others', async () => {
    await seedOrg({ isMeta: true });
    await seedOrg();
    await seedOrg();
    await expect(seedOrg({ isMeta: true })).rejects.toMatchObject({ code: 'P2002' });
    expect(await withSystemContext((tx) => organizationIds(tx))).toHaveLength(1);
  });
});

async function organizationIds(
  tx: Parameters<Parameters<typeof withSystemContext>[0]>[0],
): Promise<string[]> {
  const { organizationRepository } = await import('@/lib/repositories/organizationRepository');
  return organizationRepository.listMetaIdsInTx(tx);
}
