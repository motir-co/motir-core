import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW-AGENT SOURCE and the bot-posting switch (Story MOTIR-10327 · MOTIR-10332;
// `approval-gates.md` §12.10 and §12.16), against REAL Postgres: the project field and
// its PATCH route, the hosted start gated on the source in the `agent-review/requested`
// job body, the source switch with a review awaiting, and the §12.2a exclusion with
// Merge automatically under both sources. The review is raised by the real
// webhook-driven green verdict, the hosted run starts on the fake orchestrator, and
// motir-ai, the gateway and GitHub are stubbed at their HTTP seam, as
// `tests/agentReview/agentReviewStart.test.ts` stubs them.

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
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { ReviewAgainNotOfferedError } = await import('@/lib/agentReview/errors');
const {
  InvalidReviewAgentSourceError,
  MergeModeReviewAgentOnError,
  ReviewAgentNeedsManualMergeError,
} = await import('@/lib/projects/errors');

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

const setSource = (
  s: { project: { id: string }; ctx: { userId: string; workspaceId: string } },
  source: 'hosted' | 'own',
) => approvalGateSettingsService.updateSettings(s.project.id, { reviewAgentSource: source }, s.ctx);

const projectRow = (id: string) => adminDb.project.findUniqueOrThrow({ where: { id } });

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patchBody = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/approval-gates', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

/** A card reviewing under the HOSTED source, its raise run started and in flight. */
async function reviewingInFlight(slug: string, number: number) {
  const scenario = await reviewing(slug, number);
  expect((await agentReviewStartService.startRequested(scenario.request)).outcome).toBe('started');
  const [run] = await runRows(scenario.s.workspace.id);
  expect(run!.status).toBe('running');
  sent.length = 0;
  return { ...scenario, run: run! };
}

// ── The fields ────────────────────────────────────────────────────────────────

describe('the review source and bot-posting fields (MOTIR-10332)', () => {
  it('an existing project row defaults to source hosted and bot posting on, read by the service and GET', async () => {
    const s = await makeScenario('defaults');
    const row = await projectRow(s.project.id);
    expect(row.reviewAgentSource).toBe('hosted');
    expect(row.reviewBotPostsEnabled).toBe(true);

    await expect(approvalGateSettingsService.getSettings(s.project.id, s.ctx)).resolves.toEqual({
      acceptanceVideoEnabled: row.acceptanceVideoEnabled,
      reviewAgentEnabled: true,
      designApprovalGate: row.designApprovalGate,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });

    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });
    const res = await gatesRoute.GET(new Request('https://app.motir.co/x'), params('ACME'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
  });

  it('a PATCH naming one field writes only that field', async () => {
    const s = await makeScenario('subset');
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });

    const res = await gatesRoute.PATCH(patchBody({ reviewAgentSource: 'own' }), params('ACME'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reviewAgentEnabled: true,
      reviewAgentSource: 'own',
      reviewBotPostsEnabled: true,
    });

    const res2 = await gatesRoute.PATCH(
      patchBody({ reviewBotPostsEnabled: false }),
      params('ACME'),
    );
    expect(res2.status).toBe(200);
    const row = await projectRow(s.project.id);
    expect(row).toMatchObject({
      reviewAgentEnabled: true,
      reviewAgentSource: 'own',
      reviewBotPostsEnabled: false,
    });
  });

  it.each([
    ['a source outside hosted | own', { reviewAgentSource: 'robot' }],
    ['a non-string source', { reviewAgentSource: 1 }],
    ['a non-boolean bot-posting switch', { reviewBotPostsEnabled: 'yes' }],
  ])('the route refuses %s with 400 and writes nothing', async (_label, body) => {
    const s = await makeScenario(`bad-${_label.length}`);
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.ctx });

    const res = await gatesRoute.PATCH(patchBody(body), params('ACME'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await projectRow(s.project.id)).toMatchObject({
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
  });

  it('the service refuses an unknown source with its typed error', async () => {
    const s = await makeScenario('bad-service');
    await expect(
      approvalGateSettingsService.updateSettings(
        s.project.id,
        { reviewAgentSource: 'robot' as unknown as 'own' },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidReviewAgentSourceError);
  });

  it('the source is stored while the agent is off, and both values survive a disable', async () => {
    const s = await makeScenario('stored-off');
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'own', reviewBotPostsEnabled: false },
      s.ctx,
    );
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: true },
      s.ctx,
    );
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    expect(await projectRow(s.project.id)).toMatchObject({
      reviewAgentEnabled: false,
      reviewAgentSource: 'own',
      reviewBotPostsEnabled: false,
    });
    expect(reviewRequests()).toEqual([]);
  });
});

// ── The hosted start, gated on the source ─────────────────────────────────────

