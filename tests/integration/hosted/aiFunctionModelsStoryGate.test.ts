import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE STORY'S motir-core INTEGRATION GATE (Story MOTIR-10838 · MOTIR-10848) — an
// organisation chooses the model each Motir AI function uses, and the platform sets
// the defaults it inherits. Each card of the story tests its own piece; this file
// drives the pieces TOGETHER, against the real Postgres, through the ROUTE
// HANDLERS and the console's Server Actions:
//
//   * an org run-side choice written through `PATCH /ai-models/runs` is what the
//     next hosted start, the Run hosted preselection (`GET /api/hosted-runs/models`)
//     and a hosted review start actually run on — asserted on the started run row
//     and its `run_opened` event, never on a resolver's return value;
//   * precedence end to end: the person's pick → the project's difficulty override
//     → the org per-level choice → the platform per-level default; a design run
//     takes the design-run model (org, then platform); a review the review-agent
//     model (org, then platform, then the run default);
//   * run-side qualification at resolution: the same stored org columns apply for
//     a Pro-and-above or meta org, are ignored below Pro, and apply again with no
//     re-entry; an unreadable tier never refuses a run;
//   * the gates: org owner/admin writes, member reads, non-member 404; console
//     writes superadmin only, audited from → to, nothing on a no-op or a refusal;
//     motir-ai down answers models-unreadable everywhere.
//
// The seams are the ones the repository allows: the session gates (a route test
// has no cookie jar), `requirePlatformStaff` (seeded principals), `next/cache`, the
// paid-plan admission (`grantPaidAiPlan`), `sendEvent` (the review harness hands
// the request to the job's body itself) and `fetch` at the external boundary —
// motir-ai, the gateway and GitHub — answered by ONE stateful stub that records
// every call. The fleet is the fake orchestrator.
//
// ⚠️ THE BOUNDARY. motir-ai is a stub here, so the PLANNING-side assertions check
// motir-core's HANDLING of motir-ai's documented answers (the gate, the lock payload
// built with no model ids, the refusal codes, unreadable). Planning-side
// qualification and per-job resolution are motir-ai's own code and its own
// integration gate's (MOTIR-10847). The run-side precedence and qualification are
// motir-core's code, so here they are asserted for real.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

