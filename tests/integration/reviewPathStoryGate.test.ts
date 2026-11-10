import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE STORY GATE — Story MOTIR-10327 · MOTIR-10343.
//
// The ASSEMBLED agent review path, on REAL Postgres, the way the story's recipe drives it:
// the verdict door (MCP tool and API route), the send-back withdrawal, Dismiss, Motir's App
// bot posting and retiring its reviews, the review sync's bot filter, the review state read
// model, the review source switch, the hosted review prompt and the PR → cards lookup.
// Each predecessor pins its own part alone; every case here crosses at least two of them on
// ONE card, so a defect that only shows where two parts meet fails here, before the browser
// E2E (MOTIR-10345) does.
//
// The card under test delivers a set of TWO pull requests at one head: #201 opened by a
// person (the routed person's linked GitHub identity) and #202 opened by Motir's App. The
// GitHub side is the HTTP double below — it refuses Request changes on #202 exactly as GitHub
// refuses one on an own-authored pull request — and the merge and permission reads are spied
// on the provider, never the network. A SECOND workspace runs the same flow beside the first
// and must never see or be touched by any of it.
//
// Every assertion reads committed state: rows, the read model's answer, the events the doors
// emitted, or the double's recorded calls. Nothing waits on time.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { fakeOrchestrator } from '@motir/orchestrator';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { SubmitReviewVerdictInput } from '@/lib/dto/agentReview';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { linkPrByIdentifier } from '../helpers/prLink';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { bearer, withTokenFor } from '../fixtures/apiV1Fixtures';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { reviewVerdictService } = await import('@/lib/services/reviewVerdictService');
const { reviewDismissalService } = await import('@/lib/services/reviewDismissalService');
const { reviewBotPostService } = await import('@/lib/services/reviewBotPostService');
const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { projectPrMergeModeService } = await import('@/lib/services/projectPrMergeModeService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { _resetMotirAppBotLogins } = await import('@/lib/github/appBotLogins');
const { getGitProvider } = await import('@/lib/git');
const { reviewBotReconcile, reviewBotReconcileOnDismissal } =
  await import('@/lib/jobs/definitions/reviewBotPost');
const {
  ReviewDismissalForbiddenError,
  ReviewDismissalReasonRequiredError,
  ReviewDismissalStaleError,
  ReviewSendBackAlreadyDismissedError,
  ReviewTargetNotRunTargetError,
  ReviewVerdictInvalidError,
  ReviewVerdictLateError,
  ReviewVerdictSecondError,
} = await import('@/lib/agentReview/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');
const { MergeModeReviewAgentOnError, ReviewAgentNeedsManualMergeError } =
  await import('@/lib/projects/errors');
const { runSubmitReviewVerdict } = await import('@/lib/mcp/tools/submitReviewVerdict');
const { runFindWorkItemsForPullRequest } =
  await import('@/lib/mcp/tools/findWorkItemsForPullRequest');
const verdictRoute = await import('@/app/api/v1/work-items/[key]/review-verdict/route');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const REVIEW = 'agent_review' as const;
const PR_APPROVAL = 'pull_request_approval' as const;

/** The two pull requests of the card's delivery set: a person's, and Motir's App's. */
const PERSON_PR = 201;
const BOT_PR = 202;
const BOT_AUTHOR = { id: 777, login: 'motir-studio[bot]', type: 'Bot' };

/** One workspace's GitHub side: its installation, its repository, its person on GitHub. */
interface Tenant {
  slug: string;
  identifier: string;
  installationId: string;
  repoProviderId: string;
  repo: string;
  personGithubId: number;
}

const A: Tenant = {
  slug: 'a',
  identifier: 'ACME',
  installationId: 'inst-path-a',
  repoProviderId: '6820',
  repo: 'acme',
  personGithubId: 4242,
};
const B: Tenant = {
  slug: 'b',
  identifier: 'BETA',
  installationId: 'inst-path-b',
  repoProviderId: '6830',
  repo: 'beta',
  personGithubId: 4343,
};

const installationOf = (t: Tenant) => ({
  id: t.installationId,
  account: { login: 'moooon', type: 'Organization' },
});

// ── The GitHub, motir-ai and gateway double ───────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  mayRun?: boolean;
  /** Pull requests GitHub treats as the App's own: Request changes on them is refused. */
  ownPrs?: number[];
}

/** The App slugs the stubbed `GET /app` answers, by the JWT's `iss`. */
const SLUGS: Record<string, string> = { '111': 'motir-studio', '222': 'motir-integration' };
let reviewIds = 7000;
let calls: Call[] = [];

