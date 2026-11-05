import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DISMISS THE REVIEW (Story MOTIR-10327 · MOTIR-10334; `approval-gates.md` §12.15),
// against REAL Postgres — `reviewDismissalService.dismiss` behind
// `POST /api/v1/work-items/{key}/review-dismissal`. The send-backs it dismisses are made
// through the real doors (the user-token verdict door, the hosted run's route), the review
// is raised by the real webhook-driven green verdict, and motir-ai, the gateway and GitHub
// are stubbed at their HTTP seam, as `reviewVerdictDoor.test.ts` stubs them.
//
// What a plausible wrong Dismiss passes, pinned hardest:
//   - the approve-and-merge gate must come back AT THE SAME VERSION, through the one
//     reconcile path, while the withdrawn one stays superseded and the send-back row is
//     untouched;
//   - a dismissal belongs to its version: a push and a new send-back stand again;
//   - nothing is written, and no event is sent, on any refusal or a rollback.

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
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { reviewVerdictService } = await import('@/lib/services/reviewVerdictService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { PermissionDeniedError } = await import('@/lib/projects/errors');
const { reviewDismissalService } = await import('@/lib/services/reviewDismissalService');
const { reviewDismissalRepository } = await import('@/lib/repositories/reviewDismissalRepository');
const {
  ReviewDismissalForbiddenError,
  ReviewDismissalReasonRequiredError,
  ReviewDismissalStaleError,
  ReviewSendBackAlreadyDismissedError,
  ReviewSendBackNotStandingError,
} = await import('@/lib/agentReview/errors');
const dismissalRoute = await import('@/app/api/v1/work-items/[key]/review-dismissal/route');

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

async function post(headers: Record<string, string>, key: string, body: unknown) {
  return dismissalRoute.POST(
    new Request(`https://app.test/api/v1/work-items/${key}/review-dismissal`, {
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

// ── Dismissal helpers ─────────────────────────────────────────────────────────

const dismissalsOf = (workItemId: string) =>
  adminDb.reviewDismissal.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const dismissedEvents = () => sent.filter((e) => e.name === 'review/dismissed');

const why = (version: string, reasonMd = 'The criterion is out of scope for this card.') => ({
  subjectVersion: version,
  reasonMd,
});

/** A gate-off card the review agent sent back at `sha-a` through the user-token door. */
async function sentBackGateOff(slug: string, number: number) {
  const scenario = await deliveredGateOff(slug, number);
  const { s, item } = scenario;
  const dto = await reviewVerdictService.submit(
    s.project.id,
    item.identifier,
    sendBack(versionOf(number)),
    s.ctx,
  );
  expect(dto.withdrewApprovalGateIds).toEqual([scenario.approval.id]);
  expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  sent.length = 0;
  return { ...scenario, recordId: dto.recordId };
}

/** A gate-on card whose awaiting review was decided `changes_requested`. */
async function sentBackGateOn(source: 'hosted' | 'own', slug: string, number: number) {
  const scenario = await reviewingUnder(source, slug, number);
  const { s, item } = scenario;
  if (source === 'own') {
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(number)),
      s.ctx,
    );
  } else {
    const res = await hostedSubmit(s, item.identifier, {
      subjectVersion: versionOf(number),
      verdict: 'changes_requested',
      findingsMd: '- `lib/export.ts:12` drops the header row.',
    });
    expect(res.status).toBe(200);
  }
  expect((await gateRow(scenario.review.id)).state).toBe('changes_requested');
  expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);
  expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  sent.length = 0;
  return scenario;
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

// ── Dismissing ────────────────────────────────────────────────────────────────

describe('dismissing a standing send-back', () => {
  it('gate off: the record stays, To fix clears, and approve-and-merge is asked again at the same version', async () => {
    const { s, item, approval, recordId } = await sentBackGateOff('off', 71);
    const recordBefore = await adminDb.reviewVerdictRecord.findUniqueOrThrow({
      where: { id: recordId },
    });
    const statusBefore = (await itemRow(item.id)).status;

    const dto = await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      why(versionOf(71), '  Out of scope.  '),
      s.ctx,
    );

    expect(dto).toMatchObject({
      key: item.identifier,
      subjectVersion: versionOf(71),
      dismissed: { kind: 'record', id: recordId },
      reasonMd: 'Out of scope.',
      dismissedBy: { id: s.user.id, name: 'Owner' },
    });
    const [row] = await dismissalsOf(item.id);
    expect(row).toMatchObject({
      id: dto.dismissalId,
      reviewVerdictRecordId: recordId,
      approvalGateId: null,
      dismissedById: s.user.id,
      reasonMd: 'Out of scope.',
    });
    // The send-back row is untouched, and the withdrawn gate stays superseded as history.
    expect(
      await adminDb.reviewVerdictRecord.findUniqueOrThrow({ where: { id: recordId } }),
    ).toEqual(recordBefore);
    expect((await gateRow(approval.id)).supersededCause).toBe('agent_changes_requested');
    // A FRESH approve-and-merge gate, at the very same version.
    const fresh = await awaitingOf(item.id, PR_APPROVAL);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(approval.id);
    expect(fresh[0]!.subjectVersion).toBe(versionOf(71));
    expect(dto.approvalGateId).toBe(fresh[0]!.id);
    const after = await itemRow(item.id);
    expect(after.fixReason).toBeNull();
    expect(after.status, 'no status moves').toBe(statusBefore);
    // One event, after commit.
    expect(dismissedEvents().map((e) => e.data)).toEqual([
      {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: item.id,
        subjectVersion: versionOf(71),
        dismissalId: dto.dismissalId,
      },
    ]);
    // The read the review line consumes names who, why and when.
    const { withWorkspaceContext } = await import('@/lib/workspaces/context');
    const listed = await withWorkspaceContext(s.ctx, (tx) =>
      reviewDismissalRepository.listByWorkItem(item.id, tx),
    );
    expect(listed.map((d) => [d.reasonMd, d.dismissedBy?.name])).toEqual([
      ['Out of scope.', 'Owner'],
    ]);
  });

  it.each(['own', 'hosted'] as const)(
    'gate on, source %s: the decided review stays, and approve-and-merge is asked at the same version',
    async (source) => {
      const { s, item, review } = await sentBackGateOn(source, `on-${source}`, 72);
      const dto = await reviewDismissalService.dismiss(
        s.project.id,
        item.identifier,
        why(versionOf(72)),
        s.ctx,
      );
      expect(dto.dismissed).toEqual({ kind: 'gate', id: review.id });
      expect((await gateRow(review.id)).state).toBe('changes_requested');
      const fresh = await awaitingOf(item.id, PR_APPROVAL);
      expect(fresh.map((g) => g.subjectVersion)).toEqual([versionOf(72)]);
      expect(dto.approvalGateId).toBe(fresh[0]!.id);
      // No second review of commits already reviewed.
      expect(await awaitingOf(item.id, REVIEW)).toEqual([]);
      expect((await itemRow(item.id)).fixReason).toBeNull();
      expect(dismissedEvents()).toHaveLength(1);
      // A CI redelivery at the same head asks nothing more.
      await ci('sha-a', 72);
      expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
    },
  );

  it('a dismissal belongs to its version: a push and a new send-back stand until dismissed on their own', async () => {
    const { s, item } = await sentBackGateOff('head-move', 73);
    await reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(73)), s.ctx);

    await pushTo(item.identifier, 73, 'sha-b');
    await hostAnswersCleanAt(s.workspace.id, 73, 'sha-b');
    await ci('sha-b', 73);
    const atB = await awaitingOf(item.id, PR_APPROVAL);
    expect(atB.map((g) => g.subjectVersion)).toEqual([versionOf(73, 'sha-b')]);

    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      sendBack(versionOf(73, 'sha-b')),
      s.ctx,
    );
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
    expect(await awaitingOf(item.id, PR_APPROVAL)).toEqual([]);

    // The old version's dismissal is refused as stale — it does not reach the new one.
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(73)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewDismissalStaleError);

    await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      why(versionOf(73, 'sha-b')),
      s.ctx,
    );
    expect((await dismissalsOf(item.id)).map((d) => d.subjectVersion)).toEqual([
      versionOf(73),
      versionOf(73, 'sha-b'),
    ]);
    expect((await itemRow(item.id)).fixReason).toBeNull();
    expect((await awaitingOf(item.id, PR_APPROVAL)).map((g) => g.subjectVersion)).toEqual([
      versionOf(73, 'sha-b'),
    ]);
  });

  it('two concurrent dismissals leave exactly one row and one event', async () => {
    const { s, item } = await sentBackGateOff('race', 74);
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(74)), s.ctx),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        ReviewSendBackAlreadyDismissedError,
      );
    }
    expect(await dismissalsOf(item.id)).toHaveLength(1);
    expect(dismissedEvents()).toHaveLength(1);
    expect(await awaitingOf(item.id, PR_APPROVAL)).toHaveLength(1);
  });

  it('the unique index refuses a second row even when the read before it missed the first', async () => {
    const { s, item } = await sentBackGateOff('backstop', 75);
    await reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(75)), s.ctx);
    const [first] = await dismissalsOf(item.id);
    const { withWorkspaceContext } = await import('@/lib/workspaces/context');
    await expect(
      withWorkspaceContext(s.ctx, (tx) =>
        reviewDismissalRepository.create(
          {
            workspaceId: s.workspace.id,
            projectId: s.project.id,
            workItemId: item.id,
            reviewVerdictRecordId: first!.reviewVerdictRecordId,
            approvalGateId: null,
            subjectVersion: versionOf(75),
            reasonMd: 'again',
            dismissedById: s.user.id,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ReviewSendBackAlreadyDismissedError);
    // And a row naming neither send-back is refused by the CHECK.
    await expect(
      withWorkspaceContext(s.ctx, (tx) =>
        reviewDismissalRepository.create(
          {
            workspaceId: s.workspace.id,
            projectId: s.project.id,
            workItemId: item.id,
            reviewVerdictRecordId: null,
            approvalGateId: null,
            subjectVersion: 'other-version',
            reasonMd: 'neither',
            dismissedById: s.user.id,
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a dismissal that rolls back writes nothing and sends no event', async () => {
    const { s, item } = await sentBackGateOff('rollback', 76);
    // The read just after the dismissal row is written, inside the same transaction.
    vi.spyOn(approvalGateRepository, 'findAwaitingByWorkItem').mockRejectedValue(
      new Error('boom after the write'),
    );
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(76)), s.ctx),
    ).rejects.toThrow('boom after the write');
    vi.restoreAllMocks();
    expect(await dismissalsOf(item.id)).toEqual([]);
    expect(dismissedEvents()).toEqual([]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });
});

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('refusals that write nothing', () => {
  it.each([
    ['an empty reason', '   '],
    ['a reason over 2000 characters', 'x'.repeat(2001)],
  ])('%s', async (_label, reason) => {
    const { s, item } = await sentBackGateOff(`reason-${reason.length}`, 81);
    await expect(
      reviewDismissalService.dismiss(
        s.project.id,
        item.identifier,
        why(versionOf(81), reason),
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewDismissalReasonRequiredError);
    expect(await dismissalsOf(item.id)).toEqual([]);
  });

  it('a teammate who may edit the card but is not the routed person', async () => {
    const { s, item } = await sentBackGateOff('not-routed', 82);
    const mate = await teammate(s, 'mate', 'member');
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(82)), mate),
    ).rejects.toBeInstanceOf(ReviewDismissalForbiddenError);
    expect(await dismissalsOf(item.id)).toEqual([]);
    expect((await itemRow(item.id)).fixReason).toBe('changes_requested');
  });

  it('the assignee may dismiss even when they are not the reporter', async () => {
    const { s, item } = await sentBackGateOff('assignee', 83);
    const mate = await teammate(s, 'assignee', 'member');
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: mate.userId } });
    const dto = await reviewDismissalService.dismiss(
      s.project.id,
      item.identifier,
      why(versionOf(83)),
      mate,
    );
    expect(dto.dismissedBy).toEqual({ id: mate.userId, name: 'assignee' });
  });

  it('a viewer without work_item:edit', async () => {
    const { s, item } = await sentBackGateOff('viewer', 84);
    const viewer = await teammate(s, 'viewer', 'viewer');
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(84)), viewer),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await dismissalsOf(item.id)).toEqual([]);
  });

  it('another workspace cannot see the card', async () => {
    const { s, item } = await sentBackGateOff('tenant', 85);
    const other = await createTestUser({ name: 'other' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: other.id,
    });
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(85)), {
        userId: other.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toThrow();
    expect(await dismissalsOf(item.id)).toEqual([]);
  });

  it('a card with no standing send-back: approved, or nothing reviewed', async () => {
    const { s, item } = await deliveredGateOff('nothing', 86);
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(86)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewSendBackNotStandingError);
    await reviewVerdictService.submit(s.project.id, item.identifier, input(versionOf(86)), s.ctx);
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(86)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewSendBackNotStandingError);
    expect(await dismissalsOf(item.id)).toEqual([]);
  });

  it('a card that delivers no pull request is stale with no current version', async () => {
    const s = await makeScenario('bare');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Bare' },
      s.ctx,
    );
    const refused = await reviewDismissalService
      .dismiss(s.project.id, item.identifier, why('x/y#1@z'), s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewDismissalStaleError);
    expect((refused as InstanceType<typeof ReviewDismissalStaleError>).currentVersion).toBeNull();
  });

  it('a send-back already dismissed', async () => {
    const { s, item } = await sentBackGateOff('twice', 87);
    await reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(87)), s.ctx);
    sent.length = 0;
    await expect(
      reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(87)), s.ctx),
    ).rejects.toBeInstanceOf(ReviewSendBackAlreadyDismissedError);
    expect(await dismissalsOf(item.id)).toHaveLength(1);
    expect(dismissedEvents()).toEqual([]);
  });
});

