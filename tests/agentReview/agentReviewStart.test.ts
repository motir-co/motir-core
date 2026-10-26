import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// STARTING A HOSTED REVIEW (Story MOTIR-1626 · MOTIR-6820; ADR `hosted-agent-run.md` §8.1,
// §8.3, §8.4 and `approval-gates.md` §12.5–§12.6) — the `agent-review/requested` job's
// body, *Review again*, a review run's end, and the supersede that cancels it, against
// REAL Postgres: the gate is raised by the real webhook-driven green verdict, the run is
// started by the real hosted start path on the fake orchestrator, and motir-ai, the
// gateway and GitHub are stubbed at their HTTP seam (`fetch`), as the hosted-run suite
// stubs them.
//
// `sendEvent` records what left and otherwise does nothing, so each request is handed to
// the job's body by the test — which is exactly what a redelivery is.

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
import { _resetRunGitBotAuthors, mintRunGitCredentials } from '@/lib/github/runGitCredential';
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
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentRunCapacityService } = await import('@/lib/services/agentRunCapacityService');
const { HostedRunNoCapacityError } = await import('@/lib/hostedRuns/errors');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { ReviewAgainForbiddenError, ReviewAgainGateNotFoundError, ReviewAgainNotOfferedError } =
  await import('@/lib/agentReview/errors');

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

const pushTo = (identifier: string, number: number, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('synchronize', number, `subtask/${identifier}-${number}`, {
      head: { ref: `subtask/${identifier}-${number}`, sha },
    }),
  );

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

// ── The start ─────────────────────────────────────────────────────────────────

