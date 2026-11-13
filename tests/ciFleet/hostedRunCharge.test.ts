import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  HOSTED_AGENT_CHARGE_RETRY_MS,
  hostedAgentContainerService,
  type HostedAgentContainerRequest,
} from '@/lib/services/hostedAgentContainerService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { debitAgentMachine } from '@/lib/ai/motirAiClient';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import { inProcessMemoSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { inMemorySupervisionStore } from '@/lib/jobs/supervision/driver';
import { FLEET_CONTAINER_SIZE, fakeOrchestrator } from '@motir/orchestrator';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { leakedKeys } from '../helpers/payloadKeys';

// A HOSTED RUN IS CHARGED FOR ITS MACHINE TIME WHEN ITS CONTAINER SETTLES
// (Story MOTIR-683 · Subtask MOTIR-6514; `docs/decisions/hosted-agent-machine-charge.md`).
//
// Real Postgres, the fake orchestrator at the port, and motir-ai stubbed at
// `fetch` — the open-core boundary. ⚠️ THE CALLS ARE THE ASSERTION: every test
// counts the `POST /v1/credits/agent-machine` requests that left motir-core and
// reads the body each one carried.

const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 10_000 } as const;
const CHARGE_URL = 'https://ai.test/v1/credits/agent-machine';

let tenant: { organizationId: string; workspaceId: string; projectId: string };