describe('the hosted run starts only for source hosted', () => {
  it('source hosted: the raise starts one hosted run, as before', async () => {
    const { s, request } = await reviewing('hosted-start', 61);
    expect((await agentReviewStartService.startRequested(request)).outcome).toBe('started');
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('source own: the gate stands awaiting at its version, no run, nothing billed, no could-not-run reason', async () => {
    // The source is set BEFORE the green verdict raises the review.
    const { s, review, request } = await reviewingUnder('own', 'own-start', 62);
    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'skipped',
      why: 'source_own',
    });
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    const gate = await gateRow(review.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.subjectVersion).toBe(review.subjectVersion);
    expect(gate.reviewUnavailableReason).toBeNull();
  });

  it('source own: Review again is refused with source_own', async () => {
    const { s, review } = await reviewingUnder('own', 'own-again', 63);
    // A reason left from before the switch would otherwise offer it.
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });
    const refused = await agentReviewStartService
      .reviewAgain(review.id, s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewAgainNotOfferedError);
    expect((refused as InstanceType<typeof ReviewAgainNotOfferedError>).reason).toBe('source_own');
    expect(reviewRequests()).toEqual([]);
  });
});

/** Like {@link reviewing}, with the project's source set before the review is raised. */
async function reviewingUnder(source: 'hosted' | 'own', slug: string, number: number) {
  const s = await makeScenario(slug);
  await setSource(s, source);
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
  expect(review, 'the green verdict raised the review under either source').toBeDefined();
  const [request] = reviewRequests();
  expect(request, 'the raise requests a start under either source').toBeDefined();
  sent.length = 0;
  return { s, item, review: review!, request: request! };
}

// ── The source switch with a review awaiting ──────────────────────────────────

describe('switching the source with a review awaiting', () => {
  it('hosted → own cancels the in-flight run after commit, clears the reason, and leaves the gate awaiting', async () => {
    const { s, review, run } = await reviewingInFlight('to-own', 71);
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });

    await setSource(s, 'own');

    expect((await runRow(run.id)).status).toBe('cancelled');
    const gate = await gateRow(review.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.subjectVersion).toBe(review.subjectVersion);
    expect(gate.reviewUnavailableReason).toBeNull();
    expect(reviewRequests()).toEqual([]);

    // The cancelled run's end does not write no_verdict back onto the awaiting gate.
    await hostedRunService.endHostedRun(run.id, 'exited', 'the container exited 0');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
  });

  it('a rolled-back hosted → own switch cancels nothing and writes nothing', async () => {
    const { s, review, run } = await reviewingInFlight('rollback', 72);
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });
    vi.spyOn(approvalGateRepository, 'setReviewUnavailableReason').mockRejectedValueOnce(
      new Error('boom'),
    );

    await expect(setSource(s, 'own')).rejects.toThrow('boom');

    expect((await runRow(run.id)).status).toBe('running');
    expect((await projectRow(s.project.id)).reviewAgentSource).toBe('hosted');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');
  });

  it('own → hosted requests ONE start per awaiting gate under a fresh key, and it starts a run', async () => {
    const { s, review } = await reviewingUnder('own', 'to-hosted', 73);

    await setSource(s, 'hosted');

    const requests = reviewRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      gateId: review.id,
      subjectVersion: review.subjectVersion,
      workspaceId: s.workspace.id,
    });
    expect(requests[0]!.idempotencyKey).toMatch(new RegExp(`^agent-review:${review.id}:source:`));
    expect((await agentReviewStartService.startRequested(requests[0]!)).outcome).toBe('started');
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('a gate whose run an earlier switch cancelled starts again on the way back to hosted', async () => {
    const { s, review, run } = await reviewingInFlight('round-trip', 74);
    await setSource(s, 'own');
    expect((await runRow(run.id)).status).toBe('cancelled');

    await setSource(s, 'hosted');
    const [request] = reviewRequests();
    expect(request).toBeDefined();
    expect(request!.gateId).toBe(review.id);
    expect((await agentReviewStartService.startRequested(request!)).outcome).toBe('started');

    const runs = await runRows(s.workspace.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status).toBe('running');
    expect(runs[1]!.idempotencyKey).toBe(request!.idempotencyKey);
  });

  it('switching to the source already set starts and cancels nothing', async () => {
    const { s, run } = await reviewingInFlight('same-source', 75);
    await setSource(s, 'hosted');
    expect(reviewRequests()).toEqual([]);
    expect((await runRow(run.id)).status).toBe('running');
  });

  it('a source switch with the agent off acts on no gate', async () => {
    const { s, review } = await reviewingUnder('own', 'switch-off-agent', 76);
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false, reviewAgentSource: 'hosted' },
      s.ctx,
    );
    expect((await gateRow(review.id)).state).toBe('superseded');
    expect(reviewRequests()).toEqual([]);
  });

  it('disabling the agent under source own retires the awaiting review, as under hosted', async () => {
    const { s, review } = await reviewingUnder('own', 'disable-own', 77);
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );
    expect((await gateRow(review.id)).state).toBe('superseded');
    expect((await projectRow(s.project.id)).reviewAgentSource).toBe('own');
  });
});

// ── §12.2a — the exclusion with Merge automatically, under both sources ───────

describe('the review agent and Merge automatically exclude each other under either source (§12.2a)', () => {
  it.each(['hosted', 'own'] as const)('source %s: both refusals fire', async (source) => {
    const s = await makeScenario(`exclusion-${source}`);
    await setSource(s, source);

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
    expect(await projectRow(s.project.id)).toMatchObject({
      reviewAgentEnabled: false,
      prMergeMode: 'auto',
      reviewAgentSource: source,
    });
  });
});
