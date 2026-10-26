import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  HostedContinueRefusedError,
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedRunCardNotReadyError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
} from '@/lib/hostedRuns/errors';
import { HOSTED_RUN_SETTLE_MARGIN_MS, HOSTED_RUN_TIMEOUT_MS } from '@/lib/hostedRuns/limits';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { HOSTED_AGENT_MAX_TIMEOUT_MS } from '@/lib/services/hostedAgentContainerService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import {
  createTestLink,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// STARTING A HOSTED RUN (Story MOTIR-683 · MOTIR-690) — `hostedRunService.start`
// over the real services against real Postgres, with the fleet on the fake
// orchestrator and motir-ai, the gateway and GitHub stubbed at their HTTP seam
// (`fetch`), exactly as each client's own suite stubs it.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no `dispatch_run` row, no
// run-key mint on the gateway stub, no provision on the fake orchestrator. A
// refusal that opened, minted or booted anything and then threw would read, from
// the error alone, exactly like one that did none of it.

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
const creditCalls = () => calls.filter((c) => c.url === `${AI}/v1/credits/agent-run-check`);
const aiCalls = () => calls.filter((c) => new URL(c.url).origin === new URL(AI).origin);

let fx: WorkItemFixture;

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}
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

async function pinRepos(workItemId: string, repoIds: string[]): Promise<void> {
  for (const [position, projectRepoId] of repoIds.entries()) {
    await adminDb.workItemRepo.create({
      data: { workspaceId: fx.workspaceId, workItemId, projectRepoId, position },
    });
  }
}

const runRows = () => adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });

async function expectNothingStarted(): Promise<void> {
  expect(await runRows()).toEqual([]);
  expect(mintCalls()).toEqual([]);
  expect(fakeOrchestrator.provisioned).toEqual([]);
}

let seq = 0;
const start = (key: string, model = MODEL) =>
  hostedRunService.start({ workItemKey: key, model, idempotencyKey: `idem-${++seq}` }, fx.ctx);

/** A start with NO model — the server resolves it from the card's difficulty (MOTIR-6994). */
const startResolved = (key: string) =>
  hostedRunService.start({ workItemKey: key, idempotencyKey: `idem-${++seq}` }, fx.ctx);

const setDifficulty = (id: string, difficulty: 'trivial' | 'low' | 'medium' | 'high') =>
  adminDb.workItem.update({ where: { id }, data: { difficulty } });

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
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the refusals — every one before anything is opened, minted or booted', () => {
  it('AC1 — a model not offered: HostedModelNotOfferedError, and no pre-flight was asked', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ models: { ids: ['claude-sonnet-5'] } });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    expect(creditCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC1 — the list unreadable: HostedModelsUnavailableError, with the same absences', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ models: { status: 500 } });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedModelsUnavailableError);
    expect(creditCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC2 — mayRun false: HostedRunOutOfCreditsError, nothing opened, minted or booted', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ mayRun: false });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunOutOfCreditsError);
    await expectNothingStarted();
  });

  it('AC5 — a card that is not ready is refused before the model check is called', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const blocker = await newCard({ kind: 'task', title: 'first' });
    const card = await newCard({ kind: 'task', title: 'second' });
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: card.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    expect(aiCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC6 — a connected repository its installation no longer reaches refuses the run, naming it', async () => {
    const repo = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    await pinRepos(card.id, [repo]);
    stub({ installation: { 'acme/web': 404 } });

    const refused = await start(card.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunRepositoryNotWritableError);
    expect((refused as HostedRunRepositoryNotWritableError).refusals).toEqual([
      expect.objectContaining({ repository: 'acme/web', fix: 'reconnect' }),
    ]);
    await expectNothingStarted();
  });
});

