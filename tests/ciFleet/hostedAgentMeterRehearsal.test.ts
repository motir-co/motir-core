import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  AGENT_MAX_POLL_INTERVAL_MS,
  hostedAgentBootStepId,
  hostedAgentContainerService,
  hostedAgentPollWaitMs,
  type HostedAgentContainerRequest,
  type HostedAgentContainerOutcome,
} from '@/lib/services/hostedAgentContainerService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { inMemorySupervisionStore } from '@/lib/jobs/supervision/driver';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  FLEET_CONTAINER_SIZE,
  buildContainerUsage,
  fakeOrchestrator,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import { buildFleetCostReadout } from '../../scripts/fleetCostReadoutQuery';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE END-TO-END REHEARSAL (Story MOTIR-4336 · MOTIR-4717) — a hosted-agent
// container ran → rows were written while it ran and when it stopped → "what did
// agent hosting cost?" is answered, over real Postgres with only the machine faked.
// The twin of MOTIR-4545's index rehearsal, with the two cases this line has and
// the index line does not: an HOURS-long run whose checkpoints are the meter, and a
// run over a card set that spans repositories.
//
// ⚠️ THE LANE, READ BEFORE A LINE WAS WRITTEN (AC 6). This file mounts in the
// default `vitest.config.ts` project, where `tests/helpers/perWorkerDb.ts` gives
// each worker its own database, beside `codeGraphIndexDispatch.test.ts` and
// `ciFleetCostMeterService.test.ts` — the two files that already reach the meter
// and the fake orchestrator from here. The seam mounts in it with nothing added:
// the fake is selected through the shipped `MOTIR_FLEET_ORCHESTRATOR=fake` seam, the
// meter writes under `MOTIR_CLOUD=true`, and the readout's callable core
// (`scripts/fleetCostReadoutQuery.ts`, MOTIR-4540 — MERGED) is a plain import.
//
// ⚠️ EVERY FIGURE ASSERTED IS READ THROUGH THE SHIPPED OUTPUT PATH (AC 5):
// `ciFleetCostMeterService.getOrgPeriodCostByWorkload` and the readout's core. The
// expected values come from the container itself — the controlled clock and the
// settle's own record — never from a query this test wrote.
//
// ⚠️ It boots no real container. That a REAL fleet machine wrote an `agent` row is
// MOTIR-4715's claim, not this file's. Internal COGS; nothing here is a charge.

/** A period with no agent container in it — well before anything this file runs. */
const EMPTY_PERIOD = new Date('2026-08-15T12:00:00.000Z');

let tenant: { organizationId: string; workspaceId: string; projectId: string };

function requestFor(
  overrides: Partial<HostedAgentContainerRequest> = {},
): HostedAgentContainerRequest {
  return {
    dispatchId: `rehearsal-${randomToken(6)}`,
    runId: `rehearsal-run-${randomToken(6)}`,
    dispatchRunId: null,
    ...tenant,
    repoFullName: 'motir-projects/acme-web',
    image: 'motir/stand-in@sha256:fake',
    env: {},
    region: 'iad',
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: 8 * 60 * 60,
    ...overrides,
  };
}

async function agentLineAt(at: Date) {
  const lines = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(tenant.organizationId, at);
  return { lines, agent: lines.find((line) => line.workload === 'agent') };
}

/** A neighbour on the shared fleet, written through the real meter so the
 *  disjointness assertion is about real rows, not a fixture shaped like them. */
async function seedNeighbour(workload: FleetWorkloadKind, seconds: number, at: Date) {
  await ciFleetCostMeterService.recordContainerUsage(
    buildContainerUsage({
      handle: { provider: 'fake', id: `neighbour-${workload}`, region: 'iad', createdAt: at },
      attribution: {
        orgId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        projectId: tenant.projectId,
        repoFullName: 'motir-projects/acme-web',
        workload,
        workflowJobId: workload === 'ci_runner' ? 42 : null,
        size: FLEET_CONTAINER_SIZE,
        observedStartedAt: null,
      },
      reason: 'job_completed',
      lifecycle: {
        createdAt: at,
        startedAt: at,
        stoppedAt: new Date(at.getTime() + seconds * 1000),
        terminalState: 'destroyed',
      },
    }),
  );
}

grantPaidAiPlan();

