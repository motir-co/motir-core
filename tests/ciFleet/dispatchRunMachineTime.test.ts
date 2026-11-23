import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  INITIAL_HOSTED_AGENT_POLL_STATE,
  hostedAgentContainerService,
  type HostedAgentContainerRequest,
} from '@/lib/services/hostedAgentContainerService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  FLEET_CONTAINER_SIZE,
  fakeOrchestrator,
  type ContainerAccrual,
  type ContainerUsage,
} from '@motir/orchestrator';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// A HOSTED RUN'S MACHINE TIME IS KEYED TO ITS DISPATCH RUN (Story MOTIR-683 ·
// Subtask MOTIR-6448; `docs/decisions/hosted-agent-run.md` §1 — `DispatchRun.id` is
// the one id a hosted run carries everywhere, the container meter row included).
//
// Against real Postgres with the fake orchestrator at the port. ⚠️ THE ROWS ARE
// THE ASSERTION: every test drives the shipped seam or the shipped meter and then
// reads what landed in `ci_container_usage`, and every figure the by-run read
// returns is compared with the row the container itself wrote.

const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 10_000 } as const;

let tenant: { organizationId: string; workspaceId: string; projectId: string };

async function seedTenant() {
  const email = `run-meter-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `R${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

/** A real `dispatch_run` row — the column is a foreign key, so the run must exist. */
async function openHostedRun(): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      command: 'run',
      origin: 'hosted',
    },
  });
  return run.id;
}

function requestFor(dispatchRunId: string | null): HostedAgentContainerRequest {
  return {
    dispatchId: `dispatch-${randomToken(6)}`,
    runId: `run-${randomToken(6)}`,
    dispatchRunId,
    ...tenant,
    repoFullName: 'motir-projects/acme-web',
    image: 'motir/stand-in@sha256:fake',
    env: {},
    region: 'iad',
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: 3_600,
  };
}

/** A hand-built record for the meter's own sink, for the non-agent workloads. */
function usageFor(overrides: Partial<ContainerUsage> = {}): ContainerUsage {
  const createdAt = new Date('2026-09-26T10:00:00.000Z');
  return {
    handleId: `h-${randomToken(8)}`,
    provider: 'fake',
    region: 'iad',
    orgId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
    repoFullName: 'motir-projects/acme-web',
    workload: 'ci_runner',
    workflowJobId: 42,
    cpuKind: 'shared',
    cpus: 2,
    memoryMb: 4096,
    createdAt,
    startedAt: createdAt,
    stoppedAt: new Date(createdAt.getTime() + 120_000),
    billableSeconds: 120,
    usdPerSecond: '0.000010000000',
    costUsd: '0.0012',
    rateEffectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
    ...overrides,
  };
}

function accrualFor(usage: ContainerUsage, seconds: number): ContainerAccrual {
  return {
    handleId: usage.handleId,
    provider: usage.provider,
    region: usage.region,
    orgId: usage.orgId,
    workspaceId: usage.workspaceId,
    projectId: usage.projectId,
    repoFullName: usage.repoFullName,
    workload: usage.workload,
    workflowJobId: usage.workflowJobId,
    cpuKind: usage.cpuKind,
    cpus: usage.cpus,
    memoryMb: usage.memoryMb,
    createdAt: usage.createdAt,
    startedAt: usage.createdAt,
    observedAt: new Date(usage.createdAt.getTime() + seconds * 1000),
    accruedSeconds: seconds,
    usdPerSecond: usage.usdPerSecond,
    costUsd: new Prisma.Decimal(usage.usdPerSecond).mul(seconds).toFixed(),
    rateEffectiveFrom: usage.rateEffectiveFrom,
    ...(usage.dispatchRunId !== undefined ? { dispatchRunId: usage.dispatchRunId } : {}),
  };
}

grantPaidAiPlan();

beforeEach(async () => {
  fakeOrchestrator.reset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage_slice", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  tenant = await seedTenant();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a hosted-agent container names its dispatch run on the meter row', () => {
  it('boot → poll → settle: the first accrual names the run, the settle keeps it, and the by-run read follows the row', async () => {
    const runId = await openHostedRun();
    const booted = await hostedAgentContainerService.boot(requestFor(runId));
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const session = booted.session;
    const observedAt = new Date(new Date(session.handle.createdAt).getTime() + 90_000);

    const polled = await hostedAgentContainerService.poll(
      session,
      INITIAL_HOSTED_AGENT_POLL_STATE,
      { ...FAST, now: () => observedAt },
    );
    expect(polled.done).toBe(false);

    // AC 2 — the FIRST accrual row already names the run.
    const live = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(live.dispatchRunId).toBe(runId);
    expect(live.containerStoppedAt).toBeNull();

    // AC 3 — live figures, not settled.
    const running = await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId);
    expect(running).toEqual({
      billableSeconds: 90,
      costUsd: new Prisma.Decimal(live.costUsd).toFixed(),
      settled: false,
    });

    fakeOrchestrator.completeJob(session.handle.id, { exitCode: 0 });
    const settled = await hostedAgentContainerService.settle(session, {
      done: true,
      reason: 'job_completed',
      startedAt: session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');

    // AC 2 — the settle write for the same handle keeps the run.
    const final = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(final.handleId).toBe(session.handle.id);
    expect(final.dispatchRunId).toBe(runId);
    expect(final.containerStoppedAt).not.toBeNull();

    // AC 3 — the final figures, settled.
    expect(await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId)).toEqual({
      billableSeconds: settled.billableSeconds,
      costUsd: new Prisma.Decimal(settled.costUsd).toFixed(),
      settled: true,
    });
  });

  it('run() end to end names the run too', async () => {
    const runId = await openHostedRun();
    const outcome = await hostedAgentContainerService.run(requestFor(runId), {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 0 });
      },
    });
    if (outcome.outcome !== 'settled') throw new Error(`expected settled, got ${outcome.outcome}`);
    expect(outcome.usage.dispatchRunId).toBe(runId);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.dispatchRunId).toBe(runId);
  });
});