describe('a leaf card — the run it starts', () => {
  it('AC3 · AC9 — one hosted run on the bare model, the card claimed and stamped, one container with the launcher inputs and no other credential', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });

    const started = await start(card.identifier);
    expect(started.created).toBe(true);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      id: started.dispatchRunId,
      origin: 'hosted',
      command: 'run',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
    });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    expect(legs.map((l) => l.workItemKey)).toEqual([card.identifier]);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({
      status: 'in_progress',
      assigneeId: fx.ownerId,
      implementationSource: 'hosted',
      implementationHarness: 'opencode',
      implementationModel: MODEL,
    });

    // The key is minted for exactly the bare model, and dies at the backstop —
    // counted from ADMISSION (MOTIR-9381), which for a run admitted on its first
    // try is the open itself or a moment after it.
    const admittedBy = Date.now();
    expect(mintCalls()).toHaveLength(1);
    const mint = mintCalls()[0]!.body!;
    expect(mint['models']).toEqual([MODEL]);
    expect(mint['expiresAt']).toBeGreaterThanOrEqual(
      Math.floor((run.startedAt.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000),
    );
    expect(mint['expiresAt']).toBeLessThanOrEqual(
      Math.floor((admittedBy + HOSTED_RUN_TIMEOUT_MS) / 1000),
    );
    // The run credential dies by the backstop plus the settle margin.
    const token = await adminDb.apiToken.findFirstOrThrow({ where: { dispatchRunId: run.id } });
    const margin = HOSTED_RUN_TIMEOUT_MS + HOSTED_RUN_SETTLE_MARGIN_MS;
    expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime() + margin);
    expect(token.expiresAt!.getTime()).toBeLessThanOrEqual(admittedBy + margin);

    // ONE container, booted with the 12-hour backstop and exactly the launcher's inputs.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    const spec = fakeOrchestrator.specs[0]!;
    expect(spec.workload).toBe('hosted_agent');
    expect(spec.timeoutSeconds).toBe(HOSTED_AGENT_MAX_TIMEOUT_MS / 1000);
    expect(HOSTED_RUN_TIMEOUT_MS).toBe(HOSTED_AGENT_MAX_TIMEOUT_MS);
    expect(Object.keys(spec.env).sort()).toEqual(
      [
        'MOTIR_API_URL',
        'MOTIR_DISPATCH_RUN_ID',
        'MOTIR_GATEWAY_URL',
        'MOTIR_MODEL',
        'MOTIR_RUN_KEY',
        'MOTIR_RUN_TOKEN',
        'MOTIR_WORK_ITEM_KEY',
      ].sort(),
    );
    expect(spec.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: run.id,
      MOTIR_WORK_ITEM_KEY: card.identifier,
      MOTIR_API_URL: 'https://app.test',
      MOTIR_GATEWAY_URL: GATEWAY,
      MOTIR_RUN_KEY: 'sk-run-key-secret',
      MOTIR_MODEL: `anthropic/${MODEL}`,
    });

    // The server wrote the run's `run_opened` — the CLI adopts, never opens.
    const events = await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: run.id } });
    expect(events.map((e) => e.kind)).toEqual(['run_opened']);

    // The supervision is queued, and its payload carries no secret.
    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId: 'hosted-run/supervise' } });
    expect(queued).toHaveLength(1);
    const stored = JSON.stringify(
      await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/supervise' } }),
    );
    expect(stored).toContain(run.id);
    expect(stored).not.toContain('sk-run-key-secret');
    expect(stored).not.toContain(spec.env['MOTIR_RUN_TOKEN']!);
  });

  it('AC4 — the same idempotency key twice yields one run and one container', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    const input = { workItemKey: card.identifier, model: MODEL, idempotencyKey: 'same-click' };

    const first = await hostedRunService.start(input, fx.ctx);
    const second = await hostedRunService.start(input, fx.ctx);

    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(await runRows()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('AC6 — a run-credential mint that fails after the key was minted ends the run failed and revokes the key', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    vi.spyOn(runCredentialService, 'mintRunCredential').mockRejectedValue(new Error('mint down'));

    await expect(start(card.identifier)).rejects.toThrow('mint down');

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
    expect(mintCalls()).toHaveLength(1);
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url === `${GATEWAY}/api/motir/run-keys/${runs[0]!.id}`,
      ),
    ).toBe(true);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: runs[0]!.id, kind: 'log' },
    });
    expect(log?.body).toContain('mint down');
  });

  // Coverage top-up (MOTIR-692): a container nobody supervises spends until the
  // reaper finds it — so a failure to ENQUEUE the supervision job tears the
  // container down through the seam's own settle, right there, and still fails
  // the run (rather than leaving a booted container behind).
  it('a failure to enqueue the supervision settles the container it just booted, and fails the run', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    const sendEventModule = await import('@/lib/jobs/sendEvent');
    const original = sendEventModule.sendEvent;
    // Only the SUPERVISION enqueue fails — claiming a leg emits its own
    // `work-item/transitioned` event first, and that one must still land.
    vi.spyOn(sendEventModule, 'sendEvent').mockImplementation((async (
      name: string,
      ...rest: unknown[]
    ) => {
      if (name === 'hosted-run/supervise') throw new Error('queue is down');
      return (original as (...args: unknown[]) => Promise<void>)(name, ...rest);
    }) as typeof sendEventModule.sendEvent);

    await expect(start(card.identifier)).rejects.toThrow('queue is down');

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const runs = await runRows();
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });

  // Coverage top-up (MOTIR-692): the leaf's own claim is refused AFTER the run
  // has already opened — a race the readiness check cannot see (another
  // claimer moved between it and the claim). The run still ends `failed`,
  // exactly as any other post-open failure does.
  it('a leaf whose claim is refused after the run opened ends it failed', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    vi.spyOn(workItemsService, 'claimWorkItem').mockResolvedValueOnce({
      outcome: 'blocked',
      claimed: false,
    } as unknown as Awaited<ReturnType<typeof workItemsService.claimWorkItem>>);

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });
});

