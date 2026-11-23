import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetShardAdmissionService,
  OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND,
} from '@/lib/services/fleetShardAdmissionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE MERGED HOST ACCOUNT'S AGENT CAP (Story MOTIR-9365 · MOTIR-9589; one row
// since MOTIR-12038), against real Postgres: the account is its one
// `agent_instance` row, which takes the whole grant — agents min(50, granted ÷
// 2), no index spots kept — and the other own accounts keep granted ÷ 2.

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

/** The merged account as it is since MOTIR-12038: its one agent row, granted. */
async function merged(owner: Fixture, granted: number) {
  const [hoster] = await own(owner, ['agent_instance']);
  await grant(hoster!, granted);
  return { hoster: hoster! };
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

const ownFull = (kind: FleetWorkloadKind) => ({
  deferred: 'shard_capacity',
  detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[kind],
  own: true,
});

grantPaidAiPlan(HOST_PLAN_KEY);

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
  it('admits 20 agents and no 21st: the whole grant, no spots kept for indexing', async () => {
    const host = await seedTenant();
    const { hoster } = await merged(host, 40);

    agentsRunning({ [hoster.id]: 19 });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster.id });
    agentsRunning({ [hoster.id]: 20 });
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));
  });

  it('takes no index job: the org has no own index account', async () => {
    const host = await seedTenant();
    await merged(host, 40);
    const pool = await shared('code_graph_index');

    expect(await choose('code_graph_index', host.organizationId)).toEqual({ shardId: pool.id });
  });
});

describe('the merged account granted 120 vCPU', () => {
  it('admits 50 agents, defers the 51st, and a raise past 120 keeps the cap at 50', async () => {
    const host = await seedTenant();
    const { hoster } = await merged(host, 120);

    agentsRunning({ [hoster.id]: 49 });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster.id });
    agentsRunning({ [hoster.id]: 50 });
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));

    await grant(hoster, 200);
    const ceiling = (row: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx));
    expect(await ceiling(hoster)).toBe(50);
    expect(await choose('agent_instance', host.organizationId)).toEqual(ownFull('agent_instance'));
    // Nothing was copied onto the row.
    const row = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: hoster.id } });
    expect([row.vcpuQuota, row.admissionCeilingOverride]).toEqual([null, null]);
  });
});

describe('the other own accounts', () => {
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
