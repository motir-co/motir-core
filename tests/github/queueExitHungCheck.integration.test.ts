import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

// A real mint needs an App private key — stubbed ABOVE the code under test, as
// `pullRequestReconcile.test.ts` does. Everything from the services down is real.
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { db } from '@/lib/db';
import {
  pullRequestReconcileService,
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
} from '@/lib/services/pullRequestReconcileService';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { homeService } from '@/lib/services/homeService';
import { pullRequestApprovalMembersService } from '@/lib/services/pullRequestApprovalMembersService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { resettleStandingExit, settleUnlandedOutcome } from '@/lib/services/mergeQueueExitService';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// STORY VITEST GATE — A QUEUE EXIT WHOSE CHECK HUNG RE-ASKS (Story MOTIR-6843 ·
// MOTIR-6850; `docs/decisions/approval-gates.md` §4 SIXTH AMENDMENT).
//
// One queue exit's life has THREE writers, and each can come first: the `dequeued`
// webhook (`recordExit`), the merge group's `check_run` webhook (`attachFailingCheck`),
// and the reconcile tick, which reads the group's check runs from GitHub when the
// `check_run` delivery never came. Whatever the order, the card must end in the same
// place. So every conclusion is driven through every ordering:
//
//   A — the check's conclusion BEFORE the exit;
//   B — the exit, THEN the conclusion;
//   C — the exit only; the reconcile tick asks the host.
//
// Real Postgres, webhooks posted through the real handler, the tick called directly.
// GitHub's HTTP (the check-runs read, the merge call) and the token mint are the only
// stubs.

const PASSWORD = 'hunter2hunter2';
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

const FIXTURE = (name: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`), 'utf8'),
  ).payload as Record<string, unknown>;
const DEQUEUED = FIXTURE('dequeued-ci-failure');

interface Tenant {
  installationId: string;
  repos: { web: string; api: string };
}
const TENANT: Tenant = { installationId: 'inst-hung-gate', repos: { web: '8501', api: '8502' } };
type RepoName = keyof Tenant['repos'];

const installation = (t: Tenant) => ({
  id: t.installationId,
  account: { login: 'moooon', type: 'Organization' },
});
const repository = (t: Tenant, repo: RepoName) => ({ id: Number(t.repos[repo]) });

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto') {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${email}`,
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
    data: { prMergeMode: mode, prMergeModeDecidedAt: new Date() },
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: TENANT.installationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: (Object.keys(TENANT.repos) as RepoName[]).map((name) => ({
      providerRepoId: TENANT.repos[name],
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  return {
    user,
    workspace,
    project,
    tenant: TENANT,
    ctx: { userId: user.id, workspaceId: workspace.id },
  };
}

let guid = 0;

/** The `dequeued` delivery, the captured body re-pointed at `repo#number` and `reason`. */
const eject = (s: Scenario, number: number, headSha: string, reason: string) => {
  const pr = structuredClone(DEQUEUED['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return githubWebhookService.handleEvent(
    'pull_request',
    {
      ...DEQUEUED,
      reason,
      number,
      installation: installation(s.tenant),
      repository: repository(s.tenant, 'web'),
      pull_request: pr,
    },
    `gate-guid-${++guid}`,
  );
};

const green = (s: Scenario, repo: RepoName, number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: installation(s.tenant),
    repository: repository(s.tenant, repo),
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name: 'CI',
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

const headRefOf = (identifier: string, number: number) => `subtask/${identifier}-${number}`;

async function card(s: Scenario, prs: Array<[RepoName, number]>) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Throttle the public API' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const [repo, number] of prs) {
    const headRef = headRefOf(item.identifier, number);
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: repo,
      number,
      headRef,
    });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: installation(s.tenant),
      repository: repository(s.tenant, repo),
      pull_request: {
        number,
        state: 'open',
        merged: false,
        merged_at: null,
        title: 'A change',
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
  }
  return item;
}

const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await itemRow(id)).status;
const prRow = async (s: Scenario, number: number) => {
  const repos = await adminDb.githubRepo.findMany({ where: { workspaceId: s.workspace.id } });
  return adminDb.githubPullRequest.findFirstOrThrow({
    where: { number, repoId: { in: repos.map((r) => r.id) } },
  });
};
const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
const awaiting = async (workItemId: string) =>
  (await gates(workItemId)).filter((g) => g.state === 'awaiting');
const latestExit = async (s: Scenario, number: number) =>
  adminDb.githubPullRequestQueueExit.findFirstOrThrow({
    where: { pullRequestId: (await prRow(s, number)).id },
    orderBy: { createdAt: 'desc' },
  });

const stubHost = (answer: (number: number) => MergeChangeRequestResult) =>
  vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async (args) => answer(args.number));