describe('no model sent — the server resolves it from difficulty (MOTIR-6994)', () => {
  const SONNET = 'claude-sonnet-5-5';
  const OPUS = 'claude-opus-5-5';
  const LEVELS = { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS };

  it('a High leaf with the project’s High override runs on the override, in the row and the container', async () => {
    stub({ models: { ids: [SONNET, OPUS, 'claude-fable-5-1'], defaultsByDifficulty: LEVELS } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { hostedModelHigh: 'claude-fable-5-1' },
    });
    const card = await newCard({ kind: 'task', title: 'a hard card' });
    await setDifficulty(card.id, 'high');

    const started = await startResolved(card.identifier);

    const run = (await runRows())[0]!;
    expect(run).toMatchObject({ id: started.dispatchRunId, model: 'claude-fable-5-1' });
    expect(mintCalls()[0]!.body!['models']).toEqual(['claude-fable-5-1']);
    expect(fakeOrchestrator.specs[0]!.env['MOTIR_MODEL']).toBe('anthropic/claude-fable-5-1');
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      implementationModel: 'claude-fable-5-1',
    });
  });

  it('with no override, a Low leaf runs on the platform’s Low default', async () => {
    stub({ models: { ids: [OPUS, SONNET], defaultsByDifficulty: LEVELS } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'an easy card' });
    await setDifficulty(card.id, 'low');

    await startResolved(card.identifier);

    expect((await runRows())[0]!.model).toBe(SONNET);
  });

  it('a model the caller SENT wins over the resolved one', async () => {
    stub({ models: { ids: [SONNET, OPUS], defaultsByDifficulty: LEVELS } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    await adminDb.project.update({ where: { id: fx.projectId }, data: { hostedModelHigh: OPUS } });
    const card = await newCard({ kind: 'task', title: 'a hard card' });
    await setDifficulty(card.id, 'high');

    await start(card.identifier, SONNET);

    expect((await runRows())[0]!.model).toBe(SONNET);
  });

  it('a parent resolves from its HIGHEST unfinished leaf', async () => {
    stub({ models: { ids: [SONNET, OPUS], defaultsByDifficulty: LEVELS } });
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const easy = await newCard({ kind: 'task', title: 'easy', parentId: story.id });
    const hard = await newCard({ kind: 'task', title: 'hard', parentId: story.id });
    await pinRepos(easy.id, [site]);
    await pinRepos(hard.id, [site]);
    await setDifficulty(easy.id, 'low');
    await setDifficulty(hard.id, 'high');

    await startResolved(story.identifier);

    expect((await runRows())[0]!.model).toBe(OPUS);
  });

  it('the same idempotency key twice still yields one run', async () => {
    stub({ models: { ids: [SONNET, OPUS], defaultsByDifficulty: LEVELS } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    const input = { workItemKey: card.identifier, idempotencyKey: 'same-click' };

    const first = await hostedRunService.start(input, fx.ctx);
    const second = await hostedRunService.start(input, fx.ctx);

    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(await runRows()).toHaveLength(1);
  });

  it('nothing offered: HostedModelsUnavailableError, and nothing is opened', async () => {
    stub({ models: { ids: [] } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });

    await expect(startResolved(card.identifier)).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
    await expectNothingStarted();
  });
});

describe('a parent card — one run over its children', () => {
  it('AC10 — two ready children in two repositories: one run, both legs in dependency order, claimed and stamped, one container', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    // `later` sits first on the board but is blocked by `earlier`.
    const later = await newCard({ kind: 'task', title: 'later', parentId: story.id });
    const earlier = await newCard({
      kind: 'task',
      title: 'earlier',
      parentId: story.id,
    });
    await pinRepos(later.id, [site]);
    await pinRepos(earlier.id, [api]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: later.id,
      toId: earlier.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const started = await start(story.identifier);

    const run = (await runRows())[0]!;
    expect(run).toMatchObject({
      id: started.dispatchRunId,
      command: 'run_scope',
      origin: 'hosted',
    });
    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: run.id },
      orderBy: { position: 'asc' },
    });
    expect(legs.map((l) => l.workItemKey)).toEqual([earlier.identifier, later.identifier]);

    for (const id of [earlier.id, later.id]) {
      expect(await adminDb.workItem.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'in_progress',
        assigneeId: fx.ownerId,
        implementationSource: 'hosted',
        implementationModel: MODEL,
      });
    }
    // Write access was checked over BOTH repositories: the connected one asked GitHub.
    expect(calls.some((c) => c.url.endsWith('/repos/acme/api/installation'))).toBe(true);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env['MOTIR_WORK_ITEM_KEY']).toBe(story.identifier);
  });

  it('AC10 — a child whose repository cannot be written refuses the whole start', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const one = await newCard({ kind: 'task', title: 'one', parentId: story.id });
    const two = await newCard({ kind: 'task', title: 'two', parentId: story.id });
    await pinRepos(one.id, [site]);
    await pinRepos(two.id, [api]);
    stub({ installation: { 'acme/api': 404 } });

    await expect(start(story.identifier)).rejects.toBeInstanceOf(
      HostedRunRepositoryNotWritableError,
    );
    await expectNothingStarted();
    for (const id of [one.id, two.id, story.id]) {
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status).toBe('todo');
    }
  });

  // Coverage top-up (MOTIR-692): a scope that is not one layer deep is refused
  // as `wrong_shape` — before the model, the credits or the repository check —
  // exactly as the model-and-repository refusals above are, and just as
  // vacuously of anything opened, minted or booted.
  it('a scope more than one layer deep is refused, before the model check is even asked', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const child = await newCard({ kind: 'task', title: 'a child', parentId: story.id });
    // `task` may parent `bug` (the matrix goes deeper than a flat two levels) —
    // so this is a legal tree, and the REFUSAL is the scope shape, not the parent.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'a grandchild', parentId: child.id },
      fx.ctx,
    );

    await expect(start(story.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    expect(aiCalls()).toEqual([]);
    await expectNothingStarted();
  });

  // Coverage top-up (MOTIR-692): the scope claim itself is refused AFTER the
  // run has already opened — a race the readiness preview cannot see (another
  // claimer moved between the preview and the claim). The run still ends
  // `failed`, exactly as any other post-open failure does.
  it('a parent scope claim refused after the run opened ends it failed', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const child = await newCard({ kind: 'task', title: 'a child', parentId: story.id });
    await pinRepos(child.id, [site]);
    vi.spyOn(scopeClaimService, 'claimScope').mockResolvedValueOnce({
      claimed: false,
      outcome: 'taken',
    } as unknown as Awaited<ReturnType<typeof scopeClaimService.claimScope>>);

    await expect(start(story.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });
});