function stub(s: Stub = {}): void {
  calls = [];
  const ownPrs = new Set(s.ownPrs ?? [BOT_PR]);
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
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
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
      if (/\/repos\/moooon\/[a-z]+\/installation$/.test(url) && method === 'GET') {
        return json(200, {
          id: 42,
          account: { login: 'moooon' },
          permissions: { contents: 'write', pull_requests: 'write' },
          suspended_at: null,
          html_url: 'https://github.com/organizations/moooon/settings/installations/42',
        });
      }
      const reviewPost = /\/repos\/moooon\/[a-z]+\/pulls\/(\d+)\/reviews$/.exec(url);
      if (reviewPost && method === 'POST') {
        if (ownPrs.has(Number(reviewPost[1])) && body?.event === 'REQUEST_CHANGES') {
          return json(422, {
            message: 'Unprocessable Entity',
            errors: ['Review Can not request changes on your own pull request'],
          });
        }
        return json(200, { id: (reviewIds += 1), state: 'COMMENTED' });
      }
      if (/\/pulls\/\d+\/reviews\/\d+\/dismissals$/.test(url) && method === 'PUT') {
        return json(200, { state: 'DISMISSED' });
      }
      if (/\/app\/installations\/[^/]+\/access_tokens$/.test(url) && method === 'POST') {
        return json(201, {
          token: 'ghs-review-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') {
        const jwt = String((init?.headers as Record<string, string>)?.['authorization'] ?? '');
        const iss = String(
          (
            JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}') as {
              iss?: unknown;
            }
          ).iss ?? '',
        );
        return json(200, { slug: SLUGS[iss] });
      }
      if (/\/pulls\/\d+\/files\?/.test(url) && method === 'GET') return json(200, []);
      if (url.includes('/users/') && method === 'GET') return json(200, { id: 99 });
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const reviewCalls = () =>
  calls.filter((c) => c.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(c.url));
const dismissCalls = () => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/dismissals'));
const prNumberOf = (c: Call) => Number(/\/pulls\/(\d+)\//.exec(c.url)![1]);

const github = getGitProvider('github');

// ── The scenario ──────────────────────────────────────────────────────────────

async function makeScenario(t: Tenant) {
  const user = await usersService.createUser({
    email: `owner-${t.slug}@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${t.slug.toUpperCase()}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Workspace ${t.slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: t.identifier,
    identifier: t.identifier,
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', reviewAgentEnabled: true },
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: t.installationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: t.repoProviderId,
        owner: 'moooon',
        name: t.repo,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, repoId: t.repoProviderId },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: t.repo,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a0',
      githubRepoId: mirror.id,
    },
  });
  // The routed person's linked GitHub identity — the author of the person's pull request.
  await adminDb.githubIdentity.create({
    data: {
      userId: user.id,
      githubUserId: String(t.personGithubId),
      githubLogin: `gh-${t.personGithubId}`,
      accessTokenEncrypted: 'enc',
    },
  });
  return { t, user, workspace, project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const headRefOf = (identifier: string, number: number) => `subtask/${identifier}-${number}`;

function pullRequestPayload(
  t: Tenant,
  action: string,
  number: number,
  headRef: string,
  sha: string,
  author: { id: number; login: string; type: string },
) {
  return {
    action,
    installation: installationOf(t),
    repository: { id: Number(t.repoProviderId) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef, sha },
      base: { ref: 'main' },
      user: author,
    },
  };
}

const personAuthor = (t: Tenant) => ({
  id: t.personGithubId,
  login: `gh-${t.personGithubId}`,
  type: 'User',
});

const authorOf = (t: Tenant, number: number) => (number === BOT_PR ? BOT_AUTHOR : personAuthor(t));

/** Link pull request `number` to the card and open it on GitHub at `sha-a`. */
async function openPr(t: Tenant, identifier: string, number: number, author = authorOf(t, number)) {
  const headRef = headRefOf(identifier, number);
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: t.repo, number, headRef });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload(t, 'opened', number, headRef, 'sha-a', author),
  );
}

const ci = (t: Tenant, headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: installationOf(t),
    repository: { id: Number(t.repoProviderId) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

/** The set's version at `sha`: each member `owner/name#n@sha`, sorted, comma-joined. */
const setVersion = (t: Tenant, sha = 'sha-a', numbers = [PERSON_PR, BOT_PR]) =>
  numbers
    .map((n) => `moooon/${t.repo}#${n}@${sha}`)
    .sort()
    .join(',');

/** Move both pull requests' head to `sha` and turn CI green there. */
async function moveHead(s: Scenario, identifier: string, sha: string) {
  for (const number of [PERSON_PR, BOT_PR]) {
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload(
        s.t,
        'synchronize',
        number,
        headRefOf(identifier, number),
        sha,
        authorOf(s.t, number),
      ),
    );
    await hostAnswersCleanAt(s.workspace.id, number, sha);
  }
  for (const number of [PERSON_PR, BOT_PR]) await ci(s.t, sha, number);
}

const gatesOf = (workItemId: string, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });
const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');
const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const recordsOf = (workItemId: string) =>
  adminDb.reviewVerdictRecord.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
const postsOf = (workItemId: string) =>
  adminDb.reviewBotPost.findMany({
    where: { workItemId },
    include: { pullRequest: true },
    orderBy: { createdAt: 'asc' },
  });
const runRows = (workspaceId: string) =>
  adminDb.dispatchRun.findMany({ where: { workspaceId }, orderBy: { startedAt: 'asc' } });
const reviewToRunRows = (recipientUserId: string) =>
  adminDb.notification.findMany({
    where: { recipientUserId, type: 'review_to_run' },
    orderBy: { createdAt: 'asc' },
  });

const eventsNamed = (name: string) => sent.filter((e) => e.name === name).map((e) => e.data);
const reviewRequests = () =>
  eventsNamed('agent-review/requested') as unknown as AgentReviewRequestedData[];

/** The post job's event for the newest answering verdict, as the door emitted it. */
function postRequest(): { workspaceId: string; recordId: string } {
  const [request] = eventsNamed('review-bot/post.requested').slice(-1);
  expect(request, 'the verdict asked for its post').toBeDefined();
  return request as { workspaceId: string; recordId: string };
}

const stateOf = (
  s: Scenario,
  workItemId: string,
  ctx: { userId: string; workspaceId: string } = s.ctx,
) => reviewStateService.forCard(s.project.id, workItemId, ctx);

const homeCtx = (s: Scenario, ctx: { userId: string; workspaceId: string } = s.ctx) => ({
  ...ctx,
  projectId: s.project.id,
});

/**
 * A card delivered by the two-PR set, green at `sha-a`. `gate` on raises the review gate
 * (under `source`); off asks to approve and merge at once.
 */
async function deliveredSet(
  t: Tenant,
  o: { gate: boolean; source?: 'hosted' | 'own'; scenario?: Scenario } = { gate: true },
) {
  const s = o.scenario ?? (await makeScenario(t));
  await adminDb.project.update({
    where: { id: s.project.id },
    data: { reviewAgentEnabled: o.gate, reviewAgentSource: o.source ?? 'hosted' },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Export the report' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  sent.length = 0;
  await openPr(t, item.identifier, PERSON_PR);
  await openPr(t, item.identifier, BOT_PR);
  await ci(t, 'sha-a', PERSON_PR);
  await ci(t, 'sha-a', BOT_PR);
  const review = (await awaitingOf(item.id, REVIEW))[0];
  const approval = (await awaitingOf(item.id, PR_APPROVAL))[0];
  if (o.gate) {
    expect(review, 'the green set raised the review').toBeDefined();
    expect(review!.subjectVersion).toBe(setVersion(t));
    expect(approval, 'approve-and-merge waits for the review').toBeUndefined();
  } else {
    expect(approval, 'the green set asked to approve and merge').toBeDefined();
    expect(approval!.subjectVersion).toBe(setVersion(t));
    expect(review).toBeUndefined();
  }
  const request = reviewRequests().slice(-1)[0];
  return { s, item, review: review ?? null, approval: approval ?? null, request };
}

/** Put a teammate on the workspace with `role` on the project. */
async function teammate(s: Scenario, name: string, role: 'member' | 'viewer') {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: s.workspace.id });
  await addToProjectAs({
    key: s.t.identifier,
    actorUserId: s.user.id,
    ctx: s.ctx,
    targetUserId: user.id,
    role,
  });
  return { user, ctx: { userId: user.id, workspaceId: s.workspace.id } };
}

function input(
  version: string,
  over: Partial<SubmitReviewVerdictInput> = {},
): SubmitReviewVerdictInput {
  return {
    verdict: 'approved',
    subjectVersion: version,
    summaryMd: 'Looks right.',
    findingsMd: null,
    checklist: [
      { key: null, criterion: 'The report exports', status: 'met', evidence: 'export.test.ts' },
    ],
    harness: 'Claude Code',
    model: MODEL,
    ...over,
  };
}

const sendBack = (version: string, over: Partial<SubmitReviewVerdictInput> = {}) =>
  input(version, {
    verdict: 'changes_requested',
    findingsMd: '- `lib/export.ts:12` drops the header row — keep it.',
    checklist: [{ key: null, criterion: 'The report exports', status: 'not_met', evidence: null }],
    ...over,
  });

async function runToken(s: Scenario, dispatchRunId: string) {
  const { runCredentialService } = await import('@/lib/services/runCredentialService');
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId,
    dispatcherUserId: s.user.id,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return token;
}

async function hostedSubmit(
  s: Scenario,
  key: string,
  body: Record<string, unknown>,
  minted?: string,
) {
  const [run] = await runRows(s.workspace.id);
  const token = minted ?? (await runToken(s, run!.id));
  const { POST } = await import('@/app/api/v1/work-items/[key]/agent-review/route');
  return POST(
    new Request(`https://app.test/api/v1/work-items/${key}/agent-review`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

const postVerdictRoute = (headers: Record<string, string>, key: string, body: unknown) =>
  verdictRoute.POST(
    new Request(`https://app.test/api/v1/work-items/${key}/review-verdict`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );

const patFor = (s: Scenario, user: { id: string } = s.user) =>
  withTokenFor(user as never, s.workspace as never, {
    projectId: s.project.id,
    scopes: ['read', 'work_items:write'],
  });

let reviewSeq = 0;

/** One `pull_request_review` delivery, built from the recorded GitHub fixture. */
function reviewDelivery(
  t: Tenant,
  o: {
    number: number;
    sha: string;
    state: 'approved' | 'changes_requested';
    user: { login: string; id: number; type: string };
    action?: string;
    reviewId?: number;
  },
) {
  const file = join(process.cwd(), 'tests/fixtures/github/pull-request-review');
  const base = JSON.parse(readFileSync(join(file, 'submitted-approved.json'), 'utf8')) as {
    payload: Record<string, unknown>;
  };
  const body = structuredClone(base.payload);
  reviewSeq += 1;
  return {
    ...body,
    action: o.action ?? 'submitted',
    review: {
      ...(body['review'] as Record<string, unknown>),
      id: o.reviewId ?? 900_000 + reviewSeq,
      state: o.state,
      commit_id: o.sha,
      user: o.user,
    },
    pull_request: {
      ...(body['pull_request'] as Record<string, unknown>),
      number: o.number,
      head: { ref: `head-${o.number}`, sha: o.sha },
    },
    installation: { id: t.installationId },
    repository: {
      id: Number(t.repoProviderId),
      name: t.repo,
      full_name: `moooon/${t.repo}`,
      owner: { login: 'moooon', id: 55, type: 'Organization' },
    },
  };
}

const humanApproves = (t: Tenant, number: number, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request_review',
    reviewDelivery(t, {
      number,
      sha,
      state: 'approved',
      user: { login: 'ada-l', id: 5151, type: 'User' },
    }),
    `human-${number}-${sha}-${(reviewSeq += 1)}`,
  );

/** Spy the host's merge: answer `merged` for every member. */
const stubMerge = () =>
  vi.spyOn(github, 'mergeChangeRequest').mockImplementation(
    async (args): Promise<MergeChangeRequestResult> => ({
      outcome: 'merged',
      commitSha: `merge-${args.number}`,
    }),
  );

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  _resetMotirAppBotLogins();
  sent.length = 0;
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
  // The permission read — the one host call recording a person's review makes.
  vi.spyOn(github, 'getRepositoryPermission').mockResolvedValue('write');
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

// ── The door, under each source ───────────────────────────────────────────────

describe('the verdict door — gate on, under each source', () => {
  it('source own: a teammate’s MCP verdict decides the review, starts no hosted run, raises approve-and-merge, and the bot posts a comment on each PR', async () => {
    const { s, item, review } = await deliveredSet(A, { gate: true, source: 'own' });
    const mate = await teammate(s, 'mate', 'member');
    expect((await itemRow(item.id)).assigneeId).not.toBe(mate.user.id);
    sent.length = 0;

    const res = await runSubmitReviewVerdict(
      {
        key: item.identifier,
        verdict: 'approved',
        subjectVersion: setVersion(A),
        summaryMd: 'Both pull requests do what the card says.',
        checklist: [{ criterion: 'The report exports', status: 'met', evidence: 'export.test.ts' }],
        harness: 'Codex',
        model: 'gpt-5.5',
      },
      mate.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ outcome: 'decided', gateId: review!.id });

    // The review is decided by the review agent, from the own source — no hosted run.
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review!.id } });
    expect(decided).toMatchObject({ state: 'approved', decidedUnderAuthority: 'review_agent' });
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(calls.some((c) => c.url.includes('/run-keys'))).toBe(false);
    const [record] = await recordsOf(item.id);
    expect(record).toMatchObject({
      outcome: 'decided',
      verdict: 'pass',
      gateId: review!.id,
      submittedById: mate.user.id,
      authority: 'review_agent',
      harness: 'Codex',
      model: 'gpt-5.5',
      subjectVersion: setVersion(A),
    });

    // Approve-and-merge is asked at the SAME version, and the verdict never decides it.
    const approvals = await gatesOf(item.id, PR_APPROVAL);
    expect(approvals.map((g) => [g.state, g.subjectVersion])).toEqual([
      ['awaiting', setVersion(A)],
    ]);
    expect((await itemRow(item.id)).status).toBe('in_review');

    // The read model reads Reviewed by the teammate's own agent, at both commits.
    const state = await stateOf(s, item.id);
    expect(state?.reviewed).toMatchObject({
      reviewer: { kind: 'own', person: { id: mate.user.id }, harness: 'Codex', model: 'gpt-5.5' },
      commits: [
        { repo: 'moooon/acme', number: PERSON_PR, headSha: 'sha-a' },
        { repo: 'moooon/acme', number: BOT_PR, headSha: 'sha-a' },
      ],
    });
    expect(state?.reviewLine?.value).toBe('reviewed_by_agent');
    expect(state?.marker).toBeNull();

    // The bot posts the pass as a COMMENT on each pull request — never an Approve.
    expect(await reviewBotPostService.postVerdict(postRequest())).toEqual({
      outcome: 'posted',
      posted: 2,
      dismissed: 0,
    });
    expect(
      reviewCalls()
        .map((c) => [prNumberOf(c), c.body!.event])
        .sort(),
    ).toEqual([
      [PERSON_PR, 'COMMENT'],
      [BOT_PR, 'COMMENT'],
    ]);
    expect(calls.some((c) => c.body?.event === 'APPROVE')).toBe(false);
  });

  it('source own: the same verdict through the API route, by the teammate’s PAT, decides the review', async () => {
    const { s, item, review } = await deliveredSet(A, { gate: true, source: 'own' });
    const mate = await teammate(s, 'mate', 'member');
    const pat = await patFor(s, mate.user);
    const res = await postVerdictRoute(pat.headers, item.identifier, {
      verdict: 'approved',
      subjectVersion: setVersion(A),
      checklist: [{ criterion: 'The report exports', status: 'met', evidence: 'the test' }],
      harness: 'Claude Code',
      model: MODEL,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'decided', gateId: review!.id });
    expect((await recordsOf(item.id))[0]).toMatchObject({
      submittedById: mate.user.id,
      outcome: 'decided',
    });
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
    expect(await runRows(s.workspace.id)).toEqual([]);
  });

  it('source hosted: the door decides the review and cancels the in-flight run, whose credential then answers nothing; a live hosted run still decides through its own route', async () => {
    const { s, item, review, request } = await deliveredSet(A, { gate: true });
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');
    const [run] = await runRows(s.workspace.id);
    expect(run!.status).toBe('running');
    // The run's credential, minted while it runs — as the hosted container holds it.
    const token = await runToken(s, run!.id);
    expect((await stateOf(s, item.id))?.marker).toEqual({ kind: 'agent_reviewing' });

    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(setVersion(A)),
      s.ctx,
    );
    expect(dto.outcome).toBe('decided');
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'cancelled',
    );
    expect((await stateOf(s, item.id))?.marker).toBeNull();

    // The cancelled run's credential is dead: its late verdict is refused, and stores nothing.
    const late = await hostedSubmit(
      s,
      item.identifier,
      { subjectVersion: setVersion(A), verdict: 'pass', summaryMd: 'Fine.' },
      token,
    );
    expect(late.status).toBe(401);
    expect((await recordsOf(item.id)).map((r) => [r.outcome, r.gateId])).toEqual([
      ['decided', review!.id],
    ]);

    // The run-token route still answers as before for a hosted run that is live.
    const other = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Another card' },
      s.ctx,
    );
    await workItemsService.updateStatus(other.id, 'in_progress', s.ctx);
    sent.length = 0;
    await openPr(A, other.identifier, 211);
    await ci(A, 'sha-a', 211);
    const [next] = reviewRequests();
    expect((await agentReviewStartService.startRequested(next!)).outcome).toBe('started');
    const live = (await runRows(s.workspace.id)).find((r) => r.status === 'running')!;
    const res = await hostedSubmit(
      s,
      other.identifier,
      { subjectVersion: 'moooon/acme#211@sha-a', verdict: 'pass', summaryMd: 'Fine.' },
      await runToken(s, live.id),
    );
    expect(res.status).toBe(200);
    expect((await recordsOf(other.id)).map((r) => [r.outcome, r.harness])).toEqual([
      ['decided', 'Motir hosted review'],
    ]);
  });
});

