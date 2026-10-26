import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { randomInt, randomToken } from '../helpers/random';

// THE FLEET USE READ (Story MOTIR-9368 · MOTIR-9661), against real Postgres:
// figures equal `orgPlanFiguresService.figuresFor`, use equals
// `fleetUseCountsService.countsFor`, each part fails to its own not-read state,
// where-it-runs follows admission's order, a Host org's own accounts group by AWS
// account with their states, grants and capacity requests, and no id leaves.
// motir-ai's subscription read and Sentry (the capacity alert) are the stubbed
// seams; the kind switches are wired as `hostPlanCapsOwnAccount.test.ts` wires them.

const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { fleetUseService } = await import('@/lib/services/fleetUseService');
const { orgPlanFiguresService } = await import('@/lib/services/orgPlanFiguresService');
const { fleetUseCountsService } = await import('@/lib/services/fleetUseCountsService');
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { fleetCapacityRequestService } = await import('@/lib/services/fleetCapacityRequestService');
const { fleetShardRepository } = await import('@/lib/repositories/fleetShardRepository');
const { _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { wireFleetKindSwitch } = await import('@/lib/ciFleet/shardTargets');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-26T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60 * 60_000);
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'code_graph_index',
  'hosted_agent',
  'agent_instance',
];

function subscription(key: string, name = key): RawSubscriptionResponse {
  return {
    status: 'active',
    currentPeriodEnd: null,
    priceId: null,
    planTier: { key, name, monthlyCreditAllotment: 1 },
  };
}

interface Org {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  owner: { id: string; email: string };
}

