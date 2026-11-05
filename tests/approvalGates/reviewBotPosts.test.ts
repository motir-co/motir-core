import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR'S APP BOT ON THE PULL REQUEST (Story MOTIR-10327 · MOTIR-10335; `approval-gates.md`
// §12 rules 7 and 8), against REAL Postgres. The verdicts are made through the real doors
// (the user-token verdict door, the hosted run's route), the Dismiss through its service
// and the switch through the settings service; GitHub, motir-ai and the gateway are
// stubbed at their HTTP seam, so the provider's own review calls are what is exercised.
//
// What a plausible wrong bot passes, pinned hardest:
//   - ONE review per pull request per verdict record — a retried job posts nothing more;
//   - never APPROVE, and a Request changes GitHub refuses on an own-authored pull request
//     becomes a comment without touching the send-back;
//   - each of the three retirements dismisses the bot's Request changes ONCE;
//   - the review sync never records the bot's own reviews, under either App identity.

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
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { linkPrByIdentifier } from '../helpers/prLink';
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
const { reviewBotPostService } = await import('@/lib/services/reviewBotPostService');
const { reviewBotPostRepository } = await import('@/lib/repositories/reviewBotPostRepository');
const { getGitProvider } = await import('@/lib/git');
const { ProviderReviewWriteError } = await import('@/lib/git/errors');
const { motirAppBotLogins, _resetMotirAppBotLogins } = await import('@/lib/github/appBotLogins');
const { botReviewBody, botDismissalMessage, BOT_REVIEW_BODY_MAX_LENGTH } =
  await import('@/lib/agentReview/botReviewBody');
const { reviewBotPost, reviewBotReconcile, reviewBotReconcileOnDismissal } =
  await import('@/lib/jobs/definitions/reviewBotPost');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');

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
  /** The review POST: `ok`, `own` (GitHub's own-authored 422) or a status to fail with. */
  reviewPost?: 'ok' | 'own' | number;
  /** The dismissal PUT's status. */
  dismiss?: number;
  /** `GET /app`'s status per App id (`iss`); 200 answers that App's slug. */
  appStatus?: Record<string, number>;
}

/** The App slugs the stubbed `GET /app` answers, by the JWT's `iss`. */
const SLUGS: Record<string, string> = { '111': 'motir-studio', '222': 'motir-integration' };
let reviewIds = 7000;

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
      const reviewPost = /\/repos\/moooon\/acme\/pulls\/(\d+)\/reviews$/.exec(url);
      if (reviewPost && method === 'POST') {
        const mode = s.reviewPost ?? 'ok';
        if (mode === 'own' && body?.event === 'REQUEST_CHANGES') {
          return json(422, {
            message: 'Unprocessable Entity',
            errors: ['Review Can not request changes on your own pull request'],
          });
        }
        if (typeof mode === 'number') return json(mode, { message: 'Server Error' });
        return json(200, { id: (reviewIds += 1), state: 'COMMENTED' });
      }
      if (/\/pulls\/\d+\/reviews\/\d+\/dismissals$/.test(url) && method === 'PUT') {
        const status = s.dismiss ?? 200;
        return json(status, status === 200 ? { state: 'DISMISSED' } : { message: 'no' });
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
        const status = s.appStatus?.[iss] ?? 200;
        return status === 200 ? json(200, { slug: SLUGS[iss] }) : json(status, {});
      }
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

const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

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

// ── Bot-post helpers ──────────────────────────────────────────────────────────

const github = getGitProvider('github');

const postsOf = (workItemId: string) =>
  adminDb.reviewBotPost.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const reviewCalls = () =>
  calls.filter((c) => c.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(c.url));

const dismissCalls = () => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/dismissals'));

const eventsNamed = (name: string) => sent.filter((e) => e.name === name).map((e) => e.data);