// ── Gate off, late, second, concurrent ────────────────────────────────────────

describe('the verdict door — gate off, late, second and concurrent', () => {
  it('gate off: approved is the record and moves nothing; a late and a second verdict decide nothing and post nothing', async () => {
    const { s, item, approval } = await deliveredSet(A, { gate: false });
    sent.length = 0;
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(setVersion(A)),
      s.ctx,
    );
    expect(dto).toMatchObject({ outcome: 'recorded', gateId: null, withdrewApprovalGateIds: [] });
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approval!.id } })).state,
    ).toBe('awaiting');
    const status = (await itemRow(item.id)).status;
    expect((await stateOf(s, item.id))?.reviewLine?.value).toBe('reviewed_by_agent');
    expect(eventsNamed('review-bot/post.requested')).toHaveLength(1);

    const late = await reviewVerdictService
      .submit(s.project.id, item.identifier, sendBack(setVersion(A, 'sha-old')), s.ctx)
      .catch((err: unknown) => err);
    expect(late).toBeInstanceOf(ReviewVerdictLateError);
    const second = await reviewVerdictService
      .submit(s.project.id, item.identifier, sendBack(setVersion(A)), s.ctx)
      .catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ReviewVerdictSecondError);

    expect((await recordsOf(item.id)).map((r) => r.outcome)).toEqual([
      'recorded',
      'late',
      'second',
    ]);
    // Neither decided, superseded, moved or posted anything.
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approval!.id } })).state,
    ).toBe('awaiting');
    expect((await itemRow(item.id)).status).toBe(status);
    expect((await itemRow(item.id)).fixReason).toBeNull();
    expect(eventsNamed('review-bot/post.requested')).toHaveLength(1);
    expect((await stateOf(s, item.id))?.sentBack).toBe(false);

    // The route answers a late verdict with its typed 409.
    const pat = await patFor(s);
    const res = await postVerdictRoute(pat.headers, item.identifier, {
      verdict: 'approved',
      subjectVersion: setVersion(A, 'sha-old'),
      harness: 'Codex',
      model: 'gpt-x',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('REVIEW_VERDICT_LATE');
  });

  it('two concurrent verdicts at one version leave exactly one answering row', async () => {
    const { s, item } = await deliveredSet(A, { gate: false });
    const settled = await Promise.allSettled([
      reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), s.ctx),
      reviewVerdictService.submit(s.project.id, item.identifier, sendBack(setVersion(A)), s.ctx),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const outcomes = (await recordsOf(item.id)).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['recorded', 'second']);
  });

  it('a gate-on review with a concurrent pair is decided once', async () => {
    const { s, item, review } = await deliveredSet(A, { gate: true, source: 'own' });
    await Promise.allSettled([
      reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), s.ctx),
      reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), s.ctx),
    ]);
    const records = await recordsOf(item.id);
    expect(records.map((r) => r.outcome).sort()).toEqual(['decided', 'second']);
    expect(records.every((r) => r.gateId === review!.id)).toBe(true);
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
  });
});

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('the verdict door — refusals store nothing', () => {
  it('a viewer, a run token on the route, a card that is not a run target, empty findings and another workspace', async () => {
    const { s, item, request } = await deliveredSet(A, { gate: true });

    const viewer = await teammate(s, 'viewer', 'viewer');
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), viewer.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');
    const [run] = await runRows(s.workspace.id);
    const res = await postVerdictRoute(bearer(await runToken(s, run!.id)), item.identifier, {
      verdict: 'approved',
      subjectVersion: setVersion(A),
      harness: 'Codex',
      model: 'gpt-x',
    });
    expect(res.status).toBe(403);

    const empty = await reviewVerdictService
      .submit(s.project.id, item.identifier, sendBack(setVersion(A), { findingsMd: ' ' }), s.ctx)
      .catch((err: unknown) => err);
    expect(empty).toBeInstanceOf(ReviewVerdictInvalidError);
    expect((empty as InstanceType<typeof ReviewVerdictInvalidError>).field).toBe('findingsMd');

    // A card tested through its story is not a run target: the refusal names the story.
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
    await adminDb.testInstructions.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: story.id,
        bodyMd: '## Open the page',
      },
    });
    const notTarget = await reviewVerdictService
      .submit(s.project.id, child.identifier, input('moooon/acme#1@z'), s.ctx)
      .catch((err: unknown) => err);
    expect(notTarget).toBeInstanceOf(ReviewTargetNotRunTargetError);
    expect((notTarget as Error).message).toContain(story.identifier);

    const other = await makeScenario(B);
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), other.ctx),
    ).rejects.toThrow();

    expect(await recordsOf(item.id)).toEqual([]);
    expect(await recordsOf(child.id)).toEqual([]);
    expect((await awaitingOf(item.id, REVIEW)).length).toBe(1);
  });
});