// MOTIR-7330: a double-click on Run hosted. The second press can pass step 0's
// key read before the first press opens its run; the first press then opens it
// and claims the card, so the second press's readiness check reads a card its
// own first press moved. Forced here by making step 0 miss once: the answer must
// be the first press's run, never a "not ready" refusal of the press itself.
describe('Run hosted — a second press of the same key that missed step 0', () => {
  const press = (key: string) =>
    hostedRunService.start({ workItemKey: key, model: MODEL, idempotencyKey: 'dbl' }, fx.ctx);

  it('a leaf: answers the first press’s run, never "in_progress, not in the to-do category"', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });

    const a = await press(card.identifier);
    vi.spyOn(dispatchRunRepository, 'findByIdempotencyKey').mockResolvedValueOnce(null);
    const b = await press(card.identifier);

    expect(a.created).toBe(true);
    expect(b).toEqual({ dispatchRunId: a.dispatchRunId, created: false });
    expect(await runRows()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('a parent: answers the first press’s run, never the scope preview’s refusal', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const child = await newCard({ kind: 'task', title: 'a child', parentId: story.id });
    await pinRepos(child.id, [site]);

    const a = await press(story.identifier);
    vi.spyOn(dispatchRunRepository, 'findByIdempotencyKey').mockResolvedValueOnce(null);
    const b = await press(story.identifier);

    expect(a.created).toBe(true);
    expect(b).toEqual({ dispatchRunId: a.dispatchRunId, created: false });
    expect(await runRows()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

// ── CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6792) ─────────────────────────
// `start` with `mode: 'continue'`: the continue claim where Run hosted's
// readiness check and open were, behind every one of Run hosted's pre-flights.

/** An In Progress card, assigned to the owner, whose one LOCAL run checked out a
 *  branch and then went silent — the run a hosted continue takes over. */
async function deadCard(opts: { silentMinutes?: number } = {}) {
  const card = await newCard({ kind: 'task', title: 'a card whose run died' });
  await adminDb.workItem.update({
    where: { id: card.id },
    data: { status: 'in_progress', assigneeId: fx.ownerId },
  });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch: `subtask/${card.identifier}-work` },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - (opts.silentMinutes ?? 7) * 60_000) },
  });
  return { card, deadRunId: run.id };
}

