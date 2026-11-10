import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW STATE READ MODEL (Story MOTIR-10327 · MOTIR-10340; `approval-gates.md` §12),
// against REAL Postgres — `reviewStateService.forCards` / `forCard`, the To approve review
// to run (`approvalGatesService.listReviewsToRun`) and its once-only notification. Every
// review, send-back, dismissal and skip is made through the real doors, the review is
// raised by the real webhook-driven green verdict, and motir-ai, the gateway and GitHub are
// stubbed at their HTTP seam, as `reviewDismissal.test.ts` stubs them.
//
// What a plausible wrong read model passes, pinned hardest:
//   - an answer earned at one head carrying over to the next;
//   - a container answered from its children (it reads the asked cards only);
//   - a second notification for the same gate on a retry;
//   - one query per card, and a card of another workspace answered.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { fakeOrchestrator } from '@motir/orchestrator';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { SubmitReviewVerdictInput } from '@/lib/dto/agentReview';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { linkPrByIdentifier } from '../helpers/prLink';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { bearer } from '../fixtures/apiV1Fixtures';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { reviewVerdictService } = await import('@/lib/services/reviewVerdictService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { reviewDismissalService } = await import('@/lib/services/reviewDismissalService');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const INSTALLATION_ID = 'inst-review-start';
const REPO_PROVIDER_ID = '6820';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REVIEW = 'agent_review' as const;

// ── The HTTP seam ─────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  /** The offered list. `default: null` names none; `status` ≠ 200 is motir-ai down. */
  models?: { status?: number; ids?: string[]; default?: string | null };
  mayRun?: boolean;
  /** `GET /repos/moooon/acme/installation`: its status, and its `contents` level. */
  installation?: { status?: number; contents?: string };
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
          default: s.models?.default === undefined ? (ids[0] ?? null) : s.models.default,
        });
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
      if (url.endsWith('/repos/moooon/acme/installation') && method === 'GET') {
        const status = s.installation?.status ?? 200;
        if (status !== 200) return json(status, {});
        return json(200, {
          id: 42,
          account: { login: 'moooon' },
          permissions: { contents: s.installation?.contents ?? 'write', pull_requests: 'write' },
          suspended_at: null,
          html_url: 'https://github.com/organizations/moooon/settings/installations/42',
        });
      }
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        return json(201, {
          token: 'ghs-review-token',
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

// ── The scenario: a card whose one pull request went green with the switch on ────────

async function makeScenario(slug: string) {
  const user = await usersService.createUser({
    email: `owner-${slug}@example.com`,
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
  // The project's repository — the one a review run of its cards reads.
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, repoId: REPO_PROVIDER_ID },
  });
  const repo = await adminDb.projectRepo.create({
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
  return { user, workspace, project, ctx, repo };
}

function pullRequestPayload(action: string, number: number, headRef: string, extra = {}) {
  return {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
      ...extra,
    },
  };
}

const ci = (headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

const gatesOf = (workItemId: string, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });

const reviewRequests = () =>
  sent
    .filter((e) => e.name === 'agent-review/requested')
    .map((e) => e.data as unknown as AgentReviewRequestedData);

const runRows = (workspaceId: string) =>
  adminDb.dispatchRun.findMany({ where: { workspaceId }, orderBy: { startedAt: 'asc' } });

/** A card delivered by pull request `number`, green at `sha-a`, holding its review. */
async function reviewing(slug: string, number: number) {
  const s = await makeScenario(slug);
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: `Card ${number}` },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
  await ci('sha-a', number);
  const review = (await gatesOf(item.id, REVIEW)).find((g) => g.state === 'awaiting');
  expect(review, 'the green verdict raised the review').toBeDefined();
  const [request] = reviewRequests();
  expect(request, 'the raise requested its review').toBeDefined();
  return { s, item, review: review!, request: request! };
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_APPROVAL = 'pull_request_approval' as const;

const versionOf = (number: number, sha = 'sha-a') => `moooon/acme#${number}@${sha}`;

const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');

const pushTo = (identifier: string, number: number, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('synchronize', number, `subtask/${identifier}-${number}`, {
      head: { ref: `subtask/${identifier}-${number}`, sha },
    }),
  );

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
      { key: null, criterion: 'The button exports', status: 'met', evidence: 'export.test.ts' },
    ],
    harness: 'Claude Code',
    model: 'claude-opus-5-5',
    ...over,
  };
}

const sendBack = (version: string, over: Partial<SubmitReviewVerdictInput> = {}) =>
  input(version, {
    verdict: 'changes_requested',
    findingsMd: '- `lib/export.ts:12` drops the header row — keep it.',
    ...over,
  });

