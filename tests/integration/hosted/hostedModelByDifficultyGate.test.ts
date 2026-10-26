import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

// THE STORY'S INTEGRATION GATE (Story MOTIR-6989 · MOTIR-6997) — a hosted run
// picks its model from the card's difficulty, and the three doors that speak
// about that model must agree: the settings room's read
// (`GET/PATCH /api/projects/[key]/hosted-agent-settings`), the Run hosted
// picker's read (`GET /api/hosted-runs/models?workItem=`) and the start itself
// (`POST /api/work-items/[id]/hosted-runs` with no `model`).
//
// ONE scenario, driven through the ROUTE HANDLERS against the real Postgres. The
// seams are the ones CLAUDE.md allows: the two session gates (no cookie jar in a
// test), and `fetch` at the external boundary — motir-ai (`/v1/agent-models`,
// with `defaultsByDifficulty`, and the credit pre-flight), the gateway's run-key
// mint and GitHub's installation read. The fleet is the fake orchestrator.
//
// The offered list is MUTABLE (`offered`), so the scenario can withdraw the
// override's model mid-way and watch every door fall back together.

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
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** What motir-ai offers right now — the scenario withdraws from it. */
let offered: string[] = [];
const PLATFORM_LEVELS = { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS };

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
        return json(200, {
          models: offered.map((id) => ({ id, provider: 'anthropic' })),
          default: OPUS,
          defaultsByDifficulty: PLATFORM_LEVELS,
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, { balanceCredits: 250, hasCredits: true, mayRun: true });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
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

function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}

const setDifficulty = (id: string, difficulty: 'trivial' | 'low' | 'medium' | 'high') =>
  adminDb.workItem.update({ where: { id }, data: { difficulty } });

