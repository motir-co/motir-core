import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import {
  HOSTED_RUN_SETTLE_MARGIN_MS,
  HOSTED_RUN_TIMEOUT_MS,
  hostedRunDeadline,
} from '@/lib/hostedRuns/limits';
import type { HostedRunAdmitData } from '@/lib/jobs/types';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import {
  HOSTED_RUN_NEVER_ADMITTED_DETAIL,
  hostedRunAdmitKey,
  hostedRunService,
} from '@/lib/services/hostedRunService';
import { planCapsService } from '@/lib/services/planCapsService';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A HOSTED RUN THAT WAITS FOR ROOM (Story MOTIR-9363 · MOTIR-9381) — Run hosted
// on an organisation already at its plan's agent-run figure. The run is NOT
// ended: it stays open and claimed, says why it waits, and the
// `hosted-run/admit` job boots it once a slot is free. Real services over real
// Postgres; the fleet on the fake orchestrator; motir-ai, the gateway and GitHub
// stubbed at `fetch`, exactly as `hostedRunStart.test.ts` stubs them.
//
// ⚠️ THE CONTAINER COUNT IS THE ASSERTION throughout: a held run that booted, or
// two passes that each booted, would read the same from the run's status alone.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  models?: {
    status?: number;
    ids?: string[];
    /** The platform's per-difficulty defaults (MOTIR-6990). Absent reads as all-null. */
    defaultsByDifficulty?: Partial<Record<'trivial' | 'low' | 'medium' | 'high', string | null>>;
  };
  mayRun?: boolean | 'unanswerable';
  /** `GET /repos/{owner}/{name}/installation` status, by `owner/name`. Default 200. */
  installation?: Record<string, number>;
}

let calls: Call[] = [];

