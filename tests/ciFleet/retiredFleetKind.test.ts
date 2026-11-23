import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type FleetShard } from '@/generated/prisma/client';
import { FleetShardInvalidError } from '@/lib/ciFleet/errors';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import { db } from '@/lib/db';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';
import { randomInt, randomToken } from '../helpers/random';
import {
  allowRetiredFleetKind,
  RETIRED_FLEET_KIND,
  refuseRetiredFleetKind,
} from '../helpers/retiredFleetKind';

// THE RETIRED FLEET KIND (MOTIR-12041 · Story MOTIR-11026), run against the real
// database exactly as `prisma migrate deploy` runs it: the whole file as one
// script on one session, as the role that owns the tables (the migration
// replaces three CHECK constraints, which only the owner may do).
//
// Seeded, on a database loosened back to the four kinds it held before:
//   * a platform-pool shard of the retired kind with an in-flight slot, a
//     capacity request, a quota request and a growth event on it, a growth event
//     of the kind whose shards were already deleted, and the kind's switch row;
//   * a Host organisation's merged account as the re-home left it: its
//     `agent_instance` row, a quota request still keyed to the retired kind, and
//     a past capacity request of the kind re-pointed onto that row;
//   * a CI runner account with its own slot and raise, and a past usage row on
//     the `index` cost line — none of which the migration may touch.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261123180000_retire_code_graph_index_fleet_kind/migration.sql',
);
const SQL = readFileSync(MIGRATION, 'utf8');

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
const LATER = new Date(Date.UTC(2027, 0, 1));
const KINDS = ['ci_runner', 'hosted_agent', 'agent_instance'] as const;

/** Run the migration file as one script on one connection, as the table owner. */
async function runMigration(): Promise<void> {
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  try {
    await client.query(SQL);
  } finally {
    await client.end();
  }
}

const awsId = () => String(randomInt(100_000_000_000, 999_999_999_999));

function shard(
  name: string,
  fleetKind: string,
  extra: Partial<Prisma.FleetShardUncheckedCreateInput> = {},
): Promise<FleetShard> {
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind,
      provider: 'aws',
      role: 'primary',
      state: 'active',
      githubOrg: 'motir-fleet-use1-1',
      githubInstallationId: '9001',
      awsAccountId: awsId(),
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
      vcpuQuota: 120,
      ...extra,
    },
  });
}

function quotaRequest(shardId: string, fleetKind: string) {
  return adminDb.fleetQuotaRequest.create({
    data: {
      shardId,
      fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: 120,
      awsRequestId: `req-${randomToken(6)}`,
      status: 'approved',
      grantedValue: 96,
      closedAt: T(2),
    },
  });
}

function growthEvent(fleetKind: string, shardId: string | null) {
  return adminDb.fleetGrowthEvent.create({
    data: {
      fleetKind,
      triggeringShardId: shardId,
      vcpuInUse: 90,
      grantedQuota: 120,
      outcome: 'account_created',
    },
  });
}

function slot(fx: WorkItemFixture, workload: string, fleetShardId: string) {
  return adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: `${workload}-${randomToken(6)}`,
      organizationId: fx.workspace.organizationId,
      workspaceId: fx.workspaceId,
      fleetShardId,
      expiresAt: LATER,
    },
  });
}

function capacityRequest(
  fx: WorkItemFixture,
  on: FleetShard,
  fleetKind: string,
  quotaRequestId: string | null,
) {
  return adminDb.fleetCapacityRequest.create({
    data: {
      organizationId: fx.workspace.organizationId,
      shardId: on.id,
      awsAccountId: on.awsAccountId!,
      fleetKind,
      desiredVcpu: 200,
      reasonMd: 'more room',
      status: 'filed',
      filedAt: T(3),
      quotaRequestId,
      requestedByUserId: fx.ownerId,
    },
  });
}

interface Seed {
  pool: FleetShard;
  agent: FleetShard;
  ci: FleetShard;
  rekeyedQuotaId: string;
  keptCapacityId: string;
  ciSlotId: string;
  ciQuotaId: string;
  usageId: string;
}

