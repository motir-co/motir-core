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
// `pullRequestReconcile.test.ts` does. Everything from the service down is real.
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { db } from '@/lib/db';
import {
  pickFailingCheck,
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
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE RECONCILE TICK READS A STANDING QUEUE EXIT'S CHECK FROM THE HOST (Story
// MOTIR-6843 · MOTIR-6848; `docs/decisions/approval-gates.md` §4 SIXTH AMENDMENT,
// point 4). The exit whose `check_run` delivery never came: the tick asks GitHub for the
// merge-group commit's check runs, records the failing check's raw conclusion, and a
// cancelled / timed-out one re-asks the held card. GitHub's REST reads are answered
// in-process; the host's merge call and the token mint are the only other stubs.

const PASSWORD = 'hunter2hunter2';
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

const DEQUEUED = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/fixtures/github/merge-queue/dequeued-ci-failure.json'),
    'utf8',
  ),
).payload as Record<string, unknown>;

/** One GitHub installation per workspace, so two tenants can live side by side. */
interface Tenant {
  installationId: string;
  repos: { web: string; api: string };
}
const TENANT_A: Tenant = {
  installationId: 'inst-hung-reconcile',
  repos: { web: '8401', api: '8402' },
};
type RepoName = keyof Tenant['repos'];

const installation = (t: Tenant) => ({
  id: t.installationId,
  account: { login: 'moooon', type: 'Organization' },
});
const repository = (t: Tenant, repo: RepoName) => ({ id: Number(t.repos[repo]) });

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto', tenant: Tenant = TENANT_A) {
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
      installationId: tenant.installationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: (Object.keys(tenant.repos) as RepoName[]).map((name) => ({
      providerRepoId: tenant.repos[name],
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  return { user, workspace, project, tenant, ctx: { userId: user.id, workspaceId: workspace.id } };
}

let guid = 0;
const eject = (s: Scenario, repo: RepoName, number: number, headSha: string, reason: string) => {
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
      repository: repository(s.tenant, repo),
      pull_request: pr,
    },
    `rec-guid-${++guid}`,
  );
};

const green = (s: Scenario, repo: RepoName, number: number, headSha: string, name = 'CI') =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: installation(s.tenant),
    repository: repository(s.tenant, repo),
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name,
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

async function card(s: Scenario, prs: Array<[RepoName, number]>) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Throttle the public API' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const [repo, number] of prs) {
    const headRef = `subtask/${item.identifier}-${number}`;
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

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
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

function stubHost(answer: (number: number) => MergeChangeRequestResult) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answer(args.number));
}
const enqueueAll = () => stubHost((n) => ({ outcome: 'enqueued', entryId: `MQE_${n}` }));

