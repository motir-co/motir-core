import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW AGENT, ACROSS ITS SEAMS (Story MOTIR-1626 · MOTIR-6826 — the story's Vitest
// gate; ADR `approval-gates.md` §12 incl. §12.2a / §12.4b and `hosted-agent-run.md` §8 incl.
// §8.6). Every child card shipped its own suite; this file runs the ASSEMBLY — the loop
// from a green delivery set, through the review run and its verdict, to the next step or
// to To fix — on REAL Postgres, through the product's own doors:
//
//   · the green verdict and every head move are GitHub webhooks into `githubWebhookService`;
//   · the `agent-review/requested` request is the `job_event` row the REAL dispatcher wrote
//     (nothing stubs `sendEvent`), handed to the REAL job definition through the engine
//     test harness — exactly what a worker claiming the row does;
//   · the review run boots on the FAKE ORCHESTRATOR (`MOTIR_FLEET_ORCHESTRATOR=fake`), and
//     the verdict is posted with the run token the container was handed
//     (`MOTIR_RUN_TOKEN` in the boot spec), through `POST /api/v1/work-items/{key}/agent-review`;
//   · a person's presses are the session routes (decide, Review again, the switch, the
//     merge mode, Fix on the hosted agent); `motir fix` is `POST /api/v1/work-items/{key}/repair`.
//
// ⚠️ THE STUBS, AND NOTHING ELSE: the SESSION (a route test has no cookie jar and no
// request scope, so the compliance gate hands back the signed-in person — the seam the
// per-card route suites stub, `tests/settings/review-agent-switch.test.ts`) and `fetch`, answering motir-ai (the model list, the credit
// check, `GET /v1/convention` — the seam sequence 9 varies), the LLM gateway (run keys)
// and GitHub (installation reads and tokens). The container, gateway and motir-ai edges
// are the only fakes; every service, repository and transaction is the product's own.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantWorkspaceContext,
}));

import { fakeOrchestrator } from '@motir/orchestrator';
import type { ApprovalGateKind, User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { gateIdOfReviewRunKey } from '@/lib/agentReview/reviewRunKey';
import { agentReviewRequested } from '@/lib/jobs/definitions/agentReviewRequested';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { REVIEW_AGENT_REVIEWER_NAME } from '@/lib/workItems/fixReason';
import { bearer, withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { JobTestEngine } from '../helpers/jobs';
import { linkPr } from '../helpers/prLink';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { agentReviewViewService } = await import('@/lib/services/agentReviewViewService');
const { runCredentialService } = await import('@/lib/services/runCredentialService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');

const verdictRoute = await import('@/app/api/v1/work-items/[key]/agent-review/route');
const promptRoute = await import('@/app/api/v1/work-items/[key]/review-prompt/route');
const repairRoute = await import('@/app/api/v1/work-items/[key]/repair/route');
const gitCredentialRoute = await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
const decideRoute = await import('@/app/api/approval-gates/[id]/decide/route');
const reviewAgainRoute = await import('@/app/api/approval-gates/[id]/review-again/route');
const gatesSettingsRoute = await import('@/app/api/projects/[key]/approval-gates/route');
const mergeModeRoute = await import('@/app/api/projects/[key]/pr-merge-mode/route');
const hostedRunsRoute = await import('@/app/api/work-items/[id]/hosted-runs/route');

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

const tokenMints = () => host.calls.filter((c) => c.url.endsWith('/access_tokens'));
const conventionReads = () =>
  host.calls
    .filter((c) => c.url.startsWith(`${AI}/v1/convention?`))
    .map((c) => new URL(c.url).searchParams.get('repoKey'));

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

/** The runs the dispatcher ENQUEUED for `jobId` — after its per-job idempotency dedup, so a
 *  redelivered emit with the same key is not a second run. */
const queuedRuns = (jobId: string) =>
  adminDb.jobQueueRun.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } });

const reviewRequests = async (workItemId: string) =>
  (await eventsNamed('agent-review/requested')).filter(
    (d) => d['workItemId'] === workItemId,
  ) as unknown as AgentReviewRequestedData[];

/** A worker claims the request and runs the `agent-review/requested` job on it. */
async function runReviewJob(request: AgentReviewRequestedData) {
  const outcome = await new JobTestEngine({
    function: agentReviewRequested,
    events: [{ name: 'agent-review/requested', data: request }],
  }).execute();
  if (outcome.error) throw outcome.error;
  return outcome.result as { outcome: string; dispatchRunId?: string };
}

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

function readReviewPrompt(runToken: string, key: string) {
  return promptRoute.GET(
    new Request(`${V1}/work-items/${key}/review-prompt`, { headers: bearer(runToken) }),
    keyParams(key),
  );
}

