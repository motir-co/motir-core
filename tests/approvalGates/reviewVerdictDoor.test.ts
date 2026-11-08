import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { TOOL_PAYLOADS } from '@/lib/mcp/payloads/registry';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE USER-TOKEN VERDICT DOOR (Story MOTIR-10327 · MOTIR-10333; `approval-gates.md`
// §12.11–§12.14), against REAL Postgres — `reviewVerdictService.submit` behind the MCP
// tool `submit_review_verdict` and `POST /api/v1/work-items/{key}/review-verdict`.
//
// The review is raised by the real webhook-driven green verdict, a hosted run starts on
// the fake orchestrator, and motir-ai, the gateway and GitHub are stubbed at their HTTP
// seam, as `tests/approvalGates/reviewAgentSource.test.ts` stubs them. The cases a
// plausible wrong door passes are the ones pinned hardest:
//   - a gate-off send-back must WITHDRAW the approve-and-merge question and keep it
//     withdrawn on a CI redelivery at the same head — and a push must bring it back;
//   - a late or second verdict is STORED and decides nothing;
//   - two concurrent verdicts leave exactly ONE answering row.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { reviewVerdictService } = await import('@/lib/services/reviewVerdictService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const {
  ReviewNothingToReviewError,
  ReviewTargetNotRunTargetError,
  ReviewVerdictInvalidError,
  ReviewVerdictLateError,
  ReviewVerdictSecondError,
} = await import('@/lib/agentReview/errors');
const {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
} = await import('@/lib/approvalGates/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');
const { runSubmitReviewVerdict, registerSubmitReviewVerdict, SUBMIT_REVIEW_VERDICT_TOOL_NAME } =
  await import('@/lib/mcp/tools/submitReviewVerdict');
const verdictRoute = await import('@/app/api/v1/work-items/[key]/review-verdict/route');

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

const PR_APPROVAL = 'pull_request_approval' as const;

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

const versionOf = (number: number, sha = 'sha-a') => `moooon/acme#${number}@${sha}`;

const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');