/** A card delivered by pull request `number`, green at `sha-a`, with the review gate OFF. */
async function deliveredGateOff(slug: string, number: number) {
  const s = await makeScenario(slug);
  await adminDb.project.update({
    where: { id: s.project.id },
    data: { reviewAgentEnabled: false },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: `Card ${number}` },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
  await ci('sha-a', number);
  const approval = await awaitingOf(item.id, PR_APPROVAL);
  expect(approval, 'the green verdict asked to approve and merge').toHaveLength(1);
  expect(await awaitingOf(item.id, REVIEW)).toEqual([]);
  return { s, item, approval: approval[0]! };
}

/** A card holding an awaiting review under `source`, its hosted run started when hosted. */
async function reviewingUnder(source: 'hosted' | 'own', slug: string, number: number) {
  const scenario = await reviewing(slug, number);
  if (source === 'own') {
    await approvalGateSettingsService.updateSettings(
      scenario.s.project.id,
      { reviewAgentSource: 'own' },
      scenario.s.ctx,
    );
  } else {
    expect((await agentReviewStartService.startRequested(scenario.request)).outcome).toBe(
      'started',
    );
  }
  sent.length = 0;
  return scenario;
}

async function hostedSubmit(
  s: Awaited<ReturnType<typeof makeScenario>>,
  key: string,
  body: Record<string, unknown>,
) {
  const [run] = await runRows(s.workspace.id);
  const { runCredentialService } = await import('@/lib/services/runCredentialService');
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: run!.id,
    dispatcherUserId: s.user.id,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
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

/** Put `name` on the workspace with `role` on the project. */
async function teammate(
  s: Awaited<ReturnType<typeof makeScenario>>,
  name: string,
  role: 'member' | 'viewer',
) {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: s.workspace.id });
  await addToProjectAs({
    key: 'ACME',
    actorUserId: s.user.id,
    ctx: s.ctx,
    targetUserId: user.id,
    role,
  });
  return { userId: user.id, workspaceId: s.workspace.id };
}

// ── Review state helpers ──────────────────────────────────────────────────────

const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { reviewStateRepository } = await import('@/lib/repositories/reviewStateRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { reviewToRunService } = await import('@/lib/services/reviewToRunService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const stateOf = async (s: Scenario, workItemId: string, ctx = s.ctx) =>
  reviewStateService.forCard(s.project.id, workItemId, ctx);

const reviewToRunRows = (recipientUserId: string) =>
  adminDb.notification.findMany({
    where: { recipientUserId, type: 'review_to_run' },
    orderBy: { createdAt: 'asc' },
  });

const homeCtx = (s: Scenario) => ({ ...s.ctx, projectId: s.project.id });

/** A second pull request `number` on the card, opened by GitHub user `authorId`. */
async function secondPullRequest(item: { identifier: string }, number: number, authorId: number) {
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef, {
      head: { ref: headRef, sha: 'sha-a' },
      user: { id: authorId, login: `gh-${authorId}` },
    }),
  );
}

/** Link the owner's GitHub identity as GitHub user `githubUserId`. */
const linkIdentity = (userId: string, githubUserId: string) =>
  adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId,
      githubLogin: `gh-${githubUserId}`,
      accessTokenEncrypted: 'enc',
    },
  });

/** A gate-off child card of `parentId` delivered by its own green pull request `number`. */
async function deliveredChild(
  s: Scenario,
  parentId: string,
  number: number,
  kind: 'task' | 'subtask' = 'subtask',
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind, title: `Child ${number}`, parentId },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
  await ci('sha-a', number);
  return item;
}

// ── The marker, under each source ─────────────────────────────────────────────

describe('the review marker', () => {
  it('hosted: Agent reviewing while the run is in flight, Review could not run with a reason', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'mk-hosted', 81);
    expect((await stateOf(s, item.id))?.marker).toEqual({ kind: 'agent_reviewing' });
    expect((await stateOf(s, item.id))?.reviewToRun).toBeNull();

    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { reviewUnavailableReason: 'review_no_credits' },
    });
    expect((await stateOf(s, item.id))?.marker).toEqual({
      kind: 'could_not_run',
      reason: 'review_no_credits',
      routedTo: { id: s.user.id, name: 'Owner' },
      forViewer: true,
    });
  });

  it('own: Waiting for your review agent with the command, and a review to run', async () => {
    const { s, item, review } = await reviewingUnder('own', 'mk-own', 82);
    const state = await stateOf(s, item.id);
    expect(state?.marker).toEqual({
      kind: 'waiting_for_own_agent',
      routedTo: { id: s.user.id, name: 'Owner' },
      forViewer: true,
      command: `motir review ${item.identifier}`,
    });
    expect(state?.reviewToRun).toEqual({
      gateId: review.id,
      command: `motir review ${item.identifier}`,
    });
  });

  it('no marker with the review agent off or no awaiting review', async () => {
    const { s, item } = await reviewingUnder('own', 'mk-off', 83);
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    const state = await stateOf(s, item.id);
    expect(state?.marker).toBeNull();
    expect(state?.reviewToRun).toBeNull();

    // A card with no review gate at all — and no pull request — has no marker either.
    const bare = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Bare' },
      s.ctx,
    );
    expect((await stateOf(s, bare.id))?.marker).toBeNull();
    expect((await stateOf(s, bare.id))?.currentVersion).toBeNull();
    // A pull request linked before any delivery names no head: the version is unknown.
    await linkPrByIdentifier({
      identifier: bare.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 125,
      headRef: `subtask/${bare.identifier}-125`,
    });
    const unknown = await stateOf(s, bare.id);
    expect(unknown?.currentVersion).toBeNull();
    expect(unknown?.reviewLine).toBeNull();
  });
});

