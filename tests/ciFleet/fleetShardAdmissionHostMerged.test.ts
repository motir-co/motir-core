import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import {
  fleetShardAdmissionService,
  OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND,
} from '@/lib/services/fleetShardAdmissionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE MERGED INDEXER + AGENT HOSTER ACCOUNT SHARES ONE QUOTA (Story MOTIR-9365 ·
// MOTIR-9589), against real Postgres: 10 index spots kept whether used or not,
// agents min(50, (granted − 20) ÷ 2), both rows reading the one grant; and a
// Host org on it is bounded by that split, not by the shared index caps.

const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `host-merged-${suffix}@example.com`,
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
    identifier: `M${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

async function shared(fleetKind: FleetWorkloadKind): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `shared-${slug}`,
      fleetKind,
      provider: 'aws',
      role: 'primary',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      awsAccountId: String(randomInt(100_000_000_000, 999_999_999_999)),
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
      vcpuQuota: 640,
    },
  });
}

/** An own AWS account of `owner`, one row per kind, live. */
async function own(owner: Fixture, kinds: FleetWorkloadKind[]): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const rows: FleetShard[] = [];
  for (const fleetKind of kinds) {
    const slug = randomToken(6).toLowerCase();
    rows.push(
      await adminDb.fleetShard.create({
        data: {
          name: `host-${slug}-${fleetKind}`,
          fleetKind,
          provider: 'aws',
          role: 'org_owned',
          ownerOrganizationId: owner.organizationId,
          state: 'active',
          githubOrg: MOTIR_ORG,
          githubInstallationId: '556677',
          awsAccountId,
          awsRegion: 'us-east-1',
          credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
          quotaRequestedAt: NOW,
          grantedAt: NOW,
          liveAt: NOW,
        },
      }),
    );
  }
  return rows;
}

async function merged(owner: Fixture, granted: number) {
  const [index, hoster] = await own(owner, ['code_graph_index', 'agent_instance']);
  await grant(index!, granted);
  return { index: index!, hoster: hoster! };
}

async function grant(row: FleetShard, value: number) {
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: row.id,
      fleetKind: row.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: value,
      awsRequestId: `req-${randomToken(6)}`,
      status: 'approved',
      grantedValue: value,
      closedAt: NOW,
    },
  });
}

let slotSeq = 0;
/** `n` live index slots of `owner`, on `shardId` (null: the Fly fleet). */
async function indexSlots(owner: Fixture, shardId: string | null, n: number) {
  for (let i = 0; i < n; i++) {
    slotSeq += 1;
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'code_graph_index',
        ref: `${owner.projectId}:acme/repo-${slotSeq}`,
        ownerRef: `dispatch-${slotSeq}`,
        organizationId: owner.organizationId,
        workspaceId: owner.workspaceId,
        fleetShardId: shardId,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
    });
  }
}

/** Running agent instances on each account, by id. */
function agentsRunning(byShard: Record<string, number>) {
  vi.spyOn(agentInstanceRepository, 'countLiveOnFleetShard').mockImplementation(
    async (shardId) => byShard[shardId] ?? 0,
  );
}

const choose = (fleetKind: FleetWorkloadKind, organizationId: string) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind, organizationId }, NOW, tx),
  );

const admitIndex = (fx: Fixture, repo: string) =>
  codeGraphIndexAdmissionService.admit(
    {
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoRef: repo,
      dispatchId: `dispatch-${repo}`,
      containerTimeoutMs: 60_000,
    },
    NOW,
  );

const ownFull = (kind: FleetWorkloadKind) => ({
  deferred: 'shard_capacity',
  detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[kind],
  own: true,
});

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => true);
});

afterEach(async () => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the merged account granted 40 vCPU', () => {
  it('admits 10 agents and no 11th, with no index container running — the 10 spots stay kept', async () => {
    const host = await seedTenant();
    const { index, hoster } = await merged(host, 40);

    agentsRunning({ [hoster.id]: 9 });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster.id });
    agentsRunning({ [hoster.id]: 10 });
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));
    // The idle index spots were not lent: an index job still lands.
    expect(await choose('code_graph_index', host.organizationId)).toEqual({ shardId: index.id });
  });

  it('runs 10 index containers, defers the 11th, and 10 agents still run beside them', async () => {
    const host = await seedTenant();
    const { index, hoster } = await merged(host, 40);
    await indexSlots(host, index.id, 10);

    expect(await choose('code_graph_index', host.organizationId)).toEqual(
      ownFull('code_graph_index'),
    );
    agentsRunning({ [hoster.id]: 9 });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster.id });
  });
});

describe('the merged account granted 120 vCPU', () => {
  it('admits 50 agents, defers the 51st, and a raise past 120 keeps the cap at 50', async () => {
    const host = await seedTenant();
    const { index, hoster } = await merged(host, 120);

    agentsRunning({ [hoster.id]: 49 });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster.id });
    agentsRunning({ [hoster.id]: 50 });
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));

    await grant(index, 200);
    const ceiling = (row: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx));
    expect(await ceiling(hoster)).toBe(50);
    expect(await ceiling(index)).toBe(10);
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));
    // Nothing was copied onto either row.
    const rows = await adminDb.fleetShard.findMany({
      where: { id: { in: [index.id, hoster.id] } },
    });
    expect(rows.map((r) => [r.vcpuQuota, r.admissionCeilingOverride])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});

describe('the one grant across the pair', () => {
  it('both rows read it whichever row the raise was filed on', async () => {
    const host = await seedTenant();
    const [index, hoster] = await own(host, ['code_graph_index', 'agent_instance']);
    await grant(hoster!, 40);
    const ceiling = (row: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx));
    expect(await ceiling(index!)).toBe(10);
    expect(await ceiling(hoster!)).toBe(10);
  });

  it('the CI and agent-runner own accounts keep granted ÷ 2', async () => {
    const host = await seedTenant();
    const [ci] = await own(host, ['ci_runner']);
    const [runner] = await own(host, ['hosted_agent']);
    await grant(ci!, 40);
    await grant(runner!, 40);
    const ceiling = (row: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx));
    expect(await ceiling(ci!)).toBe(20);
    expect(await ceiling(runner!)).toBe(20);
  });
});

describe('index admission for a Host org on its merged account', () => {
  it('is bounded by the split, not the per-org index cap of 3', async () => {
    const host = await seedTenant();
    const { index } = await merged(host, 40);
    await indexSlots(host, index.id, 5);

    const verdict = await admitIndex(host, 'acme/sixth');
    expect(verdict.outcome).toBe('admitted');
    const slot = await adminDb.fleetInFlightSlot.findFirstOrThrow({
      where: { ref: `${host.projectId}:acme/sixth` },
    });
    expect(slot.fleetShardId).toBe(index.id);
  });

  it('defers the 11th with the own-capacity words', async () => {
    const host = await seedTenant();
    const { index } = await merged(host, 40);
    await indexSlots(host, index.id, 10);

    expect(await admitIndex(host, 'acme/eleventh')).toMatchObject({
      outcome: 'deferred',
      reason: 'pool_full',
      detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND.code_graph_index,
    });
  });

  it("draws nothing from the global cap: another org still indexes beside the Host org's 10", async () => {
    const host = await seedTenant();
    const other = await seedTenant();
    const { index } = await merged(host, 40);
    await shared('code_graph_index');
    await indexSlots(host, index.id, 10);

    expect((await admitIndex(other, 'acme/web')).outcome).toBe('admitted');
  });

  it('another org keeps the per-org cap of 3', async () => {
    const other = await seedTenant();
    const pool = await shared('code_graph_index');
    await indexSlots(other, pool.id, 3);

    expect(await admitIndex(other, 'acme/fourth')).toMatchObject({
      outcome: 'deferred',
      reason: 'org_index_cap',
    });
  });

  it('with the indexer switch on Fly the Host org keeps both shared caps', async () => {
    wireFleetKindSwitch('code_graph_index', async () => false);
    const host = await seedTenant();
    const { index } = await merged(host, 40);
    await indexSlots(host, index.id, 3);

    expect(await admitIndex(host, 'acme/fly')).toMatchObject({
      outcome: 'deferred',
      reason: 'org_index_cap',
    });
  });
});