const recordsOf = (workItemId: string) =>
  adminDb.reviewVerdictRecord.findMany({
    where: { workItemId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

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

async function post(headers: Record<string, string>, key: string, body: unknown) {
  return verdictRoute.POST(
    new Request(`https://app.test/api/v1/work-items/${key}/review-verdict`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

const patFor = (s: Awaited<ReturnType<typeof makeScenario>>) =>
  withTokenFor(s.user as never, s.workspace as never, {
    projectId: s.project.id,
    scopes: ['read', 'work_items:write'],
  });

// ── Gate ON ───────────────────────────────────────────────────────────────────

describe('gate ON — the verdict decides the awaiting review', () => {
  it('source own: approved decides the gate by the review agent and raises approve-and-merge', async () => {
    const { s, item, review } = await reviewingUnder('own', 'on-own-pass', 71);
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(71)),
      s.ctx,
    );
    expect(dto).toMatchObject({
      key: item.identifier,
      outcome: 'decided',
      verdict: 'approved',
      subjectVersion: versionOf(71),
      gateId: review.id,
      withdrewApprovalGateIds: [],
    });
    const gate = await gateRow(review.id);
    expect(gate.state).toBe('approved');
    expect(gate.decidedUnderAuthority).toBe('review_agent');
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);

    const [record] = await recordsOf(item.id);
    expect(record).toMatchObject({
      id: dto.recordId,
      outcome: 'decided',
      verdict: 'pass',
      gateId: review.id,
      submittedById: s.user.id,
      authority: 'review_agent',
      harness: 'Claude Code',
      model: 'claude-opus-5-5',
      summaryMd: 'Looks right.',
      checklist: [
        { key: null, criterion: 'The button exports', status: 'met', evidence: 'export.test.ts' },
      ],
    });
  });

  it('source hosted: the verdict decides the gate and cancels the hosted run still reviewing it', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'on-hosted', 72);
    const [run] = await runRows(s.workspace.id);
    expect(run!.status).toBe('running');

    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(72)),
      s.ctx,
    );
    expect(dto).toMatchObject({ outcome: 'decided', verdict: 'changes_requested' });
    expect((await gateRow(review.id)).state).toBe('changes_requested');
    expect((await runRow(run!.id)).status).toBe('cancelled');
    // A send-back raises no approve-and-merge question, and the card is To fix.
    expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });

  it('a second verdict on the decided version is stored as second and refused', async () => {
    const { s, item, review } = await reviewingUnder('own', 'on-second', 73);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(73)), s.ctx);
    const refused = await reviewVerdictService
      .submit(s.project.id, item.identifier, sendBack(versionOf(73)), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewVerdictSecondError);
    expect((await gateRow(review.id)).state).toBe('approved');
    expect((await recordsOf(item.id)).map((r) => [r.outcome, r.gateId])).toEqual([
      ['decided', review.id],
      ['second', review.id],
    ]);
  });

  it('two concurrent verdicts: one decides, the other is stored as second', async () => {
    const { s, item, review } = await reviewingUnder('own', 'on-race', 74);
    const results = await Promise.allSettled([
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(74)), s.ctx),
      reviewVerdictService.submit(s.project.id, item.identifier, sendBack(versionOf(74)), s.ctx),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ReviewVerdictSecondError);
    const outcomes = (await recordsOf(item.id)).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['decided', 'second']);
    expect(['approved', 'changes_requested']).toContain((await gateRow(review.id)).state);
  });

  it('a gate the door finds already decided is stored as second', async () => {
    const { s, item, review } = await reviewingUnder('own', 'on-lost', 75);
    vi.spyOn(approvalGatesService, 'decideAgentReview').mockRejectedValueOnce(
      new ApprovalGateAlreadyDecidedError(review.id, 'approved', null, null, null),
    );
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(75)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewVerdictSecondError);
    expect((await recordsOf(item.id)).map((r) => r.outcome)).toEqual(['second']);
  });

  it.each([
    ['superseded', (id: string) => new ApprovalGateSupersededError(id)],
    ['stale', (id: string) => new ApprovalGateStaleSubjectError(id, ['pull_requests'])],
  ])('a gate %s between the read and the decide is stored as late', async (_label, make) => {
    const { s, item, review } = await reviewingUnder('own', `on-moved-${_label}`, 76);
    vi.spyOn(approvalGatesService, 'decideAgentReview').mockRejectedValueOnce(make(review.id));
    const refused = await reviewVerdictService
      .submit(s.project.id, item.identifier, input(versionOf(76)), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewVerdictLateError);
    expect((refused as InstanceType<typeof ReviewVerdictLateError>).currentVersion).toBeNull();
    expect((await recordsOf(item.id)).map((r) => [r.outcome, r.gateId])).toEqual([
      ['late', review.id],
    ]);
    expect((await gateRow(review.id)).state).toBe('awaiting');
  });

  it('an unexpected decide failure propagates and stores nothing', async () => {
    const { s, item } = await reviewingUnder('own', 'on-boom', 77);
    vi.spyOn(approvalGatesService, 'decideAgentReview').mockRejectedValueOnce(new Error('boom'));
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(77)), s.ctx),
    ).rejects.toThrow('boom');
    expect(await recordsOf(item.id)).toEqual([]);
  });
});

// ── Gate OFF ──────────────────────────────────────────────────────────────────