const enqueueAll = () => stubHost((n) => ({ outcome: 'enqueued', entryId: `MQE_${n}` }));

/** A manual card over web#7 and api#12, green, APPROVED and enqueued by the real press. */
async function approvedIntoTheQueue(email: string) {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, [
    ['web', 7],
    ['api', 12],
  ]);
  await green(s, 'web', 7, 'sha-web');
  await green(s, 'api', 12, 'sha-api');
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate] = await awaiting(item.id);
  enqueueAll();
  await pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
    s.ctx,
  );
  expect(await statusOf(item.id)).toBe('approved');
  vi.restoreAllMocks();
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved };
}

/** The merge group the queue built for web#7 — its `checks_requested`, re-pointed. */
const GROUP_SHA = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
const checksRequested = (s: Scenario, number: number) => {
  const body = FIXTURE('merge-group-checks-requested');
  const group = body['merge_group'] as Record<string, unknown>;
  return githubWebhookService.handleEvent(
    'merge_group',
    {
      ...body,
      installation: installation(s.tenant),
      repository: { id: Number(s.tenant.repos.web), full_name: 'moooon/web' },
      merge_group: {
        ...group,
        head_sha: GROUP_SHA,
        head_ref: `refs/heads/gh-readonly-queue/main/pr-${number}-${group['base_sha'] as string}`,
      },
    },
    `gate-group-${++guid}`,
  );
};

/** The group's check completing with GitHub's own `conclusion`, verbatim. */
const groupCheck = (s: Scenario, conclusion: string, name = 'TypeScript', id = 36443325714) => {
  const body = FIXTURE('check-run-failed-merge-group');
  const run = structuredClone(body['check_run']) as Record<string, unknown>;
  return githubWebhookService.handleEvent(
    'check_run',
    {
      ...body,
      installation: installation(s.tenant),
      repository: { id: Number(s.tenant.repos.web), full_name: 'moooon/web' },
      check_run: {
        ...run,
        id,
        head_sha: GROUP_SHA,
        name,
        html_url: `https://github.com/moooon/web/actions/runs/1/job/${id}`,
        conclusion,
        pull_requests: [],
      },
    },
    `gate-check-${++guid}`,
  );
};

