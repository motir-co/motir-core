import { generateKeyPairSync } from 'node:crypto';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_CONTAINER_SIZE, fakeOrchestrator } from '@motir/orchestrator';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { inMemorySupervisionStore, type SupervisionStore } from '@/lib/jobs/supervision/driver';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import type { HostedRunSuperviseData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  HOSTED_AGENT_MAX_TIMEOUT_MS,
  hostedAgentBootStepId,
} from '@/lib/services/hostedAgentContainerService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A HOSTED RUN ENDS CLEANLY (Story MOTIR-683 · MOTIR-6450) — every way a run
// ends goes through ONE end path, which leaves no machine running and nothing
// alive, and which never moves a card or links a pull request itself: the CLI in
// the container does both on success, and no other end moves anything (the
// run-dies decision).
//
// The run is started for real (`hostedRunService.start`, the fake orchestrator,
// `fetch` stubbed at motir-ai, the gateway and GitHub), supervised pass by pass
// the way the durable job drives it, and ended by each of its six triggers.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));
const { POST: cancelRoute } = await import('@/app/api/dispatch-runs/[id]/cancel/route');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const MINUTE = 60_000;
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 600 * MINUTE } as const;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** What the stubbed gateway and GitHub were asked to revoke. */
let revokedKeys: string[] = [];
let revokedGitTokens: string[] = [];
let failGatewayRevoke = false;
let failGitRevoke = false;
/** Every machine charge motir-ai was asked for, in order — and, as motir-ai does,
 *  the run ids it has already debited (it dedupes on `externalRef`). */
let machineCharges: Array<Record<string, unknown>> = [];
let debitedRuns = new Set<string>();