describe('the agent-review/requested job — ONE review run per request', () => {
  it('one event → one hosted review run over the card, booted with MOTIR_RUN_MODE=review; the card is not claimed or moved', async () => {
    const { s, item, review, request } = await reviewing('one-run', 81);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });

    const outcome = await agentReviewStartService.startRequested(request);
    expect(outcome.outcome).toBe('started');

    const runs = await runRows(s.workspace.id);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      command: 'review',
      origin: 'hosted',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
      // Attributed to the card's reporter — it has no assignee.
      createdById: before.reporterId,
      idempotencyKey: `agent-review:${review.id}:raise`,
    });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    expect(legs.map((l) => l.workItemKey)).toEqual([item.identifier]);
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: run.id, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      command: 'review',
      gateId: review.id,
      subjectVersion: review.subjectVersion,
    });

    // The container: review mode, the gate and the version it reviews.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_RUN_MODE: 'review',
      MOTIR_REVIEW_GATE_ID: review.id,
      MOTIR_REVIEW_VERSION: review.subjectVersion,
      MOTIR_WORK_ITEM_KEY: item.identifier,
      MOTIR_DISPATCH_RUN_ID: run.id,
      MOTIR_MODEL: `anthropic/${MODEL}`,
    });

    // Billed to the workspace's organisation, on the one model it runs.
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({
      coreOrganizationId: s.workspace.organizationId,
      models: [MODEL],
    });
    // The run token is the attributed user's.
    const token = await adminDb.apiToken.findFirstOrThrow({ where: { dispatchRunId: run.id } });
    expect(token.userId).toBe(before.reporterId);

    // No claim, no status move, no implementation stamp.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe(before.status);
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.implementationSource).toBe(before.implementationSource);
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
  });

  it('the git credential a review run is handed is narrowed to contents: read', async () => {
    const { s, request } = await reviewing('read-token', 82);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    vi.stubEnv('GITHUB_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));

    await mintRunGitCredentials(run!.id);
    const mint = calls.find(
      (c) => c.url.endsWith('/app/installations/42/access_tokens') && c.method === 'POST',
    );
    expect(mint?.body?.['permissions']).toEqual({ contents: 'read' });
  });

  it('the run is attributed to the ASSIGNEE when the card has one', async () => {
    const { s, item, request } = await reviewing('assignee', 83);
    const member = await usersService.createUser({
      email: 'member-assignee@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: s.workspace.id, workspaceRole: 'member' },
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: member.id } });

    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    expect(run!.createdById).toBe(member.id);
  });

  it('the same event delivered twice starts ONE run', async () => {
    const { s, request } = await reviewing('redelivery', 84);

    const first = await agentReviewStartService.startRequested(request);
    const second = await agentReviewStartService.startRequested(request);

    expect(first.outcome).toBe('started');
    expect(second).toEqual({
      outcome: 'already_started',
      dispatchRunId: (first as { dispatchRunId: string }).dispatchRunId,
    });
    expect(await runRows(s.workspace.id)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('an event whose version moved, or whose gate is no longer awaiting, starts nothing', async () => {
    const { s, item, request } = await reviewing('stale-event', 85);

    expect(
      await agentReviewStartService.startRequested({ ...request, subjectVersion: 'other' }),
    ).toEqual({ outcome: 'skipped', why: 'version_moved' });

    await pushTo(item.identifier, 85, 'sha-b');
    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'skipped',
      why: 'not_awaiting',
    });
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('a refusal before the boot is written onto the gate, which stays awaiting', () => {
  const refusals: Array<[string, Stub, string]> = [
    ['out of credits', { mayRun: false }, 'hosted_run_out_of_credits'],
    ['no model offered', { models: { ids: [] } }, 'hosted_no_model_offered'],
    ['the model list unreachable', { models: { status: 503 } }, 'hosted_models_unavailable'],
  ];
  for (const [label, s, code] of refusals) {
    it(`${label} → ${code}`, async () => {
      const { s: scenario, review, request } = await reviewing(`refuse-${code}`, 86);
      stub(s);

      expect(await agentReviewStartService.startRequested(request)).toEqual({
        outcome: 'refused',
        reason: code,
      });
      const gate = await gateRow(review.id);
      expect(gate.state).toBe('awaiting');
      expect(gate.reviewUnavailableReason).toBe(code);
      expect(gate.noteMd).toBeNull();
      expect(await runRows(scenario.workspace.id)).toEqual([]);
      expect(mintCalls()).toEqual([]);
      expect(fakeOrchestrator.provisioned).toEqual([]);
    });
  }

  it('a repository the run cannot READ → hosted_repository_not_readable', async () => {
    const { s, review, request } = await reviewing('unreadable', 87);
    await adminDb.projectRepo.update({ where: { id: s.repo.id }, data: { state: 'connected' } });
    stub({ installation: { status: 404 } });

    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'refused',
      reason: 'hosted_repository_not_readable',
    });
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe(
      'hosted_repository_not_readable',
    );
    expect(await runRows(s.workspace.id)).toEqual([]);
  });

  it('a connected repository its App can only READ is enough for a review', async () => {
    const { s, request } = await reviewing('read-only-app', 88);
    await adminDb.projectRepo.update({ where: { id: s.repo.id }, data: { state: 'connected' } });
    stub({ installation: { contents: 'read' } });

    expect((await agentReviewStartService.startRequested(request)).outcome).toBe('started');
  });

  it('the model is the list’s default, else the first offered', async () => {
    const { s, request } = await reviewing('first-offered', 89);
    stub({ models: { ids: ['claude-sonnet-5', MODEL], default: null } });

    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('claude-sonnet-5');
  });

  it('a list whose first offered model is DeepSeek reviews on deepseek/<id>, the key bare (MOTIR-7208)', async () => {
    const { s, request } = await reviewing('deepseek-first', 90);
    stub({ models: { ids: ['deepseek-v4-pro', MODEL], default: null } });

    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('deepseek-v4-pro');
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe('deepseek/deepseek-v4-pro');
    expect(mintCalls().at(-1)!.body!['models']).toEqual(['deepseek-v4-pro']);
  });

  it('a refused review is not retried by a redelivery', async () => {
    const { s, request } = await reviewing('no-retry', 90);
    stub({ mayRun: false });
    await agentReviewStartService.startRequested(request);
    stub();

    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'skipped',
      why: 'could_not_run',
    });
    expect(await runRows(s.workspace.id)).toEqual([]);
  });
});