describe('the by-run read', () => {
  it('sums every row naming the run — a retried boot has two — and is settled only when all are', async () => {
    const runId = await openHostedRun();
    const first = usageFor({ workload: 'hosted_agent', workflowJobId: null, dispatchRunId: runId });
    await ciFleetCostMeterService.recordContainerUsage(first);
    const second = usageFor({
      workload: 'hosted_agent',
      workflowJobId: null,
      dispatchRunId: runId,
    });
    await ciFleetCostMeterService.recordContainerAccrual(accrualFor(second, 30));

    expect(await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId)).toEqual({
      billableSeconds: 150,
      costUsd: new Prisma.Decimal(first.costUsd).add(accrualFor(second, 30).costUsd).toFixed(),
      settled: false,
    });

    await ciFleetCostMeterService.recordContainerUsage(second);
    const both = await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId);
    expect(both.billableSeconds).toBe(240);
    expect(both.settled).toBe(true);
  });

  it('a settle record that does not carry the run never un-names a row an accrual named', async () => {
    const runId = await openHostedRun();
    const usage = usageFor({ workload: 'hosted_agent', workflowJobId: null, dispatchRunId: runId });
    await ciFleetCostMeterService.recordContainerAccrual(accrualFor(usage, 60));
    // The reaper builds its record from the intent, not the session: no run id.
    await ciFleetCostMeterService.recordContainerUsage({ ...usage, dispatchRunId: undefined });

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.dispatchRunId).toBe(runId);
    expect(row.containerStoppedAt).not.toBeNull();
    expect(await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId)).toMatchObject({
      billableSeconds: 120,
      settled: true,
    });
  });

  // AC 4
  it('a run with no container row answers zeroes, unsettled, and never throws', async () => {
    const runId = await openHostedRun();
    const nothing = { billableSeconds: 0, costUsd: '0', settled: false };
    expect(await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId)).toEqual(nothing);
    expect(
      await ciFleetCostMeterService.getMachineTimeForDispatchRun('no-such-dispatch-run'),
    ).toEqual(nothing);
  });

  // The aggregate has no GROUP BY and COALESCEs its sums, so Postgres always hands
  // back one row with numbers in it. The read still defends against a driver that
  // returns no row or SQL NULLs rather than throwing — pinned here against a stub
  // transaction, since no real query can produce either shape.
  it('treats a missing aggregate row or NULL sums as zero and unsettled', async () => {
    const stub = (rows: unknown[]) =>
      ({ $queryRaw: async () => rows }) as unknown as Prisma.TransactionClient;
    const nothing = { billableSeconds: 0, costUsd: '0', settled: false };
    expect(await ciContainerUsageRepository.getMachineTimeForDispatchRun('r', stub([]))).toEqual(
      nothing,
    );
    expect(
      await ciContainerUsageRepository.getMachineTimeForDispatchRun(
        'r',
        stub([{ billableSeconds: null, costUsd: null, rowCount: 2, openCount: null }]),
      ),
    ).toEqual({ billableSeconds: 0, costUsd: '0', settled: true });
  });
});

describe('the pointer outlives the run, and only a hosted container sets it', () => {
  // AC 5
  it('deleting the dispatch run keeps the usage row, with dispatch_run_id nulled', async () => {
    const runId = await openHostedRun();
    await hostedAgentContainerService.run(requestFor(runId), {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 0 });
      },
    });
    expect((await adminDb.ciContainerUsage.findFirstOrThrow()).dispatchRunId).toBe(runId);

    await adminDb.dispatchRun.delete({ where: { id: runId } });

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.dispatchRunId).toBeNull();
    expect(row.billableSeconds).toBeGreaterThanOrEqual(0);
    expect(await adminDb.ciContainerUsage.count()).toBe(1);
  });

  // AC 6
  it('a CI-runner row and an agent-instance row carry null', async () => {
    await ciFleetCostMeterService.recordContainerUsage(usageFor());
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor({ workload: 'agent_instance', workflowJobId: null }),
    );
    const rows = await adminDb.ciContainerUsage.findMany({ orderBy: { workload: 'asc' } });
    expect(rows.map((r) => [r.workload, r.dispatchRunId])).toEqual([
      ['ci', null],
      ['instance', null],
    ]);
  });

  it('the rehearsal’s stand-in, which serves no run, writes an unnamed row', async () => {
    await hostedAgentContainerService.run(requestFor(null), {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 0 });
      },
    });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.workload).toBe('agent');
    expect(row.dispatchRunId).toBeNull();
  });
});
