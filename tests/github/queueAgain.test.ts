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
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateAlreadyRequeuedError,
  ApprovalGateNotFoundError,
} from '@/lib/approvalGates/errors';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { releaseProviderRepo } from '../helpers/releaseProviderRepo';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// QUEUE AGAIN (Story MOTIR-5461 · MOTIR-5634; `docs/decisions/approval-gates.md` §4 THIRD
// AMENDMENT, decision 5), on a REAL Postgres. A pull request the merge queue removed is
// put back by ONE press while its head is unchanged — on the card's DECIDED approval in a
// `manual` project, as a person's re-dispatch in an `auto` one — and never twice. The host
// is the seam's `mergeChangeRequest`, stubbed: the one thing that leaves the process.
//
// ⚠️ NARROWED BY §4's FOURTH AMENDMENT, points 1 and 4 (MOTIR-5802): in a `manual` project
// NO exit is re-queued on the approval that preceded it — a NEUTRAL removal no more than a
// failure, because one approval authorizes ONE enqueue. The press is refused, the card is
// asked again on a fresh gate, and pressing the row's verb on THAT gate IS the new
// approval. The manual-mode tests below assert both halves.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-queue-again';
const REPO_PROVIDER_ID = '994';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

const captured = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/fixtures/github/merge-queue/dequeued-ci-failure.json'),
    'utf8',
  ),
).payload as Record<string, unknown>;

function dequeued(number: number, headSha: string, reason = 'CI_FAILURE') {
  const pr = structuredClone(captured['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return {
    ...captured,
    reason,
    number,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: pr,
  };
}

let guid = 0;
const eject = (number: number, headSha: string, reason?: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    dequeued(number, headSha, reason),
    `g-${++guid}`,
  );

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
  // Every scenario connects the SAME installation and repository, so the
  // previous scenario's organisation lets it go first (MOTIR-8218).
  await releaseProviderRepo(REPO_PROVIDER_ID);
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
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

const ci = (number: number, headSha: string) =>
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

async function card(s: Scenario, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Queued work' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
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
      },
    });
  }
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const pr = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const awaitingGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });
const latestExit = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findFirstOrThrow({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'desc' },
  });
const markQueued = async (number: number, authority: 'gate' | 'auto_mode') =>
  adminDb.githubPullRequest.update({
    where: { id: (await pr(number)).id },
    data: { mergeAuthority: authority, mergeOutcomeRef: `queue:entry-${number}` },
  });

function stubHost(answer: MergeChangeRequestResult, onCall?: () => Promise<void>) {
  return vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async () => {
    await onCall?.();
    return answer;
  });
}

/** A `manual` card with #11 and #12, approved, both queued — and #11 then EJECTED for a
 *  failure, so the card reads `implemented`. */
async function ejectedManual(email: string, reason = 'CI_FAILURE') {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, [11, 12]);
  await ci(11, 'sha-a');
  await ci(12, 'sha-b');
  const [gate] = await awaitingGates(item.id);
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
    s.ctx,
  );
  await markQueued(11, 'gate');
  await markQueued(12, 'gate');
  await eject(11, 'sha-a', reason);
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved, prId: (await pr(11)).id };
}

/** The same card after the queue removed #11, with the SIBLING already merged — so the
 *  re-asked gate covers exactly one un-landed member and the host is called once. Returns
 *  that fresh `awaiting` gate, which is what the row's verb decides (MOTIR-5802).
 *
 *  ⚠️ The default reason is BRANCH PROTECTION, not `CI_FAILURE`: since the FIFTH
 *  AMENDMENT (MOTIR-6594) a queue failure is CAN'T-LAND and re-asks nothing, and a
 *  setting-blocked exit is the failure that still does. */
async function reaskedManual(email: string, reason = 'BRANCH_PROTECTIONS') {
  const ejected = await ejectedManual(email, reason);
  await adminDb.githubPullRequest.update({
    where: { id: (await pr(12)).id },
    data: { merged: true, state: 'closed' },
  });
  const [reasked] = await awaitingGates(ejected.item.id);
  return { ...ejected, reasked: reasked! };
}