/** What GitHub says the merge group's check runs are, or no answer at all. */
let groupRuns: Array<[name: string, conclusion: string]> | 'no-answer';
let fetchMock: ReturnType<typeof vi.fn>;
function installHost() {
  fetchMock = vi.fn(async (url: string) => {
    const checks = /\/repos\/[^/]+\/([^/]+)\/commits\/([0-9a-f]+)\/check-runs/.exec(url);
    if (checks) {
      if (checks[2] !== GROUP_SHA) {
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      }
      if (groupRuns === 'no-answer') return new Response('{}', { status: 502 });
      return new Response(
        JSON.stringify({
          total_count: groupRuns.length,
          check_runs: groupRuns.map(([name, conclusion], i) => ({
            name,
            status: 'completed',
            conclusion,
            check_suite: { id: 77 },
            html_url: `https://github.com/moooon/web/actions/runs/1/job/${i + 1}`,
            completed_at: `2026-09-28T15:4${i}:00Z`,
          })),
        }),
        { status: 200 },
      );
    }
    const one = /\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (one) {
      return new Response(
        JSON.stringify({
          number: Number(one[2]),
          state: 'open',
          merged: false,
          merged_at: null,
          draft: false,
          title: 'A change',
          head: { ref: `subtask/x-${one[2]}` },
          base: { ref: 'main' },
          user: { id: 4242 },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}
const groupReads = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(`/commits/${GROUP_SHA}/check-runs`))
    .length;
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);
const tick = () => pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

const HUNG = ['cancelled', 'timed_out'] as const;
type Conclusion = (typeof HUNG)[number] | 'failure';
type Order = 'A' | 'B' | 'C';

/** Drive one exit's three writers in the named ORDER, ending with the conclusion known. */
async function drive(email: string, order: Order, conclusion: Conclusion) {
  const out = await approvedIntoTheQueue(email);
  const { s, item } = out;
  await checksRequested(s, 7);
  if (order === 'A') {
    await groupCheck(s, conclusion);
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
  } else {
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
    // Before the conclusion is known the exit is judged a failure and held — the
    // FIFTH AMENDMENT's answer, which this story only revises once it knows better.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
    if (order === 'B') {
      await groupCheck(s, conclusion);
    } else {
      groupRuns = [['TypeScript', conclusion]];
      await tick();
      expect(groupReads()).toBe(1);
    }
  }
  return out;
}

const toFixIds = async (s: Scenario) =>
  (await homeService.listToFix({ ...s.ctx, projectId: s.project.id })).items.map((r) => r.id);

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  groupRuns = [];
  installHost();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ORDERS: Array<[Order, string]> = [
  ['A', 'the conclusion before the exit'],
  ['B', 'the exit, then the conclusion'],
  ['C', 'the exit only, settled by the reconcile tick'],
];

describe.each(HUNG)('a check that concluded %s', (conclusion) => {
  it.each(ORDERS)(
    '%s — %s: in_review with ONE gate, not red, not To fix, motir fix refuses it',
    async (order) => {
      const { s, item, approved } = await drive(
        `hung-${conclusion}-${order}@example.com`,
        order,
        conclusion,
      );

      expect(await latestExit(s, 7)).toMatchObject({
        disposition: 'neutral',
        failingCheckName: 'TypeScript',
        failingCheckConclusion: conclusion,
      });
      expect(await statusOf(item.id)).toBe('in_review');
      const [reasked, ...more] = await awaiting(item.id);
      expect(more).toEqual([]);
      expect(reasked!.id).not.toBe(approved.id);
      const row = await itemRow(item.id);
      expect(row.ciState).not.toBe('failing');
      expect(row.fixReason).toBeNull();
      expect(await toFixIds(s)).not.toContain(item.id);
      expect(
        await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx),
      ).toMatchObject({ outcome: 'not_repairable' });

      if (order === 'C') {
        // A second tick finds the conclusion already recorded: no host call, no gate.
        await tick();
        expect(groupReads()).toBe(1);
        expect(await awaiting(item.id)).toHaveLength(1);
        expect(await statusOf(item.id)).toBe('in_review');
      }
    },
  );
});

describe('a check that genuinely FAILED — MOTIR-6587’s hold, unchanged', () => {
  it.each(ORDERS)(
    '%s — %s: held at implemented, no gate, To fix, motir fix admits it',
    async (order) => {
      const { s, item } = await drive(`genuine-${order}@example.com`, order, 'failure');

      expect(await latestExit(s, 7)).toMatchObject({
        disposition: 'failure',
        failingCheckName: 'TypeScript',
        failingCheckConclusion: 'failure',
      });
      expect(await statusOf(item.id)).toBe('implemented');
      expect(await awaiting(item.id)).toEqual([]);
      expect((await itemRow(item.id)).ciState).toBe('failing');
      expect(await toFixIds(s)).toContain(item.id);
      expect(
        await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx),
      ).toMatchObject({ outcome: 'claimed' });
    },
  );
});

describe('a CI_TIMEOUT with no check named', () => {
  it('re-asks at the exit itself', async () => {
    const { s, item } = await approvedIntoTheQueue('timeout-no-check@example.com');
    await eject(s, 7, 'sha-web', 'CI_TIMEOUT');
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'neutral',
      failingCheckName: null,
      failingCheckConclusion: null,
    });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
  });
});

