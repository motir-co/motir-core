import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW DOORS, ACROSS THEIR SEAMS (Story MOTIR-11941 · MOTIR-11950 — the story's
// integration gate; `approval-gates.md` §12.5, §12.18). Every card of the story proved its
// own part alone; this file drives the ASSEMBLY once a review starts only on a person's
// press, on REAL Postgres, through the product's own doors:
//
//   · the green verdict and every head move are GitHub webhooks into `githubWebhookService`
//     (the gate raise and its re-raise must start NOTHING);
//   · *Review with Motir agent* is the session route `POST /api/work-items/{key}/
//     review-with-motir-agent`, booting the hosted review on the FAKE ORCHESTRATOR;
//   · *Review in my agent* is the session route `…/review-in-my-agent` (GET the door, POST
//     the start), running in the person's own agent on the FAKE PERSISTENT FLEET;
//   · a hosted verdict posts with the container's run token to `…/agent-review`; an own
//     agent's — and the copyable `motir review <KEY>`'s — to the user-token door
//     `…/review-verdict`;
//   · the settings read and PATCH, the decide door (*Continue without the review*) and the
//     merge mode are their session routes.
//
// ⚠️ EVERY ABSENCE IS EARNED: where a case asserts that nothing started, the same fixture
// then presses a door and sees a run written, so a missing run means nothing started rather
// than a fixture that could not start one.
//
// The stubs are the session (the compliance gate hands back the signed-in person), `fetch`
// (motir-ai, the gateway, GitHub) and the two fake fleets. Every service, repository and
// transaction is the product's own. Nothing waits on time: the agent fleet's clock is
// virtual.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantWorkspaceContext,
}));

