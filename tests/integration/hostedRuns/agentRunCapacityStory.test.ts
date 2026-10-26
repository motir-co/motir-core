import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { HostedRunNoCapacityError } from '@/lib/hostedRuns/errors';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import {
  __resetAgentRunCapacityForTests,
  CAPACITY_429_WINDOW_MS_ENV_VAR,
  CAPACITY_CACHE_MS_ENV_VAR,
} from '@/lib/services/agentRunCapacityService';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';
import { connectRepairRepo, deliveredPr, setStatus } from '../../helpers/repairFixtures';

// THE STORY GATE, SERVER SIDE (Story MOTIR-9541 · MOTIR-9631) — the picker read and
// every hosted start path over ONE real `agentRunCapacityService`, real Postgres and
// the real routes, with exactly one capacity seam faked: the gateway's
// `GET /api/motir/capacity`, answered through MOTIR-9608's real HTTP client by one
// `fetch` router that also answers motir-ai, the run-key mint and GitHub, so neither
// stub can answer the other's request.
//
// ⚠️ THE AGREEMENT IS ASSERTED AT EVERY STATE, not once: `expectAgreement` reads the
// picker and presses Run for the same model, and the two must give the same answer.
// The cache and 429 windows move on a faked `Date` only, so nothing sleeps and
// Postgres I/O runs on real timers.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET: MODELS } = await import('@/app/api/hosted-runs/models/route');
const { POST: START } = await import('@/app/api/work-items/[id]/hosted-runs/route');
const { POST: APPEND } =
  await import('@/app/api/v1/projects/[projectKey]/plan-session/turns/route');
const { POST: SUBMIT } =
  await import('@/app/api/v1/projects/[projectKey]/plan-session/submissions/route');

const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const CAPACITY_URL = `${GATEWAY}/api/motir/capacity`;
const TOKEN = 'cap-token-sentinel-qzx';
const CACHE_MS = 1_000;
const WINDOW_MS = 10_000;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const FULL = 'deepseek-v4'; // its agent share used
const OPEN = 'claude-opus-5-5'; // a claude row with room
const HOT = 'claude-sonnet-5-5'; // a claude row answering 429s
const GLM = 'glm-5'; // z-ai: no gateway provider
const HAIKU = 'claude-haiku-5-5'; // anthropic, no claude row
const QWEN = 'qwen3-max'; // qwen, limits unknown / not applicable

const PROVIDER: Record<string, string> = {
  [FULL]: 'deepseek',
  [OPEN]: 'anthropic',
  [HOT]: 'anthropic',
  [GLM]: 'z-ai',
  [HAIKU]: 'anthropic',
  [QWEN]: 'qwen',
};

// ── the gateway capacity read, wire-shaped (`docs/motir-capacity-api.md` §3) ──

type Lane = Record<string, unknown> | null;
const NA = { status: 'not_applicable' };
const UNKNOWN = { status: 'unknown' };
const set = (value: number) => ({ status: 'set', value });

function lane(o: { inFlight?: number; rpm?: number; tokens?: number; r429?: number } = {}) {
  return {
    in_flight: o.inFlight ?? 0,
    requests_per_minute: o.rpm ?? 0,
    tokens_per_minute: o.tokens ?? 0,
    tokens_per_day: o.tokens ?? 0,
    rate_limited_429: { minute: o.r429 ?? 0, day: o.r429 ?? 0 },
  };
}

function entry(
  provider: string,
  model: string,
  o: { limits?: object; share?: number; agent?: Lane; planning?: Lane } = {},
) {
  return {
    provider,
    model,
    tier_note: 'Tier 3',
    unknown_note: '',
    planning_share_percent: o.share ?? 0,
    limits: {
      max_concurrency: NA,
      rpm: NA,
      input_tpm: NA,
      output_tpm: NA,
      tpm: NA,
      tpd: NA,
      ...o.limits,
    },
    lanes: {
      planning: o.planning === undefined ? lane() : o.planning,
      agent: o.agent === undefined ? lane() : o.agent,
    },
    provider_hint: null,
  };
}

/** The share-full row the requirement names: 4 at once, planning 25 %, the agent lane at 3. */
const shareFull = (inFlight = 3) =>
  entry('deepseek', FULL, {
    limits: { max_concurrency: set(4) },
    share: 25,
    agent: lane({ inFlight }),
  });
const roomy = () =>
  entry('claude', OPEN, { limits: { max_concurrency: set(40) }, agent: lane({ inFlight: 1 }) });