// ── Send-back, Dismiss, the bot and the sync on one card ──────────────────────

describe('send-back, Dismiss and Motir’s bot on one card', () => {
  it('a gate-on send-back puts the card To fix and raises no approve-and-merge while it stands', async () => {
    const { s, item, review } = await deliveredSet(A, { gate: true, source: 'own' });
    const status = (await itemRow(item.id)).status;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(setVersion(A)),
      s.ctx,
    );
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review!.id } })).state,
    ).toBe('changes_requested');
    expect(await itemRow(item.id)).toMatchObject({ status, fixReason: 'changes_requested' });
    expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);
    // A CI redelivery at the same head does not ask again while the send-back stands.
    await ci(A, 'sha-a', PERSON_PR);
    expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);
    expect((await stateOf(s, item.id))?.sentBack).toBe(true);
  });

  it('gate off: send-back withdraws approve-and-merge, the bot posts per PR, the sync ignores the bot, and Dismiss brings approval back at the same version', async () => {
    const { s, item, approval } = await deliveredSet(A, { gate: false });
    const status = (await itemRow(item.id)).status;
    sent.length = 0;

    // ── The send-back: To fix, approve-and-merge withdrawn, no status move.
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(setVersion(A)),
      s.ctx,
    );
    expect(dto.withdrewApprovalGateIds).toEqual([approval!.id]);
    const withdrawn = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approval!.id } });
    expect(withdrawn).toMatchObject({
      state: 'superseded',
      supersededCause: 'agent_changes_requested',
    });
    expect(await itemRow(item.id)).toMatchObject({ status, fixReason: 'changes_requested' });
    const queue = await approvalGatesService.listAwaitingMe(homeCtx(s));
    expect(queue.items.map((row) => row.gateId)).not.toContain(approval!.id);
    await ci(A, 'sha-a', BOT_PR);
    expect(await awaitingOf(item.id, PR_APPROVAL), 'not re-raised at this version').toEqual([]);

    // ── The bot: Request changes on the person's PR, a comment on the App's own.
    const request = postRequest();
    expect(await reviewBotPostService.postVerdict(request)).toEqual({
      outcome: 'posted',
      posted: 2,
      dismissed: 0,
    });
    const attempts = reviewCalls().map((c) => [prNumberOf(c), c.body!.event]);
    expect(attempts).toEqual(
      expect.arrayContaining([
        [PERSON_PR, 'REQUEST_CHANGES'],
        [BOT_PR, 'REQUEST_CHANGES'],
        [BOT_PR, 'COMMENT'],
      ]),
    );
    expect(attempts).toHaveLength(3);
    expect(calls.some((c) => c.body?.event === 'APPROVE')).toBe(false);
    // Minted as the repository's App; no person's token is ever sent.
    expect(calls.some((c) => /\/app\/installations\/[^/]+\/access_tokens$/.test(c.url))).toBe(true);
    const body = String(reviewCalls()[0]!.body!.body);
    expect(body).toContain('**Motir agent review: changes requested**');
    expect(body).toContain('drops the header row');
    expect(body).toContain('0 met · 1 not met · 0 cannot tell (of 1)');
    expect(body).toContain(`[${item.identifier}](https://app.test/items/${item.identifier})`);
    let posts = await postsOf(item.id);
    expect(posts.map((p) => [p.pullRequest.number, p.kind, p.state]).sort()).toEqual([
      [PERSON_PR, 'request_changes', 'posted'],
      [BOT_PR, 'comment', 'posted'],
    ]);
    // A repeat of the job posts nothing more.
    calls = [];
    expect(await reviewBotPostService.postVerdict(request)).toMatchObject({ posted: 0 });
    expect(reviewCalls()).toEqual([]);
    expect(await postsOf(item.id)).toHaveLength(2);
    const rc = posts.find((p) => p.kind === 'request_changes')!;

    // ── The review sync ignores both App bots, and the dismissal of a bot review.
    for (const login of ['motir-studio[bot]', 'Motir-Integration[bot]']) {
      for (const action of ['submitted', 'dismissed']) {
        const result = await githubWebhookService.handleEvent(
          'pull_request_review',
          reviewDelivery(A, {
            number: PERSON_PR,
            sha: 'sha-a',
            state: 'changes_requested',
            user: { login, id: 9090, type: 'Bot' },
            action,
            reviewId: Number(rc.githubReviewId),
          }),
        );
        expect(result).toEqual({ event: 'pull_request_review', outcome: 'ignored_bot' });
      }
    }
    expect(await adminDb.githubPullRequestReview.findMany({})).toEqual([]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');

    // ── Dismiss: every wrong attempt is refused and writes nothing.
    const mate = await teammate(s, 'mate', 'member');
    const refusals = await Promise.all([
      reviewDismissalService
        .dismiss(
          s.project.id,
          item.identifier,
          { subjectVersion: setVersion(A), reasonMd: 'Not mine to dismiss.' },
          mate.ctx,
        )
        .catch((err: unknown) => err),
      reviewDismissalService
        .dismiss(
          s.project.id,
          item.identifier,
          { subjectVersion: setVersion(A), reasonMd: ' ' },
          s.ctx,
        )
        .catch((err: unknown) => err),
      reviewDismissalService
        .dismiss(
          s.project.id,
          item.identifier,
          { subjectVersion: setVersion(A, 'sha-old'), reasonMd: 'Stale.' },
          s.ctx,
        )
        .catch((err: unknown) => err),
    ]);
    expect(refusals[0]).toBeInstanceOf(ReviewDismissalForbiddenError);
    expect(refusals[1]).toBeInstanceOf(ReviewDismissalReasonRequiredError);
    expect(refusals[2]).toBeInstanceOf(ReviewDismissalStaleError);
    expect(await adminDb.reviewDismissal.findMany({})).toEqual([]);

    // ── The routed person's Dismiss.
    sent.length = 0;
    await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      { subjectVersion: setVersion(A), reasonMd: 'The header row is out of scope here.' },
      s.ctx,
    );
    const dismissals = await adminDb.reviewDismissal.findMany({ where: { workItemId: item.id } });
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]).toMatchObject({
      reviewVerdictRecordId: dto.recordId,
      subjectVersion: setVersion(A),
      dismissedById: s.user.id,
    });
    const sendBackRecord = await adminDb.reviewVerdictRecord.findUniqueOrThrow({
      where: { id: dto.recordId },
    });
    expect(sendBackRecord).toMatchObject({ outcome: 'recorded', verdict: 'changes_requested' });
    expect(await itemRow(item.id)).toMatchObject({ status, fixReason: null });
    const back = await awaitingOf(item.id, PR_APPROVAL);
    expect(back.map((g) => g.subjectVersion)).toEqual([setVersion(A)]);
    const queueAgain = await approvalGatesService.listAwaitingMe(homeCtx(s));
    expect(queueAgain.items.map((row) => row.gateId)).toContain(back[0]!.id);
    const state = await stateOf(s, item.id);
    expect(state?.sentBack).toBe(false);
    expect(state?.reviewLine).toMatchObject({
      value: 'review_dismissed',
      actor: { id: s.user.id, name: 'Owner A' },
      reason: 'The header row is out of scope here.',
    });
    const dismissedEvents = eventsNamed('review/dismissed');
    expect(dismissedEvents).toHaveLength(1);

    // A second Dismiss is refused and writes nothing.
    await expect(
      reviewDismissalService.dismiss(
        s.project.id,
        item.identifier,
        { subjectVersion: setVersion(A), reasonMd: 'Again.' },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewSendBackAlreadyDismissedError);
    expect(await adminDb.reviewDismissal.findMany({})).toHaveLength(1);

    // ── The Dismiss reaches the bot: its Request changes is retired, once.
    calls = [];
    const out = await reviewBotReconcileOnDismissal.handler(
      {
        event: { name: 'review/dismissed', data: dismissedEvents[0] },
        step: {} as never,
        runId: 'r',
        attempt: 0,
      },
      { reviewBotPost: reviewBotPostService } as never,
    );
    expect(out).toEqual({ dismissed: 1 });
    expect(dismissCalls().map(prNumberOf)).toEqual([PERSON_PR]);
    expect(String(dismissCalls()[0]!.body!.message)).toContain(
      `https://app.test/items/${item.identifier}`,
    );
    expect(
      await reviewBotPostService.reconcile({ workspaceId: s.workspace.id, workItemId: item.id }),
    ).toBe(0);
    expect(dismissCalls()).toHaveLength(1);
    posts = await postsOf(item.id);
    expect(posts.find((p) => p.id === rc.id)!.state).toBe('dismissed');

    // ── A person approves both pull requests on GitHub: the gate is decided and both merge.
    const merge = stubMerge();
    expect(await humanApproves(A, PERSON_PR, 'sha-a')).toMatchObject({ outcome: 'pending' });
    expect(await humanApproves(A, BOT_PR, 'sha-a')).toMatchObject({ outcome: 'decided_approved' });
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: back[0]!.id } })).state,
    ).toBe('approved');
    expect(merge.mock.calls.map(([args]) => args.number).sort()).toEqual([PERSON_PR, BOT_PR]);
  });

  it('a pass at the next head retires the bot’s Request changes, a second reconcile does nothing, and the merge after it goes through', async () => {
    const { s, item } = await deliveredSet(A, { gate: false });
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(setVersion(A)),
      s.ctx,
    );
    await reviewBotPostService.postVerdict(postRequest());
    const rc = (await postsOf(item.id)).find((p) => p.kind === 'request_changes')!;

    await moveHead(s, item.identifier, 'sha-b');
    expect((await stateOf(s, item.id))?.sentBack, 'a send-back belongs to its version').toBe(false);
    sent.length = 0;
    calls = [];
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(setVersion(A, 'sha-b')),
      s.ctx,
    );
    expect(await reviewBotPostService.postVerdict(postRequest())).toEqual({
      outcome: 'posted',
      posted: 2,
      dismissed: 1,
    });
    expect(dismissCalls().map((c) => c.url)).toEqual([
      `https://api.github.com/repos/moooon/acme/pulls/${PERSON_PR}/reviews/${rc.githubReviewId}/dismissals`,
    ]);
    expect(dismissCalls()[0]!.body).toEqual({
      event: 'DISMISS',
      message: `A later Motir agent review passed ${item.identifier}: https://app.test/items/${item.identifier}`,
    });
    for (let i = 0; i < 2; i += 1) {
      expect(
        await reviewBotPostService.reconcile({ workspaceId: s.workspace.id, workItemId: item.id }),
      ).toBe(0);
    }
    expect(dismissCalls()).toHaveLength(1);
    expect((await stateOf(s, item.id))?.reviewed?.commits.map((c) => c.headSha)).toEqual([
      'sha-b',
      'sha-b',
    ]);

    // Motir's own merge after the pass is not refused by the bot's earlier review.
    const merge = stubMerge();
    await humanApproves(A, PERSON_PR, 'sha-b');
    expect(await humanApproves(A, BOT_PR, 'sha-b')).toMatchObject({ outcome: 'decided_approved' });
    expect(merge).toHaveBeenCalledTimes(2);
    expect((await itemRow(item.id)).status).not.toBe('implemented');
  });

  it('turning the posting switch off retires the bot’s Request changes once', async () => {
    const { s, item } = await deliveredSet(A, { gate: false });
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(setVersion(A)),
      s.ctx,
    );
    await reviewBotPostService.postVerdict(postRequest());
    sent.length = 0;
    calls = [];
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewBotPostsEnabled: false },
      s.ctx,
    );
    const [event] = eventsNamed('review-bot/reconcile.requested');
    expect(event).toEqual({ workspaceId: s.workspace.id, workItemId: item.id });
    const run = () =>
      reviewBotReconcile.handler(
        {
          event: { name: 'review-bot/reconcile.requested', data: event },
          step: {} as never,
          runId: 'r',
          attempt: 0,
        },
        { reviewBotPost: reviewBotPostService } as never,
      );
    expect(await run()).toEqual({ dismissed: 1 });
    expect(await run()).toEqual({ dismissed: 0 });
    expect(dismissCalls().map(prNumberOf)).toEqual([PERSON_PR]);
    // The send-back itself stands: only the bot's post was retired.
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });
});

