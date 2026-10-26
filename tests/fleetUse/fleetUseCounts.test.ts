import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstanceState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import type { AdmissionDeferralReason } from '@/lib/services/ciRunnerAdmissionService';
import {
  bucketWaitingReasons,
  fleetUseCountsService,
  WAITING_BUCKET_BY_REASON,
} from '@/lib/services/fleetUseCountsService';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// PER-ORG FLEET USE COUNTS (Story MOTIR-9368 · MOTIR-9660) — the in-flight counts
// are admission's own statements (asserted side by side with `orgCensus` and
// `countRunningOrAdmitting`), the waits follow the reason admission recorded
// (MOTIR-9666), and one org's rows never move another's numbers. Real Postgres;
// rows are seeded as admission and the hosted boot leave them.

const NOW = new Date('2026-07-15T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60 * 60_000);

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  ownerId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-use-${suffix}@example.com`,
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
    identifier: `U${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    ownerId: user.id,
  };
}

async function addMember(fx: Fixture): Promise<string> {
  const user = await usersService.createUser({
    email: `fleet-use-member-${randomInt(1_000_000)}@example.com`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: fx.organizationId, userId: user.id, role: 'member' },
  });
  return user.id;
}

let seq = 0;

async function slot(
  fx: Fixture,
  workload: 'hosted_agent' | 'code_graph_index' | 'agent_instance',
  ref?: string,
): Promise<string> {
  seq += 1;
  const slotRef = ref ?? `${workload}-${seq}`;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: slotRef,
      ownerRef: slotRef,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      expiresAt: LATER,
    },
  });
  return slotRef;
}

