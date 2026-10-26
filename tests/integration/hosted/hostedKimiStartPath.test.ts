import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import type { GithubRepo } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { deliveredPr, setStatus } from '../../helpers/repairFixtures';

// THE STORY'S motir-core INTEGRATION GATE (Story MOTIR-7351 · MOTIR-7363) — the
// hosted start path over an offered list mixing ALL FIVE providers: Anthropic,
// DeepSeek, GLM (`z-ai`), Qwen (`qwen`) and Kimi (`moonshotai`). The property under
// test is the HAND-OFF no unit test of one function sees — offered entry → minted
// key → booted env → run record — for a provider whose catalog id IS also one of
// OpenCode's bundled ids (`moonshotai`, which the egress contract's block overrides
// to point at the gateway). `docs/decisions/hosted-agent-run.md` §7, *one id, two
// spellings*: the key's allow-list, `DispatchRun.model` and `implementationModel`
// are BARE; only `MOTIR_MODEL` is `<provider>/<bare id>`, from the entry's own
// provider.
//
// Every press that boots a container is driven here: Run hosted and Continue hosted
// through the ROUTE HANDLER, Fix on the hosted agent through the same route with
// `mode: 'fix'`, and the review run through `hostedRunService.startReview`, the one
// call the review job's body makes (`agentReviewStartService.startRequested`). All
// against the real Postgres, with the seams CLAUDE.md allows: the session gates, and
// `fetch` at the external boundary — motir-ai's `/v1/agent-models` and credit
// pre-flight, the gateway's run-key mint and GitHub. The fleet is the fake orchestrator.
//
// MOTIR-7210's `hostedDeepSeekStartPath.test.ts` and MOTIR-7245's
// `hostedGlmQwenStartPath.test.ts` run unchanged beside it.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const modelsRoute = await import('@/app/api/hosted-runs/models/route');
const startRoute = await import('@/app/api/work-items/[id]/hosted-runs/route');

const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const DEEPSEEK = 'deepseek-v4-pro';
const GLM = 'glm-4.6';
const QWEN = 'qwen-plus';
const KIMI = 'kimi-k2.6';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** The list motir-ai offers: the Claude default and per-level defaults, DeepSeek, GLM, Qwen and Kimi. */
const OFFERED = [
  { id: OPUS, provider: 'anthropic' },
  { id: SONNET, provider: 'anthropic' },
  { id: DEEPSEEK, provider: 'deepseek' },
  { id: GLM, provider: 'z-ai' },
  { id: QWEN, provider: 'qwen' },
  { id: KIMI, provider: 'moonshotai' },
];

/** The new provider, with its bare id and its OpenCode spelling. */
const NEW_PROVIDERS = [{ name: 'Kimi', id: KIMI, opencode: `moonshotai/${KIMI}` }] as const;
const PLATFORM_LEVELS = { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS };

/** `ok` serves the list; `down` is motir-ai unreachable. */
let agentModels: 'ok' | 'down' = 'ok';
let mints: Array<Record<string, unknown>> = [];

function stubHttp(): void {
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
        if (agentModels === 'down') throw new TypeError('fetch failed');
        return json(200, { models: OFFERED, default: OPUS, defaultsByDifficulty: PLATFORM_LEVELS });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, { balanceCredits: 250, hasCredits: true, mayRun: true });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        mints.push(body ?? {});
        return json(201, { key: 'sk-run', runRef: body?.runRef, expiresAt: body?.expiresAt });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { revoked: 1 });
      }
      if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url) && method === 'GET') {
        return json(200, {
          id: 42,
          account: { login: 'motir-projects' },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: 'https://github.com/organizations/motir-projects/settings/installations/42',
        });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
        return json(201, {
          token: `ghs_run_${mints.length}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') return json(200, { slug: 'motir-integration' });
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') {
        return json(200, { id: 2002, login: decodeURIComponent(user[1] ?? '') });
      }
      if (/\/installation\/token$/.test(url) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;
/** The project's one connected repository, which `seedRepo` writes. */
let siteRepo: GithubRepo;

function newCard(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

const setDifficulty = (id: string, difficulty: 'trivial' | 'low' | 'medium' | 'high') =>
  adminDb.workItem.update({ where: { id }, data: { difficulty } });

async function seedRepo(): Promise<void> {
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: 'motir-projects',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const mirror = (siteRepo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: '721001',
      owner: 'motir-projects',
      name: 'site',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  }));
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a000',
      githubRepoId: mirror.id,
    },
  });
}

let idem = 0;

/** POST the start route as the browser does; answers the response. */
function postStart(key: string, body: Record<string, unknown>): Promise<Response> {
  return startRoute.POST(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `kimi-gate-${++idem}`, ...body }),
    }),
    { params: Promise.resolve({ id: key }) },
  );
}

/** Start, and answer the run row, the booted env and the one key minted for it. */
async function startAndRead(key: string, body: Record<string, unknown>) {
  const before = mints.length;
  const res = await postStart(key, body);
  expect(res.status).toBe(201);
  const { dispatchRunId } = (await res.json()) as { dispatchRunId: string };
  const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
  expect(mints.length - before).toBe(1);
  return { run, env: fakeOrchestrator.specs.at(-1)!.env, mint: mints.at(-1)! };
}

async function readResolved(key: string): Promise<unknown> {
  const res = await modelsRoute.GET(
    new Request(`https://app.test/api/hosted-runs/models?workItem=${encodeURIComponent(key)}`),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { resolved: unknown }).resolved;
}

/** An In Progress card whose one local run went silent — what Continue hosted takes over. */
async function deadCard(title: string) {
  const card = await newCard(title);
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
    data: { lastHeartbeatAt: new Date(Date.now() - 7 * 60_000) },
  });
  return card;
}