// ── Reviewed, before and after a head move, and on a Done card ─────────────────

describe('the Reviewed state', () => {
  it('names the own agent, the time and the commits; a head move and Done remove it', async () => {
    const { s, item } = await reviewingUnder('own', 'rv-own', 85);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(85)), s.ctx);

    const state = await stateOf(s, item.id);
    expect(state?.marker).toBeNull();
    expect(state?.reviewed).toMatchObject({
      reviewer: {
        kind: 'own',
        person: { id: s.user.id, name: 'Owner' },
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      commits: [{ repo: 'moooon/acme', number: 85, headSha: 'sha-a' }],
    });
    expect(state?.recordRef?.kind).toBe('record');
    expect(state?.reviewLine).toMatchObject({ value: 'reviewed_by_agent', githubApprovals: [] });

    await pushTo(item.identifier, 85, 'sha-b');
    const moved = await stateOf(s, item.id);
    expect(moved?.currentVersion).toBe(versionOf(85, 'sha-b'));
    expect(moved?.reviewed).toBeNull();
    expect(moved?.reviewLine).toMatchObject({
      value: 'not_reviewed',
      lastReviewedVersion: versionOf(85),
      command: `motir review ${item.identifier}`,
    });

    await pushTo(item.identifier, 85, 'sha-a');
    expect((await stateOf(s, item.id))?.reviewed).not.toBeNull();
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    expect((await stateOf(s, item.id))?.reviewed).toBeNull();
  });

  it('names Motir’s hosted agent for a hosted pass', async () => {
    const { s, item } = await reviewingUnder('hosted', 'rv-hosted', 86);
    const res = await hostedSubmit(s, item.identifier, {
      subjectVersion: versionOf(86),
      verdict: 'pass',
      summaryMd: 'Fine.',
    });
    expect(res.status).toBe(200);
    const state = await stateOf(s, item.id);
    expect(state?.reviewed?.reviewer).toEqual({ kind: 'hosted', model: MODEL });
    expect(state?.reviewLine?.value).toBe('reviewed_by_agent');
  });
});

// ── The review line ───────────────────────────────────────────────────────────

describe('the review line', () => {
  it('not reviewed by an agent, with the command and the GitHub approvals at the head', async () => {
    const { s, item } = await deliveredGateOff('ln-none', 87);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 87 } });
    const approval = (id: string, login: string, commitSha: string) =>
      adminDb.githubPullRequestReview.create({
        data: {
          githubReviewId: id,
          githubPullRequestId: pr.id,
          reviewerGithubUserId: id,
          reviewerLogin: login,
          reviewerType: 'User',
          state: 'approved',
          commitSha,
          reviewerPermission: 'write',
          submittedAt: new Date(),
        },
      });
    await approval('701', 'cy', 'sha-a');
    await approval('702', 'old-head', 'sha-0');
    const state = await stateOf(s, item.id);
    expect(state?.reviewLine).toMatchObject({
      value: 'not_reviewed',
      lastReviewedVersion: null,
      command: `motir review ${item.identifier}`,
      githubApprovals: [{ login: 'cy', repo: 'moooon/acme', number: 87 }],
    });
    expect(state?.reviewed).toBeNull();
  });

  it('review skipped by a person, with the reason', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'ln-skip', 88);
    await approvalGatesService.decide(
      {
        gateId: review.id,
        decision: 'approve',
        noteMd: 'I checked it myself.',
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect((await stateOf(s, item.id))?.reviewLine).toMatchObject({
      value: 'review_skipped',
      actor: { id: s.user.id, name: 'Owner' },
      reason: 'I checked it myself.',
    });
  });

  it('review dismissed by a person, only for the version it was dismissed at', async () => {
    const { s, item } = await deliveredGateOff('ln-dismiss', 89);
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(89)),
      s.ctx,
    );
    const sentBackState = await stateOf(s, item.id);
    expect(sentBackState?.sentBack).toBe(true);
    expect(sentBackState?.reviewLine?.value).toBe('not_reviewed');

    await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      { subjectVersion: versionOf(89), reasonMd: 'Out of scope.' },
      s.ctx,
    );
    const dismissed = await stateOf(s, item.id);
    expect(dismissed?.sentBack).toBe(false);
    expect(dismissed?.reviewLine).toMatchObject({
      value: 'review_dismissed',
      actor: { id: s.user.id, name: 'Owner' },
      reason: 'Out of scope.',
    });

    await pushTo(item.identifier, 89, 'sha-b');
    expect((await stateOf(s, item.id))?.reviewLine?.value).toBe('not_reviewed');
  });
});