/** `motir fix <KEY>` — the repair claim, with a person's token. */
function claimRepair(headers: Record<string, string>, key: string) {
  return repairRoute.POST(
    new Request(`${V1}/work-items/${key}/repair`, { method: 'POST', headers }),
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

async function pressReviewAgain(user: User, gateId: string) {
  await signInAs(user);
  return reviewAgainRoute.POST(
    new Request(`${APP}/approval-gates/${gateId}/review-again`, { method: 'POST' }),
    idParams(gateId),
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

async function patchMergeMode(user: User, projectKey: string, prMergeMode: string) {
  await signInAs(user);
  return mergeModeRoute.PATCH(
    new Request(`${APP}/projects/${projectKey}/pr-merge-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ prMergeMode }),
    }),
    keyParams(projectKey),
  );
}

async function pressFixHosted(user: User, key: string) {
  await signInAs(user);
  return hostedRunsRoute.POST(
    new Request(`${APP}/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, mode: 'fix', idempotencyKey: `fix-${key}` }),
    }),
    idParams(key),
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
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const runsOf = (workspaceId: string, command: 'review' | 'fix') =>
  adminDb.dispatchRun.findMany({ where: { workspaceId, command }, orderBy: { startedAt: 'asc' } });
const verdictEvents = (dispatchRunId: string) =>
  adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunId, kind: 'review_verdict' },
    orderBy: { seq: 'asc' },
  });

/**
 * The first half of every sequence: the card goes green with the switch on, ONE review is
 * raised and ONE request emitted; the job starts ONE review run on the fake orchestrator.
 */
async function greenToReviewRun(w: World, number: number, sha = 'sha-a') {
  const d = await deliveredCard(w, number);
  await allGreen(w, d, sha);

  const reviews = await awaitingOf(d.item.id, REVIEW);
  expect(reviews, 'the green verdict raised ONE review').toHaveLength(1);
  const review = reviews[0]!;
  expect(review.subjectVersion).toBe(versionOf(w, d, sha));
  expect(await gatesOf(d.item.id, MERGE), 'the merge question waits for the review').toEqual([]);
  const requests = await reviewRequests(d.item.id);
  expect(requests, 'the raise emitted ONE request').toHaveLength(1);
  expect(requests[0]).toMatchObject({ gateId: review.id, subjectVersion: review.subjectVersion });

  const started = await runReviewJob(requests[0]!);
  expect(started.outcome).toBe('started');
  const runs = (await runsOf(w.workspace.id, 'review')).filter((r) =>
    r.idempotencyKey?.startsWith(`agent-review:${review.id}:`),
  );
  expect(runs, 'the job opened ONE review run').toHaveLength(1);
  const run = runs[0]!;
  const env = bootOf(run.id);
  expect(env).toMatchObject({
    MOTIR_RUN_MODE: 'review',
    MOTIR_REVIEW_GATE_ID: review.id,
    MOTIR_REVIEW_VERSION: review.subjectVersion,
    MOTIR_WORK_ITEM_KEY: d.item.identifier,
  });
  return { d, review, run, runToken: env['MOTIR_RUN_TOKEN']!, sha };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────

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
  stubHost();
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

// ── 1. manual, pass ─────────────────────────────────────────────────────────────

describe('1 · manual, pass — green → review → review run → verdict → the approve-and-merge gate', () => {
  it('the job’s run reads its prompt and passes; ONE merge question at the SAME version; the run ends clean', async () => {
    const w = await makeWorld();
    const { d, review, run, runToken, sha } = await greenToReviewRun(w, 101);

    const prompt = await readReviewPrompt(runToken, d.item.identifier);
    expect(prompt.status).toBe(200);
    const brief = await json(prompt);
    expect(brief).toMatchObject({ gateId: review.id, subjectVersion: review.subjectVersion });
    expect(String(brief['prompt'])).toContain('A zero count renders `0`, never blank.');

    const res = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'pass',
      summaryMd: 'Meets the criterion.',
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ gateId: review.id, state: 'approved' });

    const decided = await gateRow(review.id);
    expect(decided).toMatchObject({ state: 'approved', decidedUnderAuthority: 'review_agent' });
    const merge = await gatesOf(d.item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({ state: 'awaiting', subjectVersion: versionOf(w, d, sha) });
    expect((await verdictEvents(run.id)).map((e) => e.data)).toEqual([
      expect.objectContaining({ verdict: 'pass', outcome: 'decided', gateId: review.id }),
    ]);

    // The container exits after its one verdict: nothing is written onto the decided review.
    await hostedRunService.endHostedRun(run.id, 'exited', 'the container exited 0');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
    // Nothing else was asked for: no second review, no fix, no status move by the review.
    expect(await reviewRequests(d.item.id)).toHaveLength(1);
    expect(await runsOf(w.workspace.id, 'fix')).toEqual([]);
    expect((await cardRow(d.item.id)).fixReason).toBeNull();
  });
});

// ── 2. The exclusion ────────────────────────────────────────────────────────────

