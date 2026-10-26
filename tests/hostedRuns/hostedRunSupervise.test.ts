import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { inMemorySupervisionStore, type SupervisionStore } from '@/lib/jobs/supervision/driver';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import type { HostedRunSuperviseData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { HOSTED_RUN_STALL_WINDOW_MS } from '@/lib/hostedRuns/limits';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { HOSTED_RUN_STALL_DETAIL, hostedRunService } from '@/lib/services/hostedRunService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A HOSTED RUN'S SUPERVISION (Story MOTIR-683 · MOTIR-690) — the durable job's
// body, `hostedRunService.supervise`, driven pass by pass the way the worker
// drives it: each pass either DEFERS (`JobRunDefer`) or returns once the
// container has settled. The step memo is a map that outlives any one pass —
// what `job_step` is — so a "restart" between passes is a new pass over the
// same memo, and it must neither boot again nor lose its place.
//
// The run itself is started for real (`hostedRunService.start`, fake
// orchestrator, `fetch` stubbed at motir-ai / the gateway), and the supervision
// is handed exactly the payload the start path enqueued.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const MINUTE = 60_000;
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 600 * MINUTE } as const;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

let revoked: string[] = [];

function stubHttp(): void {
  revoked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
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
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, { key: 'sk-run', runRef: body?.runRef, expiresAt: body?.expiresAt });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        revoked.push(decodeURIComponent(url.split('/').pop() ?? ''));
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      // The machine charge a settled run triggers (MOTIR-6514) — answered, so the
      // settle's own tail completes; this suite does not assert on it.
      if (url === `${AI}/v1/credits/agent-machine`) {
        return json(200, {
          balanceAfter: 90,
          credits: 1,
          billableSeconds: 1,
          exhausted: false,
          idempotent: false,
        });
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

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}

async function startRun(): Promise<{ data: HostedRunSuperviseData; handleId: string }> {
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a000',
      githubRepoId: (
        await adminDb.githubRepo.create({
          data: {
            installationId: (
              await adminDb.githubInstallation.create({
                data: {
                  installationId: `inst-${fx.workspaceId}`,
                  workspaceId: fx.workspaceId,
                  organizationId: fx.workspace.organizationId,
                  accountLogin: 'motir-projects',
                  accountType: 'Organization',
                  provider: 'github',
                },
              })
            ).id,
            workspaceId: fx.workspaceId,
            organizationId: fx.workspace.organizationId,
            repoId: '700001',
            owner: 'motir-projects',
            name: 'site',
            defaultBranch: 'main',
            archived: false,
            provider: 'github',
          },
        })
      ).id,
    },
  });
  const card = await newCard({ kind: 'task', title: 'a hosted card' });
  await hostedRunService.start(
    { workItemKey: card.identifier, model: MODEL, idempotencyKey: 'press' },
    fx.ctx,
  );
  const event = await adminDb.jobEvent.findFirstOrThrow({
    where: { name: 'hosted-run/supervise' },
  });
  const data = event.data as unknown as HostedRunSuperviseData;
  return { data, handleId: data.session.handle.id };
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

const runOf = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
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
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the supervision job — boot replayed, never repeated', () => {
  it('AC7 — advances the booted container to its exit across a restart, then ends the run', async () => {
    const { data, handleId } = await startRun();
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const now = () => new Date();

    expect(await pass(data, memo, store, now)).toBe('defer');
    expect(await pass(data, memo, store, now)).toBe('defer');
    // A RESTART: a new pass over the same durable memo and store. Still one container.
    expect(await pass(data, memo, store, now)).toBe('defer');
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    fakeOrchestrator.completeJob(handleId, { exitCode: 0 });
    let result = await pass(data, memo, store, now);
    for (let i = 0; i < 5 && result === 'defer'; i += 1)
      result = await pass(data, memo, store, now);
    expect(result).toEqual({ outcome: 'settled', reason: 'job_completed' });

    // The end path ran: key and credential revoked, the run closed. The CLI never
    // closed it, so the exit — 0 or not — is a crash, never a success (MOTIR-6450:
    // success is the CLI's to record, and the exit code is the CLI's own).
    expect(revoked).toEqual([data.dispatchRunId]);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: data.dispatchRunId } })).toBe(0);
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    // Replaying the finished job ends nothing twice.
    await pass(data, memo, store, now);
    expect(revoked).toEqual([data.dispatchRunId]);
  });

  it('keeps the status the CLI closed the run with, and moves no card', async () => {
    const { data, handleId } = await startRun();
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const run = await runOf(data.dispatchRunId);
    await dispatchRunService.close(
      data.dispatchRunId,
      { stopReason: 'halted', status: 'failed' },
      { userId: run.createdById!, workspaceId: run.workspaceId },
    );
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    const cardBefore = await adminDb.workItem.findUniqueOrThrow({
      where: { id: legs[0]!.workItemId! },
    });

    fakeOrchestrator.completeJob(handleId, { exitCode: 1 });
    let result = await pass(data, memo, store, () => new Date());
    for (let i = 0; i < 5 && result === 'defer'; i += 1) {
      result = await pass(data, memo, store, () => new Date());
    }

    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    const cardAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: cardBefore.id } });
    expect(cardAfter.status).toBe(cardBefore.status);
    expect(revoked).toEqual([data.dispatchRunId]);
  });
});