// ── The author fact ───────────────────────────────────────────────────────────

describe('the author-of-every-PR fact', () => {
  it('all, some, none and unknown', async () => {
    const { s, item } = await deliveredGateOff('author', 90);
    // The delivery named no login, so the author is unknown — the fact is false.
    expect((await stateOf(s, item.id))?.authorOfEveryPr).toBe(false);

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('reopened', 90, `subtask/${item.identifier}-90`, {
        head: { ref: `subtask/${item.identifier}-90`, sha: 'sha-a' },
        user: { id: 4242, login: 'owner-gh' },
      }),
    );
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 90 } });
    expect(pr).toMatchObject({ authorGithubUserId: '4242', authorLogin: 'owner-gh' });
    // Known author, but the routed person linked no GitHub identity: unknown, false.
    expect((await stateOf(s, item.id))?.authorOfEveryPr).toBe(false);

    await linkIdentity(s.user.id, '4242');
    expect((await stateOf(s, item.id))?.authorOfEveryPr).toBe(true);

    await secondPullRequest(item, 91, 5151);
    expect((await stateOf(s, item.id))?.authorOfEveryPr, 'some').toBe(false);

    await adminDb.githubIdentity.update({
      where: { userId: s.user.id },
      data: { githubUserId: '9' },
    });
    expect((await stateOf(s, item.id))?.authorOfEveryPr, 'none').toBe(false);
  });
});

// ── A container ───────────────────────────────────────────────────────────────

// A container wears no review state of its own and the read never walks into its tree: the
// *n of m reviewed* count was dropped after it read every card under a page's epics and ran
// `/items` past its transaction limit.
describe('a container', () => {
  it('is answered from its own rows only — its reviewed children are never read', async () => {
    const s = await makeScenario('tree');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'A story' },
      s.ctx,
    );
    const a = await deliveredChild(s, story.id, 92, 'task');
    await reviewVerdictService.submit(s.project.id, a.identifier, input(versionOf(92)), s.ctx);

    const deliveries = vi.spyOn(reviewStateRepository, 'listDeliveries');
    const state = await stateOf(s, story.id);
    expect(state).toMatchObject({ currentVersion: null, marker: null, reviewed: null });
    expect(deliveries).toHaveBeenCalledWith([story.id], expect.anything());
    expect(await reviewStateService.cardReviewsFor(s.project.id, [story.id], s.ctx)).toEqual({});
    // The child itself still reads Reviewed.
    expect((await stateOf(s, a.id))?.reviewed).not.toBeNull();
  });
});

// ── A review to run on To approve, notified once ───────────────────────────────

describe('a review to run', () => {
  it('is listed on To approve apart from the approvals, and notified exactly once per gate', async () => {
    const { s, item, review, request } = await reviewingUnder('own', 'run', 95);

    const rows = await approvalGatesService.listReviewsToRun(homeCtx(s));
    expect(rows).toEqual([
      {
        kind: 'review_to_run',
        gateId: review.id,
        workItemId: item.id,
        identifier: item.identifier,
        title: item.title,
        subjectVersion: versionOf(95),
        raisedAt: review.createdAt.toISOString(),
        command: `motir review ${item.identifier}`,
      },
    ]);
    // It is not an approval: the approvals queue does not list it.
    const queue = await approvalGatesService.listAwaitingMe(homeCtx(s));
    expect(queue.items.map((row) => row.gateId)).not.toContain(review.id);

    // The switch to `own` notified the routed person once…
    const first = await reviewToRunRows(s.user.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      workItemId: item.id,
      dedupeKey: `review_to_run:${review.id}`,
      category: 'direct',
      actorId: null,
      data: {
        kind: 'review_to_run',
        issueKey: item.identifier,
        command: `motir review ${item.identifier}`,
      },
    });
    // …and a retried raise job, a second notify and a re-read notify nobody again.
    expect((await agentReviewStartService.startRequested(request)).outcome).toBe('skipped');
    expect(await reviewToRunService.notifyRaised(s.workspace.id, review.id)).toBe('notified');
    await approvalGatesService.listReviewsToRun(homeCtx(s));
    expect(await reviewToRunRows(s.user.id)).toHaveLength(1);

    // A head move raises a NEW gate at the new version, which notifies once for itself.
    sent.length = 0;
    await pushTo(item.identifier, 95, 'sha-b');
    await hostAnswersCleanAt(s.workspace.id, 95, 'sha-b');
    await ci('sha-b', 95);
    const [next] = reviewRequests();
    expect(next?.subjectVersion).toBe(versionOf(95, 'sha-b'));
    expect((await agentReviewStartService.startRequested(next!)).outcome).toBe('skipped');
    expect((await agentReviewStartService.startRequested(next!)).outcome).toBe('skipped');
    const all = await reviewToRunRows(s.user.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.dedupeKey).toBe(`review_to_run:${next!.gateId}`);
    expect((await approvalGatesService.listReviewsToRun(homeCtx(s))).map((r) => r.gateId)).toEqual([
      next!.gateId,
    ]);
  });

  it('is never listed or notified for the source hosted, nor for a gate that is not awaiting', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'run-hosted', 96);
    expect(await approvalGatesService.listReviewsToRun(homeCtx(s))).toEqual([]);
    expect(await reviewToRunService.notifyRaised(s.workspace.id, review.id)).toBe(
      'not_a_review_to_run',
    );
    expect(await reviewToRunRows(s.user.id)).toEqual([]);
    expect(await reviewToRunService.notifyRaised(s.workspace.id, 'no-such-gate')).toBe(
      'not_a_review_to_run',
    );
    expect(item).toBeDefined();
  });

  it('is aimed at the routed person only, and not listed for anybody else', async () => {
    const { s, item } = await reviewingUnder('own', 'run-other', 97);
    const mate = await teammate(s, 'Mate', 'member');
    expect(
      await approvalGatesService.listReviewsToRun({ ...mate, projectId: s.project.id }),
    ).toEqual([]);
    const theirs = await stateOf(s, item.id, mate);
    expect(theirs?.marker).toMatchObject({ kind: 'waiting_for_own_agent', forViewer: false });
    expect(theirs?.viewerIsRouted).toBe(false);
  });
});