/** The post job's event for the newest answering verdict, as the door emitted it. */
function postRequest(): { workspaceId: string; recordId: string } {
  const [request] = eventsNamed('review-bot/post.requested').slice(-1);
  expect(request, 'the verdict asked for its post').toBeDefined();
  return request as { workspaceId: string; recordId: string };
}

/** A gate-off card the review agent sent back at `sha-a`, its Request changes posted. */
async function postedSendBack(slug: string, number: number) {
  const scenario = await deliveredGateOff(slug, number);
  const { s, item } = scenario;
  sent.length = 0;
  const dto = await reviewVerdictService.submit(
    s.project.id,
    item.identifier,
    sendBack(versionOf(number)),
    s.ctx,
  );
  const outcome = await reviewBotPostService.postVerdict(postRequest());
  expect(outcome).toEqual({ outcome: 'posted', posted: 1, dismissed: 0 });
  const [post] = await postsOf(item.id);
  expect(post).toMatchObject({ kind: 'request_changes', state: 'posted' });
  return { ...scenario, recordId: dto.recordId, post: post! };
}

/** One `pull_request_review` delivery on the scenario's repository. */
function reviewDelivery(o: {
  number: number;
  reviewId: number;
  login: string;
  type?: string;
  action?: string;
  state?: string;
}) {
  return {
    action: o.action ?? 'submitted',
    installation: INSTALLATION,
    repository: {
      id: Number(REPO_PROVIDER_ID),
      name: 'acme',
      full_name: 'moooon/acme',
      owner: { login: 'moooon' },
    },
    pull_request: { number: o.number, head: { sha: 'sha-a' } },
    review: {
      id: o.reviewId,
      user: { login: o.login, id: 9090, type: o.type ?? 'Bot' },
      body: 'Review body.',
      commit_id: 'sha-a',
      submitted_at: '2026-11-05T00:00:00Z',
      state: o.state ?? 'changes_requested',
      html_url: null,
    },
  };
}

const reviewRows = () => adminDb.githubPullRequestReview.findMany({});

// ── Posting ───────────────────────────────────────────────────────────────────