function stub(s: Stub = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url === `${AI}/v1/agent-models`) {
        const status = s.models?.status ?? 200;
        if (status !== 200) return json(status, { code: 'internal_error' });
        const ids = s.models?.ids ?? [MODEL];
        return json(200, {
          models: ids.map((id) => ({
            id,
            provider: id.startsWith('deepseek') ? 'deepseek' : 'anthropic',
          })),
          default: ids[0] ?? null,
          ...(s.models?.defaultsByDifficulty
            ? {
                defaultsByDifficulty: {
                  trivial: null,
                  low: null,
                  medium: null,
                  high: null,
                  ...s.models.defaultsByDifficulty,
                },
              }
            : {}),
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (s.mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        const mayRun = s.mayRun ?? true;
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: mayRun ? 250 : 0,
          hasCredits: mayRun,
          mayRun,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.runRef,
          coreOrganizationId: body?.coreOrganizationId,
          expiresAt: body?.expiresAt,
          lane: 'agent',
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const repo = inst[1] ?? '';
        const status = s.installation?.[repo] ?? 200;
        if (status !== 200) return json(status, {});
        const owner = repo.split('/')[0];
        return json(200, {
          id: 42,
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');

let repoSeq = 0;

/** A project repository with a realized GitHub repository behind it. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<string> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${opts.owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: opts.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(800_000 + repoSeq),
      owner: opts.owner,
      name: opts.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

let fx: WorkItemFixture;

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

let seq = 0;
const start = (key: string) =>
  hostedRunService.start(
    { workItemKey: key, model: MODEL, idempotencyKey: `idem-${++seq}` },
    fx.ctx,
  );

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

/** The admission job's payload, exactly as the start path stored it. */
async function admitPayload(dispatchRunId: string): Promise<HostedRunAdmitData> {
  const events = await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/admit' } });
  const event = events.find(
    (e) => (e.data as unknown as HostedRunAdmitData).dispatchRunId === dispatchRunId,
  );
  if (!event) throw new Error(`no admission event for ${dispatchRunId}`);
  return event.data as unknown as HostedRunAdmitData;
}

/** Free the slot the first run's container holds — as its settle would. */
const releaseSlotOf = (dispatchRunId: string) =>
  fleetCeilingService.release('hosted_agent', hostedRunDispatchId(dispatchRunId), dispatchRunId);

const waitingLines = async (dispatchRunId: string) =>
  (await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId, kind: 'log' } }))
    .map((e) => e.body ?? '')
    .filter((body) => body.startsWith('[motir] waiting for room'));

/** A Standard org (one agent run at once) with one run already booted. */
async function oneRunningAndOneHeld(): Promise<{ first: string; held: string; heldKey: string }> {
  await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
  const a = await newCard('the first card');
  const b = await newCard('the second card');
  const first = await start(a.identifier);
  expect(fakeOrchestrator.provisioned).toHaveLength(1);
  const held = await start(b.identifier);
  return { first: first.dispatchRunId, held: held.dispatchRunId, heldKey: b.identifier };
}

grantPaidAiPlan('standard');

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
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stub();
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

describe('a run held at the plan figure waits — it is not ended', () => {
  it('the second run on a Standard org stays open and claimed, boots nothing, and says why', async () => {
    const { held, heldKey } = await oneRunningAndOneHeld();

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await runRow(held)).toMatchObject({ status: 'running' });
    const card = await adminDb.workItem.findFirstOrThrow({ where: { identifier: heldKey } });
    expect(card).toMatchObject({ status: 'in_progress', assigneeId: fx.ownerId });

    // No credential exists for a run that has not been admitted.
    expect(mintCalls()).toHaveLength(1);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: held } })).toBe(0);

    expect(await waitingLines(held)).toEqual([
      '[motir] waiting for room: a Standard organization runs 1 agent run at once, and 1 is already running\n',
    ]);

    // One admission job, keyed to the run, and its payload carries no secret.
    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId: 'hosted-run/admit' } });
    expect(queued).toHaveLength(1);
    const data = await admitPayload(held);
    expect(data.idempotencyKey).toBe(hostedRunAdmitKey(held));
    expect(JSON.stringify(data)).not.toContain('sk-run-key-secret');
  });

  it('a pass still held writes no second identical waiting line', async () => {
    const { held } = await oneRunningAndOneHeld();

    expect(await hostedRunService.admit(await admitPayload(held))).toMatchObject({
      kind: 'waiting',
    });
    expect(await hostedRunService.admit(await admitPayload(held))).toMatchObject({
      kind: 'waiting',
    });

    expect(await waitingLines(held)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('admission — once there is room', () => {
  it('boots the held run, queues its supervision, and counts its credentials from admission', async () => {
    const { first, held } = await oneRunningAndOneHeld();
    const startedAt = (await runRow(held)).startedAt;
    await releaseSlotOf(first);

    const admittedAt = new Date(startedAt.getTime() + 2 * 60 * 60_000);
    const result = await hostedRunService.admit(await admitPayload(held), {
      now: () => admittedAt,
      supervision: { now: () => admittedAt },
    });

    expect(result).toEqual({ kind: 'booted' });
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(fakeOrchestrator.specs[1]!.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: held,
      MOTIR_RUN_KEY: 'sk-run-key-secret',
      MOTIR_GATEWAY_URL: GATEWAY,
      MOTIR_MODEL: `anthropic/${MODEL}`,
    });

    // The key and the run credential live a whole container life FROM ADMISSION.
    const mint = mintCalls()[1]!.body!;
    expect(mint['expiresAt']).toBe(
      Math.floor((admittedAt.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000),
    );
    const token = await adminDb.apiToken.findFirstOrThrow({ where: { dispatchRunId: held } });
    expect(token.expiresAt!.getTime()).toBe(
      admittedAt.getTime() + HOSTED_RUN_TIMEOUT_MS + HOSTED_RUN_SETTLE_MARGIN_MS,
    );

    const supervise = await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/supervise' } });
    expect(
      supervise.map((e) => (e.data as { dispatchRunId: string }).dispatchRunId).sort(),
    ).toEqual([first, held].sort());
    expect(await runRow(held)).toMatchObject({ status: 'running' });
  });

  it('two passes racing for the freed slot boot exactly one container', async () => {
    const { first, held } = await oneRunningAndOneHeld();
    await releaseSlotOf(first);
    const data = await admitPayload(held);

    const results = await Promise.all([hostedRunService.admit(data), hostedRunService.admit(data)]);

    expect(results).toEqual([{ kind: 'booted' }, { kind: 'booted' }]);
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    expect(mintCalls()).toHaveLength(2);
  });

  it('an unreadable plan waits too, and boots once the plan reads', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard('a card');
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
      kind: 'plan_unknown',
      planKey: null,
    });

    const started = await start(card.identifier);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'running' });
    expect(await waitingLines(started.dispatchRunId)).toHaveLength(1);

    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    expect(await hostedRunService.admit(await admitPayload(started.dispatchRunId))).toEqual({
      kind: 'booted',
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('a held run that does not boot', () => {
  it('a run cancelled while it waited is closed: no container, no credential', async () => {
    const { first, held } = await oneRunningAndOneHeld();
    await hostedRunService.cancel(held, fx.ctx);
    await releaseSlotOf(first);

    expect(await hostedRunService.admit(await admitPayload(held))).toEqual({ kind: 'closed' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: held } })).toBe(0);
    expect(await runRow(held)).toMatchObject({ status: 'cancelled' });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('a deferral that does not clear by itself — the plan lapsed — ends the run failed', async () => {
    const { first, held } = await oneRunningAndOneHeld();
    await releaseSlotOf(first);
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);

    const result = await hostedRunService.admit(await admitPayload(held));

    expect(result).toMatchObject({ kind: 'failed' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await runRow(held)).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });

  it('a run that waited the whole backstop is ended timed out, in words that say it never got room', async () => {
    const { held } = await oneRunningAndOneHeld();
    const startedAt = (await runRow(held)).startedAt;

    const result = await hostedRunService.admit(await admitPayload(held), {
      now: () => hostedRunDeadline(startedAt),
    });

    expect(result).toEqual({ kind: 'failed', detail: HOSTED_RUN_NEVER_ADMITTED_DETAIL });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await runRow(held)).toMatchObject({ status: 'timed_out' });
    const logs = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: held, kind: 'log' },
    });
    expect(logs.some((l) => (l.body ?? '').includes('never got room to run'))).toBe(true);
  });
});

