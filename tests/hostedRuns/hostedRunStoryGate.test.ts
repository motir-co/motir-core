import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunGitCredentialsSchema, dispatchRunSchema } from '@/lib/api/v1/workLoop/schema';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { inMemorySupervisionStore, type SupervisionStore } from '@/lib/jobs/supervision/driver';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import type { HostedRunSuperviseData } from '@/lib/jobs/types';
import {
  HostedModelNotOfferedError,
  HostedRunBootFailedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import { HOSTED_RUN_STALL_WINDOW_MS } from '@/lib/hostedRuns/limits';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import {
  HOSTED_AGENT_MAX_TIMEOUT_MS,
  hostedAgentBootStepId,
} from '@/lib/services/hostedAgentContainerService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { bearer } from '../fixtures/apiV1Fixtures';
import {
  createTestLink,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { warmPool } from '../helpers/warmPool';

// MOTIR-692 — THE STORY 9.1 TEST GATE ("a card runs on the hosted agent").
//
// This is the story's OWN gate, not another per-card suite: `tests/hostedRuns/`,
// `tests/api/v1/dispatch-run-git-credential-route.test.ts`,
// `tests/api/v1/run-credential-legs.test.ts` and
// `tests/github/runGitCredential.test.ts` already cover each unit's cases in
// isolation, and this file does not repeat them. What only a STORY-level suite
// can prove is that they compose: the start path, the CLI's own HTTP calls
// (using the run's own credential, never a direct service call), the durable
// supervisor and the end path meeting in one real database, across every SHAPE
// a run takes (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md`) and every
// way a run ends (`docs/decisions/hosted-agent-run.md` §2).
//
// ⚠️ THE CLI'S SIDE IS PLAYED OVER HTTP, WITH THE RUN'S OWN CREDENTIAL — read
// straight off the fake orchestrator's boot spec, exactly as the real container
// receives it (`MOTIR_RUN_TOKEN`) — never a direct service call. That is the one
// thing the per-unit suites do not exercise end to end.
//
// ⚠️ THE NO-LEAK GUARD IS THE HARD PART (the card's own difficulty note): it
// asserts ABSENCE — no live key, no live credential, no live git token, no live
// machine — across seven ways a run can end. The git-token line is proven
// load-bearing with an actual negative control, not by argument alone.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const BASE = 'http://localhost:3000/api/v1';
const MINUTE = 60_000;
const STUDIO_APP_ID = '111';
const INTEGRATION_APP_ID = '222';
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 1, bootDeadlineMs: 600 * MINUTE } as const;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

// ── The HTTP seam every external system is stubbed at — ONE whitelist ───────
//
// It throws on any URL/method it does not recognise, so a regression that read
// a PERSONAL GitHub token (anything other than an App JWT against
// `/repos/.../installation`, `/app/installations/.../access_tokens`, `/app`,
// `/users/{login}` or `DELETE /installation/token`) fails the whole round trip
// immediately rather than passing silently. That doubles as the "no personal
// GitHub token was read" guard: there is no separate runtime assertion for it
// because the stub itself is the assertion, backed by the `getLiveToken` spy
// below for a second, independent proof.

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** The App a JWT was signed for, read from its `iss` claim. */
function appIdOf(authorization: string | null): string {
  const jwt = (authorization ?? '').replace(/^Bearer /, '');
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
    iss?: string;
  };
  return String(payload.iss);
}

/** `owner` → the App installation id GitHub answers for it. Two DISTINCT ids so
 *  a run spanning `motir-projects` and `acme` mints through TWO installations;
 *  two `acme` repositories share ONE. */
function installationIdFor(owner: string): number {
  if (owner === 'motir-projects') return 7;
  if (owner === 'acme') return 42;
  return 99;
}

let calls: Call[] = [];
let mints: { installation: string; app: string; body: Record<string, unknown> }[] = [];
let revokedKeys: string[] = [];
let revokedGitTokens: string[] = [];
let machineChargeCalls = 0;
let failGatewayRevoke = false;
let tokenSeq = 0;
/** `owner/name` → an installation status override (default 200/ok). */
let installationStatus: Record<string, number> = {};
/** `POST /v1/credits/agent-run-check`'s status override (default 200/ok). */
let creditCheckStatus = 200;
/** `agent-run-check`'s `mayRun` (default true) — false is an out-of-credits org. */
let creditMayRun = true;