import { fakeOrchestrator, fakePersistentOrchestrator as agentFleet } from '@motir/orchestrator';
import type { ApprovalGateKind, User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { bearer, withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { linkPr } from '../helpers/prLink';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { installInlineBootDriver } from '../helpers/agentBootDriver';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { runCredentialService } = await import('@/lib/services/runCredentialService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { agentInstanceClock, agentInstanceLifecycleService } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { _resetAiPlanCache } = await import('@/lib/services/aiPlanGateService');
const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { reviewDismissalService } = await import('@/lib/services/reviewDismissalService');
const { reviewRunKeyPrefix } = await import('@/lib/agentReview/reviewRunKey');
const { ReviewAgentNeedsManualMergeError } = await import('@/lib/projects/errors');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');

const verdictRoute = await import('@/app/api/v1/work-items/[key]/agent-review/route');
const decideRoute = await import('@/app/api/approval-gates/[id]/decide/route');
const userVerdictRoute = await import('@/app/api/v1/work-items/[key]/review-verdict/route');
const myAgentRoute = await import('@/app/api/work-items/[id]/review-in-my-agent/route');
const reviewWithAgentRoute =
  await import('@/app/api/work-items/[id]/review-with-motir-agent/route');
const gatesSettingsRoute = await import('@/app/api/projects/[key]/approval-gates/route');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const V1 = 'http://localhost:3000/api/v1';
const APP = 'https://app.test/api';
const REVIEW = 'agent_review' as const;
const MERGE = 'pull_request_approval' as const;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const FINDINGS = [
  '- `app/header.tsx:12` — breaks “A zero count renders `0`”: `count || ""` blanks a zero.',
  '  Change it to `count ?? 0`.',
].join('\n');

// ── The HTTP seam: motir-ai, the gateway, GitHub ────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** What `GET /v1/convention` answers for one `repoKey`: a body's contentMd, `null` (none
 *  recorded) or an HTTP status (a 5xx is `MotirAiUnavailableError`). */
type ConventionAnswer = { contentMd: string } | null | { status: number };

interface Host {
  /** The credit check's answer — the fixture sequence 6 changes. */
  mayRun: boolean;
  conventions: Record<string, ConventionAnswer>;
  calls: Call[];
}

let host: Host;

function stubHost(): void {
  host = { mayRun: true, conventions: {}, calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      host.calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url === `${AI}/v1/agent-models`) {
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, {
          coreOrganizationId: body?.['coreOrganizationId'],
          balanceCredits: host.mayRun ? 250 : 0,
          hasCredits: host.mayRun,
          mayRun: host.mayRun,
        });
      }
      if (url.startsWith(`${AI}/v1/convention?`)) {
        const repoKey = new URL(url).searchParams.get('repoKey') ?? '';
        const answer = host.conventions[repoKey] ?? null;
        if (answer && 'status' in answer) {
          return new Response(
            JSON.stringify({ code: 'internal_error', status: answer.status, title: 'down' }),
            { status: answer.status, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        const convention = answer
          ? {
              id: `conv_${repoKey}`,
              aiProjectId: 'ai_1',
              repoKey,
              version: 3,
              contentMd: answer.contentMd,
              provenance: [],
              sourceAuditId: null,
              createdAt: '2026-09-29T00:00:00.000Z',
              updatedAt: '2026-09-29T00:00:00.000Z',
            }
          : null;
        return json(200, {
          convention,
          versions: convention ? [convention] : [],
          nextCursor: null,
        });
      }
      // The own-agent fleet's motir-ai reads (the agent-instance harness's answers).
      if (url.startsWith(`${AI}/v1/stripe/subscription?`)) {
        return json(200, {
          status: 'active',
          currentPeriodEnd: null,
          priceId: null,
          planTier: { key: 'max_x2', name: 'Max ×2', monthlyCreditAllotment: 60_000 },
        });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        return json(200, { idempotent: false, balanceCredits: 90 });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.['runRef'],
          coreOrganizationId: body?.['coreOrganizationId'],
          expiresAt: body?.['expiresAt'],
          lane: 'agent',
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const inst = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        return json(200, {
          id: 42,
          account: { login: inst[1] },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${inst[1]}/settings/installations/42`,
        });
      }
      if (/\/app\/installations\/[^/]+\/access_tokens$/.test(url) && method === 'POST') {
        return json(201, {
          token: `ghs_story_${host.calls.length}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') return json(200, { slug: 'motir-studio' });
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') return json(200, { id: 2002, login: user[1] });
      if (/\/installation\/token$/.test(url) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in the story gate: ${method} ${url}`);
    }),
  );
}

// ── The world: a workspace, its GitHub installation, a project with the switch on ─────

interface RepoSpec {
  name: string;
  providerId: string;
}

interface World {
  owner: User;
  ctx: { userId: string; workspaceId: string };
  workspace: { id: string; organizationId: string | null };
  project: { id: string; identifier: string };
  org: string;
  installationId: string;
  repos: RepoSpec[];
}

let worldSeq = 0;

async function makeWorld(
  opts: {
    identifier?: string;
    reviewAgent?: boolean;
    mergeMode?: 'manual' | 'auto';
    repos?: number;
  } = {},
): Promise<World> {
  const n = ++worldSeq;
  const owner = await usersService.createUser({
    email: `owner-${n}-${randomBytes(3).toString('hex')}@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${n}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Story gate ${n}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${n}`,
    identifier: opts.identifier ?? 'ACME',
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      prMergeMode: opts.mergeMode ?? 'manual',
      reviewAgentEnabled: opts.reviewAgent ?? true,
    },
  });
  const org = `org${n}`;
  const installationId = `inst-story-6826-${n}`;
  const repos: RepoSpec[] = Array.from({ length: opts.repos ?? 1 }, (_, i) => ({
    name: i === 0 ? 'web' : `api${i}`,
    providerId: `6826${n}${i}`,
  }));
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: org, accountType: 'Organization' },
    repos: repos.map((r) => ({
      providerRepoId: r.providerId,
      owner: org,
      name: r.name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  // Each repository is one of the project's — the ones a review or a repair run reads.
  for (const [i, r] of repos.entries()) {
    const mirror = await adminDb.githubRepo.findFirstOrThrow({
      where: { workspaceId: workspace.id, repoId: r.providerId },
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: i === 0 ? 'web' : 'api',
        name: r.name,
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        state: 'created',
        position: `a${i}`,
        githubRepoId: mirror.id,
      },
    });
  }
  return {
    owner,
    ctx: { userId: owner.id, workspaceId: workspace.id },
    workspace: { id: workspace.id, organizationId: workspace.organizationId ?? null },
    project: { id: project.id, identifier: project.identifier },
    org,
    installationId,
    repos,
  };
}

// ── GitHub, as webhooks ─────────────────────────────────────────────────────────

const installationOf = (w: World) => ({
  id: w.installationId,
  account: { login: w.org, type: 'Organization' },
});

function prPayload(w: World, repo: RepoSpec, action: string, number: number, head: object) {
  return {
    action,
    installation: installationOf(w),
    repository: { id: Number(repo.providerId) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (#${number})`,
      head,
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** CI finished green at `sha` on pull request `number` of `repo`: the check run completes,
 *  then its suite — the two deliveries GitHub sends when a workflow passes. */
async function green(w: World, repo: RepoSpec, number: number, sha: string) {
  await githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: installationOf(w),
    repository: { id: Number(repo.providerId) },
    check_run: {
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      name: 'Vitest',
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });
  await githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: installationOf(w),
    repository: { id: Number(repo.providerId) },
    check_suite: {
      head_sha: sha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });
}

/** A push moved pull request `number`'s head to `sha` — and, as on GitHub, CI starts on it,
 *  and the host answers that the new head still merges with its base (MOTIR-7063: until it
 *  does, the next green asks nobody). */
async function push(w: World, repo: RepoSpec, number: number, headRef: string, sha: string) {
  await githubWebhookService.handleEvent(
    'pull_request',
    prPayload(w, repo, 'synchronize', number, { ref: headRef, sha }),
  );
  await hostAnswersCleanAt(w.workspace.id, number, sha, repo.name);
  await githubWebhookService.handleEvent('check_run', {
    action: 'created',
    installation: installationOf(w),
    repository: { id: Number(repo.providerId) },
    check_run: {
      head_sha: sha,
      status: 'in_progress',
      conclusion: null,
      name: 'Vitest',
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });
}

interface Delivered {
  item: { id: string; identifier: string; title: string };
  prs: Array<{ repo: RepoSpec; number: number; headRef: string }>;
}

/** A card In Progress with one pull request per repository of the world, opened on GitHub. */
async function deliveredCard(w: World, number: number): Promise<Delivered> {
  const item = await workItemsService.createWorkItem(
    {
      projectId: w.project.id,
      kind: 'task',
      title: `Show the widget count (${number})`,
      descriptionMd: [
        'Make the widget count visible.',
        '',
        '## Acceptance criteria',
        '',
        '- A zero count renders `0`, never blank.',
      ].join('\n'),
    },
    w.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', w.ctx);
  const prs: Delivered['prs'] = [];
  for (const [i, repo] of w.repos.entries()) {
    const prNumber = number + i;
    const headRef = `subtask/${item.identifier}-${prNumber}`;
    await linkPr(
      {
        workItemId: item.id,
        projectId: w.project.id,
        owner: w.org,
        name: repo.name,
        number: prNumber,
        headRef,
      },
      w.ctx,
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload(w, repo, 'opened', prNumber, { ref: headRef }),
    );
    prs.push({ repo, number: prNumber, headRef });
  }
  return { item: { id: item.id, identifier: item.identifier, title: item.title }, prs };
}

/** Every pull request of the card goes green at `sha`. */
async function allGreen(w: World, d: Delivered, sha: string): Promise<void> {
  for (const pr of d.prs) await green(w, pr.repo, pr.number, sha);
}

const versionOf = (w: World, d: Delivered, sha: string) =>
  d.prs
    .map((pr) => `${w.org}/${pr.repo.name}#${pr.number}@${sha}`)
    .sort()
    .join(',');

// ── The job lane: what the REAL dispatcher wrote, handed to the REAL job ────────────

const eventsNamed = async (name: string) =>
  (await adminDb.jobEvent.findMany({ where: { name }, orderBy: { receivedAt: 'asc' } })).map(
    (e) => e.data as Record<string, unknown>,
  );

/** The container the fake orchestrator booted for `dispatchRunId` — its env is what a run holds. */
function bootOf(dispatchRunId: string): Record<string, string> {
  const spec = fakeOrchestrator.specs.find((s) => s.env['MOTIR_DISPATCH_RUN_ID'] === dispatchRunId);
  expect(spec, `a container was booted for run ${dispatchRunId}`).toBeDefined();
  return spec!.env;
}

// ── The doors ───────────────────────────────────────────────────────────────────

const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** The container submits its ONE verdict with the run token it was booted with. */
function submitVerdict(runToken: string, key: string, body: Record<string, unknown>) {
  return verdictRoute.POST(
    new Request(`${V1}/work-items/${key}/agent-review`, {
      method: 'POST',
      headers: { ...bearer(runToken), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    keyParams(key),
  );
}

/** The person pressing is signed in to their own (only) workspace. */
async function signInAs(user: User): Promise<void> {
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
  });
  requireCompliantWorkspaceContext.mockResolvedValue({
    ok: true,
    ctx: { userId: user.id, workspaceId: membership.workspaceId },
  });
}

/** A person's press on a gate — through the read that hands them the stamp, then the door. */
async function pressDecide(
  w: World,
  workItemId: string,
  kind: ApprovalGateKind,
  body: { decision: string; noteMd?: string },
) {
  const read = await approvalGatesService.getForWorkItem({ workItemId, kind }, w.ctx);
  expect(read.gate?.state, `the ${kind} gate is awaiting a press`).toBe('awaiting');
  await signInAs(w.owner);
  return decideRoute.POST(
    new Request(`${APP}/approval-gates/${read.gate!.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ ...body, stamp: read.stamp }),
    }),
    idParams(read.gate!.id),
  );
}

/** *Review with Motir agent* (MOTIR-11944) — a person's press on the item, by its key. */
async function pressReviewWithAgent(user: User, key: string, body: Record<string, unknown> = {}) {
  await signInAs(user);
  return reviewWithAgentRoute.POST(
    new Request(`${APP}/work-items/${key}/review-with-motir-agent`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    idParams(key),
  );
}

async function patchSettings(user: User, projectKey: string, body: Record<string, unknown>) {
  await signInAs(user);
  return gatesSettingsRoute.PATCH(
    new Request(`${APP}/projects/${projectKey}/approval-gates`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    keyParams(projectKey),
  );
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

// ── Reads ───────────────────────────────────────────────────────────────────────

const gatesOf = (workItemId: string, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });
const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const cardRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

// ── Lifecycle ───────────────────────────────────────────────────────────────────

let virtualNow = 0;

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  resetRateLimitStore();
  requireCompliantWorkspaceContext.mockReset();
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
  vi.stubEnv('GITHUB_TOKEN_ENCRYPTION_KEY', 'b'.repeat(64));
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'm'.repeat(48));
  stubHost();
  // The person's own agents: the fake persistent fleet on a virtual clock, its boot job
  // driven in process (the agent-instance harness's set-up).
  agentFleet.reset();
  _resetAiPlanCache();
  virtualNow = new Date('2026-11-21T10:00:00.000Z').getTime();
  vi.spyOn(agentInstanceClock, 'now').mockImplementation(() => new Date(virtualNow));
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    virtualNow += ms;
  });
  agentFleet.setNow(() => new Date(virtualNow));
  agentFleet.setExecResponder((command) => ({
    exitCode: 0,
    stdout: command.includes('signin') ? '{"profile":"claude","state":"signed_in"}\n' : '',
    stderr: '',
  }));
  installInlineBootDriver();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  requireCompliantWorkspaceContext.mockReset();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The own-agent doors and the user-token verdict door ──────────────────────────

const myAgentRequest = (key: string, init?: RequestInit) =>
  new Request(`${APP}/work-items/${key}/review-in-my-agent`, init);

/** *Review in my agent*'s read, for a signed-in person. */
async function readMyAgentDoor(user: User, key: string) {
  await signInAs(user);
  return myAgentRoute.GET(myAgentRequest(key), idParams(key));
}

/** *Review in my agent*'s start: the picked agent and a per-press request key. */
async function pressMyAgent(user: User, key: string, agentInstanceId: string, requestKey: string) {
  await signInAs(user);
  return myAgentRoute.POST(
    myAgentRequest(key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentInstanceId, idempotencyKey: requestKey }),
    }),
    idParams(key),
  );
}

/** One of the owner's own agents on the world's project, running on the fake fleet. */
async function ownAgent(w: World, name = `agent-${randomBytes(2).toString('hex')}`) {
  const created = await agentInstanceLifecycleService.create(
    w.project.identifier,
    { name, profileId: 'claude' },
    w.ctx,
  );
  return created.id;
}

async function runTokenOf(dispatchRunId: string, userId: string) {
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId,
    dispatcherUserId: userId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return bearer(token);
}

/** The user-token verdict door — what an own agent and `motir review <KEY>` post to. */
function postUserVerdict(headers: Record<string, string>, key: string, body: unknown) {
  return userVerdictRoute.POST(
    new Request(`${V1}/work-items/${key}/review-verdict`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    keyParams(key),
  );
}

const userVerdict = (version: string | null, over: Record<string, unknown> = {}) => ({
  verdict: 'approved',
  subjectVersion: version,
  summaryMd: 'Meets the card.',
  findingsMd: null,
  checklist: [],
  harness: 'Claude Code',
  model: 'claude-self-report',
  ...over,
});

const SEND_BACK = {
  verdict: 'changes_requested',
  findingsMd: FINDINGS,
};

/** A person's PAT — the credential `motir review <KEY>` runs under. */
const patOf = async (w: World) =>
  (
    await withTokenFor(w.owner as never, w.workspace as never, {
      projectId: w.project.id,
      scopes: ['read', 'work_items:write'],
    })
  ).headers;

const reviewToRunRows = (recipientUserId: string) =>
  adminDb.notification.findMany({
    where: { recipientUserId, type: 'review_to_run' },
    orderBy: { createdAt: 'asc' },
  });
const markerOf = async (w: World, workItemId: string) =>
  (await reviewStateService.forCards(w.project.id, [workItemId], w.ctx)).get(workItemId) ?? null;
const reviewRunsAt = (gateId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'review', idempotencyKey: { startsWith: reviewRunKeyPrefix(gateId) } },
    orderBy: { startedAt: 'asc' },
  });
/** Every call the motir-ai / gateway double recorded that a review START would make. */
const reviewStartCalls = () =>
  host.calls.filter(
    (c) =>
      c.url === `${AI}/v1/credits/agent-run-check` ||
      c.url.startsWith(`${GATEWAY}/api/motir/run-keys`),
  );

/** A card green with Review on: its ONE awaiting review, nothing started. */
async function waitingForReview(w: World, number: number, sha = 'sha-a') {
  const d = await deliveredCard(w, number);
  host.calls.length = 0;
  await allGreen(w, d, sha);
  const reviews = await awaitingOf(d.item.id, REVIEW);
  expect(reviews, 'the green verdict raised ONE review').toHaveLength(1);
  return { d, review: reviews[0]!, sha };
}

// ── 1. Nothing starts by itself ─────────────────────────────────────────────────

describe('1 · nothing starts by itself — the raise, the switch-on and the re-raise wait for a press', () => {
  it('a green set raises ONE awaiting review: no run, no start event, no motir-ai call; notified once; Waiting; then a press does start one', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 101);

    expect(review.subjectVersion).toBe(versionOf(w, d, 'sha-a'));
    expect(await reviewRunsAt(review.id)).toEqual([]);
    expect(await eventsNamed('agent-review/requested')).toEqual([]);
    expect(reviewStartCalls(), 'no credit check, no run key').toEqual([]);
    expect(fakeOrchestrator.specs).toEqual([]);
    expect((await reviewToRunRows(w.owner.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${review.id}`,
    ]);
    expect((await markerOf(w, d.item.id))?.marker).toMatchObject({ kind: 'waiting_for_review' });
    expect(await gatesOf(d.item.id, MERGE), 'approve-for-merge is not offered').toEqual([]);

    // The same fixture CAN start one: the absence above is the raise's, not the fixture's.
    const pressed = await pressReviewWithAgent(w.owner, d.item.identifier, { model: MODEL });
    expect(pressed.status).toBe(201);
    expect(await reviewRunsAt(review.id)).toHaveLength(1);
  });

  it('turning Review on over green items raises nothing; their next green version raises one each, with nothing started', async () => {
    const w = await makeWorld({ reviewAgent: false });
    const one = await deliveredCard(w, 111);
    const two = await deliveredCard(w, 121);
    await allGreen(w, one, 'sha-a');
    await allGreen(w, two, 'sha-a');
    expect(await awaitingOf(one.item.id, MERGE)).toHaveLength(1);
    expect(await awaitingOf(two.item.id, MERGE)).toHaveLength(1);

    host.calls.length = 0;
    const on = await patchSettings(w.owner, w.project.identifier, { reviewAgentEnabled: true });
    expect(on.status).toBe(200);
    for (const d of [one, two]) expect(await gatesOf(d.item.id, REVIEW)).toEqual([]);
    expect(await adminDb.dispatchRun.count({ where: { command: 'review' } })).toBe(0);
    expect(await eventsNamed('agent-review/requested')).toEqual([]);
    expect(await reviewToRunRows(w.owner.id)).toEqual([]);

    // §12.5: the NEXT version is reviewed — raised, not started.
    for (const d of [one, two]) {
      for (const pr of d.prs) await push(w, pr.repo, pr.number, pr.headRef, 'sha-b');
      await allGreen(w, d, 'sha-b');
    }
    const raised = [
      ...(await awaitingOf(one.item.id, REVIEW)),
      ...(await awaitingOf(two.item.id, REVIEW)),
    ];
    expect(raised.map((g) => g.subjectVersion)).toEqual([
      versionOf(w, one, 'sha-b'),
      versionOf(w, two, 'sha-b'),
    ]);
    expect(await adminDb.dispatchRun.count({ where: { command: 'review' } })).toBe(0);
    expect(reviewStartCalls()).toEqual([]);
    expect((await reviewToRunRows(w.owner.id)).map((n) => n.dedupeKey).sort()).toEqual(
      raised.map((g) => `review_to_run:${g.id}`).sort(),
    );

    const pressed = await pressReviewWithAgent(w.owner, one.item.identifier, { model: MODEL });
    expect(pressed.status).toBe(201);
  });

  it('a new head withdraws the waiting review and raises the next one — still nothing started, notified once more', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 131);
    for (const pr of d.prs) await push(w, pr.repo, pr.number, pr.headRef, 'sha-b');
    await allGreen(w, d, 'sha-b');

    expect((await gateRow(review.id)).state).not.toBe('awaiting');
    const [next] = await awaitingOf(d.item.id, REVIEW);
    expect(next!.subjectVersion).toBe(versionOf(w, d, 'sha-b'));
    expect(await adminDb.dispatchRun.count({ where: { command: 'review' } })).toBe(0);
    expect((await markerOf(w, d.item.id))?.marker).toMatchObject({ kind: 'waiting_for_review' });
    expect((await reviewToRunRows(w.owner.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${review.id}`,
      `review_to_run:${next!.id}`,
    ]);
    expect((await pressReviewWithAgent(w.owner, d.item.identifier, {})).status).toBe(201);
  });

  it('architecture: only the hosted door route starts a review, and nothing emits a review request', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    // The CODE of a file — its comments name the retired paths on purpose.
    const code = (f: string) =>
      readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
    walk(join(root, 'lib'));
    walk(join(root, 'app'));
    const callers = files
      .filter((f) => /agentReviewStartService\.startRequested\(/.test(code(f)))
      .map((f) => relative(root, f));
    expect(callers).toEqual(['app/api/work-items/[id]/review-with-motir-agent/route.ts']);
    const emitters = files
      .filter((f) => /['"`]agent-review\/requested['"`]/.test(code(f)))
      .map((f) => relative(root, f))
      // The event's own registry entry may name it; no service emits it.
      .filter((f) => !f.startsWith('lib/jobs/'));
    expect(emitters).toEqual([]);
  });
});

// ── 2. The hosted door ──────────────────────────────────────────────────────────

describe('2 · Review with Motir agent — one run per press, refusals by name', () => {
  it('one press: ONE run at the gate’s version with the chosen model, in flight; a second press and a retry start nothing', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 201);

    const first = await pressReviewWithAgent(w.owner, d.item.identifier, {
      model: MODEL,
      idempotencyKey: 'press-1',
    });
    expect(first.status).toBe(201);
    const runs = await reviewRunsAt(review.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.model).toBe(MODEL);
    expect(bootOf(runs[0]!.id)['MOTIR_REVIEW_VERSION']).toBe(review.subjectVersion);
    expect((await markerOf(w, d.item.id))?.marker).toMatchObject({ kind: 'agent_reviewing' });

    const retry = await pressReviewWithAgent(w.owner, d.item.identifier, {
      model: MODEL,
      idempotencyKey: 'press-1',
    });
    const again = await pressReviewWithAgent(w.owner, d.item.identifier, { model: MODEL });
    for (const res of [retry, again]) {
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({
        code: 'REVIEW_START_NOT_OFFERED',
        reason: 'review_in_flight',
      });
    }
    expect(await reviewRunsAt(review.id)).toHaveLength(1);
  });

  it('a run that ends without a verdict: the same press starts a fresh one under a new key', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 211);
    await pressReviewWithAgent(w.owner, d.item.identifier, { model: MODEL });
    const [run] = await reviewRunsAt(review.id);
    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('no_verdict');

    expect((await pressReviewWithAgent(w.owner, d.item.identifier, {})).status).toBe(201);
    const runs = await reviewRunsAt(review.id);
    expect(runs.map((r) => r.idempotencyKey)).toEqual([
      `agent-review:${review.id}:press:1`,
      `agent-review:${review.id}:press:2`,
    ]);
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
  });

  it('each refusal by name, writing no run: no permission, lane off, no credits, decided, not In review', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 221);
    const runsNow = () => adminDb.dispatchRun.count({ where: { command: 'review' } });

    // A member outside the routed set.
    const member = await usersService.createUser({
      email: `member-${randomBytes(3).toString('hex')}@example.com`,
      password: 'hunter2hunter2',
      name: 'Not routed',
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: w.workspace.id });
    const forbidden = await pressReviewWithAgent(member, d.item.identifier, {});
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden))['code']).toBe('REVIEW_START_FORBIDDEN');

    // The hosted lane off for the organisation: the kill-switch refuses by its code.
    await adminDb.orgFeatureFlag.create({
      data: {
        organizationId: w.workspace.organizationId!,
        key: 'hosted_runs',
        enabled: false,
        reason: 'Spend',
      },
    });
    const laneOff = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(laneOff.status).toBe(403);
    expect((await json(laneOff))['code']).toBe('ORG_FEATURE_DISABLED');
    await adminDb.orgFeatureFlag.deleteMany({
      where: { organizationId: w.workspace.organizationId! },
    });

    // No AI credits.
    host.mayRun = false;
    const broke = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(broke.status).toBe(402);
    host.mayRun = true;
    expect(await runsNow()).toBe(0);

    // Not In review.
    await workItemsService.updateStatus(d.item.id, 'in_progress', w.ctx);
    const notInReview = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(notInReview.status).toBe(409);
    expect((await json(notInReview))['reason']).toBe('not_in_review');
    await workItemsService.updateStatus(d.item.id, 'in_review', w.ctx);

    // Decided: Continue without the review.
    await pressDecide(w, d.item.id, REVIEW, { decision: 'approve', noteMd: 'Checked by hand.' });
    const decided = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(decided.status).toBe(409);
    expect((await json(decided))['reason']).toBe('gate_not_awaiting');

    expect(await runsNow()).toBe(0);
    expect(await reviewRunsAt(review.id)).toEqual([]);
  });
});

