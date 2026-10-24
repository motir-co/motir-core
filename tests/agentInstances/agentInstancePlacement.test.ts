import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  OrchestratorCapacityError,
  type PersistentContainerHandle,
  type PersistentContainerOrchestrator,
  type PersistentContainerSpec,
} from '@motir/orchestrator';
import type { AgentInstance, FleetShard } from '@/generated/prisma/client';
import { AgentInstancePlacementError } from '@/lib/agentInstances/errors';
import { fleetKindOnPool, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  agentInstancePlacementService as placement,
  placementZoneFor,
  type AgentInstancePlacementDeps,
  type AgentInstancePlacementInput,
} from '@/lib/services/agentInstancePlacementService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// WHERE A NEW AGENT INSTANCE LIVES (Story MOTIR-9361 · MOTIR-9471), against a
// real Postgres with a fake persistent orchestrator per account: the switch off
// is Fly as today; on, the account with most headroom, the next one on a
// capacity refusal, `pool_full` when none is left — never Fly — and a provider
// error that is not a capacity refusal fails the create without trying further.

const NOW = new Date('2026-10-24T21:00:00.000Z');

beforeEach(async () => {
  await truncateAuthTables();
  wireFleetKindSwitch('agent_instance', null);
  wireFleetKindSwitch('ci_runner', null);
});

