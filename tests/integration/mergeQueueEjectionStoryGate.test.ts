import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

const doors = vi.hoisted(() => ({
  ctx: null as { userId: string; workspaceId: string } | null,
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () => ({ ok: true, ctx: doors.ctx }),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => ({ user: { id: doors.ctx?.userId } }),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => doors.ctx,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { ApprovalGateAlreadyRequeuedError } from '@/lib/approvalGates/errors';
import { derivePrCiState } from '@/lib/github/prCiState';
import {
  QUEUE_EXIT_REASONS,
  classOfQueueExit,
  judgeQueueExit,
  classifyQueueExit,
} from '@/lib/mergeQueue/queueExit';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { POST as queueAgainRoute } from '@/app/api/work-items/[id]/pull-requests/[pullRequestId]/queue-again/route';
import { queueAgainAutoAction } from '@/app/(authed)/items/[key]/approvalGateActions';

/** The exit as the recorder STORES it for a manual card whose queue run named no
 *  check (§4 SIXTH AMENDMENT): a `CI_TIMEOUT` with no known check is neutral. */
const asStored = (reason: string) => ({
  rawReason: reason,
  disposition: judgeQueueExit({ rawReason: reason, failingCheckConclusion: null }).disposition,
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE STORY GATE — A PULL REQUEST THE MERGE QUEUE EJECTS (Story MOTIR-5461 · MOTIR-5636)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each code child proved its own half: the workflow edges (MOTIR-5630), the ejection
// arm (MOTIR-5632), the failing check (MOTIR-5633), Queue again (MOTIR-5634) and the
// frame (MOTIR-5635). This file drives them TOGETHER, on a real Postgres, through
// `githubWebhookService.handleEvent` with the REAL captured deliveries
// (`tests/fixtures/github/merge-queue/`), and asserts the seams no unit owns:
//
//   1. the whole manual loop — green → ONE gate → approve and merge → eject → In Review
//      with ONE fresh gate (§4 FOURTH AMENDMENT; MOTIR-5805) → a green check asks
//      nothing twice → Queue again refused (MOTIR-5802) → approve re-queues → merges →
//      done;
//   2. the re-arm — a push after the ejection supersedes the re-asked gate and the next
//      green raises exactly ONE fresh gate;
//   3. auto mode — eject from in_review, a person's Queue again, once;
//   4. every reason in the amendment's map, from the SAME constant the handler reads;
//   5. redelivery and order;
//   6. the failing check, and the pull request's own CI state untouched;
//   7. the architecture: who may import the new repositories, and how status is written;
//   8. no per-pull-request gate, anywhere, after every scenario.
//
// The host is the seam's `mergeChangeRequest`, stubbed — the one call that leaves the
// process. Nothing Motir decides is mocked: not `applyStatusTransition`, not the raise,
// not the exit repository.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ejection-story';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REPOS = { web: '7001', api: '7002' } as const;
type RepoName = keyof typeof REPOS;
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

const repository = (repo: RepoName) => ({ id: Number(REPOS[repo]) });

function dequeuedBody(repo: RepoName, number: number, headSha: string, reason: string) {
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return {
    ...body,
    reason,
    number,
    installation: INSTALLATION,
    repository: repository(repo),
    pull_request: pr,
  };
}

let guid = 0;
const nextGuid = () => `story-guid-${++guid}`;
/**
 * The default ejection: a FAILURE that still RE-ASKS. Since the FIFTH AMENDMENT
 * (MOTIR-6594) a queue failure such as `CI_FAILURE` is CAN'T-LAND and asks nothing, so
 * the loops below that walk the RE-ASK eject for branch protection — a `failure`
 * disposition (red, promotion held) whose class is `setting` (asked again).
 */
const REASK = 'BRANCH_PROTECTIONS';
const eject = (
  repo: RepoName,
  number: number,
  headSha: string,
  reason = REASK,
  deliveryId = nextGuid(),
) =>
  githubWebhookService.handleEvent(
    'pull_request',
    dequeuedBody(repo, number, headSha, reason),
    deliveryId,
  );

const green = (repo: RepoName, number: number, headSha: string, name = 'CI complete') =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: repository(repo),
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name,
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

const pending = (repo: RepoName, number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'created',
    installation: INSTALLATION,
    repository: repository(repo),
    check_run: {
      head_sha: headSha,
      status: 'in_progress',
      conclusion: null,
      name: 'CI complete',
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

function prDelivery(
  repo: RepoName,
  action: string,
  number: number,
  headRef: string,
  opts: { merged?: boolean; headSha?: string } = {},
) {
  return githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: repository(repo),
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? new Date().toISOString() : null,
      title: 'A change',
      head: { ref: headRef, ...(opts.headSha ? { sha: opts.headSha } : {}) },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto') {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
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
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: (Object.keys(REPOS) as RepoName[]).map((name) => ({
      providerRepoId: REPOS[name],
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

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
    await prDelivery(repo, 'opened', number, headRef);
  }
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) =>
  adminDb.githubPullRequest.findFirstOrThrow({ where: { number }, include: { checkRuns: true } });
const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
const awaiting = async (workItemId: string) =>
  (await gates(workItemId)).filter((g) => g.state === 'awaiting');
const exitsOf = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findMany({
    where: { pullRequestId: (await prRow(number)).id },
    orderBy: { createdAt: 'asc' },
  });
const queueRef = async (number: number) => (await prRow(number)).mergeOutcomeRef;

function stubHost(answer: (number: number) => MergeChangeRequestResult) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answer(args.number));
}
const enqueueAll = () => stubHost((n) => ({ outcome: 'enqueued', entryId: `MQE_${n}` }));

/** A manual card over web#7 and api#12, green, approved and merged into the queue by the
 *  REAL press. */
async function approvedIntoTheQueue(email: string) {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, [
    ['web', 7],
    ['api', 12],
  ]);
  await green('web', 7, 'sha-web');
  await green('api', 12, 'sha-api');
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate, ...more] = await awaiting(item.id);
  expect(more).toEqual([]);
  enqueueAll();
  const { members } = await pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
    s.ctx,
  );
  expect(members.map((m) => m.outcome)).toEqual(['enqueued', 'enqueued']);
  expect(await statusOf(item.id)).toBe('approved');
  expect(await queueRef(7)).toBe('queue:MQE_7');
  expect(await queueRef(12)).toBe('queue:MQE_12');
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved };
}

const queueAgain = async (s: Scenario, approvalGateId: string, number: number) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    {
      approvalGateId,
      pullRequestId: (await prRow(number)).id,
      noteMd: null,
      source: 'ui',
      // On the RE-ASKED gate the press IS the approval (MOTIR-5802), so it carries a
      // stamp; on a decided gate nothing reads it.
      stamp: DECIDED_WITHOUT_A_READER,
    },
    s.ctx,
  );

/** The card's ONE awaiting approve-to-merge gate — the re-asked question a row's verb
 *  decides (MOTIR-5802). */
const reaskedGate = async (workItemId: string) => {
  const [gate] = await awaiting(workItemId);
  return gate!;
};

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

// 8 · NO PER-PULL-REQUEST GATE — after every scenario in this file.
afterEach(async () => {
  expect(await adminDb.approvalGate.count({ where: { kind: 'pull_request_merge' } })).toBe(0);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1 · the whole manual loop', () => {
  // §4 FOURTH AMENDMENT (Story MOTIR-5799): the ejection RE-ASKS the merge question at
  // In Review, Queue again is retired for it, and approving the fresh gate re-queues.
  it('eject → In Review with ONE fresh gate → a green at the same head asks nothing twice → Queue again is refused → approve re-queues → both merge → done', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('loop@example.com');

    // A failure exit for web#7.
    expect(await eject('web', 7, 'sha-web')).toMatchObject({
      outcome: 'recorded',
      moved: [item.identifier],
      reasked: [item.identifier],
    });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await queueRef(7)).toBeNull();
    expect(await queueRef(12)).toBe('queue:MQE_12');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );
    const [reasked, ...more] = await awaiting(item.id);
    expect(more).toEqual([]);
    expect(reasked!.subjectVersion).toBe(approved.subjectVersion);

    // Guard (a): a green check at web#7's SAME head asks nothing a second time.
    await green('web', 7, 'sha-web', 'Lint');
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaiting(item.id)).map((g) => g.id)).toEqual([reasked!.id]);

    // Queue again on a FAILURE exit is RETIRED (§4 FOURTH AMENDMENT, point 4; MOTIR-5802):
    // the old approval is not reused, nothing is claimed, and no host is called.
    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await exitsOf(7))[0]!.requeuedAt).toBeNull();

    // Approving the re-asked gate re-queues (point 3).
    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );
    expect(members.map((m) => m.outcome)).toEqual(['enqueued', 'enqueued']);
    expect(await statusOf(item.id)).toBe('approved');
    expect(await queueRef(7)).toBe('queue:MQE_7');
    expect((await exitsOf(7))[0]!.requeuedAt).not.toBeNull();

    // Both merges land: done.
    await prDelivery('api', 'closed', 12, headRefOf(item.identifier, 12), { merged: true });
    expect(await statusOf(item.id)).toBe('approved');
    await prDelivery('web', 'closed', 7, headRefOf(item.identifier, 7), { merged: true });
    expect(await statusOf(item.id)).toBe('done');
    expect(await gates(item.id)).toHaveLength(2);
  });
});