describe('the review start path’s own edges', () => {
  it('a boot the fleet refuses ends the run failed and records the boot refusal, not no_verdict', async () => {
    const { s, review, request } = await reviewing('boot-refused', 101);
    fakeOrchestrator.failNextProvision('the fleet is at its ceiling');

    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'refused',
      reason: 'hosted_run_boot_failed',
    });
    const [run] = await runRows(s.workspace.id);
    expect(run).toMatchObject({ command: 'review', status: 'failed' });
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('hosted_run_boot_failed');
  });

  it('the same request key twice answers the run it already opened', async () => {
    const { s, item, review } = await reviewing('start-twice', 102);
    const input = {
      workItemId: item.id,
      gateId: review.id,
      subjectVersion: review.subjectVersion!,
      idempotencyKey: `agent-review:${review.id}:raise`,
    };
    const ctx = { userId: item.reporterId, workspaceId: s.workspace.id };

    const first = await hostedRunService.startReview(input, ctx, {});
    const second = await hostedRunService.startReview(input, ctx, {});
    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('the supervisor leaves a review whose gate is still awaiting to the stall read', async () => {
    const { s, request } = await reviewing('liveness-awaiting', 103);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);

    const verdict = await hostedRunService.livenessOf(
      run!.id,
      {
        attribution: { workspaceId: s.workspace.id },
        bootedAt: new Date().toISOString(),
      } as Parameters<typeof hostedRunService.livenessOf>[1],
      new Date(),
    );
    expect(verdict).toBeNull();
  });

  it('the end path writes nothing for a review run that names no gate, or for no run at all', async () => {
    const { s, item, review } = await reviewing('no-gate-key', 104);
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        command: 'review',
        origin: 'hosted',
        createdById: item.reporterId,
        idempotencyKey: 'a-local-review',
      },
    });

    await hostedRunService.endHostedRun(run.id, 'exited', 'the container exited 0');
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
    expect((await hostedRunService.endHostedRun('no-such-run', 'failed', 'gone')).closed).toBe(
      false,
    );
  });
});

// ── The end ───────────────────────────────────────────────────────────────────

describe('a review run that ends without a verdict', () => {
  it('a crash (the container exited with the run open) writes no_verdict onto the awaiting gate', async () => {
    const { s, review, request } = await reviewing('no-verdict', 91);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);

    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');

    const gate = await gateRow(review.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.reviewUnavailableReason).toBe('no_verdict');
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'failed',
    );
  });

  it('a run whose verdict decided the gate leaves no reason', async () => {
    const { s, review, request } = await reviewing('verdict', 92);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    await approvalGatesService.decideAgentReview(
      {
        gateId: review.id,
        subjectVersion: review.subjectVersion!,
        verdict: 'pass',
        noteMd: 'Looks right.',
      },
      { userId: run!.createdById!, workspaceId: s.workspace.id },
    );

    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');

    const gate = await gateRow(review.id);
    expect(gate.state).toBe('approved');
    expect(gate.reviewUnavailableReason).toBeNull();
  });
});

// ── Review again ──────────────────────────────────────────────────────────────

describe('Review again', () => {
  async function couldNotRun(slug: string, number: number) {
    const scenario = await reviewing(slug, number);
    stub({ mayRun: false });
    await agentReviewStartService.startRequested(scenario.request);
    stub();
    expect((await gateRow(scenario.review.id)).reviewUnavailableReason).toBe(
      'hosted_run_out_of_credits',
    );
    sent.length = 0;
    return scenario;
  }

  it('the routed person clears the reason and requests ONE new run for the same gate and version', async () => {
    const { s, review } = await couldNotRun('again', 93);

    expect(await agentReviewStartService.reviewAgain(review.id, s.ctx)).toEqual({
      gateId: review.id,
    });
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
    const requests = reviewRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      gateId: review.id,
      subjectVersion: review.subjectVersion,
    });
    expect(requests[0]!.idempotencyKey).toMatch(new RegExp(`^agent-review:${review.id}:again:`));

    expect((await agentReviewStartService.startRequested(requests[0]!)).outcome).toBe('started');
    expect(await runRows(s.workspace.id)).toHaveLength(1);
    // …and that request, redelivered, starts nothing more.
    await agentReviewStartService.startRequested(requests[0]!);
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('is refused while a review run for the gate is in flight', async () => {
    const { s, review } = await couldNotRun('in-flight', 94);
    await agentReviewStartService.reviewAgain(review.id, s.ctx);
    await agentReviewStartService.startRequested(reviewRequests()[0]!);
    // The reason comes back while the run still runs (a racing refusal, say).
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });
    sent.length = 0;

    const refused = await agentReviewStartService
      .reviewAgain(review.id, s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewAgainNotOfferedError);
    expect((refused as InstanceType<typeof ReviewAgainNotOfferedError>).reason).toBe(
      'run_in_flight',
    );
    expect(reviewRequests()).toEqual([]);
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');
  });

  it('is refused on a review that has not failed to run', async () => {
    const { s, review } = await reviewing('no-reason', 95);
    const refused = await agentReviewStartService
      .reviewAgain(review.id, s.ctx)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReviewAgainNotOfferedError);
    expect((refused as InstanceType<typeof ReviewAgainNotOfferedError>).reason).toBe('no_reason');
  });

  it('is refused for a member who is not the person the review is routed to', async () => {
    const { s, review } = await couldNotRun('not-routed', 96);
    const member = await usersService.createUser({
      email: 'member-not-routed@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: s.workspace.id, workspaceRole: 'member' },
    });

    await expect(
      agentReviewStartService.reviewAgain(review.id, {
        userId: member.id,
        workspaceId: s.workspace.id,
      }),
    ).rejects.toBeInstanceOf(ReviewAgainForbiddenError);
    expect(reviewRequests()).toEqual([]);
    expect((await gateRow(review.id)).reviewUnavailableReason).toBe('hosted_run_out_of_credits');
  });

  it('answers not-found for a gate in another workspace', async () => {
    const { review } = await couldNotRun('other-ws', 97);
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: stranger.id,
    });
    await expect(
      agentReviewStartService.reviewAgain(review.id, {
        userId: stranger.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(ReviewAgainGateNotFoundError);
  });
});