const startContinue = (key: string, idempotencyKey = `idem-${++seq}`) =>
  hostedRunService.start(
    { workItemKey: key, model: MODEL, idempotencyKey, mode: 'continue' },
    fx.ctx,
  );

const continueRuns = () =>
  adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId, command: 'continue' } });

describe('continue hosted — a leaf whose run died', () => {
  it('opens ONE hosted continue run, boots ONE container in continue mode, and writes no status', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCard();

    const started = await startContinue(card.identifier);
    expect(started.created).toBe(true);

    const runs = await continueRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: started.dispatchRunId,
      origin: 'hosted',
      command: 'continue',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
    });
    // The lapsed run is closed by the claim, in the claim's transaction.
    const dead = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: deadRunId } });
    expect(dead).toMatchObject({ stopReason: 'abandoned' });

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({
      status: 'in_progress',
      assigneeId: fx.ownerId,
      implementationSource: 'hosted',
      implementationModel: MODEL,
    });

    expect(mintCalls()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: started.dispatchRunId,
      MOTIR_WORK_ITEM_KEY: card.identifier,
      MOTIR_RUN_MODE: 'continue',
    });

    // ONE `run_opened`, written by the claim — the container adopts it.
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: started.dispatchRunId },
    });
    expect(events.map((e) => e.kind)).toEqual(['run_opened']);
    expect(events[0]!.data).toMatchObject({
      continuesRunId: deadRunId,
      branch: `subtask/${card.identifier}-work`,
      origin: 'hosted',
      model: MODEL,
    });

    // The part reads it as HOSTED, so it says so and points at Run above (MOTIR-6796).
    expect(await workItemContinueService.getContinueView(card.id, fx.ctx)).toMatchObject({
      state: 'continuing',
      origin: 'hosted',
      byViewer: true,
    });
  });

  it('takes the card off To fix — the claim clears the stored run_died (Story MOTIR-6590 · MOTIR-6883, case 2)', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCard();
    // Recorded dead, so the card's stored reason says so before the press.
    await dispatchRunService.close(deadRunId, { stopReason: 'interrupted' }, fx.ctx);
    const reasonOf = async () =>
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).fixReason;
    expect(await reasonOf()).toBe('run_died');

    const started = await startContinue(card.identifier);

    expect(started.created).toBe(true);
    expect(await reasonOf()).toBeNull();
  });

  it('the same key twice answers one run and boots one container', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();

    const first = await startContinue(card.identifier, 'same-press');
    const second = await startContinue(card.identifier, 'same-press');

    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(await continueRuns()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('two presses of the same key AT ONCE answer one run and boot one container', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();

    // Whichever way the two interleave — the second seeing the first's run at the
    // short-circuit, both passing it and the claim replaying the opening, or the
    // second's PREVIEW running after the first's claim committed (re-read by key,
    // MOTIR-7312; forced in the next test) — the answer is the same run, opened once.
    const [a, b] = await Promise.all([
      startContinue(card.identifier, 'double-click'),
      startContinue(card.identifier, 'double-click'),
    ]);

    expect(a.dispatchRunId).toBe(b.dispatchRunId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await continueRuns()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  // MOTIR-7312: the THIRD interleaving, forced rather than left to timing. The
  // second press passes the short-circuit, the first press's claim then commits,
  // and only then does the second press's preview run — so it sees the first
  // press's open run as somebody `continuing` the card. It must still answer that
  // run, never refuse its own press as `taken`.
  it('a second press whose preview runs AFTER the first press committed answers its run, never "taken"', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();

    let secondReachedPreview!: () => void;
    const secondAtPreview = new Promise<void>((resolve) => (secondReachedPreview = resolve));
    let firstClaimed!: () => void;
    const firstCommitted = new Promise<void>((resolve) => (firstClaimed = resolve));

    const preview = workItemContinueService.previewHostedContinue.bind(workItemContinueService);
    let previews = 0;
    vi.spyOn(workItemContinueService, 'previewHostedContinue').mockImplementation(
      async (...args) => {
        if (++previews === 2) {
          // This press passed the short-circuit before anything was opened.
          secondReachedPreview();
          await firstCommitted;
        }
        return preview(...args);
      },
    );
    const claim = workItemContinueService.claimContinue.bind(workItemContinueService);
    vi.spyOn(workItemContinueService, 'claimContinue').mockImplementation(async (...args) => {
      // The first press may not commit its claim until the second has passed the
      // short-circuit — otherwise the second would replay there and never preview.
      await secondAtPreview;
      const answered = await claim(...args);
      firstClaimed();
      return answered;
    });

    const [a, b] = await Promise.all([
      startContinue(card.identifier, 'double-click'),
      startContinue(card.identifier, 'double-click'),
    ]);

    expect(previews).toBe(2);
    expect(a.dispatchRunId).toBe(b.dispatchRunId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await continueRuns()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('a Run hosted start (mode run) on the same In Progress card is still refused as not ready', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    expect(await continueRuns()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

/** A card whose one run stopped at a gate (MOTIR-7708): closed `gated`, holding one
 *  `design_result` gate on the card in `state`. */
async function gatedCard(state: 'awaiting' | 'approved') {
  const { card, deadRunId } = await deadCard();
  await dispatchRunService.close(deadRunId, { stopReason: 'gated' }, fx.ctx);
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: 'design_result',
      subjectId: `subject-${card.id}`,
      state,
      ...(state === 'approved' ? { decidedById: fx.ownerId, decidedAt: new Date() } : {}),
    },
  });
  await adminDb.dispatchRunHeldGate.create({
    data: {
      workspaceId: fx.workspaceId,
      dispatchRunId: deadRunId,
      gateId: gate.id,
      workItemId: card.id,
      kind: 'design_result',
    },
  });
  return { card, gatedRunId: deadRunId };
}

describe('continue hosted — a run that stopped at a gate (MOTIR-7708)', () => {
  it('boots ONE hosted continue once its gate is approved, recorded as a resume', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, gatedRunId } = await gatedCard('approved');

    const started = await startContinue(card.identifier);

    expect(started.created).toBe(true);
    expect(await continueRuns()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({ MOTIR_RUN_MODE: 'continue' });
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: started.dispatchRunId, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      continuesRunId: gatedRunId,
      resumesGated: true,
      branch: `subtask/${card.identifier}-work`,
    });
    // The gated run is left as it ended — a resume does not rewrite it as a death.
    expect(
      await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: gatedRunId } }),
    ).toMatchObject({ status: 'succeeded', stopReason: 'gated' });
  });

  it('while its gate still waits: hosted_continue_gate_awaiting, nothing opened', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await gatedCard('awaiting');

    await expect(startContinue(card.identifier)).rejects.toMatchObject({
      code: 'hosted_continue_gate_awaiting',
    });
    expect(await continueRuns()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('continue hosted — every refusal before anything is opened', () => {
  async function expectNoContinue(cardId: string): Promise<void> {
    expect(await continueRuns()).toEqual([]);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } });
    expect(after.assigneeId).toBe(fx.ownerId);
    expect(after.implementationSource).toBeNull();
  }

  it('out of credits: refused after the preview, with no run, no claim and the dead run left open', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCard();
    stub({ mayRun: false });

    await expect(startContinue(card.identifier)).rejects.toBeInstanceOf(HostedRunOutOfCreditsError);
    await expectNoContinue(card.id);
    // The claim never ran, so the lapsed run was not even closed.
    const dead = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: deadRunId } });
    expect(dead.stopReason).toBeNull();
  });

  it('a model not offered: refused, nothing opened', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();

    await expect(
      hostedRunService.start(
        { workItemKey: card.identifier, model: 'nope', idempotencyKey: 'k', mode: 'continue' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    await expectNoContinue(card.id);
  });

  it('a run still heartbeating: hosted_continue_run_alive, before the model is even asked', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard({ silentMinutes: 1 });

    const err = await startContinue(card.identifier).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedContinueRefusedError);
    expect(err).toMatchObject({ code: 'hosted_continue_run_alive' });
    expect(aiCalls()).toEqual([]);
    await expectNoContinue(card.id);
  });

  it('a card never run: hosted_continue_no_dead_run', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'never run' });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { status: 'in_progress', assigneeId: fx.ownerId },
    });

    await expect(startContinue(card.identifier)).rejects.toMatchObject({
      code: 'hosted_continue_no_dead_run',
    });
    await expectNoContinue(card.id);
  });

  it('a card at To Do: hosted_continue_not_in_progress', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'to do' });
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });

    await expect(startContinue(card.identifier)).rejects.toMatchObject({
      code: 'hosted_continue_not_in_progress',
    });
    await expectNoContinue(card.id);
  });

  it('a second continue while the first is running: hosted_continue_taken, naming its holder', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();
    await startContinue(card.identifier);

    await expect(startContinue(card.identifier)).rejects.toMatchObject({
      code: 'hosted_continue_taken',
      holder: { id: fx.ownerId },
    });
    expect(await continueRuns()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('continue hosted — a failure after the claim', () => {
  it('ends the continue run failed, leaves the card as it was, and a second continue is accepted', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();
    const mint = vi
      .spyOn(runCredentialService, 'mintRunCredential')
      .mockRejectedValueOnce(new Error('mint down'));

    await expect(startContinue(card.identifier)).rejects.toThrow('mint down');
    const failed = await continueRuns();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed' });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('in_progress');

    mint.mockRestore();
    const again = await startContinue(card.identifier);
    expect(again.created).toBe(true);
    const runs = await continueRuns();
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === again.dispatchRunId)).toMatchObject({ status: 'running' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('continue hosted — a leg of a dead PARENT run', () => {
  it('continues the PARENT: the container boots on the parent key, over every leg', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'the story' });
    const first = await newCard({ kind: 'task', title: 'first', parentId: story.id });
    const second = await newCard({ kind: 'task', title: 'second', parentId: story.id });
    for (const id of [story.id, first.id, second.id]) {
      await adminDb.workItem.update({
        where: { id },
        data: { status: 'in_progress', assigneeId: fx.ownerId },
      });
    }
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: [first, second].map((c) => ({ key: c.identifier, disposition: 'queued' as const })),
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'card_settled',
          workItemKey: first.identifier,
          disposition: 'integrated',
          sessionBranch: 'motir/auto-20260928-0900',
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 8 * 60_000) },
    });

    const started = await startContinue(second.identifier);

    expect(started.created).toBe(true);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_WORK_ITEM_KEY: story.identifier,
      MOTIR_RUN_MODE: 'continue',
    });
    const opened = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: started.dispatchRunId },
    });
    expect(opened).toMatchObject({
      command: 'continue',
      origin: 'hosted',
      scopeWorkItemId: story.id,
    });
  });
});

