import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerUrl } from '../helpers/parallelDb';
import { randomInt, randomToken } from '../helpers/random';

// THE MERGED HOST ACCOUNT RE-HOME (MOTIR-12038), run against the real database
// exactly as `prisma migrate deploy` runs it: the whole file, one script, one
// session — and as the RUNTIME role (`motir_app`), which every RLS policy binds,
// so the per-workspace writes to `agent_instance` and `dispatch_run` are proven
// to pass their policies rather than a superuser walking past them.
//
// Seeded: a merged account written the old way (an `org_owned`
// `code_graph_index` row carrying the raise, and its `agent_instance` twin), with
// a row in every table that references a fleet account; a merged account whose
// twin was never written; and a platform-pool `code_graph_index` row beside them.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261123120000_merged_host_account_rehome/migration.sql',
);
const SQL = readFileSync(MIGRATION, 'utf8');

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
const LATER = new Date(Date.UTC(2027, 0, 1));

/** Run the migration file as one script on one connection, as the app role. */
async function runMigration(): Promise<void> {
  const client = new Client({ connectionString: currentWorkerUrl() });
  await client.connect();
  try {
    await client.query(SQL);
  } finally {
    await client.end();
  }
}

const awsId = () => String(randomInt(100_000_000_000, 999_999_999_999));

async function indexRow(
  organizationId: string | null,
  name: string,
  awsAccountId: string,
  role: 'org_owned' | 'primary' = 'org_owned',
): Promise<FleetShard> {
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'code_graph_index',
      provider: 'aws',
      role,
      ownerOrganizationId: organizationId,
      state: 'active',
      githubOrg: 'motir-fleet-use1-1',
      githubInstallationId: '9001',
      awsAccountId,
      awsRegion: 'us-west-2',
      credentialRef: 'FLEET_SHARD_HOST_INDEX',
      vcpuQuota: 120,
      limitsSource: { vcpuQuota: 'raised' },
      limitsVerifiedAt: T(5),
      quotaRequestedAt: T(1),
      grantedAt: T(2),
      liveAt: T(3),
    },
  });
}

async function raise(shard: FleetShard, granted: number) {
  return adminDb.fleetQuotaRequest.create({
    data: {
      shardId: shard.id,
      fleetKind: shard.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: 120,
      awsRequestId: `req-${randomToken(6)}`,
      status: 'approved',
      grantedValue: granted,
      closedAt: T(2),
    },
  });
}

interface Seed {
  fx: WorkItemFixture;
  index: FleetShard;
  twin: FleetShard;
  quotaRequestId: string;
  capacityRequestId: string;
  growthEventId: string;
  slotId: string;
  agentInstanceId: string;
  dispatchRunId: string;
}