const ctxRef = { current: null as import('@/lib/workspaces').WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
const { requireCompliantWorkspaceContext, requireCompliantSession } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
  requireCompliantSession: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantWorkspaceContext,
  requireCompliantSession,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
let currentPrincipal: import('@/lib/platform/auth').PlatformPrincipal | null = null;
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  const { NotPlatformStaffError } =
    await vi.importActual<typeof import('@/lib/platform/errors')>('@/lib/platform/errors');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import type { OrgRunModelsDTO, OrgPlannerModelsDTO } from '@/lib/dto/orgAiModels';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { grantPaidAiPlan } from '../../helpers/paidAiPlan';
import { linkPrByIdentifier } from '../../helpers/prLink';

const settingsRoute = await import('@/app/api/projects/[key]/hosted-agent-settings/route');
const modelsRoute = await import('@/app/api/hosted-runs/models/route');
const startRoute = await import('@/app/api/work-items/[id]/hosted-runs/route');
const orgRunsRoute = await import('@/app/api/organizations/[orgId]/ai-models/runs/route');
const orgPlanningRoute = await import('@/app/api/organizations/[orgId]/ai-models/planning/route');
const { setPlannerFunctionModelAction } = await import('@/app/(admin)/admin/ai-planning/actions');
const { setRunModelDefaultAction } = await import('@/app/(admin)/admin/run-models/actions');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { platformRunModelService } = await import('@/lib/services/platformRunModelService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');

const AI = 'https://ai.test';

/** Whether a URL is addressed to the motir-ai stub: compared by parsed origin, not by prefix. */
const isAi = (url: string): boolean => new URL(url).origin === AI;
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

// The models. PLATFORM_* are motir-ai's platform defaults; O, P, X, D, R the
// choices the scenario writes. Every id is distinct, so a run's model names the
// one layer it came from.
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const O = 'gpt-5.2-codex'; // the org's per-level choice
const P = 'claude-fable-5-1'; // the project's difficulty override
const X = 'glm-5.1'; // the person's own pick
const D = 'deepseek-v4-pro'; // the org's design-run choice
const D2 = 'claude-opus-5'; // the platform design-run default
const R = 'kimi-k3'; // the org's review-agent choice
const R2 = 'qwen-4-max'; // the platform review-agent default
const GUIDE = 'planning-guide-10848';
const PLANNING_OFFER = [
  { id: GUIDE, provider: 'anthropic' },
  { id: 'planning-other-10848', provider: 'z-ai' },
];
const ALL = [HAIKU, SONNET, OPUS, O, P, X, D, D2, R, R2];
const PLATFORM_LEVELS = { trivial: HAIKU, low: SONNET, medium: OPUS, high: OPUS };

// ── motir-ai, the gateway and GitHub — ONE stateful stub ───────────────────────

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const ai = {
  offered: [...ALL],
  reviewAgentDefault: null as string | null,
  designRunDefault: null as string | null,
  /** `coreOrganizationId → tierKey`; a missing org answers no tier. */
  tiers: new Map<string, string | null>(),
  tiersDown: false,
  /** Every motir-ai call fails at transport. */
  down: false,
  /** motir-ai's planning-side answer per org: whether it qualifies, and its Guide. */
  planner: new Map<string, { qualifies: boolean; guide: string | null }>(),
  /** The console's platform defaults, as motir-ai stores them. */
  functions: { guide: null, debug: null, ask: null } as Record<string, string | null>,
  runDefaults: {
    trivial: HAIKU,
    low: SONNET,
    medium: OPUS,
    high: OPUS,
    review: null,
    design: null,
  } as Record<string, string | null>,
  /** The next console write motir-ai refuses `validation_error`. */
  refuseNextWrite: false,
};
let calls: Call[] = [];

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
const problem = (status: number, code: string) =>
  json(status, { type: 'about:blank', title: code, status, code, detail: code });
const provider = (id: string) => (id.startsWith('deepseek') ? 'deepseek' : 'anthropic');

function stubHttp(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });

      if (isAi(url)) {
        if (ai.down) throw new TypeError('fetch failed');
        const { pathname, search } = new URL(url);
        const path = pathname + search;
        if (path === '/v1/agent-models') {
          return json(200, {
            models: ai.offered.map((id) => ({ id, provider: provider(id) })),
            default: OPUS,
            defaultsByDifficulty: PLATFORM_LEVELS,
            reviewAgentDefault: ai.reviewAgentDefault,
            designRunDefault: ai.designRunDefault,
          });
        }
        if (path === '/v1/credits/agent-run-check') {
          return json(200, {
            coreOrganizationId: body?.['coreOrganizationId'],
            balanceCredits: 250,
            hasCredits: true,
            mayRun: true,
          });
        }
        if (path === '/v1/admin/orgs/tiers') {
          if (ai.tiersDown) return problem(500, 'internal_error');
          const ids = (body?.['coreOrganizationIds'] as string[] | undefined) ?? [];
          return json(200, {
            orgs: ids.map((id) => ({ coreOrganizationId: id, tierKey: ai.tiers.get(id) ?? null })),
          });
        }
        if (path === '/v1/planner-model-settings' && method === 'GET') {
          return json(200, {
            settings: [],
            offered: PLANNING_OFFER,
            functions: Object.entries(ai.functions).map(([fn, model]) => ({
              function: fn,
              model,
              offered: model === null ? null : true,
              updatedAt: model === null ? null : '2026-11-10T00:00:00.000Z',
              updatedByCoreUserId: null,
            })),
          });
        }
        if (path === '/v1/planner-model-settings/functions' && method === 'PUT') {
          if (ai.refuseNextWrite) {
            ai.refuseNextWrite = false;
            return problem(422, 'validation_error');
          }
          const fn = String(body?.['function']);
          const previousModel = ai.functions[fn] ?? null;
          ai.functions[fn] = (body?.['model'] as string | null) ?? null;
          return json(200, {
            function: fn,
            previousModel,
            model: ai.functions[fn],
            updatedAt: '2026-11-10T01:00:00.000Z',
          });
        }
        if (path === '/v1/admin/run-model-defaults') {
          const row = (key: string) => ({
            key,
            model: ai.runDefaults[key],
            offered: ai.runDefaults[key] === null ? null : true,
            effectiveModel: ai.runDefaults[key],
            updatedAt: '2026-11-10T00:00:00.000Z',
            updatedByCoreUserId: null,
          });
          if (method === 'GET') {
            return json(200, {
              settings: Object.keys(ai.runDefaults).map(row),
              models: ai.offered.map((id) => ({ id, provider: provider(id) })),
            });
          }
          if (ai.refuseNextWrite) {
            ai.refuseNextWrite = false;
            return problem(422, 'validation_error');
          }
          const key = String(body?.['key']);
          const before = ai.runDefaults[key] ?? null;
          const after = (body?.['model'] as string | null) ?? null;
          ai.runDefaults[key] = after;
          if (key === 'review') ai.reviewAgentDefault = after;
          if (key === 'design') ai.designRunDefault = after;
          return json(200, {
            setting: row(key),
            audit:
              before === after
                ? null
                : {
                    action: 'ai.run_model_default.set',
                    actorCoreUserId: body?.['actorCoreUserId'],
                    at: '2026-11-10T01:00:00.000Z',
                    key,
                    before: { model: before },
                    after: { model: after },
                  },
          });
        }
        const overrides = /^\/v1\/orgs\/([^/]+)\/planner-model-overrides$/.exec(path);
        if (overrides) {
          const orgId = decodeURIComponent(overrides[1]!);
          const state = ai.planner.get(orgId) ?? { qualifies: false, guide: null };
          if (method === 'PUT') {
            if (!state.qualifies) return problem(403, 'permission_denied');
            const previousModel = state.guide;
            if (body?.['function'] === 'guide') state.guide = (body['model'] as string) ?? null;
            ai.planner.set(orgId, state);
            return json(200, {
              function: body?.['function'],
              previousModel,
              model: body?.['model'] ?? null,
              updatedAt: '2026-11-10T01:00:00.000Z',
            });
          }
          const fns = ['planning', 'guide', 'debug', 'ask'] as const;
          return json(200, {
            known: true,
            qualifies: state.qualifies,
            overrides: fns.map((fn) => {
              const model = fn === 'guide' ? state.guide : null;
              return {
                function: fn,
                model,
                offered: model === null ? null : true,
                applies: model !== null && state.qualifies,
                updatedAt: model ? '2026-11-10T00:00:00.000Z' : null,
                updatedByCoreUserId: null,
              };
            }),
            effective: fns.map((fn) => ({
              function: fn,
              model: fn === 'guide' && state.guide && state.qualifies ? state.guide : OPUS,
              source: fn === 'guide' && state.guide && state.qualifies ? 'org' : 'audience',
            })),
            offered: PLANNING_OFFER,
          });
        }
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run',
          runRef: body?.['runRef'],
          expiresAt: body?.['expiresAt'],
        });
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
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        return json(201, {
          token: 'ghs-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') return json(200, { slug: 'motir-studio' });
      if (url.includes('/users/') && method === 'GET') return json(200, { id: 99 });
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

/** Calls the stub recorded to motir-ai, other than reads. */
const aiWrites = () => calls.filter((c) => isAi(c.url) && c.method !== 'GET');

// ── the harness: a project with a repository, and the doors as a browser calls them ──

let fx: WorkItemFixture;
let repoId: string;

function signInAs(user: { id: string; email?: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email ?? `${user.id}@example.com` } },
  });
}