describe('gate OFF — the verdict is the record', () => {
  it('approved is recorded and moves nothing', async () => {
    const { s, item, approval } = await deliveredGateOff('off-pass', 81);
    const before = await itemRow(item.id);
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(81)),
      s.ctx,
    );
    expect(dto).toMatchObject({ outcome: 'recorded', gateId: null, withdrewApprovalGateIds: [] });
    expect((await gateRow(approval.id)).state).toBe('awaiting');
    const after = await itemRow(item.id);
    expect(after.status).toBe(before.status);
    expect(after.fixReason).toBeNull();
  });

  it('changes_requested withdraws approve-and-merge, puts the card To fix, and a CI redelivery does not re-raise it', async () => {
    const { s, item, approval } = await deliveredGateOff('off-back', 82);
    const before = await itemRow(item.id);
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(82)),
      s.ctx,
    );
    expect(dto).toMatchObject({
      outcome: 'recorded',
      verdict: 'changes_requested',
      withdrewApprovalGateIds: [approval.id],
    });
    const withdrawn = await gateRow(approval.id);
    expect(withdrawn.state).toBe('superseded');
    expect(withdrawn.supersededCause).toBe('agent_changes_requested');
    const after = await itemRow(item.id);
    expect(after.status, 'no status moves').toBe(before.status);
    expect(after.fixReason).toBe('changes_requested');

    // The same head, green again: the send-back still stands.
    await ci('sha-a', 82);
    expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);

    // A push ends it: the new head asks to approve and merge again.
    await pushTo(item.identifier, 82, 'sha-b');
    // The host says the new head still merges (MOTIR-7063) — until then nobody is asked.
    await hostAnswersCleanAt(s.workspace.id, 82, 'sha-b');
    await ci('sha-b', 82);
    const raised = await awaitingOf(item.id, PR_APPROVAL);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.subjectVersion).toBe(versionOf(82, 'sha-b'));
    expect((await itemRow(item.id)).fixReason).toBeNull();
  });

  it('changes_requested also withdraws a waiting story-run acceptance video beside the merge gate', async () => {
    const { s, item, approval } = await deliveredGateOff('off-back-video', 86);
    const video = await adminDb.approvalGate.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: item.id,
        kind: 'acceptance_result',
        subjectId: 'receipt-86',
        subjectVersion: 'sha-a',
        state: 'awaiting',
      },
    });

    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(86)),
      s.ctx,
    );

    expect([...dto.withdrewApprovalGateIds].sort()).toEqual([approval.id, video.id].sort());
    expect(await gateRow(video.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'agent_changes_requested',
    });
  });

  it('a second verdict at a recorded version is stored as second', async () => {
    const { s, item } = await deliveredGateOff('off-second', 83);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(83)), s.ctx);
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, sendBack(versionOf(83)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewVerdictSecondError);
    expect((await recordsOf(item.id)).map((r) => r.outcome)).toEqual(['recorded', 'second']);
  });

  it('two concurrent verdicts leave exactly one answering row', async () => {
    const { s, item } = await deliveredGateOff('off-race', 84);
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(84)), s.ctx),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ReviewVerdictSecondError);
    }
    const outcomes = (await recordsOf(item.id)).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['recorded', 'second', 'second']);
  });

  it('a late verdict is stored as late, decides nothing, and names the current version', async () => {
    const { s, item, approval } = await deliveredGateOff('off-late', 85);
    const refused = await reviewVerdictService
      .submit(s.project.id, item.identifier, sendBack(versionOf(85, 'sha-old')), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewVerdictLateError);
    expect((refused as InstanceType<typeof ReviewVerdictLateError>).currentVersion).toBe(
      versionOf(85),
    );
    expect((await recordsOf(item.id)).map((r) => [r.outcome, r.subjectVersion])).toEqual([
      ['late', versionOf(85, 'sha-old')],
    ]);
    expect((await gateRow(approval.id)).state).toBe('awaiting');
  });
});

// ── Refusals before anything is stored ────────────────────────────────────────