// ── The review state across a head move, Done and the markers ─────────────────

describe('the review state read model over the assembled path', () => {
  it('Reviewed after a pass, gone after a head move (not reviewed, with the last version), gone on Done', async () => {
    const { s, item } = await deliveredSet(A, { gate: true, source: 'own' });
    await reviewVerdictService.submit(s.project.id, item.identifier, input(setVersion(A)), s.ctx);
    const passed = await stateOf(s, item.id);
    expect(passed?.reviewed?.reviewer).toMatchObject({ kind: 'own', harness: 'Claude Code' });
    expect(passed?.currentVersion).toBe(setVersion(A));

    await moveHead(s, item.identifier, 'sha-b');
    const moved = await stateOf(s, item.id);
    expect(moved?.currentVersion).toBe(setVersion(A, 'sha-b'));
    expect(moved?.reviewed).toBeNull();
    expect(moved?.reviewLine).toMatchObject({
      value: 'not_reviewed',
      lastReviewedVersion: setVersion(A),
      command: `motir review ${item.identifier}`,
    });
    // The head move raised a new review: Waiting for your review agent, at the new version.
    const fresh = await awaitingOf(item.id, REVIEW);
    expect(fresh.map((g) => g.subjectVersion)).toEqual([setVersion(A, 'sha-b')]);
    expect(moved?.marker).toMatchObject({ kind: 'waiting_for_own_agent', forViewer: true });

    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(setVersion(A, 'sha-b')),
      s.ctx,
    );
    expect((await stateOf(s, item.id))?.reviewed).not.toBeNull();
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    expect((await stateOf(s, item.id))?.reviewed).toBeNull();
  });

  it('markers from the matching rows: Agent reviewing and Review could not run (hosted), none with the agent off', async () => {
    const { s, item, review, request } = await deliveredSet(A, { gate: true });
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');
    expect((await stateOf(s, item.id))?.marker).toEqual({ kind: 'agent_reviewing' });
    await adminDb.approvalGate.update({
      where: { id: review!.id },
      data: { reviewUnavailableReason: 'review_no_credits' },
    });
    expect((await stateOf(s, item.id))?.marker).toMatchObject({
      kind: 'could_not_run',
      reason: 'review_no_credits',
      routedTo: { id: s.user.id },
    });
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    expect((await stateOf(s, item.id))?.marker).toBeNull();
  });
});