async function enterFixture(next: WorkItemFixture): Promise<void> {
  fx = next;
  ctxRef.current = fx.ctx;
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  signInAs(fx.owner);
  repoId = await seedRepo();
}

const orgId = () => fx.workspace.organizationId;

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
      repoId: `10848-${fx.workspaceId}`,
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

type Difficulty = 'trivial' | 'low' | 'medium' | 'high';

/** A card in the fixture's project, its difficulty and type set, pinned to the repo. */
async function card(
  input: { difficulty?: Difficulty; type?: 'design' | 'code'; parentId?: string } = {},
): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: input.parentId ? 'task' : 'task',
      title: `card ${Math.random().toString(36).slice(2, 8)}`,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      ...(input.difficulty ? { difficulty: input.difficulty } : {}),
      ...(input.type ? { type: input.type } : {}),
    },
  });
  await adminDb.workItemRepo.create({
    data: { workspaceId: fx.workspaceId, workItemId: item.id, projectRepoId: repoId, position: 0 },
  });
  return { id: item.id, identifier: item.identifier };
}

async function story(): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'a story' },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

interface Resolved {
  model: string;
  source: string;
  difficulty: string | null;
  fromLeaves: boolean;
  design: boolean;
}

async function preselect(key: string): Promise<Resolved | null> {
  const res = await modelsRoute.GET(
    new Request(`https://app.test/api/hosted-runs/models?workItem=${encodeURIComponent(key)}`),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { resolved: Resolved | null }).resolved;
}