// ── 3. The own-agent door ───────────────────────────────────────────────────────

describe('3 · Review in my agent — one run in the person’s agent, one review at a time', () => {
  it('a start sends ONE review run to the agent; the door reads it as progress; the verdict lands as the person, and the merge question follows', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 301);
    const agentId = await ownAgent(w, 'yue-laptop');

    const door = await readMyAgentDoor(w.owner, d.item.identifier);
    expect(door.status).toBe(200);
    expect(await json(door)).toMatchObject({ offered: true, agent: { id: agentId } });

    const started = await pressMyAgent(w.owner, d.item.identifier, agentId, 'mine-1');
    expect(started.status, String(JSON.stringify(await started.clone().json()))).toBe(201);
    const runs = await reviewRunsAt(review.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ origin: 'instance', agentInstanceId: agentId });
    expect(fakeOrchestrator.specs, 'no hosted container').toEqual([]);

    const progress = await json(await readMyAgentDoor(w.owner, d.item.identifier));
    expect(progress).toMatchObject({ offered: false, reason: 'review_in_flight' });
    expect((progress['run'] as Record<string, unknown>)['id']).toBe(runs[0]!.id);
    // The hosted door sees the same review in flight.
    const hosted = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(hosted.status).toBe(409);
    expect((await json(hosted))['reason']).toBe('review_in_flight');

    const res = await postUserVerdict(
      await runTokenOf(runs[0]!.id, w.owner.id),
      d.item.identifier,
      userVerdict(review.subjectVersion),
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await gateRow(review.id)).toMatchObject({ state: 'approved' });
    const [record] = await adminDb.reviewVerdictRecord.findMany({
      where: { workItemId: d.item.id },
    });
    expect(record).toMatchObject({
      submittedById: w.owner.id,
      harness: 'Claude Code',
      model: 'claude-self-report',
    });
    expect(await awaitingOf(d.item.id, MERGE)).toHaveLength(1);
  });

  it('while a hosted review runs, the own-agent door reads review_in_flight and a start opens nothing', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 311);
    const agentId = await ownAgent(w);
    await pressReviewWithAgent(w.owner, d.item.identifier, {});

    expect(await json(await readMyAgentDoor(w.owner, d.item.identifier))).toMatchObject({
      offered: false,
      reason: 'review_in_flight',
    });
    const refused = await pressMyAgent(w.owner, d.item.identifier, agentId, 'mine-2');
    expect(refused.status).toBe(409);
    expect(await reviewRunsAt(review.id)).toHaveLength(1);
  });

  it('no own agent reads no_agent; an unusable one reads agent_unusable with its refusal — both 200 answers', async () => {
    const w = await makeWorld();
    const { d } = await waitingForReview(w, 321);
    const none = await readMyAgentDoor(w.owner, d.item.identifier);
    expect(none.status).toBe(200);
    expect(await json(none)).toMatchObject({ offered: false, reason: 'no_agent' });

    const agentId = await ownAgent(w);
    // An agent moving to a new image takes no run.
    await adminDb.agentInstance.update({ where: { id: agentId }, data: { state: 'updating' } });
    const unusable = await readMyAgentDoor(w.owner, d.item.identifier);
    expect(unusable.status).toBe(200);
    expect(await json(unusable)).toMatchObject({
      offered: false,
      reason: 'agent_unusable',
      refusal: 'agent_instance_state_conflict',
    });
  });
});