const hot = (r429 = 2) => entry('claude', HOT, { planning: lane({ r429 }) });

type Gateway =
  | { kind: 'answer'; entries: unknown[]; store?: 'live' | 'unavailable' }
  | { kind: 'network' };
let gateway: Gateway = { kind: 'answer', entries: [] };

const answer = (entries: unknown[], store: 'live' | 'unavailable' = 'live') => {
  gateway = { kind: 'answer', entries, store };
};

// ── the one fetch router ────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let offered: { ids: string[]; default: string; byDifficulty?: Record<string, string> } = {
  ids: [FULL, OPEN],
  default: OPEN,
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function answerAi(url: string, body: Record<string, unknown> | null): Response | null {
  if (url === `${AI}/v1/agent-models`) {
    return json(200, {
      models: offered.ids.map((id) => ({ id, provider: PROVIDER[id] })),
      default: offered.default,
      ...(offered.byDifficulty ? { defaultsByDifficulty: offered.byDifficulty } : {}),
    });
  }
  if (url === `${AI}/v1/credits/agent-run-check`) {
    return json(200, {
      coreOrganizationId: body?.coreOrganizationId,
      balanceCredits: 250,
      hasCredits: true,
      mayRun: true,
    });
  }
  if (url === `${AI}/v1/jobs`) return json(202, { jobId: 'job-plan' });
  return null;
}

function answerGateway(url: string, method: string, body: Record<string, unknown> | null) {
  if (url === CAPACITY_URL && method === 'GET') {
    if (gateway.kind === 'network') throw new TypeError('fetch failed');
    return json(200, {
      success: true,
      read_at: new Date().toISOString(),
      counter_store: { state: gateway.store ?? 'live', scope: 'shared' },
      entries: gateway.entries,
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
  return null;
}

function answerGithub(url: string, method: string): Response | null {
  const inst = /\/repos\/([^/]+)\/[^/]+\/installation$/.exec(url);
  if (inst && method === 'GET') {
    return json(200, {
      id: 42,
      account: { login: inst[1] },
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended_at: null,
      html_url: `https://github.com/organizations/${inst[1]}/settings/installations/42`,
    });
  }
  if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
    return json(201, {
      token: 'ghs_run',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  if (url.endsWith('/app') && method === 'GET') return json(200, { slug: 'motir-integration' });
  const user = /\/users\/(.+)$/.exec(url);
  if (user && method === 'GET') return json(200, { id: 2002, login: decodeURIComponent(user[1]!) });
  if (/\/installation\/token$/.test(url) && method === 'DELETE')
    return new Response(null, { status: 204 });
  return null;
}

function route(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const res =
        answerAi(url, body) ?? answerGateway(url, method, body) ?? answerGithub(url, method);
      if (!res) throw new Error(`unexpected fetch in test: ${method} ${url}`);
      return res;
    }),
  );
}

const capacityReads = () => calls.filter((c) => c.url === CAPACITY_URL).length;
const spendCalls = () =>
  calls.filter(
    (c) =>
      c.url === `${AI}/v1/credits/agent-run-check` ||
      (c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST'),
  );

// ── the product's two doors, through their routes ──────────────────────────

type Capacity = { verdict: 'available' } | { verdict: 'no_capacity'; reason: string };
interface PickerBody {
  models: Array<{ id: string; provider: string; capacity: Capacity }>;
}

async function picker(query = ''): Promise<{ body: PickerBody; text: string }> {
  const res = await MODELS(new Request(`http://localhost/api/hosted-runs/models${query}`));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as PickerBody, text };
}

const capacityOf = (body: PickerBody, id: string) => body.models.find((m) => m.id === id)!.capacity;

/** The reason the picker holds `model` for, or `available`. */
async function pickerReason(model: string): Promise<string> {
  const capacity = capacityOf((await picker()).body, model);
  return capacity.verdict === 'no_capacity' ? capacity.reason : 'available';
}

async function post(key: string, body: object) {
  const res = await START(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `press-${++seq}`, ...body }),
    }),
    { params: Promise.resolve({ id: key }) },
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

let fx: WorkItemFixture;
let seq = 0;

async function freshCard(difficulty?: 'low' | 'high') {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `card ${++seq}` },
    fx.ctx,
  );
  if (difficulty) await adminDb.workItem.update({ where: { id: card.id }, data: { difficulty } });
  return card;
}