describe('1b · a sibling already MERGED when the queue ejects the other (MOTIR-5805)', () => {
  it('the re-ask is still raised over the SAME set, and approving it re-queues only the ejected member', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('merged-sibling@example.com');
    // api#12 lands first; the card waits on web#7.
    await prDelivery('api', 'closed', 12, headRefOf(item.identifier, 12), { merged: true });
    expect(await statusOf(item.id)).toBe('approved');

    await eject('web', 7, 'sha-web');

    expect(await statusOf(item.id)).toBe('in_review');
    const [reasked, ...more] = await awaiting(item.id);
    expect(more).toEqual([]);
    expect(reasked!.subjectVersion).toBe(approved.subjectVersion);

    const host = enqueueAll();
    host.mockClear();
    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );
    expect(host).toHaveBeenCalledTimes(1);
    expect(host.mock.calls[0]![0]).toMatchObject({ number: 7 });
    expect(members.map((m) => m.outcome).sort()).toEqual(['enqueued', 'no_merge_gate']);
    expect(await statusOf(item.id)).toBe('approved');

    await prDelivery('web', 'closed', 7, headRefOf(item.identifier, 7), { merged: true });
    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('2 · the re-arm', () => {
  it('a push after the ejection raises exactly ONE fresh gate over the new head, and the old exit cannot be queued again', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('rearm@example.com');
    await eject('web', 7, 'sha-web');
    expect(await statusOf(item.id)).toBe('in_review');
    const [reasked] = await awaiting(item.id);

    await prDelivery('web', 'synchronize', 7, headRefOf(item.identifier, 7), {
      headSha: 'sha-web-2',
    });
    await pending('web', 7, 'sha-web-2');
    // The push supersedes the re-asked gate `head moved`: the question was about the
    // commits the queue threw out, and those are no longer the head.
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked!.id } }),
    ).toMatchObject({ state: 'superseded', supersededCause: 'head_moved' });
    expect(await awaiting(item.id)).toEqual([]);

    // The host says the new head still merges (MOTIR-7063) — until then nobody is asked.
    await hostAnswersCleanAt(s.workspace.id, 7, 'sha-web-2', 'web');
    await green('web', 7, 'sha-web-2');
    expect(await statusOf(item.id)).toBe('in_review');
    const fresh = await awaiting(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toContain('moooon/web#7@sha-web-2');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );

    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    expect(host).not.toHaveBeenCalled();
  });
});

