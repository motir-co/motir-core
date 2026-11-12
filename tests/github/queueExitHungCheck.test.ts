import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { db } from '@/lib/db';
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
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// A QUEUE EXIT WHOSE CHECK HUNG RE-ASKS (Story MOTIR-6843 · MOTIR-6847;
// `docs/decisions/approval-gates.md` §4 SIXTH AMENDMENT). The judge, every reader of
// it, and the late re-judge when the check's conclusion arrives after the exit — driven
// through `githubWebhookService.handleEvent` on a real Postgres, as the FIFTH
// AMENDMENT's story gate drives its sequences. The host's merge call is the only stub.

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
const TENANT_A: Tenant = { installationId: 'inst-hung-a', repos: { web: '8301', api: '8302' } };
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
    `hung-guid-${++guid}`,
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

/** The sibling api#12 has merged, so a re-asked gate covers exactly the ejected member and
 *  the host is asked about it alone — as `queueAgain.test.ts` sets it up. */
const siblingMerged = async (s: Scenario) =>
  adminDb.githubPullRequest.update({
    where: { id: (await prRow(s, 12)).id },
    data: { merged: true, state: 'closed' },
  });

const press = async (s: Scenario, approvalGateId: string, number: number) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    {
      approvalGateId,
      pullRequestId: (await prRow(s, number)).id,
      noteMd: null,
      source: 'ui',
      stamp: DECIDED_WITHOUT_A_READER,
    },
    s.ctx,
  );

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

/** A merge-group check completing with GitHub's own `conclusion`, verbatim. */
const groupCheck = (s: Scenario, conclusion: string, name = 'TypeScript', id = 36443325714) => {
  const body = MERGE_QUEUE_FIXTURE('check-run-failed-merge-group');
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
    `hung-check-${++guid}`,
  );
};

const ciStateOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the conclusion is known AT the exit', () => {
  it.each(['cancelled', 'timed_out'])(
    'a CI_FAILURE whose check was %s re-asks at in_review with ONE gate, is not red, motir fix refuses it, and Queue again enqueues it',
    async (conclusion) => {
      const { s, item, approved } = await approvedIntoTheQueue(`hung-at-${conclusion}@example.com`);
      await checksRequested(s, 7);
      await groupCheck(s, conclusion);

      await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');

      expect(await latestExit(s, 7)).toMatchObject({
        disposition: 'neutral',
        failingCheckName: 'TypeScript',
        failingCheckConclusion: conclusion,
      });
      expect(await statusOf(item.id)).toBe('in_review');
      const [reasked, ...more] = await awaiting(item.id);
      expect(more).toEqual([]);
      expect(reasked!.id).not.toBe(approved.id);
      expect(await ciStateOf(item.id)).not.toBe('failing');
      expect(
        await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx),
      ).toMatchObject({ outcome: 'not_repairable', reason: 'repair_not_code' });

      await siblingMerged(s);
      const host = enqueueAll();
      expect(await press(s, reasked!.id, 7)).toMatchObject({ outcome: 'enqueued' });
      expect(host).toHaveBeenCalledTimes(1);
      expect(await statusOf(item.id)).toBe('approved');
    },
  );

  it.each(['failure', 'startup_failure', 'action_required'])(
    'a CI_FAILURE whose check concluded %s is still held at implemented with no gate',
    async (conclusion) => {
      const { s, item } = await approvedIntoTheQueue(`genuine-at-${conclusion}@example.com`);
      await checksRequested(s, 7);
      await groupCheck(s, conclusion);

      await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');

      expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
      expect(await statusOf(item.id)).toBe('implemented');
      expect(await awaiting(item.id)).toEqual([]);
      expect(await ciStateOf(item.id)).toBe('failing');
    },
  );

  it('a CI_TIMEOUT whose recorded check genuinely FAILED is held', async () => {
    const { s, item } = await approvedIntoTheQueue('timeout-genuine@example.com');
    await checksRequested(s, 7);
    await groupCheck(s, 'failure');
    await eject(s, 'web', 7, 'sha-web', 'CI_TIMEOUT');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('the conclusion arrives AFTER the exit', () => {
  it('a late cancelled check re-judges the exit and re-asks the held card ONCE; a redelivery moves nothing', async () => {
    const { s, item } = await approvedIntoTheQueue('late-cancelled@example.com');
    await checksRequested(s, 7);
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await ciStateOf(item.id)).toBe('failing');
    sent.length = 0;

    await groupCheck(s, 'cancelled');

    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'neutral',
      failingCheckConclusion: 'cancelled',
    });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
    expect(await ciStateOf(item.id)).not.toBe('failing');
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          workItemId: item.id,
          fromStatusKey: 'implemented',
          toStatusKey: 'in_review',
        }),
      }),
    ]);

    await groupCheck(s, 'cancelled');
    await groupCheck(s, 'timed_out', 'Lint', 5);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('a late genuine failure leaves the card held with no gate', async () => {
    const { s, item } = await approvedIntoTheQueue('late-failure@example.com');
    await checksRequested(s, 7);
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');
    await groupCheck(s, 'failure');
    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
  });

  it('after a push moved the head, a late cancelled check moves nothing', async () => {
    const { s, item } = await approvedIntoTheQueue('late-head-moved@example.com');
    await checksRequested(s, 7);
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');
    await green(s, 'web', 7, 'sha-web-2');
    const before = await statusOf(item.id);
    const gatesBefore = (await awaiting(item.id)).map((g) => g.id);

    await groupCheck(s, 'cancelled');

    expect(await latestExit(s, 7)).toMatchObject({ disposition: 'failure' });
    expect(await statusOf(item.id)).toBe(before);
    expect((await awaiting(item.id)).map((g) => g.id)).toEqual(gatesBefore);
  });

  it('after the exit was re-queued, a late cancelled check moves nothing', async () => {
    const { s, item } = await approvedIntoTheQueue('late-requeued@example.com');
    await checksRequested(s, 7);
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');
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
});

describe('auto mode is unchanged', () => {
  it('a cancelled check keeps the exit a failure: the card moves to implemented and nothing is asked', async () => {
    const s = await makeScenario('hung-auto@example.com', 'auto');
    const item = await card(s, [['web', 7]]);
    await green(s, 'web', 7, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(s, 7)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_7' },
    });
    await checksRequested(s, 7);
    await groupCheck(s, 'cancelled');

    await eject(s, 'web', 7, 'sha-auto', 'CI_FAILURE');

    expect(await latestExit(s, 7)).toMatchObject({
      disposition: 'failure',
      failingCheckConclusion: 'cancelled',
    });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gates(item.id)).toEqual([]);
  });
});