const press = (s: Scenario, approvalGateId: string, pullRequestId: string) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    { approvalGateId, pullRequestId, noteMd: null, source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
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

describe('manual mode — Queue again on the card’s ONE decided approval', () => {
  // REPLACES the THIRD AMENDMENT's "re-enqueues … returns the card to approved" test,
  // which asserted the `implemented → approved` write this card removes (MOTIR-5802).
  it('a FAILURE exit is REFUSED — nothing is stamped, no host is called, the card and its gates are unchanged', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-failure@example.com');
    const statusBefore = await statusOf(item.id);
    const gatesBefore = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id },
      orderBy: { createdAt: 'asc' },
    });
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_2' });
    sent.length = 0;

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      pullRequestId: prId,
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(11)).requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe(statusBefore);
    expect(
      await adminDb.approvalGate.findMany({
        where: { workItemId: item.id },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual(gatesBefore);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  // REPLACES the THIRD AMENDMENT's "a neutral exit re-enqueues on the standing approval"
  // test: point 1 admits no exception, and Yue settled the neutral case by name
  // (2026-09-19, *"re-ask too"*).
  it('a NEUTRAL exit is REFUSED too — the approval that sent it has been spent', async () => {
    const { s, approved, prId } = await ejectedManual('manual-neutral@example.com', 'MANUAL');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_3' });
    sent.length = 0;

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      pullRequestId: prId,
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(11)).requeuedAt).toBeNull();
    // The decided gate is byte-for-byte what it was.
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('a CONFLICT exit holds the card at Implemented, asks nothing, and refuses the press', async () => {
    const { s, item, approved, prId } = await ejectedManual(
      'manual-conflict@example.com',
      'MERGE_CONFLICT',
    );
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_C' });

    // CAN'T LAND (§4 FOURTH AMENDMENT, point 2): the commits cannot combine as they
    // stand, so the card waits at Implemented with `motir fix` and NOTHING is asked.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(11)).requeuedAt).toBeNull();
  });

  // ⚠️ A GATE THE OLD RULE RE-ASKED FROM A QUEUE FAILURE (MOTIR-6594; §4 FIFTH AMENDMENT).
  // Nothing raises one any more, but a card stranded before the convergence (MOTIR-6595)
  // still holds it. Its press re-queues NOTHING: the commits cannot land as they stand,
  // and the refusal names the FAILURE — never a conflict that does not exist.
  it.each(['CI_FAILURE', 'CI_TIMEOUT', 'INVALID_MERGE_COMMIT', 'GIT_TREE_INVALID'])(
    'a gate re-asked from a %s exit is refused MERGE_QUEUE_FAILED_NEEDS_FIX and enqueues nothing',
    async (reason) => {
      const { s, reasked, prId } = await reaskedManual(`stranded-${reason}@example.com`);
      // The exit as the OLD rule recorded it: the same row, reason a queue failure.
      await adminDb.githubPullRequestQueueExit.updateMany({
        where: { pullRequestId: prId },
        data: { rawReason: reason, disposition: 'failure' },
      });
      const host = stubHost({ outcome: 'enqueued', entryId: `MQE_${reason}` });

      const outcome = await press(s, reasked.id, prId);

      expect(outcome).toMatchObject({
        pullRequestId: prId,
        outcome: 'refused',
        refusal: { tag: 'MERGE_QUEUE_FAILED_NEEDS_FIX', reason },
      });
      expect(host).not.toHaveBeenCalled();
      expect((await latestExit(11)).requeuedAt).toBeNull();
    },
  );

  it('the same stranded gate over a MERGE_CONFLICT exit is still refused MERGE_CONFLICT', async () => {
    const { s, reasked, prId } = await reaskedManual('stranded-conflict@example.com');
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { rawReason: 'MERGE_CONFLICT', disposition: 'failure' },
    });
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_SC' });

    const outcome = await press(s, reasked.id, prId);

    expect(outcome).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect(host).not.toHaveBeenCalled();
  });

  it('pressing the RE-ASKED gate IS the new approval — it decides it, enqueues once and returns the card to approved', async () => {
    const { s, item, approved, prId, reasked } = await reaskedManual('manual-reask@example.com');
    // The failure exit put the card back at In Review with ONE fresh question (MOTIR-5805).
    expect(await statusOf(item.id)).toBe('in_review');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_R' });
    sent.length = 0;

    const outcome = await press(s, reasked.id, prId);

    expect(outcome).toMatchObject({ pullRequestId: prId, outcome: 'enqueued' });
    expect(host).toHaveBeenCalledTimes(1);
    expect(host.mock.calls[0]![0]).toMatchObject({ number: 11, expectedHeadSha: 'sha-a' });
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:MQE_R');
    expect((await latestExit(11)).requeuedAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    // The press DECIDED the fresh gate — that is what makes it an approval — and left the
    // earlier one untouched as history.
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked.id } });
    expect(decided.state).toBe('approved');
    expect(decided.decidedById).toBe(s.user.id);
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a moved head is refused, and nothing is claimed and no host is called', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-moved@example.com');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_4' });
    await ci(11, 'sha-a2');
    // The push re-armed the card with its ONE fresh question.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toHaveLength(1);

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(11)).requeuedAt).toBeNull();
  });

  it('a host refusal releases the claim, so the exit is offered again', async () => {
    const { s, item, reasked, prId } = await reaskedManual('manual-refused@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'conflict' } });

    const outcome = await press(s, reasked.id, prId);

    expect(outcome).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect((await latestExit(11)).requeuedAt).toBeNull();
    // ⚠️ THE REFUSAL IS ITSELF AN UN-LANDED OUTCOME (MOTIR-5833): it is recorded on the
    // pull request and settled by its class, and `conflict` is CAN'T LAND — so the press
    // that was just made is spent, the card is held at Implemented, and the row offers
    // no verb at all. `motir fix` is the way forward.
    expect(await statusOf(item.id)).toBe('implemented');
    const members = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: reasked.id },
      s.ctx,
    );
    expect(members.find((m) => m.pullRequestId === prId)).toMatchObject({
      requeueable: false,
      refusal: { code: 'conflict', landingClass: 'cant_land' },
    });
  });

  it('a host FAULT releases the claim and is rethrown, not dressed as a refusal', async () => {
    const { s, item, reasked, prId } = await reaskedManual('manual-fault@example.com');
    vi.spyOn(github, 'mergeChangeRequest').mockRejectedValue(new Error('the host is on fire'));

    await expect(press(s, reasked.id, prId)).rejects.toThrow('the host is on fire');
    expect((await latestExit(11)).requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a second press on the same exit is refused and enqueues nothing', async () => {
    const { s, reasked, prId } = await reaskedManual('manual-twice@example.com');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_5' });

    await press(s, reasked.id, prId);
    // The gate the first press DECIDED carries the decision out; the exit it stamped is
    // what refuses a second enqueue.
    const second = await press(s, reasked.id, prId);

    expect(second).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    expect(host).toHaveBeenCalledTimes(1);
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:MQE_5');
  });

  it('two presses at once enqueue exactly once, and the other is refused', async () => {
    const { s, reasked, prId } = await reaskedManual('manual-race@example.com');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_6' }, () => gate);

    const both = Promise.allSettled([press(s, reasked.id, prId), press(s, reasked.id, prId)]);
    // Let both reach the gate before the winner's host call returns.
    await new Promise((r) => setTimeout(r, 200));
    release();
    const settled = await both;

    // ⚠️ THE GATE IS NOW THE RACE'S GUARD, not the exit's claim (MOTIR-5802): the press IS
    // the approval, so the loser meets the DECISION door's own refusal — the same one two
    // people pressing Approve at once meet, which every surface already renders.
    expect(host).toHaveBeenCalledTimes(1);
    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe('enqueued');
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ApprovalGateAlreadyDecidedError,
    );
  });

  it('the auto entry point refuses a manual project', async () => {
    const { s, item, prId } = await ejectedManual('manual-auto-door@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'wrong_mode' });
  });
});