// ── A page of cards, and tenancy ──────────────────────────────────────────────

describe('a page of cards', () => {
  it('is answered with one call of each batch read, whatever the page size', async () => {
    const s = await makeScenario('page');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'S' },
      s.ctx,
    );
    const kids = [
      await deliveredChild(s, story.id, 120),
      await deliveredChild(s, story.id, 121),
      await deliveredChild(s, story.id, 122),
    ];
    const spies = (
      [
        'listCards',
        'listDeliveries',
        'listAgentReviewGates',
        'listLatestDecidedGates',
        'listRecords',
        'listDismissals',
        'listGateIdsWithRunningReview',
        'listPeople',
      ] as const
    ).map((name) => vi.spyOn(reviewStateRepository, name));
    const page = await reviewStateService.forCards(
      s.project.id,
      [story.id, ...kids.map((k) => k.id)],
      s.ctx,
    );
    expect(page.size).toBe(4);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(await reviewStateService.forCards(s.project.id, [], s.ctx)).toEqual(new Map());
  });

  it('never answers a card of another workspace, or a project the reader cannot see', async () => {
    const { s, item } = await deliveredGateOff('tenant-a', 123);
    const other = await usersService.createUser({
      email: 'other-tenant@example.com',
      password: 'hunter2hunter2',
      name: 'Other',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: other.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: other.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const otherCtx = { userId: other.id, workspaceId: workspace.id };
    const foreign = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Theirs' },
      otherCtx,
    );

    const mine = await reviewStateService.forCards(s.project.id, [item.id, foreign.id], s.ctx);
    expect([...mine.keys()]).toEqual([item.id]);
    expect(await reviewStateService.forCards(project.id, [foreign.id], s.ctx)).toEqual(new Map());
    expect(await reviewStateService.forCards(s.project.id, [item.id], otherCtx)).toEqual(new Map());
    expect(await reviewStateService.forCard(s.project.id, foreign.id, s.ctx)).toBeNull();
    expect(await reviewStateService.forCards('no-such-project', [item.id], s.ctx)).toEqual(
      new Map(),
    );
    expect(await reviewStateService.forCard(project.id, foreign.id, otherCtx)).toMatchObject({
      workItemId: foreign.id,
      currentVersion: null,
      reviewLine: null,
      authorOfEveryPr: false,
    });
  });
});

// THE HEAD OF A PULL REQUEST WITH NO STORED HEAD — the check rows' head, computed in the
// database (the `/items` timeout): never the check rows themselves, which a whole project's
// tree read loaded by the hundred thousand.
describe('a pull request with no stored head', () => {
  it('reads its head from the check rows — the commit first seen last — without loading them', async () => {
    const { s, item } = await deliveredGateOff('headless', 131);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 131 } });
    const [row] = await adminDb.githubCheckRun.findMany({ where: { pullRequestId: pr.id } });
    expect(row, 'the green verdict stored a check row').toBeDefined();
    const { id: _id, ...base } = row!;
    // sha-b first seen after sha-a; a LATER row at sha-a (a re-run) does not make it the head.
    await adminDb.githubCheckRun.create({
      data: { ...base, commitSha: 'sha-b', createdAt: new Date(row!.createdAt.getTime() + 1000) },
    });
    await adminDb.githubCheckRun.create({
      data: {
        ...base,
        checkName: `${base.checkName}-rerun`,
        createdAt: new Date(row!.createdAt.getTime() + 2000),
      },
    });
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: null } });

    expect((await stateOf(s, item.id))?.currentVersion).toBe(versionOf(131, 'sha-b'));
    const deliveries = await withWorkspaceContext(s.ctx, (tx) =>
      reviewStateRepository.listDeliveries([item.id], tx),
    );
    expect(deliveries.map((d) => [d.pullRequest.headSha, d.pullRequest.checkRuns])).toEqual([
      ['sha-b', []],
    ]);

    // No stored head and no check rows: the version stays unknown.
    await adminDb.githubCheckRun.deleteMany({ where: { pullRequestId: pr.id } });
    expect((await stateOf(s, item.id))?.currentVersion).toBeNull();
  });
});