describe('posting — one review per pull request per verdict record', () => {
  it('a pass posts ONE comment review with the verdict, checklist, findings and the card link; a rerun posts nothing', async () => {
    const { s, item } = await deliveredGateOff('pass', 101);
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(101), {
        findingsMd: 'Nothing blocking.',
        checklist: [
          { key: null, criterion: 'The button exports', status: 'met', evidence: 'a.test.ts' },
          { key: null, criterion: 'The  file\nis named', status: 'cannot_tell', evidence: null },
        ],
      }),
      s.ctx,
    );
    const request = postRequest();

    expect(await reviewBotPostService.postVerdict(request)).toEqual({
      outcome: 'posted',
      posted: 1,
      dismissed: 0,
    });
    const [call] = reviewCalls();
    expect(call!.url).toBe('https://api.github.com/repos/moooon/acme/pulls/101/reviews');
    expect(call!.body!.event).toBe('COMMENT');
    const body = String(call!.body!.body);
    expect(body).toContain('**Motir agent review: passed**');
    expect(body).toContain(`[${item.identifier}](https://app.test/items/${item.identifier})`);
    expect(body).toContain('Looks right.');
    expect(body).toContain('1 met · 0 not met · 1 cannot tell (of 2)');
    expect(body).toContain('- cannot tell: The file is named');
    expect(body).toContain('Nothing blocking.');
    expect(body).toContain('This is not an approval');

    // The retry: the row is the idempotency record.
    expect(await reviewBotPostService.postVerdict(request)).toEqual({
      outcome: 'posted',
      posted: 0,
      dismissed: 0,
    });
    expect(reviewCalls()).toHaveLength(1);
    const posts = await postsOf(item.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      kind: 'comment',
      state: 'posted',
      reviewVerdictRecordId: request.recordId,
      githubReviewId: '7001',
    });
    expect(posts[0]!.postedAt).toBeInstanceOf(Date);
    // Never APPROVE, anywhere.
    expect(calls.some((c) => c.body?.event === 'APPROVE')).toBe(false);
  });

  it('a send-back posts a Request changes review, minted as the repository App — never a person', async () => {
    const { item } = await postedSendBack('send-back', 102);
    const [call] = reviewCalls();
    expect(call!.body!.event).toBe('REQUEST_CHANGES');
    expect(String(call!.body!.body)).toContain('**Motir agent review: changes requested**');
    expect(String(call!.body!.body)).toContain('drops the header row');
    // The Motir-created repo's App (`motir-studio`, the provisioning registration).
    expect(calls.some((c) => /\/app\/installations\/[^/]+\/access_tokens$/.test(c.url))).toBe(true);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });

  it('GitHub refusing Request changes on an own-authored pull request posts a comment instead; the send-back stands', async () => {
    const { s, item } = await deliveredGateOff('own', 103);
    stub({ reviewPost: 'own' });
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(103)),
      s.ctx,
    );
    expect(await reviewBotPostService.postVerdict(postRequest())).toMatchObject({ posted: 1 });
    expect(reviewCalls().map((c) => c.body!.event)).toEqual(['REQUEST_CHANGES', 'COMMENT']);
    expect(await postsOf(item.id)).toEqual([
      expect.objectContaining({ kind: 'comment', state: 'posted' }),
    ]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });

  it('a failed post throws for the retry, leaves no row and never touches the verdict; the retry posts once', async () => {
    const { s, item } = await deliveredGateOff('fails', 104);
    stub({ reviewPost: 502 });
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(104)),
      s.ctx,
    );
    const request = postRequest();
    await expect(reviewBotPostService.postVerdict(request)).rejects.toBeInstanceOf(
      ProviderReviewWriteError,
    );
    expect(await postsOf(item.id)).toEqual([]);
    const record = await adminDb.reviewVerdictRecord.findUniqueOrThrow({
      where: { id: request.recordId },
    });
    expect(record.outcome).toBe('recorded');
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');

    stub();
    expect(await reviewBotPostService.postVerdict(request)).toMatchObject({ posted: 1 });
    expect(await postsOf(item.id)).toHaveLength(1);
  });

  it('a new version’s verdict posts its own review', async () => {
    const { s, item } = await postedSendBack('new-version', 105);
    await pushTo(item.identifier, 105, 'sha-b');
    await hostAnswersCleanAt(s.workspace.id, 105, 'sha-b');
    await ci('sha-b', 105);
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(105, 'sha-b')),
      s.ctx,
    );
    await reviewBotPostService.postVerdict(postRequest());
    const posts = await postsOf(item.id);
    expect(posts.map((p) => p.kind)).toEqual(['request_changes', 'request_changes']);
    expect(new Set(posts.map((p) => p.reviewVerdictRecordId)).size).toBe(2);
  });

  it('a late or second verdict, and a missing record, post nothing', async () => {
    const { s, item } = await postedSendBack('nothing', 106);
    calls = [];
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(106)), s.ctx),
    ).rejects.toThrow();
    await expect(
      reviewVerdictService.submit(
        s.project.id,
        item.identifier,
        input(versionOf(106, 'sha-old')),
        s.ctx,
      ),
    ).rejects.toThrow();
    const history = await adminDb.reviewVerdictRecord.findMany({
      where: { workItemId: item.id, outcome: { in: ['late', 'second'] } },
    });
    expect(history.map((r) => r.outcome).sort()).toEqual(['late', 'second']);
    expect(eventsNamed('review-bot/post.requested')).toHaveLength(1);
    for (const record of history) {
      expect(
        await reviewBotPostService.postVerdict({
          workspaceId: s.workspace.id,
          recordId: record.id,
        }),
      ).toEqual({ outcome: 'skipped', reason: 'not_answering', dismissed: 0 });
    }
    expect(
      await reviewBotPostService.postVerdict({ workspaceId: s.workspace.id, recordId: 'gone' }),
    ).toEqual({ outcome: 'skipped', reason: 'no_record', dismissed: 0 });
  });

  it('a project whose posting switch is off posts nothing', async () => {
    const other = await deliveredGateOff('switch-off', 107);
    await adminDb.project.update({
      where: { id: other.s.project.id },
      data: { reviewBotPostsEnabled: false },
    });
    sent.length = 0;
    await reviewVerdictService.submit(
      other.s.project.id,
      other.item.identifier,
      sendBack(versionOf(107)),
      other.s.ctx,
    );
    expect(await reviewBotPostService.postVerdict(postRequest())).toEqual({
      outcome: 'skipped',
      reason: 'posting_off',
      dismissed: 0,
    });
    expect(reviewCalls()).toEqual([]);
    expect(await postsOf(other.item.id)).toEqual([]);
  });

  it('a closed pull request of the set is skipped', async () => {
    const { s, item } = await deliveredGateOff('closed', 108);
    await adminDb.githubPullRequest.updateMany({
      where: { number: 108 },
      data: { state: 'closed' },
    });
    sent.length = 0;
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(108)), s.ctx);
    expect(await reviewBotPostService.postVerdict(postRequest())).toEqual({
      outcome: 'posted',
      posted: 0,
      dismissed: 0,
    });
    expect(reviewCalls()).toEqual([]);
  });

  it('the hosted path posts its decided verdict; a rollback of the door emits nothing', async () => {
    const { s, item } = await reviewingUnder('hosted', 'hosted', 109);
    const res = await hostedSubmit(s, item.identifier, {
      subjectVersion: versionOf(109),
      verdict: 'changes_requested',
      findingsMd: '- `lib/export.ts:12` drops the header row.',
    });
    expect(res.status).toBe(200);
    const request = postRequest();
    const record = await adminDb.reviewVerdictRecord.findUniqueOrThrow({
      where: { id: request.recordId },
    });
    expect(record).toMatchObject({ outcome: 'decided', harness: 'Motir hosted review' });
    expect(await reviewBotPostService.postVerdict(request)).toMatchObject({ posted: 1 });
    expect(reviewCalls()[0]!.body!.event).toBe('REQUEST_CHANGES');
  });

  it('the own-agent door posts its decided verdict too', async () => {
    const { s, item } = await reviewingUnder('own', 'own-door', 110);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(110)), s.ctx);
    const request = postRequest();
    expect(
      (await adminDb.reviewVerdictRecord.findUniqueOrThrow({ where: { id: request.recordId } }))
        .outcome,
    ).toBe('decided');
    expect(await reviewBotPostService.postVerdict(request)).toMatchObject({ posted: 1 });
  });
});