const runCount = () => adminDb.dispatchRun.count({ where: { workspaceId: fx.workspaceId } });

/**
 * THE AGREEMENT: the picker's verdict for `model` and a Run press for it on a fresh
 * card give the same answer — a 409 with the picker's reason and nothing opened, or a
 * started run. Answers what both said. A started run's fleet slot is released so the
 * plan's parallel figure never decides a later press.
 */
async function expectAgreement(model: string): Promise<string> {
  const capacity = capacityOf((await picker()).body, model);
  const card = await freshCard();
  const before = await runCount();
  const res = await post(card.identifier, { model });
  if (capacity.verdict === 'no_capacity') {
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'hosted_run_no_capacity',
      model,
      reason: capacity.reason,
    });
    expect(await runCount()).toBe(before);
    return capacity.reason;
  }
  expect(res.status).toBe(201);
  expect(await runCount()).toBe(before + 1);
  await adminDb.fleetInFlightSlot.deleteMany({});
  return 'available';
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** A project repository with a realized GitHub repository behind it — what a run writes to. */
async function seedRepo(): Promise<void> {
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}-motir-projects`,
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
      repoId: '963100',
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
      position: 'a0',
      githubRepoId: mirror.id,
    },
  });
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  __resetAgentRunCapacityForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date());
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  for (const [name, value] of Object.entries({
    MOTIR_CLOUD: 'true',
    MOTIR_FLEET_ORCHESTRATOR: 'fake',
    MOTIR_AI_URL: `${AI}/`,
    MOTIR_AI_SERVICE_TOKEN: 'svc-token',
    MOTIR_GATEWAY_URL: GATEWAY,
    MOTIR_GATEWAY_RUN_URL: GATEWAY,
    MOTIR_GATEWAY_CAPACITY_TOKEN: TOKEN,
    MOTIR_E2E_FAKE_GATEWAY_CAPACITY: '',
    MOTIR_RUN_KEY_MINT_SECRET: 'mint-secret',
    MOTIR_BASE_URL: 'https://app.test/',
    GITHUB_STUDIO_APP_ID: '111',
    GITHUB_STUDIO_APP_PRIVATE_KEY: PEM,
    GITHUB_APP_ID: '222',
    GITHUB_APP_PRIVATE_KEY: PEM,
    [CAPACITY_CACHE_MS_ENV_VAR]: String(CACHE_MS),
    [CAPACITY_429_WINDOW_MS_ENV_VAR]: String(WINDOW_MS),
  })) {
    vi.stubEnv(name, value);
  }
  offered = { ids: [FULL, OPEN], default: OPEN };
  answer([shareFull(), roomy()]);
  route();
  await seedRepo();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('share full — the picker labels the model and the launch refuses it with the same reason', () => {
  it('the full model reads agent_share_exhausted and is refused; the roomy one reads available and starts', async () => {
    const { body } = await picker();
    expect(capacityOf(body, FULL)).toEqual({
      verdict: 'no_capacity',
      reason: 'agent_share_exhausted',
    });
    expect(capacityOf(body, OPEN)).toEqual({ verdict: 'available' });

    const card = await freshCard();
    const refused = await post(card.identifier, { model: FULL });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      code: 'hosted_run_no_capacity',
      error: expect.any(String),
      model: FULL,
      reason: 'agent_share_exhausted',
    });

    expect(await expectAgreement(FULL)).toBe('agent_share_exhausted');
    expect(await expectAgreement(OPEN)).toBe('available');
  });

  it('no model sent: the model the difficulty resolves to is checked, not the picker default', async () => {
    offered = {
      ids: [FULL, OPEN],
      default: OPEN,
      byDifficulty: { trivial: FULL, low: FULL, medium: OPEN, high: OPEN },
    };
    const easy = await freshCard('low');

    const refused = await post(easy.identifier, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ model: FULL, reason: 'agent_share_exhausted' });
    expect(await runCount()).toBe(0);

    // The converse: only a model the card does not resolve to is full, and it starts.
    const hard = await freshCard('high');
    const started = await post(hard.identifier, {});
    expect(started.status).toBe(201);
    expect(
      await adminDb.dispatchRun.findFirstOrThrow({ where: { workspaceId: fx.workspaceId } }),
    ).toMatchObject({ model: OPEN });
  });
});

// ── every start path refused on the full model, and nothing left behind ─────

async function expectNothingSpent(): Promise<void> {
  expect(spendCalls()).toEqual([]);
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  expect(fakeOrchestrator.provisioned).toEqual([]);
}

/** A card whose CLI run went silent — what Continue hosted picks up. */
async function deadCard() {
  const card = await freshCard();
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
  return { card, deadRunId: run.id };
}

/** A card In Review over one open green pull request, that a review sent back. */
async function sentBackCard() {
  const card = await freshCard();
  await setStatus(card.id, 'in_review');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const repo = await connectRepairRepo(fx, 'web-fix');
  const pr = await deliveredPr(fx, card.id, repo, {
    headRef: `subtask/${card.identifier}-0`,
    checks: { Vitest: 'success' },
  });
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: 'agent_review',
      subjectId: card.id,
      subjectVersion: `acme/${repo.name}#${pr.number}@${'c'.repeat(40)}`,
      state: 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: new Date(Date.now() - 60_000),
      decidedByLabel: 'Review agent',
      decisionSource: 'ui',
      decidedUnderAuthority: 'review_agent',
      noteMd: '1. The new route has no tenant check.',
    },
  });
  return card;
}