describe('access and the edges', () => {
  it('answers nothing on a project the reader may not browse', async () => {
    const { s, item } = await deliveredGateOff('private', 126);
    const outsider = await createTestUser({ name: 'Outsider' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.workspace.id });
    await adminDb.project.update({ where: { id: s.project.id }, data: { accessMode: 'members' } });
    const ctx = { userId: outsider.id, workspaceId: s.workspace.id };
    expect(await reviewStateService.forCards(s.project.id, [item.id], ctx)).toEqual(new Map());
    expect(
      await approvalGatesService.listReviewsToRun({ ...ctx, projectId: s.project.id }),
    ).toEqual([]);
  });

  it('writes no review-to-run row for a person who turned it off', async () => {
    const { s, review } = await reviewing('pref-off', 127);
    await adminDb.notificationPreference.create({
      data: { userId: s.user.id, eventType: 'review_to_run', channel: 'in_app', enabled: false },
    });
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'own' },
      s.ctx,
    );
    expect(await reviewToRunService.notifyRaised(s.workspace.id, review.id)).toBe('off');
    expect(await reviewToRunRows(s.user.id)).toEqual([]);
  });

  it('every batch read answers an empty set without a query', async () => {
    const tx = {} as never;
    expect(await reviewStateRepository.listCards([], tx)).toEqual([]);
    expect(await reviewStateRepository.listDeliveries([], tx)).toEqual([]);
    expect(await reviewStateRepository.listAgentReviewGates([], tx)).toEqual([]);
    expect(await reviewStateRepository.listLatestDecidedGates([], tx)).toEqual([]);
    expect(await reviewStateRepository.listRecords([], tx)).toEqual([]);
    expect(await reviewStateRepository.listDismissals([], tx)).toEqual([]);
    expect(await reviewStateRepository.listGateIdsWithRunningReview('w', [], tx)).toEqual(
      new Set(),
    );
    expect(await reviewStateRepository.listPeople([], tx)).toEqual([]);
  });
});

// THE SURFACES' READ (MOTIR-10341) — the board and the List / Tree read the model through
// `cardReviewsFor`: ONE batch over the page, a serializable map holding only the cards that
// draw something, and nothing of another workspace.
describe('the surfaces’ read — cardReviewsFor and the board', () => {
  it('answers only the cards that draw something, as plain data, in one batch', async () => {
    const { s, item } = await reviewingUnder('own', 'surf-own', 128);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(128)), s.ctx);
    const quiet = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Undelivered' },
      s.ctx,
    );
    const forCards = vi.spyOn(reviewStateService, 'forCards');
    const map = await reviewStateService.cardReviewsFor(s.project.id, [item.id, quiet.id], s.ctx);
    expect(forCards).toHaveBeenCalledTimes(1);
    expect(Object.keys(map)).toEqual([item.id]);
    expect(map[item.id]).toMatchObject({
      identifier: item.identifier,
      marker: null,
      reviewed: { commits: [{ repo: 'moooon/acme', number: 128, headSha: 'sha-a' }] },
      recordRef: { kind: 'record' },
    });
    // Crosses the server → client boundary unchanged.
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });

  it('the board carries each card its review with one batch, and none for a foreign reader', async () => {
    const { s, item } = await reviewingUnder('own', 'surf-board', 129);
    const second = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Second' },
      s.ctx,
    );
    const { boardsService } = await import('@/lib/services/boardsService');
    const batch = vi.spyOn(reviewStateService, 'cardReviewsFor');
    const board = await boardsService.getBoard(s.project.id, s.ctx);
    expect(batch).toHaveBeenCalledTimes(1);
    const cards = board.columns.flatMap((c) => c.cards);
    const mine = cards.find((c) => c.id === item.id);
    expect(mine?.review?.marker).toMatchObject({
      kind: 'waiting_for_own_agent',
      command: `motir review ${item.identifier}`,
    });
    const plain = cards.find((c) => c.id === second.id);
    expect(plain).toBeDefined();
    expect(plain?.review ?? null).toBeNull();

    const outsider = await createTestUser({ name: 'Elsewhere' });
    const elsewhere = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: outsider.id,
    });
    expect(
      await reviewStateService.cardReviewsFor(s.project.id, [item.id], {
        userId: outsider.id,
        workspaceId: elsewhere.workspace.id,
      }),
    ).toEqual({});
  });
});

