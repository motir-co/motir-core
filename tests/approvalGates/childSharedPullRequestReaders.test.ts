import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A CHILD THAT SHARES ONE PULL REQUEST WITH ITS STORY (Bug MOTIR-11695), against REAL
// Postgres, through the real webhook-driven green verdict.
//
// The review and approve-and-merge gates are raised over a card's OWN pull requests:
// `gateSetFor` leaves out one an ancestor also delivers (MOTIR-11624). Every reader that
// compares a version with one of those gates has to measure that same set, or it disagrees
// with the gate for a child holding one pull request of its own and one its story also
// delivers. Each case below names the reader it pins and what it did over the whole set:
//   - the approve-and-merge handler recorded (and so merged) the story's pull request too;
//   - a push to the STORY's pull request withdrew the child's questions;
//   - a CI re-run at the child's own head never retired its question;
//   - a gate-off send-back at the child's own version never held its carried merge;
//   - the review state read model named a version no gate of the child carries.

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
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { pullRequestApprovalGateHandler } =
  await import('@/lib/approvalGates/pullRequestApprovalHandler');
const { agentReviewHoldsMerge } = await import('@/lib/services/mergeGates');
const { readReviewStates } = await import('@/lib/services/reviewStateService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

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

const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

const versionOf = (number: number, sha = 'sha-a') => `moooon/acme#${number}@${sha}`;

const PR_APPROVAL = 'pull_request_approval' as const;

/** A push of `sha` to pull request `number`, whose branch is `headRef`. */
const push = (number: number, headRef: string, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('synchronize', number, headRef, { head: { ref: headRef, sha } }),
  );

/** A check on pull request `number` at `sha-a` going back to `queued` — a re-run. */
const rerun = (number: number) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'created',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      name: 'Vitest (1/12)',
      head_sha: 'sha-a',
      status: 'queued',
      conclusion: null,
      pull_requests: [{ number }],
      check_suite: { id: 36613621931, head_branch: null },
    },
  });

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

/**
 * A story holding a current How to test, and a child under it delivering pull request
 * `own` of its own AND pull request `shared`, which the story also delivers — the parent
 * run's branch a child was linked to before MOTIR-11637. Both green at `sha-a`. With
 * `gate`, the review agent's switch is on (the review stands where the merge question
 * would); without it, the approve-and-merge question is asked directly.
 */
async function childSharingWithStory(
  slug: string,
  own: number,
  shared: number,
  opts: { gate: boolean },
) {
  const s = await makeScenario(slug);
  if (opts.gate) {
    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentSource: 'own' },
      s.ctx,
    );
  } else {
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { reviewAgentEnabled: false },
    });
  }
  const story = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'story', title: 'The story' },
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
  const child = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'subtask', title: 'Re-pin the starter', parentId: story.id },
    s.ctx,
  );
  await workItemsService.updateStatus(child.id, 'in_progress', s.ctx);
  const ownRef = `subtask/${child.identifier}-${own}`;
  await linkPrByIdentifier({
    identifier: child.identifier,
    owner: 'moooon',
    name: 'acme',
    number: own,
    headRef: ownRef,
  });
  await githubWebhookService.handleEvent('pull_request', pullRequestPayload('opened', own, ownRef));
  await ci('sha-a', own);
  const sharedRef = `parent/${story.identifier}-${shared}`;
  for (const identifier of [story.identifier, child.identifier]) {
    await linkPrByIdentifier({
      identifier,
      owner: 'moooon',
      name: 'acme',
      number: shared,
      headRef: sharedRef,
    });
  }
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', shared, sharedRef),
  );
  await ci('sha-a', shared);
  return { s, story, child, ownRef, sharedRef };
}

describe('the approve-and-merge handler (Bug MOTIR-11695)', () => {
  it('measures the child’s own set — the version it records, and so what a press merges, leaves the story’s pull request out', async () => {
    const { s, child } = await childSharingWithStory('handler', 140, 141, { gate: false });
    const [gate] = await awaitingOf(child.id, PR_APPROVAL);
    expect(gate?.subjectVersion, 'the gate names the child’s own pull request').toBe(
      versionOf(140),
    );

    const [version, subject] = await withWorkspaceContext(s.ctx, async (tx) => [
      await pullRequestApprovalGateHandler.subjectVersion({ gate: gate!, tx } as never),
      await pullRequestApprovalGateHandler.resolveSubject({ gate: gate!, tx } as never),
    ]);
    expect(version, 'the version an Approve records').toBe(versionOf(140));
    expect(
      (subject as { pullRequest: { number: number } }[]).map((d) => d.pullRequest.number),
    ).toEqual([140]);
  });
});