const fullModelUntouched = async (cardId: string, status: string) =>
  expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } })).toMatchObject({
    status,
    implementationSource: null,
    implementationModel: null,
  });

describe('every hosted start path is refused on the full model, and opens, claims and spends nothing', () => {
  it("mode 'run' on a leaf", async () => {
    const card = await freshCard();
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    const res = await post(card.identifier, { model: FULL, mode: 'run' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ model: FULL, reason: await pickerReason(FULL) });
    expect(await runCount()).toBe(0);
    await expectNothingSpent();
    await fullModelUntouched(card.id, before.status);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      before.assigneeId,
    );
  });

  it("mode 'continue' on a dead run's card — still continuable once the share frees", async () => {
    const { card, deadRunId } = await deadCard();
    const res = await post(card.identifier, { model: FULL, mode: 'continue' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'hosted_run_no_capacity',
      model: FULL,
      reason: 'agent_share_exhausted',
    });
    expect(
      await adminDb.dispatchRun.count({
        where: { workspaceId: fx.workspaceId, command: 'continue' },
      }),
    ).toBe(0);
    expect(
      (await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: deadRunId } })).stopReason,
    ).toBeNull();
    await expectNothingSpent();
    await fullModelUntouched(card.id, 'in_progress');

    answer([shareFull(2), roomy()]);
    advance(CACHE_MS + 1);
    expect((await post(card.identifier, { model: FULL, mode: 'continue' })).status).toBe(201);
  });

  it("mode 'fix' on a card a review sent back — still fixable once the share frees", async () => {
    const card = await sentBackCard();
    const res = await post(card.identifier, { model: FULL, mode: 'fix' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'hosted_run_no_capacity',
      model: FULL,
      reason: 'agent_share_exhausted',
    });
    expect(
      await adminDb.dispatchRun.count({ where: { workspaceId: fx.workspaceId, command: 'fix' } }),
    ).toBe(0);
    await expectNothingSpent();
    await fullModelUntouched(card.id, 'in_review');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      fx.ownerId,
    );

    answer([shareFull(2), roomy()]);
    advance(CACHE_MS + 1);
    expect((await post(card.identifier, { model: FULL, mode: 'fix' })).status).toBe(201);
  });

  it('the review start on the full default model; through the requested job the gate stays awaiting', async () => {
    offered = { ids: [FULL, OPEN], default: FULL };
    const card = await freshCard();
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'agent_review',
        subjectId: card.id,
        subjectVersion: 'acme/web#1@abc',
        state: 'awaiting',
      },
    });
    const input = { workItemId: card.id, gateId: gate.id, subjectVersion: 'acme/web#1@abc' };

    const refused = await hostedRunService
      .startReview({ ...input, idempotencyKey: `agent-review:${gate.id}:direct` }, fx.ctx, {})
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunNoCapacityError);
    expect(refused).toMatchObject({ model: FULL, reason: await pickerReason(FULL) });

    expect(
      await agentReviewStartService.startRequested({ workspaceId: fx.workspaceId, ...input }),
    ).toEqual({
      outcome: 'refused',
      reason: 'hosted_run_no_capacity',
    });
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'awaiting',
      reviewUnavailableReason: 'hosted_run_no_capacity',
    });
    expect(await runCount()).toBe(0);
    await expectNothingSpent();
  });
});

