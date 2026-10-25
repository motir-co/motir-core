import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance, FleetShard } from '@/generated/prisma/client';
import { getPersistentOrchestrator } from '@/lib/orchestrator';
import { db } from '@/lib/db';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceHandle } from '@/lib/services/agentInstanceLifecycleService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Where an agent instance lives (Story MOTIR-9361 · MOTIR-9468), against a real
// Postgres: the fleet account and the zone of its disk, recorded once at
// placement. NULL is the process-wide Fly app, so a row with no placement reads
// and routes exactly as before. The database holds the shape — a zone needs an
// account, the account must exist, and an account holding an instance cannot be
// deleted — and `recordPlacement` is the one write, guarded so it lands once.

beforeEach(async () => {
  await truncateAuthTables();
  // The handle names the process-wide orchestrator's provider; the fake answers it.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      identifier: `PL${seq}`,
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

async function seedShard(name: string): Promise<FleetShard> {
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: `1111${String(seq++).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
    },
  });
}

function record(f: Fixture, id: string, fleetShardId: string, availabilityZone: string | null) {
  return withWorkspaceServiceContext(f.workspaceId, (tx) =>
    agentInstanceRepository.recordPlacement(id, { fleetShardId, availabilityZone }, tx),
  );
}

function rowOf(id: string): Promise<AgentInstance> {
  return adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
}

describe('an instance with no placement — the process-wide Fly app', () => {
  it('reads fleetShardId and availabilityZone null, and its handle is unchanged', async () => {
    const f = await seedFixture();
    const created = await createInstance(f, 'yue-claude');
    expect(created.fleetShardId).toBeNull();
    expect(created.availabilityZone).toBeNull();

    await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.setHandle(
        created.id,
        { flyApp: 'motir-inst-x', machineId: 'm-1', volumeId: 'vol_1' },
        tx,
      ),
    );
    const row = await rowOf(created.id);
    expect(agentInstanceHandle(row)).toEqual({
      provider: getPersistentOrchestrator().provider,
      app: 'motir-inst-x',
      machineId: 'm-1',
      volumeId: 'vol_1',
      region: 'iad',
      createdAt: row.createdAt,
    });
  });
});

describe('the database holds the shape', () => {
  it('refuses a zone with no account', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    await expect(
      adminDb.agentInstance.update({
        where: { id: row.id },
        data: { availabilityZone: 'us-east-1a' },
      }),
    ).rejects.toThrow(/agent_instance_zone_needs_account_check/);
  });

  it('refuses an account that names no fleet_shard row', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    await expect(
      adminDb.agentInstance.update({
        where: { id: row.id },
        data: { fleetShardId: 'no-such-shard', availabilityZone: 'us-east-1a' },
      }),
    ).rejects.toThrow(/agent_instance_fleet_shard_id_fkey|Foreign key constraint/);
  });

  it('refuses deleting an account that an instance names', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    const shard = await seedShard('agent-aws-1');
    await record(f, row.id, shard.id, 'us-east-1a');
    await expect(adminDb.fleetShard.delete({ where: { id: shard.id } })).rejects.toThrow();
    expect(await adminDb.fleetShard.count({ where: { id: shard.id } })).toBe(1);
  });
});

describe('recordPlacement — once, for the instance’s life', () => {
  it('sets both fields on an unplaced instance and answers applied', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    const shard = await seedShard('agent-aws-1');
    expect(await record(f, row.id, shard.id, 'us-east-1a')).toEqual({ applied: true });
    const placed = await rowOf(row.id);
    expect(placed.fleetShardId).toBe(shard.id);
    expect(placed.availabilityZone).toBe('us-east-1a');
  });

  it('changes nothing a second time, with another account or another zone', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    const first = await seedShard('agent-aws-1');
    const second = await seedShard('agent-aws-2');
    await record(f, row.id, first.id, 'us-east-1a');
    expect(await record(f, row.id, second.id, 'us-east-1b')).toEqual({ applied: false });
    expect(await record(f, row.id, first.id, 'us-east-1c')).toEqual({ applied: false });
    const placed = await rowOf(row.id);
    expect(placed.fleetShardId).toBe(first.id);
    expect(placed.availabilityZone).toBe('us-east-1a');
  });

  it('two concurrent placements leave exactly one account recorded', async () => {
    const f = await seedFixture();
    const row = await createInstance(f, 'yue-claude');
    const a = await seedShard('agent-aws-1');
    const b = await seedShard('agent-aws-2');
    const answers = await Promise.all([
      record(f, row.id, a.id, 'us-east-1a'),
      record(f, row.id, b.id, 'us-east-1b'),
    ]);
    expect(answers.filter((x) => x.applied)).toHaveLength(1);
    const winner = answers[0]!.applied ? a : b;
    const placed = await rowOf(row.id);
    expect(placed.fleetShardId).toBe(winner.id);
    expect(placed.availabilityZone).toBe(winner === a ? 'us-east-1a' : 'us-east-1b');
  });
});

describe('listByFleetShard — one account’s instances', () => {
  it('lists that account’s live and deleted rows, and no other account’s or Fly’s', async () => {
    const f = await seedFixture();
    const shard = await seedShard('agent-aws-1');
    const other = await seedShard('agent-aws-2');
    const live = await createInstance(f, 'live');
    const deleted = await createInstance(f, 'deleted');
    const elsewhere = await createInstance(f, 'elsewhere');
    await createInstance(f, 'on-fly');
    await record(f, live.id, shard.id, 'us-east-1a');
    await record(f, deleted.id, shard.id, 'us-east-1b');
    await record(f, elsewhere.id, other.id, 'us-east-1a');
    await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.markDeleted(deleted.id, new Date(), tx),
    );

    const listed = await withSystemContext((tx) =>
      agentInstanceRepository.listByFleetShard(shard.id, tx),
    );
    expect(listed.map((r) => r.id).sort()).toEqual([live.id, deleted.id].sort());
  });
});