describe('the members read — requeueable only where Queue again is honest', () => {
  it('is true for a standing exit at the approved head, and false otherwise', async () => {
    // A FAILURE that still re-asks (a setting), so the re-asked gate below exists.
    const { s, item, approved, prId } = await ejectedManual(
      'read@example.com',
      'BRANCH_PROTECTIONS',
    );
    const read = async () =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: approved.id },
          s.ctx,
        )
      ).find((m) => m.pullRequestId === prId)!;
    const sibling = async () =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: approved.id },
          s.ctx,
        )
      ).find((m) => m.pullRequestId !== prId)!;

    // A standing FAILURE exit at the head the approval named: NOT requeueable — the card is
    // asked again instead (§4 FOURTH AMENDMENT, point 4; MOTIR-5802).
    expect(await read()).toMatchObject({
      requeueable: false,
      retryable: false,
      queued: false,
      exit: {
        rawReason: 'BRANCH_PROTECTIONS',
        disposition: 'failure',
        headSha: 'sha-a',
        requeuedAt: null,
      },
    });
    // A member the queue never removed.
    expect(await sibling()).toMatchObject({ requeueable: false, exit: null, queued: true });

    // The SAME exit, NEUTRAL: still not requeueable on this approval (MOTIR-5802, point 1).
    // One approval authorizes one enqueue, and a hand removal spends it exactly as a
    // failure does — Yue, 2026-09-19: *"re-ask too"*.
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { disposition: 'neutral', rawReason: 'MANUAL' },
    });
    expect(await read()).toMatchObject({
      requeueable: false,
      retryDecidesGateId: null,
      exit: { rawReason: 'MANUAL', disposition: 'neutral', headSha: 'sha-a', requeuedAt: null },
    });

    // …and it IS offered on the RE-ASKED gate, whose id the row presses: that press is the
    // new approval (point 4).
    const [reasked] = await awaitingGates(item.id);
    expect(reasked).toBeDefined();
    const onReask = (
      await pullRequestMergeService.listApprovalMembers(
        { workItemId: item.id, approvalGateId: reasked!.id },
        s.ctx,
      )
    ).find((m) => m.pullRequestId === prId);
    expect(onReask).toMatchObject({ requeueable: true, retryDecidesGateId: reasked!.id });

    // …but NOT for a queue FAILURE, even on that gate (MOTIR-6594): it is CAN'T-LAND, so
    // the row offers no verb and `motir fix` is the way forward.
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { disposition: 'failure', rawReason: 'CI_FAILURE' },
    });
    expect(
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: reasked!.id },
          s.ctx,
        )
      ).find((m) => m.pullRequestId === prId),
    ).toMatchObject({ requeueable: false });

    // Put back: no longer requeueable.
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { requeuedAt: new Date() },
    });
    expect(await read()).toMatchObject({ requeueable: false });

    // A fresh exit at a head the approval did not name (the member was pushed).
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: prId,
        deliveryId: 'g-moved',
        rawReason: 'CI_FAILURE',
        disposition: 'failure',
        headSha: 'sha-other',
        exitedAt: new Date(Date.now() + 1000),
      },
    });
    await ci(11, 'sha-other');
    expect(await read()).toMatchObject({ requeueable: false });
  });
});