describe('3 · auto mode', () => {
  it('a failure moves the card from in_review to implemented; a person’s Queue again re-dispatches once', async () => {
    const s = await makeScenario('auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(21)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_21' },
    });

    await eject('web', 21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('implemented');
    sent.length = 0;

    const pr = await prRow(21);
    const exit = (await exitsOf(21))[0]!;
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: pr.id },
        s.ctx,
      ),
    ).resolves.toMatchObject({ status: 'in_review' });
    expect(await statusOf(item.id)).toBe('in_review');
    const keys = sent
      .filter((e) => e.name === 'pull-request/auto-merge.requested')
      .map((e) => e.data['idempotencyKey']);
    expect(keys).toEqual([`${pr.id}:sha-auto:requeue:${exit.id}`]);

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: pr.id },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyRequeuedError);
    expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toHaveLength(1);
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('4 · the dispositions, over the WHOLE reason table', () => {
  // Derived from the constant the handler reads — never re-typed.
  const reasons = Object.keys(QUEUE_EXIT_REASONS) as Array<keyof typeof QUEUE_EXIT_REASONS>;

  it('covers every reason in the map, plus one nobody has mapped', () => {
    expect(reasons.length).toBeGreaterThanOrEqual(12);
    expect(classifyQueueExit('SOMETHING_NEW')).toEqual({
      disposition: 'neutral',
      recognised: false,
    });
  });

  it.each([...reasons, 'SOMETHING_NEW'])('%s', async (reason) => {
    // The STORED disposition: a manual `CI_TIMEOUT` with no check named is neutral.
    const disposition = asStored(reason).disposition;
    const { item } = await approvedIntoTheQueue(`reason-${reason.toLowerCase()}@example.com`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await eject('web', 7, 'sha-web', reason);

    expect(result).toMatchObject({ disposition });
    if (disposition === 'landed') {
      expect(result).toMatchObject({ outcome: 'landed' });
      expect(await exitsOf(7)).toEqual([]);
      expect(await queueRef(7)).toBe('queue:MQE_7');
      expect(await statusOf(item.id)).toBe('approved');
    } else {
      expect(await exitsOf(7)).toEqual([
        expect.objectContaining({ rawReason: reason, disposition }),
      ]);
      expect(await queueRef(7)).toBeNull();
      // ⚠️ §4 FOURTH AMENDMENT, point 2 (MOTIR-5805): the CLASS decides where the card
      // goes, not the disposition. Every un-landed reason settles it — a neutral removal
      // as much as a failure — and only a CONFLICT is held at `implemented`, because the
      // same commits cannot combine however often anybody says yes.
      const landingClass = classOfQueueExit(asStored(reason));
      expect(await statusOf(item.id)).toBe(
        landingClass === 'cant_land' ? 'implemented' : 'in_review',
      );
      expect(await awaiting(item.id)).toHaveLength(landingClass === 'cant_land' ? 0 : 1);
    }
    // The other member is never touched.
    expect(await queueRef(12)).toBe('queue:MQE_12');
    expect(warn).toHaveBeenCalledTimes(reason === 'SOMETHING_NEW' ? 1 : 0);
  });
});

describe('5 · redelivery and order', () => {
  it('the same GUID twice writes one row', async () => {
    const { item } = await approvedIntoTheQueue('redeliver@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', REASK, id);
    expect(await eject('web', 7, 'sha-web', REASK, id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('in_review');
    // …and raises no second gate.
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  // ⚠️ THE VERB IS PRESSED ON THE RE-ASKED GATE FROM HERE ON (MOTIR-5802): every un-landed
  // exit spends the approval that preceded it, so the press that puts the pull request back
  // is the NEW approval rather than the old one carried out again.
  it('an OLD exit redelivered after Queue again changes nothing, and the queue ref is kept', async () => {
    const { s, item } = await approvedIntoTheQueue('old-exit@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', REASK, id);
    enqueueAll();
    await queueAgain(s, (await reaskedGate(item.id)).id, 7);
    expect(await statusOf(item.id)).toBe('approved');

    expect(await eject('web', 7, 'sha-web', REASK, id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await statusOf(item.id)).toBe('approved');
    expect(await queueRef(7)).toBe('queue:MQE_7');
    expect(await exitsOf(7)).toHaveLength(1);
  });

  it('a second GENUINE exit at the same head after Queue again is a new row, asked again', async () => {
    const { s, item } = await approvedIntoTheQueue('second-exit@example.com');
    await eject('web', 7, 'sha-web', REASK);
    enqueueAll();
    await queueAgain(s, (await reaskedGate(item.id)).id, 7);

    expect(await eject('web', 7, 'sha-web', REASK)).toMatchObject({ outcome: 'recorded' });
    expect(await exitsOf(7)).toHaveLength(2);
    expect((await exitsOf(7))[1]!.requeuedAt).toBeNull();
    expect(await queueRef(7)).toBeNull();

    // …and the NEW exit spends the approval that re-queued it, so the card is asked once
    // more and that fresh press puts it back.
    expect(await statusOf(item.id)).toBe('in_review');
    enqueueAll();
    expect(await queueAgain(s, (await reaskedGate(item.id)).id, 7)).toMatchObject({
      outcome: 'enqueued',
    });
    expect(await statusOf(item.id)).toBe('approved');
  });
});

describe('6 · the failing check', () => {
  it('names the latest exit and leaves the pull request’s own CI rows and verdict untouched', async () => {
    const { item } = await approvedIntoTheQueue('check@example.com');
    const group = 'abcabcabcabcabcabcabcabcabcabcabcabcabca';
    const requested = captured('merge-group-checks-requested');
    const mg = requested['merge_group'] as Record<string, unknown>;
    await githubWebhookService.handleEvent('merge_group', {
      ...requested,
      installation: INSTALLATION,
      repository: repository('web'),
      merge_group: {
        ...mg,
        head_sha: group,
        head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${mg['base_sha'] as string}`,
      },
    });
    const before = await prRow(7);
    const rowsBefore = before.checkRuns.length;
    const verdictBefore = derivePrCiState(before.checkRuns);
    expect(verdictBefore).toBe('passing');

    const failed = captured('check-run-failed-merge-group');
    await githubWebhookService.handleEvent('check_run', {
      ...failed,
      installation: INSTALLATION,
      repository: repository('web'),
      check_run: { ...(failed['check_run'] as Record<string, unknown>), head_sha: group },
    });
    await eject('web', 7, 'sha-web');

    expect((await exitsOf(7))[0]).toMatchObject({
      failingCheckName: 'Vitest (7/12)',
      failingCheckUrl: expect.stringContaining('/job/103732354674'),
    });
    const after = await prRow(7);
    expect(after.checkRuns).toHaveLength(rowsBefore);
    expect(derivePrCiState(after.checkRuns)).toBe(verdictBefore);
    expect(await adminDb.githubCheckRun.count({ where: { commitSha: group } })).toBe(0);
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('7 · the architecture', () => {
  const roots = ['lib', 'app', 'components', 'packages'];
  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* sources(path);
      else if (/\.(ts|tsx)$/.test(name)) yield path;
    }
  }
  const all = roots.flatMap((root) => [...sources(join(process.cwd(), root))]);
  const rel = (path: string) => path.slice(process.cwd().length + 1);

  it('only lib/services imports the queue-exit and queue-attempt repositories', () => {
    const offenders = all
      .filter((path) =>
        /githubPullRequestQueueExitRepository|githubMergeQueueAttemptRepository/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map(rel)
      .filter(
        (path) =>
          !path.startsWith('lib/services/') &&
          path !== 'lib/repositories/githubPullRequestQueueExitRepository.ts' &&
          path !== 'lib/repositories/githubMergeQueueAttemptRepository.ts',
      );
    expect(offenders).toEqual([]);
  });

  it('the ejection arm writes status only through applyStatusTransition, and the check arm writes none', () => {
    const code = (file: string) =>
      readFileSync(join(process.cwd(), file), 'utf8').replace(/\/\/.*$/gm, '');
    const exitArm = code('lib/services/mergeQueueExitService.ts');
    expect(exitArm).toMatch(/\bapplyStatusTransition\(/);
    expect(exitArm).not.toMatch(/\bupdateStatus\(|workItemRepository\.update\(/);
    const checkArm = code('lib/services/mergeQueueCheckService.ts');
    expect(checkArm).not.toMatch(
      /applyStatusTransition\(|updateStatus\(|workItemRepository|githubCheckRun/,
    );
  });

  it('the Queue again path gets its status write from the ejection service, not its own', () => {
    const merge = readFileSync(
      join(process.cwd(), 'lib/services/pullRequestMergeService.ts'),
      'utf8',
    );
    expect(merge).not.toMatch(/\bapplyStatusTransition\(|\bupdateStatus\(/);
    expect(merge).toMatch(/queueExitCardMoves\.returnCard\(/);
  });
});

describe('9 · the doors a person presses', () => {
  const post = (id: string, pullRequestId: string, body: string) =>
    queueAgainRoute(
      new Request(
        `http://localhost/api/work-items/${id}/pull-requests/${pullRequestId}/queue-again`,
        {
          method: 'POST',
          body,
        },
      ),
      { params: Promise.resolve({ id, pullRequestId }) },
    );

  it('the route re-queues by DECIDING the re-asked gate, and answers a second press with the exit it stamped', async () => {
    const { s, item } = await approvedIntoTheQueue('route-manual@example.com');
    await eject('web', 7, 'sha-web', REASK);
    doors.ctx = s.ctx;
    const prId = (await prRow(7)).id;
    const reasked = await reaskedGate(item.id);
    // The API caller hands back the stamp its read was shown, exactly as the frame does.
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      s.ctx,
    );
    enqueueAll();

    const body = JSON.stringify({ approvalGateId: reasked.id, stamp: read.stamp });
    const first = await post(item.id, prId, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ member: { outcome: 'enqueued' } });
    expect(await statusOf(item.id)).toBe('approved');

    const second = await post(item.id, prId, body);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      member: { outcome: 'refused', refusal: { tag: 'MERGE_ALREADY_REQUEUED' } },
    });
  });

  it('the route answers a manual FAILURE exit with MERGE_REQUEUE_NEEDS_APPROVAL, and re-queues nothing (MOTIR-5802)', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('route-failure@example.com');
    await eject('web', 7, 'sha-web');
    doors.ctx = s.ctx;
    const prId = (await prRow(7)).id;
    const host = enqueueAll();
    host.mockClear();

    const res = await post(item.id, prId, JSON.stringify({ approvalGateId: approved.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      member: { outcome: 'refused', refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' } },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await exitsOf(7))[0]!.requeuedAt).toBeNull();
  });

  it('the route’s auto door re-dispatches, and maps each refusal to its status', async () => {
    const s = await makeScenario('route-auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    await eject('web', 21, 'sha-auto');
    doors.ctx = s.ctx;
    const prId = (await prRow(21)).id;

    expect((await post(item.id, prId, 'not json')).status).toBe(400);
    expect((await post('no-such-card', prId, '')).status).toBe(404);
    const noExit = await post(item.id, 'no-such-pr', '{}');
    expect(noExit.status).toBe(409);
    expect(await noExit.json()).toMatchObject({ reason: 'not_delivered' });

    const ok = await post(item.id, prId, '');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ pullRequestId: prId, status: 'in_review' });

    const again = await post(item.id, prId, '{}');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'MERGE_ALREADY_REQUEUED' });
  });

  it('the auto action answers a status, and a refusal in the frame’s vocabulary', async () => {
    const s = await makeScenario('action-auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    await eject('web', 21, 'sha-auto');
    doors.ctx = s.ctx;
    const pullRequestId = (await prRow(21)).id;
    const press = () =>
      queueAgainAutoAction({ workItemId: item.id, pullRequestId, identifier: item.identifier });

    expect(await press()).toEqual({ ok: true, status: 'in_review' });
    expect(await press()).toEqual({
      ok: false,
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    // A stale page pressing where the button is never offered.
    expect(
      await queueAgainAutoAction({
        workItemId: item.id,
        pullRequestId: 'no-such-pr',
        identifier: item.identifier,
      }),
    ).toEqual({ ok: false, refusal: { tag: 'UNEXPECTED' } });
  });
});

describe('10 · the ejection arm’s edges, through the real handler', () => {
  it('refuses a delivery with no GUID or no installation, and names what it could not find', async () => {
    await approvedIntoTheQueue('edges@example.com');
    const body = dequeuedBody('web', 7, 'sha-web', 'CI_FAILURE');
    expect(await githubWebhookService.handleEvent('pull_request', body, null)).toMatchObject({
      outcome: 'malformed',
    });
    const { installation: _dropped, ...noInstallation } = body;
    expect(
      await githubWebhookService.handleEvent('pull_request', noInstallation, nextGuid()),
    ).toMatchObject({ outcome: 'unknown_installation' });
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, installation: { id: 'not-ours' } },
        nextGuid(),
      ),
    ).toMatchObject({ outcome: 'unknown_installation' });
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, repository: { id: 9999 } },
        nextGuid(),
      ),
    ).toMatchObject({ outcome: 'unknown_repo' });
    expect(await eject('web', 999, 'sha-x')).toMatchObject({ outcome: 'unknown_pull_request' });
    expect(await exitsOf(7)).toEqual([]);
  });

  it('a removal that states no reason is a neutral exit recorded with an empty reason; a body with no head is malformed', async () => {
    const { item } = await approvedIntoTheQueue('no-reason@example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = dequeuedBody('web', 7, 'sha-web', 'CI_FAILURE');
    const { reason: _none, ...noReason } = body;
    expect(
      await githubWebhookService.handleEvent('pull_request', noReason, nextGuid()),
    ).toMatchObject({ outcome: 'recorded', disposition: 'neutral', rawReason: null });
    expect(await exitsOf(7)).toEqual([expect.objectContaining({ rawReason: '' })]);
    // A reason nobody stated is RETRYABLE: the safe default is to ask a person, never
    // to leave a card holding an approval nothing will act on (MOTIR-5805).
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    const pr = structuredClone(body.pull_request) as Record<string, unknown>;
    pr['head'] = {};
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, pull_request: pr },
        nextGuid(),
      ),
    ).toEqual({ event: 'pull_request', outcome: 'malformed' });
  });

  it('an auto card with no pull request has no standing exit', async () => {
    const s = await makeScenario('auto-empty@example.com', 'auto');
    const item = await card(s, []);
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx),
    ).toEqual([]);
  });

  it('a workspace with no owner records the exit and moves no card, naming each one', async () => {
    const { s, item } = await approvedIntoTheQueue('ownerless@example.com');
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: s.workspace.id },
      data: { workspaceRole: 'member' },
    });

    expect(await eject('web', 7, 'sha-web')).toMatchObject({
      outcome: 'recorded',
      moved: [],
      skipped: [{ key: item.identifier, status: 'approved', reason: 'no_actor' }],
      clearedQueuedOutcome: true,
    });
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a delivery that loses the unique-index race reads as a duplicate; any other write fault is thrown', async () => {
    await approvedIntoTheQueue('race@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', 'CI_FAILURE', id);
    // The redelivery check misses (a concurrent copy), so the index is the backstop.
    vi.spyOn(githubPullRequestQueueExitRepository, 'findByDeliveryId').mockResolvedValueOnce(null);
    expect(await eject('web', 7, 'sha-web', 'CI_FAILURE', id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await exitsOf(7)).toHaveLength(1);

    vi.spyOn(githubPullRequestQueueExitRepository, 'create').mockRejectedValueOnce(
      new Error('the disk is full'),
    );
    await expect(eject('web', 7, 'sha-web')).rejects.toThrow('the disk is full');
  });

  // REPLACES "a workflow that cannot take the card back leaves it" (MOTIR-5634): no press
  // writes `implemented → approved` any more (MOTIR-5802), and a NEUTRAL exit spends the
  // approval exactly as a failure does — so the old press is refused and moves nothing,
  // whatever the workflow holds.
  it('Queue again on a neutral exit is refused on the spent approval and writes no status', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('no-edge@example.com');
    // The removal itself asks again (MOTIR-5805), which is a status write of its own;
    // what this test pins is that the PRESS on the spent approval writes none.
    await eject('web', 7, 'sha-web', 'MANUAL');
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: s.project.id } });
    const idOf = (key: string) => statuses.find((row) => row.key === key)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: s.project.id,
        fromStatusId: idOf('implemented'),
        toStatusId: idOf('approved'),
      },
    });
    enqueueAll();
    sent.length = 0;

    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(await queueRef(7)).toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });
});

