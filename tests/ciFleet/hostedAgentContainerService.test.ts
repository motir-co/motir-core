import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  AGENT_MAX_POLL_INTERVAL_MS,
  HOSTED_AGENT_FLEET_TIME_BUDGETS,
  HOSTED_AGENT_MAX_TIMEOUT_MS,
  INITIAL_HOSTED_AGENT_POLL_STATE,
  hostedAgentBootStepId,
  hostedAgentContainerService,
  hostedAgentPollWaitMs,
  hostedAgentSlotTtlSeconds,
  type HostedAgentContainerRequest,
  type HostedAgentSession,
} from '@/lib/services/hostedAgentContainerService';
import {
  HostedAgentContainerRequestInvalidError,
  HostedAgentContainerUnpricedError,
} from '@/lib/ciFleet/errors';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { SUPERVISION_KINDS, isSupervisionKind } from '@/lib/jobs/supervision/driver';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { DEFAULT_FLEET_SLOT_TTL_SECONDS } from '@/lib/ciFleet/limits';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorTimeoutError,
  fakeOrchestrator,
  type OrchestratorCapacityReason,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { SHARD_PAUSE_SECONDS } from '@/lib/ciFleet/shardTargets';
import { HOSTED_AGENT_SHARD_CAPACITY_DETAIL } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { rehearseHostedAgentMeter } from '../../scripts/rehearseHostedAgentMeter';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE HOSTED-AGENT METERING SEAM (Story MOTIR-4336 · MOTIR-4713) — its own unit
// floor, against real Postgres with the fake orchestrator at the port.
//
// ⚠️ THE ROWS ARE THE ASSERTION. The meter was already proven for this workload
// with a HAND-BUILT usage record; what was missing was a writer, so every test
// here drives the seam and then reads what landed in `ci_container_usage`, its
// period rollup and `fleet_in_flight_slot`.

/** A whole supervision in milliseconds. */
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 10_000 } as const;

let tenant: { organizationId: string; workspaceId: string; projectId: string };

function requestFor(
  overrides: Partial<HostedAgentContainerRequest> = {},
): HostedAgentContainerRequest {
  return {
    dispatchId: `dispatch-${randomToken(6)}`,
    runId: `run-${randomToken(6)}`,
    dispatchRunId: null,
    ...tenant,
    repoFullName: 'motir-projects/acme-web',
    image: 'motir/stand-in@sha256:fake',
    env: {},
    region: 'iad',
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: 3_600,
    ...overrides,
  };
}

/** Finish whichever container is live, the way an exiting stand-in would. */
function completeWith(exitCode: number | null) {
  return async () => {
    const live = fakeOrchestrator.liveContainerIds();
    if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode });
  };
}

