import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW SOURCE IS RETIRED (Story MOTIR-11941 · MOTIR-11943; `approval-gates.md` §12),
// against REAL Postgres. Nothing reviews by itself: the raise requests no hosted run under
// either stored `review_agent_source` value, it notifies the routed person once instead,
// and the reviews-to-run list, the start lane a person's press uses, and a hosted run's
// end read no source. The PATCH accepts and ignores the field. The column stays in the
// schema, unread by behaviour. The review is raised by the real webhook-driven green
// verdict, the hosted run starts on the fake orchestrator, and motir-ai, the gateway and
// GitHub are stubbed at their HTTP seam, as `tests/agentReview/agentReviewStart.test.ts`
// stubs them.

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
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { linkPrByIdentifier } from '../helpers/prLink';
import { reviewRequestFor } from '../helpers/reviewRequest';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { projectPrMergeModeService } = await import('@/lib/services/projectPrMergeModeService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { reviewToRunService } = await import('@/lib/services/reviewToRunService');
const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { MergeModeReviewAgentOnError, ReviewAgentNeedsManualMergeError } =
  await import('@/lib/projects/errors');

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));
const gatesRoute = await import('@/app/api/projects/[key]/approval-gates/route');

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

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');

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

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

const reviewRequests = () =>
  sent
    .filter((e) => e.name === 'agent-review/requested')
    .map((e) => e.data as unknown as AgentReviewRequestedData);

const runRows = (workspaceId: string) =>
  adminDb.dispatchRun.findMany({ where: { workspaceId }, orderBy: { startedAt: 'asc' } });

type Stored = 'hosted' | 'own';

/** Write the RETIRED column directly — no door writes it any more. */
const storeSource = (projectId: string, source: Stored) =>
  adminDb.project.update({ where: { id: projectId }, data: { reviewAgentSource: source } });

const reviewToRunRows = (recipientUserId: string) =>
  adminDb.notification.findMany({
    where: { recipientUserId, type: 'review_to_run' },
    orderBy: { createdAt: 'asc' },
  });

/**
 * A card delivered by pull request `number`, green at `sha-a`, holding its review — raised
 * with the retired column already holding `stored`.
 */
async function reviewing(slug: string, number: number, stored: Stored = 'hosted') {
  const s = await makeScenario(slug);
  await storeSource(s.project.id, stored);
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
  return { s, item, review: review! };
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

const projectRow = (id: string) => adminDb.project.findUniqueOrThrow({ where: { id } });

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patchBody = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/approval-gates', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

const homeCtx = (s: {
  user: { id: string };
  workspace: { id: string };
  project: { id: string };
}) => ({
  userId: s.user.id,
  workspaceId: s.workspace.id,
  projectId: s.project.id,
});

// ── Nothing reviews by itself ─────────────────────────────────────────────────

describe('the raise starts nothing under either stored source', () => {
  it.each(['hosted', 'own'] as const)(
    'stored %s: the gate waits at its version, no request, no run, nothing billed, one notification',
    async (stored) => {
      const { s, item, review } = await reviewing(
        `raise-${stored}`,
        stored === 'hosted' ? 61 : 62,
        stored,
      );
      expect(reviewRequests()).toEqual([]);
      expect(await runRows(s.workspace.id)).toEqual([]);
      expect(mintCalls()).toEqual([]);
      expect(fakeOrchestrator.provisioned).toHaveLength(0);
      const gate = await gateRow(review.id);
      expect(gate.state).toBe('awaiting');
      expect(gate.reviewUnavailableReason).toBeNull();

      // The routed person (the reporter here) was told once, after commit.
      const rows = await reviewToRunRows(s.user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workItemId: item.id,
        dedupeKey: `review_to_run:${review.id}`,
        data: { kind: 'review_to_run', command: `motir review ${item.identifier}` },
      });
      // A redelivered notify writes no second row.
      expect(await reviewToRunService.notifyRaised(s.workspace.id, review.id)).toBe('notified');
      expect(await reviewToRunRows(s.user.id)).toHaveLength(1);

      const state = (await reviewStateService.forCards(s.project.id, [item.id], s.ctx)).get(
        item.id,
      );
      expect(state?.marker).toEqual({
        kind: 'waiting_for_review',
        routedTo: expect.objectContaining({ id: s.user.id }),
        forViewer: true,
        command: `motir review ${item.identifier}`,
      });
      expect(state?.reviewToRun).toEqual({
        gateId: review.id,
        command: `motir review ${item.identifier}`,
      });
      // …and it is listed as a review to run, whichever value the column holds.
      expect(
        (await approvalGatesService.listReviewsToRun(homeCtx(s))).map((row) => row.gateId),
      ).toEqual([review.id]);
    },
  );

  it('notifyRaised answers not_a_review_to_run with the review agent off, or for a gate that is not an awaiting review', async () => {
    const { s, review } = await reviewing('notify-off', 63);
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
    expect(await reviewToRunService.notifyRaised(s.workspace.id, review.id)).toBe(
      'not_a_review_to_run',
    );
    expect(await reviewToRunService.notifyRaised(s.workspace.id, 'no-such-gate')).toBe(
      'not_a_review_to_run',
    );
  });
});

