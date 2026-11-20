import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { ApprovalGateError, ApprovalGateNotAuthorisedError } from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  APPROVAL_MERGE_PERMISSION,
  pullRequestMergeService,
} from '@/lib/services/pullRequestMergeService';
import { pullRequestApprovalGateHandler } from '@/lib/approvalGates/pullRequestApprovalHandler';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE MERGE ENTRY POINT (Story MOTIR-4882 · MOTIR-5517 · MOTIR-5613), against a REAL
// Postgres. The host is the seam's `mergeChangeRequest`, stubbed per case — the one thing
// that leaves the process.
//
// ⚠️ RE-KEYED ONTO THE CARD'S OWN GATE. There is ONE approve-to-merge gate per card, so a
// merge is addressed by (that gate, the pull request) and no `pull_request_merge` row
// exists for any of this. The property under test is the ORDER — check, merge, then RECORD
// on the pull request — and the new half of it: a refusal leaves the APPROVAL standing.

const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seatedOn(role: 'member' | 'viewer') {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A card in review, delivered by pull request #7 green at HEAD, holding the card's ONE
 *  awaiting approve-to-merge gate over that set — the state
 *  `raisePullRequestApprovalGate` leaves. */
async function cardWithGate(assigneeId: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Merge me' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });

  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5517-${item.id}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-5517-${item.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 7,
      title: 'Merge me',
      state: 'open',
      headRef: 'subtask/merge-me',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        // ⚠️ THE CARD is the subject; the version names its members.
        subjectId: item.id,
        subjectVersion: `acme/web#7@${HEAD}`,
        routedToId: assigneeId,
      },
      tx,
    ),
  );
  return { item, pr, gate, installation };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const prRow = (id: string) => adminDb.githubPullRequest.findUniqueOrThrow({ where: { id } });

function stubSeam(...answers: Array<MergeChangeRequestResult | Error>) {
  const spy = vi.spyOn(github, 'mergeChangeRequest');
  for (const answer of answers) {
    if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
    else spy.mockResolvedValueOnce(answer);
  }
  return spy;
}

describe('APPROVE MERGES THE SET — one gate decided, then each pull request', () => {
  it('merged: ONE seam call at the approved head with no transaction open; the card is approved and the PULL REQUEST carries the outcome', async () => {
    const assignee = await seatedOn('member');
    const { item, pr, gate, installation } = await cardWithGate(assignee.user.id);

    // Count the transactions open at the moment the host is called.
    let open = 0;
    let opened = 0;
    let openAtSeam = -1;
    const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(db, '$transaction').mockImplementation(((...args: unknown[]) => {
      open += 1;
      opened += 1;
      return realTransaction(...args).finally(() => {
        open -= 1;
      });
    }) as typeof db.$transaction);
    const seam = vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async () => {
      openAtSeam = open;
      return { outcome: 'merged', commitSha: 'f00dfeedcafe' };
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      installationId: installation.installationId,
      owner: 'acme',
      name: 'web',
      number: 7,
      expectedHeadSha: HEAD,
    });
    // The spy really sits on the transaction entry — the decision, the check and the
    // record each opened one — so the zero below is a measurement, not a default.
    expect(opened).toBeGreaterThanOrEqual(3);
    expect(openAtSeam).toBe(0);

    expect(result.approval.gate.state).toBe('approved');
    // The gate's outcome is the STATUS it moved the card to; a merge writes nothing here.
    expect(result.approval.gate.outcomeRef).toBe('approved');
    expect(result.members).toEqual([
      { subjectVersion: `acme/web#7@${HEAD}`, pullRequestId: pr.id, outcome: 'merged' },
    ]);
    expect((await prRow(pr.id)).mergeAuthority).toBe('gate');
    expect((await prRow(pr.id)).mergeOutcomeRef).toBe('f00dfeedcafe');
    // ONE gate, and it is the card's. Nothing raised a second one to decide.
    expect(await adminDb.approvalGate.findMany({ where: { workItemId: item.id } })).toHaveLength(1);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(card.status).toBe('approved');
  });

  it('enqueued: the pull request records queue:<entryId>, and the merge leaves no mark on the gate', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    stubSeam({ outcome: 'enqueued', entryId: 'MQE_1' });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'api' },
      assignee.ctx,
    );

    expect(result.approval.gate.state).toBe('approved');
    expect(result.approval.gate.outcomeRef).toBe('approved');
    expect(result.members[0]).toMatchObject({ outcome: 'enqueued', pullRequestId: pr.id });
    expect((await prRow(pr.id)).mergeOutcomeRef).toBe('queue:MQE_1');
  });
});