// ── 4. Verdicts, whichever door ─────────────────────────────────────────────────

describe('4 · verdicts, whichever door — pass, send back, continue without', () => {
  it('a hosted pass and a `motir review` (PAT) pass each raise the approve-and-merge gate', async () => {
    const w = await makeWorld();
    const hosted = await waitingForReview(w, 401);
    await pressReviewWithAgent(w.owner, hosted.d.item.identifier, {});
    const [run] = await reviewRunsAt(hosted.review.id);
    const res = await submitVerdict(bootOf(run!.id)['MOTIR_RUN_TOKEN']!, hosted.d.item.identifier, {
      subjectVersion: hosted.review.subjectVersion,
      verdict: 'pass',
      summaryMd: 'Meets the criterion.',
    });
    expect(res.status).toBe(200);
    expect(await awaitingOf(hosted.d.item.id, MERGE)).toHaveLength(1);

    const cli = await waitingForReview(w, 411);
    const viaPat = await postUserVerdict(
      await patOf(w),
      cli.d.item.identifier,
      userVerdict(cli.review.subjectVersion, { harness: 'Codex', model: 'gpt-5.5' }),
    );
    expect(viaPat.status, JSON.stringify(await viaPat.clone().json())).toBe(200);
    expect(await gateRow(cli.review.id)).toMatchObject({ state: 'approved' });
    expect(await awaitingOf(cli.d.item.id, MERGE)).toHaveLength(1);
  });

  it('a send-back from either door puts the item in To fix and leaves no merge question', async () => {
    const w = await makeWorld();
    const hosted = await waitingForReview(w, 421);
    await pressReviewWithAgent(w.owner, hosted.d.item.identifier, {});
    const [run] = await reviewRunsAt(hosted.review.id);
    const res = await submitVerdict(bootOf(run!.id)['MOTIR_RUN_TOKEN']!, hosted.d.item.identifier, {
      subjectVersion: hosted.review.subjectVersion,
      verdict: 'changes_requested',
      summaryMd: 'One criterion is not met.',
      findingsMd: FINDINGS,
    });
    expect(res.status).toBe(200);
    expect((await cardRow(hosted.d.item.id)).fixReason).toBe('changes_requested');
    expect(await awaitingOf(hosted.d.item.id, MERGE)).toEqual([]);

    const cli = await waitingForReview(w, 431);
    const viaPat = await postUserVerdict(
      await patOf(w),
      cli.d.item.identifier,
      userVerdict(cli.review.subjectVersion, SEND_BACK),
    );
    expect(viaPat.status).toBe(200);
    expect((await cardRow(cli.d.item.id)).fixReason).toBe('changes_requested');
    expect(await awaitingOf(cli.d.item.id, MERGE)).toEqual([]);
  });

  it('Continue without the review decides the waiting review and raises approve-and-merge', async () => {
    const w = await makeWorld();
    const { d, review } = await waitingForReview(w, 441);
    const res = await pressDecide(w, d.item.id, REVIEW, {
      decision: 'approve',
      noteMd: 'Reviewed by hand.',
    });
    expect(res.status).toBe(200);
    expect(await gateRow(review.id)).toMatchObject({ state: 'approved' });
    expect(await awaitingOf(d.item.id, MERGE)).toHaveLength(1);
    expect(await reviewRunsAt(review.id)).toEqual([]);
  });
});