// ── A review to run, notified once, and the author-of-every-PR fact ───────────

describe('a review to run on To approve, and the author fact', () => {
  it('is listed apart from approvals, notified once across three reads, and once again for the next head’s gate', async () => {
    const { s, item, review, request } = await deliveredSet(A, { gate: true, source: 'own' });
    // The raise job's own-source branch is what notifies.
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('skipped');
    for (let i = 0; i < 3; i += 1) {
      const rows = await approvalGatesService.listReviewsToRun(homeCtx(s));
      expect(rows.map((r) => [r.kind, r.gateId])).toEqual([['review_to_run', review!.id]]);
    }
    const queue = await approvalGatesService.listAwaitingMe(homeCtx(s));
    expect(queue.items.map((row) => row.gateId)).not.toContain(review!.id);
    expect(await agentReviewStartService.startRequested(request!)).toMatchObject({
      outcome: 'skipped',
    });
    const once = await reviewToRunRows(s.user.id);
    expect(once.map((n) => n.dedupeKey)).toEqual([`review_to_run:${review!.id}`]);

    sent.length = 0;
    await moveHead(s, item.identifier, 'sha-b');
    const next = reviewRequests().slice(-1)[0]!;
    expect(next.subjectVersion).toBe(setVersion(A, 'sha-b'));
    await agentReviewStartService.startRequested(next);
    await agentReviewStartService.startRequested(next);
    expect((await reviewToRunRows(s.user.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${review!.id}`,
      `review_to_run:${next.gateId}`,
    ]);
    expect((await approvalGatesService.listReviewsToRun(homeCtx(s))).map((r) => r.gateId)).toEqual([
      next.gateId,
    ]);
  });

  it('the author fact is false for the mixed set, true once every PR is the person’s, false for an empty set or an unknown login', async () => {
    const { s, item } = await deliveredSet(A, { gate: false });
    expect((await stateOf(s, item.id))?.authorOfEveryPr, 'mixed').toBe(false);

    // The App's pull request is re-reported as the person's.
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload(
        A,
        'reopened',
        BOT_PR,
        headRefOf(item.identifier, BOT_PR),
        'sha-a',
        personAuthor(A),
      ),
    );
    expect((await stateOf(s, item.id))?.authorOfEveryPr, 'all').toBe(true);

    await adminDb.githubIdentity.delete({ where: { userId: s.user.id } });
    expect((await stateOf(s, item.id))?.authorOfEveryPr, 'unknown login').toBe(false);

    const bare = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'No pull requests' },
      s.ctx,
    );
    expect((await stateOf(s, bare.id))?.authorOfEveryPr, 'empty set').toBe(false);
  });
});

// ── The source switch with a review awaiting ──────────────────────────────────

describe('the review source switch on an awaiting review', () => {
  it('hosted → own cancels the run and notifies once; own → hosted starts one run; the same source does nothing; Merge automatically is refused under both', async () => {
    const { s, item, review, request } = await deliveredSet(A, { gate: true });
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');
    const [run] = await runRows(s.workspace.id);

    sent.length = 0;
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'own' },
      s.ctx,
    );
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'cancelled',
    );
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review!.id } })).state,
    ).toBe('awaiting');
    expect(reviewRequests()).toEqual([]);
    expect((await reviewToRunRows(s.user.id)).map((n) => n.dedupeKey)).toEqual([
      `review_to_run:${review!.id}`,
    ]);
    expect((await stateOf(s, item.id))?.marker?.kind).toBe('waiting_for_own_agent');
    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.ctx),
    ).rejects.toBeInstanceOf(MergeModeReviewAgentOnError);

    // The same source again: nothing starts, nothing is cancelled, nobody is told twice.
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'own' },
      s.ctx,
    );
    expect(reviewRequests()).toEqual([]);
    expect(await reviewToRunRows(s.user.id)).toHaveLength(1);

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'hosted' },
      s.ctx,
    );
    const requests = reviewRequests();
    expect(requests.map((r) => r.gateId)).toEqual([review!.id]);
    expect((await agentReviewStartService.startRequested(requests[0]!)).outcome).toBe('started');
    expect((await runRows(s.workspace.id)).map((r) => r.status)).toEqual(['cancelled', 'running']);
    expect((await stateOf(s, item.id))?.marker).toEqual({ kind: 'agent_reviewing' });
    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.ctx),
    ).rejects.toBeInstanceOf(MergeModeReviewAgentOnError);

    // With the agent off and Merge automatically on, turning the agent back on is refused.
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    await projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.ctx);
    for (const source of ['hosted', 'own'] as const) {
      await expect(
        approvalGateSettingsService.updateSettings(
          s.project.id,
          { reviewAgentEnabled: true, reviewAgentSource: source },
          s.ctx,
        ),
      ).rejects.toBeInstanceOf(ReviewAgentNeedsManualMergeError);
    }
  });
});

// ── The hosted review prompt ───────────────────────────────────────────────────

describe('the hosted review prompt over the run target’s tree', () => {
  const crit = (line: string) => `Intro.\n\n## Acceptance criteria\n\n- ${line}\n`;

  async function readPrompt(s: Scenario, key: string) {
    const [run] = (await runRows(s.workspace.id)).filter((r) => r.status === 'running');
    const token = await runToken(s, run!.id);
    const { GET } = await import('@/app/api/v1/work-items/[key]/review-prompt/route');
    const res = await GET(
      new Request(`https://app.test/api/v1/work-items/${key}/review-prompt`, {
        headers: bearer(token),
      }),
      { params: Promise.resolve({ key }) },
    );
    expect(res.status).toBe(200);
    return String(((await res.json()) as Record<string, unknown>)['prompt']);
  }

  it('lists every card’s criteria in tree order for a story; a single card keeps its own listing; both are byte-identical on a second read', async () => {
    const s = await makeScenario(A);
    const make = (
      kind: 'story' | 'task' | 'subtask',
      title: string,
      parentId?: string,
      withCriteria = true,
    ) =>
      workItemsService.createWorkItem(
        {
          projectId: s.project.id,
          kind,
          title,
          descriptionMd: withCriteria ? crit(`${title} holds.`) : 'No criteria here.',
          parentId,
        },
        s.ctx,
      );
    const story = await make('story', 'The story');
    const first = await make('task', 'First child', story.id);
    const second = await make('task', 'Second child', story.id, false);
    const grandchild = await make('subtask', 'Grandchild', first.id);
    for (const child of [grandchild, first, second]) {
      await workItemsService.updateStatus(child.id, 'in_progress', s.ctx);
      await workItemsService.updateStatus(child.id, 'done', s.ctx);
    }
    await workItemsService.updateStatus(story.id, 'in_progress', s.ctx);
    sent.length = 0;
    await openPr(A, story.identifier, PERSON_PR);
    await ci(A, 'sha-a', PERSON_PR);
    const [request] = reviewRequests();
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');

    const prompt = await readPrompt(s, story.identifier);
    expect(prompt).toContain('CRITERIA CHECKLIST — this card and every card under it');
    const heads = [
      `  ${story.identifier} — The story (the run target)`,
      `  ${first.identifier} — First child (done — its criteria still count)`,
      `  ${second.identifier} — Second child (done — its criteria still count)`,
      `  ${grandchild.identifier} — Grandchild (done — its criteria still count)`,
    ];
    // Breadth-first: each level by its parent's order, then by position.
    const at = heads.map((head) => prompt.indexOf(head));
    expect(
      at.every((i) => i >= 0),
      JSON.stringify(at),
    ).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(prompt).toContain('    - Grandchild holds.');
    expect(prompt).toContain('    (This card names no acceptance criteria.');
    expect(prompt).toContain('One verdict per review.');
    expect(prompt).toContain(`ONE verdict, for ${story.identifier} — the run target — only.`);
    expect(await readPrompt(s, story.identifier)).toBe(prompt);

    // A single card with no descendants: the ACCEPTANCE CRITERIA listing, as before.
    await adminDb.dispatchRun.updateMany({
      where: { workspaceId: s.workspace.id },
      data: { status: 'cancelled' },
    });
    const single = await make('task', 'A lone card');
    await workItemsService.updateStatus(single.id, 'in_progress', s.ctx);
    sent.length = 0;
    await openPr(A, single.identifier, BOT_PR);
    await ci(A, 'sha-a', BOT_PR);
    const [lone] = reviewRequests();
    expect((await agentReviewStartService.startRequested(lone!)).outcome).toBe('started');
    const own = await readPrompt(s, single.identifier);
    expect(own).toContain('ACCEPTANCE CRITERIA');
    expect(own).toContain('  - A lone card holds.');
    expect(own).not.toContain('CRITERIA CHECKLIST');
    expect(await readPrompt(s, single.identifier)).toBe(own);
  });
});

// ── The PR → cards lookup ──────────────────────────────────────────────────────

describe('find_work_items_for_pull_request over the delivered set', () => {
  const structured = (res: { structuredContent?: unknown }) =>
    res.structuredContent as Record<string, unknown>;
  const urlOf = (repo: string, n: number) => `https://github.com/moooon/${repo}/pull/${n}`;

  it('answers both cards a PR delivers, not_linked for a known PR with no card and an unknown PR, and refuses the rest', async () => {
    const { s, item } = await deliveredSet(A, { gate: false });
    const sibling = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Rides the same PR' },
      s.ctx,
    );
    await linkPrByIdentifier({
      identifier: sibling.identifier,
      owner: 'moooon',
      name: 'acme',
      number: PERSON_PR,
      headRef: headRefOf(item.identifier, PERSON_PR),
    });

    const both = await runFindWorkItemsForPullRequest({ url: urlOf('acme', PERSON_PR) }, s.ctx);
    expect(both.isError).toBeFalsy();
    expect(structured(both)).toMatchObject({ outcome: 'linked' });
    expect(
      (structured(both)['workItems'] as Array<Record<string, unknown>>).map((w) => [
        w['key'],
        w['title'],
        w['kind'],
        typeof w['status'],
        w['projectKey'],
      ]),
    ).toEqual([
      [item.identifier, 'Export the report', 'task', 'string', 'ACME'],
      [sibling.identifier, 'Rides the same PR', 'task', 'string', 'ACME'],
    ]);

    // A pull request GitHub told us about that delivers no card.
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload(A, 'opened', 299, 'feature/x', 'sha-x', personAuthor(A)),
    );
    const known = await runFindWorkItemsForPullRequest({ url: urlOf('acme', 299) }, s.ctx);
    const unknown = await runFindWorkItemsForPullRequest({ url: urlOf('acme', 9999) }, s.ctx);
    expect(known.isError).toBeFalsy();
    expect(unknown.isError).toBeFalsy();
    expect(structured(known)).toMatchObject({ outcome: 'not_linked' });
    expect(structured(unknown)).toMatchObject({
      outcome: 'not_linked',
      reason: 'pull_request_unknown',
    });
    expect(structured(known)['reason']).not.toBe(structured(unknown)['reason']);

    for (const url of ['not a url', 'https://gitlab.com/moooon/acme/-/merge_requests/1']) {
      const bad = await runFindWorkItemsForPullRequest({ url }, s.ctx);
      expect(bad.isError, url).toBe(true);
    }

    const viewer = await teammate(s, 'viewer', 'viewer');
    const refused = await runFindWorkItemsForPullRequest(
      { url: urlOf('acme', PERSON_PR) },
      viewer.ctx,
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).not.toContain(item.identifier);
  });
});

// ── Tenant isolation across the whole flow ─────────────────────────────────────

describe('tenant isolation across the whole flow', () => {
  it('a second workspace running the same flow never sees, nor is touched by, the first', async () => {
    // Workspace B: its own card, send-back, post and Dismiss — the rows A must never reach.
    const b = await deliveredSet(B, { gate: false });
    sent.length = 0;
    const bBack = await reviewVerdictService.submit(
      b.s.project.id,
      b.item.identifier,
      sendBack(setVersion(B)),
      b.s.ctx,
    );
    await reviewBotPostService.postVerdict(postRequest());
    await reviewDismissalService.dismiss(
      b.s.project.id,
      b.item.identifier,
      { subjectVersion: setVersion(B), reasonMd: 'B’s own reason.' },
      b.s.ctx,
    );
    const bBefore = {
      records: await recordsOf(b.item.id),
      posts: await postsOf(b.item.id),
      dismissals: await adminDb.reviewDismissal.findMany({ where: { workItemId: b.item.id } }),
      gates: await adminDb.approvalGate.findMany({
        where: { workItemId: b.item.id },
        orderBy: { createdAt: 'asc' },
      }),
    };

    // Workspace A: the same flow on its card.
    const a = await deliveredSet(A, { gate: false });
    sent.length = 0;
    await reviewVerdictService.submit(
      a.s.project.id,
      a.item.identifier,
      sendBack(setVersion(A)),
      a.s.ctx,
    );
    await reviewBotPostService.postVerdict(postRequest());
    await reviewDismissalService.dismiss(
      a.s.project.id,
      a.item.identifier,
      { subjectVersion: setVersion(A), reasonMd: 'A’s reason.' },
      a.s.ctx,
    );

    // Every read of A's data, from B's context, answers nothing of A.
    const { withWorkspaceContext } = await import('@/lib/workspaces/context');
    const seenFromB = await withWorkspaceContext(b.s.ctx, async (tx) => ({
      records: await tx.reviewVerdictRecord.findMany({ where: { workItemId: a.item.id } }),
      dismissals: await tx.reviewDismissal.findMany({ where: { workItemId: a.item.id } }),
      posts: await tx.reviewBotPost.findMany({ where: { workItemId: a.item.id } }),
      gates: await tx.approvalGate.findMany({ where: { workItemId: a.item.id } }),
    }));
    expect(seenFromB).toEqual({ records: [], dismissals: [], posts: [], gates: [] });
    expect(await reviewStateService.forCards(a.s.project.id, [a.item.id], b.s.ctx)).toEqual(
      new Map(),
    );
    expect([
      ...(
        await reviewStateService.forCards(b.s.project.id, [b.item.id, a.item.id], b.s.ctx)
      ).keys(),
    ]).toEqual([b.item.id]);
    expect(await approvalGatesService.listReviewsToRun(homeCtx(a.s, b.s.ctx))).toEqual([]);
    const lookup = await runFindWorkItemsForPullRequest(
      { url: `https://github.com/moooon/acme/pull/${PERSON_PR}` },
      b.s.ctx,
    );
    expect(JSON.stringify(lookup)).not.toContain(a.item.identifier);

    // …and nothing A did changed B's rows.
    expect({
      records: await recordsOf(b.item.id),
      posts: await postsOf(b.item.id),
      dismissals: await adminDb.reviewDismissal.findMany({ where: { workItemId: b.item.id } }),
      gates: await adminDb.approvalGate.findMany({
        where: { workItemId: b.item.id },
        orderBy: { createdAt: 'asc' },
      }),
    }).toEqual(bBefore);
    expect(bBack.recordId).toBe(bBefore.records[0]!.id);
    // B's own read model still answers B's dismissal.
    expect((await stateOf(b.s, b.item.id))?.reviewLine).toMatchObject({
      value: 'review_dismissed',
      reason: 'B’s own reason.',
    });
  });
});