beforeEach(async () => {
  fakeOrchestrator.reset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage_slice", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateAuthTables();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');

  const email = `agent-rehearsal-${randomToken(6)}@example.com`;
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
  tenant = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the HEALTHY run — boot → checkpoints → settle → the question answered (AC 1, 2)', () => {
  it('the line grows between checkpoints, a replay adds nothing, the settle reconciles, and `agent` is disjoint from `ci` and `instance`', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const { session } = booted;
    const started = new Date(session.handle.createdAt);
    await seedNeighbour('ci_runner', 100, started);
    await seedNeighbour('agent_instance', 200, started);

    const at = (seconds: number) => ({ now: () => new Date(started.getTime() + seconds * 1000) });

    // Checkpoint 1 and 2: the figure is absolute-to-date and the LINE moves with it.
    await hostedAgentContainerService.poll(session, undefined, at(60));
    expect((await agentLineAt(started)).agent).toMatchObject({
      containerSeconds: 60,
      containerCount: 1,
    });
    await hostedAgentContainerService.poll(session, undefined, at(180));
    expect((await agentLineAt(started)).agent).toMatchObject({
      containerSeconds: 180,
      containerCount: 1,
    });
    // A REPLAYED poll — the ordinary durable-step path — adds nothing.
    await hostedAgentContainerService.poll(session, undefined, at(180));
    expect((await agentLineAt(started)).agent).toMatchObject({ containerSeconds: 180 });

    // The container really stopped moments after boot, BELOW the last checkpoint:
    // the settle's signed delta takes the line back down to the true total.
    fakeOrchestrator.completeJob(session.handle.id, { exitCode: 10 });
    const settled = await hostedAgentContainerService.settle(session, {
      done: true,
      reason: 'job_completed',
      startedAt: session.handle.createdAt,
      exitCode: 10,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');
    expect(settled.billableSeconds).toBeLessThan(180);

    const { lines, agent } = await agentLineAt(started);
    expect(agent).toMatchObject({ containerSeconds: settled.billableSeconds, containerCount: 1 });
    expect(new Prisma.Decimal(agent!.costUsd).equals(new Prisma.Decimal(settled.costUsd))).toBe(
      true,
    );
    // DISJOINT, not merely present: each neighbour keeps exactly its own figure.
    expect(lines.map((line) => line.workload)).toEqual(['agent', 'ci', 'instance']);
    expect(lines.find((line) => line.workload === 'ci')).toMatchObject({ containerSeconds: 100 });
    expect(lines.find((line) => line.workload === 'instance')).toMatchObject({
      containerSeconds: 200,
    });

    // The readout's callable core (MOTIR-4540, merged) answers identically, and its
    // platform-wide split carries the container on the TENANT side.
    const readout = await buildFleetCostReadout({
      organizationId: tenant.organizationId,
      at: started,
    });
    expect(readout.input?.org?.lines.find((line) => line.workload === 'agent')).toEqual(agent);
    expect(
      readout.input?.metaSplit.find((row) => !row.isMeta && row.workload === 'agent'),
    ).toMatchObject({ containerCount: 1, containerSeconds: settled.billableSeconds });
  });
});

describe('the LONG run — hours, supervised pass by pass (AC 3)', () => {
  it('bounds the provider reads by the cadence, and the line never lags the container by more than one interval', async () => {
    const HOURS = 3;
    // Pinned mid-month: the line is read per MONTHLY period, so a start within
    // HOURS of a month's end would read the next month's empty line (MOTIR-7070).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    const store = inMemorySupervisionStore();
    const memo = new Map<string, unknown>();
    const steps = {
      run: async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
        if (memo.has(id)) return memo.get(id) as T;
        // Round-tripped through JSON as `job_step` does, so the session a later
        // pass replays is the serialized one.
        const value = JSON.parse(JSON.stringify(await fn())) as T;
        memo.set(id, value);
        return value;
      },
    };
    fakeOrchestrator.setBootBehaviour('hang');
    const request = requestFor();
    const clock = { ms: Date.now() };
    const options = { steps, supervisionStore: store, now: () => new Date(clock.ms) };
    const describeSpy = vi.spyOn(fakeOrchestrator, 'describe');

    let startedMs: number | null = null;
    let maxLagSeconds = 0;
    let outcome: HostedAgentContainerOutcome | null = null;
    for (let pass = 0; pass < 2_000 && !outcome; pass += 1) {
      try {
        outcome = await hostedAgentContainerService.advance(request.runId, request, options);
      } catch (err) {
        if (!isJobRunDefer(err)) throw err;
        const session = (
          memo.get(hostedAgentBootStepId(request.dispatchId)) as {
            session: { handle: { createdAt: string } };
          }
        ).session;
        startedMs ??= new Date(session.handle.createdAt).getTime();
        // What the line says NOW, against what the container has truly accrued NOW.
        // Read in the container's OWN period: its accrual stays in the period its
        // run started in, so reading at `clock.ms` would switch to the next, empty
        // month whenever the simulated hours cross a month boundary.
        const { agent } = await agentLineAt(new Date(startedMs));
        const trueSeconds = Math.ceil((clock.ms - startedMs) / 1000);
        maxLagSeconds = Math.max(maxLagSeconds, trueSeconds - (agent?.containerSeconds ?? 0));
        // Jump to exactly the instant the pass deferred to — the queue's own wait.
        clock.ms = err.resumeAt.getTime();
        if (clock.ms - startedMs >= HOURS * 60 * 60_000) {
          fakeOrchestrator.completeJob(fakeOrchestrator.liveContainerIds()[0]!, { exitCode: 0 });
        }
      }
    }
    if (outcome?.outcome !== 'settled') throw new Error('the supervision never settled');

    // THE CADENCE BOUND: after the backoff ramp, at most one read per minute.
    const rampPolls = Array.from({ length: 20 }, (_, i) => hostedAgentPollWaitMs(i + 1)).filter(
      (ms) => ms < AGENT_MAX_POLL_INTERVAL_MS,
    ).length;
    const elapsedMs = clock.ms - startedMs!;
    const boundedReads = Math.ceil(elapsedMs / AGENT_MAX_POLL_INTERVAL_MS) + rampPolls + 1;
    expect(describeSpy.mock.calls.length).toBeLessThanOrEqual(boundedReads);
    expect(describeSpy.mock.calls.length).toBeGreaterThan(HOURS * 60 - 5);

    // THE LAG BOUND: the line was never more than one interval behind the truth.
    expect(maxLagSeconds).toBeLessThanOrEqual(AGENT_MAX_POLL_INTERVAL_MS / 1000);
    // And the settle reconciled the long accrual to one row, one container.
    const { agent } = await agentLineAt(new Date(startedMs!));
    expect(agent).toMatchObject({ containerCount: 1, containerSeconds: outcome.billableSeconds });
  });
});