describe('a host REFUSAL writes nothing — and the APPROVAL still stands', () => {
  const MATRIX = [
    { code: 'checks_not_green', tag: 'MERGE_CHECKS_NOT_GREEN' },
    { code: 'conflict', tag: 'MERGE_CONFLICT' },
    { code: 'branch_protected', tag: 'MERGE_BRANCH_PROTECTED', reason: 'A review is required.' },
    { code: 'already_merged', tag: 'MERGE_ALREADY_MERGED' },
    {
      code: 'app_permission_missing',
      tag: 'MERGE_APP_PERMISSION_MISSING',
      permission: 'contents: write',
    },
  ] as const;

  it.each(MATRIX)('$code → $tag, reported on the member; the gate stays approved', async (row) => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    stubSeam({
      outcome: 'refused',
      refusal: {
        code: row.code,
        ...('reason' in row ? { reason: row.reason } : {}),
        ...('permission' in row ? { permission: row.permission } : {}),
      },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    // The five MERGE_* members round-trip from the seam to the caller unchanged.
    expect(result.members[0]).toMatchObject({
      outcome: 'refused',
      pullRequestId: pr.id,
      refusal: {
        tag: row.tag,
        ...('permission' in row ? { permission: row.permission } : {}),
        ...('reason' in row ? { reason: row.reason } : {}),
      },
    });
    // ⚠️ THE DECISION IS NOT UNDONE BY A REFUSED MERGE — that is what one gate per card
    // means: the person answered *are these commits right?* and a conflict is not an
    // answer to it. The retry presses the same standing approval.
    const after = await gateRow(gate.id);
    expect(after.state).toBe('approved');
    expect(await prRow(pr.id)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
  });

  it('a host that does not ANSWER records nothing, and is logged with the gate and the pull request', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    stubSeam(new MergeChangeRequestError('github', 'timeout'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    // Nothing was decided about the MERGE, so the member is unclassified rather than
    // refused by the host.
    expect(result.members[0]).toMatchObject({ outcome: 'refused', refusal: { tag: 'UNEXPECTED' } });
    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await prRow(pr.id)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('did not answer'),
      expect.objectContaining({ approvalGateId: gate.id, pullRequestId: pr.id }),
    );
  });
});

describe('a THROTTLED merge spends nothing (Bug MOTIR-11841)', () => {
  // GitHub's rate limit answers with the 403 a missing permission answers too. Read as a
  // refusal, each press during the throttle was recorded as `app_permission_missing`,
  // spent the approval and named a permission the App already had. As the seam's
  // `rate_limited` non-answer it records nothing: the approval stands, and the next press
  // merges on it.
  const refusalRows = (pullRequestId: string) =>
    adminDb.githubPullRequestMergeRefusal.count({ where: { pullRequestId } });

  it.each([
    { name: 'a named wait', retryAfterSeconds: 60 },
    { name: 'no named wait', retryAfterSeconds: null },
  ])(
    'with $name: the member names the rate limit, no refusal row is written, and the NEXT press merges without a new approval',
    async ({ retryAfterSeconds }) => {
      const assignee = await seatedOn('member');
      const { item, pr, gate } = await cardWithGate(assignee.user.id);
      stubSeam(
        new MergeChangeRequestError('github', 'rate_limited', { status: 403, retryAfterSeconds }),
        { outcome: 'merged', commitSha: 'f00dfeedcafe' },
      );
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        assignee.ctx,
      );

      expect(result.members[0]).toEqual({
        subjectVersion: `acme/web#7@${HEAD}`,
        pullRequestId: pr.id,
        outcome: 'refused',
        refusal: { tag: 'MERGE_RATE_LIMITED', retryAfterSeconds },
      });
      expect(await refusalRows(pr.id)).toBe(0);
      expect((await gateRow(gate.id)).state).toBe('approved');
      // Not settled back by a refusal class: the card still carries the approval.
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
        'approved',
      );
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('did not answer'),
        expect.objectContaining({ reason: 'rate_limited', status: 403, retryAfterSeconds }),
      );

      // The throttle lifted: the retry presses the SAME standing approval.
      const retried = await pullRequestMergeService.retryApproveAndMergeMember(
        {
          approvalGateId: gate.id,
          pullRequestId: pr.id,
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        assignee.ctx,
      );
      expect(retried).toMatchObject({ outcome: 'merged', pullRequestId: pr.id });
      expect((await prRow(pr.id)).mergeOutcomeRef).toBe('f00dfeedcafe');
      expect(await adminDb.approvalGate.findMany({ where: { workItemId: item.id } })).toHaveLength(
        1,
      );
      expect(await refusalRows(pr.id)).toBe(0);
    },
  );

  it('a PERMISSION refusal, by contrast, is recorded — the line the throttle must not cross', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    stubSeam({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing', permission: 'contents: write' },
    });

    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );
    expect(await refusalRows(pr.id)).toBe(1);
  });
});

