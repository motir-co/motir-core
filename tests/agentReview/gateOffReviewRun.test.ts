import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A HOSTED REVIEW RUN WITH NO GATE (Story MOTIR-11941 · MOTIR-11952; `approval-gates.md`
// §12.18, `hosted-agent-run.md` §8.8). With Review off a person can still start a hosted
// review of an item, and there is no `agent_review` gate for it to answer: the run is keyed
// on the item and version (`reviewItemRunKey`), its prompt reviews the RUN's version, its
// verdict gives the user-token door's outcomes, and the review state reads it in flight or
// could-not-run from the run itself. Against REAL Postgres: the deliveries come from the
// real webhook path, the start is the real hosted start on the fake orchestrator, and
// motir-ai, the gateway and GitHub are stubbed at their HTTP seam (`fetch`), as the
// review-start suite stubs them.

vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async () => undefined,
}));

import { fakeOrchestrator } from '@motir/orchestrator';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  gateIdOfReviewRunKey,
  reviewItemRunKey,
  reviewItemRunKeyPrefix,
} from '@/lib/agentReview/reviewRunKey';
import { HOSTED_REVIEW_HARNESS, REVIEW_NO_VERDICT_REASON } from '@/lib/agentReview/reviewState';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { bearer } from '../fixtures/apiV1Fixtures';
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
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { runCredentialService } = await import('@/lib/services/runCredentialService');
const { reviewStateService } = await import('@/lib/services/reviewStateService');
const { reviewStateRepository } = await import('@/lib/repositories/reviewStateRepository');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const BASE = 'http://localhost:3000/api/v1';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const INSTALLATION_ID = 'inst-gate-off-review';
const REPO_PROVIDER_ID = '11952';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const version = (number: number, sha: string) => `moooon/acme#${number}@${sha}`;

// ── The HTTP seam ─────────────────────────────────────────────────────────────