let idem = 0;

/** Run hosted (optionally with the person's pick) and answer what the START opened. */
async function start(key: string, model?: string): Promise<{ run: string; event: string }> {
  const res = await startRoute.POST(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `gate-10848-${++idem}`, ...(model ? { model } : {}) }),
    }),
    { params: Promise.resolve({ id: key }) },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const { dispatchRunId } = (await res.json()) as { dispatchRunId: string };
  return opened(dispatchRunId);
}

/** The run row's model and its `run_opened` event's model, which must agree. */
async function opened(dispatchRunId: string): Promise<{ run: string; event: string }> {
  const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
  expect(run.origin).toBe('hosted');
  const event = await adminDb.dispatchRunEvent.findFirstOrThrow({
    where: { dispatchRunId, kind: 'run_opened' },
  });
  return { run: run.model!, event: String((event.data as { model?: unknown }).model) };
}

const both = (model: string) => ({ run: model, event: model });

// The org routes.
const orgParams = (id: string) => ({ params: Promise.resolve({ orgId: id }) });
const orgUrl = (id: string, side: 'runs' | 'planning') =>
  `https://app.test/api/organizations/${id}/ai-models/${side}`;

async function getOrg(side: 'runs' | 'planning', id = orgId()) {
  const route = side === 'runs' ? orgRunsRoute : orgPlanningRoute;
  const res = await route.GET(new Request(orgUrl(id, side)), orgParams(id));
  return { status: res.status, text: await res.text() };
}