async function seedTenant() {
  const email = `run-charge-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `C${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

async function openRun(origin: 'hosted' | 'local' = 'hosted'): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      command: 'run',
      origin,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function debitBody(credits: number, idempotent = false) {
  return {
    transactionId: `tx-${randomToken(6)}`,
    aiOrganizationId: 'ai-org',
    credits: -credits,
    balanceAfter: 1_000 - credits,
    exhausted: false,
    idempotent,
  };
}

/**
 * motir-ai at `fetch`: every agent-machine call is recorded, and `answer` decides
 * each response in turn. Any other URL is a test failure — this seam must make no
 * other motir-ai call.
 */
function stubMotirAi(answer: (call: number, body: Record<string, unknown>) => Response) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== CHARGE_URL) throw new Error(`unexpected motir-ai call: ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return answer(calls.length, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** The in-process loop's sleep: let a moment pass (so the container bills a
 *  second), then finish whatever is still running. */
function completingSleep(onSleep?: (ms: number) => void | Promise<void>) {
  return async (ms: number): Promise<void> => {
    await onSleep?.(ms);
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const id of fakeOrchestrator.liveContainerIds()) {
      fakeOrchestrator.completeJob(id, { exitCode: 0 });
    }
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
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  tenant = await seedTenant();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a settled hosted-agent container charges its run once', () => {
  // AC 2 + AC 7
  it('calls motir-ai once, with the run as externalRef and the credits for its settled seconds — and nothing of the meter', async () => {
    const runId = await openRun();
    const calls = stubMotirAi((_n, body) => json(debitBody(body['credits'] as number)));

    const outcome = await hostedAgentContainerService.run(requestFor(runId), {
      ...FAST,
      sleep: completingSleep(),
    });
    if (outcome.outcome !== 'settled') throw new Error(`expected settled, got ${outcome.outcome}`);

    const machine = await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId);
    expect(machine.settled).toBe(true);
    expect(machine.billableSeconds).toBeGreaterThan(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      coreOrganizationId: tenant.organizationId,
      coreRunId: runId,
      credits: machineCreditsFor(machine.billableSeconds),
      billableSeconds: machine.billableSeconds,
      externalRef: runId,
      reason: 'Motir agent machine time',
      // MOTIR-7240 — the run's own workspace and project, so motir-ai attributes it.
      coreWorkspaceId: tenant.workspaceId,
      coreProjectId: tenant.projectId,
    });
    // AC 7 — no meter row, cost or rate crosses the boundary. Scanned over the
    // payload's KEYS: its values are generated ids, which spell `cost` often
    // enough to eject unrelated pull requests from the merge queue (MOTIR-7349).
    expect(leakedKeys(calls[0], /cost|usdPerSecond|handleId/i)).toEqual([]);
  });

  // AC 3
  it('a second settle pass for the same run makes no second call, and a replayed call carries the same externalRef', async () => {
    const runId = await openRun();
    const calls = stubMotirAi((n, body) => json(debitBody(body['credits'] as number, n > 1)));
    const request = requestFor(runId);
    // One memo and one supervision row across both passes — what `job_step` and
    // `job_supervision` are to a job-driven run.
    const steps = inProcessMemoSteps({ run: async (_id, fn) => fn() });
    const supervisionStore = inMemorySupervisionStore();

    const first = await hostedAgentContainerService.run(request, {
      ...FAST,
      steps,
      supervisionStore,
      sleep: completingSleep(),
    });
    expect(first.outcome).toBe('settled');
    expect(calls).toHaveLength(1);

    const replayed = await hostedAgentContainerService.advance(request.runId, request, {
      ...FAST,
      steps,
      supervisionStore,
    });
    expect(replayed).toEqual(first);
    expect(calls).toHaveLength(1);

    // Called again outside the memo — a second writer, a sweep — the request is
    // the SAME charge, which motir-ai deduplicates on `externalRef`.
    const again = await hostedRunChargeService.chargeMachineTime(runId);
    expect(again).toMatchObject({ outcome: 'charged', idempotent: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });
});

describe('only a container that served a run is charged', () => {
  // AC 4
  it('a container with no dispatchRunId settles and is never charged', async () => {
    const calls = stubMotirAi(() => json(debitBody(1)));
    const outcome = await hostedAgentContainerService.run(requestFor(null), {
      ...FAST,
      sleep: completingSleep(),
    });
    expect(outcome.outcome).toBe('settled');
    expect(await adminDb.ciContainerUsage.count()).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('a run that is not hosted, or does not exist, is never charged', async () => {
    const calls = stubMotirAi(() => json(debitBody(1)));
    const localRun = await openRun('local');
    expect(await hostedRunChargeService.chargeMachineTime(localRun)).toEqual({
      outcome: 'not_charged',
      reason: 'no_run',
    });
    expect(await hostedRunChargeService.chargeMachineTime('no-such-run')).toEqual({
      outcome: 'not_charged',
      reason: 'no_run',
    });
    expect(calls).toHaveLength(0);
  });

  it('a hosted run with no settled machine time is not charged yet', async () => {
    const calls = stubMotirAi(() => json(debitBody(1)));
    const runId = await openRun();
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'not_charged',
      reason: 'not_settled',
    });
    expect(calls).toHaveLength(0);
  });

  // Coverage top-up (MOTIR-692): decision §3's "a run with 0 billable seconds
  // costs nothing" — the meter answering settled with zero seconds, distinct
  // from `not_settled` above (a meter that has not answered at all).
  it('zero settled billable seconds charges nothing, and motir-ai is never asked', async () => {
    const calls = stubMotirAi(() => json(debitBody(1)));
    const runId = await openRun();
    vi.spyOn(ciFleetCostMeterService, 'getMachineTimeForDispatchRun').mockResolvedValueOnce({
      settled: true,
      billableSeconds: 0,
      costUsd: '0',
    });
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'not_charged',
      reason: 'zero_seconds',
    });
    expect(calls).toHaveLength(0);
  });

  it('a self-hosted (non-billing) build charges nothing', async () => {
    const calls = stubMotirAi(() => json(debitBody(1)));
    const runId = await openRun();
    vi.stubEnv('MOTIR_CLOUD', 'false');
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'not_charged',
      reason: 'disabled',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('a motir-ai failure never holds the teardown, and the charge is retried', () => {
  // AC 5
  it('the container is gone and metered before the retry, and the retry charges once', async () => {
    const runId = await openRun();
    const calls = stubMotirAi((n, body) =>
      n === 1
        ? json({ code: 'internal_error', status: 503, title: 'down' }, 503)
        : json(debitBody(body['credits'] as number)),
    );
    const retryWaits: number[] = [];
    let teardownSeenBeforeRetry = false;

    const outcome = await hostedAgentContainerService.run(requestFor(runId), {
      ...FAST,
      sleep: completingSleep(async (ms) => {
        if (calls.length !== 1) return;
        retryWaits.push(ms);
        // The pass that failed to charge has ALREADY torn down, metered and
        // released: nothing about the container waits on motir-ai.
        const row = await adminDb.ciContainerUsage.findFirstOrThrow();
        teardownSeenBeforeRetry =
          fakeOrchestrator.liveContainerIds().length === 0 &&
          row.containerStoppedAt !== null &&
          (await adminDb.fleetInFlightSlot.count()) === 0;
      }),
    });

    expect(outcome.outcome).toBe('settled');
    expect(teardownSeenBeforeRetry).toBe(true);
    expect(retryWaits.length).toBeGreaterThan(0);
    expect(Math.max(...retryWaits)).toBeLessThanOrEqual(HOSTED_AGENT_CHARGE_RETRY_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('a transport failure is a retryable result, never a throw', async () => {
    const runId = await openRun();
    await hostedAgentContainerService.run(requestFor(null), { ...FAST, sleep: completingSleep() });
    // Name the settled row after the run so the by-run read is settled.
    await adminDb.ciContainerUsage.updateMany({ data: { dispatchRunId: runId } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toMatchObject({
      outcome: 'retryable',
    });
  });

  // Coverage top-up (MOTIR-692): a throw that is not an `Error` instance at
  // the transport. `lib/ai/motirAiClient.ts`'s `aiFetch` wraps EVERY transport
  // failure — `Error` or not — in `MotirAiUnavailableError(describe(err))`
  // before it ever reaches `chargeMachineTime`'s own catch, so `err instanceof
  // Error` is true here too and `detail` is that wrapped message, prefixed
  // exactly as `MotirAiUnavailableError`'s constructor formats it.
  it("a non-Error throw at the transport is still a retryable result, wrapped by motir-ai's own client", async () => {
    const runId = await openRun();
    await hostedAgentContainerService.run(requestFor(null), { ...FAST, sleep: completingSleep() });
    await adminDb.ciContainerUsage.updateMany({ data: { dispatchRunId: runId } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw 'connection reset';
      }),
    );
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'retryable',
      detail: 'motir-ai is unavailable: connection reset',
    });
  });

  // Coverage top-up (MOTIR-692): `chargeMachineTime`'s OWN `err instanceof
  // Error ? err.message : String(err)` — its NON-Error arm, unreachable through
  // the real client (`aiFetch` above always wraps first), so it needs a direct
  // mock of `debitAgentMachine` to reach at all.
  it("a debit call that throws something that isn't an Error still answers a string detail", async () => {
    const runId = await openRun();
    await hostedAgentContainerService.run(requestFor(null), { ...FAST, sleep: completingSleep() });
    await adminDb.ciContainerUsage.updateMany({ data: { dispatchRunId: runId } });
    const client = await import('@/lib/ai/motirAiClient');
    vi.spyOn(client, 'debitAgentMachine').mockRejectedValueOnce({ weird: 'not an Error' });
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'retryable',
      detail: '[object Object]',
    });
  });

  // Coverage top-up (MOTIR-692): the client itself unconfigured on this
  // deployment (no `MOTIR_AI_SERVICE_TOKEN`) — distinct from every reachability
  // failure above, and never retried since no request was even attempted.
  it('an unconfigured motir-ai client answers not_charged unconfigured, and makes no call', async () => {
    const runId = await openRun();
    await hostedAgentContainerService.run(requestFor(null), { ...FAST, sleep: completingSleep() });
    await adminDb.ciContainerUsage.updateMany({ data: { dispatchRunId: runId } });
    const calls = stubMotirAi(() => json(debitBody(1)));
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    expect(await hostedRunChargeService.chargeMachineTime(runId)).toEqual({
      outcome: 'not_charged',
      reason: 'unconfigured',
    });
    expect(calls).toHaveLength(0);
  });

  it('a refusal is not retried: one call, the outcome still settled', async () => {
    const runId = await openRun();
    const calls = stubMotirAi(() =>
      json({ code: 'not_found', status: 404, title: 'unknown organization' }, 404),
    );
    const outcome = await hostedAgentContainerService.run(requestFor(runId), {
      ...FAST,
      sleep: completingSleep(),
    });
    expect(outcome.outcome).toBe('settled');
    expect(calls).toHaveLength(1);
  });
});