// ── Dismissal ─────────────────────────────────────────────────────────────────

describe('dismissal — the bot retires its own Request changes, once', () => {
  it('a later pass dismisses the earlier Request changes with a one-line reason linking the card; a second reconcile dismisses nothing', async () => {
    const { s, item, post } = await postedSendBack('later-pass', 111);
    await pushTo(item.identifier, 111, 'sha-b');
    await hostAnswersCleanAt(s.workspace.id, 111, 'sha-b');
    await ci('sha-b', 111);
    sent.length = 0;
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(111, 'sha-b')),
      s.ctx,
    );
    expect(await reviewBotPostService.postVerdict(postRequest())).toEqual({
      outcome: 'posted',
      posted: 1,
      dismissed: 1,
    });
    const [dismissal] = dismissCalls();
    expect(dismissal!.url).toBe(
      `https://api.github.com/repos/moooon/acme/pulls/111/reviews/${post.githubReviewId}/dismissals`,
    );
    expect(dismissal!.body).toEqual({
      event: 'DISMISS',
      message: `A later Motir agent review passed ${item.identifier}: https://app.test/items/${item.identifier}`,
    });
    const after = await adminDb.reviewBotPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.state).toBe('dismissed');
    expect(after.dismissedAt).toBeInstanceOf(Date);

    expect(
      await reviewBotPostService.reconcile({ workspaceId: s.workspace.id, workItemId: item.id }),
    ).toBe(0);
    expect(dismissCalls()).toHaveLength(1);
  });

  it('a person’s Dismiss reaches the reconcile through review/dismissed', async () => {
    const { s, item, post } = await postedSendBack('dismiss', 112);
    sent.length = 0;
    await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      { subjectVersion: versionOf(112), reasonMd: 'Out of scope for this card.' },
      s.ctx,
    );
    const [event] = eventsNamed('review/dismissed');
    const out = await reviewBotReconcileOnDismissal.handler(
      {
        event: { name: 'review/dismissed', data: event },
        step: {} as never,
        runId: 'r',
        attempt: 0,
      },
      { reviewBotPost: reviewBotPostService } as never,
    );
    expect(out).toEqual({ dismissed: 1 });
    expect(String(dismissCalls()[0]!.body!.message)).toContain(
      'A person dismissed this agent review',
    );
    expect((await adminDb.reviewBotPost.findUniqueOrThrow({ where: { id: post.id } })).state).toBe(
      'dismissed',
    );
  });

  it('turning the posting switch off asks to reconcile each card with a standing Request changes', async () => {
    const { s, item, post } = await postedSendBack('switch', 113);
    sent.length = 0;
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewBotPostsEnabled: false },
      s.ctx,
    );
    const events = eventsNamed('review-bot/reconcile.requested');
    expect(events).toEqual([{ workspaceId: s.workspace.id, workItemId: item.id }]);
    const out = await reviewBotReconcile.handler(
      {
        event: { name: 'review-bot/reconcile.requested', data: events[0] },
        step: {} as never,
        runId: 'r',
        attempt: 0,
      },
      { reviewBotPost: reviewBotPostService } as never,
    );
    expect(out).toEqual({ dismissed: 1 });
    expect(String(dismissCalls()[0]!.body!.message)).toContain(
      'Posting agent reviews was turned off',
    );
    expect((await adminDb.reviewBotPost.findUniqueOrThrow({ where: { id: post.id } })).state).toBe(
      'dismissed',
    );
    // Turning it back on asks nothing.
    sent.length = 0;
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewBotPostsEnabled: true },
      s.ctx,
    );
    expect(eventsNamed('review-bot/reconcile.requested')).toEqual([]);
  });

  it('a standing send-back with nothing retiring it is left alone', async () => {
    const { s, item } = await postedSendBack('standing', 114);
    expect(
      await reviewBotPostService.reconcile({ workspaceId: s.workspace.id, workItemId: item.id }),
    ).toBe(0);
    expect(dismissCalls()).toEqual([]);
  });

  it('a dismissal GitHub did not take is counted and thrown for the retry; a vanished review is marked done', async () => {
    const { s, item, post } = await postedSendBack('dismiss-fails', 115);
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewBotPostsEnabled: false },
    });
    stub({ dismiss: 500 });
    const reconcile = () =>
      reviewBotPostService.reconcile({ workspaceId: s.workspace.id, workItemId: item.id });
    await expect(reconcile()).rejects.toThrow(/could not dismiss 1 of Motir/);
    const failed = await adminDb.reviewBotPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(failed).toMatchObject({ state: 'posted', attempts: 1 });
    expect(failed.lastError).toMatch(/answered 500/);

    stub({ dismiss: 404 });
    expect(await reconcile()).toBe(1);
    expect(await adminDb.reviewBotPost.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject(
      { state: 'dismissed', lastError: null },
    );
  });

  it('the post job, run as the engine runs it, posts and reconciles', async () => {
    const { s, item } = await deliveredGateOff('job', 116);
    sent.length = 0;
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(116)), s.ctx);
    const out = await reviewBotPost.handler(
      {
        event: { name: 'review-bot/post.requested', data: postRequest() },
        step: {} as never,
        runId: 'r',
        attempt: 0,
      },
      { reviewBotPost: reviewBotPostService } as never,
    );
    expect(out).toEqual({ outcome: 'posted', posted: 1, dismissed: 0 });
  });
});