// ── 5. Review off ───────────────────────────────────────────────────────────────

describe('5 · Review off — the doors still review; the verdict gates nothing', () => {
  it('no review gate; both doors start a review; a send-back is a record, approve-and-merge unchanged; Dismiss restores it', async () => {
    const w = await makeWorld({ reviewAgent: false });
    const d = await deliveredCard(w, 501);
    await allGreen(w, d, 'sha-a');
    expect(await gatesOf(d.item.id, REVIEW)).toEqual([]);
    const [merge] = await awaitingOf(d.item.id, MERGE);
    expect(merge).toBeDefined();
    const version = versionOf(w, d, 'sha-a');

    // The hosted door: a gate-less run.
    const hosted = await pressReviewWithAgent(w.owner, d.item.identifier, {});
    expect(hosted.status).toBe(201);
    expect(await json(hosted)).toMatchObject({ created: true, gateId: null });
    const [hostedRun] = await adminDb.dispatchRun.findMany({
      where: { workspaceId: w.workspace.id, command: 'review' },
    });
    await hostedRunService.endHostedRun(hostedRun!.id, 'exited', 'the container exited 0');

    // The own-agent door: offered once the hosted review has ended.
    const agentId = await ownAgent(w);
    expect(await json(await readMyAgentDoor(w.owner, d.item.identifier))).toMatchObject({
      offered: true,
    });
    const started = await pressMyAgent(w.owner, d.item.identifier, agentId, 'off-1');
    expect(started.status).toBe(201);
    const ownRun = (
      await adminDb.dispatchRun.findMany({
        where: { workspaceId: w.workspace.id, command: 'review', origin: 'instance' },
      })
    )[0]!;

    const res = await postUserVerdict(
      await runTokenOf(ownRun.id, w.owner.id),
      d.item.identifier,
      userVerdict(version, SEND_BACK),
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await json(res)).toMatchObject({ outcome: 'recorded', gateId: null });
    expect(await gatesOf(d.item.id, REVIEW), 'still no review gate').toEqual([]);
    expect(await adminDb.reviewVerdictRecord.count({ where: { workItemId: d.item.id } })).toBe(1);
    // The send-back withdrew the merge question; *Dismiss the review* restores it.
    expect(await awaitingOf(d.item.id, MERGE)).toEqual([]);
    await reviewDismissalService.dismiss(
      w.project.id,
      d.item.identifier,
      { subjectVersion: version, reasonMd: 'Out of scope for this card.' },
      w.ctx,
    );
    expect((await awaitingOf(d.item.id, MERGE)).map((g) => g.subjectVersion)).toEqual([version]);
  });
});