// ── To approve and the gate frame (MOTIR-10342) ───────────────────────────────

describe('the review path on To approve and the gate frame', () => {
  it('the approvals queue carries each merge row its review line, and the badge once a pass stands', async () => {
    const { s, item, approval } = await deliveredGateOff('rows-line', 120);
    const before = await approvalGatesService.listAwaitingMe(homeCtx(s));
    const row = before.items.find((r) => r.gateId === approval.id);
    expect(row?.review).toMatchObject({
      line: { value: 'not_reviewed', command: `motir review ${item.identifier}` },
      recordRef: null,
      badge: null,
    });
    expect(before.reviewsToRun).toEqual([]);

    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(120)),
      s.ctx,
    );
    const after = await approvalGatesService.listAwaitingMe(homeCtx(s));
    const passed = after.items.find((r) => r.kind === 'pull_request_approval');
    expect(passed?.review?.line.value).toBe('reviewed_by_agent');
    expect(passed?.review?.recordRef).toEqual({ kind: 'record', id: dto.recordId });
    expect(passed?.review?.badge).toMatchObject({ identifier: item.identifier, marker: null });
    expect(passed?.review?.badge?.reviewed).not.toBeNull();

    // The room's awaiting list reads the same line.
    const room = await approvalGatesService.listRecords(homeCtx(s), { limit: 50 });
    const roomRow = room.sections.awaiting.items.find((r) => r.kind === 'pull_request_approval');
    expect(roomRow?.review?.line.value).toBe('reviewed_by_agent');
  });

  it('a review to run rides the queue beside the approvals, never as one', async () => {
    const { s, review } = await reviewingUnder('own', 'rows-run', 121);
    const queue = await approvalGatesService.listAwaitingMe(homeCtx(s));
    expect(queue.reviewsToRun?.map((r) => r.gateId)).toEqual([review.id]);
    expect(queue.items.map((r) => r.gateId)).not.toContain(review.id);
  });

  it('the frame reads the gate-off send-back record, the routed reader and the author fact', async () => {
    const { s, item } = await deliveredGateOff('frame-sent', 122);
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(122)),
      s.ctx,
    );
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      s.ctx,
    );
    expect(read.reviewPath).toMatchObject({
      identifier: item.identifier,
      currentVersion: versionOf(122),
      viewerIsRouted: true,
      sentBackRecord: {
        recordId: dto.recordId,
        findingsMd: '- `lib/export.ts:12` drops the header row — keep it.',
      },
    });
    expect(typeof read.reviewPath?.authorOfEveryPr).toBe('boolean');

    // Another kind of gate pays nothing for it.
    const merge = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_merge' },
      s.ctx,
    );
    expect(merge.reviewPath ?? null).toBeNull();

    // Once dismissed the send-back no longer stands, so there is no record to dismiss.
    await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      { subjectVersion: versionOf(122), reasonMd: 'Out of scope.' },
      s.ctx,
    );
    expect((await stateOf(s, item.id))?.sentBackRecord).toBeNull();
  });

  it('not reviewed after a push names the earlier pass it can open', async () => {
    const { s, item } = await deliveredGateOff('earlier', 123);
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(123)),
      s.ctx,
    );
    await pushTo(item.identifier, 123, 'sha-b');
    expect((await stateOf(s, item.id))?.reviewLine).toMatchObject({
      value: 'not_reviewed',
      lastReviewedVersion: versionOf(123),
      lastReviewedRef: { kind: 'record', id: dto.recordId },
    });
  });
});

// ── The open Workbench hears every review write (Bug MOTIR-10504) ─────────────
//
// THE FULL SEAM: a review write, through the real door → the committed `live_signal`
// notification a real LISTEN session hears → the reader's own watermark read, whose
// `moved` must name To approve so the open tab re-reads the row's review line and badge.
// Before the fix the gate-off pass wrote one `review_verdict_record` and nothing else: no
// trigger heard it and the To approve reading (`approval_gate` alone) did not move, so the
// row kept *Not reviewed by an agent* until a reload.

const { Client: PgClient } = await import('pg');
const { LIVE_SIGNAL_CHANNEL, parseLiveNotification } = await import('@/lib/live/liveNotification');
const { currentWorkerAdminUrl } = await import('../helpers/parallelDb');
const { workbenchWatermarkService } = await import('@/lib/services/workbenchWatermarkService');
const { githubPullRequestReviewRepository } =
  await import('@/lib/repositories/githubPullRequestReviewRepository');