describe('no wall-clock limit but the backstop — only a silent agent is ended early', () => {
  it('AC9 — a container still running and producing output at the 91st minute is NOT ended', async () => {
    const { data } = await startRun();
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const at91 = new Date(bootedAt + 91 * MINUTE);
    // The agent spoke a minute ago.
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: data.dispatchRunId,
        seq: 100,
        kind: 'log',
        createdAt: new Date(at91.getTime() - MINUTE),
      },
    });
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();

    expect(await pass(data, memo, store, () => at91)).toBe('defer');
    expect(await pass(data, memo, store, () => at91)).toBe('defer');
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect((await runOf(data.dispatchRunId)).status).toBe('running');
    expect(revoked).toEqual([]);
  });

  it('a run with no event inside the stall window is ended as stalled, its machine torn down', async () => {
    const { data } = await startRun();
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const later = new Date(bootedAt + HOSTED_RUN_STALL_WINDOW_MS + MINUTE);
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();

    let result = await pass(data, memo, store, () => later);
    for (let i = 0; i < 5 && result === 'defer'; i += 1) {
      result = await pass(data, memo, store, () => later);
    }
    expect(result).toEqual({ outcome: 'settled', reason: 'job_timed_out' });

    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: data.dispatchRunId, kind: 'log' },
      orderBy: { seq: 'desc' },
    });
    expect(log?.body).toContain(HOSTED_RUN_STALL_DETAIL);
    expect(revoked).toEqual([data.dispatchRunId]);
  });

  // Coverage top-up (MOTIR-692): `stallDetail`'s `latest?.getTime() ?? 0`
  // fallback — a run with NO event at all (not even `run_opened`), so the
  // stall read falls back to its BOOT time alone, never to epoch zero.
  it('a run with no event of its own still stalls off its boot time alone', async () => {
    const { data } = await startRun();
    await adminDb.dispatchRunEvent.deleteMany({ where: { dispatchRunId: data.dispatchRunId } });
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const later = new Date(bootedAt + HOSTED_RUN_STALL_WINDOW_MS + MINUTE);
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();

    let result = await pass(data, memo, store, () => later);
    for (let i = 0; i < 5 && result === 'defer'; i += 1) {
      result = await pass(data, memo, store, () => later);
    }
    expect(result).toEqual({ outcome: 'settled', reason: 'job_timed_out' });
    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
  });
});

describe('a settle reason none of the end path’s own names cover', () => {
  // Coverage top-up (MOTIR-692): `endOutcomeFor`'s final fallback arm — a
  // settled outcome whose `reason` is none of `job_completed`, `job_timed_out`
  // or `gate_revoked` (the fleet reaper's own `reaped`, here). The end path
  // still closes the run `failed`, quoting the container's own detail, rather
  // than silently falling through.
  it('a container the fleet reaper found abandoned still ends the run failed', async () => {
    const { data } = await startRun();
    const { hostedAgentContainerService } =
      await import('@/lib/services/hostedAgentContainerService');
    vi.spyOn(hostedAgentContainerService, 'advance').mockResolvedValueOnce({
      outcome: 'settled',
      reason: 'reaped',
      containerId: 'fake-container',
      exitCode: null,
      billableSeconds: 1,
      costUsd: '0',
      usage: {},
      failureDetail: 'the fleet reaper found it orphaned',
    } as unknown as Awaited<ReturnType<typeof hostedAgentContainerService.advance>>);

    const outcome = await hostedRunService.supervise('job-run-1', data, {
      ...FAST,
      now: () => new Date(),
      steps: durableSteps(new Map()),
      supervisionStore: inMemorySupervisionStore(),
    });
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'reaped' });

    expect(await runOf(data.dispatchRunId)).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
    });
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: data.dispatchRunId, kind: 'log' },
      orderBy: { seq: 'desc' },
    });
    expect(log?.body).toContain('the fleet reaper found it orphaned');
  });
});