/** A card In Review over one open green pull request, which a review sent back — what Fix takes. */
async function sentBackCard(title: string) {
  const card = await newCard(title);
  await setStatus(card.id, 'in_review');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const pr = await deliveredPr(fx, card.id, siteRepo, {
    headRef: `subtask/${card.identifier}-work`,
    checks: { Vitest: 'success' },
  });
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: 'agent_review',
      subjectId: card.id,
      subjectVersion: `${siteRepo.owner}/${siteRepo.name}#${pr.number}@${'c'.repeat(40)}`,
      state: 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: new Date('2026-10-02T10:00:00Z'),
      decidedByLabel: 'Review agent',
      decisionSource: 'ui',
      decidedUnderAuthority: 'review_agent',
      noteMd: '1. The new route has no tenant check.',
    },
  });
  return card;
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  ctxRef.current = fx.ctx;
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  agentModels = 'ok';
  mints = [];
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
  stubHttp();
  await seedRepo();
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

describe('the hosted start path over Anthropic, DeepSeek, GLM, Qwen and Kimi (MOTIR-7363)', () => {
  for (const p of NEW_PROVIDERS) {
    it(`Run hosted on ${p.name}: the key, the run and the card BARE; the env ${p.opencode}`, async () => {
      const card = await newCard(`a ${p.name} card`);
      const { run, env, mint } = await startAndRead(card.identifier, { model: p.id });

      expect(mint['models']).toEqual([p.id]);
      expect(env['MOTIR_MODEL']).toBe(p.opencode);
      expect(run.model).toBe(p.id);
      expect(
        (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).implementationModel,
      ).toBe(p.id);
    });

    it(`Continue hosted on ${p.name}: the same bare/prefixed split`, async () => {
      const card = await deadCard(`a ${p.name} card whose run died`);
      const { run, env, mint } = await startAndRead(card.identifier, {
        model: p.id,
        mode: 'continue',
      });

      expect(run.command).toBe('continue');
      expect(mint['models']).toEqual([p.id]);
      expect(env).toMatchObject({ MOTIR_MODEL: p.opencode, MOTIR_RUN_MODE: 'continue' });
      expect(run.model).toBe(p.id);
    });

    it(`Fix on the hosted agent on ${p.name}: the same bare/prefixed split`, async () => {
      const card = await sentBackCard(`a ${p.name} card a review sent back`);
      const { run, env, mint } = await startAndRead(card.identifier, {
        model: p.id,
        mode: 'fix',
      });

      expect(run.command).toBe('fix');
      expect(mint['models']).toEqual([p.id]);
      expect(env).toMatchObject({ MOTIR_MODEL: p.opencode, MOTIR_RUN_MODE: 'fix' });
      expect(run.model).toBe(p.id);
    });
  }

  it('Claude, DeepSeek, GLM and Qwen from the same five-provider list are exactly as before', async () => {
    for (const [id, opencode] of [
      [OPUS, `anthropic/${OPUS}`],
      [DEEPSEEK, `deepseek/${DEEPSEEK}`],
      [GLM, `z-ai/${GLM}`],
      [QWEN, `qwen/${QWEN}`],
    ] as const) {
      const started = await startAndRead((await newCard(`a ${id} card`)).identifier, {
        model: id,
      });
      expect(started.mint['models']).toEqual([id]);
      expect(started.env['MOTIR_MODEL']).toBe(opencode);
      expect(started.run.model).toBe(id);
    }
  });

  it("the review run still takes the list's default, Claude", async () => {
    const card = await newCard('a card under review');
    const before = mints.length;
    const started = await hostedRunService.startReview(
      {
        workItemId: card.id,
        gateId: 'gate-under-review',
        subjectVersion: 'acme/site#1@abc',
        idempotencyKey: `review-${card.identifier}`,
      },
      fx.ctx,
      {},
    );

    expect(started.created).toBe(true);
    const run = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: started.dispatchRunId },
    });
    expect(run.command).toBe('review');
    expect(run.model).toBe(OPUS);
    expect(mints.length - before).toBe(1);
    expect(mints.at(-1)!['models']).toEqual([OPUS]);
    expect(fakeOrchestrator.specs.at(-1)!.env).toMatchObject({
      MOTIR_MODEL: `anthropic/${OPUS}`,
      MOTIR_RUN_MODE: 'review',
    });
  });

  it('not offered: a Kimi id off the list is refused 422 — nothing minted, nothing booted', async () => {
    const card = await newCard('a card');
    const res = await postStart(card.identifier, { model: 'kimi-k2.7-code' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_model_not_offered');
    expect(mints).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it("OpenCode's own spelling is not an offered id: `moonshotai/kimi-k2.6` as the model is refused", async () => {
    const card = await newCard('a card');
    const res = await postStart(card.identifier, { model: `moonshotai/${KIMI}` });

    expect(res.status).toBe(422);
    expect(mints).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('preselection is untouched: every difficulty resolves to its Claude default, never Kimi', async () => {
    for (const [difficulty, want] of Object.entries(PLATFORM_LEVELS)) {
      const card = await newCard(`a ${difficulty} card`);
      await setDifficulty(card.id, difficulty as keyof typeof PLATFORM_LEVELS);
      expect(await readResolved(card.identifier)).toMatchObject({
        model: want,
        source: 'platform_level',
      });
    }
    const card = await newCard('a hard card');
    await setDifficulty(card.id, 'high');
    const { env, mint } = await startAndRead(card.identifier, {});
    expect(env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);
    expect(mint['models']).toEqual([OPUS]);
  });
});