// ── The review sync filter ────────────────────────────────────────────────────

describe('the review sync ignores Motir’s own App bots', () => {
  it.each([
    ['motir-studio[bot]', 'the provisioning App'],
    ['Motir-Integration[bot]', 'the user-facing App'],
  ])('%s (%s) is ignored_bot and stored nowhere — its dismissal too', async (login) => {
    const { item } = await postedSendBack(`sync-${login.length}`, 120);
    for (const action of ['submitted', 'dismissed']) {
      const result = await githubWebhookService.handleEvent(
        'pull_request_review',
        reviewDelivery({ number: 120, reviewId: 55_001, login, action }),
      );
      expect(result).toEqual({ event: 'pull_request_review', outcome: 'ignored_bot' });
    }
    expect(await reviewRows()).toEqual([]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });

  it('another bot, and a person, are recorded as before', async () => {
    await postedSendBack('sync-others', 121);
    const bot = await githubWebhookService.handleEvent(
      'pull_request_review',
      reviewDelivery({
        number: 121,
        reviewId: 55_002,
        login: 'dependabot[bot]',
        state: 'commented',
      }),
    );
    expect(bot.event === 'pull_request_review' && bot.outcome).not.toBe('ignored_bot');
    const person = await githubWebhookService.handleEvent(
      'pull_request_review',
      reviewDelivery({
        number: 121,
        reviewId: 55_003,
        login: 'ada-l',
        type: 'User',
        state: 'commented',
      }),
    );
    expect(person.event === 'pull_request_review' && person.outcome).not.toBe('ignored_bot');
    expect((await reviewRows()).map((r) => r.reviewerLogin).sort()).toEqual([
      'ada-l',
      'dependabot[bot]',
    ]);
  });

  it('when an App’s slug cannot be read, the bot’s own post row still identifies its review', async () => {
    const { post } = await postedSendBack('sync-backstop', 122);
    stub({ appStatus: { '111': 500, '222': 500 } });
    const result = await githubWebhookService.handleEvent(
      'pull_request_review',
      reviewDelivery({
        number: 122,
        reviewId: Number(post.githubReviewId),
        login: 'motir-studio[bot]',
      }),
    );
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'ignored_bot' });
    expect(await reviewRows()).toEqual([]);
    expect(await motirAppBotLogins()).toEqual({ logins: new Set(), complete: false });
    // A failed read is not cached: the next one asks again.
    stub();
    expect((await motirAppBotLogins()).logins).toEqual(
      new Set(['motir-studio[bot]', 'motir-integration[bot]']),
    );
  });

  it('an App that is not configured contributes no login', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    expect(await motirAppBotLogins()).toEqual({
      logins: new Set(['motir-studio[bot]']),
      complete: true,
    });
  });
});

