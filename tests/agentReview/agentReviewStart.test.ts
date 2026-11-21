import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// STARTING A HOSTED REVIEW ON A PERSON'S PRESS (Story MOTIR-1626 · MOTIR-6820, reshaped by
// Story MOTIR-11941 · MOTIR-11944; ADR `hosted-agent-run.md` §8.1, §8.4, §8.8 and
// `approval-gates.md` §12.5, §12.6, §12.18) — *Review with Motir agent*
// (`agentReviewStartService.startRequested`), a review run's end, and the supersede that
// cancels it, against REAL Postgres: the gate is raised by the real webhook-driven green
// verdict, the run is started by the real hosted start path on the fake orchestrator, and
// motir-ai, the gateway and GitHub are stubbed at their HTTP seam (`fetch`), as the
// hosted-run suite stubs them.
//
// `sendEvent` records what left and otherwise does nothing: nothing reviews by itself, so
// no review event ever leaves, which each scenario asserts.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

// The SESSION, for the route cases — a route test has no cookie jar, so the compliance gate
// hands back the signed-in person (the seam every session-route suite stubs).
const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantWorkspaceContext,
}));

import { fakeOrchestrator } from '@motir/orchestrator';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors, mintRunGitCredentials } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { linkPrByIdentifier } from '../helpers/prLink';
import { pressReview } from '../helpers/reviewRequest';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentRunCapacityService } = await import('@/lib/services/agentRunCapacityService');
const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { HostedModelNotOfferedError, HostedRunBootFailedError, HostedRunNoCapacityError } =
  await import('@/lib/hostedRuns/errors');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { ReviewStartForbiddenError, ReviewStartNotOfferedError } =
  await import('@/lib/agentReview/errors');