// ── 6. The retired source and the merge mode ────────────────────────────────────

describe('6 · the retired source — read, PATCH and the merge-mode exclusion', () => {
  it('the read names no source; a PATCH naming one saves the rest and ignores it; Review on stays on', async () => {
    const w = await makeWorld();
    await signInAs(w.owner);
    const read = await gatesSettingsRoute.GET(
      new Request(`${APP}/projects/${w.project.identifier}/approval-gates`),
      keyParams(w.project.identifier),
    );
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).not.toContain('reviewAgentSource');

    const before = await adminDb.project.findUniqueOrThrow({ where: { id: w.project.id } });
    const patched = await patchSettings(w.owner, w.project.identifier, {
      reviewAgentSource: 'own',
      reviewBotPostsEnabled: !before.reviewBotPostsEnabled,
    });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(await patched.json())).not.toContain('reviewAgentSource');
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: w.project.id } });
    expect(project.reviewBotPostsEnabled, 'the other field saved').toBe(
      !before.reviewBotPostsEnabled,
    );
    expect(project.reviewAgentEnabled, 'Review on stays on').toBe(true);
  });

  it('turning Review on under Merge automatically is refused by name and Review stays off', async () => {
    const w = await makeWorld({ reviewAgent: false, mergeMode: 'auto' });
    const refused = await patchSettings(w.owner, w.project.identifier, {
      reviewAgentEnabled: true,
    });
    expect(refused.status).toBe(409);
    expect((await json(refused))['code']).toBe('REVIEW_AGENT_NEEDS_MANUAL_MERGE');
    await expect(
      approvalGateSettingsService.updateSettings(
        w.project.id,
        { reviewAgentEnabled: true } as never,
        w.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewAgentNeedsManualMergeError);
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: w.project.id } })).reviewAgentEnabled,
    ).toBe(false);
  });
});