async function seed(): Promise<Seed> {
  const fx = await makeWorkItemFixture({ name: 'Retire', identifier: `RT${randomInt(10, 100)}` });
  const organizationId = fx.workspace.organizationId;

  // The retired kind's platform pool, and every record that names it.
  const pool = await shard('indexer-use1-1', RETIRED_FLEET_KIND);
  const poolQuota = await quotaRequest(pool.id, RETIRED_FLEET_KIND);
  await slot(fx, RETIRED_FLEET_KIND, pool.id);
  await capacityRequest(fx, pool, RETIRED_FLEET_KIND, poolQuota.id);
  await growthEvent(RETIRED_FLEET_KIND, pool.id);
  await growthEvent(RETIRED_FLEET_KIND, null);
  await adminDb.platformFleetKindSwitch.create({
    data: { fleetKind: RETIRED_FLEET_KIND, onPool: true, lastReason: 'indexer on AWS' },
  });

  // The merged account as the re-home left it.
  const agent = await shard(`host-${organizationId.toLowerCase()}-index`, 'agent_instance', {
    role: 'org_owned',
    ownerOrganizationId: organizationId,
  });
  const rekeyed = await quotaRequest(agent.id, RETIRED_FLEET_KIND);
  const kept = await capacityRequest(fx, agent, RETIRED_FLEET_KIND, rekeyed.id);

  // A live kind's rows, which the migration never touches.
  const ci = await shard('ci-runner-use1-1', 'ci_runner');
  const ciSlot = await slot(fx, 'ci_runner', ci.id);
  const ciQuota = await quotaRequest(ci.id, 'ci_runner');
  await growthEvent('ci_runner', ci.id);
  const usage = await adminDb.ciContainerUsage.create({
    data: {
      containerProvider: 'fly',
      handleId: `machine-index-${randomToken(6)}`,
      containerRegion: 'iad',
      workspaceId: fx.workspaceId,
      organizationId,
      workload: 'index',
      repoFullName: 'acme/web',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 4096,
      containerCreatedAt: T(0),
      containerStartedAt: T(0),
      containerStoppedAt: T(30),
      billableSeconds: 1800,
      periodStart: new Date(Date.UTC(2026, 10, 1)),
      usdPerSecond: new Prisma.Decimal('0.000031636049'),
      costUsd: new Prisma.Decimal('0.056944888200'),
      rateEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    },
  });

  return {
    pool,
    agent,
    ci,
    rekeyedQuotaId: rekeyed.id,
    keptCapacityId: kept.id,
    ciSlotId: ciSlot.id,
    ciQuotaId: ciQuota.id,
    usageId: usage.id,
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
    switches: await adminDb.platformFleetKindSwitch.findMany({ orderBy: { id: 'asc' } }),
    usage: await adminDb.ciContainerUsage.findMany({ orderBy: { id: 'asc' } }),
  };
}

async function clearFleet() {
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetGrowthEvent.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await adminDb.platformFleetKindSwitch.deleteMany({});
  await adminDb.ciContainerUsage.deleteMany({});
}

/** The raw message of a refused write, so the constraint it names is asserted. */
async function refusal(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error('the write was accepted');
}

beforeEach(async () => {
  await clearFleet();
  await truncateAuthTables();
  // The database as it stood before this migration: four kinds.
  await allowRetiredFleetKind();
});