async function patchOrg(side: 'runs' | 'planning', body: Record<string, unknown>, id = orgId()) {
  const route = side === 'runs' ? orgRunsRoute : orgPlanningRoute;
  const res = await route.PATCH(
    new Request(orgUrl(id, side), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    orgParams(id),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const runRow = (dto: OrgRunModelsDTO, key: string) =>
  dto.state === 'ready' ? dto.rows.find((r) => r.key === key) : undefined;

async function patchProject(body: Record<string, string | null>): Promise<void> {
  const res = await settingsRoute.PATCH(
    new Request(`https://app.test/api/projects/${fx.projectIdentifier}/hosted-agent-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key: fx.projectIdentifier }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

const orgColumns = (id = orgId()) =>
  adminDb.organization.findUniqueOrThrow({
    where: { id },
    select: {
      hostedModelTrivial: true,
      hostedModelLow: true,
      hostedModelMedium: true,
      hostedModelHigh: true,
      hostedReviewModel: true,
      hostedDesignModel: true,
    },
  });

async function addMember(id: string, role: 'admin' | 'member') {
  const user = await createTestUser();
  await adminDb.organizationMembership.create({
    data: { organizationId: id, userId: user.id, role },
  });
  return user;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

const truncateConsoleTables = () =>
  adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list", "platform_audit_log" RESTART IDENTITY CASCADE',
  );

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateConsoleTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  sent.length = 0;
  currentPrincipal = null;
  Object.assign(ai, {
    offered: [...ALL],
    reviewAgentDefault: null,
    designRunDefault: null,
    tiers: new Map(),
    tiersDown: false,
    down: false,
    planner: new Map(),
    functions: { guide: null, debug: null, ask: null },
    runDefaults: {
      trivial: HAIKU,
      low: SONNET,
      medium: OPUS,
      high: OPUS,
      review: null,
      design: null,
    },
    refuseNextWrite: false,
  });
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
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await truncateConsoleTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── 1. run-side precedence, end to end, on what the start opened ───────────────

describe('an org run-side choice is what the next run uses, in precedence order', () => {
  beforeEach(async () => {
    await enterFixture(await makeWorkItemFixture());
    ai.tiers.set(orgId(), 'pro');
  });

  it('no overrides → the platform level, exactly as before the story', async () => {
    const leaf = await card({ difficulty: 'high' });
    expect(await preselect(leaf.identifier)).toMatchObject({
      model: OPUS,
      source: 'platform_level',
      design: false,
    });
    expect(await start(leaf.identifier)).toEqual(both(OPUS));
  });

  it('org high → org; project override → project; the person’s pick → the pick', async () => {
    // The org owner chooses O for High through the route.
    const saved = await patchOrg('runs', { key: 'high', model: O });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ key: 'high', model: O });
    const leaf = await card({ difficulty: 'high' });
    expect(await preselect(leaf.identifier)).toMatchObject({ model: O, source: 'org_level' });
    expect(await start(leaf.identifier)).toEqual(both(O));
    const read = JSON.parse((await getOrg('runs')).text) as OrgRunModelsDTO;
    expect(runRow(read, 'high')).toMatchObject({ model: O, withdrawn: false, effectiveModel: O });

    // The project's own difficulty override still wins over the org's.
    await patchProject({ high: P });
    const leaf2 = await card({ difficulty: 'high' });
    expect(await preselect(leaf2.identifier)).toMatchObject({ model: P, source: 'override' });
    expect(await start(leaf2.identifier)).toEqual(both(P));

    // The person's own pick wins over every stored layer.
    const leaf3 = await card({ difficulty: 'high' });
    expect(await start(leaf3.identifier, X)).toEqual(both(X));
  });

  it('a design leaf takes the org design model, then the platform’s; a parent only when every leaf is design', async () => {
    await patchProject({ high: P }); // the design leaf's level has a project override
    expect((await patchOrg('runs', { key: 'design', model: D })).status).toBe(200);
    const design = await card({ difficulty: 'high', type: 'design' });
    expect(await preselect(design.identifier)).toMatchObject({
      model: D,
      source: 'org_design',
      design: true,
    });
    expect(await start(design.identifier)).toEqual(both(D));

    // Cleared: the platform design-run default applies.
    expect((await patchOrg('runs', { key: 'design', model: null })).status).toBe(200);
    ai.designRunDefault = D2;
    const design2 = await card({ difficulty: 'high', type: 'design' });
    expect(await preselect(design2.identifier)).toMatchObject({
      model: D2,
      source: 'platform_design',
    });
    expect(await start(design2.identifier)).toEqual(both(D2));

    // A parent whose unfinished leaves are all design cards runs on it too.
    const allDesign = await story();
    await card({ difficulty: 'low', type: 'design', parentId: allDesign.id });
    await card({ difficulty: 'high', type: 'design', parentId: allDesign.id });
    expect(await preselect(allDesign.identifier)).toMatchObject({
      model: D2,
      source: 'platform_design',
      fromLeaves: true,
      design: true,
    });
    expect(await start(allDesign.identifier)).toEqual(both(D2));

    // One non-design leaf: the difficulty rule, the project override first.
    const mixed = await story();
    await card({ difficulty: 'high', type: 'design', parentId: mixed.id });
    await card({ difficulty: 'high', type: 'code', parentId: mixed.id });
    expect(await preselect(mixed.identifier)).toMatchObject({
      model: P,
      source: 'override',
      design: false,
    });
    expect(await start(mixed.identifier)).toEqual(both(P));
  });

  it('below Pro the stored columns are ignored, kept, and named nowhere; back on Pro they apply', async () => {
    expect((await patchOrg('runs', { key: 'high', model: O })).status).toBe(200);
    expect((await patchOrg('runs', { key: 'review', model: R })).status).toBe(200);
    const stored = await orgColumns();

    ai.tiers.set(orgId(), 'standard');
    const leaf = await card({ difficulty: 'high' });
    expect(await preselect(leaf.identifier)).toMatchObject({
      model: OPUS,
      source: 'platform_level',
    });
    expect(await start(leaf.identifier)).toEqual(both(OPUS));
    const locked = await getOrg('runs');
    expect(JSON.parse(locked.text)).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    for (const id of ALL) expect(locked.text).not.toContain(id);
    expect(await orgColumns()).toEqual(stored);

    // Back on Pro with no PATCH: the stored choice applies again.
    ai.tiers.set(orgId(), 'pro');
    const leaf2 = await card({ difficulty: 'high' });
    expect(await start(leaf2.identifier)).toEqual(both(O));
  });

  it('an unreadable tier never refuses a run: it starts on the platform level', async () => {
    expect((await patchOrg('runs', { key: 'high', model: O })).status).toBe(200);
    ai.tiersDown = true;
    const leaf = await card({ difficulty: 'high' });
    expect(await start(leaf.identifier)).toEqual(both(OPUS));
  });

  it('a stored choice no longer offered is skipped, the run starts on the next layer, the GET flags it', async () => {
    expect((await patchOrg('runs', { key: 'high', model: O })).status).toBe(200);
    ai.offered = ALL.filter((id) => id !== O);
    const leaf = await card({ difficulty: 'high' });
    expect(await preselect(leaf.identifier)).toMatchObject({
      model: OPUS,
      source: 'platform_level',
    });
    expect(await start(leaf.identifier)).toEqual(both(OPUS));
    const read = JSON.parse((await getOrg('runs')).text) as OrgRunModelsDTO;
    expect(runRow(read, 'high')).toMatchObject({
      model: O,
      withdrawn: true,
      effectiveModel: OPUS,
      effectiveSource: 'platform_level',
    });
  });
});

describe('qualification of the org layer: the meta org on any tier, the rest only Pro and above', () => {
  it('a meta org on Free chooses and runs on it; a non-meta Free or no-tier org is refused and writes nothing', async () => {
    const meta = await makeWorkItemFixture();
    await adminDb.organization.update({
      where: { id: meta.workspace.organizationId },
      data: { isMeta: true },
    });
    await enterFixture(meta);
    ai.tiers.set(orgId(), 'free');
    expect((await patchOrg('runs', { key: 'high', model: O })).status).toBe(200);
    const leaf = await card({ difficulty: 'high' });
    expect(await start(leaf.identifier)).toEqual(both(O));

    for (const tier of ['free', undefined] as const) {
      const other = await makeWorkItemFixture();
      await enterFixture(other);
      if (tier) ai.tiers.set(orgId(), tier);
      const before = await orgColumns();
      const refused = await patchOrg('runs', { key: 'high', model: O });
      expect(refused.status).toBe(403);
      expect(refused.body['code']).toBe('ORG_MODEL_CHOICE_NOT_QUALIFIED');
      expect(await orgColumns()).toEqual(before);
    }
  });
});

// ── 2. the hosted review start ─────────────────────────────────────────────────

const INSTALLATION_ID = 'inst-10848-review';
const REPO_PROVIDER_ID = '108480';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

/** A card delivered by a green pull request, holding its review request. */
async function reviewing(slug: string) {
  const user = await usersService.createUser({
    email: `owner-10848-${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', reviewAgentEnabled: true },
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, repoId: REPO_PROVIDER_ID },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: 'acme',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a0',
      githubRepoId: mirror.id,
    },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A reviewed card' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  const number = 7;
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  const pr = {
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
  await githubWebhookService.handleEvent('pull_request', { action: 'opened', ...pr });
  await githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: 'sha-a',
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });
  const request = sent
    .filter((e) => e.name === 'agent-review/requested')
    .map((e) => e.data as unknown as AgentReviewRequestedData)[0];
  expect(request, 'the green verdict requested its review').toBeDefined();
  signInAs(user);
  return { organizationId: workspace.organizationId, workspaceId: workspace.id, request: request! };
}

async function reviewRun(workspaceId: string): Promise<{ run: string; event: string }> {
  const [row] = await adminDb.dispatchRun.findMany({ where: { workspaceId, command: 'review' } });
  expect(row, 'the review opened a run').toBeDefined();
  return opened(row!.id);
}

describe('a hosted review runs on the review-agent model: org, then platform, then the run default', () => {
  it('the org’s review-agent choice, written through the org route', async () => {
    const s = await reviewing('org');
    ai.tiers.set(s.organizationId, 'pro');
    ai.reviewAgentDefault = R2;
    expect((await patchOrg('runs', { key: 'review', model: R }, s.organizationId)).status).toBe(
      200,
    );
    await agentReviewStartService.startRequested(s.request);
    expect(await reviewRun(s.workspaceId)).toEqual(both(R));
  });

  it('with the org’s cleared, the platform review-agent default', async () => {
    const s = await reviewing('platform');
    ai.tiers.set(s.organizationId, 'pro');
    expect((await patchOrg('runs', { key: 'review', model: R }, s.organizationId)).status).toBe(
      200,
    );
    expect((await patchOrg('runs', { key: 'review', model: null }, s.organizationId)).status).toBe(
      200,
    );
    ai.reviewAgentDefault = R2;
    await agentReviewStartService.startRequested(s.request);
    expect(await reviewRun(s.workspaceId)).toEqual(both(R2));
  });

  it('with both unset, the offered list’s default, as today', async () => {
    const s = await reviewing('default');
    ai.tiers.set(s.organizationId, 'pro');
    await agentReviewStartService.startRequested(s.request);
    expect(await reviewRun(s.workspaceId)).toEqual(both(OPUS));
  });
});

// ── 3. the org routes' gates, lock and unreadable answers ──────────────────────

describe('the org routes: who may read and write, what a lock and an outage answer', () => {
  beforeEach(async () => {
    await enterFixture(await makeWorkItemFixture());
    ai.tiers.set(orgId(), 'pro');
    ai.planner.set(orgId(), { qualifies: true, guide: null });
  });

  it('a plain member reads read-only and is refused writes with nothing reaching motir-ai; a non-member gets 404', async () => {
    const member = await addMember(orgId(), 'member');
    signInAs(member);
    for (const side of ['runs', 'planning'] as const) {
      const read = await getOrg(side);
      expect(read.status).toBe(200);
      expect(JSON.parse(read.text)).toMatchObject({ state: 'ready', canEdit: false });
      calls = [];
      const body =
        side === 'runs' ? { key: 'high', model: O } : { function: 'guide', model: GUIDE };
      const refused = await patchOrg(side, body);
      expect(refused.status).toBe(403);
      expect(aiWrites()).toEqual([]);
    }
    expect((await orgColumns()).hostedModelHigh).toBeNull();

    const outsider = await createTestUser();
    signInAs(outsider);
    for (const side of ['runs', 'planning'] as const) {
      expect((await getOrg(side)).status).toBe(404);
    }
  });

  it('planning side: a non-qualifying org reads locked with no model id; a qualifying one reads and writes', async () => {
    const other = await makeWorkItemFixture();
    const lockedOrg = other.workspace.organizationId;
    ai.planner.set(lockedOrg, { qualifies: false, guide: GUIDE });

    signInAs(other.owner);
    const locked = await getOrg('planning', lockedOrg);
    expect(locked.status).toBe(200);
    expect(JSON.parse(locked.text)).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    for (const id of [GUIDE, ...PLANNING_OFFER.map((m) => m.id), OPUS]) {
      expect(locked.text).not.toContain(id);
    }
    const refused = await patchOrg('planning', { function: 'guide', model: GUIDE }, lockedOrg);
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('ORG_MODEL_CHOICE_NOT_QUALIFIED');

    signInAs(fx.owner);
    const ready = JSON.parse((await getOrg('planning')).text) as OrgPlannerModelsDTO;
    expect(ready).toMatchObject({ state: 'ready', canEdit: true });
    expect(ready.state === 'ready' && ready.rows.map((r) => r.function)).toEqual([
      'planning',
      'guide',
      'debug',
      'ask',
    ]);
    calls = [];
    const saved = await patchOrg('planning', { function: 'guide', model: GUIDE });
    expect(saved.status).toBe(200);
    expect(aiWrites()).toEqual([
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          function: 'guide',
          model: GUIDE,
          actorCoreUserId: fx.owner.id,
        }),
      }),
    ]);
  });

  it('motir-ai down: both GETs unreadable with no model ids, both PATCHes 503, both console actions UNAVAILABLE, no audit row', async () => {
    expect((await patchOrg('runs', { key: 'high', model: O })).status).toBe(200);
    currentPrincipal = await seedStaff('superadmin');
    ai.down = true;
    for (const side of ['runs', 'planning'] as const) {
      const read = await getOrg(side);
      expect(read.status).toBe(200);
      expect(JSON.parse(read.text)).toEqual({ state: 'unreadable', canEdit: false });
      for (const id of ALL) expect(read.text).not.toContain(id);
    }
    const runs = await patchOrg('runs', { key: 'low', model: O });
    const planning = await patchOrg('planning', { function: 'guide', model: GUIDE });
    for (const res of [runs, planning]) {
      expect(res.status).toBe(503);
      expect(res.body['code']).toBe('MODELS_UNREADABLE');
    }
    expect(await setPlannerFunctionModelAction('debug', GUIDE, 'a reason')).toMatchObject({
      ok: false,
      code: 'UNAVAILABLE',
    });
    expect(await setRunModelDefaultAction('review', R2, 'a reason')).toMatchObject({
      ok: false,
      code: 'UNAVAILABLE',
    });
    expect(await writeAudits()).toBe(0);
  });
});