// ── 7. Tenant isolation ─────────────────────────────────────────────────────────

describe('7 · a second workspace beside the first', () => {
  it('neither sees nor touches the first’s gates, runs or notifications', async () => {
    const a = await makeWorld({ identifier: 'ACME' });
    const b = await makeWorld({ identifier: 'BETA' });
    const ra = await waitingForReview(a, 701);
    const rb = await waitingForReview(b, 711);

    // B's owner presses A's item: not found, never forbidden.
    expect((await pressReviewWithAgent(b.owner, ra.d.item.identifier, {})).status).toBe(404);
    expect((await readMyAgentDoor(b.owner, ra.d.item.identifier)).status).toBe(404);
    expect(await reviewRunsAt(ra.review.id)).toEqual([]);

    // Each presses its own: one run each, in its own workspace.
    expect((await pressReviewWithAgent(a.owner, ra.d.item.identifier, {})).status).toBe(201);
    expect((await pressReviewWithAgent(b.owner, rb.d.item.identifier, {})).status).toBe(201);
    const [runA] = await reviewRunsAt(ra.review.id);
    const [runB] = await reviewRunsAt(rb.review.id);
    expect(runA!.workspaceId).toBe(a.workspace.id);
    expect(runB!.workspaceId).toBe(b.workspace.id);

    // A's run token cannot decide B's review.
    const cross = await submitVerdict(bootOf(runA!.id)['MOTIR_RUN_TOKEN']!, rb.d.item.identifier, {
      subjectVersion: rb.review.subjectVersion,
      verdict: 'pass',
      summaryMd: 'Not mine.',
    });
    expect([403, 404]).toContain(cross.status);
    expect((await gateRow(rb.review.id)).state).toBe('awaiting');

    // Notifications stay in their own workspace.
    expect((await reviewToRunRows(a.owner.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${ra.review.id}`,
    ]);
    expect((await reviewToRunRows(b.owner.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${rb.review.id}`,
    ]);
  });
});