describe('refusals that store nothing', () => {
  it('a card that delivers no pull request has nothing to review', async () => {
    const s = await makeScenario('nothing');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Bare' },
      s.ctx,
    );
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input('x/y#1@z'), s.ctx),
    ).rejects.toBeInstanceOf(ReviewNothingToReviewError);
    expect(await recordsOf(item.id)).toEqual([]);
  });

  it('a card tested through its story names the story to review instead', async () => {
    const s = await makeScenario('ancestor');
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
    const refused = await reviewVerdictService
      .submit(s.project.id, child.identifier, input('x/y#1@z'), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewTargetNotRunTargetError);
    expect((refused as Error).message).toContain(story.identifier);
    expect(await recordsOf(child.id)).toEqual([]);
  });

  it('a viewer without work_item:edit is refused', async () => {
    const { s, item } = await deliveredGateOff('viewer', 86);
    const viewer = await createTestUser({ name: 'viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: s.workspace.id });
    await addToProjectAs({
      key: 'ACME',
      actorUserId: s.user.id,
      ctx: s.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(86)), {
        userId: viewer.id,
        workspaceId: s.workspace.id,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await recordsOf(item.id)).toEqual([]);
  });

  it('a teammate who is not the assignee may submit', async () => {
    const { s, item } = await deliveredGateOff('teammate', 87);
    const mate = await createTestUser({ name: 'mate' });
    await workspacesService.addMember({ userId: mate.id, workspaceId: s.workspace.id });
    await addToProjectAs({
      key: 'ACME',
      actorUserId: s.user.id,
      ctx: s.ctx,
      targetUserId: mate.id,
      role: 'member',
    });
    const dto = await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      input(versionOf(87)),
      { userId: mate.id, workspaceId: s.workspace.id },
    );
    expect(dto.outcome).toBe('recorded');
    expect((await recordsOf(item.id))[0]!.submittedById).toBe(mate.id);
  });

  it('another workspace cannot see the card', async () => {
    const { s, item } = await deliveredGateOff('tenant', 88);
    const other = await createTestUser({ name: 'other' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: other.id,
    });
    await expect(
      reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(88)), {
        userId: other.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toThrow();
    expect(await recordsOf(item.id)).toEqual([]);
  });

  it.each<[string, Partial<SubmitReviewVerdictInput>, string]>([
    ['an empty version', { subjectVersion: '  ' }, 'subjectVersion'],
    ['an empty harness', { harness: ' ' }, 'harness'],
    ['an over-long model', { model: 'm'.repeat(201) }, 'model'],
    [
      'a send-back without findings',
      { verdict: 'changes_requested', findingsMd: ' ' },
      'findingsMd',
    ],
    [
      'too many checklist rows',
      {
        checklist: Array.from({ length: 201 }, () => ({
          key: null,
          criterion: 'c',
          status: 'not_met' as const,
          evidence: null,
        })),
      },
      'checklist',
    ],
    [
      'an empty criterion',
      { checklist: [{ key: null, criterion: ' ', status: 'not_met', evidence: null }] },
      'checklist.0.criterion',
    ],
    [
      'an unknown checklist status',
      {
        checklist: [
          { key: null, criterion: 'c', status: 'maybe' as unknown as 'met', evidence: null },
        ],
      },
      'checklist.0.status',
    ],
    [
      'a met row without evidence',
      { checklist: [{ key: null, criterion: 'c', status: 'met', evidence: '' }] },
      'checklist.0.evidence',
    ],
  ])('the service refuses %s', async (_label, over, field) => {
    const { s, item } = await deliveredGateOff(`invalid-${field}-${_label.length}`, 89);
    const refused = await reviewVerdictService
      .submit(s.project.id, item.identifier, input(versionOf(89), over), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewVerdictInvalidError);
    expect((refused as InstanceType<typeof ReviewVerdictInvalidError>).field).toBe(field);
    expect(await recordsOf(item.id)).toEqual([]);
  });
});

// ── The hosted run writes a record too ────────────────────────────────────────

describe('the hosted run’s own verdict', () => {
  it('a hosted run’s verdict through its run-token route lands in the same history', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'hosted-record', 91);
    const [run] = await runRows(s.workspace.id);
    const { runCredentialService } = await import('@/lib/services/runCredentialService');
    const { token } = await runCredentialService.mintRunCredential({
      dispatchRunId: run!.id,
      dispatcherUserId: s.user.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const { POST } = await import('@/app/api/v1/work-items/[key]/agent-review/route');
    const res = await POST(
      new Request(`https://app.test/api/v1/work-items/${item.identifier}/agent-review`, {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectVersion: versionOf(91),
          verdict: 'pass',
          summaryMd: 'Fine.',
        }),
      }),
      { params: Promise.resolve({ key: item.identifier }) },
    );
    expect(res.status).toBe(200);
    const [record] = await recordsOf(item.id);
    expect(record).toMatchObject({
      outcome: 'decided',
      verdict: 'pass',
      gateId: review.id,
      harness: 'Motir hosted review',
      checklist: [],
    });
  });
});

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

describe('the hosted run’s late and second verdicts', () => {
  it('a hosted verdict about an old version is recorded late', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'hosted-late', 101);
    const res = await hostedSubmit(s, item.identifier, {
      subjectVersion: versionOf(101, 'sha-old'),
      verdict: 'pass',
      summaryMd: 'Fine.',
    });
    expect(res.status).toBe(409);
    expect((await recordsOf(item.id)).map((r) => [r.outcome, r.gateId])).toEqual([
      ['late', review.id],
    ]);
  });

  it('a hosted verdict on a review already decided is recorded second', async () => {
    const { s, item, review } = await reviewingUnder('hosted', 'hosted-second', 102);
    await approvalGatesService.decideAgentReview(
      { gateId: review.id, subjectVersion: versionOf(102), verdict: 'pass', noteMd: 'ok' },
      s.ctx,
    );
    const res = await hostedSubmit(s, item.identifier, {
      subjectVersion: versionOf(102),
      verdict: 'changes_requested',
      findingsMd: 'late thought',
    });
    expect(res.status).toBe(409);
    expect((await recordsOf(item.id)).map((r) => r.outcome)).toEqual(['second']);
  });
});