function stubHttp(): void {
  calls = [];
  mints = [];
  revokedKeys = [];
  revokedGitTokens = [];
  machineChargeCalls = 0;
  failGatewayRevoke = false;
  tokenSeq = 0;
  installationStatus = {};
  creditCheckStatus = 200;
  creditMayRun = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const headers = new Headers(init?.headers);
      calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      // ── motir-ai ──────────────────────────────────────────────────────────
      if (url === `${AI}/v1/agent-models`) {
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (creditCheckStatus !== 200) return json(creditCheckStatus, { code: 'internal_error' });
        return creditMayRun
          ? json(200, { balanceCredits: 250, hasCredits: true, mayRun: true })
          : json(200, { balanceCredits: 0, hasCredits: false, mayRun: false });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        machineChargeCalls += 1;
        return json(200, {
          balanceAfter: 90,
          credits: 1,
          billableSeconds: 1,
          exhausted: false,
          idempotent: false,
        });
      }

      // ── the gateway's run key ─────────────────────────────────────────────
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.['runRef'],
          expiresAt: body?.['expiresAt'],
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        if (failGatewayRevoke) return json(503, { error: 'gateway down' });
        const ref = decodeURIComponent(url.split('/').pop() ?? '');
        const already = revokedKeys.includes(ref);
        revokedKeys.push(ref);
        return json(200, { runRef: ref, revoked: already ? 0 : 1 });
      }

      // ── GitHub — App auth only; no personal-token endpoint exists here ────
      const inst = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const owner = inst[1] ?? '';
        const repo = `${owner}/${inst[2] ?? ''}`;
        const status = installationStatus[repo] ?? 200;
        if (status !== 200) return json(status, {});
        return json(200, {
          id: installationIdFor(owner),
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/${installationIdFor(owner)}`,
        });
      }
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (mint && method === 'POST') {
        tokenSeq += 1;
        mints.push({
          installation: mint[1] ?? '',
          app: appIdOf(headers.get('authorization')),
          body: body ?? {},
        });
        return json(201, {
          token: `ghs_run_${tokenSeq}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url === 'https://api.github.com/installation/token' && method === 'DELETE') {
        revokedGitTokens.push((headers.get('authorization') ?? '').replace(/^(token|Bearer) /, ''));
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/app') && method === 'GET') {
        const app = appIdOf(headers.get('authorization'));
        return json(200, { slug: app === STUDIO_APP_ID ? 'motir-studio' : 'motir-integration' });
      }
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') {
        const login = decodeURIComponent(user[1] ?? '');
        return json(200, { id: login === 'motir-studio[bot]' ? 1001 : 2002, login });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');

// ── Fixtures ──────────────────────────────────────────────────────────────

let fx: WorkItemFixture;
let repoSeq = 0;

interface SeededRepo {
  projectRepoId: string;
  owner: string;
  name: string;
}

/** A project repository with a realized GitHub repository behind it. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<SeededRepo> {
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
      repoId: String(900_000 + repoSeq),
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
  return { projectRepoId: row.id, owner: opts.owner, name: opts.name };
}

function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}

async function pinRepos(workItemId: string, repoIds: string[]): Promise<void> {
  for (const [position, projectRepoId] of repoIds.entries()) {
    await adminDb.workItemRepo.create({
      data: { workspaceId: fx.workspaceId, workItemId, projectRepoId, position },
    });
  }
}

let seq = 0;
const start = (key: string, model = MODEL) =>
  hostedRunService.start({ workItemKey: key, model, idempotencyKey: `idem-${++seq}` }, fx.ctx);

/** The session data the start path handed the durable supervisor. Valid
 *  because each test truncates job runs in `beforeEach` and starts exactly one
 *  run before reading it back — the same precondition
 *  `tests/hostedRuns/hostedRunEnd.test.ts` relies on. */
async function supervisionDataOf(): Promise<HostedRunSuperviseData> {
  const event = await adminDb.jobEvent.findFirstOrThrow({
    where: { name: 'hosted-run/supervise' },
  });
  return event.data as unknown as HostedRunSuperviseData;
}

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

// ── The CLI's own side, played over HTTP with the run's OWN credential ──────

function jsonReq(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The run token the container was booted with — read off the fake
 *  orchestrator's boot spec, exactly as the real container receives it: never
 *  from a service call, so nothing here holds a second reference to it. */
function runTokenOf(spec: { env: Record<string, string> }): string {
  const token = spec.env['MOTIR_RUN_TOKEN'];
  if (!token) throw new Error('the boot spec carried no MOTIR_RUN_TOKEN');
  return token;
}

interface LegPlan {
  key: string;
  sessionBranch: string;
  repos: { owner: string; name: string; prNumber: number }[];
}

/**
 * Play the CLI's side of a hosted run over `/api/v1`, with the run's own
 * credential — exactly the sequence
 * `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §3 describes: ADOPT
 * the server-opened run, fetch a git credential (the credential helper's first
 * call), report progress, integrate and link a pull request per repository for
 * every leg, then CLOSE the run itself as `succeeded`.
 */
async function driveCliToSuccess(
  dispatchRunId: string,
  runToken: string,
  legs: readonly LegPlan[],
): Promise<{ gitCredentials: { repository: string; token: string }[] }> {
  const headers = bearer(runToken);

  const { GET: getRun } = await import('@/app/api/v1/dispatch-runs/[id]/route');
  const adopted = await getRun(jsonReq('GET', `${BASE}/dispatch-runs/${dispatchRunId}`, headers), {
    params: Promise.resolve({ id: dispatchRunId }),
  });
  expect(adopted.status, 'adopt').toBe(200);
  const runDto = dispatchRunSchema.parse(await adopted.json());
  expect(runDto.cards.map((c) => c.key)).toEqual(legs.map((l) => l.key));

  const { POST: postGitCred } =
    await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
  const gitRes = await postGitCred(
    jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/git-credential`, headers),
    { params: Promise.resolve({ id: dispatchRunId }) },
  );
  expect(gitRes.status, 'git-credential').toBe(200);
  const gitBody = dispatchRunGitCredentialsSchema.parse(await gitRes.json());

  const { POST: postEvents } = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
  const events = (batch: Record<string, unknown>[]) =>
    postEvents(
      jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/events`, headers, { events: batch }),
      { params: Promise.resolve({ id: dispatchRunId }) },
    );
  expect((await events([{ kind: 'checkout_ready' }, { kind: 'agent_started' }])).status).toBe(200);

  const { POST: postIntegration } = await import('@/app/api/v1/work-items/[key]/integration/route');
  const { POST: postPr } = await import('@/app/api/v1/work-items/[key]/pull-requests/route');
  for (const leg of legs) {
    const integ = await postIntegration(
      jsonReq('POST', `${BASE}/work-items/${leg.key}/integration`, headers, {
        sessionBranch: leg.sessionBranch,
      }),
      { params: Promise.resolve({ key: leg.key }) },
    );
    expect(integ.status, `integration ${leg.key}`).toBe(200);
    for (const repo of leg.repos) {
      const pr = await postPr(
        jsonReq('POST', `${BASE}/work-items/${leg.key}/pull-requests`, headers, {
          repository: `${repo.owner}/${repo.name}`,
          number: repo.prNumber,
          headRef: leg.sessionBranch,
          baseRef: 'main',
        }),
        { params: Promise.resolve({ key: leg.key }) },
      );
      expect(pr.status, `pull-request link ${leg.key} ${repo.owner}/${repo.name}`).toBe(200);
      await events([
        {
          kind: 'delivery_linked',
          workItemKey: leg.key,
          data: { repository: `${repo.owner}/${repo.name}` },
        },
      ]);
    }
  }

  expect((await events([{ kind: 'agent_exited', exitCode: 0 }])).status).toBe(200);

  const { POST: postClose } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
  const closed = await postClose(
    jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/close`, headers, {
      stopReason: 'completed',
      status: 'succeeded',
    }),
    { params: Promise.resolve({ id: dispatchRunId }) },
  );
  expect(closed.status, 'close').toBe(200);

  return { gitCredentials: gitBody.credentials };
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  resetRateLimitStore();
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  repoSeq = 0;
  seq = 0;
  fx = await makeWorkItemFixture();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', STUDIO_APP_ID);
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', INTEGRATION_APP_ID);
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stubHttp();
});

let getLiveTokenSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // No personal GitHub token is ever read on a hosted run's git path — asserted
  // directly, beside the stub's own whitelist above.
  getLiveTokenSpy = vi.spyOn(githubIdentityService, 'getLiveToken');
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

// ═════════════════════════════════════════════════════════════════════════
// 1 · THE ROUND TRIP — three run shapes
// ═════════════════════════════════════════════════════════════════════════

describe('the round trip — start, the CLI’s own ingest, end — over three run shapes', () => {
  it('a one-repository leaf', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a hosted leaf' });
    await pinRepos(card.id, [repo.projectRepoId]);

    const started = await start(card.identifier);
    const spec = fakeOrchestrator.specs.at(-1)!;
    const runToken = runTokenOf(spec);
    const legs: LegPlan[] = [
      {
        key: card.identifier,
        sessionBranch: 'hosted/leaf-a',
        repos: [{ owner: 'motir-projects', name: 'site', prNumber: 101 }],
      },
    ];

    const { gitCredentials } = await driveCliToSuccess(started.dispatchRunId, runToken, legs);
    expect(gitCredentials.map((c) => c.repository)).toEqual(['motir-projects/site']);
    expect(mints).toHaveLength(1);

    const data = await supervisionDataOf();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    const run = await runOf(started.dispatchRunId);
    expect(run).toMatchObject({ status: 'succeeded', stopReason: 'completed' });
    const after = await cardOf(card.id);
    expect(after).toMatchObject({
      status: 'implemented',
      implementationSource: 'hosted',
      sessionBranch: 'hosted/leaf-a',
    });
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('a two-repository leaf — one App installation covers both repositories', async () => {
    const repoA = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const repoB = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const card = await newCard({ kind: 'task', title: 'a two-repo leaf' });
    await pinRepos(card.id, [repoA.projectRepoId, repoB.projectRepoId]);

    const started = await start(card.identifier);
    const spec = fakeOrchestrator.specs.at(-1)!;
    const runToken = runTokenOf(spec);
    const legs: LegPlan[] = [
      {
        key: card.identifier,
        sessionBranch: 'hosted/leaf-b',
        repos: [
          { owner: 'acme', name: 'api', prNumber: 201 },
          { owner: 'acme', name: 'web', prNumber: 202 },
        ],
      },
    ];

    const { gitCredentials } = await driveCliToSuccess(started.dispatchRunId, runToken, legs);
    expect(gitCredentials.map((c) => c.repository).sort()).toEqual(['acme/api', 'acme/web']);
    // Two repositories, ONE installation → one mint call carrying both ids.
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body['repository_ids']).toHaveLength(2);

    const data = await supervisionDataOf();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    expect(await runOf(started.dispatchRunId)).toMatchObject({ status: 'succeeded' });
    const after = await cardOf(card.id);
    expect(after).toMatchObject({ status: 'implemented', implementationSource: 'hosted' });
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(2);
  });

  it('a two-child parent across two repositories — two App installations', async () => {
    const repoA = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const repoB = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const story = await newCard({ kind: 'story', title: 'a story this run drains' });
    // `later` sits first on the board but is blocked by `earlier` — the run's
    // dependency order (`orderLegs`) puts `earlier` first.
    const later = await newCard({ kind: 'task', title: 'later', parentId: story.id });
    const earlier = await newCard({ kind: 'task', title: 'earlier', parentId: story.id });
    await pinRepos(later.id, [repoA.projectRepoId]);
    await pinRepos(earlier.id, [repoB.projectRepoId]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: later.id,
      toId: earlier.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const started = await start(story.identifier);
    const spec = fakeOrchestrator.specs.at(-1)!;
    const runToken = runTokenOf(spec);
    const legs: LegPlan[] = [
      {
        key: earlier.identifier,
        sessionBranch: 'hosted/earlier',
        repos: [{ owner: 'acme', name: 'api', prNumber: 301 }],
      },
      {
        key: later.identifier,
        sessionBranch: 'hosted/later',
        repos: [{ owner: 'motir-projects', name: 'site', prNumber: 302 }],
      },
    ];

    const { gitCredentials } = await driveCliToSuccess(started.dispatchRunId, runToken, legs);
    expect(gitCredentials.map((c) => c.repository).sort()).toEqual([
      'acme/api',
      'motir-projects/site',
    ]);
    // Two repositories, each in its OWN App's installation.
    expect(mints).toHaveLength(2);
    expect(mints.map((m) => m.app).sort()).toEqual([STUDIO_APP_ID, INTEGRATION_APP_ID].sort());

    const data = await supervisionDataOf();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });

    expect(await runOf(started.dispatchRunId)).toMatchObject({
      status: 'succeeded',
      command: 'run_scope',
    });
    for (const leg of [earlier, later]) {
      const after = await cardOf(leg.id);
      expect(after, leg.identifier).toMatchObject({
        status: 'implemented',
        implementationSource: 'hosted',
      });
      expect(await adminDb.workItemDelivery.count({ where: { workItemId: leg.id } })).toBe(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2 · THE NO-LEAK GUARD — every one of the seven ends
// ═════════════════════════════════════════════════════════════════════════

/** A one-repository, one-leg run whose CLI has fetched a REAL git credential
 *  (minted through GitHub, never pre-seeded) — the substrate every no-leak
 *  case ends from `running`. */
async function liveRunWithGitCredential(): Promise<{
  dispatchRunId: string;
  cardId: string;
  data: HostedRunSuperviseData;
  runToken: string;
}> {
  const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
  const card = await newCard({ kind: 'task', title: 'a no-leak card' });
  await pinRepos(card.id, [repo.projectRepoId]);
  const started = await start(card.identifier);
  const data = await supervisionDataOf();
  const spec = fakeOrchestrator.specs.at(-1)!;
  const runToken = runTokenOf(spec);

  const { POST: postGitCred } =
    await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
  const res = await postGitCred(
    jsonReq(
      'POST',
      `${BASE}/dispatch-runs/${started.dispatchRunId}/git-credential`,
      bearer(runToken),
    ),
    { params: Promise.resolve({ id: started.dispatchRunId }) },
  );
  expect(res.status, 'seeding a live git credential').toBe(200);

  return { dispatchRunId: started.dispatchRunId, cardId: card.id, data, runToken };
}

/**
 * Nothing the run held is alive. Each line is proven load-bearing: the test
 * named "the git-token line is load-bearing" below shows this EXACT assertion
 * failing (a token count of 1, not 0) when the revoke call is skipped — the
 * same shape a removed call in `endHostedRun` would produce. The other three
 * lines read the same three stub-recorded actors (the gateway, the run's own
 * `ApiToken` via a REAL ingest call, GitHub's git-token DELETE), so a removed
 * revoke leaves the matching call missing from that same record and each line
 * fails exactly as the negative control demonstrates for the git-token one.
 */
async function assertNoLeak(
  dispatchRunId: string,
  runToken: string,
  opts: { gitTokens: number } = { gitTokens: 1 },
): Promise<void> {
  expect(revokedKeys, 'the gateway key').toContain(dispatchRunId);
  expect(await adminDb.apiToken.count({ where: { dispatchRunId } }), 'the run credential').toBe(0);

  const { POST: postEvents } = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
  const stillAlive = await postEvents(
    jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/events`, bearer(runToken), {
      events: [{ kind: 'log', body: 'is the credential still good?\n' }],
    }),
    { params: Promise.resolve({ id: dispatchRunId }) },
  );
  expect(stillAlive.status, 'the run credential on the ingest').toBe(401);

  expect(revokedGitTokens, 'every git token').toHaveLength(opts.gitTokens);
  expect(
    await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId } }),
    'no git-credential row left recorded',
  ).toBe(0);

  expect(getLiveTokenSpy, 'no personal GitHub token was ever read').not.toHaveBeenCalled();

  expect(
    await adminDb.ciContainerUsage.count({
      where: { dispatchRunId, containerStoppedAt: { not: null } },
    }),
    'the machine settled exactly once',
  ).toBe(1);
  expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
}