describe('the no-ops — status AND gate count unchanged', () => {
  it('B: a push moved the head before a cancelled conclusion arrived', async () => {
    const { s, item } = await approvedIntoTheQueue('noop-b-head@example.com');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
    await green(s, 'web', 7, 'sha-web-2');
    const status = await statusOf(item.id);
    const before = (await awaiting(item.id)).map((g) => g.id);

    await groupCheck(s, 'cancelled');

    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await statusOf(item.id)).toBe(status);
    expect((await awaiting(item.id)).map((g) => g.id)).toEqual(before);
  });

  it('B: Queue again had already requeued the exit', async () => {
    const { s, item } = await approvedIntoTheQueue('noop-b-requeued@example.com');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
    const exit = await latestExit(s, 7);
    await adminDb.githubPullRequestQueueExit.update({
      where: { id: exit.id },
      data: { requeuedAt: new Date() },
    });

    await groupCheck(s, 'cancelled');

    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });

  it('C: a push moved the head — the tick makes no host call and moves nothing', async () => {
    const { s, item } = await approvedIntoTheQueue('noop-c-head@example.com');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
    await green(s, 'web', 7, 'sha-web-2');
    const status = await statusOf(item.id);
    const before = (await awaiting(item.id)).map((g) => g.id);
    groupRuns = [['TypeScript', 'cancelled']];

    await tick();

    expect(groupReads()).toBe(0);
    expect(await latestExit(s, 7)).toMatchObject({ failingCheckConclusion: null });
    expect(await statusOf(item.id)).toBe(status);
    expect((await awaiting(item.id)).map((g) => g.id)).toEqual(before);
  });

  it('C: Queue again had already requeued the exit — the tick makes no host call and moves nothing', async () => {
    // The real way an exit with no recorded conclusion gets requeued: a CI_TIMEOUT that
    // named no check re-asks at once, and the person presses Queue again before the tick.
    const { s, item } = await approvedIntoTheQueue('noop-c-requeued@example.com');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-web', 'CI_TIMEOUT');
    const [reasked] = await awaiting(item.id);
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(s, 12)).id },
      data: { merged: true, state: 'closed' },
    });
    enqueueAll();
    await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: reasked!.id,
        pullRequestId: (await prRow(s, 7)).id,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect((await latestExit(s, 7)).requeuedAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    const gatesBefore = (await gates(item.id)).map((g) => [g.id, g.state]);
    groupRuns = [['TypeScript', 'failure']];

    await tick();

    expect(groupReads()).toBe(0);
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'neutral',
      failingCheckConclusion: null,
    });
    expect(await statusOf(item.id)).toBe('approved');
    expect((await gates(item.id)).map((g) => [g.id, g.state])).toEqual(gatesBefore);
  });

  it('C: the host gives no answer — nothing recorded, nothing moved', async () => {
    const { s, item } = await approvedIntoTheQueue('noop-c-null@example.com');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-web', 'CI_FAILURE');
    groupRuns = 'no-answer';

    await tick();

    expect(groupReads()).toBe(1);
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'failure',
      failingCheckName: null,
      failingCheckConclusion: null,
    });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('the whole loop', () => {
  it('after A, Queue again enqueues, and the MERGE plus the merge completes the card', async () => {
    const { s, item } = await drive('loop@example.com', 'A', 'cancelled');
    const [reasked] = await awaiting(item.id);
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(s, 12)).id },
      data: { merged: true, state: 'closed' },
    });
    const host = enqueueAll();

    const pressed = await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: reasked!.id,
        pullRequestId: (await prRow(s, 7)).id,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect(pressed).toMatchObject({ outcome: 'enqueued' });
    expect(host).toHaveBeenCalledTimes(1);
    expect(await statusOf(item.id)).toBe('approved');

    expect(await eject(s, 7, 'sha-web', 'MERGE')).toMatchObject({ outcome: 'landed' });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'closed',
      installation: installation(s.tenant),
      repository: repository(s.tenant, 'web'),
      pull_request: {
        number: 7,
        state: 'closed',
        merged: true,
        merged_at: new Date().toISOString(),
        title: 'A change',
        head: { ref: headRefOf(item.identifier, 7), sha: 'sha-web' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('auto mode is unchanged', () => {
  it('a cancelled check keeps the exit a failure: implemented, and nothing is asked', async () => {
    const s = await makeScenario('auto@example.com', 'auto');
    const item = await card(s, [['web', 7]]);
    await green(s, 'web', 7, 'sha-auto');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(s, 7)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_7' },
    });
    await checksRequested(s, 7);
    await groupCheck(s, 'cancelled');

    await eject(s, 7, 'sha-auto', 'CI_FAILURE');

    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'failure',
      failingCheckConclusion: 'cancelled',
    });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gates(item.id)).toEqual([]);
  });
});

describe('the seam — writer to the DTO the item page reads', () => {
  it('the conclusion the reconcile tick recorded reads back on the approval member’s exit', async () => {
    const { s, item, approved } = await drive('seam@example.com', 'C', 'timed_out');

    const members = await pullRequestApprovalMembersService.listForGate(
      { workItemId: item.id, approvalGateId: approved.id },
      s.ctx,
    );
    const web = members.find((m) => m.exit !== null);
    expect(web?.exit).toMatchObject({
      rawReason: 'CI_FAILURE',
      disposition: 'neutral',
      failingCheckName: 'TypeScript',
      failingCheckConclusion: 'timed_out',
    });
  });
});