describe('429s now — a model the provider is refusing is held on both doors', () => {
  it('free share but two 429s this minute on the planning lane: provider_rate_limited on both', async () => {
    offered = { ids: [HOT, OPEN], default: OPEN };
    answer([hot(), roomy()]);

    expect(capacityOf((await picker()).body, HOT)).toEqual({
      verdict: 'no_capacity',
      reason: 'provider_rate_limited',
    });
    expect(await expectAgreement(HOT)).toBe('provider_rate_limited');
    expect(await expectAgreement(OPEN)).toBe('available');
  });
});

describe('both clearing — the label and the launch move together, window by window', () => {
  it('the share frees after the cache window; the 429 model waits out its own window', async () => {
    offered = { ids: [FULL, HOT, OPEN], default: OPEN };
    answer([shareFull(), hot(), roomy()]);
    expect(await expectAgreement(FULL)).toBe('agent_share_exhausted');
    expect(await expectAgreement(HOT)).toBe('provider_rate_limited');

    // The gateway now says both have room — but the cached read still holds them.
    answer([shareFull(2), hot(0), roomy()]);
    expect(await expectAgreement(FULL)).toBe('agent_share_exhausted');
    expect(await expectAgreement(HOT)).toBe('provider_rate_limited');

    // Past the cache window: the share reads free, the 429 window has not passed.
    advance(CACHE_MS + 1);
    expect(await expectAgreement(FULL)).toBe('available');
    expect(await expectAgreement(HOT)).toBe('provider_rate_limited');

    // Past the 429 window since its last non-zero count: available, and it starts.
    advance(WINDOW_MS);
    expect(await expectAgreement(HOT)).toBe('available');
    expect(await expectAgreement(FULL)).toBe('available');
  });
});

describe('the gateway down, unconfigured or degraded — every model available, every start proceeds', () => {
  const capacityWarnings = (warn: MockInstance<typeof console.warn>) =>
    warn.mock.calls.map((c) => c.map(String).join(' ')).filter((t) => t.includes('capacity'));

  /** Every offered model reads available and starts; answers this window's warnings. */
  async function expectAllOpen(warn: MockInstance<typeof console.warn>): Promise<string[]> {
    warn.mockClear();
    const { body } = await picker();
    expect(body.models.map((m) => m.capacity)).toEqual(
      offered.ids.map(() => ({ verdict: 'available' })),
    );
    for (const id of offered.ids) expect(await expectAgreement(id)).toBe('available');
    return capacityWarnings(warn);
  }

  it('network, not_configured, counter store down: one warning per window naming the reason; a null lane: none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sentinels = [shareFull(7331), roomy()];

    gateway = { kind: 'network' };
    const network = await expectAllOpen(warn);
    expect(network).toHaveLength(1);
    expect(network[0]).toContain('network');

    advance(CACHE_MS + 1);
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
    answer(sentinels);
    const before = capacityReads();
    const unconfigured = await expectAllOpen(warn);
    expect(capacityReads()).toBe(before); // nothing is sent without a token
    expect(unconfigured).toHaveLength(1);
    expect(unconfigured[0]).toContain('not_configured');

    advance(CACHE_MS + 1);
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', TOKEN);
    answer(sentinels, 'unavailable');
    const degraded = await expectAllOpen(warn);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('counter store unavailable');

    advance(CACHE_MS + 1);
    answer([
      entry('deepseek', FULL, { limits: { max_concurrency: set(4) }, share: 25, agent: null }),
      roomy(),
    ]);
    expect(await expectAllOpen(warn)).toEqual([]);

    for (const text of [...network, ...unconfigured, ...degraded]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/7331|\d/);
    }
  });
});

describe('no entry and unknown limits — nothing to compare reads available', () => {
  it('a z-ai model, an anthropic model with no claude row, and a qwen row of unknown limits at high use', async () => {
    offered = { ids: [GLM, HAIKU, QWEN], default: HAIKU };
    answer([
      entry('qwen', QWEN, {
        limits: {
          max_concurrency: UNKNOWN,
          rpm: UNKNOWN,
          input_tpm: set(10),
          output_tpm: set(10),
          tpm: NA,
          tpd: UNKNOWN,
        },
        agent: lane({ inFlight: 900, rpm: 900, tokens: 900_000 }),
      }),
    ]);

    const { body } = await picker();
    expect(body.models.map((m) => [m.id, m.capacity])).toEqual([
      [GLM, { verdict: 'available' }],
      [HAIKU, { verdict: 'available' }],
      [QWEN, { verdict: 'available' }],
    ]);
    for (const id of [GLM, HAIKU, QWEN]) expect(await expectAgreement(id)).toBe('available');
  });
});