afterAll(async () => {
  await clearFleet();
  await refuseRetiredFleetKind();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the retired fleet kind migration (MOTIR-12041)', () => {
  it('leaves no row of the retired kind except the re-pointed past capacity request', async () => {
    const s = await seed();

    await runMigration();

    const where = { fleetKind: RETIRED_FLEET_KIND };
    expect(await adminDb.fleetShard.count({ where })).toBe(0);
    expect(await adminDb.fleetQuotaRequest.count({ where })).toBe(0);
    expect(await adminDb.fleetGrowthEvent.count({ where })).toBe(0);
    expect(await adminDb.platformFleetKindSwitch.count({ where })).toBe(0);
    expect(await adminDb.fleetInFlightSlot.count({ where: { workload: RETIRED_FLEET_KIND } })).toBe(
      0,
    );
    expect(await adminDb.fleetShard.findUnique({ where: { id: s.pool.id } })).toBeNull();

    // The merged account's past request is billing history: kept, as stored.
    const capacity = await adminDb.fleetCapacityRequest.findMany({ where });
    expect(capacity).toEqual([
      expect.objectContaining({
        id: s.keptCapacityId,
        shardId: s.agent.id,
        awsAccountId: s.agent.awsAccountId,
        fleetKind: RETIRED_FLEET_KIND,
        quotaRequestId: s.rekeyedQuotaId,
      }),
    ]);
  });

  it('re-keys a raise of the kind on the agent row, and leaves the agent row unchanged', async () => {
    const s = await seed();

    await runMigration();

    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: s.rekeyedQuotaId } }),
    ).toMatchObject({ shardId: s.agent.id, fleetKind: 'agent_instance', grantedValue: 96 });
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: s.agent.id } })).toEqual(
      s.agent,
    );
  });

  it('touches no live kind’s row and no past usage on the index cost line', async () => {
    const s = await seed();
    const usageBefore = await adminDb.ciContainerUsage.findUniqueOrThrow({
      where: { id: s.usageId },
    });

    await runMigration();

    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: s.ci.id } })).toEqual(s.ci);
    expect(
      await adminDb.fleetInFlightSlot.findUniqueOrThrow({ where: { id: s.ciSlotId } }),
    ).toMatchObject({ workload: 'ci_runner', fleetShardId: s.ci.id });
    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: s.ciQuotaId } }),
    ).toMatchObject({ fleetKind: 'ci_runner' });
    expect(await adminDb.fleetGrowthEvent.count({ where: { fleetKind: 'ci_runner' } })).toBe(1);
    expect(await adminDb.ciContainerUsage.findUniqueOrThrow({ where: { id: s.usageId } })).toEqual(
      usageBefore,
    );
  });

  it('refuses a new row of the retired kind in all three checked tables, and takes the live kinds', async () => {
    await runMigration();

    expect(await refusal(() => shard('indexer-use1-2', RETIRED_FLEET_KIND))).toMatch(
      /fleet_shard_fleet_kind_check/,
    );
    const host = await shard('ci-runner-use1-9', 'ci_runner');
    expect(await refusal(() => quotaRequest(host.id, RETIRED_FLEET_KIND))).toMatch(
      /fleet_quota_request_fleet_kind_check/,
    );
    expect(await refusal(() => growthEvent(RETIRED_FLEET_KIND, null))).toMatch(
      /fleet_growth_event_fleet_kind_check/,
    );

    for (const kind of KINDS) {
      const row = await shard(`${kind.replace(/_/g, '-')}-use1-5`, kind);
      await expect(quotaRequest(row.id, kind)).resolves.toMatchObject({ fleetKind: kind });
      await expect(growthEvent(kind, row.id)).resolves.toMatchObject({ fleetKind: kind });
    }
    expect([...FLEET_WORKLOAD_KINDS].sort()).toEqual([...KINDS].sort());
  });

  it('a second run on the migrated database changes nothing and raises no error', async () => {
    await seed();
    await runMigration();
    const once = await snapshot();

    await expect(runMigration()).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(once);
  });

  it('the shard service refuses the retired kind with a typed error before the database', async () => {
    await runMigration();

    const error = await fleetShardService
      .createShard({
        name: 'indexer-use1-3',
        fleetKind: RETIRED_FLEET_KIND as never,
        provider: 'aws',
        state: 'active',
        githubOrg: 'motir-fleet-use1-1',
        githubInstallationId: '9001',
        awsAccountId: awsId(),
        awsRegion: 'us-east-1',
        credentialRef: 'FLEET_SHARD_INDEXER',
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(FleetShardInvalidError);
    expect((error as FleetShardInvalidError).field).toBe('fleetKind');
    expect(await adminDb.fleetShard.count()).toBe(0);
  });
});