describe('the no-leak guard — nothing a run held survives any of its seven ends', () => {
  it('success — the CLI closes it, the end path only tears down', async () => {
    const { dispatchRunId, data, runToken } = await liveRunWithGitCredential();
    const { POST: postClose } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
    const closed = await postClose(
      jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/close`, bearer(runToken), {
        stopReason: 'completed',
        status: 'succeeded',
      }),
      { params: Promise.resolve({ id: dispatchRunId }) },
    );
    expect(closed.status).toBe(200);

    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'succeeded' });
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
  });

  it('failure — the container exits with the run still open (a crash)', async () => {
    const { dispatchRunId, data, runToken } = await liveRunWithGitCredential();

    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 1 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'failed', stopReason: 'halted' });
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
  });

  it('cancel — revoked and closed at once, the machine settled at the next poll', async () => {
    const { dispatchRunId, data, runToken, cardId } = await liveRunWithGitCredential();
    const card = await cardOf(cardId);

    await hostedRunService.cancel(dispatchRunId, fx.ctx);
    expect(await runOf(dispatchRunId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'interrupted',
    });
    // Revoked and refused NOW — before the supervisor ever tears the machine down.
    expect(revokedKeys).toContain(dispatchRunId);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId } })).toBe(0);

    // The supervisor is the machine's ONE owner: it tears it down, settles and
    // charges it at its next poll.
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'gate_revoked' });
    expect((await cardOf(cardId)).status).toBe(card.status);
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
  });

  it('stall — no agent output inside the stall window ends the run early', async () => {
    const { dispatchRunId, data, runToken } = await liveRunWithGitCredential();
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const later = () => new Date(bootedAt + HOSTED_RUN_STALL_WINDOW_MS + MINUTE);

    expect(await superviseToEnd(data, later)).toEqual({
      outcome: 'settled',
      reason: 'job_timed_out',
    });
    expect(await runOf(dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind: 'log' },
      orderBy: { seq: 'desc' },
    });
    expect(log?.body).toContain('stalled: no agent output');
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
  });

  it('backstop — a container still producing output is stopped at the 12-hour ceiling', async () => {
    const { dispatchRunId, data, runToken } = await liveRunWithGitCredential();
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const past = new Date(bootedAt + HOSTED_AGENT_MAX_TIMEOUT_MS + MINUTE);
    // Still talking — a recent event, so it is the backstop that ends it, not a stall.
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId,
        seq: 100,
        kind: 'log',
        createdAt: new Date(past.getTime() - MINUTE),
      },
    });

    expect(await superviseToEnd(data, () => past)).toEqual({
      outcome: 'settled',
      reason: 'job_timed_out',
    });
    expect(await runOf(dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind: 'log' },
      orderBy: { seq: 'desc' },
    });
    expect(log?.body).toContain('hosted run ended (backstop)');
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
  });

  it('lost supervision — the sweep settles a chain the worker never resumed', async () => {
    const { dispatchRunId, data, runToken } = await liveRunWithGitCredential();
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
    await withSystemContext(async (tx: Prisma.TransactionClient) => {
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
    expect(await runOf(dispatchRunId)).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind: 'log' },
      orderBy: { seq: 'desc' },
    });
    expect(log?.body).toContain('hosted run ended (lost supervision)');
    await assertNoLeak(dispatchRunId, runToken);
    expect(machineChargeCalls).toBe(1);
    await truncateJobRuns();
  });

  it('a failure mid-start — the gateway key is revoked although the run never reached a container', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'fails mid-start' });
    await pinRepos(card.id, [repo.projectRepoId]);
    vi.spyOn(runCredentialService, 'mintRunCredential').mockRejectedValueOnce(
      new Error('mint down'),
    );

    await expect(start(card.identifier)).rejects.toThrow('mint down');

    const run = await adminDb.dispatchRun.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(run).toMatchObject({ status: 'failed', stopReason: 'halted' });
    // The gateway key WAS minted (it comes first) and so must be revoked, even
    // though no container ever booted and no git credential was ever fetched.
    expect(mintCalls()).toHaveLength(1);
    expect(revokedKeys).toContain(run.id);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: run.id } })).toBe(0);
    expect(await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId: run.id } })).toBe(
      0,
    );
    expect(fakeOrchestrator.provisioned).toEqual([]);
    // No container ever ran, so there is nothing for the machine meter to have
    // settled — the "settled once" question does not arise for this end.
    expect(await adminDb.ciContainerUsage.count({ where: { dispatchRunId: run.id } })).toBe(0);
    expect(machineChargeCalls).toBe(0);
    expect(getLiveTokenSpy).not.toHaveBeenCalled();
  });

  it('the git-token line is load-bearing: skipping the revoke leaves the token alive', async () => {
    // A NEGATIVE CONTROL for `assertNoLeak`'s git-token assertion: it mocks
    // AWAY the exact call `endHostedRun` makes (`revokeRunGitCredentials`,
    // imported and called directly — never through an object a `vi.spyOn` on
    // a service would reach), ends the run, and shows the token that a
    // removed revoke would leave alive. This is the shape every other case's
    // `expect(revokedGitTokens).toHaveLength(1)` /
    // `expect(… .count(...)).toBe(0)` would fail under, which is what proves
    // those two lines are load-bearing rather than vacuously true.
    const { dispatchRunId } = await liveRunWithGitCredential();
    const runGitCredentialModule = await import('@/lib/github/runGitCredential');
    vi.spyOn(runGitCredentialModule, 'revokeRunGitCredentials').mockResolvedValueOnce([]);

    await hostedRunService.endHostedRun(dispatchRunId, 'failed', 'a mid-run failure');

    expect(revokedGitTokens, 'the DELETE the real revoke would have made never happened').toEqual(
      [],
    );
    expect(
      await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId } }),
      'the row a real revoke would have deleted is still there',
    ).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3 · The run credential reaches only its own run's legs
// ═════════════════════════════════════════════════════════════════════════

describe('the run credential of a REAL hosted run reaches only its own legs', () => {
  // `tests/api/v1/run-credential-legs.test.ts` already drives every route of
  // the allow-list both ways, against a run opened directly through
  // `dispatchRunService.open`. What that suite cannot show is that the SAME
  // guarantee holds for the credential `hostedRunService.start` itself mints
  // and hands to a real container — so this drives it from there instead.
  it('a card outside its legs is refused (403); another run’s id is refused (403)', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const ownCard = await newCard({ kind: 'task', title: 'this run’s own card' });
    const otherCard = await newCard({ kind: 'task', title: 'outside this run' });
    await pinRepos(ownCard.id, [repo.projectRepoId]);
    await pinRepos(otherCard.id, [repo.projectRepoId]);

    await start(ownCard.identifier);
    const ownToken = runTokenOf(fakeOrchestrator.specs.at(-1)!);
    const other = await start(otherCard.identifier);

    const { GET: getWorkItem } = await import('@/app/api/v1/work-items/[key]/route');
    const outside = await getWorkItem(
      jsonReq('GET', `${BASE}/work-items/${otherCard.identifier}`, bearer(ownToken)),
      { params: Promise.resolve({ key: otherCard.identifier }) },
    );
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { code?: string }).code).toBe(
      'DISPATCH_RUN_TOKEN_OUT_OF_SCOPE',
    );

    const { GET: getRun } = await import('@/app/api/v1/dispatch-runs/[id]/route');
    const foreignRun = await getRun(
      jsonReq('GET', `${BASE}/dispatch-runs/${other.dispatchRunId}`, bearer(ownToken)),
      { params: Promise.resolve({ id: other.dispatchRunId }) },
    );
    expect(foreignRun.status).toBe(403);
    expect(((await foreignRun.json()) as { code?: string }).code).toBe(
      'DISPATCH_RUN_TOKEN_OUT_OF_SCOPE',
    );

    // Its OWN card and its OWN run are still reachable — the lock narrows, it
    // does not disable.
    const ownRes = await getWorkItem(
      jsonReq('GET', `${BASE}/work-items/${ownCard.identifier}`, bearer(ownToken)),
      { params: Promise.resolve({ key: ownCard.identifier }) },
    );
    expect(ownRes.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4 · The start path's repository refusal — 409, naming EVERY repository
// ═════════════════════════════════════════════════════════════════════════

describe('the start path refuses a run whose repositories it cannot all write', () => {
  it('409 hosted_repository_not_writable names every repository, with zero provisions', async () => {
    const repoA = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const repoB = await seedRepo({ state: 'connected', owner: 'acme', name: 'billing' });
    const story = await newCard({ kind: 'story', title: 'a two-repo story' });
    const one = await newCard({ kind: 'task', title: 'one', parentId: story.id });
    const two = await newCard({ kind: 'task', title: 'two', parentId: story.id });
    await pinRepos(one.id, [repoA.projectRepoId]);
    await pinRepos(two.id, [repoB.projectRepoId]);
    // BOTH repositories are unreachable — not one of two, every one of the run's.
    installationStatus = { 'acme/web': 404, 'acme/billing': 404 };

    const refused = await start(story.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunRepositoryNotWritableError);
    const err = refused as HostedRunRepositoryNotWritableError;
    expect(err.code).toBe('hosted_repository_not_writable');
    expect(err.totalRepositories).toBe(2);
    expect(err.refusals.map((r: RunGitWriteRefusal) => r.repository).sort()).toEqual([
      'acme/billing',
      'acme/web',
    ]);
    for (const r of err.refusals) expect(r.fix).toBe('reconnect');

    // The absences ARE the assertion: nothing was opened, minted or booted.
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    for (const id of [one.id, two.id, story.id]) {
      expect((await cardOf(id)).status).toBe('todo');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5 · Coverage top-up (MOTIR-692) — two of the start path's OWN refusals that
// no per-card suite exercises: the credit pre-flight unreachable, and a boot
// that fails at provision. Both are genuine start-path scenarios (not bare
// constructor calls), and both name the absences the same way every other
// refusal in this file does.
// ═════════════════════════════════════════════════════════════════════════

describe('two more start-path refusals — nothing opened survives them either', () => {
  it('the credit pre-flight unreachable refuses as HostedRunCreditsUnavailableError, before anything is opened', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'credits unreachable' });
    await pinRepos(card.id, [repo.projectRepoId]);
    creditCheckStatus = 503;

    const refused = await start(card.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunCreditsUnavailableError);
    expect((refused as HostedRunCreditsUnavailableError).code).toBe(
      'hosted_run_credits_unavailable',
    );
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('a boot the provider refuses ends the run failed and is reported as HostedRunBootFailedError', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'the fleet refuses to boot it' });
    await pinRepos(card.id, [repo.projectRepoId]);
    fakeOrchestrator.failNextProvision('the fleet is at its ceiling');

    const refused = await start(card.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunBootFailedError);
    const err = refused as HostedRunBootFailedError;
    expect(err.code).toBe('hosted_run_boot_failed');
    expect(err.detail).toContain('the fleet is at its ceiling');

    // Unlike every OTHER refusal here, the run WAS opened (the boot is the last
    // step) — so this is the one refusal where the no-leak guarantee, not
    // absence, is the assertion: it was ended `failed` and its key revoked.
    const run = await adminDb.dispatchRun.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(run).toMatchObject({ status: 'failed', stopReason: 'halted' });
    expect(err.dispatchRunId).toBe(run.id);
    expect(revokedKeys).toContain(run.id);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: run.id } })).toBe(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6 · CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6797) — the story's own gate.
//
// Each card of that story tested itself (`tests/hostedRuns/hostedRunStart.test.ts`'s
// continue block, `tests/ready/claimWorkItemContinue.test.ts`'s hosted opening, the
// CLI's continue suites). What lives BETWEEN them is asserted here, on the same
// fake fleet and the same real Postgres as the rest of this file: every end of a
// hosted CONTINUE through `endHostedRun`, a refused pre-flight taking no lock, the
// browser racing a terminal on one card, and a dead run's per-repository branches
// reaching the container's own reads.
// ═════════════════════════════════════════════════════════════════════════

const startContinue = (key: string, ctx = fx.ctx) =>
  hostedRunService.start(
    { workItemKey: key, model: MODEL, idempotencyKey: `idem-${++seq}`, mode: 'continue' },
    ctx,
  );

/** An In Progress card, assigned to the owner, pinned to `repos`, whose LOCAL run
 *  checked out a branch in each and then went silent. */
async function deadCardOn(
  repos: SeededRepo[],
  title = 'a card whose run died',
): Promise<{ card: { id: string; identifier: string }; deadRunId: string; branches: string[] }> {
  const card = await newCard({ kind: 'task', title });
  await pinRepos(
    card.id,
    repos.map((r) => r.projectRepoId),
  );
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
  const branches = repos.map((r) => `subtask/${card.identifier}-${r.name}`);
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data:
          repos.length === 1
            ? { branch: branches[0] }
            : {
                branches: repos.map((r, i) => ({
                  repository: r.name,
                  branch: branches[i],
                  workBranch: branches[i],
                })),
              },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 8 * MINUTE) },
  });
  return { card, deadRunId: run.id, branches };
}

/** A LIVE hosted continue that has fetched its git credential. */
async function liveContinueWithGitCredential() {
  const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
  const { card, deadRunId } = await deadCardOn([repo]);
  const started = await startContinue(card.identifier);
  const data = await supervisionDataOf();
  const spec = fakeOrchestrator.specs.at(-1)!;
  expect(spec.env).toMatchObject({ MOTIR_RUN_MODE: 'continue' });
  const runToken = runTokenOf(spec);

  const { POST: postGitCred } =
    await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
  const res = await postGitCred(
    jsonReq(
      'POST',
      `${BASE}/dispatch-runs/${started.dispatchRunId}/git-credential`,
      bearer(runToken),
    ),
    { params: Promise.resolve({ id: started.dispatchRunId }) },
  );
  expect(res.status, 'seeding a live git credential').toBe(200);
  return { dispatchRunId: started.dispatchRunId, cardId: card.id, deadRunId, data, runToken };
}

/** Every end but success leaves the card In Progress, with the continuer, and
 *  continuable again — the ended continue is now the dead run. */
async function expectContinuableAgain(cardId: string, dispatchRunId: string): Promise<void> {
  expect(await cardOf(cardId)).toMatchObject({ status: 'in_progress', assigneeId: fx.ownerId });
  expect(await workItemContinueService.getContinueView(cardId, fx.ctx)).toMatchObject({
    state: 'died',
    refusal: null,
    deadRun: { id: dispatchRunId, command: 'continue', origin: 'hosted' },
  });
}

describe('continue hosted — every end goes through endHostedRun and leaks nothing', () => {
  it('start → claim → boot: ONE hosted `continue` run, booted in continue mode', async () => {
    const { dispatchRunId, deadRunId } = await liveContinueWithGitCredential();
    expect(await runOf(dispatchRunId)).toMatchObject({
      command: 'continue',
      origin: 'hosted',
      status: 'running',
    });
    // The claim closed the lapsed run in its own transaction.
    expect(await runOf(deadRunId)).toMatchObject({ stopReason: 'abandoned' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('success — the CLI closes it, the end path only tears down', async () => {
    const { dispatchRunId, data, runToken } = await liveContinueWithGitCredential();
    const { POST: postClose } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
    const closed = await postClose(
      jsonReq('POST', `${BASE}/dispatch-runs/${dispatchRunId}/close`, bearer(runToken), {
        stopReason: 'completed',
        status: 'succeeded',
      }),
      { params: Promise.resolve({ id: dispatchRunId }) },
    );
    expect(closed.status).toBe(200);
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 0 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'succeeded' });
    await assertNoLeak(dispatchRunId, runToken);
  });

  it('failed — a crash leaves the card In Progress and continuable', async () => {
    const { dispatchRunId, data, runToken, cardId } = await liveContinueWithGitCredential();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 1 });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'job_completed' });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'failed', stopReason: 'halted' });
    await assertNoLeak(dispatchRunId, runToken);
    await expectContinuableAgain(cardId, dispatchRunId);
  });

  it('stall — no agent output ends it early; the card stays In Progress', async () => {
    const { dispatchRunId, data, runToken, cardId } = await liveContinueWithGitCredential();
    const bootedAt = new Date(data.session.bootedAt).getTime();
    const later = () => new Date(bootedAt + HOSTED_RUN_STALL_WINDOW_MS + MINUTE);
    expect(await superviseToEnd(data, later)).toEqual({
      outcome: 'settled',
      reason: 'job_timed_out',
    });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'timed_out' });
    await assertNoLeak(dispatchRunId, runToken);
    await expectContinuableAgain(cardId, dispatchRunId);
  });

  it('cancelled — revoked at once, settled at the next poll; the card stays In Progress', async () => {
    const { dispatchRunId, data, runToken, cardId } = await liveContinueWithGitCredential();
    await hostedRunService.cancel(dispatchRunId, fx.ctx);
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'cancelled' });
    expect(await superviseToEnd(data)).toEqual({ outcome: 'settled', reason: 'gate_revoked' });
    await assertNoLeak(dispatchRunId, runToken);
    await expectContinuableAgain(cardId, dispatchRunId);
  });

  it('lost supervision — the sweep settles it; the card stays In Progress', async () => {
    const { dispatchRunId, data, runToken, cardId } = await liveContinueWithGitCredential();
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
    await withSystemContext(async (tx: Prisma.TransactionClient) => {
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
    expect(await supervisionSweepService.sweepAbandoned()).toMatchObject({ settled: 1 });
    expect(await runOf(dispatchRunId)).toMatchObject({ status: 'timed_out' });
    await assertNoLeak(dispatchRunId, runToken);
    await expectContinuableAgain(cardId, dispatchRunId);
    await truncateJobRuns();
  });

  it('died again — a continue that ended failed is continued by a second Continue hosted', async () => {
    const { dispatchRunId, data, cardId } = await liveContinueWithGitCredential();
    fakeOrchestrator.completeJob(data.session.handle.id, { exitCode: 1 });
    await superviseToEnd(data);
    const card = await cardOf(cardId);

    const again = await startContinue(card.identifier);
    expect(again.created).toBe(true);
    expect(again.dispatchRunId).not.toBe(dispatchRunId);
    expect(await runOf(again.dispatchRunId)).toMatchObject({
      command: 'continue',
      origin: 'hosted',
      status: 'running',
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
  });
});

describe('continue hosted — a refused pre-flight takes no lock', () => {
  /** Nothing opened, nothing booted, the dead run untouched, the assignee kept —
   *  and a terminal `motir continue` right after is accepted. */
  async function expectNoLockTaken(cardId: string, identifier: string, deadRunId: string) {
    expect(
      await adminDb.dispatchRun.count({
        where: { workspaceId: fx.workspaceId, command: 'continue' },
      }),
    ).toBe(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect((await runOf(deadRunId)).stopReason).toBeNull();
    expect((await cardOf(cardId)).assigneeId).toBe(fx.ownerId);
    const terminal = await workItemContinueService.claimContinue(fx.projectId, identifier, fx.ctx);
    expect(terminal.outcome).toBe('claimed');
  }

  it('out of credits', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCardOn([repo]);
    creditMayRun = false;
    await expect(startContinue(card.identifier)).rejects.toBeInstanceOf(HostedRunOutOfCreditsError);
    await expectNoLockTaken(card.id, card.identifier, deadRunId);
  });

  it('a model not offered', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCardOn([repo]);
    await expect(
      hostedRunService.start(
        { workItemKey: card.identifier, model: 'nope', idempotencyKey: 'k', mode: 'continue' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    await expectNoLockTaken(card.id, card.identifier, deadRunId);
  });

  it('a repository it cannot write', async () => {
    const repo = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const { card, deadRunId } = await deadCardOn([repo]);
    installationStatus = { 'acme/web': 404 };
    await expect(startContinue(card.identifier)).rejects.toBeInstanceOf(
      HostedRunRepositoryNotWritableError,
    );
    await expectNoLockTaken(card.id, card.identifier, deadRunId);
  });

  it('`mode` omitted is Run hosted: a died In Progress card is refused not ready, no continue opened', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card, deadRunId } = await deadCardOn([repo]);
    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    await expectNoLockTaken(card.id, card.identifier, deadRunId);
  });
});

describe('continue hosted — the browser racing a terminal on one card', () => {
  it('Continue hosted and a v1 `/continue` at once: one winner, the other `taken` naming it', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCardOn([repo]);
    const user = await usersService.createUser({
      email: `terminal+${randomToken()}@example.com`,
      password: 'hunter2hunter2',
      name: 'Tess Terminal',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const { token } = await apiTokensService.create(user.id, fx.workspaceId, {
      label: `race-${randomToken()}`,
      projectId: fx.projectId,
      permissions: CLI_TOKEN_GRANT.filter((p) => !p.startsWith('lesson:')),
    });
    const { POST: postContinue } = await import('@/app/api/v1/work-items/[key]/continue/route');

    // A cold pool hands both racers one connection and passes with the lock missing.
    await warmPool(4);
    const [hosted, terminal] = await Promise.all([
      startContinue(card.identifier).then(
        (r) => ({ ok: true as const, runId: r.dispatchRunId }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      postContinue(
        jsonReq('POST', `${BASE}/work-items/${card.identifier}/continue`, bearer(token)),
        { params: Promise.resolve({ key: card.identifier }) },
      ).then(async (res) => (await res.json()) as Record<string, unknown>),
    ]);

    const continues = await adminDb.dispatchRun.findMany({
      where: { workspaceId: fx.workspaceId, command: 'continue' },
    });
    expect(continues, 'exactly one continuing agent').toHaveLength(1);
    const winner = continues[0]!;

    if (hosted.ok) {
      // The browser won: the terminal is told who holds it.
      expect(winner).toMatchObject({ id: hosted.runId, origin: 'hosted' });
      expect(terminal).toMatchObject({ outcome: 'taken', holder: { id: fx.ownerId } });
      expect(fakeOrchestrator.provisioned).toHaveLength(1);
    } else {
      // The terminal won: the browser's refusal names the terminal's member.
      expect(terminal).toMatchObject({ outcome: 'claimed', runId: winner.id });
      expect(hosted.err).toMatchObject({
        code: 'hosted_continue_taken',
        holder: { id: user.id, name: 'Tess Terminal' },
      });
      expect(fakeOrchestrator.provisioned).toEqual([]);
    }
  });
});

describe('continue hosted — a dead run’s branch per repository reaches the container', () => {
  it('checkout_ready → the claim → the adopted run’s `continues` → the CONTINUE prompt, per repository', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const api = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'api' });
    const { card, deadRunId, branches } = await deadCardOn([site, api], 'a two-repository card');

    const started = await startContinue(card.identifier);
    const runToken = runTokenOf(fakeOrchestrator.specs.at(-1)!);
    const headers = bearer(runToken);

    // The container ADOPTS the run and reads every repository's branch off it.
    const { GET: getRun } = await import('@/app/api/v1/dispatch-runs/[id]/route');
    const adopted = await getRun(
      jsonReq('GET', `${BASE}/dispatch-runs/${started.dispatchRunId}`, headers),
      { params: Promise.resolve({ id: started.dispatchRunId }) },
    );
    expect(adopted.status).toBe(200);
    const run = dispatchRunSchema.parse(await adopted.json());
    expect(run.continues).toMatchObject({ fromRunId: deadRunId, mode: 'card' });
    expect(run.continues!.branches.map((b) => [b.repository, b.branch])).toEqual([
      ['site', branches[0]],
      ['api', branches[1]],
    ]);
    // Every repository names where to clone it from — none it has to refuse.
    for (const b of run.continues!.branches) expect(b.cloneUrl).toMatch(/^https:\/\//);

    // The agent's prompt names every repository's branch, in its CONTINUE block.
    const { GET: getPrompt } = await import('@/app/api/v1/work-items/[key]/dispatch-prompt/route');
    const promptRes = await getPrompt(
      jsonReq(
        'GET',
        `${BASE}/work-items/${card.identifier}/dispatch-prompt?continueFrom=${deadRunId}`,
        headers,
      ),
      { params: Promise.resolve({ key: card.identifier }) },
    );
    expect(promptRes.status).toBe(200);
    const prompt = String(((await promptRes.json()) as { prompt?: unknown }).prompt);
    expect(prompt).toContain('CONTINUE');
    for (const branch of branches) expect(prompt).toContain(branch);
  });

  it('the continue run’s credential reaches only its own card', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const { card } = await deadCardOn([repo]);
    const other = await newCard({ kind: 'task', title: 'outside the continue' });
    await startContinue(card.identifier);
    const token = runTokenOf(fakeOrchestrator.specs.at(-1)!);

    const { GET: getWorkItem } = await import('@/app/api/v1/work-items/[key]/route');
    const outside = await getWorkItem(
      jsonReq('GET', `${BASE}/work-items/${other.identifier}`, bearer(token)),
      { params: Promise.resolve({ key: other.identifier }) },
    );
    expect(outside.status).toBe(403);
    const own = await getWorkItem(
      jsonReq('GET', `${BASE}/work-items/${card.identifier}`, bearer(token)),
      { params: Promise.resolve({ key: card.identifier }) },
    );
    expect(own.status).toBe(200);
  });
});