describe('one gateway read per cache window', () => {
  it('two picker reads and ten concurrent starts share ONE read; the next window reads once more', async () => {
    const leaf = await freshCard('high');
    await picker();
    await picker(`?workItem=${encodeURIComponent(leaf.identifier)}`);
    const cards = await Promise.all(Array.from({ length: 10 }, () => freshCard()));
    const answers = await Promise.all(
      cards.map((card, i) => post(card.identifier, { model: i % 2 === 0 ? FULL : OPEN })),
    );
    expect(answers.filter((a) => a.status === 409)).toHaveLength(5);
    expect(capacityReads()).toBe(1);

    advance(CACHE_MS + 1);
    await picker();
    expect(await expectAgreement(FULL)).toBe('agent_share_exhausted');
    expect(capacityReads()).toBe(2);
  });
});

describe('payload hygiene — nothing beyond the verdict and its reason leaves the server', () => {
  it('the picker models and the refusal carry exactly their keys, and no number, token or id', async () => {
    const SENTINELS = ['86421', '97531', '46813', '75319'];
    answer([
      entry('deepseek', FULL, {
        limits: { max_concurrency: set(86421), rpm: set(97531) },
        share: 25,
        agent: lane({ inFlight: 86421, rpm: 46813, tokens: 75319 }),
        planning: lane({ inFlight: 46813, rpm: 75319 }),
      }),
      entry('claude', OPEN, { limits: { tpm: set(97531) }, agent: lane({ tokens: 46813 }) }),
    ]);

    const { body, text } = await picker();
    for (const m of body.models) {
      expect(Object.keys(m).sort()).toEqual(['capacity', 'id', 'provider']);
      expect(Object.keys(m.capacity).sort()).toEqual(
        m.capacity.verdict === 'available' ? ['verdict'] : ['reason', 'verdict'],
      );
    }
    expect(capacityOf(body, FULL)).toEqual({
      verdict: 'no_capacity',
      reason: 'agent_share_exhausted',
    });

    const card = await freshCard();
    const refused = await post(card.identifier, { model: FULL });
    expect(refused.status).toBe(409);
    expect(Object.keys(refused.body).sort()).toEqual(['code', 'error', 'model', 'reason']);

    for (const serialised of [text, refused.text]) {
      for (const leak of [...SENTINELS, TOKEN, fx.workspaceId, fx.projectId, fx.ownerId]) {
        expect(serialised).not.toContain(leak);
      }
    }
  });
});

/** Every `.ts`/`.tsx` file under `dir`, repository-relative. */
function sourceFiles(dir: string): string[] {
  const root = join(__dirname, '../../..');
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => relative(root, join(d.parentPath, d.name)));
}

describe('planning never reaches the agent-run check', () => {
  it('only the two hosted-run consumers import the verdict service', () => {
    const root = join(__dirname, '../../..');
    const importer =
      /from\s+['"](?:@\/lib\/services\/|\.\/|\.\.\/services\/)agentRunCapacityService['"]/;
    const importers = ['app', 'lib', 'components']
      .flatMap(sourceFiles)
      .filter((f) => importer.test(readFileSync(join(root, f), 'utf8')))
      .sort();
    expect(importers).toEqual([
      'lib/services/hostedRunPickerService.ts',
      'lib/services/hostedRunService.ts',
    ]);
  });

  it('every model held, a planning submit is still sent and reads no capacity', async () => {
    offered = { ids: [FULL], default: FULL };
    answer([shareFull()]);
    expect(await pickerReason(FULL)).toBe('agent_share_exhausted');
    const readsBefore = capacityReads();

    const caller = await createV1ProjectCaller({ permissions: ['project:browse', 'ai:plan'] });
    const at = (suffix: string, body: object) =>
      [
        new Request(
          `http://localhost:3000/api/v1/projects/${caller.projectKey}/plan-session${suffix}`,
          {
            method: 'POST',
            headers: { ...caller.headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
        { params: Promise.resolve({ projectKey: caller.projectKey }) },
      ] as const;
    expect((await APPEND(...at('/turns', { body: 'plan the export' }))).status).toBe(200);
    expect((await SUBMIT(...at('/submissions', {}))).status).toBe(202);

    expect(calls.filter((c) => c.url === `${AI}/v1/jobs`)).toHaveLength(1);
    expect(capacityReads()).toBe(readsBefore);
  });
});