describe('2 · the review agent and `auto` merging exclude each other (§12.2a)', () => {
  it('ON in `auto` → 409; `auto` while ON → 409; nothing written either way', async () => {
    const auto = await makeWorld({ mergeMode: 'auto', reviewAgent: false });
    const onInAuto = await patchSettings(auto.owner, auto.project.identifier, {
      reviewAgentEnabled: true,
    });
    expect(onInAuto.status).toBe(409);
    expect((await json(onInAuto))['code']).toBe('REVIEW_AGENT_NEEDS_MANUAL_MERGE');
    expect(
      await adminDb.project.findUniqueOrThrow({ where: { id: auto.project.id } }),
    ).toMatchObject({ reviewAgentEnabled: false, prMergeMode: 'auto' });

    const on = await makeWorld({ mergeMode: 'manual', reviewAgent: true });
    const autoWhileOn = await patchMergeMode(on.owner, on.project.identifier, 'auto');
    expect(autoWhileOn.status).toBe(409);
    expect((await json(autoWhileOn))['code']).toBe('MERGE_MODE_REVIEW_AGENT_ON');
    expect(await adminDb.project.findUniqueOrThrow({ where: { id: on.project.id } })).toMatchObject(
      {
        reviewAgentEnabled: true,
        prMergeMode: 'manual',
      },
    );
  });

  it('switch off → `auto` is accepted, and its green emits ONE auto-merge keyed pr:headSha and raises no review', async () => {
    const w = await makeWorld({ mergeMode: 'manual', reviewAgent: true });
    const off = await patchSettings(w.owner, w.project.identifier, { reviewAgentEnabled: false });
    expect(off.status).toBe(200);
    const auto = await patchMergeMode(w.owner, w.project.identifier, 'auto');
    expect(auto.status).toBe(200);

    const d = await deliveredCard(w, 111);
    await allGreen(w, d, 'sha-a');

    const pr = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number: 111, repo: { workspaceId: w.workspace.id } },
    });
    // GitHub delivers the green twice (the check run, then its suite): each emits, and the
    // job's `pr:headSha` key enqueues ONE merge.
    const merges = await queuedRuns('pull-request/auto-merge.requested');
    expect(merges.map((r) => r.idempotencyKey)).toEqual([`${pr.id}:sha-a`]);
    expect(
      (await eventsNamed('pull-request/auto-merge.requested')).every(
        (e) => e['workItemId'] === d.item.id && e['headSha'] === 'sha-a',
      ),
    ).toBe(true);
    expect(await gatesOf(d.item.id, REVIEW)).toEqual([]);
    expect(await eventsNamed('agent-review/requested')).toEqual([]);
  });
});

// ── 3. Sent back → To fix → `motir fix` → push → re-review ──────────────────────────

describe('3 · sent back — changes_requested → To fix → `motir fix` claims (review class) → push → the next green is reviewed', () => {
  it('runs the whole loop and reviews the NEW version', async () => {
    const w = await makeWorld();
    const { d, review, run, runToken } = await greenToReviewRun(w, 121);
    const statusBefore = (await cardRow(d.item.id)).status;

    const res = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'changes_requested',
      summaryMd: 'A zero count renders blank.',
      findingsMd: FINDINGS,
    });
    expect(res.status).toBe(200);
    await hostedRunService.endHostedRun(run.id, 'exited', 'the container exited 0');

    const card = await cardRow(d.item.id);
    expect(card.status).toBe(statusBefore);
    expect(card.fixReason).toBe('changes_requested');
    expect(card.fixDetail).toMatchObject({
      repair: 'fix',
      gate: 'agent_review',
      reviewerName: REVIEW_AGENT_REVIEWER_NAME,
    });
    expect(await gatesOf(d.item.id, MERGE)).toEqual([]);

    // `motir fix <KEY>` — the person's token claims the repair, with the findings in full.
    const pat = await withTokenFor(w.owner, w.workspace as never, {
      projectId: w.project.id,
      scopes: ['read', 'work_items:write'],
    });
    const claimed = await claimRepair(pat.headers, d.item.identifier);
    expect(claimed.status).toBe(200);
    expect(await json(claimed)).toMatchObject({
      outcome: 'claimed',
      repairClass: 'review',
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: FINDINGS,
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
      },
    });
    expect((await cardRow(d.item.id)).status).toBe(statusBefore);

    // The repair pushes: the head moves, the refusal is about an older version — To fix clears.
    await push(w, d.prs[0]!.repo, d.prs[0]!.number, d.prs[0]!.headRef, 'sha-b');
    expect((await cardRow(d.item.id)).fixReason).toBeNull();
    // The decided refusal is history — nothing re-decided it.
    expect(await gateRow(review.id)).toMatchObject({
      state: 'changes_requested',
      noteMd: FINDINGS,
    });

    // The next green is reviewed again — a NEW review at the NEW version, one new request.
    await allGreen(w, d, 'sha-b');
    const next = await awaitingOf(d.item.id, REVIEW);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(review.id);
    expect(next[0]!.subjectVersion).toBe(versionOf(w, d, 'sha-b'));
    const requests = await reviewRequests(d.item.id);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ gateId: next[0]!.id });
    expect((await runReviewJob(requests[1]!)).outcome).toBe('started');
    expect(await runsOf(w.workspace.id, 'review')).toHaveLength(2);
  });
});

// ── 4. A person's Request changes ────────────────────────────────────────────────