describe('the record repository', () => {
  it('lists a card’s history newest first, and rethrows a failure that is not the one-answer rule', async () => {
    const { s, item } = await deliveredGateOff('repo', 103);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(103)), s.ctx);
    await reviewVerdictService
      .submit(s.project.id, item.identifier, input(versionOf(103)), s.ctx)
      .catch(() => undefined);
    const { reviewVerdictRecordRepository } =
      await import('@/lib/repositories/reviewVerdictRecordRepository');
    const { withWorkspaceContext } = await import('@/lib/workspaces/context');
    const history = await withWorkspaceContext(s.ctx, (tx) =>
      reviewVerdictRecordRepository.listByWorkItem(item.id, tx),
    );
    expect(history.map((r) => r.outcome)).toEqual(['second', 'recorded']);

    await expect(
      withWorkspaceContext(s.ctx, (tx) =>
        reviewVerdictRecordRepository.create(
          {
            workspaceId: s.workspace.id,
            projectId: s.project.id,
            workItemId: 'no-such-card',
            gateId: null,
            subjectVersion: 'v',
            verdict: 'pass',
            outcome: 'late',
            summaryMd: null,
            findingsMd: null,
            checklist: [],
            submittedById: null,
            harness: 'h',
            model: 'm',
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
  });
});

// ── The transports ────────────────────────────────────────────────────────────

describe('POST /api/v1/work-items/{key}/review-verdict', () => {
  it('a PAT holder’s verdict is recorded and presented', async () => {
    const { s, item } = await deliveredGateOff('rest-ok', 92);
    const pat = await patFor(s);
    const res = await post(pat.headers, item.identifier, {
      verdict: 'approved',
      subjectVersion: versionOf(92),
      checklist: [{ criterion: 'It exports', status: 'met', evidence: 'the test' }],
      harness: 'Codex',
      model: 'gpt-x',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      key: item.identifier,
      outcome: 'recorded',
      verdict: 'approved',
      gateId: null,
      withdrewApprovalGateIds: [],
    });
    expect(typeof body['submittedAt']).toBe('string');
  });

  it.each([
    ['a send-back without findings', { verdict: 'changes_requested' }],
    ['a met row without evidence', { checklist: [{ criterion: 'c', status: 'met' }] }],
    ['an unknown field', { extra: true }],
  ])('refuses %s with 422 and stores nothing', async (_label, over) => {
    const { s, item } = await deliveredGateOff(`rest-bad-${_label.length}`, 93);
    const pat = await patFor(s);
    const res = await post(pat.headers, item.identifier, {
      verdict: 'approved',
      subjectVersion: versionOf(93),
      harness: 'Codex',
      model: 'gpt-x',
      ...over,
    });
    expect(res.status).toBe(422);
    expect(await recordsOf(item.id)).toEqual([]);
  });

  it('a late verdict answers 409 REVIEW_VERDICT_LATE', async () => {
    const { s, item } = await deliveredGateOff('rest-late', 94);
    const pat = await patFor(s);
    const res = await post(pat.headers, item.identifier, {
      verdict: 'approved',
      subjectVersion: versionOf(94, 'sha-old'),
      harness: 'Codex',
      model: 'gpt-x',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('REVIEW_VERDICT_LATE');
  });

  it('a run token is not accepted here', async () => {
    const { s, item } = await reviewingUnder('hosted', 'rest-run-token', 95);
    const [run] = await runRows(s.workspace.id);
    const { runCredentialService } = await import('@/lib/services/runCredentialService');
    const { token } = await runCredentialService.mintRunCredential({
      dispatchRunId: run!.id,
      dispatcherUserId: s.user.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const res = await post(bearer(token), item.identifier, {
      verdict: 'approved',
      subjectVersion: versionOf(95),
      harness: 'Codex',
      model: 'gpt-x',
    });
    expect(res.status).toBe(403);
    expect(await recordsOf(item.id)).toEqual([]);
  });
});

describe('the MCP tool submit_review_verdict', () => {
  const textOf = (res: { content: unknown }) =>
    (res.content as Array<{ type: string; text: string }>)[0]!.text;

  it('a send-back answers the payload and the prose', async () => {
    const { s, item, approval } = await deliveredGateOff('mcp-back', 96);
    const res = await runSubmitReviewVerdict(
      {
        key: item.identifier,
        verdict: 'changes_requested',
        subjectVersion: versionOf(96),
        findingsMd: '- `a.ts:1` is wrong',
        checklist: [{ criterion: 'It exports', status: 'not_met' }],
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      s.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      outcome: 'recorded',
      verdict: 'changes_requested',
      withdrewApprovalGateIds: [approval.id],
    });
    expect(textOf(res)).toContain('To fix');
    expect(textOf(res)).toContain('withdrawn');
    // The tool's payload IS v1's `ReviewVerdictResult`: the drift guard finds no drift.
    expect(checkPayloadDrift(TOOL_PAYLOADS.submit_review_verdict!, res.structuredContent)).toEqual(
      [],
    );
  });

  it('a gate-on approval says a person still approves the merge', async () => {
    const { s, item, review } = await reviewingUnder('own', 'mcp-pass', 97);
    const res = await runSubmitReviewVerdict(
      {
        key: item.identifier,
        verdict: 'approved',
        subjectVersion: versionOf(97),
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      s.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`decided the review gate ${review.id}`);
    expect(textOf(res)).toContain('A person still approves the merge');
  });

  it('a gate-off send-back with nothing to withdraw says no status moved', async () => {
    const { s, item } = await deliveredGateOff('mcp-nothing', 98);
    await adminDb.approvalGate.updateMany({
      where: { workItemId: item.id, kind: PR_APPROVAL },
      data: { state: 'superseded', supersededCause: 'set_changed' },
    });
    const res = await runSubmitReviewVerdict(
      {
        key: item.identifier,
        verdict: 'changes_requested',
        subjectVersion: versionOf(98),
        findingsMd: 'fix it',
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      s.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('no status moved.');
    expect(textOf(res)).not.toContain('withdrawn');
  });

  it('the door’s refusals answer their own codes; other failures map generically', async () => {
    const { s, item } = await deliveredGateOff('mcp-refuse', 99);
    const base = {
      key: item.identifier,
      verdict: 'approved' as const,
      harness: 'Claude Code',
      model: 'claude-opus-5-5',
    };
    const late = await runSubmitReviewVerdict(
      { ...base, subjectVersion: versionOf(99, 'sha-old') },
      s.ctx,
    );
    expect(late.isError).toBe(true);
    expect(textOf(late)).toMatch(/^REVIEW_VERDICT_LATE: /);

    await runSubmitReviewVerdict({ ...base, subjectVersion: versionOf(99) }, s.ctx);
    const second = await runSubmitReviewVerdict({ ...base, subjectVersion: versionOf(99) }, s.ctx);
    expect(textOf(second)).toMatch(/^REVIEW_VERDICT_SECOND: /);

    const invalid = await runSubmitReviewVerdict(
      { ...base, subjectVersion: versionOf(99), verdict: 'changes_requested' },
      s.ctx,
    );
    expect(textOf(invalid)).toMatch(/^INVALID_REVIEW_VERDICT: /);

    const missing = await runSubmitReviewVerdict(
      { ...base, key: 'ACME-9999', subjectVersion: versionOf(99) },
      s.ctx,
    );
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).not.toMatch(/^REVIEW_/);
  });

  it('a card with nothing to review, and one tested through its story', async () => {
    const s = await makeScenario('mcp-targets');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
    const base = {
      verdict: 'approved' as const,
      subjectVersion: 'x/y#1@z',
      harness: 'Claude Code',
      model: 'claude-opus-5-5',
    };
    const nothing = await runSubmitReviewVerdict({ ...base, key: child.identifier }, s.ctx);
    expect(textOf(nothing)).toMatch(/^REVIEW_NOTHING_TO_REVIEW: /);
    await adminDb.testInstructions.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: story.id,
        bodyMd: '## Open the page',
      },
    });
    const ancestor = await runSubmitReviewVerdict({ ...base, key: child.identifier }, s.ctx);
    expect(textOf(ancestor)).toMatch(/^REVIEW_TARGET_NOT_RUN_TARGET: /);
  });

  it('registers under its name and hands the resolved context to the runner', async () => {
    const { s, item } = await deliveredGateOff('mcp-register', 100);
    let handler: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (name: string, _config: unknown, cb: typeof handler) => {
        expect(name).toBe(SUBMIT_REVIEW_VERDICT_TOOL_NAME);
        handler = cb;
      },
    } as unknown as McpServer;
    registerSubmitReviewVerdict(server, () => s.ctx);
    const res = (await handler!(
      {
        key: item.identifier,
        verdict: 'approved',
        subjectVersion: versionOf(100),
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      {},
    )) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });
});