describe('a raise outside any transaction helper scope', () => {
  it('notifies nobody and says so; the gate still stands awaiting', async () => {
    const { s, item, review } = await reviewing('unscoped', 67);
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { state: 'superseded', supersededCause: 'ci_failed' },
    });
    await adminDb.notification.deleteMany({ where: { recipientUserId: s.user.id } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A bare transaction opens no after-commit scope: the creator cannot defer its notify.
    await adminDb.$transaction(async (tx) => {
      const fresh = await tx.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(await reconcileGatesFor(fresh, tx)).toEqual([REVIEW]);
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('raised outside a transaction scope'),
      expect.objectContaining({ workItemId: item.id }),
    );
    const [again] = (await gatesOf(item.id, REVIEW)).filter((g) => g.state === 'awaiting');
    expect(again).toBeDefined();
    expect(await reviewToRunRows(s.user.id)).toEqual([]);
    expect(reviewRequests()).toEqual([]);
  });
});

// ── The start lane a person's press uses ──────────────────────────────────────

describe('startRequested reads no source', () => {
  it('starts ONE hosted run for a fresh request even with the column at own; then already_started, run_in_flight', async () => {
    const { s, review } = await reviewing('start-own', 64, 'own');
    const request = reviewRequestFor(review);
    const first = await agentReviewStartService.startRequested(request);
    expect(first.outcome).toBe('started');
    expect(await runRows(s.workspace.id)).toHaveLength(1);

    // The same key again is that run.
    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'already_started',
      dispatchRunId: (first as { dispatchRunId: string }).dispatchRunId,
    });
    // A second key while it runs: one review at a time.
    expect(
      await agentReviewStartService.startRequested(
        reviewRequestFor(review, `agent-review:${review.id}:again:second`),
      ),
    ).toEqual({ outcome: 'skipped', why: 'run_in_flight' });
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('a request at a moved version answers version_moved and starts nothing', async () => {
    const { s, review } = await reviewing('start-moved', 65, 'own');
    expect(
      await agentReviewStartService.startRequested({
        ...reviewRequestFor(review),
        subjectVersion: 'acme/app#65@another',
      }),
    ).toEqual({ outcome: 'skipped', why: 'version_moved' });
    expect(await runRows(s.workspace.id)).toEqual([]);
  });

  it('a hosted run that ends without a verdict leaves its reason on the awaiting gate, with the column at own', async () => {
    const { s, review } = await reviewing('end-own', 66, 'own');
    expect((await agentReviewStartService.startRequested(reviewRequestFor(review))).outcome).toBe(
      'started',
    );
    const [run] = await runRows(s.workspace.id);
    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');
    expect((await runRow(run!.id)).status).not.toBe('running');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('no_verdict');
  });
});

// ── The retired field on the PATCH ────────────────────────────────────────────

describe('the PATCH accepts and ignores the retired source', () => {
  it.each([
    ['own', { reviewAgentSource: 'own' }],
    ['an unknown value', { reviewAgentSource: 'robot' }],
    ['a non-string', { reviewAgentSource: 1 }],
  ])('%s answers 200, leaves the column unchanged and emits nothing', async (label, body) => {
    const { s, review } = await reviewing(`patch-${label.length}`, 70 + label.length);
    sent.length = 0;
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });

    const res = await gatesRoute.PATCH(patchBody(body), params('ACME'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reviewAgentEnabled: true,
      reviewAgentSource: 'hosted',
    });
    expect((await projectRow(s.project.id)).reviewAgentSource).toBe('hosted');
    expect(sent).toEqual([]);
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect((await gateRow(review.id)).state).toBe('awaiting');
  });

  it('a body carrying the field beside a real switch writes only the switch', async () => {
    const s = await makeScenario('patch-beside');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });
    const res = await gatesRoute.PATCH(
      patchBody({ reviewAgentSource: 'own', reviewBotPostsEnabled: false }),
      params('ACME'),
    );
    expect(res.status).toBe(200);
    expect(await projectRow(s.project.id)).toMatchObject({
      reviewAgentEnabled: true,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: false,
    });
  });

  it('the settings read still maps the stored column for the settings room', async () => {
    const s = await makeScenario('read-dto');
    await storeSource(s.project.id, 'own');
    await expect(
      approvalGateSettingsService.getSettings(s.project.id, s.ctx),
    ).resolves.toMatchObject({
      reviewAgentEnabled: true,
      reviewAgentSource: 'own',
      reviewBotPostsEnabled: true,
    });
  });
});