describe('4 · a person’s Request changes on the approve-and-merge gate → `repair = fix` → `motir fix` claims it', () => {
  it('the press sends it back, To fix names `fix`, and the repair route claims the review class', async () => {
    const w = await makeWorld();
    const { d, review, runToken } = await greenToReviewRun(w, 131);
    expect(
      (
        await submitVerdict(runToken, d.item.identifier, {
          subjectVersion: review.subjectVersion,
          verdict: 'pass',
        })
      ).status,
    ).toBe(200);

    const pressed = await pressDecide(w, d.item.id, MERGE, {
      decision: 'request_changes',
      noteMd: 'The empty state reads wrong.',
    });
    expect(pressed.status).toBe(200);

    const card = await cardRow(d.item.id);
    expect(card.fixReason).toBe('changes_requested');
    expect(card.fixDetail).toMatchObject({ repair: 'fix', gate: 'pull_request_approval' });

    const pat = await withTokenFor(w.owner, w.workspace as never, {
      projectId: w.project.id,
      scopes: ['read', 'work_items:write'],
    });
    const claimed = await claimRepair(pat.headers, d.item.identifier);
    expect(claimed.status).toBe(200);
    expect(await json(claimed)).toMatchObject({
      outcome: 'claimed',
      repairClass: 'review',
      reviewRefusal: { gate: 'pull_request_approval', findingsMd: 'The empty state reads wrong.' },
    });
  });
});

// ── 5. Stale ────────────────────────────────────────────────────────────────────

describe('5 · stale — a push mid-review supersedes the review; the late verdict decides nothing', () => {
  it('the push supersedes the gate and cancels the run; the late verdict is refused and nothing is decided', async () => {
    const w = await makeWorld();
    const { d, review, run, runToken } = await greenToReviewRun(w, 141);

    await push(w, d.prs[0]!.repo, d.prs[0]!.number, d.prs[0]!.headRef, 'sha-b');
    expect(await gateRow(review.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'head_moved',
    });
    expect((await runRow(run.id)).status).toBe('cancelled');

    const late = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'changes_requested',
      findingsMd: FINDINGS,
    });
    // ⚠️ WHAT THE LATE VERDICT IS ANSWERED is NOT pinned here, deliberately. §12.5 says it is
    // "recorded on the review RUN … and decides nothing", and the card asks for
    // `REVIEW_STALE` recorded on the run. On the assembled path it cannot be: the supersede
    // CANCELS the run (§12.5's other clause), the cancel ends it through
    // `hostedRunService.endHostedRun`, which REVOKES its run credential, and the late verdict
    // is refused 401 before the route runs — so nothing is recorded on the run. The per-card
    // suite (`agent-review-routes.test.ts`) drives a hand-minted run that is never
    // cancelled, which is why it passes. Reported with MOTIR-6826 for a decision; what
    // BOTH readings agree on is asserted: it is refused and it decides nothing.
    expect(late.status).not.toBe(200);
    const gate = await gateRow(review.id);
    expect(gate).toMatchObject({ state: 'superseded', decidedById: null, noteMd: null });
    expect(await gatesOf(d.item.id, MERGE)).toEqual([]);
    expect((await cardRow(d.item.id)).fixReason).toBeNull();
  });
});

// ── 6. Could not run ─────────────────────────────────────────────────────────────

describe('6 · could not run — no credits → reason on the gate → Review again → no verdict → the override', () => {
  it('walks every could-not-run branch and leaves only by a person’s written reason', async () => {
    const w = await makeWorld();
    const d = await deliveredCard(w, 151);
    host.mayRun = false;
    await allGreen(w, d, 'sha-a');
    const [review] = await awaitingOf(d.item.id, REVIEW);
    expect(review).toBeDefined();

    // Out-of-credits pre-flight: the reason is on the gate, no run, nothing booted.
    const [raise] = await reviewRequests(d.item.id);
    expect((await runReviewJob(raise!)).outcome).not.toBe('started');
    expect(await gateRow(review!.id)).toMatchObject({
      state: 'awaiting',
      reviewUnavailableReason: 'hosted_run_out_of_credits',
    });
    expect(await runsOf(w.workspace.id, 'review')).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);

    // Review again while the credits are unchanged: the press is taken, the request's own
    // pre-flight refuses again, and the reason is back — still no run.
    const again1 = await pressReviewAgain(w.owner, review!.id);
    expect(again1.status).toBe(202);
    const requests1 = await reviewRequests(d.item.id);
    expect(requests1).toHaveLength(2);
    await runReviewJob(requests1[1]!);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');
    expect(await runsOf(w.workspace.id, 'review')).toEqual([]);

    // The credits fixture changes: Review again now starts ONE run, for the same gate.
    host.mayRun = true;
    expect((await pressReviewAgain(w.owner, review!.id)).status).toBe(202);
    const requests2 = await reviewRequests(d.item.id);
    expect(requests2).toHaveLength(3);
    expect((await runReviewJob(requests2[2]!)).outcome).toBe('started');
    const [run] = await runsOf(w.workspace.id, 'review');
    expect(run).toBeDefined();
    expect(bootOf(run!.id)['MOTIR_REVIEW_GATE_ID']).toBe(review!.id);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
    // …and while that run is in flight, Review again is not offered: nothing more is asked.
    const whileRunning = await pressReviewAgain(w.owner, review!.id);
    expect(whileRunning.status).toBe(409);
    expect((await json(whileRunning))['code']).toBe('REVIEW_AGAIN_NOT_OFFERED');
    expect(await reviewRequests(d.item.id)).toHaveLength(3);

    // The run exits WITHOUT a verdict: that is written onto the gate, which stays awaiting.
    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');
    expect(await gateRow(review!.id)).toMatchObject({
      state: 'awaiting',
      reviewUnavailableReason: 'no_verdict',
    });

    // The override: refused without a note, then decided with one — the ordinary flow follows.
    const noNote = await pressDecide(w, d.item.id, REVIEW, { decision: 'approve' });
    expect(noNote.status).toBe(400);
    expect(await json(noNote)).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'override_needs_a_note',
    });
    expect((await gateRow(review!.id)).state).toBe('awaiting');

    const note = 'The review cannot run this week; I read the diff myself.';
    const override = await pressDecide(w, d.item.id, REVIEW, { decision: 'approve', noteMd: note });
    expect(override.status).toBe(200);
    const decided = await gateRow(review!.id);
    expect(decided).toMatchObject({ state: 'approved', decidedById: w.owner.id, noteMd: note });
    expect(decided.decidedUnderAuthority).not.toBe('review_agent');
    const merge = await awaitingOf(d.item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.subjectVersion).toBe(review!.subjectVersion);
  });
});

