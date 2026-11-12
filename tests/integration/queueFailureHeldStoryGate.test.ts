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
import { ejectedCardConvergenceService } from '@/lib/services/ejectedCardConvergenceService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// ═══════════════════════════════════════════════════════════════════════════════
// THE STORY GATE — A MERGE-QUEUE FAILURE ASKS NOBODY TO APPROVE AGAIN
// (Story MOTIR-6587 · MOTIR-6597; `docs/decisions/approval-gates.md` § 4 FIFTH AMENDMENT)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each code child proved its own half: the class map and every reader of it (MOTIR-6594),
// the convergence of the cards the old rule re-asked (MOTIR-6595), and the surface
// (MOTIR-6596). This file drives the SEQUENCE none of them sees alone — a queue exit, a
// check run at the same head, a push, a green check at the new head, a gate decision —
// through `githubWebhookService.handleEvent` with the captured `dequeued` delivery, on a
// real Postgres, one sequence per exit class:
//
//   · FAILURE (`CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID`) and
//     CONFLICT — held at Implemented, nothing asked, until a push goes green and ONE gate
//     is raised;
//   · NEUTRAL (`MANUAL`, `QUEUE_CLEARED`) and SETTING (`BRANCH_PROTECTIONS`) — re-asked at
//     In Review with ONE gate, and the row's press decides it and re-queues;
//   · the refusal, `motir fix`, the convergence's population E, auto mode and tenancy.
//
// The host is the seam's `mergeChangeRequest`, stubbed — the one call that leaves the
// process. Nothing Motir decides is mocked: not the queue-exit service, not the CI
// promotion, not `settleUnlandedOutcome`, not the database.

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
const TENANT_A: Tenant = { installationId: 'inst-held-a', repos: { web: '8101', api: '8102' } };
const TENANT_B: Tenant = { installationId: 'inst-held-b', repos: { web: '8201', api: '8202' } };
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
    `held-guid-${++guid}`,
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

describe('1 · a queue FAILURE is held at Implemented until a green push asks ONCE', () => {
  // `CI_TIMEOUT` with no check named re-asks since the SIXTH AMENDMENT (MOTIR-6847) —
  // see section 2 — and `tests/github/queueExitHungCheck.test.ts` for a named check.
  it.each(['CI_FAILURE', 'INVALID_MERGE_COMMIT', 'GIT_TREE_INVALID', 'MERGE_CONFLICT'])(
    '%s: exit → implemented, no gate; green at the same head → still none; push + green → ONE gate at in_review',
    async (reason) => {
      const { s, item, approved } = await approvedIntoTheQueue(
        `held-${reason.toLowerCase()}@example.com`,
      );

      await eject(s, 'web', 7, 'sha-web', reason);
      expect(await statusOf(item.id)).toBe('implemented');
      expect(await awaiting(item.id)).toEqual([]);

      // The promotion HOLDS at that head: a green check there raises nothing.
      await green(s, 'web', 7, 'sha-web', 'Lint');
      expect(await statusOf(item.id)).toBe('implemented');
      expect(await awaiting(item.id)).toEqual([]);

      // A push moves the head; its green is the ordinary CI promotion, and it asks ONCE.
      await green(s, 'web', 7, 'sha-web-2');
      expect(await statusOf(item.id)).toBe('in_review');
      const fresh = await awaiting(item.id);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.subjectVersion).toBe('moooon/api#12@sha-api,moooon/web#7@sha-web-2');
      // The spent approval is history, byte for byte.
      expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
        approved,
      );
    },
  );
});

describe('2 · NEUTRAL and SETTING still re-ask — unchanged by the FIFTH AMENDMENT', () => {
  it.each(['MANUAL', 'QUEUE_CLEARED', 'BRANCH_PROTECTIONS', 'CI_TIMEOUT'])(
    '%s: exit → in_review with ONE fresh gate, and the row press decides it and re-queues',
    async (reason) => {
      const { s, item, approved } = await approvedIntoTheQueue(
        `reask-${reason.toLowerCase()}@example.com`,
      );

      await eject(s, 'web', 7, 'sha-web', reason);
      expect(await statusOf(item.id)).toBe('in_review');
      const [reasked, ...more] = await awaiting(item.id);
      expect(more).toEqual([]);
      expect(reasked!.id).not.toBe(approved.id);

      await siblingMerged(s);
      const host = enqueueAll();
      const outcome = await press(s, reasked!.id, 7);
      expect(outcome).toMatchObject({ outcome: 'enqueued' });
      expect(host).toHaveBeenCalledTimes(1);
      expect(await statusOf(item.id)).toBe('approved');
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked!.id } })).state,
      ).toBe('approved');
      expect((await latestExit(s, 7)).requeuedAt).not.toBeNull();
    },
  );
});