/** A manual card over web#7 and api#12, green, APPROVED and enqueued by the real press. */
async function approvedIntoTheQueue(email: string, tenant: Tenant = TENANT_A) {
  const s = await makeScenario(email, 'manual', tenant);
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

const MERGE_QUEUE_FIXTURE = (name: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`), 'utf8'),
  ).payload as Record<string, unknown>;

/** The merge group the queue built for web#7 — its `checks_requested`, re-pointed. */
const GROUP_SHA = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
const checksRequested = (s: Scenario, number: number, sha = GROUP_SHA) => {
  const body = MERGE_QUEUE_FIXTURE('merge-group-checks-requested');
  const group = body['merge_group'] as Record<string, unknown>;
  return githubWebhookService.handleEvent(
    'merge_group',
    {
      ...body,
      installation: installation(s.tenant),
      repository: { id: Number(s.tenant.repos.web), full_name: 'moooon/web' },
      merge_group: {
        ...group,
        head_sha: sha,
        head_ref: `refs/heads/gh-readonly-queue/main/pr-${number}-${group['base_sha'] as string}`,
      },
    },
    `hung-group-${++guid}`,
  );
};

/** What GitHub says the merge group's check runs are: `[name, status, conclusion]`. */
let groupRuns: Array<[name: string, status: string, conclusion: string | null]> | 'no-answer';
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
          check_runs: groupRuns.map(([name, status, conclusion], i) => ({
            name,
            status,
            conclusion,
            check_suite: { id: 77 },
            html_url: `https://github.com/moooon/web/actions/runs/1/job/${i + 1}`,
            completed_at: status === 'completed' ? `2026-09-28T15:4${i}:00Z` : null,
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

/** Past the quiet threshold, so every row written "now" is a candidate. */
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);
const tick = () => pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

/** A card held at implemented behind a standing CI_FAILURE exit that names NO conclusion
 *  — the queue ran web#7 in a merge group, and the group's check_run never arrived. */
async function heldWithNoConclusion(email: string) {
  const out = await approvedIntoTheQueue(email);
  await checksRequested(out.s, 7);
  await eject(out.s, 'web', 7, 'sha-web', 'CI_FAILURE');
  expect(await statusOf(out.item.id)).toBe('implemented');
  expect(await latestExit(out.s, 7)).toMatchObject({
    disposition: 'failure',
    failingCheckName: null,
    failingCheckConclusion: null,
  });
  return out;
}

const attemptOf = async (s: Scenario) =>
  adminDb.githubMergeQueueAttempt.findFirstOrThrow({
    where: { pullRequestId: (await prRow(s, 7)).id },
    orderBy: { createdAt: 'desc' },
  });

const ciStateOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;

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

describe('the tick settles an exit whose check’s end Motir never heard', () => {
  it('a host-reported CANCELLED check re-asks the card at in_review with ONE gate, recorded on the attempt and the exit', async () => {
    const { s, item } = await heldWithNoConclusion('rec-cancelled@example.com');
    groupRuns = [
      ['Lint', 'completed', 'success'],
      ['TypeScript', 'completed', 'cancelled'],
      ['E2E', 'in_progress', null],
    ];

    const summary = await tick();

    expect(summary.queueExitsResolved).toBe(1);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
    expect(await ciStateOf(item.id)).not.toBe('failing');
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'neutral',
      failingCheckName: 'TypeScript',
      failingCheckConclusion: 'cancelled',
    });
    expect(await attemptOf(s)).toMatchObject({
      failingCheckName: 'TypeScript',
      failingCheckConclusion: 'cancelled',
    });
  });

  it('with the check already NAMED, the tick records that check’s conclusion and re-asks', async () => {
    const { s, item } = await heldWithNoConclusion('rec-named@example.com');
    // A row named before the conclusion column existed.
    const exit = await latestExit(s, 7);
    await adminDb.githubPullRequestQueueExit.update({
      where: { id: exit.id },
      data: { failingCheckName: 'TypeScript', failingCheckUrl: 'https://example.test/job/1' },
    });
    await adminDb.githubMergeQueueAttempt.update({
      where: { id: (await attemptOf(s)).id },
      data: { failingCheckName: 'TypeScript', failingCheckUrl: 'https://example.test/job/1' },
    });
    groupRuns = [
      ['TypeScript', 'completed', 'cancelled'],
      ['CI complete', 'completed', 'failure'],
    ];
    sent.length = 0;

    const summary = await tick();

    expect(summary.queueExitsResolved).toBe(1);
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'neutral',
      failingCheckName: 'TypeScript',
      failingCheckConclusion: 'cancelled',
    });
    expect(await attemptOf(s)).toMatchObject({ failingCheckConclusion: 'cancelled' });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toHaveLength(1);

    // A second pass makes NO host call for the group: the row no longer matches.
    const before = groupReads();
    await tick();
    expect(groupReads()).toBe(before);
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('a host-reported GENUINE failure is recorded and the card stays held with no gate', async () => {
    const { s, item } = await heldWithNoConclusion('rec-failure@example.com');
    groupRuns = [['TypeScript', 'completed', 'failure']];

    expect((await tick()).queueExitsResolved).toBe(1);

    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'failure',
      failingCheckName: 'TypeScript',
      failingCheckConclusion: 'failure',
    });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });

  it('NO ANSWER from the host records nothing and moves nothing; a later answered pass settles it', async () => {
    const { s, item } = await heldWithNoConclusion('rec-no-answer@example.com');
    groupRuns = 'no-answer';

    expect((await tick()).queueExitsResolved).toBe(0);
    expect(await latestExit(s, 7)).toMatchObject({ failingCheckConclusion: null });
    expect(await statusOf(item.id)).toBe('implemented');

    groupRuns = [['TypeScript', 'completed', 'timed_out']];
    expect((await tick()).queueExitsResolved).toBe(1);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('an exit whose head MOVED is skipped with no host call', async () => {
    const { s, item } = await heldWithNoConclusion('rec-head-moved@example.com');
    await green(s, 'web', 7, 'sha-web-2');
    groupRuns = [['TypeScript', 'completed', 'cancelled']];
    const status = await statusOf(item.id);

    await tick();

    expect(groupReads()).toBe(0);
    expect(await latestExit(s, 7)).toMatchObject({ failingCheckConclusion: null });
    expect(await statusOf(item.id)).toBe(status);
  });

  it('an exit that was REQUEUED is skipped with no host call', async () => {
    const { s } = await heldWithNoConclusion('rec-requeued@example.com');
    const exit = await latestExit(s, 7);
    await adminDb.githubPullRequestQueueExit.update({
      where: { id: exit.id },
      data: { requeuedAt: new Date() },
    });
    groupRuns = [['TypeScript', 'completed', 'cancelled']];

    await tick();

    expect(groupReads()).toBe(0);
    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'failure',
      failingCheckConclusion: null,
    });
  });
});

describe('which reported run is the failing check', () => {
  const run = (checkName: string, rawConclusion: string | null, minute = 0): ReportedCheckRun => ({
    checkName,
    checkSuiteId: '1',
    conclusion:
      rawConclusion === null ? 'pending' : rawConclusion === 'success' ? 'success' : 'failure',
    rawConclusion,
    url: null,
    completedAt: rawConclusion === null ? null : new Date(Date.UTC(2026, 8, 28, 15, minute)),
  });

  it('the NAMED check wins, whatever else failed', () => {
    expect(
      pickFailingCheck(
        [run('CI complete', 'failure'), run('TypeScript', 'cancelled')],
        'TypeScript',
      )?.rawConclusion,
    ).toBe('cancelled');
  });

  it('with no name, a genuine failure outranks a cancellation, which outranks nothing', () => {
    expect(
      pickFailingCheck([run('A', 'cancelled', 1), run('B', 'failure', 2)], null)?.checkName,
    ).toBe('B');
    expect(pickFailingCheck([run('A', 'timed_out'), run('B', 'success')], null)?.checkName).toBe(
      'A',
    );
    expect(pickFailingCheck([run('A', 'success'), run('B', null)], null)).toBeNull();
  });

  it('a named check the host did not report as failed is not picked', () => {
    expect(pickFailingCheck([run('TypeScript', 'success')], 'TypeScript')).toBeNull();
  });
});