const { WorkItemNotFoundError } = await import('@/lib/workItems/errors');
const reviewDoor = await import('@/app/api/work-items/[id]/review-with-motir-agent/route');

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
  models?: {
    status?: number;
    ids?: string[];
    default?: string | null;
    /** The platform review-agent model (MOTIR-10843); omitted = not sent. */
    reviewAgentDefault?: string | null;
  };
  /** The tier `/v1/admin/orgs/tiers` answers for every org asked (MOTIR-10843). */
  tierKey?: string | null;
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
          ...(s.models?.reviewAgentDefault !== undefined
            ? { reviewAgentDefault: s.models.reviewAgentDefault }
            : {}),
        });
      }
      if (url === `${AI}/v1/admin/orgs/tiers`) {
        const ids = (body?.['coreOrganizationIds'] as string[] | undefined) ?? [];
        return json(200, {
          orgs: ids.map((id) => ({ coreOrganizationId: id, tierKey: s.tierKey ?? null })),
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

/** Every review event that left — none, since nothing reviews by itself (MOTIR-11943). */
const reviewEvents = () => sent.filter((e) => e.name.startsWith('agent-review/'));

const runRows = (workspaceId: string) =>
  adminDb.dispatchRun.findMany({ where: { workspaceId }, orderBy: { startedAt: 'asc' } });

/** A press's refusal, caught — the service throws it to the route. */
const refusalOf = (p: Promise<unknown>) => p.then(() => null).catch((err: unknown) => err);

/** A teammate on the workspace (and so on the project) as a `member`. */
async function memberOf(workspaceId: string, slug: string) {
  const user = await usersService.createUser({
    email: `member-${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId, workspaceRole: 'member' },
  });
  return user;
}

/**
 * A card delivered by pull request `number` and green at `sha-a`, In review. With Review on
 * (the default) it holds its awaiting review; off, it holds none and the press reviews the
 * item at its own version.
 */
async function reviewing(slug: string, number: number, review = true) {
  const s = await makeScenario(slug);
  if (!review) {
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
  }
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
  expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
    'in_review',
  );
  const gate = (await gatesOf(item.id, REVIEW)).find((g) => g.state === 'awaiting');
  if (review) expect(gate, 'the green verdict raised the review').toBeDefined();
  else expect(gate, 'with Review off nothing is raised').toBeUndefined();
  // Nothing reviews by itself (MOTIR-11943): the raise requests no run, so each case
  // presses *Review with Motir agent* as the routed person — the reporter here.
  expect(reviewEvents(), 'the raise requests no review by itself').toEqual([]);
  expect(await runRows(s.workspace.id)).toEqual([]);
  const target = { workItemId: item.id, workspaceId: s.workspace.id };
  return { s, item, review: gate ?? null, target };
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

// ── The press ─────────────────────────────────────────────────────────────────

describe('Review with Motir agent — ONE review run per press', () => {
  it('one press → one hosted review run over the gate, booted with MOTIR_RUN_MODE=review, paid and run by the presser; the card is not claimed or moved', async () => {
    const { s, item, review, target } = await reviewing('one-run', 81);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });

    const result = await pressReview(target, { ctx: s.ctx });

    const runs = await runRows(s.workspace.id);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(result).toEqual({ dispatchRunId: run.id, created: true, gateId: review!.id });
    expect(run).toMatchObject({
      command: 'review',
      origin: 'hosted',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
      // The PRESSER is the run's actor (MOTIR-11944).
      createdById: s.user.id,
      idempotencyKey: `agent-review:${review!.id}:press:1`,
    });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    expect(legs.map((l) => l.workItemKey)).toEqual([item.identifier]);
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: run.id, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      command: 'review',
      gateId: review!.id,
      subjectVersion: review!.subjectVersion,
    });

    // The container: review mode, the gate and the version it reviews.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_RUN_MODE: 'review',
      MOTIR_REVIEW_GATE_ID: review!.id,
      MOTIR_REVIEW_VERSION: review!.subjectVersion,
      MOTIR_WORK_ITEM_KEY: item.identifier,
      MOTIR_DISPATCH_RUN_ID: run.id,
      MOTIR_MODEL: `anthropic/${MODEL}`,
    });

    // Billed to the presser's organisation, on the one model it runs.
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({
      coreOrganizationId: s.workspace.organizationId,
      models: [MODEL],
    });
    const token = await adminDb.apiToken.findFirstOrThrow({ where: { dispatchRunId: run.id } });
    expect(token.userId).toBe(s.user.id);

    // No claim, no status move, no implementation stamp, and the review read says in flight.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe(before.status);
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.implementationSource).toBe(before.implementationSource);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
    expect((await reviewStateService.forCard(s.project.id, item.id, s.ctx))?.marker).toEqual({
      kind: 'agent_reviewing',
    });
  });

  it('the git credential a review run is handed is narrowed to contents: read', async () => {
    const { s, target } = await reviewing('read-token', 82);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    vi.stubEnv('GITHUB_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));

    await mintRunGitCredentials(run!.id);
    const mint = calls.find(
      (c) => c.url.endsWith('/app/installations/42/access_tokens') && c.method === 'POST',
    );
    expect(mint?.body?.['permissions']).toEqual({ contents: 'read' });
  });

  it('the run is the PRESSER’s, never the assignee’s: a manager presses a card someone else holds', async () => {
    const { s, item, target } = await reviewing('assignee', 83);
    const member = await memberOf(s.workspace.id, 'assignee');
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: member.id } });

    // The owner holds `approval:decide_any`, so they are in the routed set too.
    await pressReview(target, { ctx: s.ctx });
    const [run] = await runRows(s.workspace.id);
    expect(run!.createdById).toBe(s.user.id);
  });

  it('a second press while the run runs is review_in_flight, and two racing presses start ONE run', async () => {
    const { s, target } = await reviewing('race', 84);

    const results = await Promise.allSettled([pressReview(target), pressReview(target)]);
    expect(await runRows(s.workspace.id)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    const started = results.filter(
      (r) => r.status === 'fulfilled' && r.value.created,
    ) as PromiseFulfilledResult<{ dispatchRunId: string; created: boolean }>[];
    expect(started).toHaveLength(1);
    // The other press either collapsed onto the same key or saw the run in flight.
    for (const r of results) {
      if (r.status === 'fulfilled') {
        expect(r.value.dispatchRunId).toBe(started[0]!.value.dispatchRunId);
      } else {
        expect(r.reason).toBeInstanceOf(ReviewStartNotOfferedError);
        expect((r.reason as InstanceType<typeof ReviewStartNotOfferedError>).reason).toBe(
          'review_in_flight',
        );
      }
    }

    const again = await refusalOf(pressReview(target));
    expect(again).toBeInstanceOf(ReviewStartNotOfferedError);
    expect(again).toMatchObject({ code: 'REVIEW_START_NOT_OFFERED', reason: 'review_in_flight' });
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('the model the person picked is the run’s; one Run hosted does not offer is refused 422-shaped and opens nothing', async () => {
    const { s, target } = await reviewing('picked-model', 85);
    stub({ models: { ids: [MODEL, 'claude-sonnet-5'] } });

    const refused = await refusalOf(pressReview(target, { model: 'not-a-model' }));
    expect(refused).toBeInstanceOf(HostedModelNotOfferedError);
    expect(await runRows(s.workspace.id)).toEqual([]);

    await pressReview(target, { model: 'claude-sonnet-5' });
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('claude-sonnet-5');
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe('anthropic/claude-sonnet-5');
  });
});

describe('what a press may review, and who may press', () => {
  it('an item not In review is not_in_review; a gate no longer awaiting is gate_not_awaiting', async () => {
    const { s, item, review, target } = await reviewing('not-offered', 86);

    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    expect(await refusalOf(pressReview(target))).toMatchObject({ reason: 'not_in_review' });

    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_review' } });
    await adminDb.approvalGate.update({
      where: { id: review!.id },
      data: { state: 'superseded', supersededCause: 'head_moved' },
    });
    expect(await refusalOf(pressReview(target))).toMatchObject({ reason: 'gate_not_awaiting' });
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('a member outside the routed set is REVIEW_START_FORBIDDEN; a stranger reads not-found', async () => {
    const { s, review, target } = await reviewing('who', 87);
    const member = await memberOf(s.workspace.id, 'not-routed');

    const forbidden = await refusalOf(
      pressReview(target, { ctx: { userId: member.id, workspaceId: s.workspace.id } }),
    );
    expect(forbidden).toBeInstanceOf(ReviewStartForbiddenError);
    expect(forbidden).toMatchObject({ code: 'REVIEW_START_FORBIDDEN' });

    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: stranger.id,
    });
    expect(
      await refusalOf(
        pressReview(target, { ctx: { userId: stranger.id, workspaceId: workspace.id } }),
      ),
    ).toBeInstanceOf(WorkItemNotFoundError);
    // A credential bound to ANOTHER project reads the card as not-found too, never a 403.
    expect(
      await refusalOf(pressReview(target, { ctx: { ...s.ctx, tokenProjectId: 'other-project' } })),
    ).toBeInstanceOf(WorkItemNotFoundError);
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
  });
});

describe('a pre-flight refusal is thrown to the presser; nothing is written onto the gate', () => {
  const refusals: Array<[string, Stub, string]> = [
    ['out of credits', { mayRun: false }, 'hosted_run_out_of_credits'],
    ['no model offered', { models: { ids: [] } }, 'hosted_no_model_offered'],
    ['the model list unreachable', { models: { status: 503 } }, 'hosted_models_unavailable'],
  ];
  for (const [label, st, code] of refusals) {
    it(`${label} → ${code}`, async () => {
      const { s, review, target } = await reviewing(`refuse-${code}`, 88);
      stub(st);

      expect(await refusalOf(pressReview(target))).toMatchObject({ code });
      const gate = await gateRow(review!.id);
      expect(gate.state).toBe('awaiting');
      expect(gate.reviewUnavailableReason).toBeNull();
      expect(gate.noteMd).toBeNull();
      expect(await runRows(s.workspace.id)).toEqual([]);
      expect(mintCalls()).toEqual([]);
      expect(fakeOrchestrator.provisioned).toEqual([]);
    });
  }

  it('a repository the run cannot READ → hosted_repository_not_readable', async () => {
    const { s, review, target } = await reviewing('unreadable', 89);
    await adminDb.projectRepo.update({ where: { id: s.repo.id }, data: { state: 'connected' } });
    stub({ installation: { status: 404 } });

    expect(await refusalOf(pressReview(target))).toMatchObject({
      code: 'hosted_repository_not_readable',
    });
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
    expect(await runRows(s.workspace.id)).toEqual([]);
  });

  it('a connected repository its App can only READ is enough for a review', async () => {
    const { s, target } = await reviewing('read-only-app', 90);
    await adminDb.projectRepo.update({ where: { id: s.repo.id }, data: { state: 'connected' } });
    stub({ installation: { contents: 'read' } });

    expect((await pressReview(target)).created).toBe(true);
  });

  it('a refused press leaves the next one fresh: once the credits are back it starts attempt 1', async () => {
    const { s, review, target } = await reviewing('after-refusal', 91);
    stub({ mayRun: false });
    expect(await refusalOf(pressReview(target))).toMatchObject({
      code: 'hosted_run_out_of_credits',
    });
    stub();

    expect((await pressReview(target)).created).toBe(true);
    const [run] = await runRows(s.workspace.id);
    expect(run!.idempotencyKey).toBe(`agent-review:${review!.id}:press:1`);
  });
});

describe('with no model picked, the review’s own model resolution', () => {
  it('the model is the list’s default, else the first offered', async () => {
    const { s, target } = await reviewing('first-offered', 92);
    stub({ models: { ids: ['claude-sonnet-5', MODEL], default: null } });

    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('claude-sonnet-5');
  });

  it("the model is the qualifying org's review-agent model, else the platform's (MOTIR-10843)", async () => {
    const { s, target } = await reviewing('org-review-model', 93);
    const ids = [MODEL, 'claude-sonnet-5', 'claude-fable-5-1'];
    await adminDb.organization.update({
      where: { id: s.workspace.organizationId },
      data: { hostedReviewModel: 'claude-fable-5-1' },
    });
    stub({ models: { ids, reviewAgentDefault: 'claude-sonnet-5' }, tierKey: 'pro' });

    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('claude-fable-5-1');
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe('anthropic/claude-fable-5-1');
  });

  it('an org on Standard reviews on the platform review-agent model, its own choice kept', async () => {
    const { s, target } = await reviewing('standard-review-model', 94);
    await adminDb.organization.update({
      where: { id: s.workspace.organizationId },
      data: { hostedReviewModel: 'claude-fable-5-1' },
    });
    stub({
      models: {
        ids: [MODEL, 'claude-sonnet-5', 'claude-fable-5-1'],
        reviewAgentDefault: 'claude-sonnet-5',
      },
      tierKey: 'standard',
    });

    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('claude-sonnet-5');
  });

  it('a list whose first offered model is DeepSeek reviews on deepseek/<id>, the key bare (MOTIR-7208)', async () => {
    const { s, target } = await reviewing('deepseek-first', 95);
    stub({ models: { ids: ['deepseek-v4-pro', MODEL], default: null } });

    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    expect(run!.model).toBe('deepseek-v4-pro');
    expect(fakeOrchestrator.specs.at(-1)!.env['MOTIR_MODEL']).toBe('deepseek/deepseek-v4-pro');
    expect(mintCalls().at(-1)!.body!['models']).toEqual(['deepseek-v4-pro']);
  });
});

describe('the review start path’s own edges', () => {
  it('a boot the fleet refuses ends the run failed and records the boot refusal, not no_verdict', async () => {
    const { s, review, target } = await reviewing('boot-refused', 101);
    fakeOrchestrator.failNextProvision('the fleet is at its ceiling');

    expect(await refusalOf(pressReview(target))).toBeInstanceOf(HostedRunBootFailedError);
    const [run] = await runRows(s.workspace.id);
    expect(run).toMatchObject({ command: 'review', status: 'failed' });
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBe('hosted_run_boot_failed');
  });

  it('the same run key twice answers the run it already opened', async () => {
    const { s, item, review } = await reviewing('start-twice', 102);
    const input = {
      workItemId: item.id,
      gateId: review!.id,
      subjectVersion: review!.subjectVersion!,
      idempotencyKey: `agent-review:${review!.id}:press:1`,
    };
    const ctx = { userId: item.reporterId, workspaceId: s.workspace.id };

    const first = await hostedRunService.startReview(input, ctx, {});
    const second = await hostedRunService.startReview(input, ctx, {});
    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('the supervisor leaves a review whose gate is still awaiting to the stall read', async () => {
    const { s, target } = await reviewing('liveness-awaiting', 103);
    await pressReview(target);
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
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
    expect((await hostedRunService.endHostedRun('no-such-run', 'failed', 'gone')).closed).toBe(
      false,
    );
  });
});

// ── The end, and the press after it ───────────────────────────────────────────

describe('a review run that ends without a verdict, and the press that starts it again', () => {
  it('a crash (the container exited with the run open) writes no_verdict onto the awaiting gate', async () => {
    const { s, review, target } = await reviewing('no-verdict', 105);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);

    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');

    const gate = await gateRow(review!.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.reviewUnavailableReason).toBe('no_verdict');
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'failed',
    );
  });

  it('a run whose verdict decided the gate leaves no reason', async () => {
    const { s, review, target } = await reviewing('verdict', 106);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    await approvalGatesService.decideAgentReview(
      {
        gateId: review!.id,
        subjectVersion: review!.subjectVersion!,
        verdict: 'pass',
        noteMd: 'Looks right.',
      },
      { userId: run!.createdById!, workspaceId: s.workspace.id },
    );

    await hostedRunService.endHostedRun(run!.id, 'exited', 'the container exited 0');

    const gate = await gateRow(review!.id);
    expect(gate.state).toBe('approved');
    expect(gate.reviewUnavailableReason).toBeNull();
  });

  it('after Review could not run, the press starts a fresh attempt under the next key and clears the reason', async () => {
    const { s, review, target } = await reviewing('again', 107);
    await pressReview(target);
    const [first] = await runRows(s.workspace.id);
    await hostedRunService.endHostedRun(first!.id, 'exited', 'the container exited 0');
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBe('no_verdict');

    const second = await pressReview(target);
    expect(second).toMatchObject({ created: true, gateId: review!.id });
    const runs = await runRows(s.workspace.id);
    expect(runs.map((r) => r.idempotencyKey)).toEqual([
      `agent-review:${review!.id}:press:1`,
      `agent-review:${review!.id}:press:2`,
    ]);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
    expect(reviewEvents()).toEqual([]);
  });
});

// ── Review off ────────────────────────────────────────────────────────────────

describe('with Review off, the press reviews the item at its own version and gates nothing', () => {
  it('ONE gate-less run keyed by the item and version, booted with no gate id; a second press is review_in_flight', async () => {
    const { s, item, target } = await reviewing('gate-off', 111, false);

    const result = await pressReview(target);
    expect(result).toMatchObject({ created: true, gateId: null });
    const [run] = await runRows(s.workspace.id);
    expect(run!.idempotencyKey).toMatch(new RegExp(`^agent-review-item:${item.id}:[0-9a-f]+:1$`));
    expect(run!.createdById).toBe(s.user.id);
    const env = fakeOrchestrator.specs.at(-1)!.env;
    expect(env['MOTIR_RUN_MODE']).toBe('review');
    expect(env).not.toHaveProperty('MOTIR_REVIEW_GATE_ID');
    expect(await gatesOf(item.id, REVIEW)).toEqual([]);

    // The item's review read answers the run in flight, per item and version.
    expect(
      (await reviewStateService.forCard(s.project.id, item.id, s.ctx))?.itemReviewRun,
    ).toMatchObject({ state: 'in_flight', dispatchRunId: run!.id });

    expect(await refusalOf(pressReview(target))).toMatchObject({ reason: 'review_in_flight' });
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('an item In review with no pull request of its own is no_pull_request', async () => {
    const s = await makeScenario('no-pr');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'No pull request' },
      s.ctx,
    );
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_review' } });

    expect(
      await refusalOf(pressReview({ workItemId: item.id, workspaceId: s.workspace.id })),
    ).toMatchObject({ reason: 'no_pull_request' });
    expect(await runRows(s.workspace.id)).toEqual([]);
  });
});

// ── Supersede cancels ─────────────────────────────────────────────────────────

describe('a superseded review’s run is cancelled (§12.5)', () => {
  it('a head move supersedes the review and cancels its run in flight', async () => {
    const { s, item, review, target } = await reviewing('head-move', 98);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);

    await pushTo(item.identifier, 98, 'sha-b');

    expect((await gateRow(review!.id)).state).toBe('superseded');
    const after = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } });
    expect(after.status).toBe('cancelled');
    // A withdrawn review is not a review that could not run.
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
  });

  it('switching the review agent off cancels the run too', async () => {
    const { s, review, target } = await reviewing('switch-off', 99);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );

    expect((await gateRow(review!.id)).state).toBe('superseded');
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe(
      'cancelled',
    );
  });

  it('the supervisor tears down a review whose gate was superseded by a path with no seam', async () => {
    const { s, review, target } = await reviewing('liveness', 100);
    await pressReview(target);
    const [run] = await runRows(s.workspace.id);
    await adminDb.approvalGate.update({
      where: { id: review!.id },
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
      gateId: review!.id,
      subjectVersion: review!.subjectVersion!,
      idempotencyKey: `agent-review:${review!.id}:press:1`,
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

  it('through the press, the refusal is thrown by name and the gate stays awaiting with no reason', async () => {
    const { s, review, target } = await reviewing('no-capacity-press', 122);
    vi.spyOn(agentRunCapacityService, 'verdictFor').mockResolvedValue({
      verdict: 'no_capacity',
      reason: 'provider_rate_limited',
    });

    expect(await refusalOf(pressReview(target))).toBeInstanceOf(HostedRunNoCapacityError);
    const gate = await gateRow(review!.id);
    expect(gate.state).toBe('awaiting');
    expect(gate.reviewUnavailableReason).toBeNull();
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

// ── The door: POST /api/work-items/[id]/review-with-motir-agent ───────────────

describe('the Review with Motir agent route', () => {
  const signIn = (ctx: { userId: string; workspaceId: string }) =>
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
  const post = (key: string, body?: string) =>
    reviewDoor.POST(
      new Request(`https://app.test/api/work-items/${key}/review-with-motir-agent`, {
        method: 'POST',
        ...(body === undefined ? {} : { body }),
      }),
      { params: Promise.resolve({ id: key }) },
    );
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  it('201 with the run for the routed person; then 409 review_in_flight; racing posts leave ONE run', async () => {
    const { s, item, review } = await reviewing('door-start', 131);
    signIn(s.ctx);

    const [a, b] = await Promise.all([post(item.identifier), post(item.identifier, '{}')]);
    // One press opens the run; the other collapsed onto its key (200) or saw it running (409).
    const statuses = [a.status, b.status];
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect([200, 409]).toContain(statuses.find((x) => x !== 201));
    const runs = await runRows(s.workspace.id);
    expect(runs).toHaveLength(1);
    const winner = a.status === 201 ? a : b;
    expect(await json(winner)).toEqual({
      dispatchRunId: runs[0]!.id,
      created: true,
      gateId: review!.id,
    });
    expect(winner.headers.get('cache-control')).toContain('no-store');
    expect(runs[0]).toMatchObject({
      createdById: s.user.id,
      idempotencyKey: `agent-review:${review!.id}:press:1`,
    });

    const again = await post(item.identifier, JSON.stringify({ idempotencyKey: 'retry-1' }));
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({
      code: 'REVIEW_START_NOT_OFFERED',
      reason: 'review_in_flight',
    });
    expect(await runRows(s.workspace.id)).toHaveLength(1);
  });

  it('the picked model is the run’s; an unoffered one is 422 hosted_model_not_offered and opens nothing', async () => {
    const { s, item } = await reviewing('door-model', 132);
    stub({ models: { ids: [MODEL, 'claude-sonnet-5'] } });
    signIn(s.ctx);

    const refused = await post(item.identifier, JSON.stringify({ model: 'no-such-model' }));
    expect(refused.status).toBe(422);
    expect((await json(refused))['code']).toBe('hosted_model_not_offered');
    expect(await runRows(s.workspace.id)).toEqual([]);

    const started = await post(item.identifier, JSON.stringify({ model: ' claude-sonnet-5 ' }));
    expect(started.status).toBe(201);
    expect((await runRows(s.workspace.id))[0]!.model).toBe('claude-sonnet-5');
  });

  it('refusals by name: 400 bodies, 404, 403, 409 not offered, 402 out of credits, the lane switched off', async () => {
    const { s, item, review } = await reviewing('door-refusals', 133);
    signIn(s.ctx);

    expect((await post(item.identifier, 'not json')).status).toBe(400);
    expect((await post(item.identifier, '[]')).status).toBe(400);
    expect((await post(item.identifier, JSON.stringify({ model: 7 }))).status).toBe(400);
    expect((await post(item.identifier, JSON.stringify({ idempotencyKey: 7 }))).status).toBe(400);

    const missing = await post('ACME-999999');
    expect(missing.status).toBe(404);
    expect((await json(missing))['code']).toBe('WORK_ITEM_NOT_FOUND');

    const member = await memberOf(s.workspace.id, 'door-not-routed');
    signIn({ userId: member.id, workspaceId: s.workspace.id });
    const forbidden = await post(item.identifier);
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden))['code']).toBe('REVIEW_START_FORBIDDEN');

    signIn(s.ctx);
    stub({ mayRun: false });
    const broke = await post(item.identifier);
    expect(broke.status).toBe(402);
    expect((await json(broke))['code']).toBe('hosted_run_out_of_credits');
    stub();

    await adminDb.orgFeatureFlag.create({
      data: {
        organizationId: s.workspace.organizationId,
        key: 'hosted_runs',
        enabled: false,
        reason: 'Spend',
      },
    });
    const off = await post(item.identifier);
    expect(off.status).toBeGreaterThanOrEqual(400);
    expect(off.status).not.toBe(201);
    await adminDb.orgFeatureFlag.deleteMany({
      where: { organizationId: s.workspace.organizationId },
    });

    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    const notInReview = await post(item.identifier);
    expect(notInReview.status).toBe(409);
    expect(await json(notInReview)).toMatchObject({ reason: 'not_in_review' });

    // None of them opened a run or wrote onto the gate.
    expect(await runRows(s.workspace.id)).toEqual([]);
    expect((await gateRow(review!.id)).reviewUnavailableReason).toBeNull();
  });

  it('signed out is the gate’s own answer', async () => {
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await post('ACME-1')).status).toBe(401);
  });
});