// ── MOTIR-7208: a DeepSeek offered entry — the env is <provider>/<id>, the key BARE ──
const DEEPSEEK = 'deepseek-v4-pro';

describe('a DeepSeek model offered (MOTIR-7208) — OpenCode is named by the entry’s own provider', () => {
  it('Run hosted: MOTIR_MODEL=deepseek/<id>, while the key, the run row and the card hold the bare id', async () => {
    stub({ models: { ids: [MODEL, DEEPSEEK] } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a deepseek card' });

    const started = await start(card.identifier, DEEPSEEK);

    expect(fakeOrchestrator.specs[0]!.env['MOTIR_MODEL']).toBe(`deepseek/${DEEPSEEK}`);
    expect(mintCalls()[0]!.body!['models']).toEqual([DEEPSEEK]);
    const [run] = await runRows();
    expect(run).toMatchObject({ id: started.dispatchRunId, model: DEEPSEEK });
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).implementationModel,
    ).toBe(DEEPSEEK);
  });

  it('Run hosted on Claude from the same mixed list is unchanged: anthropic/<id>', async () => {
    stub({ models: { ids: [MODEL, DEEPSEEK] } });
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a claude card' });

    await start(card.identifier, MODEL);

    expect(fakeOrchestrator.specs[0]!.env['MOTIR_MODEL']).toBe(`anthropic/${MODEL}`);
    expect(mintCalls()[0]!.body!['models']).toEqual([MODEL]);
  });

  it('Continue hosted on DeepSeek: the same bare/prefixed split', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCard();
    stub({ models: { ids: [MODEL, DEEPSEEK] } });

    const started = await hostedRunService.start(
      {
        workItemKey: card.identifier,
        model: DEEPSEEK,
        idempotencyKey: `idem-${++seq}`,
        mode: 'continue',
      },
      fx.ctx,
    );

    expect(started.created).toBe(true);
    expect(fakeOrchestrator.specs.at(-1)!.env).toMatchObject({
      MOTIR_MODEL: `deepseek/${DEEPSEEK}`,
      MOTIR_RUN_MODE: 'continue',
    });
    expect(mintCalls().at(-1)!.body!['models']).toEqual([DEEPSEEK]);
  });
});