/** A merged account the old way, every referencing table holding a row on it. */
async function mergedWithTwin(): Promise<Seed> {
  const fx = await makeWorkItemFixture({ name: 'Twin', identifier: `TW${randomInt(10, 100)}` });
  const organizationId = fx.workspace.organizationId;
  const account = awsId();
  const name = `host-${organizationId.toLowerCase()}-index`;
  const index = await indexRow(organizationId, name, account);
  const twin = await adminDb.fleetShard.create({
    data: {
      name: `host-${organizationId.toLowerCase()}-agent-host`,
      fleetKind: 'agent_instance',
      provider: 'aws',
      role: 'org_owned',
      ownerOrganizationId: organizationId,
      state: 'provisioning',
      githubOrg: 'motir-fleet-use1-1',
      githubInstallationId: '9001',
      awsAccountId: account,
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_STALE_COPY',
      admissionCeilingOverride: null,
      admissionPausedUntil: LATER,
      admissionPausedReason: 'capacity_refused',
    },
  });
  const quota = await raise(index, 120);
  const capacity = await adminDb.fleetCapacityRequest.create({
    data: {
      organizationId,
      shardId: index.id,
      awsAccountId: account,
      fleetKind: 'code_graph_index',
      desiredVcpu: 200,
      reasonMd: 'more index room',
      status: 'closed',
      closedAt: T(4),
      closedNote: 'done',
      requestedByUserId: fx.ownerId,
    },
  });
  const growth = await adminDb.fleetGrowthEvent.create({
    data: {
      fleetKind: 'code_graph_index',
      triggeringShardId: index.id,
      spareShardId: index.id,
      newShardId: index.id,
      vcpuInUse: 10,
      grantedQuota: 120,
      outcome: 'account_created',
    },
  });
  const slot = await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'code_graph_index',
      ref: `index-${randomToken(6)}`,
      organizationId,
      workspaceId: fx.workspaceId,
      fleetShardId: index.id,
      expiresAt: LATER,
    },
  });
  const instance = await adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name: `agent-${randomToken(4)}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      region: 'iad',
      fleetShardId: index.id,
    },
  });
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: fx.ownerId,
      fleetShardId: index.id,
    },
  });
  return {
    fx,
    index,
    twin,
    quotaRequestId: quota.id,
    capacityRequestId: capacity.id,
    growthEventId: growth.id,
    slotId: slot.id,
    agentInstanceId: instance.id,
    dispatchRunId: run.id,
  };
}

/** Every row the migration may touch, for the second-run comparison. */
async function snapshot() {
  return {
    shards: await adminDb.fleetShard.findMany({ orderBy: { id: 'asc' } }),
    quotas: await adminDb.fleetQuotaRequest.findMany({ orderBy: { id: 'asc' } }),
    capacity: await adminDb.fleetCapacityRequest.findMany({ orderBy: { id: 'asc' } }),
    growth: await adminDb.fleetGrowthEvent.findMany({ orderBy: { id: 'asc' } }),
    slots: await adminDb.fleetInFlightSlot.findMany({ orderBy: { id: 'asc' } }),
    instances: await adminDb.agentInstance.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, fleetShardId: true },
    }),
    runs: await adminDb.dispatchRun.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, fleetShardId: true },
    }),
  };
}

async function clearFleet() {
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetGrowthEvent.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.agentInstance.deleteMany({});
  await adminDb.dispatchRun.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
}

beforeEach(async () => {
  await clearFleet();
  await truncateAuthTables();
});

afterAll(async () => {
  await clearFleet();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the merged host account re-home migration (MOTIR-12038)', () => {
  it('moves a merged account onto its twin, re-points every reference first, and loses no raise', async () => {
    const seed = await mergedWithTwin();

    await runMigration();

    expect(await adminDb.fleetShard.findUnique({ where: { id: seed.index.id } })).toBeNull();
    const twin = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: seed.twin.id } });
    expect(twin).toMatchObject({
      fleetKind: 'agent_instance',
      role: 'org_owned',
      name: seed.index.name,
      awsAccountId: seed.index.awsAccountId,
      awsRegion: 'us-west-2',
      credentialRef: 'FLEET_SHARD_HOST_INDEX',
      vcpuQuota: 120,
      limitsSource: { vcpuQuota: 'raised' },
      limitsVerifiedAt: T(5),
      quotaRequestedAt: T(1),
      grantedAt: T(2),
      liveAt: T(3),
      // The twin was still provisioning: it takes the account's state.
      state: 'active',
      // Its own admission fields stay its own.
      admissionCeilingOverride: null,
      admissionPausedUntil: LATER,
      admissionPausedReason: 'capacity_refused',
    });

    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: seed.quotaRequestId } }),
    ).toMatchObject({ shardId: twin.id, fleetKind: 'agent_instance', grantedValue: 120 });
    // A capacity request is history: only its shard moves.
    expect(
      await adminDb.fleetCapacityRequest.findUniqueOrThrow({
        where: { id: seed.capacityRequestId },
      }),
    ).toMatchObject({
      shardId: twin.id,
      fleetKind: 'code_graph_index',
      awsAccountId: seed.index.awsAccountId,
    });
    expect(
      await adminDb.fleetGrowthEvent.findUniqueOrThrow({ where: { id: seed.growthEventId } }),
    ).toMatchObject({ triggeringShardId: twin.id, spareShardId: twin.id, newShardId: twin.id });
    expect(
      await adminDb.fleetInFlightSlot.findUniqueOrThrow({ where: { id: seed.slotId } }),
    ).toMatchObject({ fleetShardId: twin.id });
    expect(
      await adminDb.agentInstance.findUniqueOrThrow({ where: { id: seed.agentInstanceId } }),
    ).toMatchObject({ fleetShardId: twin.id });
    expect(
      await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: seed.dispatchRunId } }),
    ).toMatchObject({ fleetShardId: twin.id });

    // The grant the index row carried is the agent row's whole-grant cap.
    const ceiling = await withSystemContext((tx) =>
      fleetShardAdmissionService.ownCeilingInTx(twin, tx),
    );
    expect(ceiling).toBe(50);
  });

  it('keeps a twin that is already past provisioning in its own state', async () => {
    const seed = await mergedWithTwin();
    await adminDb.fleetShard.update({ where: { id: seed.twin.id }, data: { state: 'disabled' } });

    await runMigration();

    expect(
      await adminDb.fleetShard.findUniqueOrThrow({ where: { id: seed.twin.id } }),
    ).toMatchObject({ state: 'disabled', name: seed.index.name });
  });

  it('turns a twinless merged account into the agent row in place, with the same id', async () => {
    const fx = await makeWorkItemFixture({ name: 'Solo', identifier: `SO${randomInt(10, 100)}` });
    const organizationId = fx.workspace.organizationId;
    const index = await indexRow(organizationId, `host-${organizationId}-index`, awsId());
    const quota = await raise(index, 40);
    const capacity = await adminDb.fleetCapacityRequest.create({
      data: {
        organizationId,
        shardId: index.id,
        awsAccountId: index.awsAccountId!,
        fleetKind: 'code_graph_index',
        desiredVcpu: 200,
        reasonMd: 'more',
        requestedByUserId: fx.ownerId,
      },
    });

    await runMigration();

    const row = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: index.id } });
    expect(row).toMatchObject({
      fleetKind: 'agent_instance',
      name: index.name,
      awsAccountId: index.awsAccountId,
      state: 'active',
    });
    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: quota.id } }),
    ).toMatchObject({ shardId: index.id, fleetKind: 'agent_instance' });
    expect(
      await adminDb.fleetCapacityRequest.findUniqueOrThrow({ where: { id: capacity.id } }),
    ).toMatchObject({ shardId: index.id, fleetKind: 'code_graph_index' });
    const ceiling = await withSystemContext((tx) =>
      fleetShardAdmissionService.ownCeilingInTx(row, tx),
    );
    expect(ceiling).toBe(20);
  });

  it('leaves no org_owned index row, touches no platform-pool row, and a second run changes nothing', async () => {
    await mergedWithTwin();
    const fx = await makeWorkItemFixture({ name: 'Bare', identifier: `BA${randomInt(10, 100)}` });
    const bare = fx.workspace.organizationId;
    await raise(await indexRow(bare, `host-${bare}-index`, awsId()), 120);
    const pool = await indexRow(null, 'indexer-use1-1', awsId(), 'primary');
    const poolRaise = await raise(pool, 640);

    await runMigration();

    expect(
      await adminDb.fleetShard.count({
        where: { fleetKind: 'code_graph_index', role: 'org_owned' },
      }),
    ).toBe(0);
    expect(
      await adminDb.fleetQuotaRequest.count({
        where: { fleetKind: 'code_graph_index', shard: { role: 'org_owned' } },
      }),
    ).toBe(0);
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: pool.id } })).toEqual(pool);
    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: poolRaise.id } }),
    ).toMatchObject({ shardId: pool.id, fleetKind: 'code_graph_index' });

    const once = await snapshot();
    await runMigration();
    expect(await snapshot()).toEqual(once);
  });
});