// ── 7. Switch off ──────────────────────────────────────────────────────────────────

describe('7 · switch off — mid-review, and from the start', () => {
  it('switching off mid-review supersedes the review, cancels its run and raises the ordinary flow', async () => {
    const w = await makeWorld();
    const { d, review, run } = await greenToReviewRun(w, 161);

    const off = await patchSettings(w.owner, w.project.identifier, { reviewAgentEnabled: false });
    expect(off.status).toBe(200);

    expect(await gateRow(review.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'review_agent_disabled',
    });
    expect((await runRow(run.id)).status).toBe('cancelled');
    const merge = await awaitingOf(d.item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.subjectVersion).toBe(review.subjectVersion);
  });

  it('with the switch off from the start, `manual` and `auto` run exactly as before — no review row, no request', async () => {
    const manual = await makeWorld({ reviewAgent: false, mergeMode: 'manual' });
    const m = await deliveredCard(manual, 171);
    await allGreen(manual, m, 'sha-a');
    const merge = await gatesOf(m.item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({
      state: 'awaiting',
      subjectVersion: versionOf(manual, m, 'sha-a'),
    });
    expect(await gatesOf(m.item.id, REVIEW)).toEqual([]);

    const auto = await makeWorld({ reviewAgent: false, mergeMode: 'auto' });
    const a = await deliveredCard(auto, 181);
    await allGreen(auto, a, 'sha-a');
    expect(await gatesOf(a.item.id, REVIEW)).toEqual([]);
    const autoPr = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number: 181, repo: { workspaceId: auto.workspace.id } },
    });
    expect(
      (await queuedRuns('pull-request/auto-merge.requested')).map((r) => r.idempotencyKey),
    ).toEqual([`${autoPr.id}:sha-a`]);
    expect(await gatesOf(a.item.id, MERGE)).toEqual([]);

    expect(await eventsNamed('agent-review/requested')).toEqual([]);
    expect(await adminDb.dispatchRun.count({ where: { command: 'review' } })).toBe(0);
  });
});

// ── 8. Isolation ──────────────────────────────────────────────────────────────────