describe('the open Workbench hears every review write on a To approve row (MOTIR-10504)', () => {
  let listener: InstanceType<typeof PgClient>;
  let heard: { workspaceId: string; projectId: string | null }[] = [];

  beforeEach(async () => {
    heard = [];
    listener = new PgClient({ connectionString: currentWorkerAdminUrl() });
    await listener.connect();
    listener.on('notification', (msg) => {
      const n =
        msg.channel === LIVE_SIGNAL_CHANNEL ? parseLiveNotification(msg.payload ?? '') : null;
      if (n) heard.push({ workspaceId: n.workspaceId, projectId: n.projectId });
    });
    await listener.query(`LISTEN ${LIVE_SIGNAL_CHANNEL}`);
  });

  afterEach(async () => {
    await listener.end();
  });

  /** Wait until the listener has heard a signal for this project. */
  async function signalled(s: Scenario): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (heard.some((n) => n.workspaceId === s.workspace.id && n.projectId === s.project.id)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no live signal was heard for the project');
  }

  /** The reader's watermark, then (after `write`) what moved since it — the stream's own read. */
  async function movedBy(s: Scenario, write: () => Promise<unknown>, ctx = homeCtx(s)) {
    const before = await workbenchWatermarkService.read(ctx);
    heard = [];
    await write();
    await signalled(s);
    return (await workbenchWatermarkService.read(ctx, before.cursor)).moved;
  }

  const mergeRow = async (s: Scenario, ctx = homeCtx(s)) =>
    (await approvalGatesService.listAwaitingMe(ctx)).items.find(
      (r) => r.kind === 'pull_request_approval',
    );

  it('a gate-off pass moves To approve, and the re-read row reads Reviewed by agent with the badge', async () => {
    const { s, item } = await deliveredGateOff('live-pass', 140);
    expect((await mergeRow(s))?.review).toMatchObject({
      line: { value: 'not_reviewed' },
      badge: null,
    });

    let recordId = '';
    const moved = await movedBy(s, async () => {
      const dto = await reviewVerdictService.submit(
        s.project.id,
        item.identifier,
        input(versionOf(140)),
        s.ctx,
      );
      expect(dto.outcome).toBe('recorded');
      recordId = dto.recordId;
    });
    // The pass decided no gate: only the review reading can have moved the tab.
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
    expect(moved).toContain('approvals');

    const row = await mergeRow(s);
    expect(row?.review?.line.value).toBe('reviewed_by_agent');
    expect(row?.review?.recordRef).toEqual({ kind: 'record', id: recordId });
    expect(row?.review?.badge).toMatchObject({ identifier: item.identifier, marker: null });
  });

  it('a pass with the review gate on moves To approve', async () => {
    const { s, item } = await reviewingUnder('own', 'live-gate-on', 141);
    const moved = await movedBy(s, () =>
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(141)), s.ctx),
    );
    expect(moved).toContain('approvals');
    expect((await mergeRow(s))?.review?.line.value).toBe('reviewed_by_agent');
  });

  it('a dismissal of a gate-off send-back moves To approve', async () => {
    const { s, item } = await deliveredGateOff('live-dismiss', 142);
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(142)),
      s.ctx,
    );
    const moved = await movedBy(s, () =>
      reviewDismissalService.dismiss(
        s.project.id,
        item.identifier,
        { subjectVersion: versionOf(142), reasonMd: 'Reviewed by hand.' },
        s.ctx,
      ),
    );
    expect(moved).toContain('approvals');
    expect((await mergeRow(s))?.review?.line.value).toBe('review_dismissed');
  });

  it('a GitHub approval stored at the head, deciding no gate, moves To approve', async () => {
    const { s, item } = await deliveredGateOff('live-github', 143);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 143 } });
    const moved = await movedBy(s, () =>
      adminDb.$transaction((tx) =>
        githubPullRequestReviewRepository.upsertByGithubReviewId(
          {
            githubReviewId: 'review-143',
            githubPullRequestId: pr.id,
            reviewerGithubUserId: '5150',
            reviewerLogin: 'octo-reviewer',
            reviewerType: 'User',
            state: 'approved',
            commitSha: 'sha-a',
            reviewerPermission: 'write',
            submittedAt: new Date(),
          },
          tx,
        ),
      ),
    );
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
    expect(moved).toContain('approvals');
    expect((await mergeRow(s))?.review?.line.githubApprovals).toEqual([
      { login: 'octo-reviewer', repo: 'moooon/acme', number: 143 },
    ]);
  });

  it('a review on a card the reader has no row for moves nothing on their To approve', async () => {
    const { s, item } = await deliveredGateOff('live-other', 144);
    const mate = await teammate(s, 'Teammate', 'member');
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: mate.userId } });
    const mateCtx = { ...mate, projectId: s.project.id };
    expect(await mergeRow(s)).toBeUndefined();
    expect(await mergeRow(s, mateCtx)).toBeDefined();

    const before = await workbenchWatermarkService.read(mateCtx);
    const moved = await movedBy(s, () =>
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(144)), s.ctx),
    );
    // The owner's To approve is untouched — the card is routed to the teammate…
    expect(moved).not.toContain('approvals');
    // …whose own To approve moves.
    expect((await workbenchWatermarkService.read(mateCtx, before.cursor)).moved).toContain(
      'approvals',
    );
  });
});
