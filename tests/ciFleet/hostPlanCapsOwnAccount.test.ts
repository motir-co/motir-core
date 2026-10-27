import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { adminDb } from '../helpers/adminDb';
import { randomInt, randomToken } from '../helpers/random';

// A HOST ORGANISATION'S CAPS FOLLOW ITS OWN ACCOUNTS (Story MOTIR-9365 ·
// MOTIR-9587), against real Postgres: on the shared floor the `host` row; once
// the agent-runner or CI account is live, that kind's figure is the account's
// granted vCPU ÷ 2 — read on every call, so a later raise shows. motir-ai's
// subscription read is the one stubbed seam.

const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));

const { planCapsService, _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { wireFleetKindSwitch } = await import('@/lib/ciFleet/shardTargets');
const { fleetShardRepository } = await import('@/lib/repositories/fleetShardRepository');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-26T12:00:00.000Z');
const FLOOR = capsForPlanKey(HOST_PLAN_KEY)!;
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

function subscription(key: string, name: string): RawSubscriptionResponse {
  return {
    status: 'active',
    currentPeriodEnd: null,
    priceId: null,
    planTier: { key, name, monthlyCreditAllotment: 1 },
  };
}

async function seedOrg(): Promise<string> {
  const user = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Host caps',
    ownerUserId: user.id,
  });
  return workspace.organizationId;
}

/** One own AWS account of `org`, one row per kind, its raise on the first row. */
async function own(
  organizationId: string,
  kinds: FleetWorkloadKind[],
  options: { granted?: number; live?: boolean } = {},
): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const live = options.live ?? true;
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
          ownerOrganizationId: organizationId,
          state: live ? 'active' : 'provisioning',
          githubOrg: 'motir-projects',
          githubInstallationId: '556677',
          awsAccountId,
          awsRegion: 'us-east-1',
          credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
          quotaRequestedAt: NOW,
          grantedAt: NOW,
          liveAt: live ? NOW : null,
        },
      }),
    );
  }
  await grant(rows[0]!, options.granted ?? 32);
  return rows;
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

async function caps(organizationId: string) {
  _resetPlanCapsCache();
  const answer = await planCapsService.capsFor(organizationId);
  if (answer.kind !== 'capped') throw new Error(`expected capped, got ${answer.kind}`);
  return answer.caps;
}

let org: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  _resetPlanCapsCache();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockResolvedValue(subscription(HOST_PLAN_KEY, 'Host'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => true);
  org = await seedOrg();
});

afterEach(() => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planCapsService.capsFor — a Host org', () => {
  it('is on the shared floor with no own account', async () => {
    expect(await caps(org)).toEqual(FLOOR);
  });

  it('a live agent-runner account granted 32 → 16 agent runs; CI stays on the floor', async () => {
    await own(org, ['hosted_agent'], { granted: 32 });
    const answer = await caps(org);
    expect(answer.agentRunsInParallel).toBe(16);
    expect(answer.ciBurstCap).toBe(FLOOR.ciBurstCap);
    expect(answer.agentsPerUser).toBe(FLOOR.agentsPerUser);
    expect(answer.agentsRunningPerOrg).toBe(FLOOR.agentsRunningPerOrg);
  });

  it('rounds an odd grant down — 33 → 16', async () => {
    await own(org, ['hosted_agent'], { granted: 33 });
    expect((await caps(org)).agentRunsInParallel).toBe(16);
  });

  it('follows a later raise — 32 then 64 → 32', async () => {
    const [row] = await own(org, ['hosted_agent'], { granted: 32 });
    expect((await caps(org)).agentRunsInParallel).toBe(16);
    await grant(row!, 64);
    expect((await caps(org)).agentRunsInParallel).toBe(32);
  });

  it('a live CI account granted 200 → 100 in flight; agent runs on the floor', async () => {
    await own(org, ['ci_runner'], { granted: 200 });
    const answer = await caps(org);
    expect(answer.ciBurstCap).toBe(100);
    expect(answer.agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
  });

  it('the two kinds move independently', async () => {
    await own(org, ['hosted_agent'], { granted: 64 });
    await own(org, ['ci_runner'], { granted: 200 });
    const answer = await caps(org);
    expect(answer.agentRunsInParallel).toBe(32);
    expect(answer.ciBurstCap).toBe(100);
  });

  it('granted but not live stays on the floor', async () => {
    await own(org, ['ci_runner'], { granted: 200, live: false });
    expect(await caps(org)).toEqual(FLOOR);
  });

  it('the merged indexer + agent hoster account lifts the agents to 10 / 50 and moves neither run nor CI figure (MOTIR-9668)', async () => {
    await own(org, ['code_graph_index', 'agent_instance'], { granted: 120 });
    expect(await caps(org)).toEqual({ ...FLOOR, agentsPerUser: 10, agentsRunningPerOrg: 50 });
  });

  it('the merged account not yet live keeps the floor’s agents', async () => {
    await own(org, ['code_graph_index', 'agent_instance'], { granted: 120, live: false });
    expect(await caps(org)).toEqual(FLOOR);
  });

  it('the agent hoster’s switch reading Fly keeps the floor’s agents', async () => {
    wireFleetKindSwitch('agent_instance', async () => false);
    await own(org, ['code_graph_index', 'agent_instance'], { granted: 120 });
    expect(await caps(org)).toEqual(FLOOR);
  });

  it('a kind whose switch reads Fly stays on the floor', async () => {
    wireFleetKindSwitch('hosted_agent', async () => false);
    await own(org, ['hosted_agent'], { granted: 64 });
    await own(org, ['ci_runner'], { granted: 200 });
    const answer = await caps(org);
    expect(answer.agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
    expect(answer.ciBurstCap).toBe(100);
  });

  it('another org’s own account changes nothing', async () => {
    const other = await seedOrg();
    await own(other, ['hosted_agent'], { granted: 64 });
    expect(await caps(org)).toEqual(FLOOR);
  });

  it('a failed own-account read answers the floor, never more', async () => {
    await own(org, ['hosted_agent'], { granted: 64 });
    vi.spyOn(fleetShardRepository, 'listLiveOrgOwned').mockRejectedValue(new Error('db down'));
    expect(await caps(org)).toEqual(FLOOR);
  });
});

describe('planCapsService.capsFor — any other plan', () => {
  it('ignores own accounts', async () => {
    getOrgSubscriptionMock.mockResolvedValue(subscription('max', 'Max'));
    await own(org, ['hosted_agent'], { granted: 64 });
    expect(await caps(org)).toEqual(capsForPlanKey('max'));
  });
});