/** A project repository the hosted run can write, with a realized GitHub repo behind it. */
async function seedRepo(): Promise<string> {
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
      repoId: '699701',
      owner: 'motir-projects',
      name: 'site',
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
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a000',
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

async function pinRepo(workItemId: string, projectRepoId: string): Promise<void> {
  await adminDb.workItemRepo.create({
    data: { workspaceId: fx.workspaceId, workItemId, projectRepoId, position: 0 },
  });
}

// ── the three doors, as the browser calls them ────────────────────────────────

interface LevelDto {
  level: string;
  override: string | null;
  overrideOffered: boolean;
  platformDefault: string | null;
  effective: string | null;
  source: string;
}

const settingsUrl = () =>
  `https://app.test/api/projects/${fx.projectIdentifier}/hosted-agent-settings`;
const settingsParams = () => ({ params: Promise.resolve({ key: fx.projectIdentifier }) });

async function getSettings(): Promise<LevelDto[]> {
  const res = await settingsRoute.GET(new Request(settingsUrl()), settingsParams());
  expect(res.status).toBe(200);
  return ((await res.json()) as { levels: LevelDto[] }).levels;
}

async function patchSettings(body: Record<string, string | null>): Promise<LevelDto[]> {
  const res = await settingsRoute.PATCH(
    new Request(settingsUrl(), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    settingsParams(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { levels: LevelDto[] }).levels;
}

const high = (levels: LevelDto[]) => levels.find((l) => l.level === 'high')!;

async function readModels(key: string): Promise<{ resolved: unknown; default: string }> {
  const res = await modelsRoute.GET(
    new Request(`https://app.test/api/hosted-runs/models?workItem=${encodeURIComponent(key)}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { resolved: unknown; default: string };
}

let idem = 0;

/** Run hosted WITHOUT a model — the server resolves it — and answer the run's model. */
async function startWithoutModel(key: string): Promise<string | null> {
  const res = await startRoute.POST(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `gate-${++idem}` }),
    }),
    { params: Promise.resolve({ id: key }) },
  );
  expect(res.status).toBe(201);
  const { dispatchRunId } = (await res.json()) as { dispatchRunId: string };
  const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
  expect(run.origin).toBe('hosted');
  return run.model;
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
  offered = [SONNET, OPUS, FABLE];
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

describe('a hosted run picks its model from difficulty — settings, picker and start agree (MOTIR-6997)', () => {
  it('override → withdrawn → reset, then a parent resolving from its highest unfinished leaf', async () => {
    const repo = await seedRepo();
    const hardLeaf = await newCard({ kind: 'task', title: 'a hard leaf' });
    await setDifficulty(hardLeaf.id, 'high');

    // ── 1. Save a High override through PATCH; GET reads it back as `override`.
    expect(high(await patchSettings({ high: FABLE }))).toMatchObject({
      override: FABLE,
      effective: FABLE,
      source: 'override',
    });
    expect(high(await getSettings())).toEqual({
      level: 'high',
      override: FABLE,
      overrideOffered: true,
      platformDefault: OPUS,
      effective: FABLE,
      source: 'override',
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.hostedModelHigh).toBe(FABLE);

    // ── 2. The picker's read resolves the High leaf to the override.
    expect((await readModels(hardLeaf.identifier)).resolved).toEqual({
      model: FABLE,
      source: 'override',
      difficulty: 'high',
      fromLeaves: false,
    });

    // ── 3. A start WITHOUT `model` runs on the override.
    expect(await startWithoutModel(hardLeaf.identifier)).toBe(FABLE);
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe(`anthropic/${FABLE}`);

    // ── 4. motir-ai withdraws the override's model.
    offered = [SONNET, OPUS];

    // The room FLAGS it (still stored, no longer offered) and falls back.
    expect(high(await getSettings())).toEqual({
      level: 'high',
      override: FABLE,
      overrideOffered: false,
      platformDefault: OPUS,
      effective: OPUS,
      source: 'platform_level',
    });
    // The override is skipped, never an error — it stays on the row.
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).hostedModelHigh,
    ).toBe(FABLE);

    // A second High leaf (the first is now claimed by its run, so not ready).
    const hardLeaf2 = await newCard({ kind: 'task', title: 'another hard leaf' });
    await setDifficulty(hardLeaf2.id, 'high');
    expect((await readModels(hardLeaf2.identifier)).resolved).toEqual({
      model: OPUS,
      source: 'platform_level',
      difficulty: 'high',
      fromLeaves: false,
    });
    expect(await startWithoutModel(hardLeaf2.identifier)).toBe(OPUS);
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe(`anthropic/${OPUS}`);

    // ── 5. Reset the level: the override is gone, the source is `platform_level`.
    expect(high(await patchSettings({ high: null }))).toMatchObject({
      override: null,
      source: 'platform_level',
    });
    expect(high(await getSettings())).toEqual({
      level: 'high',
      override: null,
      overrideOffered: true,
      platformDefault: OPUS,
      effective: OPUS,
      source: 'platform_level',
    });
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).hostedModelHigh,
    ).toBeNull();

    // ── 6. A parent whose unfinished leaves are Low and High resolves from High —
    // Low would be SONNET, so OPUS is the proof the higher leaf won.
    const story = await newCard({ kind: 'story', title: 'a story' });
    const easy = await newCard({ kind: 'task', title: 'easy', parentId: story.id });
    const hard = await newCard({ kind: 'task', title: 'hard', parentId: story.id });
    await pinRepo(easy.id, repo);
    await pinRepo(hard.id, repo);
    await setDifficulty(easy.id, 'low');
    await setDifficulty(hard.id, 'high');

    expect((await readModels(story.identifier)).resolved).toEqual({
      model: OPUS,
      source: 'platform_level',
      difficulty: 'high',
      fromLeaves: true,
    });
    expect(await startWithoutModel(story.identifier)).toBe(OPUS);

    // Three runs, one per start, each on the model its door named.
    const runs = await adminDb.dispatchRun.findMany({
      where: { workspaceId: fx.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { model: true },
    });
    expect(runs.map((r) => r.model)).toEqual([FABLE, OPUS, OPUS]);
  });
});