describe('8 · tenant isolation — a verdict token, a session and a PAT stay in their own workspace', () => {
  it('card A’s review run cannot decide card B’s gate in another workspace, nor can A’s owner reach it', async () => {
    const a = await makeWorld({ identifier: 'ALPHA' });
    const b = await makeWorld({ identifier: 'BETA' });
    const ra = await greenToReviewRun(a, 191);
    const rb = await greenToReviewRun(b, 191);

    // A's run token, aimed at B's card, with B's version — refused, nothing decided.
    const cross = await submitVerdict(ra.runToken, rb.d.item.identifier, {
      subjectVersion: rb.review.subjectVersion,
      verdict: 'pass',
    });
    expect(cross.status).toBe(404);
    expect(await gateRow(rb.review.id)).toMatchObject({ state: 'awaiting', decidedById: null });
    expect(await verdictEvents(ra.run.id)).toEqual([]);
    expect(await gatesOf(rb.d.item.id, MERGE)).toEqual([]);

    // …nor its prompt.
    expect((await readReviewPrompt(ra.runToken, rb.d.item.identifier)).status).toBe(404);

    // A's owner, signed in, cannot press B's gate: not found, never forbidden.
    await signInAs(a.owner);
    const decide = await decideRoute.POST(
      new Request(`${APP}/approval-gates/${rb.review.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', noteMd: 'no', stamp: 'x' }),
      }),
      idParams(rb.review.id),
    );
    expect(decide.status).toBe(404);
    await adminDb.approvalGate.update({
      where: { id: rb.review.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });
    expect((await pressReviewAgain(a.owner, rb.review.id)).status).toBe(404);

    // A's token cannot claim B's repair.
    const pat = await withTokenFor(a.owner, a.workspace as never, {
      projectId: a.project.id,
      scopes: ['read', 'work_items:write'],
    });
    expect((await claimRepair(pat.headers, rb.d.item.identifier)).status).toBe(404);

    // B's own run token still decides B's gate — the refusals were about the tenant.
    expect(
      (
        await submitVerdict(rb.runToken, rb.d.item.identifier, {
          subjectVersion: rb.review.subjectVersion,
          verdict: 'pass',
        })
      ).status,
    ).toBe(200);
    expect((await gateRow(ra.review.id)).state).toBe('awaiting');
  });
});

// ── 9. Conventions are optional ───────────────────────────────────────────────────

describe('9 · conventions are optional — a two-repository card with motir-ai stubbed three ways', () => {
  const cases: Array<{
    name: string;
    arrange: (w: World) => void;
    expectPresent: (w: World) => string[];
  }> = [
    {
      name: 'one repository with a convention and one without',
      arrange: (w) => {
        host.conventions[`${w.org}/web`] = {
          contentMd: '## Counts\n\nUse `??` for counts, never `||`.',
        };
      },
      expectPresent: (w) => [`${w.org}/web`],
    },
    {
      name: 'every getConvention rejecting with MotirAiUnavailableError (503)',
      arrange: (w) => {
        for (const r of w.repos) host.conventions[`${w.org}/${r.name}`] = { status: 503 };
      },
      expectPresent: () => [],
    },
    {
      name: 'MotirAiConfigError (motir-ai not configured when the prompt is read)',
      arrange: () => {
        vi.stubEnv('MOTIR_AI_URL', '');
      },
      expectPresent: () => [],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the prompt is served, the run and the verdict proceed, no reason is written`, async () => {
      const w = await makeWorld({ repos: 2 });
      const { d, review, runToken, sha } = await greenToReviewRun(w, 201);
      expect(review.subjectVersion).toBe(versionOf(w, d, sha));
      c.arrange(w);

      const res = await readReviewPrompt(runToken, d.item.identifier);
      expect(res.status).toBe(200);
      const body = await json(res);
      const prompt = String(body['prompt']);
      expect((body['pullRequests'] as unknown[]).length).toBe(2);
      const present = c.expectPresent(w);
      for (const r of w.repos) {
        const repoKey = `${w.org}/${r.name}`;
        const absent = `  ${repoKey}\n    No coding convention is recorded for this repository.`;
        if (present.includes(repoKey)) {
          expect(prompt).not.toContain(absent);
        } else {
          expect(prompt).toContain(absent);
        }
      }
      if (present.length > 0) expect(prompt).toContain('Use `??` for counts, never `||`.');
      if (c.name.startsWith('MotirAiConfigError')) expect(conventionReads()).toEqual([]);
      expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();

      const verdict = await submitVerdict(runToken, d.item.identifier, {
        subjectVersion: review.subjectVersion,
        verdict: 'pass',
      });
      expect(verdict.status).toBe(200);
      const merge = await awaitingOf(d.item.id, MERGE);
      expect(merge).toHaveLength(1);
      expect(merge[0]!.subjectVersion).toBe(review.subjectVersion);
      expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
    });
  }
});

// ── 10. Fix on the hosted agent (§12.4b · §8.6) — the server half ──────────────────

describe('10 · Fix on the hosted agent — the press → the fix run → its push → the next review', () => {
  it('a sent-back card is repaired on the hosted agent; the push clears To fix and the next green is reviewed', async () => {
    const w = await makeWorld();
    const { d, review, run: reviewRun, runToken } = await greenToReviewRun(w, 211);
    await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'changes_requested',
      findingsMd: FINDINGS,
    });
    await hostedRunService.endHostedRun(reviewRun.id, 'exited', 'the container exited 0');
    const before = await cardRow(d.item.id);
    expect(before.fixReason).toBe('changes_requested');

    // The press: ONE hosted `fix` run, booted in fix mode, carrying the review's findings.
    const pressed = await pressFixHosted(w.owner, d.item.identifier);
    expect(pressed.status).toBe(201);
    const { dispatchRunId } = (await json(pressed)) as { dispatchRunId: string };
    expect(await runRow(dispatchRunId)).toMatchObject({
      command: 'fix',
      origin: 'hosted',
      status: 'running',
    });
    const env = bootOf(dispatchRunId);
    expect(env['MOTIR_RUN_MODE']).toBe('fix');
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      repairClass: 'review',
      findings: { gate: 'agent_review', gateId: review.id, findingsMd: FINDINGS },
      pullRequests: [{ number: 211, branch: d.prs[0]!.headRef }],
    });

    // One repair at a time: another member's local `motir fix` meets the hosted holder.
    const rivalUser = await usersService.createUser({
      email: `rival-${randomBytes(3).toString('hex')}@example.com`,
      password: 'hunter2hunter2',
      name: 'Terminal Fixer',
    });
    await workspacesService.addMember({ userId: rivalUser.id, workspaceId: w.workspace.id });
    const rivalPat = await withTokenFor(rivalUser, w.workspace as never, {
      scopes: ['read', 'work_items:write'],
    });
    expect(await json(await claimRepair(rivalPat.headers, d.item.identifier))).toMatchObject({
      outcome: 'taken',
      runId: dispatchRunId,
      holder: { id: w.owner.id },
    });
    expect(await runsOf(w.workspace.id, 'fix')).toHaveLength(1);

    // The container asks for its git credential with its run token: WRITE, to push its branch.
    const cred = await gitCredentialRoute.POST(
      new Request(`${V1}/dispatch-runs/${dispatchRunId}/git-credential`, {
        method: 'POST',
        headers: bearer(env['MOTIR_RUN_TOKEN']!),
      }),
      idParams(dispatchRunId),
    );
    expect(cred.status).toBe(200);
    expect(tokenMints().at(-1)!.body).toMatchObject({
      permissions: { contents: 'write', pull_requests: 'write' },
    });

    // Its push lands: the head moves, To fix clears, the card never moved status.
    await push(w, d.prs[0]!.repo, 211, d.prs[0]!.headRef, 'sha-fixed');
    expect((await cardRow(d.item.id)).fixReason).toBeNull();
    await hostedRunService.endHostedRun(dispatchRunId, 'exited', 'the container exited 0');
    const after = await cardRow(d.item.id);
    expect(after.status).toBe(before.status);
    expect(after.fixReason).toBeNull();

    // The next green is reviewed — a new review at the repaired version.
    await allGreen(w, d, 'sha-fixed');
    const next = await awaitingOf(d.item.id, REVIEW);
    expect(next).toHaveLength(1);
    expect(next[0]!.subjectVersion).toBe(versionOf(w, d, 'sha-fixed'));
    expect(await reviewRequests(d.item.id)).toHaveLength(2);
  });
});