afterEach(() => {
  wireFleetKindSwitch('agent_instance', null);
  wireFleetKindSwitch('ci_runner', null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Fixture {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
}

async function seedFixture(): Promise<Fixture> {
  const tag = `${seq++}-${randomUUID().slice(0, 6)}`;
  const owner = await adminDb.user.create({
    data: { name: 'Yue', email: `yue-${tag}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `moooon ${tag}`, slug: `moooon-${tag}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `moooon ${tag}`, slug: `ws-${tag}`, organizationId: org.id },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Motir ${tag}`,
      slug: `motir-${tag}`,
      identifier: `PP${seq}`,
      workspaceId: workspace.id,
    },
  });
  return {
    organizationId: org.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
  };
}

function createInstance(f: Fixture, name: string): Promise<AgentInstance> {
  return withWorkspaceServiceContext(f.workspaceId, (tx) =>
    agentInstanceRepository.create(
      {
        workspaceId: f.workspaceId,
        organizationId: f.organizationId,
        projectId: f.projectId,
        ownerId: f.ownerId,
        name,
        profileId: 'claude',
        imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
        imageDigest: 'sha256:' + 'a'.repeat(64),
        region: 'iad',
      },
      tx,
    ),
  );
}

async function seedShard(
  name: string,
  overrides: Partial<{ machineLimit: number; provider: 'aws' | 'fly'; fleetKind: string }> = {},
): Promise<FleetShard> {
  const provider = overrides.provider ?? 'aws';
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: overrides.fleetKind ?? 'agent_instance',
      provider,
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      ...(provider === 'aws'
        ? { awsAccountId: `2222${String(seq++).padStart(8, '0')}`, awsRegion: 'us-east-1' }
        : { flyOrg: 'motir', flyApp: `${name}-app`, flyRegion: 'iad' }),
      credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
      machineLimit: overrides.machineLimit ?? 10,
    },
  });
}

type Behaviour = 'ok' | 'capacity' | 'denied';

/** A fake persistent orchestrator for one account, recording what it was asked. */
function fakeAccount(name: string) {
  let behaviour: Behaviour = 'ok';
  let onProvision: (() => Promise<void>) | null = null;
  const provisioned: PersistentContainerSpec[] = [];
  const destroyed: PersistentContainerHandle[] = [];
  let n = 0;
  const orchestrator = {
    provider: 'aws',
    defaultRegion: () => 'us-east-1',
    async provisionPersistent(spec: PersistentContainerSpec) {
      provisioned.push(spec);
      if (onProvision) await onProvision();
      if (behaviour === 'capacity') {
        throw new OrchestratorCapacityError('aws', 400, 'out_of_stock', spec.availabilityZone);
      }
      if (behaviour === 'denied')
        throw new OrchestratorApiError('aws', 403, 'UnauthorizedOperation');
      n += 1;
      return {
        provider: 'aws',
        app: name,
        machineId: `i-${name}-${n}`,
        volumeId: `vol-${name}-${n}`,
        region: spec.region,
        createdAt: NOW,
      } satisfies PersistentContainerHandle;
    },
    async destroyPersistent(handle: PersistentContainerHandle) {
      destroyed.push(handle);
    },
  } as unknown as PersistentContainerOrchestrator;
  return {
    orchestrator,
    provisioned,
    destroyed,
    set(b: Behaviour) {
      behaviour = b;
    },
    beforeAnswer(fn: (() => Promise<void>) | null) {
      onProvision = fn;
    },
  };
}

function deps(accounts: Record<string, ReturnType<typeof fakeAccount>>) {
  const fly = fakeAccount('fly-process-wide');
  const value: AgentInstancePlacementDeps = {
    persistentOrchestratorForShard: (shard: FleetShardDTO) => {
      const account = accounts[shard.name];
      if (!account) throw new Error(`no fake for ${shard.name}`);
      return account.orchestrator;
    },
    flyOrchestrator: () => fly.orchestrator,
    now: () => NOW,
  };
  return { value, fly };
}

function inputFor(f: Fixture, row: AgentInstance): AgentInstancePlacementInput {
  return {
    instanceId: row.id,
    organizationId: f.organizationId,
    workspaceId: f.workspaceId,
    spec: {
      orgId: f.organizationId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      instanceId: row.id,
      image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'a'.repeat(64),
      size: FLEET_CONTAINER_SIZE,
      env: { MOTIR_INSTANCE_ID: row.id },
      volumeSizeGb: 10,
      mountPath: '/home/agent',
      terminal: null,
    },
  };
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

/** Fill an account with `count` live instances placed on it. */
async function fill(f: Fixture, shard: FleetShard, count: number) {
  for (let i = 0; i < count; i++) {
    const row = await createInstance(f, `filler-${shard.name}-${i}`);
    await adminDb.agentInstance.update({
      where: { id: row.id },
      data: { fleetShardId: shard.id, availabilityZone: 'us-east-1a' },
    });
  }
}

describe('the agent-hoster switch', () => {
  it('defaults to Fly and is separate from every other kind’s switch', async () => {
    expect(await fleetKindOnPool('agent_instance')).toBe(false);
    wireFleetKindSwitch('ci_runner', () => true);
    wireFleetKindSwitch('code_graph_index', () => true);
    expect(await fleetKindOnPool('agent_instance')).toBe(false);
    wireFleetKindSwitch('agent_instance', () => true);
    wireFleetKindSwitch('ci_runner', () => false);
    expect(await fleetKindOnPool('agent_instance')).toBe(true);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    wireFleetKindSwitch('code_graph_index', null);
  });
});

describe('placeAndProvision', () => {
  it('with the switch off provisions on the process-wide Fly app and records no account', async () => {
    const f = await seedFixture();
    await seedShard('agent-hoster-a');
    const a = fakeAccount('agent-hoster-a');
    const { value, fly } = deps({ 'agent-hoster-a': a });
    const row = await createInstance(f, 'yue-claude');

    const out = await placement.placeAndProvision(inputFor(f, row), value);
    expect(out).toMatchObject({ outcome: 'fly', handle: { app: 'fly-process-wide' } });
    expect(fly.provisioned).toHaveLength(1);
    expect(fly.provisioned[0]).toMatchObject({ region: 'us-east-1' });
    expect(fly.provisioned[0]).not.toHaveProperty('availabilityZone');
    expect(a.provisioned).toHaveLength(0);
    expect((await rowOf(row.id)).fleetShardId).toBeNull();
  });

  it('with the switch on, provisions on the account with most headroom and records it with the zone', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const small = await seedShard('agent-hoster-small', { machineLimit: 4 });
    const big = await seedShard('agent-hoster-big', { machineLimit: 4 });
    await fill(f, small, 2);
    const accounts = {
      'agent-hoster-small': fakeAccount('agent-hoster-small'),
      'agent-hoster-big': fakeAccount('agent-hoster-big'),
    };
    const { value, fly } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');

    const out = await placement.placeAndProvision(inputFor(f, row), value);
    expect(out).toMatchObject({
      outcome: 'aws',
      fleetShardId: big.id,
      availabilityZone: 'us-east-1a',
      handle: { app: 'agent-hoster-big', machineId: 'i-agent-hoster-big-1' },
    });
    expect(accounts['agent-hoster-big'].provisioned[0]).toMatchObject({
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
    });
    expect(accounts['agent-hoster-small'].provisioned).toHaveLength(0);
    expect(fly.provisioned).toHaveLength(0);
    const placed = await rowOf(row.id);
    expect(placed).toMatchObject({
      fleetShardId: big.id,
      availabilityZone: 'us-east-1a',
      flyApp: 'agent-hoster-big',
      machineId: 'i-agent-hoster-big-1',
      volumeId: 'vol-agent-hoster-big-1',
    });
  });

  it('never considers a Fly account or another kind’s account', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    await seedShard('agent-hoster-fly', { provider: 'fly' });
    await seedShard('ci-runner-aws', { fleetKind: 'ci_runner' });
    const { value, fly } = deps({});
    const row = await createInstance(f, 'yue-claude');
    expect(await placement.placeAndProvision(inputFor(f, row), value)).toEqual({
      outcome: 'pool_full',
      refusedShardIds: [],
    });
    expect(fly.provisioned).toHaveLength(0);
  });

  it('moves to the next account on a capacity refusal, leaving nothing on the refusing one', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const first = await seedShard('agent-hoster-first', { machineLimit: 8 });
    const second = await seedShard('agent-hoster-second', { machineLimit: 4 });
    const accounts = {
      'agent-hoster-first': fakeAccount('agent-hoster-first'),
      'agent-hoster-second': fakeAccount('agent-hoster-second'),
    };
    accounts['agent-hoster-first'].set('capacity');
    const { value, fly } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');

    const out = await placement.placeAndProvision(inputFor(f, row), value);
    expect(out).toMatchObject({ outcome: 'aws', fleetShardId: second.id });
    expect(accounts['agent-hoster-first'].provisioned).toHaveLength(1);
    expect(accounts['agent-hoster-first'].destroyed).toHaveLength(0);
    expect((await rowOf(row.id)).fleetShardId).toBe(second.id);
    // The refusing account is paused as admission pauses it.
    const paused = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: first.id } });
    expect(paused.admissionPausedReason).toBe('capacity_refused');
    expect(paused.admissionPausedUntil!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(fly.provisioned).toHaveLength(0);
  });

  it('answers pool_full when every account refuses or is full: nothing created, nothing recorded, no Fly', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const refusing = await seedShard('agent-hoster-refusing', { machineLimit: 4 });
    const full = await seedShard('agent-hoster-full', { machineLimit: 2 });
    await fill(f, full, 2);
    const accounts = {
      'agent-hoster-refusing': fakeAccount('agent-hoster-refusing'),
      'agent-hoster-full': fakeAccount('agent-hoster-full'),
    };
    accounts['agent-hoster-refusing'].set('capacity');
    const { value, fly } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');

    expect(await placement.placeAndProvision(inputFor(f, row), value)).toEqual({
      outcome: 'pool_full',
      refusedShardIds: [refusing.id],
    });
    expect(accounts['agent-hoster-full'].provisioned).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({
      fleetShardId: null,
      availabilityZone: null,
      machineId: null,
    });
    expect(fly.provisioned).toHaveLength(0);
  });

  it('raises a non-capacity error as AgentInstancePlacementError without trying the next account or Fly', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const first = await seedShard('agent-hoster-first', { machineLimit: 8 });
    await seedShard('agent-hoster-second', { machineLimit: 4 });
    const accounts = {
      'agent-hoster-first': fakeAccount('agent-hoster-first'),
      'agent-hoster-second': fakeAccount('agent-hoster-second'),
    };
    accounts['agent-hoster-first'].set('denied');
    const { value, fly } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');

    const err = await placement.placeAndProvision(inputFor(f, row), value).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInstancePlacementError);
    expect(err).toMatchObject({ fleetShardId: first.id, code: 'agent_instance_placement_failed' });
    expect((err as AgentInstancePlacementError).cause).toBeInstanceOf(OrchestratorApiError);
    expect(accounts['agent-hoster-second'].provisioned).toHaveLength(0);
    expect(fly.provisioned).toHaveLength(0);
    // The reservation is given back; the account is not paused for a non-capacity error.
    expect((await rowOf(row.id)).fleetShardId).toBeNull();
    const shard = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: first.id } });
    expect(shard.admissionPausedUntil).toBeNull();
  });

  it('two racing creates cannot both fill the last place on one account', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const last = await seedShard('agent-hoster-last', { machineLimit: 2 });
    await fill(f, last, 1);
    const accounts = { 'agent-hoster-last': fakeAccount('agent-hoster-last') };
    const { value } = deps(accounts);
    const one = await createInstance(f, 'yue-one');
    const two = await createInstance(f, 'yue-two');

    const outcomes = await Promise.all([
      placement.placeAndProvision(inputFor(f, one), value),
      placement.placeAndProvision(inputFor(f, two), value),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'aws')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'pool_full')).toHaveLength(1);
    expect(accounts['agent-hoster-last'].provisioned).toHaveLength(1);
    expect(
      await adminDb.agentInstance.count({ where: { fleetShardId: last.id, deletedAt: null } }),
    ).toBe(2);
  });

  it('when the placement is no longer this call’s after the provision, destroys what it made and reports the existing placement', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const mine = await seedShard('agent-hoster-mine', { machineLimit: 4 });
    const other = await seedShard('agent-hoster-other', { machineLimit: 1 });
    const accounts = { 'agent-hoster-mine': fakeAccount('agent-hoster-mine') };
    const { value } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');
    // While the provider works, another placement takes the instance over.
    accounts['agent-hoster-mine'].beforeAnswer(async () => {
      await adminDb.agentInstance.update({
        where: { id: row.id },
        data: {
          fleetShardId: other.id,
          availabilityZone: 'us-east-1b',
          flyApp: 'agent-hoster-other',
          machineId: 'i-other',
          volumeId: 'vol-other',
        },
      });
    });

    const out = await placement.placeAndProvision(inputFor(f, row), value);
    expect(out).toMatchObject({
      outcome: 'aws',
      fleetShardId: other.id,
      availabilityZone: 'us-east-1b',
      handle: { machineId: 'i-other', volumeId: 'vol-other' },
      placedElsewhere: true,
    });
    expect(accounts['agent-hoster-mine'].destroyed).toEqual([
      expect.objectContaining({
        machineId: 'i-agent-hoster-mine-1',
        volumeId: 'vol-agent-hoster-mine-1',
      }),
    ]);
    expect(mine.id).not.toBe(other.id);
  });

  it('reports a placement another call already reserved without provisioning', async () => {
    wireFleetKindSwitch('agent_instance', () => true);
    const f = await seedFixture();
    const reserved = await seedShard('agent-hoster-reserved', { machineLimit: 4 });
    const accounts = { 'agent-hoster-reserved': fakeAccount('agent-hoster-reserved') };
    const { value } = deps(accounts);
    const row = await createInstance(f, 'yue-claude');
    await adminDb.agentInstance.update({
      where: { id: row.id },
      data: { fleetShardId: reserved.id, availabilityZone: 'us-east-1a' },
    });

    expect(await placement.placeAndProvision(inputFor(f, row), value)).toEqual({
      outcome: 'aws',
      fleetShardId: reserved.id,
      availabilityZone: 'us-east-1a',
      handle: null,
      placedElsewhere: true,
    });
    expect(accounts['agent-hoster-reserved'].provisioned).toHaveLength(0);
  });

  it('chooses the region’s first zone, and refuses an account with no region', () => {
    expect(placementZoneFor({ awsRegion: 'eu-west-2' })).toBe('eu-west-2a');
    expect(() => placementZoneFor({ awsRegion: null })).toThrow(/names no region/);
  });
});