describe('the run records the account its container booted on (MOTIR-9423)', () => {
  async function agentAccount() {
    const slug = Math.random().toString(36).slice(2, 8);
    return adminDb.fleetShard.create({
      data: {
        name: `agents-${slug}`,
        fleetKind: 'hosted_agent',
        provider: 'fly',
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        flyOrg: 'motir',
        flyApp: `motir-agents-${slug}`,
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        machineLimit: 5,
      },
    });
  }

  it('switch off: the run boots on the process-wide fleet and its fleet_shard_id stays null', async () => {
    await agentAccount();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const run = await start((await newCard('legacy')).identifier);

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await runRow(run.dispatchRunId)).toMatchObject({ fleetShardId: null });
  });

  it('switch on: the run names account A, written before its supervision is sent', async () => {
    const a = await agentAccount();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const superviseSentAtRecord: number[] = [];
    const record = dispatchRunRepository.recordFleetShard.bind(dispatchRunRepository);
    vi.spyOn(dispatchRunRepository, 'recordFleetShard').mockImplementation(async (id, s, tx) => {
      superviseSentAtRecord.push(
        await adminDb.jobEvent.count({ where: { name: 'hosted-run/supervise' } }),
      );
      return record(id, s, tx);
    });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const run = await start((await newCard('on an account')).identifier);

    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(fakeOrchestratorForShard(a.id).provisioned).toHaveLength(1);
    expect(await runRow(run.dispatchRunId)).toMatchObject({ fleetShardId: a.id });
    expect(superviseSentAtRecord).toEqual([0]);
    expect(await adminDb.jobEvent.count({ where: { name: 'hosted-run/supervise' } })).toBe(1);
  });
});