// MOTIR-7240 — the run's ADDRESS rides the charge whole or not at all, and only on
// the run path. Driven at the client, where the rule lives: motir-ai refuses half an
// address, and refuses any address on an instance interval.
describe('the charge carries where the run ran', () => {
  const base = {
    coreOrganizationId: 'org_1',
    credits: 3,
    billableSeconds: 180,
    reason: 'Motir agent machine time',
  };

  it('sends both ids with a run charge, and drops a half address instead of sending it', async () => {
    const calls = stubMotirAi((_n, body) => json(debitBody(body['credits'] as number)));
    await debitAgentMachine({
      ...base,
      coreRunId: 'run_1',
      externalRef: 'run_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
    });
    await debitAgentMachine({
      ...base,
      coreRunId: 'run_2',
      externalRef: 'run_2',
      coreWorkspaceId: 'ws_1',
    });
    expect(calls[0]).toMatchObject({ coreWorkspaceId: 'ws_1', coreProjectId: 'pj_1' });
    // The charge itself still goes — it never waits on attribution.
    expect(calls[1]).toMatchObject({ coreRunId: 'run_2', credits: 3 });
    expect(calls[1]).not.toHaveProperty('coreWorkspaceId');
    expect(calls[1]).not.toHaveProperty('coreProjectId');
  });

  it('an instance-interval charge carries neither id', async () => {
    const calls = stubMotirAi((_n, body) => json(debitBody(body['credits'] as number)));
    await debitAgentMachine({
      ...base,
      instanceIntervalId: 'iv_1',
      externalRef: 'agent-instance-interval:iv_1',
    });
    expect(calls[0]).not.toHaveProperty('coreWorkspaceId');
    expect(calls[0]).not.toHaveProperty('coreProjectId');
  });
});