describe('3 · Queue again on a queue FAILURE re-queues nothing', () => {
  it('the spent approval is refused and nothing is written — no stamp, no host call, no status', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('refused-spent@example.com');
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');
    const host = enqueueAll();
    const gatesBefore = await gates(item.id);

    const outcome = await press(s, approved.id, 7);

    expect(outcome).toMatchObject({ outcome: 'refused' });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(s, 7)).requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gates(item.id)).toEqual(gatesBefore);
  });

  it('a gate the OLD rule re-asked is refused MERGE_QUEUE_FAILED_NEEDS_FIX, never MERGE_CONFLICT', async () => {
    const { s, item } = await approvedIntoTheQueue('refused-stranded@example.com');
    // The old rule's shape: re-asked at in_review over a failure exit.
    await eject(s, 'web', 7, 'sha-web', 'BRANCH_PROTECTIONS');
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: (await prRow(s, 7)).id },
      data: { rawReason: 'CI_FAILURE' },
    });
    const [stranded] = await awaiting(item.id);
    await siblingMerged(s);
    const host = enqueueAll();

    const outcome = await press(s, stranded!.id, 7);

    expect(outcome).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_QUEUE_FAILED_NEEDS_FIX', reason: 'CI_FAILURE' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(s, 7)).requeuedAt).toBeNull();
  });
});

describe('4 · motir fix claims a held failure, and refuses what no code change answers', () => {
  it('a card held by a CI_FAILURE is claimed at implemented, naming the exit', async () => {
    const { s, item } = await approvedIntoTheQueue('fix-held@example.com');
    await eject(s, 'web', 7, 'sha-web', 'CI_FAILURE');

    const claim = await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx);

    expect(claim.outcome).toBe('claimed');
    expect(claim.pullRequests).toEqual([
      expect.objectContaining({
        number: 7,
        queueExit: expect.objectContaining({ rawReason: 'CI_FAILURE' }),
      }),
    ]);
  });

  it.each(['MANUAL', 'BRANCH_PROTECTIONS'])(
    'a card re-asked for %s is refused repair_not_code',
    async (reason) => {
      const { s, item } = await approvedIntoTheQueue(
        `fix-refused-${reason.toLowerCase()}@example.com`,
      );
      await eject(s, 'web', 7, 'sha-web', reason);

      const claim = await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx);

      expect(claim).toMatchObject({ outcome: 'not_repairable', reason: 'repair_not_code' });
    },
  );
});

/** The OLD rule's shape: in_review, an awaiting gate re-asked over a standing CI_FAILURE. */
async function reaskedTheOldWay(email: string, tenant: Tenant = TENANT_A) {
  const out = await approvedIntoTheQueue(email, tenant);
  await eject(out.s, 'web', 7, 'sha-web', 'BRANCH_PROTECTIONS');
  await adminDb.githubPullRequestQueueExit.updateMany({
    where: { pullRequestId: (await prRow(out.s, 7)).id },
    data: { rawReason: 'CI_FAILURE' },
  });
  expect(await statusOf(out.item.id)).toBe('in_review');
  const [reasked] = await awaiting(out.item.id);
  return { ...out, reasked: reasked! };
}

describe('5 · the convergence, population E', () => {
  it('a card the old rule re-asked ends at implemented, its gate superseded `queue_failed`; a second apply converges 0', async () => {
    const { item, approved, reasked } = await reaskedTheOldWay('converge@example.com');

    const report = await ejectedCardConvergenceService.converge({ dryRun: false });

    expect(report.failed).toEqual([]);
    expect(report.withdrawnQueueFailed.map((c) => c.workItemId)).toEqual([item.id]);
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked.id } }),
    ).toMatchObject({
      state: 'superseded',
      supersededCause: 'queue_failed',
      decidedAt: null,
    });
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );

    const again = await ejectedCardConvergenceService.converge({ dryRun: false });
    expect(again.converged).toEqual([]);
    expect(again.skipped.find((sk) => sk.workItemId === item.id)?.reason).toBe('cant_land_held');
  });

  it('TENANCY: each tenant’s card converges in its own workspace, written by its own owner', async () => {
    const a = await reaskedTheOldWay('tenant-a@example.com', TENANT_A);
    const b = await reaskedTheOldWay('tenant-b@example.com', TENANT_B);
    sent.length = 0;

    const report = await ejectedCardConvergenceService.converge({ dryRun: false });

    expect(report.withdrawnQueueFailed.map((c) => c.workItemId).sort()).toEqual(
      [a.item.id, b.item.id].sort(),
    );
    for (const t of [a, b]) {
      expect(await statusOf(t.item.id)).toBe('implemented');
      const moved = sent.find(
        (e) => e.name === 'work-item/transitioned' && e.data['workItemId'] === t.item.id,
      );
      expect(moved?.data).toMatchObject({
        workspaceId: t.s.workspace.id,
        actorId: t.s.user.id,
        toStatusKey: 'implemented',
      });
    }
    // Neither card's gate row moved across workspaces.
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: a.reasked.id } })).workspaceId,
    ).toBe(a.s.workspace.id);
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: b.reasked.id } })).workspaceId,
    ).toBe(b.s.workspace.id);
  });
});

describe('6 · auto mode is unchanged', () => {
  it('a failure exit moves the card in_review → implemented, raises no gate, and Queue again re-dispatches once', async () => {
    const s = await makeScenario('auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green(s, 'web', 21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(s, 21)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_21' },
    });

    await eject(s, 'web', 21, 'sha-auto', 'CI_FAILURE');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gates(item.id)).toEqual([]);
    sent.length = 0;

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: (await prRow(s, 21)).id },
        s.ctx,
      ),
    ).resolves.toMatchObject({ status: 'in_review' });
    expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toHaveLength(1);
    expect(await gates(item.id)).toEqual([]);
  });
});
