import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

// THE STORY'S motir-core INTEGRATION GATE (Story MOTIR-7205 · MOTIR-7210) — the
// hosted start path over a MIXED offered list: two Anthropic models and one
// DeepSeek model. The property under test is the HAND-OFF no unit test of one
// function sees — offered entry → minted key → booted env → run record — and
// `docs/decisions/hosted-agent-run.md` §7's *one id, two spellings*, as amended by
// MOTIR-7206: the key's allow-list, `DispatchRun.model` and `implementationModel`
// are BARE; only `MOTIR_MODEL` is `<provider>/<bare id>`, from the entry's own
// provider.
//
// Driven through the ROUTE HANDLERS against the real Postgres, exactly as the
// difficulty gate next door (`hostedModelByDifficultyGate.test.ts`) is. The seams
// are the ones CLAUDE.md allows: the session gates, and `fetch` at the external
// boundary — motir-ai's `/v1/agent-models` and credit pre-flight, the gateway's
// run-key mint and GitHub's installation read. The fleet is the fake orchestrator.
//
// FIX ON THE HOSTED AGENT and the REVIEW run take the same `preflight` → `launch`
// seam; their DeepSeek cases are asserted against the same real start path by
// `tests/hostedRuns/hostedRunStartFix.test.ts` and
// `tests/agentReview/agentReviewStart.test.ts` (MOTIR-7208), which own the
// sent-back and reviewed-gate fixtures those presses need.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const settingsRoute = await import('@/app/api/projects/[key]/hosted-agent-settings/route');
const modelsRoute = await import('@/app/api/hosted-runs/models/route');
const startRoute = await import('@/app/api/work-items/[id]/hosted-runs/route');

const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const DEEPSEEK = 'deepseek-v4-pro';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** The mixed list motir-ai offers: the Claude default and per-level defaults, plus DeepSeek. */
const OFFERED = [
  { id: OPUS, provider: 'anthropic' },
  { id: SONNET, provider: 'anthropic' },
  { id: DEEPSEEK, provider: 'deepseek' },
];
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
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;

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
  const mirror = await adminDb.githubRepo.create({
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
      body: JSON.stringify({ idempotencyKey: `ds-gate-${++idem}`, ...body }),
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

async function setHighOverride(model: string | null): Promise<void> {
  const res = await settingsRoute.PATCH(
    new Request(`https://app.test/api/projects/${fx.projectIdentifier}/hosted-agent-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ high: model }),
    }),
    { params: Promise.resolve({ key: fx.projectIdentifier }) },
  );
  expect(res.status).toBe(200);
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

describe('the hosted start path over a mixed Anthropic + DeepSeek list (MOTIR-7210)', () => {
  it('Run hosted on DeepSeek: the key, the run and the card BARE; the env deepseek/<id>', async () => {
    const card = await newCard('a deepseek card');
    const { run, env, mint } = await startAndRead(card.identifier, { model: DEEPSEEK });

    expect(mint['models']).toEqual([DEEPSEEK]);
    expect(env['MOTIR_MODEL']).toBe(`deepseek/${DEEPSEEK}`);
    expect(run.model).toBe(DEEPSEEK);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).implementationModel,
    ).toBe(DEEPSEEK);
  });

  it('Run hosted on Claude from the same list is exactly as before', async () => {
    const card = await newCard('a claude card');
    const { run, env, mint } = await startAndRead(card.identifier, { model: OPUS });

    expect(mint['models']).toEqual([OPUS]);
    expect(env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);
    expect(run.model).toBe(OPUS);
  });

  it('Continue hosted on DeepSeek: the same bare/prefixed split', async () => {
    const card = await deadCard('a deepseek card whose run died');
    const { run, env, mint } = await startAndRead(card.identifier, {
      model: DEEPSEEK,
      mode: 'continue',
    });

    expect(run.command).toBe('continue');
    expect(mint['models']).toEqual([DEEPSEEK]);
    expect(env).toMatchObject({ MOTIR_MODEL: `deepseek/${DEEPSEEK}`, MOTIR_RUN_MODE: 'continue' });
    expect(run.model).toBe(DEEPSEEK);
  });

  it('not offered: a model off the list is refused 422 — nothing minted, nothing booted', async () => {
    const card = await newCard('a card');
    const res = await postStart(card.identifier, { model: 'deepseek-flash' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_model_not_offered');
    expect(mints).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('unavailable: motir-ai unreachable is 503, never an empty list and never a default', async () => {
    const card = await newCard('a card');
    agentModels = 'down';
    const res = await postStart(card.identifier, { model: DEEPSEEK });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_models_unavailable');
    expect(mints).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('the platform preselection is unchanged: with no override a High card resolves to Claude', async () => {
    const card = await newCard('a hard card');
    await setDifficulty(card.id, 'high');

    expect(await readResolved(card.identifier)).toMatchObject({
      model: OPUS,
      source: 'platform_level',
    });
    const { env, mint } = await startAndRead(card.identifier, {});
    expect(env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);
    expect(mint['models']).toEqual([OPUS]);
  });

  it('a project override naming DeepSeek: preselected, and a start without a model runs on it', async () => {
    const card = await newCard('a hard card on a deepseek project');
    await setDifficulty(card.id, 'high');
    await setHighOverride(DEEPSEEK);

    expect(await readResolved(card.identifier)).toMatchObject({
      model: DEEPSEEK,
      source: 'override',
      difficulty: 'high',
    });
    const { run, env, mint } = await startAndRead(card.identifier, {});
    expect(run.model).toBe(DEEPSEEK);
    expect(mint['models']).toEqual([DEEPSEEK]);
    expect(env['MOTIR_MODEL']).toBe(`deepseek/${DEEPSEEK}`);
  });
});