describe('11 · a HOST REFUSAL at the press, by class (MOTIR-5833 · MOTIR-5834)', () => {
  /** A manual card, green and approved — with the host REFUSING both members. */
  async function refusedPress(email: string, code: 'branch_protected' | 'conflict') {
    const s = await makeScenario(email, 'manual');
    const item = await card(s, [
      ['web', 7],
      ['api', 12],
    ]);
    await green('web', 7, 'sha-web');
    await green('api', 12, 'sha-api');
    const [gate] = await awaiting(item.id);
    stubHost(() => ({ outcome: 'refused', refusal: { code } }));
    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
      s.ctx,
    );
    expect(members.every((m) => m.outcome === 'refused')).toBe(true);
    return { s, item, approved: gate! };
  }

  const refusalsOf = async (number: number) =>
    adminDb.githubPullRequestMergeRefusal.findMany({
      where: { pullRequestId: (await prRow(number)).id },
      orderBy: { refusedAt: 'asc' },
    });

  it('a SETTING refusal: recorded, asked again at In Review, and the fresh gate lands it', async () => {
    const { s, item, approved } = await refusedPress(
      'refusal-setting@example.com',
      'branch_protected',
    );

    // Recorded on BOTH members, and the card asks again — once.
    expect(await refusalsOf(7)).toHaveLength(1);
    expect((await refusalsOf(7))[0]).toMatchObject({
      code: 'branch_protected',
      supersededAt: null,
    });
    expect(await statusOf(item.id)).toBe('in_review');
    const reasked = await awaiting(item.id);
    expect(reasked).toHaveLength(1);
    expect(reasked[0]!.id).not.toBe(approved.id);

    // The spent approval may not press again; the fresh gate may.
    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();

    expect(await queueAgain(s, reasked[0]!.id, 7)).toMatchObject({ outcome: 'enqueued' });
    expect(await statusOf(item.id)).toBe('approved');
    expect((await refusalsOf(7))[0]!.supersededAt).not.toBeNull();
  });

  it('a CONFLICT refusal: recorded, HELD at Implemented, and no verb however green it goes', async () => {
    const { s, item, approved } = await refusedPress('refusal-conflict@example.com', 'conflict');

    expect((await refusalsOf(7))[0]).toMatchObject({ code: 'conflict' });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);

    // A green check at the SAME head asks nothing: the commits cannot land as they stand.
    await green('web', 7, 'sha-web');
    expect(await awaiting(item.id)).toEqual([]);

    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({ outcome: 'refused' });
    expect(host).not.toHaveBeenCalled();
  });
});