// ── 4. the console's per-function platform defaults ────────────────────────────

const WRITE_ACTIONS = ['ai.planner_function_model.set', 'ai.run_model_default.set'];
/** Audit rows the console's WRITES left (its reads and the list seed log rows of their own). */
const writeAudits = () =>
  adminDb.platformAuditLog.count({ where: { action: { in: WRITE_ACTIONS } } });

let staffSeq = 0;
async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+10848-${role}-${staffSeq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } as const;
}

describe('the console: superadmin-only writes, audited from → to', () => {
  it('operator and support are refused with no write and no audit row', async () => {
    for (const role of ['operator', 'support'] as const) {
      currentPrincipal = await seedStaff(role);
      calls = [];
      expect(await setPlannerFunctionModelAction('debug', GUIDE, 'a reason')).toMatchObject({
        ok: false,
        code: 'NOT_PERMITTED',
      });
      expect(await setRunModelDefaultAction('review', R2, 'a reason')).toMatchObject({
        ok: false,
        code: 'NOT_PERMITTED',
      });
      expect(aiWrites()).toEqual([]);
    }
    expect(await writeAudits()).toBe(0);
  });

  it('a superadmin’s writes land one row each; a no-op adds none; allowedModels is the run-model list', async () => {
    currentPrincipal = await seedStaff('superadmin');
    // The run-model list, initialised the way the console's first read does.
    await platformRunModelService.listModels(currentPrincipal);
    const listed = (await adminDb.platformRunModel.findMany()).map((r) => r.model).sort();

    expect(await setPlannerFunctionModelAction('debug', GUIDE, 'debug on the guide model')).toEqual(
      {
        ok: true,
      },
    );
    calls = [];
    expect(await setRunModelDefaultAction('review', R2, 'reviews on R2')).toEqual({ ok: true });
    const put = aiWrites().find((c) => c.url.endsWith('/v1/admin/run-model-defaults'));
    expect((put!.body!['allowedModels'] as string[]).sort()).toEqual(listed);
    expect(put!.body!['actorCoreUserId']).toBe(currentPrincipal.userId);

    // The same value again: motir-ai answers `audit: null`, and no row is added.
    expect(await setRunModelDefaultAction('review', R2, 'again')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });

    // The console's own reads and the list seed log rows of their own; the writes are these.
    const rows = await adminDb.platformAuditLog.findMany({
      where: { action: { in: WRITE_ACTIONS } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => [r.action, r.targetId, r.metadata])).toEqual([
      [
        'ai.planner_function_model.set',
        'debug',
        expect.objectContaining({ fromModel: null, toModel: GUIDE }),
      ],
      [
        'ai.run_model_default.set',
        'review',
        expect.objectContaining({ key: 'review', fromModel: null, toModel: R2 }),
      ],
    ]);

    // The platform review default the console set is what the next review offer carries.
    expect(ai.reviewAgentDefault).toBe(R2);
  });

  it('a write motir-ai refuses returns not offered and leaves no audit row', async () => {
    currentPrincipal = await seedStaff('superadmin');
    ai.refuseNextWrite = true;
    expect(await setPlannerFunctionModelAction('debug', GUIDE, 'a reason')).toMatchObject({
      ok: false,
      code: 'NOT_OFFERED',
    });
    ai.refuseNextWrite = true;
    expect(await setRunModelDefaultAction('review', R2, 'a reason')).toMatchObject({
      ok: false,
      code: 'NOT_OFFERED',
    });
    expect(await writeAudits()).toBe(0);
  });
});