// ⚠️ THE RE-JUDGE'S OWN GUARDS, called directly. Every writer above reaches
// `resettleStandingExit` only after its own filter, so these arms are unreachable
// through a webhook and were the coverage floor's gap. Each is still a behaviour a
// second caller would rely on: a re-judge that finds nothing to do must move nothing.
describe('resettleStandingExit, called directly — each guard moves nothing it should not', () => {
  /** A held exit whose check has since been recorded `cancelled`, not yet re-judged. */
  async function heldWithCancelled(email: string) {
    const out = await approvedIntoTheQueue(email);
    await checksRequested(out.s, 7);
    await eject(out.s, 7, 'sha-web', 'CI_FAILURE');
    expect(await statusOf(out.item.id)).toBe('implemented');
    const exit = await latestExit(out.s, 7);
    await adminDb.githubPullRequestQueueExit.update({
      where: { id: exit.id },
      data: { failingCheckName: 'TypeScript', failingCheckConclusion: 'cancelled' },
    });
    return out;
  }
  const resettle = async (s: Scenario, number: number) => {
    const pullRequestId = (await prRow(s, number)).id;
    // As the reconcile tick calls it: the system context, bound to the workspace.
    return withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      return resettleStandingExit({ pullRequestId, workspaceId: s.workspace.id, tx });
    });
  };

  it('a pull request with no exit is not re-judged', async () => {
    const { s, item } = await approvedIntoTheQueue('direct-no-exit@example.com');
    expect(await resettle(s, 7)).toEqual({
      rejudged: false,
      moved: [],
      reasked: [],
      actorId: null,
    });
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a second call after the re-judge is a no-op — idempotent', async () => {
    const { s, item } = await drive('direct-twice@example.com', 'B', 'cancelled');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await resettle(s, 7)).toMatchObject({ rejudged: false, moved: [] });
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('an exit that no longer stands at the head is left a failure', async () => {
    const { s, item } = await heldWithCancelled('direct-head@example.com');
    await green(s, 'web', 7, 'sha-web-2');
    const status = await statusOf(item.id);
    expect(await resettle(s, 7)).toMatchObject({ rejudged: false });
    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await statusOf(item.id)).toBe(status);
  });

  it('a pull request delivering into an auto project is left a failure', async () => {
    const s = await makeScenario('direct-auto@example.com', 'auto');
    const item = await card(s, [['web', 7]]);
    await green(s, 'web', 7, 'sha-auto');
    await checksRequested(s, 7);
    await eject(s, 7, 'sha-auto', 'CI_FAILURE');
    const exit = await latestExit(s, 7);
    await adminDb.githubPullRequestQueueExit.update({
      where: { id: exit.id },
      data: { failingCheckName: 'TypeScript', failingCheckConclusion: 'cancelled' },
    });
    expect(await resettle(s, 7)).toMatchObject({ rejudged: false });
    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await gates(item.id)).toEqual([]);
  });

  it('with no manager to act as, the exit is re-judged but no card is moved', async () => {
    const { s, item } = await heldWithCancelled('direct-no-owner@example.com');
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: s.workspace.id },
      data: { workspaceRole: 'member' },
    });
    expect(await resettle(s, 7)).toEqual({ rejudged: true, moved: [], reasked: [], actorId: null });
    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'neutral' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a card a person has since moved is not moved back', async () => {
    const { s, item } = await heldWithCancelled('direct-moved@example.com');
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    expect(await resettle(s, 7)).toMatchObject({ rejudged: true, moved: [], reasked: [] });
    expect(await statusOf(item.id)).toBe('in_progress');
    expect(await awaiting(item.id)).toEqual([]);
  });

  it('a MARKED card stays where it is, and nothing is asked', async () => {
    const { s, item } = await heldWithCancelled('direct-marked@example.com');
    await adminDb.workItem.update({ where: { id: item.id }, data: { obsolescence: 'outdated' } });
    expect(await resettle(s, 7)).toMatchObject({ rejudged: true, moved: [], reasked: [] });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });

  it('settleUnlandedOutcome does nothing for a landed exit', async () => {
    const { s, item } = await heldWithCancelled('direct-landed@example.com');
    const row = await itemRow(item.id);
    const settled = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      return settleUnlandedOutcome(row, 'landed', s.ctx, tx);
    });
    expect(settled).toEqual({ transition: null, raised: false });
    expect(await statusOf(item.id)).toBe('implemented');
  });
});