async function intent(fx: Fixture, status: string, waitingReason: string | null = null) {
  seq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(70_000 + seq),
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

async function agent(fx: Fixture, ownerId: string, state: AgentInstanceState = 'running') {
  seq += 1;
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      ownerId,
      name: `agent-${seq}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      region: 'us-east-1',
      state,
    },
  });
}

/** An open hosted run, with its waiting lines' reasons in order (oldest first). */
async function hostedRun(
  fx: Fixture,
  reasons: string[],
  options: { status?: 'running' | 'succeeded'; booted?: boolean } = {},
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin: 'hosted',
      status: options.status ?? 'running',
      createdById: fx.ownerId,
    },
  });
  let eventSeq = 0;
  for (const reason of reasons) {
    eventSeq += 1;
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: run.id,
        seq: eventSeq,
        kind: 'log',
        data: { waiting: `words for ${reason}`, reason },
        body: `[motir] waiting for room: words for ${reason}\n`,
      },
    });
  }
  if (options.booted) await slot(fx, 'hosted_agent', hostedRunDispatchId(run.id));
  return run.id;
}

const countsFor = (fx: Fixture, agentsPerUser: number | null = null) =>
  fleetUseCountsService.countsFor(fx.organizationId, { agentsPerUser }, NOW);

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('in flight, by admission’s own statements', () => {
  it('agent runs, CI and indexing equal orgCensus for the same org at the same now', async () => {
    const fx = await seedTenant();
    await slot(fx, 'hosted_agent');
    await slot(fx, 'hosted_agent');
    await intent(fx, 'running');
    await intent(fx, 'running');
    await intent(fx, 'provisioning');
    await slot(fx, 'code_graph_index');

    const counts = await countsFor(fx);
    const census = await withSystemContext((tx) =>
      fleetCeilingService.orgCensus(fx.organizationId, NOW, tx),
    );
    expect(counts.agentRuns.inFlight).toBe(2);
    expect(counts.ciJobs.inFlight).toBe(3);
    expect(counts.codeGraphIndex.inFlight).toBe(1);
    expect([
      counts.agentRuns.inFlight,
      counts.ciJobs.inFlight,
      counts.codeGraphIndex.inFlight,
    ]).toEqual([
      census.byWorkload.hosted_agent,
      census.byWorkload.ci_runner,
      census.byWorkload.code_graph_index,
    ]);
  });

  it('agents running equals the running-cap guard’s count, a wake in flight included', async () => {
    const fx = await seedTenant();
    await agent(fx, fx.ownerId, 'running');
    // A wake in flight: its slot is held while the row still reads hibernated.
    const waking = await agent(fx, fx.ownerId, 'hibernated');
    await slot(fx, 'agent_instance', waking.id);
    await agent(fx, fx.ownerId, 'hibernated');

    const counts = await countsFor(fx);
    const guard = await withSystemContext(async (tx) =>
      agentInstanceRepository.countRunningOrAdmitting(fx.organizationId, [waking.id], tx),
    );
    expect(counts.agentsRunning).toEqual({ inFlight: 2, waiting: null });
    expect(counts.agentsRunning.inFlight).toBe(guard);
  });
});

describe('waiting work, split by the reason admission recorded', () => {
  it('CI: plan_cap, shard_capacity, credits_insufficient and never judged', async () => {
    const fx = await seedTenant();
    await intent(fx, 'pending', 'plan_cap');
    await intent(fx, 'pending', 'shard_capacity');
    await intent(fx, 'pending', 'credits_insufficient');
    await intent(fx, 'pending', null);
    await intent(fx, 'provisioning');
    await intent(fx, 'running');

    expect((await countsFor(fx)).ciJobs.waiting).toEqual({ planLimit: 1, poolFull: 1, other: 2 });
  });

  it('CI: the count follows the latest reason, not the first', async () => {
    const fx = await seedTenant();
    const row = await intent(fx, 'pending', 'plan_cap');
    expect((await countsFor(fx)).ciJobs.waiting).toEqual({ planLimit: 1, poolFull: 0, other: 0 });

    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: row.id },
      data: { waitingReason: 'shard_capacity' },
    });
    expect((await countsFor(fx)).ciJobs.waiting).toEqual({ planLimit: 0, poolFull: 1, other: 0 });
  });

  it('agent runs: by each run’s latest waiting line; a booted or closed run is not waiting', async () => {
    const fx = await seedTenant();
    await hostedRun(fx, ['shard_capacity', 'plan_cap']);
    await hostedRun(fx, ['shard_capacity']);
    await hostedRun(fx, ['plan_cap'], { booted: true });
    await hostedRun(fx, ['plan_cap'], { status: 'succeeded' });
    await hostedRun(fx, []);

    expect((await countsFor(fx)).agentRuns.waiting).toEqual({
      planLimit: 1,
      poolFull: 1,
      other: 0,
    });
  });

  it('agent instances refuse rather than queue: their waits are null, never 0', async () => {
    const fx = await seedTenant();
    const counts = await countsFor(fx, 2);
    expect(counts.agentsRunning.waiting).toBeNull();
    expect(counts.agentsPerUser.waiting).toBeNull();
  });
});

describe('bucketWaitingReasons', () => {
  it('is total over every AdmissionDeferralReason and null', () => {
    const reasons = Object.keys(WAITING_BUCKET_BY_REASON) as AdmissionDeferralReason[];
    // The map's type is `Record<AdmissionDeferralReason, …>`, so this list is the union.
    expect(reasons).toHaveLength(9);
    for (const reason of [...reasons, null]) {
      const buckets = bucketWaitingReasons([{ reason, count: 1 }]);
      expect(buckets.planLimit + buckets.poolFull + buckets.other).toBe(1);
      expect(buckets.planLimit).toBe(reason === 'plan_cap' ? 1 : 0);
      expect(buckets.poolFull).toBe(reason === 'shard_capacity' ? 1 : 0);
    }
  });

  it('puts an unrecognised reason in other', () => {
    expect(bucketWaitingReasons([{ reason: 'workload_cap', count: 2 }])).toEqual({
      planLimit: 0,
      poolFull: 0,
      other: 2,
    });
  });
});

describe('members at the per-person figure', () => {
  it('counts members across every org their agents live in, and returns only the number', async () => {
    const fx = await seedTenant();
    const elsewhere = await seedTenant();
    const twoHere = await addMember(fx);
    const oneHereOneThere = await addMember(fx);
    const oneHere = await addMember(fx);
    await agent(fx, twoHere);
    await agent(fx, twoHere, 'hibernated');
    await agent(fx, oneHereOneThere);
    await agent(elsewhere, oneHereOneThere);
    await agent(fx, oneHere);

    const counts = await countsFor(fx, 2);
    expect(counts.agentsPerUser).toEqual({ membersAtFigure: 2, waiting: null });
    expect(JSON.stringify(counts)).not.toContain(twoHere);
    expect((await countsFor(fx, null)).agentsPerUser.membersAtFigure).toBeNull();
  });
});

describe('isolation and failure', () => {
  it('a second org’s rows change none of the first org’s numbers', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await slot(a, 'hosted_agent');
    await intent(a, 'running');
    await intent(a, 'pending', 'plan_cap');
    await hostedRun(a, ['shard_capacity']);
    await agent(a, a.ownerId);

    const before = await countsFor(a, 1);
    await slot(b, 'hosted_agent');
    await slot(b, 'code_graph_index');
    await intent(b, 'running');
    await intent(b, 'pending', 'shard_capacity');
    await hostedRun(b, ['plan_cap']);
    await agent(b, b.ownerId);
    expect(await countsFor(a, 1)).toEqual(before);
    expect(await countsFor(b, 1)).toEqual({
      agentRuns: { inFlight: 1, waiting: { planLimit: 1, poolFull: 0, other: 0 } },
      ciJobs: { inFlight: 1, waiting: { planLimit: 0, poolFull: 1, other: 0 } },
      agentsRunning: { inFlight: 1, waiting: null },
      agentsPerUser: { membersAtFigure: 1, waiting: null },
      codeGraphIndex: { inFlight: 1 },
    });
  });

  it('a repository read that throws makes countsFor throw', async () => {
    const fx = await seedTenant();
    vi.spyOn(dispatchRunRepository, 'countWaitingHostedForOrganizationByReason').mockRejectedValue(
      new Error('read failed'),
    );
    await expect(countsFor(fx)).rejects.toThrow('read failed');
  });

  it('takes no fleet admission lock and writes no row', async () => {
    const fx = await seedTenant();
    await intent(fx, 'pending', 'plan_cap');
    await slot(fx, 'hosted_agent');
    const snapshot = async () => ({
      intents: await adminDb.ciRunnerProvisioningIntent.findMany({ orderBy: { id: 'asc' } }),
      slots: await adminDb.fleetInFlightSlot.findMany({ orderBy: { ref: 'asc' } }),
    });
    const before = await snapshot();

    // An admission holds the fleet lock in a parallel transaction; the read still
    // completes while it is held.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const admission = withSystemContext(async (tx) => {
      await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
      await locks.lockScope(FLEET_ADMISSION_SCOPE, tx);
      locked();
      await held;
    });
    await lockTaken;
    const counts = await countsFor(fx);
    release();
    await admission;

    expect(counts.ciJobs.waiting.planLimit).toBe(1);
    const after = await snapshot();
    expect(after.intents).toEqual(before.intents);
    expect(after.slots).toEqual(before.slots);
  });
});