// ── Tenancy, the provider seam and the body ───────────────────────────────────

describe('the post table, the provider seam and the text', () => {
  it('a post row is invisible from another workspace', async () => {
    const { s, item } = await postedSendBack('tenant-a', 130);
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const other = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: stranger.id,
    });
    const fromOther = await withWorkspaceServiceContext(other.workspace.id, (tx) =>
      tx.reviewBotPost.findMany({ where: { workItemId: item.id } }),
    );
    expect(fromOther).toEqual([]);
    const fromOwn = await withWorkspaceServiceContext(s.workspace.id, (tx) =>
      reviewBotPostRepository.listLiveRequestChangesByWorkItem(item.id, tx),
    );
    expect(fromOwn).toHaveLength(1);
    expect(fromOwn[0]!.pullRequest).toMatchObject({
      number: 130,
      repo: { owner: 'moooon', name: 'acme', installation: { installationId: INSTALLATION_ID } },
    });
    // The repository answers the row already there for a repeated pair.
    const again = await withWorkspaceServiceContext(s.workspace.id, (tx) =>
      reviewBotPostRepository.create(
        {
          workspaceId: s.workspace.id,
          projectId: s.project.id,
          workItemId: item.id,
          reviewVerdictRecordId: fromOwn[0]!.reviewVerdictRecordId,
          githubPullRequestId: fromOwn[0]!.githubPullRequestId,
          kind: 'comment',
          githubReviewId: '1',
          postedAt: new Date(),
        },
        tx,
      ),
    );
    expect(again.id).toBe(fromOwn[0]!.id);
    expect(await postsOf(item.id)).toHaveLength(1);
  });

  it('the provider throws a typed error on an unreachable host and an answer with no id; a 422 dismissal is gone', async () => {
    const address = { installationId: '42', owner: 'moooon', repo: 'acme', number: 1 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/access_tokens')) {
          return new Response(
            JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3e6).toISOString() }),
            { status: 201 },
          );
        }
        throw new Error('socket hang up');
      }),
    );
    await expect(
      github.createPullRequestReview!({ ...address, event: 'COMMENT', body: 'b' }),
    ).rejects.toThrow(/review post could not be reached \(socket hang up\)/);

    const answer = (status: number, payload: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) =>
          String(input).endsWith('/access_tokens')
            ? new Response(
                JSON.stringify({
                  token: 't',
                  expires_at: new Date(Date.now() + 3e6).toISOString(),
                }),
                { status: 201 },
              )
            : new Response(JSON.stringify(payload), { status }),
        ),
      );
    answer(200, { state: 'COMMENTED' });
    await expect(
      github.createPullRequestReview!({ ...address, event: 'COMMENT', body: 'b' }),
    ).rejects.toThrow(/no review id/);
    answer(422, { message: 'Validation Failed' });
    await expect(
      github.createPullRequestReview!({ ...address, event: 'REQUEST_CHANGES', body: 'b' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REVIEW_WRITE_FAILED', status: 422 });
    answer(422, { message: 'Can not dismiss a commented pull request review' });
    await expect(
      github.dismissPullRequestReview!({ ...address, reviewId: '9', message: 'm' }),
    ).resolves.toBe('gone');
    answer(503, {});
    await expect(
      github.dismissPullRequestReview!({ ...address, reviewId: '9', message: 'm' }),
    ).rejects.toMatchObject({ operation: 'dismiss', status: 503 });
  });

  it('the body is cut under GitHub’s limit, reads only well-formed checklist rows, and every reason has its line', () => {
    const long = botReviewBody(
      {
        verdict: 'changes_requested',
        summaryMd: null,
        findingsMd: 'x'.repeat(BOT_REVIEW_BODY_MAX_LENGTH + 10),
        checklist: [null, 'row', ['a'], { criterion: 1, status: 'met' }] as never,
      },
      'ACME-1',
      'https://app.test/items/ACME-1',
    );
    expect(long.length).toBeLessThan(BOT_REVIEW_BODY_MAX_LENGTH + 200);
    expect(long).toContain(
      '… (cut — the full review is on [ACME-1](https://app.test/items/ACME-1))',
    );
    expect(long).not.toContain('**Checklist:**');
    expect(
      botReviewBody(
        { verdict: 'pass', summaryMd: ' ', findingsMd: null, checklist: {} as never },
        'ACME-1',
        'u',
      ),
    ).not.toContain('**Findings**');
    expect(
      botReviewBody(
        {
          verdict: 'changes_requested',
          summaryMd: null,
          findingsMd: null,
          checklist: [{ criterion: 'c', status: 'odd' }] as never,
        },
        'ACME-1',
        'u',
      ),
    ).toContain('- odd: c');
    expect(botDismissalMessage('dismissed', 'ACME-1', 'u')).toBe(
      'A person dismissed this agent review in Motir on ACME-1: u',
    );
  });
});