describe('auto mode — a person’s Queue again', () => {
  async function ejectedAuto(email: string) {
    const s = await makeScenario(email, 'auto');
    const item = await card(s, [21]);
    await ci(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await markQueued(21, 'auto_mode');
    await eject(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('implemented');
    return { s, item, prId: (await pr(21)).id };
  }

  it('re-dispatches the same head under a NEW key and returns the card to in_review', async () => {
    const { s, item, prId } = await ejectedAuto('auto-ok@example.com');
    const firstKey = `${prId}:sha-auto`;
    expect(sent.some((e) => e.data['idempotencyKey'] === firstKey)).toBe(true);
    const exit = await latestExit(21);
    sent.length = 0;

    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    expect(result).toEqual({ pullRequestId: prId, headSha: 'sha-auto', status: 'in_review' });
    const dispatched = sent.filter((e) => e.name === 'pull-request/auto-merge.requested');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.data).toMatchObject({
      pullRequestId: prId,
      headSha: 'sha-auto',
      idempotencyKey: `${prId}:sha-auto:requeue:${exit.id}`,
    });
    expect(dispatched[0]!.data['idempotencyKey']).not.toBe(firstKey);
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await latestExit(21)).requeuedAt).not.toBeNull();
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a second call is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-twice@example.com');
    await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyRequeuedError);
  });

  it('a moved head is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-moved@example.com');
    await ci(21, 'sha-auto-2');

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'head_moved' });
  });

  it('a caller without work_item:edit is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-perm@example.com');
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValue(
      new PermissionDeniedError(s.project.id, 'work_item:edit'),
    );

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await latestExit(21)).requeuedAt).toBeNull();
  });

  it('the gate path refuses an auto project — it has no approval to reuse', async () => {
    const { s, prId } = await ejectedAuto('auto-gate-door@example.com');
    await expect(press(s, 'no-such-gate', prId)).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });

  it('an unknown card is not found', async () => {
    const { s, prId } = await ejectedAuto('auto-unknown@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: 'no-such-card', pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('a pull request the card does not deliver is refused', async () => {
    const { s, item } = await ejectedAuto('auto-not-delivered@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: 'no-such-pull-request' },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'not_delivered' });
  });

  it('a closed pull request is refused, and nothing is claimed', async () => {
    const { s, item, prId } = await ejectedAuto('auto-closed@example.com');
    await adminDb.githubPullRequest.update({ where: { id: prId }, data: { state: 'closed' } });

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'not_open' });
    expect((await latestExit(21)).requeuedAt).toBeNull();
  });

  it('re-dispatches but leaves a card a person has since moved elsewhere', async () => {
    const { s, item, prId } = await ejectedAuto('auto-moved-card@example.com');
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    sent.length = 0;

    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    expect(result).toMatchObject({ status: 'in_progress' });
    expect(await statusOf(item.id)).toBe('in_progress');
    expect(sent.map((e) => e.name)).toEqual(['pull-request/auto-merge.requested']);
  });

  it('the standing-exits read offers Queue again until the head moves or it is put back', async () => {
    const { s, item, prId } = await ejectedAuto('auto-read@example.com');
    const read = () =>
      pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx);

    expect(await read()).toEqual([
      expect.objectContaining({
        pullRequestId: prId,
        repo: 'moooon/acme',
        number: 21,
        requeueable: true,
        exit: expect.objectContaining({
          rawReason: 'CI_FAILURE',
          disposition: 'failure',
          failingCheckName: null,
        }),
      }),
    ]);

    await ci(21, 'sha-auto-2');
    expect(await read()).toEqual([expect.objectContaining({ requeueable: false })]);

    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { requeuedAt: new Date() },
    });
    expect(await read()).toEqual([]);
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: 'no-such-card' }, s.ctx),
    ).toEqual([]);
  });

  it('the standing-exits read answers nothing for a closed pull request or a manual project', async () => {
    const { s, item, prId } = await ejectedAuto('auto-read-closed@example.com');
    await adminDb.githubPullRequest.update({ where: { id: prId }, data: { state: 'closed' } });
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx),
    ).toEqual([]);

    const manual = await ejectedManual('manual-read@example.com');
    expect(
      await pullRequestMergeService.listStandingQueueExits(
        { workItemId: manual.item.id },
        manual.s.ctx,
      ),
    ).toEqual([]);
  });

  it('a pull request with no standing exit is refused', async () => {
    const s = await makeScenario('auto-no-exit@example.com', 'auto');
    const item = await card(s, [22]);
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: (await pr(22)).id },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(QueueAgainRefusedError);
  });
});