async function seedTenant() {
  const email = `agent-meter-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

grantPaidAiPlan();

beforeEach(async () => {
  fakeOrchestrator.reset();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Fleet-wide, so nothing else cleans it up for the next file. Slots first:
  // an account a slot names cannot be deleted under it.
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a settled container leaves a priced `agent` row and rollup line', () => {
  it('boot → poll → settle writes `workload = agent`, no workflow job, a real rate, and the line', async () => {
    const outcome = await hostedAgentContainerService.run(requestFor(), {
      ...FAST,
      sleep: completeWith(10),
    });

    if (outcome.outcome !== 'settled') throw new Error(`expected settled, got ${outcome.outcome}`);
    expect(outcome.exitCode).toBe(10);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({
      handleId: outcome.containerId,
      workload: 'agent',
      workflowJobId: null,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      repoFullName: 'motir-projects/acme-web',
      teardownReason: 'job_completed',
    });
    expect(row.rateEffectiveFrom).not.toBeNull();
    expect(fakeOrchestrator.specs[0]).toMatchObject({
      workload: 'hosted_agent',
      workflowJobId: null,
    });

    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup).toMatchObject({ workload: 'agent', containerCount: 1 });
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
    // The container is gone and its slot went back after the row was written.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });
});

describe('checkpoints while the container runs', () => {
  it('records a partial figure, a replayed poll adds nothing, and a settle BELOW it reconciles downward', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const session = booted.session;
    const observedAt = new Date(new Date(session.handle.createdAt).getTime() + 90_000);
    const options = { ...FAST, now: () => observedAt };

    const first = await hostedAgentContainerService.poll(
      session,
      INITIAL_HOSTED_AGENT_POLL_STATE,
      options,
    );
    expect(first.done).toBe(false);
    const partial = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(partial.billableSeconds).toBe(90);
    expect(partial.containerStoppedAt).toBeNull();

    await hostedAgentContainerService.poll(session, INITIAL_HOSTED_AGENT_POLL_STATE, options);
    const afterReplay = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(afterReplay).toMatchObject({ containerSeconds: 90, containerCount: 1 });

    // The container really stopped a moment after boot, far below the checkpoint
    // the injected clock produced — so the settle's delta is NEGATIVE.
    fakeOrchestrator.completeJob(session.handle.id, { exitCode: 0 });
    const settled = await hostedAgentContainerService.settle(session, {
      done: true,
      reason: 'job_completed',
      startedAt: session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });
    if (settled.outcome !== 'settled') throw new Error('expected settled');
    expect(settled.billableSeconds).toBeLessThan(90);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
    expect(rollup.containerCount).toBe(1);
  });
});

describe('the cadence is this workload’s own', () => {
  it('backs off to a minute, never past it, and never faster than the index loop’s ceiling', () => {
    const waits = Array.from({ length: 12 }, (_, i) => hostedAgentPollWaitMs(i + 1));
    expect(waits[0]).toBe(HOSTED_AGENT_FLEET_TIME_BUDGETS.pollIntervalMs);
    expect(Math.max(...waits)).toBe(AGENT_MAX_POLL_INTERVAL_MS);
    expect(waits.at(-1)).toBe(AGENT_MAX_POLL_INTERVAL_MS);
    expect(AGENT_MAX_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(
      HOSTED_AGENT_FLEET_TIME_BUDGETS.indexLoopMaxPollIntervalMs,
    );
    // A test seam may shorten the ceiling but not lengthen it.
    expect(hostedAgentPollWaitMs(20, { maxPollIntervalMs: 10 * 60_000 })).toBe(
      AGENT_MAX_POLL_INTERVAL_MS,
    );
  });

  it('the poll ceiling clears the longest legal run at the backed-off cadence', () => {
    expect(HOSTED_AGENT_FLEET_TIME_BUDGETS.maxPollIterations).toBeGreaterThan(
      HOSTED_AGENT_MAX_TIMEOUT_MS / AGENT_MAX_POLL_INTERVAL_MS,
    );
  });
});

describe('the fleet slot is held for exactly as long as a container exists', () => {
  it('sizes its TTL from the run timeout, never the fleet-wide default', async () => {
    const reserve = vi.spyOn(fleetCeilingService, 'reserve');
    const request = requestFor({ timeoutSeconds: 8 * 60 * 60 });
    const booted = await hostedAgentContainerService.boot(request);
    expect(booted.phase).toBe('supervising');

    expect(reserve.mock.calls[0]![0]).toMatchObject({
      workload: 'hosted_agent',
      ref: request.dispatchId,
      ownerRef: request.runId,
      ttlSeconds: hostedAgentSlotTtlSeconds(8 * 60 * 60),
    });
    expect(hostedAgentSlotTtlSeconds(8 * 60 * 60)).toBeGreaterThan(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    const slot = await adminDb.fleetInFlightSlot.findFirstOrThrow();
    expect(slot).toMatchObject({ workload: 'hosted_agent', ref: request.dispatchId });
  });

  it('gives the slot back when the provision is refused', async () => {
    fakeOrchestrator.failNextProvision('no capacity');
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('keeps the slot when teardown fails — the container may still be spending', async () => {
    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    fakeOrchestrator.failNextTeardown();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: booted.session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });

    expect(outcome.outcome).toBe('teardown_failed');
    expect(error).toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count()).toBe(1);
  });

  it('defers without booting when the fleet is at its ceiling', async () => {
    vi.spyOn(fleetCeilingService, 'reserve').mockResolvedValue({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: 'full',
    });
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'admission_deferred', reason: 'fleet_ceiling' },
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('an unpriced machine class is refused BEFORE anything is spent', () => {
  it('throws the typed error with no slot taken and nothing provisioned', async () => {
    const unpriced = { cpuKind: 'performance' as const, cpus: 4, memoryMb: 16_384 };
    await expect(
      hostedAgentContainerService.boot(requestFor({ size: unpriced })),
    ).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    await expect(
      hostedAgentContainerService.boot(requestFor({ region: 'syd' })),
    ).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('refuses a timeout outside the seam’s bounds', async () => {
    for (const timeoutSeconds of [0, -1, HOSTED_AGENT_MAX_TIMEOUT_MS / 1000 + 1]) {
      await expect(
        hostedAgentContainerService.boot(requestFor({ timeoutSeconds })),
      ).rejects.toBeInstanceOf(HostedAgentContainerRequestInvalidError);
    }
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('a run over a card set attributes across repository slices', () => {
  const T0 = new Date('2026-09-10T12:00:00.000Z');

  async function runLasting(seconds: number, request: HostedAgentContainerRequest) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const booted = await hostedAgentContainerService.boot(request);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    vi.setSystemTime(new Date(T0.getTime() + seconds * 1000));
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 0 });
    const outcome = await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: T0.toISOString(),
      exitCode: 0,
      failureDetail: null,
    });
    if (outcome.outcome !== 'settled') throw new Error('expected settled');
    return outcome;
  }

  it('two slices plus idle sum to the handle’s billable seconds, and the row names no single repo', async () => {
    const outcome = await runLasting(
      600,
      requestFor({
        slices: [
          {
            sliceRef: 'card-1',
            projectId: tenant.projectId,
            repoFullName: 'acme/web',
            seconds: 200,
          },
          {
            sliceRef: 'card-2',
            projectId: tenant.projectId,
            repoFullName: 'acme/api',
            seconds: 300,
          },
        ],
      }),
    );

    expect(outcome.billableSeconds).toBe(600);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.repoFullName).toBeNull();
    const slices = await adminDb.ciContainerUsageSlice.findMany({ orderBy: { sliceRef: 'asc' } });
    expect(slices.reduce((sum, s) => sum + s.seconds, 0)).toBe(row.billableSeconds);
    expect(slices.find((s) => s.kind === 'idle')?.seconds).toBe(100);
    // Slices divide the total; the line is unchanged by the split.
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(600);
  });

  it('a one-repo run writes the one-repo row and no slices', async () => {
    await runLasting(120, requestFor());
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.repoFullName).toBe('motir-projects/acme-web');
    expect(await adminDb.ciContainerUsageSlice.count()).toBe(0);
    // Money stays decimal: 120 s at the fake's iad rate, exactly.
    expect(
      new Prisma.Decimal(row.costUsd).equals(new Prisma.Decimal('0.000031636049').mul(120)),
    ).toBe(true);
  });
});

describe('the abandoned-supervision sweep routes a `hosted-agent` row to THIS service', () => {
  it('registers the kind, and settles an abandoned one here with `job_timed_out`', async () => {
    expect(SUPERVISION_KINDS).toContain('hosted-agent');
    expect(isSupervisionKind('hosted-agent')).toBe(true);
    await truncateJobRuns();

    const booted = await hostedAgentContainerService.boot(requestFor());
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const session: HostedAgentSession = booted.session;
    const run: JobQueueRun = await adminDb.jobQueueRun.create({
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
    const settle = vi.spyOn(hostedAgentContainerService, 'settle');

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({ done: true, reason: 'job_timed_out' });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({ workload: 'agent', teardownReason: 'job_timed_out' });
    await truncateJobRuns();
  });
});

describe('the rehearsal command', () => {
  const args = () => ({ ...tenant, repoFullName: 'motir-projects/acme-web' });

  it('off-cloud it prints that the meter is disabled and provisions nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const rehearsal = await rehearseHostedAgentMeter(args());
    expect(rehearsal.outcome).toBeNull();
    expect(rehearsal.text).toContain('disabled');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('boots the stand-in with an EMPTY env and prints its usage row and the `agent` line', async () => {
    const rehearsal = await rehearseHostedAgentMeter({
      ...args(),
      options: { ...FAST, sleep: completeWith(10) },
    });

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toEqual({});
    if (rehearsal.outcome?.outcome !== 'settled') throw new Error('expected settled');
    expect(rehearsal.agentLine).toMatchObject({ workload: 'agent', containerCount: 1 });
    // Money reaches the output as the repository's decimal string, verbatim.
    expect(rehearsal.text).toContain(`cost usd         ${rehearsal.outcome.usage.costUsd}`);
    expect(rehearsal.text).toContain(`$${rehearsal.agentLine!.costUsd}`);
    expect(rehearsal.text).toContain('workload         hosted_agent');
  });
});

// ── ON THE ACCOUNT ITS SLOT CHOSE (MOTIR-9423) ────────────────────────────────
// The agent runner's switch is on, so `reserve` names an account; every account
// has its OWN fake (`fakeOrchestratorForShard`), and the process-wide fake is
// the legacy target, which an account boot must never touch.

const NOW = new Date('2026-10-24T12:00:00.000Z');

async function agentAccount(
  machineLimit = 5,
  location: 'fly' | 'aws' = 'fly',
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `agents-${slug}`,
      fleetKind: 'hosted_agent',
      provider: location,
      state: 'active',
      githubOrg: 'motir-projects',
      githubInstallationId: '556677',
      ...(location === 'fly'
        ? { flyOrg: 'motir', flyApp: `motir-agents-${slug}`, flyRegion: 'iad' }
        : { awsAccountId: '123456789012', awsRegion: 'us-east-1' }),
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
    },
  });
}

const accountFake = (shard: FleetShard) => fakeOrchestratorForShard(shard.id);
const slotOf = (request: HostedAgentContainerRequest) =>
  adminDb.fleetInFlightSlot.findUnique({
    where: { workload_ref: { workload: 'hosted_agent', ref: request.dispatchId } },
  });

/** The admission-time mint, counted, returning a fresh key each call. */
function countingMint() {
  let calls = 0;
  const mint = vi.fn(async () => {
    calls += 1;
    return { MOTIR_RUN_KEY: `sk-run-${calls}`, MOTIR_RUN_TOKEN: `rt-${calls}` };
  });
  return { mint, calls: () => calls };
}

describe('a hosted run boots on the account its slot chose (MOTIR-9423)', () => {
  beforeEach(() => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  });

  it('switch off: the legacy target, the request’s image and region, and no shardId', async () => {
    const a = await agentAccount();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
    const request = requestFor();
    const booted = await hostedAgentContainerService.boot(request);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]).toMatchObject({ image: request.image, region: 'iad' });
    expect(accountFake(a).provisioned).toEqual([]);
    expect('shardId' in booted.session.handle).toBe(false);
    expect((await slotOf(request))?.fleetShardId).toBeNull();
  });

  it('switch off: an account-less capacity refusal still ends provision_failed, as on main', async () => {
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
    fakeOrchestrator.failNextProvisionForCapacity('out_of_stock');
    const booted = await hostedAgentContainerService.boot(requestFor());
    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('switch on: provisions only on the chosen account, with its image and location', async () => {
    const a = await agentAccount(5);
    const b = await agentAccount(1);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const request = requestFor({ image: 'legacy/never@sha256:fake', region: 'syd' });

    const booted = await hostedAgentContainerService.boot(request);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');

    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(accountFake(b).provisioned).toEqual([]);
    expect(accountFake(a).specs).toHaveLength(1);
    // The fake orchestrator's image for every provider; the account's own region.
    expect(accountFake(a).specs[0]).toMatchObject({
      image: 'motir/hosted-agent@sha256:fake',
      region: 'iad',
    });
    expect(booted.session.handle.shardId).toBe(a.id);
    expect((await slotOf(request))?.fleetShardId).toBe(a.id);
  });

  it('an account with no rate for its region is refused unpriced, after giving the slot back', async () => {
    const aws = await agentAccount(5, 'aws');
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const request = requestFor();

    const refused = hostedAgentContainerService.boot(request);
    await expect(refused).rejects.toBeInstanceOf(HostedAgentContainerUnpricedError);
    await expect(refused).rejects.toMatchObject({ provider: 'fake', region: 'us-east-1' });
    expect(accountFake(aws).provisioned).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await slotOf(request)).toBeNull();
  });

  it.each(['quota_exceeded', 'out_of_stock', 'throttled'] as OrchestratorCapacityReason[])(
    'a capacity refusal (%s) pauses A, moves the slot to B, and boots there with the same env',
    async (capacityReason) => {
      const a = await agentAccount(5);
      const b = await agentAccount(3);
      vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
      accountFake(a).failNextProvisionForCapacity(capacityReason);
      const attempted = vi.spyOn(accountFake(a), 'provision');
      const { mint, calls } = countingMint();
      const request = requestFor();

      const booted = await hostedAgentContainerService.boot(request, {
        envAtAdmission: mint,
        now: () => NOW,
      });
      if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');

      expect(calls()).toBe(1);
      const envOnA = attempted.mock.calls[0]![0].env;
      const envOnB = accountFake(b).specs[0]!.env;
      expect(envOnB['MOTIR_RUN_KEY']).toBe(envOnA['MOTIR_RUN_KEY']);
      expect(envOnB['MOTIR_RUN_TOKEN']).toBe(envOnA['MOTIR_RUN_TOKEN']);
      expect(envOnB).toMatchObject({ MOTIR_RUN_KEY: 'sk-run-1', MOTIR_RUN_TOKEN: 'rt-1' });

      expect(accountFake(a).liveContainerIds()).toEqual([]);
      expect(accountFake(b).liveContainerIds()).toHaveLength(1);
      expect(fakeOrchestrator.provisioned).toEqual([]);
      expect(booted.session.handle.shardId).toBe(b.id);
      expect((await slotOf(request))?.fleetShardId).toBe(b.id);
      expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
        admissionPausedUntil: new Date(NOW.getTime() + SHARD_PAUSE_SECONDS * 1000),
        admissionPausedReason: 'capacity_refused',
      });
    },
  );

  it.each([
    ['a timeout', new OrchestratorTimeoutError('fly', 30_000)],
    ['a 503', new OrchestratorApiError('fly', 503, 'unavailable')],
    ['no answer at all', new OrchestratorApiError('fly', null, 'unreachable')],
  ])('an outage (%s) moves the boot with reason provider_unavailable', async (_case, error) => {
    const a = await agentAccount(5);
    const b = await agentAccount(3);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    vi.spyOn(accountFake(a), 'provision').mockRejectedValueOnce(error);
    const request = requestFor();

    const booted = await hostedAgentContainerService.boot(request, { now: () => NOW });
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    expect(booted.session.handle.shardId).toBe(b.id);
    expect((await slotOf(request))?.fleetShardId).toBe(b.id);
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      admissionPausedReason: 'provider_unavailable',
    });
  });

  it('every account refuses for capacity: the slot is gone and the boot defers shard_capacity', async () => {
    const a = await agentAccount(5);
    const b = await agentAccount(3);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    accountFake(a).failNextProvisionForCapacity('out_of_stock');
    accountFake(b).failNextProvisionForCapacity('quota_exceeded');
    const request = requestFor();

    const booted = await hostedAgentContainerService.boot(request, { now: () => NOW });

    expect(booted).toEqual({
      phase: 'terminal',
      outcome: {
        outcome: 'admission_deferred',
        reason: 'shard_capacity',
        detail: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
      },
    });
    expect(await slotOf(request)).toBeNull();
    expect(accountFake(a).liveContainerIds()).toEqual([]);
    expect(accountFake(b).liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it.each([
    [
      'an unpullable image',
      new OrchestratorImageUnpullableError('fly', 400, 'ghcr.io/x@sha256:1', 'denied'),
      'image_unpullable',
    ],
    ['a 400', new OrchestratorApiError('fly', 400, 'bad spec'), 'provision_failed'],
  ])(
    '%s from an account does not move: the slot goes back and the outcome is today’s',
    async (_c, error, outcome) => {
      const a = await agentAccount(5);
      const b = await agentAccount(3);
      vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
      vi.spyOn(accountFake(a), 'provision').mockRejectedValueOnce(error);
      const request = requestFor();

      const booted = await hostedAgentContainerService.boot(request);
      expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome } });
      expect(await slotOf(request)).toBeNull();
      expect(accountFake(b).provisioned).toEqual([]);
      expect(
        (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).admissionPausedUntil,
      ).toBeNull();
    },
  );

  it('a move racing a new admission for the one free slot left: no account over, one deferred', async () => {
    const a = await agentAccount(1);
    const b = await agentAccount(1);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    accountFake(a).failNextProvisionForCapacity('out_of_stock');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await seedTenant();

    const results = await Promise.all([
      hostedAgentContainerService.boot(requestFor()),
      hostedAgentContainerService.boot(requestFor(other)),
    ]);

    const phases = results.map((r) => r.phase).sort();
    expect(phases).toEqual(['supervising', 'terminal']);
    expect(results.find((r) => r.phase === 'terminal')).toMatchObject({
      outcome: { outcome: 'admission_deferred', reason: 'shard_capacity' },
    });
    for (const shard of [a, b]) {
      expect(
        await adminDb.fleetInFlightSlot.count({ where: { fleetShardId: shard.id } }),
      ).toBeLessThanOrEqual(1);
    }
    const live =
      accountFake(a).liveContainerIds().length + accountFake(b).liveContainerIds().length;
    expect(live).toBe(1);
  });

  it('never re-points a slot another run owns', async () => {
    const a = await agentAccount(5);
    const b = await agentAccount(5);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref: 'dispatch-shared',
          ownerRef: 'run-owner',
          organizationId: tenant.organizationId,
          fleetShardId: a.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        tx,
      ),
    );

    const next = await fleetCeilingService.moveHostedSlotAfterRefusal(
      { ref: 'dispatch-shared', ownerRef: 'run-intruder', organizationId: tenant.organizationId },
      a.id,
      'capacity_refused',
      new Set([a.id]),
      NOW,
    );

    expect(next).toBeNull();
    const row = await adminDb.fleetInFlightSlot.findFirstOrThrow({
      where: { ref: 'dispatch-shared' },
    });
    expect(row).toMatchObject({ ownerRef: 'run-owner', fleetShardId: a.id });
    expect(b.id).not.toBe(a.id);
  });

  it('a session memoized before accounts (no handle.shardId) still round-trips as legacy', () => {
    const memo: HostedAgentSession = JSON.parse(
      JSON.stringify({
        handle: { provider: 'fake', id: 'fake-1', region: 'iad', createdAt: NOW.toISOString() },
        bootedAt: NOW.toISOString(),
        dispatchId: 'dispatch-old',
        runId: 'run-old',
        dispatchRunId: null,
        timeoutSeconds: 3_600,
        size: FLEET_CONTAINER_SIZE,
        attribution: {
          orgId: 'org',
          workspaceId: 'ws',
          projectId: 'p',
          repoFullName: 'motir-projects/acme-web',
        },
      }),
    ) as HostedAgentSession;
    expect(memo.handle.shardId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(memo))).toEqual(memo);
  });
});