describe('the edge runs, each stating what the reader sees (AC 4)', () => {
  it('NEVER-STARTED: a zero-second row exists, and the line COUNTS it', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      pollIntervalMs: 1,
      maxPollIntervalMs: 1,
      bootDeadlineMs: 0,
    });
    if (outcome.outcome !== 'settled') throw new Error('expected settled');
    expect(outcome.reason).toBe('provision_failed');

    // What the reader sees: one agent container, zero seconds, zero cost — a
    // container that was provisioned and never ran, not an absent line.
    const { agent } = await agentLineAt(outcome.usage.stoppedAt);
    expect(agent).toMatchObject({ containerCount: 1, containerSeconds: 0 });
    expect(new Prisma.Decimal(agent!.costUsd).isZero()).toBe(true);
  });

  it('ABANDONED: the supervisor dies mid-run, the real sweep settles it through the seam, and the line reconciles', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const { session } = booted;
    const started = new Date(session.handle.createdAt);
    // One checkpoint was written before the supervisor died.
    await hostedAgentContainerService.poll(session, undefined, {
      now: () => new Date(started.getTime() + 240_000),
    });
    expect((await agentLineAt(started)).agent).toMatchObject({ containerSeconds: 240 });

    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.hosted-agent',
        eventName: 'hosted-agent/run.requested',
        workspaceId: tenant.workspaceId,
        runAt: new Date(Date.now() - 60 * 60_000),
        maxAttempts: 3,
        state: 'failed',
      },
    });
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: session.dispatchId,
          kind: 'hosted-agent',
          nextPollAt: new Date(Date.now() - 40 * 60_000),
          workspaceId: tenant.workspaceId,
        },
        tx,
      );
      await jobStepRepository.create(
        {
          runId: run.id,
          stepId: hostedAgentBootStepId(session.dispatchId),
          kind: 'run',
          result: { phase: 'supervising', session } as unknown as Prisma.InputJsonValue,
          workspaceId: tenant.workspaceId,
        },
        tx,
      );
    });

    expect((await supervisionSweepService.sweepAbandoned()).settled).toBe(1);

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({ workload: 'agent', teardownReason: 'job_timed_out' });
    // What the reader sees: ONE container, at the settled total — the checkpoint's
    // 240 s corrected to what the teardown measured, never added to it.
    const { agent } = await agentLineAt(started);
    expect(agent).toMatchObject({ containerCount: 1, containerSeconds: row.billableSeconds });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('TWO-REPO: the slices sum with idle to the handle, and the line is unchanged by the split', async () => {
    const T0 = new Date('2026-09-10T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const booted = await hostedAgentContainerService.boot(
      requestFor({
        slices: [
          {
            sliceRef: 'card-a',
            projectId: tenant.projectId,
            repoFullName: 'acme/web',
            seconds: 900,
          },
          {
            sliceRef: 'card-b',
            projectId: tenant.projectId,
            repoFullName: 'acme/api',
            seconds: 1_500,
          },
        ],
      }),
    );
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    vi.setSystemTime(new Date(T0.getTime() + 3_000_000));
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 0 });
    const settled = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: T0.toISOString(),
      exitCode: 0,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');

    const slices = await adminDb.ciContainerUsageSlice.findMany();
    expect(slices.reduce((sum, slice) => sum + slice.seconds, 0)).toBe(settled.billableSeconds);
    expect(slices.find((slice) => slice.kind === 'idle')?.seconds).toBe(3_000 - 2_400);
    // What the reader sees: the `agent` line is the HANDLE's total. Slices divide
    // it; they never add a second figure beside it.
    const { agent } = await agentLineAt(T0);
    expect(agent).toMatchObject({ containerCount: 1, containerSeconds: 3_000 });
  });

  it('EMPTY PERIOD: with no agent container in it, the line is ABSENT — not a zero row', async () => {
    await seedNeighbour('ci_runner', 100, EMPTY_PERIOD);
    const { lines, agent } = await agentLineAt(EMPTY_PERIOD);
    // What the reader sees: a `ci` line and nothing for `agent` — the rollup holds
    // rows for what ran, and a zero would state a fact the table does not contain.
    expect(agent).toBeUndefined();
    expect(lines.map((line) => line.workload)).toEqual(['ci']);
  });
});