// ── QUEUE AGAIN CLEARS THE CARD'S RED (Story MOTIR-5628 · MOTIR-5717) ────────────
//
// The stamp lifts the queue failure, so every card the pull request delivers is
// recomputed in the stamp's own transaction; a host that refuses releases the stamp,
// and the release recomputes the red back.

describe('the card’s ciState follows Queue again (MOTIR-5717)', () => {
  const ciStateOf = async (id: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;

  // The manual press no longer re-queues a FAILURE exit (MOTIR-5802), so it no longer
  // stamps it either: the red stands until the fresh gate's approval re-queues it
  // (MOTIR-5805) or a push moves the head. A NEUTRAL exit never folds into the verdict.
  it('manual: an ejected card reads failing, and the refused press leaves it failing', async () => {
    const { s, item, approved, prId } = await ejectedManual('ci-manual-ok@example.com');
    expect(await ciStateOf(item.id)).toBe('failing');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_CI' });

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('manual: a conflict ejection reads failing too', async () => {
    const { item } = await ejectedManual('ci-manual-conflict@example.com', 'MERGE_CONFLICT');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('auto: a person’s Queue again clears the card’s red', async () => {
    const s = await makeScenario('ci-auto@example.com', 'auto');
    const item = await card(s, [21]);
    await ci(21, 'sha-auto');
    await markQueued(21, 'auto_mode');
    await eject(21, 'sha-auto');
    expect(await ciStateOf(item.id)).toBe('failing');

    await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: (await pr(21)).id },
      s.ctx,
    );

    expect(await ciStateOf(item.id)).toBe('passing');
  });
});

// ── THE TWO PLACES A CARD DOES NOT MOVE (MOTIR-5805) ────────────────────────────
//
// A queue exit's job is to leave the card where the reason says it belongs. Both of
// these leave it exactly where it was, and each is a different KIND of not-moving: one
// because the reason carries no verdict about the code, the other because the project's
// own workflow has no edge to move along.
describe('a removal that moves nothing', () => {
  it('auto mode, a NEUTRAL removal: nothing is recorded as moved, and the card stays implemented', async () => {
    const s = await makeScenario('auto-neutral@example.com', 'auto');
    const item = await card(s, [23]);
    await ci(23, 'sha-auto-neutral');
    await markQueued(23, 'auto_mode');
    // The status an ENQUEUED card sits at in `auto` — the one a removal is read against.
    expect(await statusOf(item.id)).toBe('in_review');

    // ⚠️ ONLY A FAILURE MOVES AN AUTO CARD (§ 4 THIRD AMENDMENT, decision 3, which the
    // FOURTH leaves standing for `auto`). Somebody taking the pull request out by hand
    // says nothing about the commits, and in auto mode there is no approval to spend and
    // nobody to ask — so unlike `manual`, where a neutral removal now re-asks, the exit
    // is recorded and the card is left exactly where it was.
    const result = await eject(23, 'sha-auto-neutral', 'MANUAL');

    expect(result).toMatchObject({ outcome: 'recorded', disposition: 'neutral', moved: [] });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('Queue again on a project whose workflow has no `implemented → in_review` edge re-dispatches anyway', async () => {
    const s = await makeScenario('auto-no-edge@example.com', 'auto');
    const item = await card(s, [24]);
    await ci(24, 'sha-auto');
    await markQueued(24, 'auto_mode');
    await eject(24, 'sha-auto');
    expect(await statusOf(item.id)).toBe('implemented');
    const prId = (await pr(24)).id;
    sent.length = 0;
    // A project that EDITED its workflow: the rung this return would walk is not there.
    // The re-dispatch is the point of the press and must still happen — the card simply
    // stays where it is, and the refusal is logged rather than thrown, because a person
    // pressing *Queue again* is asking for a merge attempt, not for a status change.
    const workflow = await adminDb.workflowStatus.findMany({
      where: { projectId: s.project.id, key: { in: ['implemented', 'in_review'] } },
    });
    const from = workflow.find((w) => w.key === 'implemented')!;
    const to = workflow.find((w) => w.key === 'in_review')!;
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: s.project.id, fromStatusId: from.id, toStatusId: to.id },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    expect(result).toMatchObject({ pullRequestId: prId, headSha: 'sha-auto' });
    expect(sent.some((e) => e.name === 'pull-request/auto-merge.requested')).toBe(true);
    expect(await statusOf(item.id)).toBe('implemented');
    expect(warn).toHaveBeenCalledWith(
      '[mergeQueueExitService] Queue again could not return the card',
      expect.objectContaining({ workItemId: item.id, to: 'in_review' }),
    );
  });
});