function stubHttp(): void {
  machineCharges = [];
  debitedRuns = new Set<string>();
  revokedKeys = [];
  revokedGitTokens = [];
  failGatewayRevoke = false;
  failGitRevoke = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const headers = new Headers(init?.headers);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/agent-models`) {
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, { balanceCredits: 100, hasCredits: true, mayRun: true });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        machineCharges.push(body ?? {});
        const ref = String(body?.externalRef);
        const idempotent = debitedRuns.has(ref);
        debitedRuns.add(ref);
        return json(200, {
          balanceAfter: 90,
          credits: 1,
          billableSeconds: 1,
          exhausted: false,
          idempotent,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, { key: 'sk-run', runRef: body?.runRef, expiresAt: body?.expiresAt });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        if (failGatewayRevoke) return json(503, { error: 'gateway down' });
        const ref = decodeURIComponent(url.split('/').pop() ?? '');
        const already = revokedKeys.includes(ref);
        revokedKeys.push(ref);
        return json(200, { runRef: ref, revoked: already ? 0 : 1 });
      }
      if (url === 'https://api.github.com/installation/token' && method === 'DELETE') {
        if (failGitRevoke) return json(500, { error: 'github down' });
        revokedGitTokens.push((headers.get('authorization') ?? '').replace(/^(token|Bearer) /, ''));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

/** A step memo that OUTLIVES a pass — `job_step`. */
function durableSteps(memo: Map<string, unknown>): MemoizingSteps {
  return {
    async run<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
      if (memo.has(id)) return memo.get(id) as T;
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
}

let fx: WorkItemFixture;

async function seedRepo(): Promise<void> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: 'motir-projects',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: '700001',
      owner: 'motir-projects',
      name: 'site',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a000',
      githubRepoId: repo.id,
    },
  });
}

interface Started {
  data: HostedRunSuperviseData;
  handleId: string;
  cardId: string;
}

async function startRun(): Promise<Started> {
  await seedRepo();
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'a hosted card' },
    fx.ctx,
  );
  await hostedRunService.start(
    { workItemKey: card.identifier, model: MODEL, idempotencyKey: 'press' },
    fx.ctx,
  );
  const event = await adminDb.jobEvent.findFirstOrThrow({
    where: { name: 'hosted-run/supervise' },
  });
  const data = event.data as unknown as HostedRunSuperviseData;
  // A git token the container fetched mid-run — recorded, so the end must revoke it.
  await adminDb.dispatchRunGitCredential.create({
    data: {
      workspaceId: fx.workspaceId,
      dispatchRunId: data.dispatchRunId,
      app: 'motir-studio',
      installationId: '42',
      repositories: ['motir-projects/site'],
      tokenEncrypted: encryptToken('ghs_run_token'),
      expiresAt: new Date(Date.now() + 60 * MINUTE),
    },
  });
  return { data, handleId: data.session.handle.id, cardId: card.id };
}

/** ONE pass: `defer`, or the settled outcome. */
async function pass(
  data: HostedRunSuperviseData,
  memo: Map<string, unknown>,
  store: SupervisionStore,
  now: () => Date,
): Promise<'defer' | { outcome: string; reason?: string }> {
  try {
    const outcome = await hostedRunService.supervise('job-run-1', data, {
      ...FAST,
      now,
      steps: durableSteps(memo),
      supervisionStore: store,
    });
    return outcome.outcome === 'settled'
      ? { outcome: outcome.outcome, reason: outcome.reason }
      : { outcome: outcome.outcome };
  } catch (err) {
    if (isJobRunDefer(err)) return 'defer';
    throw err;
  }
}

/** Passes until the supervision returns (the durable job's loop). */
async function superviseToEnd(
  data: HostedRunSuperviseData,
  now: () => Date = () => new Date(),
): Promise<{ outcome: string; reason?: string }> {
  const memo = new Map<string, unknown>();
  const store = inMemorySupervisionStore();
  let result = await pass(data, memo, store, now);
  for (let i = 0; i < 8 && result === 'defer'; i += 1) result = await pass(data, memo, store, now);
  if (result === 'defer') throw new Error('the supervision never returned');
  return result;
}

const runOf = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const cardOf = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const lastLog = (dispatchRunId: string) =>
  adminDb.dispatchRunEvent.findFirst({
    where: { dispatchRunId, kind: 'log' },
    orderBy: { seq: 'desc' },
  });

/** The CLI in the container closing the run it adopted, as a local run closes. */
async function cliCloses(
  dispatchRunId: string,
  close: { stopReason: 'completed' | 'halted' | 'gated'; status: 'succeeded' | 'failed' },
): Promise<void> {
  const run = await runOf(dispatchRunId);
  await dispatchRunService.close(dispatchRunId, close, {
    userId: run.createdById!,
    workspaceId: run.workspaceId,
  });
}

/** Everything a run holds is dead: key, run credential, every git token. */
async function expectNothingAlive(dispatchRunId: string): Promise<void> {
  expect(revokedKeys).toContain(dispatchRunId);
  expect(await adminDb.apiToken.count({ where: { dispatchRunId } })).toBe(0);
  expect(revokedGitTokens).toEqual(['ghs_run_token']);
  expect(await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId } })).toBe(0);
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  fakeOrchestrator.reset();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  stubHttp();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('success is the CLI’s — the end path only tears down and revokes', () => {
  it('AC1/AC3 — a run the CLI closed `succeeded` keeps its status, its cards and its links', async () => {
    const { data, handleId, cardId } = await startRun();
    await cliCloses(data.dispatchRunId, { stopReason: 'completed', status: 'succeeded' });
    const before = await runOf(data.dispatchRunId);
    const card = await cardOf(cardId);
    const deliveries = await adminDb.workItemDelivery.count();
    const events = await adminDb.dispatchRunEvent.count({
      where: { dispatchRunId: data.dispatchRunId },
    });

    fakeOrchestrator.completeJob(handleId, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    const after = await runOf(data.dispatchRunId);
    expect(after).toMatchObject({ status: 'succeeded', stopReason: 'completed' });
    expect(after.endedAt).toEqual(before.endedAt); // not closed a second time
    expect(
      await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: data.dispatchRunId } }),
    ).toBe(events);
    const cardAfter = await cardOf(cardId);
    expect(cardAfter.status).toBe(card.status);
    expect(cardAfter.implementationSource).toBe('hosted');
    expect(await adminDb.workItemDelivery.count()).toBe(deliveries);
    await expectNothingAlive(data.dispatchRunId);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });
});

describe('a hosted run the CLI closed `gated` keeps the gates that held it (MOTIR-7703)', () => {
  it('the end path neither re-closes it nor drops its held-gate rows', async () => {
    const { data, handleId, cardId } = await startRun();
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: cardId,
        kind: 'design_result',
        subjectId: 'ev-hosted-held',
      },
    });
    await cliCloses(data.dispatchRunId, { stopReason: 'gated', status: 'succeeded' });

    fakeOrchestrator.completeJob(handleId, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'succeeded',
      stopReason: 'gated',
    });
    const held = await adminDb.dispatchRunHeldGate.findMany({
      where: { dispatchRunId: data.dispatchRunId },
    });
    expect(held.map((r) => [r.gateId, r.workItemId, r.kind])).toEqual([
      [gate.id, cardId, 'design_result'],
    ]);
  });
});

describe('a container that exits with its run still OPEN is a crash, never a success', () => {
  it('exit 0 with the run open → closed `failed`, logged as a crash, card unmoved', async () => {
    const { data, handleId, cardId } = await startRun();
    const card = await cardOf(cardId);

    fakeOrchestrator.completeJob(handleId, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain('hosted run ended (crash)');
    expect((await cardOf(cardId)).status).toBe(card.status);
    await expectNothingAlive(data.dispatchRunId);
  });

  it('exit 20 says the launcher never reached the CLI', async () => {
    const { data, handleId } = await startRun();
    fakeOrchestrator.completeJob(handleId, { exitCode: 20 });
    await superviseToEnd(data);
    expect((await lastLog(data.dispatchRunId))?.body).toContain(
      'the launcher never reached the CLI',
    );
    expect((await runOf(data.dispatchRunId)).status).toBe('failed');
  });

  it('AC1 failure — the CLI closed it `failed`: the status stands', async () => {
    const { data, handleId } = await startRun();
    await cliCloses(data.dispatchRunId, { stopReason: 'halted', status: 'failed' });
    fakeOrchestrator.completeJob(handleId, { exitCode: 1 });
    await superviseToEnd(data);
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    await expectNothingAlive(data.dispatchRunId);
  });
});

describe('cancel — revoked and closed now, torn down by its supervisor at the next poll', () => {
  it('a run on an agent-runner account is torn down on THAT account (MOTIR-9424)', async () => {
    const shard = await adminDb.fleetShard.create({
      data: {
        name: 'agents-cancel',
        fleetKind: 'hosted_agent',
        provider: 'fly',
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        flyOrg: 'motir',
        flyApp: 'motir-agents-cancel',
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        machineLimit: 5,
      },
    });
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const { data } = await startRun();
    expect(data.session.handle.shardId).toBe(shard.id);
    const account = fakeOrchestratorForShard(shard.id);
    const accountTeardown = vi.spyOn(account, 'teardown');
    const legacyTeardown = vi.spyOn(fakeOrchestrator, 'teardown');

    const res = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(res.status).toBe(200);
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'gate_revoked' });

    expect(accountTeardown.mock.calls.map((c) => c[1])).toEqual(['gate_revoked']);
    expect(legacyTeardown).not.toHaveBeenCalled();
    expect(account.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('AC1/AC4/AC6 — the dispatcher cancels: 200, run cancelled, machine settled `gate_revoked`', async () => {
    const { data, cardId } = await startRun();
    const card = await cardOf(cardId);

    const res = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(res.status).toBe(200);
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'interrupted',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain('hosted run ended (cancelled)');
    await expectNothingAlive(data.dispatchRunId);

    // The supervisor, the machine's one owner, tears it down with the cancel's reason.
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'gate_revoked' });
    const usage = await adminDb.ciContainerUsage.findFirstOrThrow({
      where: { dispatchRunId: data.dispatchRunId, containerStoppedAt: { not: null } },
    });
    expect(usage.teardownReason).toBe('gate_revoked');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect((await runOf(data.dispatchRunId)).status).toBe('cancelled');
    expect((await cardOf(cardId)).status).toBe(card.status);

    // Ended now — a second cancel has nothing to cancel.
    const again = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(again.status).toBe(409);
  });

  // Coverage top-up (MOTIR-692): the route's own gate and its one unmapped
  // rethrow — neither is a `hostedRunService.cancel` outcome, so no scenario
  // above reaches them.
  it("an incompliant session is the gate's own response, never reaching the service", async () => {
    const { data } = await startRun();
    const gateResponse = new Response(null, { status: 302 });
    requireCompliantWorkspaceContext.mockResolvedValueOnce({ ok: false, response: gateResponse });

    const res = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(res).toBe(gateResponse);
    expect((await runOf(data.dispatchRunId)).status).toBe('running');
  });

  it('an error the service never names is rethrown, not swallowed', async () => {
    const { data } = await startRun();
    vi.spyOn(hostedRunService, 'cancel').mockRejectedValueOnce(new Error('unexpected'));

    await expect(
      cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
        params: Promise.resolve({ id: data.dispatchRunId }),
      }),
    ).rejects.toThrow('unexpected');
  });

  it('AC6 — a project admin may cancel; another member may not; another workspace sees nothing', async () => {
    const { data } = await startRun();

    const member = await createTestUser();
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: true,
      ctx: { userId: member.id, workspaceId: fx.workspaceId },
    });
    const refused = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(refused.status).toBe(403);

    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: other.ctx });
    const hidden = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(hidden.status).toBe(404);
    expect((await runOf(data.dispatchRunId)).status).toBe('running');

    const admin = await createTestUser();
    await workspacesService.addMember({
      userId: admin.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'manager',
    });
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: true,
      ctx: { userId: admin.id, workspaceId: fx.workspaceId },
    });
    const ok = await cancelRoute(new Request('http://t/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: data.dispatchRunId }),
    });
    expect(ok.status).toBe(200);
    expect((await runOf(data.dispatchRunId)).status).toBe('cancelled');
  });

  it('AC2 — a cancel racing the CLI’s own success resolves to ONE terminal status', async () => {
    const { data } = await startRun();
    await Promise.allSettled([
      hostedRunService.cancel(data.dispatchRunId, fx.ctx),
      cliCloses(data.dispatchRunId, { stopReason: 'completed', status: 'succeeded' }),
    ]);
    const run = await runOf(data.dispatchRunId);
    expect(['cancelled', 'succeeded']).toContain(run.status);
    expect(run.endedAt).not.toBeNull();
  });

  // MOTIR-7489: the same race, pinned deterministically — the CLI's `succeeded`
  // commits at the first statement of the end path's close transaction, after
  // the end path read the run `running`. Its closing line must roll back with it.
  it('a CLI close landing inside the end path’s close leaves no closing line on the succeeded run', async () => {
    const { data } = await startRun();
    const runId = data.dispatchRunId;
    const read = dispatchRunRepository.findByIdWithCards.bind(dispatchRunRepository);
    let raced = false;
    vi.spyOn(dispatchRunRepository, 'findByIdWithCards').mockImplementation(async (id, tx) => {
      if (!raced && id === runId) {
        raced = true;
        await adminDb.dispatchRun.update({
          where: { id: runId },
          data: { status: 'succeeded', stopReason: 'completed', endedAt: new Date() },
        });
      }
      return read(id, tx);
    });
    const ended = await hostedRunService.endHostedRun(runId, 'cancelled', 'cancelled by a person');
    expect(raced).toBe(true);
    expect(ended.closed).toBe(false);
    expect((await runOf(runId)).status).toBe('succeeded');
    const lines = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId, kind: 'log' },
    });
    expect(lines.filter((e) => (e.body ?? '').includes('hosted run ended'))).toEqual([]);
  });
});

describe('the end path is idempotent and never throws', () => {
  it('AC2 — a second end closes nothing and revokes nothing a second time', async () => {
    const { data } = await startRun();
    const first = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');
    const closedAt = (await runOf(data.dispatchRunId)).endedAt;
    const second = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');

    expect(first).toMatchObject({ closed: true, runKey: 'revoked', runCredential: 1 });
    expect(first.gitCredentials).toEqual({ revoked: 1, failed: 0 });
    expect(second).toMatchObject({ closed: false, runCredential: 0 });
    expect(second.gitCredentials).toEqual({ revoked: 0, failed: 0 });
    expect(revokedGitTokens).toEqual(['ghs_run_token']);
    // The gateway is re-asked and answers that nothing was left to revoke.
    expect(revokedKeys).toEqual([data.dispatchRunId, data.dispatchRunId]);
    expect((await runOf(data.dispatchRunId)).endedAt).toEqual(closedAt);
  });

  it('AC5 — a revoke that fails is logged on the run, and the run still closes', async () => {
    const { data } = await startRun();
    failGatewayRevoke = true;
    const ended = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');
    expect(ended).toMatchObject({ closed: true, runKey: 'failed' });
    expect((await runOf(data.dispatchRunId)).status).toBe('failed');
    expect((await lastLog(data.dispatchRunId))?.body).toContain('the run key could not be revoked');
  });

  // Coverage top-up (MOTIR-692): a git-token revoke that FAILS is named on the
  // run's closing log too — its own failure count, distinct from the gateway
  // key's.
  it('a git-token revoke that fails is named on the closing log by its own count', async () => {
    const { data } = await startRun();
    failGitRevoke = true;
    const ended = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');
    expect(ended.gitCredentials).toEqual({ revoked: 0, failed: 1 });
    expect((await runOf(data.dispatchRunId)).status).toBe('failed');
    expect((await lastLog(data.dispatchRunId))?.body).toContain(
      '1 git token(s) could not be revoked',
    );
  });

  // Coverage top-up (MOTIR-692): a run-credential revoke that THROWS (rather
  // than answering a typed failure, as the gateway's own revoke does) is
  // caught and logged, never left to abort the rest of the teardown.
  it('a run-credential revoke that throws is swallowed, and the rest of the end path still runs', async () => {
    const { data } = await startRun();
    const runCredentialService = (await import('@/lib/services/runCredentialService'))
      .runCredentialService;
    vi.spyOn(runCredentialService, 'revokeRunCredential').mockRejectedValueOnce(
      new Error('the token table is down'),
    );

    const ended = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');
    expect(ended).toMatchObject({ closed: true, runCredential: 0 });
    expect(revokedKeys).toContain(data.dispatchRunId);
    expect(revokedGitTokens).toEqual(['ghs_run_token']);
  });

  // Coverage top-up (MOTIR-692): a close that fails for a reason OTHER than the
  // CLI having already closed it (`DispatchRunTerminalError`) is logged, not
  // rethrown — the revocations already ran and must stand either way.
  it('a close that fails for an unrelated reason is logged, and every revoke still stands', async () => {
    const { data } = await startRun();
    vi.spyOn(dispatchRunService, 'close').mockRejectedValueOnce(new Error('the run table is down'));

    const ended = await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', 'test');
    expect(ended.closed).toBe(false);
    expect(revokedKeys).toContain(data.dispatchRunId);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: data.dispatchRunId } })).toBe(0);
  });
});

describe('a container whose own teardown fails is still a `failed` run, never a false success', () => {
  // Coverage top-up (MOTIR-692): `endOutcomeFor`'s "the container did not even
  // settle" branch — a `teardown_failed`/`provision_failed`/`image_unpullable`
  // outcome from the seam itself, never `job_completed` / `job_timed_out` /
  // `gate_revoked`, which every other end scenario in this file produces.
  it('a settle whose teardown itself fails still ends the run `failed`, not silently open', async () => {
    const { data, handleId, cardId } = await startRun();
    const card = await cardOf(cardId);
    fakeOrchestrator.failNextTeardown('the fleet API is down');
    fakeOrchestrator.completeJob(handleId, { exitCode: 0 });

    expect(await superviseToEnd(data)).toEqual({ outcome: 'teardown_failed' });
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain('the container ended as');
    expect((await cardOf(cardId)).status).toBe(card.status);
    await expectNothingAlive(data.dispatchRunId);
  });
});

describe('the backstop and a lost supervision chain take the same path', () => {
  it('AC7 — at the backstop the run is ended `timed_out` and its log says so', async () => {
    const { data, cardId } = await startRun();
    const card = await cardOf(cardId);
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const past = new Date(bootedAt + HOSTED_AGENT_MAX_TIMEOUT_MS + MINUTE);
    // Still talking — so it is the backstop that ends it, not a stall.
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: data.dispatchRunId,
        seq: 100,
        kind: 'log',
        createdAt: new Date(past.getTime() - MINUTE),
      },
    });

    expect(await superviseToEnd(data, () => past)).toEqual({
      outcome: 'settled',
      reason: 'job_timed_out',
    });
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain('hosted run ended (backstop)');
    expect((await cardOf(cardId)).status).toBe(card.status);
    await expectNothingAlive(data.dispatchRunId);
  });

  it('AC8 — a supervision the sweep finds abandoned ends through the end path', async () => {
    const { data, cardId } = await startRun();
    const card = await cardOf(cardId);
    await truncateJobRuns();
    const job = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'hosted-run/supervise',
        eventName: 'hosted-run/supervise',
        workspaceId: fx.workspaceId,
        runAt: new Date(Date.now() - 60 * MINUTE),
        maxAttempts: 1,
        state: 'failed',
      },
    });
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: job.id,
          subject: data.session.dispatchId,
          kind: 'hosted-agent',
          nextPollAt: new Date(Date.now() - 40 * MINUTE),
          workspaceId: fx.workspaceId,
        },
        tx,
      );
      await jobStepRepository.create(
        {
          runId: job.id,
          stepId: hostedAgentBootStepId(data.session.dispatchId),
          kind: 'run',
          result: {
            phase: 'supervising',
            session: data.session,
          } as unknown as Prisma.InputJsonValue,
          workspaceId: fx.workspaceId,
        },
        tx,
      );
    });

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain(
      'hosted run ended (lost supervision)',
    );
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(
      await adminDb.ciContainerUsage.count({
        where: { dispatchRunId: data.dispatchRunId, containerStoppedAt: { not: null } },
      }),
    ).toBe(1);
    expect((await cardOf(cardId)).status).toBe(card.status);
    await expectNothingAlive(data.dispatchRunId);
    await truncateJobRuns();
  });
});

describe('the attribution reconciler spares a hosted run that still holds its fleet slot', () => {
  /** Supervise far enough that the container has accrued a live usage row. */
  async function liveRun(): Promise<Started> {
    const started = await startRun();
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    for (let i = 0; i < 3; i += 1) await pass(started.data, memo, store, () => new Date());
    expect(
      await adminDb.ciContainerUsage.count({
        where: { dispatchRunId: started.data.dispatchRunId, containerStoppedAt: null },
      }),
    ).toBeGreaterThan(0);
    // Old enough for the CI cutoff to reach it.
    fakeOrchestrator.backdate(started.handleId, new Date(Date.now() - 5 * 60 * MINUTE));
    return started;
  }

  it('AC9 — a long run holding its slot survives the reconciler', async () => {
    const { handleId } = await liveRun();
    const reaped = await fleetAttributionService.reconcile({
      now: () => new Date(Date.now() + 20 * MINUTE),
    });
    expect(reaped).toMatchObject({ killed: [] });
    expect(fakeOrchestrator.liveContainerIds()).toContain(handleId);
  });

  it('AC9 — the same machine with no slot is an orphan, and is reaped', async () => {
    const { handleId } = await liveRun();
    await adminDb.fleetInFlightSlot.deleteMany({});
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 20 * MINUTE) });
    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handleId);
  });
});

describe('a hosted run whose container the REAPER destroys is settled, charged and ended (MOTIR-6524)', () => {
  /** A live run whose container has lost its fleet slot — the reaper's orphan. */
  async function orphanedRun(): Promise<Started> {
    const started = await startRun();
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    for (let i = 0; i < 3; i += 1) await pass(started.data, memo, store, () => new Date());
    fakeOrchestrator.backdate(started.handleId, new Date(Date.now() - 5 * 60 * MINUTE));
    await adminDb.fleetInFlightSlot.deleteMany({});
    // Nothing has been charged yet: the run's only container is still open.
    expect(machineCharges).toEqual([]);
    return started;
  }

  const chargesFor = (dispatchRunId: string) =>
    machineCharges.filter((c) => c.externalRef === dispatchRunId);

  it('AC1 — a reaped hosted-agent container naming run R charges R exactly once', async () => {
    const { data, handleId, cardId } = await orphanedRun();
    const card = await cardOf(cardId);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reaped = await fleetAttributionService.reconcile({
      now: () => new Date(Date.now() + 20 * MINUTE),
    });

    expect(reaped).toMatchObject({
      killed: [{ machineId: handleId, reason: 'record_ended', workload: 'hosted_agent' }],
    });
    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handleId);
    // The container's row is SETTLED, still naming its run — which is what makes
    // the run read as settled to the charge.
    const row = await adminDb.ciContainerUsage.findFirstOrThrow({ where: { handleId } });
    expect(row).toMatchObject({
      dispatchRunId: data.dispatchRunId,
      workload: 'agent',
      teardownReason: 'reaped',
    });
    expect(row.containerStoppedAt).not.toBeNull();
    expect(chargesFor(data.dispatchRunId)).toHaveLength(1);
    expect(chargesFor(data.dispatchRunId)[0]).toMatchObject({
      coreRunId: data.dispatchRunId,
      externalRef: data.dispatchRunId,
    });
    expect(machineCharges).toHaveLength(1);
    // …and the run ends through the one end path, as a lost supervision.
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect((await lastLog(data.dispatchRunId))?.body).toContain(
      'hosted run ended (lost supervision)',
    );
    expect((await cardOf(cardId)).status).toBe(card.status);
    await expectNothingAlive(data.dispatchRunId);
  });

  it('AC3 — a run charged elsewhere too is debited once: every charge carries the run as `externalRef`', async () => {
    const { data } = await orphanedRun();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 20 * MINUTE) });
    // A second pass finds nothing left to charge.
    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 20 * MINUTE) });
    expect(chargesFor(data.dispatchRunId)).toHaveLength(1);

    // The run's own pass or the sweep charging the same run afterwards asks
    // motir-ai again under the SAME key, and motir-ai answers it as a replay.
    const again = await hostedRunChargeService.chargeMachineTime(data.dispatchRunId);
    expect(again).toMatchObject({ outcome: 'charged', idempotent: true });
    expect(chargesFor(data.dispatchRunId).map((c) => c.externalRef)).toEqual([
      data.dispatchRunId,
      data.dispatchRunId,
    ]);
    expect([...debitedRuns]).toEqual([data.dispatchRunId]);
  });

  it('AC2 — a reaped container that is not a hosted run is never charged', async () => {
    const handle = await fakeOrchestrator.provision({
      orgId: fx.workspace.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName: 'motir-projects/site',
      workload: 'code_graph_index',
      workflowJobId: null,
      image: 'motir/indexer@sha256:test',
      size: FLEET_CONTAINER_SIZE,
      env: {},
      timeoutSeconds: 3600,
      region: 'iad',
    });
    fakeOrchestrator.backdate(handle.id, new Date(Date.now() - 5 * 60 * MINUTE));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 20 * MINUTE) });

    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handle.id);
    expect(machineCharges).toEqual([]);
  });
});