// ── Turning Review on, and a head move ────────────────────────────────────────

describe('turning Review on starts nothing, and a head move re-raises a waiting review', () => {
  it('turning Review on raises no review on a card already asking to approve and merge', async () => {
    const s = await makeScenario('enable');
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Card 80' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    const headRef = `subtask/${item.identifier}-80`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 80,
      headRef,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('opened', 80, headRef),
    );
    await ci('sha-a', 80);
    expect(
      (await gatesOf(item.id, 'pull_request_approval')).filter((g) => g.state === 'awaiting'),
    ).toHaveLength(1);
    sent.length = 0;

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: true },
      s.ctx,
    );

    expect(await gatesOf(item.id, REVIEW)).toEqual([]);
    expect(reviewRequests()).toEqual([]);
    expect(await runRows(s.workspace.id)).toEqual([]);
  });

  it('a head move supersedes the review and re-raises it at the new version, waiting, notified once', async () => {
    const { s, item, review } = await reviewing('head-move', 81);
    sent.length = 0;
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 81, `subtask/${item.identifier}-81`, {
        head: { ref: `subtask/${item.identifier}-81`, sha: 'sha-b' },
      }),
    );
    await hostAnswersCleanAt(s.workspace.id, 81, 'sha-b');
    await ci('sha-b', 81);

    expect((await gateRow(review.id)).state).toBe('superseded');
    const next = (await gatesOf(item.id, REVIEW)).find((g) => g.state === 'awaiting');
    expect(next, 'the head move re-raised the review').toBeDefined();
    expect(next!.id).not.toBe(review.id);
    expect(next!.subjectVersion).not.toBe(review.subjectVersion);
    expect(reviewRequests()).toEqual([]);
    expect(await runRows(s.workspace.id)).toEqual([]);
    const rows = await reviewToRunRows(s.user.id);
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      `review_to_run:${review.id}`,
      `review_to_run:${next!.id}`,
    ]);
  });
});

// ── §12.2a — the exclusion with Merge automatically ───────────────────────────

describe('the review agent and Merge automatically still exclude each other (§12.2a)', () => {
  it('both refusals fire, and the refused enable answers 409 on the route', async () => {
    const s = await makeScenario('exclusion');

    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.ctx),
    ).rejects.toBeInstanceOf(MergeModeReviewAgentOnError);

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    await projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.ctx);
    await expect(
      approvalGateSettingsService.updateSettings(s.project.id, { reviewAgentEnabled: true }, s.ctx),
    ).rejects.toBeInstanceOf(ReviewAgentNeedsManualMergeError);

    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });
    const res = await gatesRoute.PATCH(patchBody({ reviewAgentEnabled: true }), params('ACME'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'REVIEW_AGENT_NEEDS_MANUAL_MERGE' });
    expect(await projectRow(s.project.id)).toMatchObject({
      reviewAgentEnabled: false,
      prMergeMode: 'auto',
    });
  });
});