function stub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/agent-models`) {
        return json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL });
      }
      if (url === `${AI}/v1/admin/orgs/tiers`) {
        const ids = (body?.['coreOrganizationIds'] as string[] | undefined) ?? [];
        return json(200, { orgs: ids.map((id) => ({ coreOrganizationId: id, tierKey: null })) });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: 250,
          hasCredits: true,
          mayRun: true,
        });
      }
      if (url.startsWith(`${AI}/v1/conventions`)) return json(404, { code: 'not_found' });
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
        return json(200, {
          id: 42,
          account: { login: 'moooon' },
          permissions: { contents: 'write', pull_requests: 'write' },
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

// ── The scenario: an item in In review, green, with Review OFF ───────────────

async function makeScenario(slug: string, reviewAgentEnabled = false) {
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
    data: { prMergeMode: 'manual', reviewAgentEnabled },
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
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, repoId: REPO_PROVIDER_ID },
  });
  await adminDb.projectRepo.create({
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
  return { user, workspace, project, ctx };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

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

/** An item delivered by pull request `number`, green at `sha-a`. */
async function greenItem(s: Scenario, number: number) {
  const item = await workItemsService.createWorkItem(
    {
      projectId: s.project.id,
      kind: 'task',
      title: `Card ${number}`,
      descriptionMd: '## Acceptance criteria\n\n- The header shows the count.',
    },
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

const gatesOf = (workItemId: string, kind?: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'asc' },
  });

/**
 * A review run over `item` opened with NO GATE at `subjectVersion` — the row, its one leg,
 * its `run_opened` (`gateId: null`) and its own credential — as `startReview` opens one.
 */
async function gateOffRun(
  s: Scenario,
  item: { id: string; identifier: string },
  subjectVersion: string,
  requestId = '1',
  status: 'running' | 'failed' | 'succeeded' | 'cancelled' = 'running',
) {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: s.workspace.id,
      projectId: s.project.id,
      command: 'review',
      origin: 'hosted',
      model: MODEL,
      createdById: s.user.id,
      idempotencyKey: reviewItemRunKey(item.id, subjectVersion, requestId),
      cards: {
        create: [
          {
            workspaceId: s.workspace.id,
            workItemId: item.id,
            workItemKey: item.identifier,
            position: 0,
          },
        ],
      },
    },
  });
  await adminDb.dispatchRunEvent.create({
    data: {
      workspaceId: s.workspace.id,
      dispatchRunId: run.id,
      seq: 1,
      kind: 'run_opened',
      reportedBy: 'cli',
      data: { command: 'review', key: item.identifier, gateId: null, subjectVersion },
    },
  });
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: run.id,
    dispatcherUserId: s.user.id,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  // The credential is minted while the run is live; an ended run is then ended.
  if (status !== 'running') {
    await adminDb.dispatchRun.update({ where: { id: run.id }, data: { status } });
  }
  return { runId: run.id, headers: bearer(token) };
}

async function readPrompt(headers: Record<string, string>, key: string): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/review-prompt/route');
  return GET(new Request(`${BASE}/work-items/${key}/review-prompt`, { headers }), {
    params: Promise.resolve({ key }),
  });
}

async function submit(
  headers: Record<string, string>,
  key: string,
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/agent-review/route');
  return POST(
    new Request(`${BASE}/work-items/${key}/agent-review`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;
const recordsOf = (workItemId: string) =>
  adminDb.reviewVerdictRecord.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
const itemRunRows = (s: Scenario, items: { workItemId: string; subjectVersion: string }[]) =>
  withWorkspaceContext(s.ctx, (tx) =>
    reviewStateRepository.listItemReviewRuns(s.workspace.id, items, tx),
  );
/** The rows' state, run and reason — the run's own facts are asserted where they matter. */
const itemRuns = async (s: Scenario, items: { workItemId: string; subjectVersion: string }[]) =>
  new Map(
    [...(await itemRunRows(s, items))].map(([id, r]) => [
      id,
      { state: r.state, dispatchRunId: r.dispatchRunId, reason: r.reason },
    ]),
  );

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  resetRateLimitStore();
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

// ── The key ───────────────────────────────────────────────────────────────────

describe('reviewItemRunKey — a namespace of its own', () => {
  it('is deterministic per request id, under its prefix, with a fixed-length digest, and names no gate', () => {
    const v = version(1, 'sha-a');
    const key = reviewItemRunKey('wi1', v, '1');
    expect(key).toBe(reviewItemRunKey('wi1', v, '1'));
    expect(key.startsWith(reviewItemRunKeyPrefix('wi1', v))).toBe(true);
    expect(key).not.toBe(reviewItemRunKey('wi1', v, '2'));
    expect(key).not.toBe(reviewItemRunKey('wi1', version(1, 'sha-b'), '1'));
    expect(key).toMatch(/^agent-review-item:wi1:[0-9a-f]{64}:1$/);
    const huge = Array.from({ length: 400 }, (_, i) => version(i, `sha-${i}`)).join(',');
    expect(reviewItemRunKey('wi1', huge, '1')).toHaveLength(key.length);
    expect(gateIdOfReviewRunKey(key)).toBeNull();
  });
});

// ── The start ─────────────────────────────────────────────────────────────────

describe('hostedRunService.startReview with no gate', () => {
  it('opens ONE review run over the item, run_opened gateId null, booted with no gate id; the same key opens nothing; no gate moves', async () => {
    const s = await makeScenario('start');
    const item = await greenItem(s, 31);
    const v = version(31, 'sha-a');
    const gatesBefore = await gatesOf(item.id);
    expect(gatesBefore.filter((g) => g.kind === 'agent_review')).toEqual([]);
    const input = {
      workItemId: item.id,
      gateId: null,
      subjectVersion: v,
      idempotencyKey: reviewItemRunKey(item.id, v, '1'),
    };

    const started = await hostedRunService.startReview(input, s.ctx, {});
    expect(started.created).toBe(true);
    const runs = await adminDb.dispatchRun.findMany({ where: { workspaceId: s.workspace.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: 'review', idempotencyKey: input.idempotencyKey });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: runs[0]!.id } });
    expect(legs.map((l) => l.workItemId)).toEqual([item.id]);
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: runs[0]!.id, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({ command: 'review', gateId: null, subjectVersion: v });
    const env = fakeOrchestrator.specs[0]!.env;
    expect(env).toMatchObject({ MOTIR_RUN_MODE: 'review', MOTIR_REVIEW_VERSION: v });
    expect(env).not.toHaveProperty('MOTIR_REVIEW_GATE_ID');

    const again = await hostedRunService.startReview(input, s.ctx, {});
    expect(again).toEqual({ dispatchRunId: started.dispatchRunId, created: false });
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: s.workspace.id } })).toBe(1);
    expect(await gatesOf(item.id)).toEqual(gatesBefore);

    // Its end leaves no reason on any gate — there is none to write it on.
    await hostedRunService.endHostedRun(started.dispatchRunId, 'failed', 'test end');
    const gatesAfter = await gatesOf(item.id);
    expect(gatesAfter.every((g) => g.reviewUnavailableReason === null)).toBe(true);
    expect(await itemRuns(s, [{ workItemId: item.id, subjectVersion: v }])).toEqual(
      new Map([
        [
          item.id,
          {
            state: 'could_not_run',
            dispatchRunId: started.dispatchRunId,
            reason: REVIEW_NO_VERDICT_REASON,
          },
        ],
      ]),
    );
    // The run's own facts, which the review part draws (MOTIR-11948): who, what, when.
    const [row] = [
      ...(await itemRunRows(s, [{ workItemId: item.id, subjectVersion: v }])).values(),
    ];
    expect(row).toMatchObject({ origin: 'hosted', agentName: null, createdById: s.user.id });
    expect(row!.startedAt).toBeInstanceOf(Date);
  });
});

// ── The prompt ────────────────────────────────────────────────────────────────

describe('the review prompt of a run with no gate', () => {
  it('reviews the item at the RUN’s version, with gateId null, though the item has no review gate', async () => {
    const s = await makeScenario('prompt');
    const item = await greenItem(s, 32);
    const v = version(32, 'sha-a');
    const { headers } = await gateOffRun(s, item, v);

    const res = await readPrompt(headers, item.identifier);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ key: item.identifier, gateId: null, subjectVersion: v });
    expect(body['pullRequests']).toEqual([
      expect.objectContaining({ repository: 'moooon/acme', number: 32, headSha: 'sha-a' }),
    ]);
    expect(String(body['prompt'])).toContain('The header shows the count.');
  });

  it('a run opened for a gate that is gone still answers REVIEW_GATE_NOT_FOUND', async () => {
    const s = await makeScenario('prompt-gone');
    const item = await greenItem(s, 33);
    const { runId, headers } = await gateOffRun(s, item, version(33, 'sha-a'));
    await adminDb.dispatchRunEvent.updateMany({
      where: { dispatchRunId: runId, kind: 'run_opened' },
      data: { data: { command: 'review', gateId: 'gone', subjectVersion: version(33, 'sha-a') } },
    });
    const res = await readPrompt(headers, item.identifier);
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toMatchObject({ code: 'REVIEW_GATE_NOT_FOUND' });
  });
});

// ── The verdict ───────────────────────────────────────────────────────────────

describe('the verdict of a run with no gate — the user-token door’s outcomes', () => {
  it('PASS is stored as a recorded review record by the hosted reviewer, moves nothing and decides no gate', async () => {
    const s = await makeScenario('pass');
    const item = await greenItem(s, 34);
    const v = version(34, 'sha-a');
    const { headers } = await gateOffRun(s, item, v);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const gatesBefore = await gatesOf(item.id);

    const res = await submit(headers, item.identifier, {
      subjectVersion: v,
      verdict: 'pass',
      summaryMd: 'Looks right.',
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      key: item.identifier,
      gateId: null,
      outcome: 'recorded',
      verdict: 'pass',
      state: 'approved',
      subjectVersion: v,
    });
    const records = await recordsOf(item.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'recorded',
      gateId: null,
      verdict: 'pass',
      harness: HOSTED_REVIEW_HARNESS,
      model: MODEL,
      subjectVersion: v,
    });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe(before.status);
    expect(await gatesOf(item.id)).toEqual(gatesBefore);
  });

  it('CHANGES_REQUESTED withdraws the awaiting approve-and-merge gate and the item is To fix', async () => {
    const s = await makeScenario('send-back');
    const item = await greenItem(s, 35);
    const v = version(35, 'sha-a');
    const merge = (await gatesOf(item.id, 'pull_request_approval')).find(
      (g) => g.state === 'awaiting',
    );
    expect(merge, 'Review off: the green verdict asked for the merge').toBeDefined();
    const { headers } = await gateOffRun(s, item, v);

    const res = await submit(headers, item.identifier, {
      subjectVersion: v,
      verdict: 'changes_requested',
      findingsMd: '- `a.ts:1` breaks the count.',
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ gateId: null, outcome: 'recorded' });
    expect((await recordsOf(item.id))[0]).toMatchObject({
      outcome: 'recorded',
      verdict: 'changes_requested',
    });
    const withdrawn = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge!.id } });
    expect(withdrawn).toMatchObject({
      state: 'superseded',
      supersededCause: 'agent_changes_requested',
    });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.fixReason).toBe('changes_requested');
  });

  it('a moved version is stored LATE (409 REVIEW_STALE); a version already answered is stored SECOND; a second verdict of the run is refused', async () => {
    const s = await makeScenario('late');
    const item = await greenItem(s, 36);
    const va = version(36, 'sha-a');

    // SECOND: another door answered this version first.
    const first = await gateOffRun(s, item, va, '1');
    expect(
      (await submit(first.headers, item.identifier, { subjectVersion: va, verdict: 'pass' }))
        .status,
    ).toBe(200);
    const second = await gateOffRun(s, item, va, '2');
    const res2 = await submit(second.headers, item.identifier, {
      subjectVersion: va,
      verdict: 'pass',
    });
    expect(res2.status).toBe(409);
    expect(await bodyOf(res2)).toMatchObject({ code: 'REVIEW_STALE' });

    // ONE verdict per run: the first run's second verdict stores nothing.
    const recordsBefore = await recordsOf(item.id);
    const res3 = await submit(first.headers, item.identifier, {
      subjectVersion: va,
      verdict: 'pass',
    });
    expect(res3.status).toBe(409);
    expect(await bodyOf(res3)).toMatchObject({ code: 'REVIEW_VERDICT_ALREADY_SUBMITTED' });
    expect(await recordsOf(item.id)).toHaveLength(recordsBefore.length);

    // LATE: the head moved while a third run reviewed `sha-a`.
    const third = await gateOffRun(s, item, va, '3');
    await pushTo(item.identifier, 36, 'sha-b');
    const res4 = await submit(third.headers, item.identifier, {
      subjectVersion: va,
      verdict: 'pass',
    });
    expect(res4.status).toBe(409);
    expect(await bodyOf(res4)).toMatchObject({ code: 'REVIEW_STALE' });
    expect((await recordsOf(item.id)).map((r) => r.outcome)).toEqual([
      'recorded',
      'second',
      'late',
    ]);
  });

  it('an AWAITING review gate at the run’s version (Review turned on mid-run) is decided as a gate-on run decides it', async () => {
    const s = await makeScenario('turned-on', true);
    const item = await greenItem(s, 37);
    const v = version(37, 'sha-a');
    const review = (await gatesOf(item.id, 'agent_review')).find((g) => g.state === 'awaiting');
    expect(review).toBeDefined();
    const { headers } = await gateOffRun(s, item, v);

    const res = await submit(headers, item.identifier, { subjectVersion: v, verdict: 'pass' });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ gateId: review!.id, outcome: 'decided' });
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review!.id } }),
    ).toMatchObject({ state: 'approved', decidedUnderAuthority: 'review_agent' });
  });
});

// ── The read ──────────────────────────────────────────────────────────────────

describe('reviewStateRepository.listItemReviewRuns and the review state', () => {
  it('in flight while running, could-not-run after an end with no verdict, nothing after a verdict; the latest request decides', async () => {
    const s = await makeScenario('read');
    const one = await greenItem(s, 38);
    const two = await greenItem(s, 39);
    const v1 = version(38, 'sha-a');
    const v2 = version(39, 'sha-a');
    const asked = [
      { workItemId: one.id, subjectVersion: v1 },
      { workItemId: two.id, subjectVersion: v2 },
    ];
    expect(await itemRuns(s, asked)).toEqual(new Map());

    const failed = await gateOffRun(s, one, v1, '1', 'failed');
    const running = await gateOffRun(s, two, v2, '1', 'running');
    expect(await itemRuns(s, asked)).toEqual(
      new Map([
        [
          one.id,
          { state: 'could_not_run', dispatchRunId: failed.runId, reason: REVIEW_NO_VERDICT_REASON },
        ],
        [two.id, { state: 'in_flight', dispatchRunId: running.runId, reason: null }],
      ]),
    );

    // A later request is what the answer follows — and one that submitted answers nothing.
    await adminDb.dispatchRun.update({
      where: { id: failed.runId },
      data: { startedAt: new Date(Date.now() - 60_000) },
    });
    const retried = await gateOffRun(s, one, v1, '2', 'running');
    expect((await itemRuns(s, asked)).get(one.id)).toMatchObject({
      state: 'in_flight',
      dispatchRunId: retried.runId,
    });
    expect(
      (await submit(retried.headers, one.identifier, { subjectVersion: v1, verdict: 'pass' }))
        .status,
    ).toBe(200);
    await adminDb.dispatchRun.update({
      where: { id: retried.runId },
      data: { status: 'succeeded' },
    });
    expect((await itemRuns(s, asked)).has(one.id)).toBe(false);

    // The review state carries it while Review is off — and not once it is on.
    const states = await reviewStateService.forCards(s.project.id, [one.id, two.id], s.ctx);
    expect(states.get(one.id)?.itemReviewRun).toBeNull();
    expect(states.get(two.id)?.itemReviewRun).toMatchObject({
      state: 'in_flight',
      dispatchRunId: running.runId,
      reason: null,
      // The run's own facts the review part draws (MOTIR-11948).
      origin: expect.any(String),
      label: expect.stringContaining('motir review'),
      byViewer: expect.any(Boolean),
    });
    expect(states.get(two.id)?.reviewOn).toBe(false);
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: true },
    });
    const on = await reviewStateService.forCards(s.project.id, [two.id], s.ctx);
    expect(on.get(two.id)?.itemReviewRun).toBeNull();
  });

  it('never answers a run of another workspace', async () => {
    const a = await makeScenario('ws-a');
    const item = await greenItem(a, 40);
    const v = version(40, 'sha-a');
    await gateOffRun(a, item, v, '1', 'running');
    const other = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: other.id,
    });
    const seen = await withWorkspaceContext({ userId: other.id, workspaceId: workspace.id }, (tx) =>
      reviewStateRepository.listItemReviewRuns(
        workspace.id,
        [{ workItemId: item.id, subjectVersion: v }],
        tx,
      ),
    );
    expect(seen).toEqual(new Map());
  });
});