// ── 11. The edges the journeys pass by ─────────────────────────────────────────────

describe('11 · the edges the journeys pass by — each on the assembled path', () => {
  it('the job starts nothing for a gate it cannot find, a review that could not run, or one already running', async () => {
    const w = await makeWorld();
    // A request naming no gate (a gate deleted with its card, say).
    expect(
      await runReviewJob({
        workspaceId: w.workspace.id,
        gateId: 'no-such-gate',
        workItemId: 'no-such-card',
        subjectVersion: 'x',
        idempotencyKey: 'agent-review:no-such-gate:raise',
      }),
    ).toEqual({ outcome: 'skipped', why: 'gate_missing' });

    // A refused review is not retried by a redelivery of its raise — only Review again.
    host.mayRun = false;
    const d = await deliveredCard(w, 301);
    await allGreen(w, d, 'sha-a');
    const [raise] = await reviewRequests(d.item.id);
    expect((await runReviewJob(raise!)).outcome).toBe('refused');
    host.mayRun = true;
    expect(
      await runReviewJob({ ...raise!, idempotencyKey: `agent-review:${raise!.gateId}:again:x` }),
    ).toEqual({ outcome: 'skipped', why: 'could_not_run' });
    expect(await runsOf(w.workspace.id, 'review')).toEqual([]);

    // With a review run in flight for the gate, a second request starts no second run.
    const r = await greenToReviewRun(w, 311);
    expect(
      await runReviewJob({
        workspaceId: w.workspace.id,
        gateId: r.review.id,
        workItemId: r.d.item.id,
        subjectVersion: r.review.subjectVersion!,
        idempotencyKey: `agent-review:${r.review.id}:again:y`,
      }),
    ).toEqual({ outcome: 'skipped', why: 'run_in_flight' });
    expect(
      (await runsOf(w.workspace.id, 'review')).filter((x) =>
        x.idempotencyKey?.startsWith(`agent-review:${r.review.id}:`),
      ),
    ).toHaveLength(1);
    // A key that is not a review run's names no gate.
    expect(gateIdOfReviewRunKey(`agent-review:${r.review.id}:raise`)).toBe(r.review.id);
    expect(gateIdOfReviewRunKey('agent-review:')).toBeNull();
    expect(gateIdOfReviewRunKey('fix-1')).toBeNull();
  });

  it('a person continues without the review WHILE it runs: the run’s later verdict is recorded and decides nothing', async () => {
    const w = await makeWorld();
    const { d, review, run, runToken } = await greenToReviewRun(w, 321);

    const note = 'Shipping today; I reviewed it myself.';
    expect(
      (await pressDecide(w, d.item.id, REVIEW, { decision: 'approve', noteMd: note })).status,
    ).toBe(200);
    expect(await awaitingOf(d.item.id, MERGE)).toHaveLength(1);

    const late = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'changes_requested',
      findingsMd: FINDINGS,
    });
    expect(late.status).toBe(409);
    expect((await json(late))['code']).toBe('REVIEW_STALE');
    expect((await verdictEvents(run.id)).map((e) => e.data)).toEqual([
      expect.objectContaining({ outcome: 'already_decided', gateId: review.id }),
    ]);
    expect(await gateRow(review.id)).toMatchObject({ state: 'approved', noteMd: note });
    expect(await awaitingOf(d.item.id, MERGE)).toHaveLength(1);
    expect((await cardRow(d.item.id)).fixReason).toBeNull();

    // The Development frame's read: a decided review carries no could-not-run reason.
    const view = await agentReviewViewService.readForWorkItem(d.item.id, w.ctx);
    expect(view).toMatchObject({ reviewUnavailableReason: null });
  });

  it('a verdict about another version is recorded as stale, and the run’s ONE verdict is spent', async () => {
    const w = await makeWorld();
    const { d, review, run, runToken } = await greenToReviewRun(w, 331);

    const stale = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: `${w.org}/web#331@sha-old`,
      verdict: 'pass',
    });
    expect(stale.status).toBe(409);
    expect((await json(stale))['code']).toBe('REVIEW_STALE');
    expect((await verdictEvents(run.id)).map((e) => e.data)).toEqual([
      expect.objectContaining({ outcome: 'stale_version' }),
    ]);
    expect((await gateRow(review.id)).state).toBe('awaiting');
    expect(await gatesOf(d.item.id, MERGE)).toEqual([]);

    // The run said its one thing: a second verdict — even the right one — is refused.
    const second = await submitVerdict(runToken, d.item.identifier, {
      subjectVersion: review.subjectVersion,
      verdict: 'pass',
    });
    expect(second.status).toBe(409);
    expect((await gateRow(review.id)).state).toBe('awaiting');
    // …and when it exits, the review could not run: a person may press Review again.
    await hostedRunService.endHostedRun(run.id, 'exited', 'the container exited 0');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('no_verdict');
  });

  it('a review run over a card with NO review answers 404 at both doors', async () => {
    const w = await makeWorld({ reviewAgent: false });
    const d = await deliveredCard(w, 341);
    await allGreen(w, d, 'sha-a');
    expect(await gatesOf(d.item.id, REVIEW)).toEqual([]);
    // A review run naming the card, with its own credential — no gate for it to answer.
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: w.workspace.id,
        projectId: w.project.id,
        command: 'review',
        origin: 'hosted',
        createdById: w.owner.id,
        cards: {
          create: [
            {
              workspaceId: w.workspace.id,
              workItemId: d.item.id,
              workItemKey: d.item.identifier,
              position: 0,
            },
          ],
        },
      },
    });
    const { token } = await runCredentialService.mintRunCredential({
      dispatchRunId: run.id,
      dispatcherUserId: w.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const verdict = await submitVerdict(token, d.item.identifier, {
      subjectVersion: versionOf(w, d, 'sha-a'),
      verdict: 'pass',
    });
    expect(verdict.status).toBe(404);
    expect((await json(verdict))['code']).toBe('REVIEW_GATE_NOT_FOUND');
    const prompt = await readReviewPrompt(token, d.item.identifier);
    expect(prompt.status).toBe(404);
    expect((await json(prompt))['code']).toBe('REVIEW_GATE_NOT_FOUND');
    // The merge question the switch-off flow raised is untouched.
    expect(await awaitingOf(d.item.id, MERGE)).toHaveLength(1);
  });

  it('Review again’s door: signed out, no gate named, not the routed person, and a decided review', async () => {
    const w = await makeWorld();
    const d = await deliveredCard(w, 351);
    host.mayRun = false;
    await allGreen(w, d, 'sha-a');
    const [review] = await awaitingOf(d.item.id, REVIEW);
    await runReviewJob((await reviewRequests(d.item.id))[0]!);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');

    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 }),
    });
    expect(
      (
        await reviewAgainRoute.POST(
          new Request(`${APP}/approval-gates/${review!.id}/review-again`, { method: 'POST' }),
          idParams(review!.id),
        )
      ).status,
    ).toBe(401);
    expect((await pressReviewAgain(w.owner, '  ')).status).toBe(400);

    const member = await usersService.createUser({
      email: `member-${randomBytes(3).toString('hex')}@example.com`,
      password: 'hunter2hunter2',
      name: 'Not routed',
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: w.workspace.id });
    const forbidden = await pressReviewAgain(member, review!.id);
    expect(forbidden.status).toBe(403);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');

    // Continued without the review: it is decided, and there is nothing left to run again.
    await pressDecide(w, d.item.id, REVIEW, { decision: 'approve', noteMd: 'Checked by hand.' });
    const decided = await pressReviewAgain(w.owner, review!.id);
    expect(decided.status).toBe(409);
    expect(await json(decided)).toMatchObject({
      code: 'REVIEW_AGAIN_NOT_OFFERED',
      reason: 'not_awaiting',
    });
    expect(await reviewRequests(d.item.id)).toHaveLength(1);
  });

  it('a supersede outside a transaction scope cancels nothing itself — the run’s supervisor does', async () => {
    const w = await makeWorld();
    const { review, run } = await greenToReviewRun(w, 361);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    agentReviewStartService.cancelRunsAfterCommit(w.workspace.id, [review.id]);
    agentReviewStartService.cancelRunsAfterCommit(w.workspace.id, []);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await runRow(run.id)).status).toBe('running');
    // …and the direct cancel ends it, as the supersede seam does after its commit.
    expect(await agentReviewStartService.cancelRunsForGates(w.workspace.id, [review.id])).toEqual([
      run.id,
    ]);
    expect((await runRow(run.id)).status).toBe('cancelled');
  });
});