// ── The route ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/work-items/{key}/review-dismissal', () => {
  it('dismisses and presents the result', async () => {
    const { s, item, recordId } = await sentBackGateOff('rest-ok', 91);
    const pat = await patFor(s);
    const res = await post(pat.headers, item.identifier, {
      subjectVersion: versionOf(91),
      reason: 'Out of scope.',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      key: item.identifier,
      subjectVersion: versionOf(91),
      dismissed: { kind: 'record', id: recordId },
      reason: 'Out of scope.',
      dismissedBy: { id: s.user.id, name: 'Owner' },
    });
    expect(typeof body['approvalGateId']).toBe('string');
  });

  it.each([
    ['a missing reason', { reason: undefined }, 422, 'INVALID_BODY'],
    ['an unknown field', { subjectVersion: 'v', reason: 'r', extra: 1 }, 422, 'INVALID_BODY'],
    ['an empty reason', { reason: ' ' }, 422, 'REASON_REQUIRED'],
    [
      'a stale version',
      { subjectVersion: 'moooon/acme#92@sha-old' },
      409,
      'REVIEW_DISMISSAL_STALE',
    ],
  ])('refuses %s', async (_label, over, status, code) => {
    const { s, item } = await sentBackGateOff(`rest-bad-${_label.length}`, 92);
    const pat = await patFor(s);
    const res = await post(pat.headers, item.identifier, {
      subjectVersion: versionOf(92),
      reason: 'Out of scope.',
      ...over,
    });
    expect(res.status).toBe(status);
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe(code);
    expect(await dismissalsOf(item.id)).toEqual([]);
  });
});

// ── The carried merge ─────────────────────────────────────────────────────────

describe('agentReviewHoldsMerge — the carried merge reads the same dismissal', () => {
  const holds = async (s: Awaited<ReturnType<typeof makeScenario>>, workItemId: string) => {
    const { agentReviewHoldsMerge } = await import('@/lib/services/mergeGates');
    const { withWorkspaceContext } = await import('@/lib/workspaces/context');
    return withWorkspaceContext(s.ctx, async (tx) =>
      agentReviewHoldsMerge(
        await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } }),
        tx,
      ),
    );
  };

  it('gate off: a send-back holds the merge until it is dismissed', async () => {
    const { s, item } = await sentBackGateOff('carry-off', 101);
    expect(await holds(s, item.id)).toBe(true);
    await reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(101)), s.ctx);
    expect(await holds(s, item.id)).toBe(false);
  });

  it('gate on: a refused review holds the merge until it is dismissed', async () => {
    const { s, item } = await sentBackGateOn('own', 'carry-on', 102);
    expect(await holds(s, item.id)).toBe(true);
    await reviewDismissalService.dismiss(s.project.id, item.identifier, why(versionOf(102)), s.ctx);
    expect(await holds(s, item.id)).toBe(false);
  });
});