describe('a member the card no longer delivers at the approved head is NOT merged', () => {
  it('the pull request CLOSED → nothing to merge, zero seam calls, approval intact', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { state: 'closed' } });
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    expect(seam).not.toHaveBeenCalled();
    // The `no_merge_gate` literal no longer names a gate — MOTIR-5615 renames it with the
    // frame's copy. It means: this card has no pull request to merge at the approved head.
    expect(result.members[0]).toMatchObject({ outcome: 'no_merge_gate', pullRequestId: null });
    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await prRow(pr.id)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
  });

  it('its DELIVERY ROW is gone → the set names no members, and no host is called', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    await adminDb.workItemDelivery.deleteMany({ where: { githubPullRequestId: pr.id } });
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    // ⚠️ THE DOOR RE-RESOLVES THE SET AT DECIDE TIME. A delivery set that can no longer
    // name its commits has no members, so the press approves and merges nothing at all —
    // it does not report a stale member, because there is no member left to report.
    //
    // (A head that MOVED is not this path's case: it supersedes the gate before anyone can
    // press it — MOTIR-5482, covered in `tests/github/mergeGates.test.ts`.)
    expect(result.approval.gate.state).toBe('approved');
    expect(result.members).toEqual([]);
    expect(seam).not.toHaveBeenCalled();
    expect(await prRow(pr.id)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
  });

  it('a seam subject_changed (the 409 that raced the check) is a superseded member, not a refusal a host owns', async () => {
    const assignee = await seatedOn('member');
    const { gate } = await cardWithGate(assignee.user.id);
    stubSeam({ outcome: 'refused', refusal: { code: 'subject_changed' } });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      assignee.ctx,
    );

    expect(result.members[0]).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    // ⚠️ AND THE CARD'S GATE IS NOT WITHDRAWN. One member racing a push is not a reason to
    // re-ask the whole set; the head-move withdrawal is the raise path's (MOTIR-5482).
    expect((await gateRow(gate.id)).state).toBe('approved');
  });
});

describe('the actor and the other verb', () => {
  it('the permission the merge asserts IS the gate’s own floor — the copy cannot drift', () => {
    // The service copies this rather than importing the handler, because importing it
    // closes a module cycle through `workItemsService`. This is the pin that keeps the
    // copy honest.
    expect(APPROVAL_MERGE_PERMISSION).toBe(pullRequestApprovalGateHandler.permission);
  });

  it('an actor without authority is refused with zero seam calls, and decides nothing', async () => {
    const assignee = await seatedOn('member');
    const bystander = await seatedOn('member');
    const { gate } = await cardWithGate(assignee.user.id);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        bystander.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
    expect(seam).not.toHaveBeenCalled();
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('request_changes calls no host and records the decision', async () => {
    const assignee = await seatedOn('member');
    const { gate } = await cardWithGate(assignee.user.id);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    const result = await pullRequestMergeService.decideGate(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        noteMd: 'Not yet',
        source: 'ui',
      },
      assignee.ctx,
    );

    expect(seam).not.toHaveBeenCalled();
    expect(result.gate.state).toBe('changes_requested');
  });
});

describe('two presses at once', () => {
  it('one approves and merges; the other is refused — one decided gate, one merge record, no 500', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithGate(assignee.user.id);
    stubSeam(
      { outcome: 'merged', commitSha: 'c0ffee' },
      { outcome: 'refused', refusal: { code: 'already_merged' } },
    );

    const press = () =>
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        assignee.ctx,
      );
    const outcomes = await Promise.allSettled([press(), press()]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A typed refusal — the frame draws it — never an unclassified error.
    expect(rejected[0]!.reason).toBeInstanceOf(ApprovalGateError);

    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await prRow(pr.id)).toMatchObject({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'c0ffee',
    });
  });
});