describe('the head-move withdrawal (Bug MOTIR-11695)', () => {
  it('gate OFF: a push to the story’s pull request leaves the child’s merge question standing; a push to its own withdraws it', async () => {
    const { child, ownRef, sharedRef } = await childSharingWithStory('head-off', 142, 143, {
      gate: false,
    });
    const [gate] = await awaitingOf(child.id, PR_APPROVAL);

    await push(143, sharedRef, 'sha-b');
    expect((await gateRow(gate!.id)).state, 'the story’s branch is not the child’s question').toBe(
      'awaiting',
    );

    await push(142, ownRef, 'sha-b');
    const withdrawn = await gateRow(gate!.id);
    expect([withdrawn.state, withdrawn.supersededCause]).toEqual(['superseded', 'head_moved']);
  });

  it('gate ON: a push to the story’s pull request leaves the child’s review standing', async () => {
    const { child, ownRef, sharedRef } = await childSharingWithStory('head-on', 144, 145, {
      gate: true,
    });
    const [review] = await awaitingOf(child.id, REVIEW);
    expect(review?.subjectVersion).toBe(versionOf(144));

    await push(145, sharedRef, 'sha-b');
    expect((await gateRow(review!.id)).state).toBe('awaiting');

    await push(144, ownRef, 'sha-b');
    const withdrawn = await gateRow(review!.id);
    expect([withdrawn.state, withdrawn.supersededCause]).toEqual(['superseded', 'head_moved']);
  });
});

describe('the CI-rerun retirement (Bug MOTIR-11695)', () => {
  it('a check re-running at the child’s own head retires its merge question as `ci_rerunning`', async () => {
    const { child } = await childSharingWithStory('rerun', 146, 147, { gate: false });
    const [gate] = await awaitingOf(child.id, PR_APPROVAL);

    await rerun(146);
    const retired = await gateRow(gate!.id);
    expect([retired.state, retired.supersededCause]).toEqual(['superseded', 'ci_rerunning']);
  });

  it('gate ON: the same re-run retires the child’s review', async () => {
    const { child } = await childSharingWithStory('rerun-on', 148, 149, { gate: true });
    const [review] = await awaitingOf(child.id, REVIEW);

    await rerun(148);
    const retired = await gateRow(review!.id);
    expect([retired.state, retired.supersededCause]).toEqual(['superseded', 'ci_rerunning']);
  });
});

describe('the merge hold (Bug MOTIR-11695)', () => {
  it('a gate-off send-back at the child’s own version holds its carried merge', async () => {
    const { s, child } = await childSharingWithStory('hold', 150, 151, { gate: false });
    const held = () =>
      withWorkspaceContext(s.ctx, async (tx) =>
        agentReviewHoldsMerge(
          (await tx.workItem.findUniqueOrThrow({ where: { id: child.id } }))!,
          tx,
        ),
      );
    expect(await held(), 'nothing sent it back yet').toBe(false);

    // The send-back the verdict door records at the child's own version (MOTIR-11693).
    await adminDb.reviewVerdictRecord.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: child.id,
        subjectVersion: versionOf(150),
        verdict: 'changes_requested',
        outcome: 'recorded',
        findingsMd: '- `lib/export.ts:12` drops the header row — keep it.',
        harness: 'Claude Code',
        model: MODEL,
      },
    });
    expect(await held()).toBe(true);
  });
});

describe('the review state read model (Bug MOTIR-11695)', () => {
  it('names the child’s own version — the one its review gate carries', async () => {
    const { s, story, child } = await childSharingWithStory('state', 152, 153, { gate: true });
    const [review] = await awaitingOf(child.id, REVIEW);

    // A card that delivers nothing reads no version at all.
    const lone = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Nothing delivered' },
      s.ctx,
    );
    const states = await withWorkspaceContext(s.ctx, (tx) =>
      readReviewStates(s.project.id, [child.id, story.id], s.ctx, tx),
    );
    const loneStates = await withWorkspaceContext(s.ctx, (tx) =>
      readReviewStates(s.project.id, [lone.id], s.ctx, tx),
    );
    expect(loneStates.get(lone.id)?.currentVersion).toBeNull();
    expect(states.get(child.id)?.currentVersion).toBe(review!.subjectVersion);
    expect(states.get(child.id)?.currentVersion).toBe(versionOf(152));
    // The story is not a child of anything: its whole set is its own.
    expect(states.get(story.id)?.currentVersion).toBe(versionOf(153));
  });
});