async function makeOrg(): Promise<Org> {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Fleet use',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Acme',
    identifier: `F${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
    owner,
  };
}

const seeded = { secrets: [] as string[] };

let seq = 0;
async function slot(org: Org, workload: FleetWorkloadKind, ref?: string) {
  seq += 1;
  const slotRef = ref ?? `${workload}-${seq}`;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: slotRef,
      ownerRef: slotRef,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      expiresAt: LATER,
    },
  });
}

async function intent(org: Org, status: string, waitingReason: string | null = null) {
  seq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      projectId: org.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + seq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status,
      waitingReason,
    },
  });
}

async function waitingRun(org: Org, reason: string) {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: org.workspaceId,
      projectId: org.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: org.owner.id,
    },
  });
  await adminDb.dispatchRunEvent.create({
    data: {
      workspaceId: org.workspaceId,
      dispatchRunId: run.id,
      seq: 1,
      kind: 'log',
      data: { waiting: 'words', reason },
      body: '[motir] waiting for room\n',
    },
  });
  return run.id;
}

/** One own AWS account of `org`: a row per kind, its raise on the first row. */
async function hostAccount(
  org: Org,
  kinds: FleetWorkloadKind[],
  desired: number,
  options: { granted?: number; status?: string; live?: boolean } = {},
): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const live = options.live ?? false;
  const granted = options.granted ?? null;
  const rows: FleetShard[] = [];
  for (const fleetKind of kinds) {
    const slug = randomToken(6).toLowerCase();
    const credentialRef = `FLEET_SHARD_${slug.toUpperCase()}`;
    const row = await adminDb.fleetShard.create({
      data: {
        name: `host-${slug}-${fleetKind}`.replace(/_/g, '-'),
        fleetKind,
        provider: 'aws',
        role: 'org_owned',
        ownerOrganizationId: org.organizationId,
        state: live ? 'active' : 'provisioning',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        awsAccountId,
        awsRegion: 'us-east-1',
        credentialRef,
        quotaRequestedAt: NOW,
        grantedAt: granted !== null ? NOW : null,
        liveAt: live ? NOW : null,
      },
    });
    seeded.secrets.push(row.id, credentialRef);
    rows.push(row);
  }
  seeded.secrets.push(awsAccountId);
  const awsRequestId = `req-${randomToken(8)}`;
  seeded.secrets.push(awsRequestId);
  const status = options.status ?? (granted !== null ? 'approved' : 'pending');
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: rows[0]!.id,
      fleetKind: rows[0]!.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: desired,
      awsRequestId,
      status: status as never,
      grantedValue: granted,
      closedAt: status === 'pending' ? null : NOW,
    },
  });
  return rows;
}

/** The three accounts a Host org has right after purchase. */
async function hostAfterPurchase(org: Org) {
  await hostAccount(org, ['ci_runner'], 200);
  await hostAccount(org, ['hosted_agent'], 32);
  await hostAccount(org, ['code_graph_index', 'agent_instance'], 120);
}

function wire(on: Partial<Record<FleetWorkloadKind, boolean>>) {
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => on[kind] ?? false);
}

const read = (org: Org, actorUserId = org.owner.id) =>
  fleetUseService.readForOrganization({ organizationId: org.organizationId, actorUserId }, NOW);

const answers: string[] = [];
async function readKept(org: Org) {
  const answer = await read(org);
  answers.push(JSON.stringify(answer));
  return answer;
}

let org: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetPlanCapsCache();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockResolvedValue(subscription('pro', 'Pro'));
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  wire({});
  org = await makeOrg();
  seeded.secrets.push(org.organizationId, org.owner.id, org.owner.email);
});

afterEach(async () => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  // No answer this file produced carries an id, a credential or an email.
  const all = answers.join('\n');
  for (const secret of [...seeded.secrets, 'L-1216C47A']) expect(all).not.toContain(secret);
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a Pro org: figures are figuresFor’s, use is countsFor’s', () => {
  it('reads the figures, the use and the waits', async () => {
    for (let i = 0; i < 3; i += 1) await slot(org, 'hosted_agent');
    await waitingRun(org, 'plan_cap');
    await slot(org, 'code_graph_index');
    await intent(org, 'running');
    await intent(org, 'pending', 'shard_capacity');
    await intent(org, 'pending', 'plan_cap');
    await intent(org, 'pending', 'plan_cap');

    const answer = await readKept(org);
    _resetPlanCapsCache();
    const figures = await orgPlanFiguresService.figuresFor(org.organizationId);
    if (figures.kind !== 'capped') throw new Error('expected capped');
    const counts = await fleetUseCountsService.countsFor(
      org.organizationId,
      { agentsPerUser: figures.agentsPerUser },
      NOW,
    );

    expect(answer.plan).toEqual({
      kind: 'limited',
      planKey: 'pro',
      planName: 'Pro',
      noFleet: false,
    });
    expect(answer.countsRead).toBe(true);
    expect(answer.figures.agentRunsInParallel).toEqual({
      figure: figures.agentRunsInParallel,
      inUse: counts.agentRuns.inFlight,
      waiting: counts.agentRuns.waiting,
      figureSource: 'plan',
    });
    expect(answer.figures.agentRunsInParallel).toMatchObject({
      figure: 3,
      inUse: 3,
      waiting: { planLimit: 1, poolFull: 0, other: 0 },
    });
    expect(answer.figures.ciJobsInFlight).toEqual({
      figure: figures.ciBurstCap,
      inUse: counts.ciJobs.inFlight,
      waiting: { planLimit: 2, poolFull: 1, other: 0 },
      figureSource: 'plan',
    });
    expect(answer.figures.agentsRunningInOrg).toEqual({
      figure: figures.agentsRunningPerOrg,
      inUse: counts.agentsRunning.inFlight,
      waiting: null,
      figureSource: 'plan',
    });
    expect(answer.figures.agentsPerPerson).toEqual({
      figure: figures.agentsPerUser,
      inUse: counts.agentsPerUser.membersAtFigure,
      waiting: null,
      figureSource: 'plan',
    });
    expect(answer.codeGraphIndex).toEqual({ inUse: 1 });
    expect(answer.hostAccounts).toBeNull();
    expect(answer.whereItRuns.map((row) => row.provider)).toEqual(KINDS.map(() => 'fly'));
  });

  it('a failed count read is null under countsRead: false — never 0 — and is logged', async () => {
    await slot(org, 'hosted_agent');
    vi.spyOn(fleetUseCountsService, 'countsFor').mockRejectedValue(new Error('down'));
    const answer = await readKept(org);
    expect(answer.countsRead).toBe(false);
    for (const row of Object.values(answer.figures)) {
      expect(row.inUse).toBeNull();
      expect(row.waiting).toBeNull();
      expect(row.figure).not.toBeNull();
    }
    expect(answer.codeGraphIndex.inUse).toBeNull();
    expect(answer.plan.kind).toBe('limited');
    expect(console.error).toHaveBeenCalledWith(
      "[fleetUseService] could not read the organization's fleet use counts",
      expect.objectContaining({ organizationId: org.organizationId }),
    );
  });
});

describe('the plan’s three shapes', () => {
  it('a key with no caps row reads not_read with every figure null', async () => {
    getOrgSubscriptionMock.mockResolvedValue(subscription('mystery'));
    const answer = await readKept(org);
    expect(answer.plan).toEqual({ kind: 'not_read' });
    for (const row of Object.values(answer.figures)) {
      expect(row.figure).toBeNull();
      expect(row.figureSource).toBe('not_read');
    }
  });

  it('a Motir-owned org reads no_plan_limits, figures null, counts still read', async () => {
    await adminDb.organization.update({
      where: { id: org.organizationId },
      data: { isMeta: true },
    });
    await slot(org, 'hosted_agent');
    const answer = await readKept(org);
    expect(answer.plan).toEqual({ kind: 'no_plan_limits' });
    for (const row of Object.values(answer.figures)) expect(row.figure).toBeNull();
    expect(answer.figures.agentRunsInParallel.inUse).toBe(1);
  });

  it('a Free org reads noFleet', async () => {
    getOrgSubscriptionMock.mockResolvedValue(subscription('free', 'Free'));
    expect((await readKept(org)).plan).toMatchObject({ kind: 'limited', noFleet: true });
  });

  it('an unreadable CI override reads null not_read; a staff override reads staff_override', async () => {
    const spy = vi
      .spyOn(fleetCeilingService, 'resolveCiBurstCap')
      .mockResolvedValue({ kind: 'unreadable' });
    expect((await readKept(org)).figures.ciJobsInFlight).toMatchObject({
      figure: null,
      figureSource: 'not_read',
    });
    spy.mockRestore();

    await adminDb.organization.update({
      where: { id: org.organizationId },
      data: { fleetPoolCap: 7 },
    });
    _resetPlanCapsCache();
    expect((await readKept(org)).figures.ciJobsInFlight).toMatchObject({
      figure: 7,
      figureSource: 'staff_override',
    });
  });
});

describe('a Host org’s own accounts', () => {
  beforeEach(() => {
    getOrgSubscriptionMock.mockResolvedValue(subscription('host', 'Host'));
  });

  it('right after purchase: three accounts quota requested, on the shared floor', async () => {
    wire({ ci_runner: true, hosted_agent: true, code_graph_index: true, agent_instance: true });
    await hostAfterPurchase(org);
    const answer = await readKept(org);
    const accounts = answer.hostAccounts as Exclude<
      typeof answer.hostAccounts,
      null | { kind: 'not_read' }
    >;
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => [a.accountKind, a.fleetKinds, a.vcpuAsked])).toEqual([
      ['ci_runner', ['ci_runner'], 200],
      ['hosted_agent', ['hosted_agent'], 32],
      ['indexer_and_hoster', ['code_graph_index', 'agent_instance'], 120],
    ]);
    for (const account of accounts) {
      expect(account).toMatchObject({
        state: 'quota_requested',
        quotaRequestedAt: NOW.toISOString(),
        vcpuGranted: null,
        onSharedFloor: true,
      });
      expect(Object.keys(account).sort()).toEqual(
        [
          'accountKind',
          'capacityRequests',
          'createdAt',
          'fleetKinds',
          'grantedAt',
          'keptIndexSpots',
          'liveAt',
          'onSharedFloor',
          'quotaOutcome',
          'quotaRequestedAt',
          'requestKind',
          'state',
          'vcpuAsked',
          'vcpuGranted',
        ].sort(),
      );
    }
    expect(accounts[2]!.keptIndexSpots).toBe(10);
    expect(accounts[0]!.keptIndexSpots).toBeNull();
    expect(answer.figures.agentRunsInParallel.figureSource).toBe('shared_floor');
    expect(answer.figures.ciJobsInFlight.figureSource).toBe('shared_floor');
    expect(answer.whereItRuns.map((row) => row.provider)).toEqual(
      KINDS.map(() => 'shared_aws_pool'),
    );
  });

  it('a live granted agent-runner account with its switch off: floor and Fly', async () => {
    wire({ ci_runner: true });
    await hostAccount(org, ['hosted_agent'], 32, { granted: 32, live: true });
    const answer = await readKept(org);
    expect(answer.figures.agentRunsInParallel.figureSource).toBe('shared_floor');
    expect(answer.whereItRuns.find((row) => row.fleetKind === 'hosted_agent')!.provider).toBe(
      'fly',
    );
  });

  it('with its switch on: live, granted 32, off the floor, the granted figure', async () => {
    wire({ hosted_agent: true });
    await hostAccount(org, ['hosted_agent'], 32, { granted: 32, live: true });
    const answer = await readKept(org);
    _resetPlanCapsCache();
    const figures = await orgPlanFiguresService.figuresFor(org.organizationId);
    if (figures.kind !== 'capped') throw new Error('expected capped');

    const [account] = answer.hostAccounts as { state: string }[];
    expect(account).toMatchObject({
      accountKind: 'hosted_agent',
      state: 'live',
      liveAt: NOW.toISOString(),
      vcpuGranted: 32,
      onSharedFloor: false,
    });
    expect(answer.figures.agentRunsInParallel).toMatchObject({
      figure: figures.agentRunsInParallel,
      figureSource: 'granted_quota',
    });
    expect(answer.whereItRuns.find((row) => row.fleetKind === 'hosted_agent')!.provider).toBe(
      'own_aws_account',
    );
  });

  it('a denied raise on the merged account: quota_requested, denied, on the floor', async () => {
    wire({ code_graph_index: true, agent_instance: true });
    await hostAccount(org, ['code_graph_index', 'agent_instance'], 120, { status: 'denied' });
    const answer = await readKept(org);
    const [merged] = answer.hostAccounts as { onSharedFloor: boolean }[];
    expect(merged).toMatchObject({
      state: 'quota_requested',
      quotaOutcome: 'denied',
      onSharedFloor: true,
    });
    for (const kind of ['code_graph_index', 'agent_instance']) {
      expect(answer.whereItRuns.find((row) => row.fleetKind === kind)!.provider).toBe(
        'shared_aws_pool',
      );
    }
  });

  it('each account lists its own capacity requests, newest first; the merged one once', async () => {
    await hostAfterPurchase(org);
    const ask = (fleetKind: string, desiredVcpu: number) =>
      fleetCapacityRequestService.requestForOrganization({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
        fleetKind,
        desiredVcpu,
        reason: `more for ${fleetKind}`,
      });
    const ci = await ask('ci_runner', 300);
    const merged = await ask('agent_instance', 240);
    const answer = await readKept(org);
    const accounts = answer.hostAccounts as {
      accountKind: string;
      capacityRequests: { id: string }[];
    }[];
    const byKind = Object.fromEntries(accounts.map((a) => [a.accountKind, a.capacityRequests]));
    expect(byKind.ci_runner!.map((r) => r.id)).toEqual([ci.id]);
    expect(byKind.hosted_agent).toEqual([]);
    expect(byKind.indexer_and_hoster!.map((r) => r.id)).toEqual([merged.id]);
    expect(byKind.indexer_and_hoster![0]).toMatchObject({
      fleetKind: 'agent_instance',
      desiredVcpu: 240,
      status: 'open',
    });
  });

  it('a failed account read is not_read and the rest stands', async () => {
    await hostAfterPurchase(org);
    vi.spyOn(fleetShardRepository, 'listOrgOwnedInTx').mockRejectedValue(new Error('down'));
    const answer = await readKept(org);
    expect(answer.hostAccounts).toEqual({ kind: 'not_read' });
    expect(answer.plan).toMatchObject({ kind: 'limited', planKey: 'host' });
    expect(answer.countsRead).toBe(true);
  });
});

describe('cross-org isolation', () => {
  it('a second org’s rows change none of the first org’s answer', async () => {
    getOrgSubscriptionMock.mockResolvedValue(subscription('host', 'Host'));
    wire({ hosted_agent: true });
    await hostAccount(org, ['hosted_agent'], 32, { granted: 32, live: true });
    await slot(org, 'hosted_agent');
    const before = JSON.stringify(await readKept(org));

    const other = await makeOrg();
    seeded.secrets.push(other.organizationId, other.owner.id);
    await hostAfterPurchase(other);
    await slot(other, 'hosted_agent');
    await waitingRun(other, 'plan_cap');
    await intent(other, 'pending', 'shard_capacity');
    _resetPlanCapsCache();
    expect(JSON.stringify(await readKept(org))).toBe(before);
  });
});

describe('the gate comes first', () => {
  it.each([
    ['a plain member', 'member', 'BillingForbiddenError'],
    ['a non-member', null, 'OrganizationNotFoundError'],
  ] as const)('%s is refused before any read', async (_, role, errorName) => {
    const figures = vi.spyOn(orgPlanFiguresService, 'figuresFor');
    const counts = vi.spyOn(fleetUseCountsService, 'countsFor');
    const user = await createTestUser();
    if (role) {
      await organizationsService.addMember({
        organizationId: org.organizationId,
        userId: user.id,
        role,
        actorUserId: org.owner.id,
      });
    }
    await expect(read(org, user.id)).rejects.toMatchObject({ name: errorName });
    expect(figures).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
  });

  it('off-cloud is refused before any read', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const figures = vi.spyOn(orgPlanFiguresService, 'figuresFor');
    await expect(read(org)).rejects.toMatchObject({ name: 'BillingNotAvailableError' });
    expect(figures).not.toHaveBeenCalled();
  });
});