describe('12 · NO DOOR REUSES A SPENT APPROVAL, whatever the reason (MOTIR-5802)', () => {
  it.each([
    // A queue failure is CAN'T-LAND since the FIFTH AMENDMENT (MOTIR-6594).
    ['CI_FAILURE', 'implemented'],
    ['MANUAL', 'in_review'],
    ['BRANCH_PROTECTIONS', 'in_review'],
    ['MERGE_CONFLICT', 'implemented'],
  ] as const)(
    'after %s the card is at %s and the old approval enqueues nothing',
    async (reason, status) => {
      const { s, item, approved } = await approvedIntoTheQueue(
        `spent-${reason.toLowerCase()}@example.com`,
      );
      await eject('web', 7, 'sha-web', reason);
      expect(await statusOf(item.id)).toBe(status);

      const host = enqueueAll();
      host.mockClear();
      const outcome = await queueAgain(s, approved.id, 7);

      expect(outcome).toMatchObject({ outcome: 'refused' });
      expect(host).not.toHaveBeenCalled();
      expect((await exitsOf(7)).at(-1)!.requeuedAt).toBeNull();
      // The decided gate is history, and is never edited.
      expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
        approved,
      );
    },
  );
});

describe('8 · no per-pull-request gate', () => {
  it('is asserted after every scenario above (afterEach), and the refusal type is the shipped one', () => {
    expect(new QueueAgainRefusedError('no_exit', 'x')).toBeInstanceOf(Error);
  });
});