// ── Supersede cancels ─────────────────────────────────────────────────────────

describe('a superseded review’s run is cancelled (§12.5)', () => {
  it('a head move supersedes the review and cancels its run in flight', async () => {
    const { s, item, review, request } = await reviewing('head-move', 98);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);

    await pushTo(item.identifier, 98, 'sha-b');

    expect((await gateRow(review.id)).state).toBe('superseded');
    const after = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } });
    expect(after.status).toBe('cancelled');
    // A withdrawn review is not a review that could not run.
    expect((await gateRow(review.id)).reviewUnavailableReason).toBeNull();
  });

  it('switching the review agent off cancels the run too', async () => {
    const { s, review, request } = await reviewing('switch-off', 99);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );

    expect((await gateRow(review.id)).state).toBe('superseded');
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'cancelled',
    );
  });

  it('the supervisor tears down a review whose gate was superseded by a path with no seam', async () => {
    const { s, review, request } = await reviewing('liveness', 100);
    await agentReviewStartService.startRequested(request);
    const [run] = await runRows(s.workspace.id);
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { state: 'superseded', supersededCause: 'head_moved' },
    });

    const verdict = await hostedRunService.livenessOf(
      run!.id,
      { attribution: { workspaceId: s.workspace.id } } as Parameters<
        typeof hostedRunService.livenessOf
      >[1],
      new Date(),
    );
    expect(verdict).toMatchObject({ reason: 'gate_revoked' });
  });
});

// ── NO AGENT-RUN CAPACITY (Story MOTIR-9541 · MOTIR-9628) ───────────────────
describe('a review on a model with no agent-run capacity', () => {
  it('startReview throws HostedRunNoCapacityError on the offered default, before any open', async () => {
    const { s, item, review } = await reviewing('no-capacity-direct', 121);
    const verdict = vi
      .spyOn(agentRunCapacityService, 'verdictFor')
      .mockResolvedValue({ verdict: 'no_capacity', reason: 'provider_rate_limited' });
    const input = {
      workItemId: item.id,
      gateId: review.id,
      subjectVersion: review.subjectVersion!,
      idempotencyKey: `agent-review:${review.id}:raise`,
    };
    const ctx = { userId: item.reporterId, workspaceId: s.workspace.id };

    const refused = await hostedRunService.startReview(input, ctx, {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HostedRunNoCapacityError);
    expect(refused).toMatchObject({ model: MODEL, reason: 'provider_rate_limited' });
    expect(verdict).toHaveBeenCalledWith(expect.objectContaining({ id: MODEL }));
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('through the requested job, the gate records hosted_run_no_capacity and stays awaiting', async () => {
    const { s, review, request } = await reviewing('no-capacity-job', 122);
    vi.spyOn(agentRunCapacityService, 'verdictFor').mockResolvedValue({
      verdict: 'no_capacity',
      reason: 'provider_rate_limited',
    });

    expect(await agentReviewStartService.startRequested(request)).toEqual({
      outcome: 'refused',
      reason: 'hosted_run_no_capacity',
    });
    const gate = await gateRow(review.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.reviewUnavailableReason).toBe('hosted_run_no_capacity');
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});
