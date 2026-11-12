import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { pullRequestSubjectVersion } from '@/lib/approvalGates/deliverySetVersion';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { settleGreenVerdict } from '@/lib/services/mergeGates';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import {
  autoMergeRefusedCommentBody,
  pullRequestAutoMergeService,
} from '@/lib/services/pullRequestAutoMergeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE MERGE STORY'S DATABASE EDGES (Story MOTIR-4882 · MOTIR-5519 — the coverage floor
// over MOTIR-5515, MOTIR-5517 and MOTIR-5518). The children's own suites drive the
// journeys; this one drives the answers that are NOT the journey — a gate whose pull
// request is gone, a kind the entry point is not for, a provider that cannot merge — so
// every arm of the merge path is a tested answer rather than an untested guess.

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

let seq = 0;

/** A card in review delivered by one pull request green at HEAD, holding the card's ONE
 *  approve-to-merge gate over that set, assigned to the fixture's owner. `approved` decides
 *  it the way a press would, for the paths that run AFTER an approval (MOTIR-5613). */
async function cardWithPr(opts: { parentId?: string; gate?: boolean; approved?: boolean } = {}) {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.parentId ? 'task' : 'story',
      title: `Merge me ${seq}`,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-edges-${seq}-${item.id}`,
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
      repoId: `repo-edges-${seq}-${item.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: seq,
      title: 'Merge me',
      state: 'open',
      headRef: `subtask/merge-me-${seq}`,
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
  const gate =
    opts.gate === false
      ? null
      : await adminDb.approvalGate.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item.id,
            kind: 'pull_request_approval',
            // THE CARD is the subject of its one gate; the version names its members.
            subjectId: item.id,
            subjectVersion: `acme/web#${seq}@${HEAD}`,
            routedToId: fx.ownerId,
            ...(opts.approved
              ? { state: 'approved' as const, decidedById: fx.ownerId, decidedAt: new Date() }
              : {}),
          },
        });
  return { item, repo, pr, gate };
}

/** A bare work item in `on`, for a gate that hangs off something other than a delivery. */
async function bareItem(on: WorkItemFixture = fx) {
  return workItemsService.createWorkItem(
    { projectId: on.projectId, kind: 'task', title: 'Bare' },
    on.ctx,
  );
}

const inTx = <T>(
  fn: (tx: Parameters<Parameters<typeof withWorkspaceContext>[1]>[0]) => Promise<T>,
) => withWorkspaceContext(fx.ctx, fn);
const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const setMode = (mode: 'auto' | 'manual') =>
  adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: mode, prMergeModeDecidedAt: new Date() },
  });

describe('the MEMBER VERSION rule, when there is no head', () => {
  // The spelling outlived the handler it was written in: MOTIR-5616 retired the
  // `pull_request_merge` kind and its handler, and moved this function beside the SET
  // version, which is the only thing that still compares member versions.
  it('a pull request no check has reported on has no version', () => {
    expect(
      pullRequestSubjectVersion({
        number: 7,
        repo: { owner: 'acme', name: 'web' },
        headSha: null,
        checkRuns: [],
      }),
    ).toBeNull();
  });

  it('a caller that KNOWS the head names it, whatever the checks say', () => {
    expect(
      pullRequestSubjectVersion(
        { number: 7, repo: { owner: 'acme', name: 'web' }, headSha: null, checkRuns: [] },
        'deadbeef',
      ),
    ).toBe('acme/web#7@deadbeef');
  });
});

describe('settleGreenVerdict — the answers that owe nothing', () => {
  it('no members, or a project that no longer resolves, settle to nothing', async () => {
    const { item, pr } = await cardWithPr({ gate: false });
    const row = await itemRow(item.id);
    await inTx(async (tx) => {
      expect(await settleGreenVerdict({ item: row, pullRequestIds: [] }, fx.ctx, tx)).toEqual([]);
      expect(
        await settleGreenVerdict(
          { item: { ...row, projectId: 'no-such-project' }, pullRequestIds: [pr.id] },
          fx.ctx,
          tx,
        ),
      ).toEqual([]);
    });
  });

  it('AUTO: the run target owes its green pull request; a child under it and a closed pull request owe nothing', async () => {
    await setMode('auto');
    const story = await cardWithPr({ gate: false });
    await adminDb.testInstructions.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.item.id,
        bodyMd: '## Open',
      },
    });
    const child = await cardWithPr({ parentId: story.item.id, gate: false });
    const [storyRow, childRow] = [await itemRow(story.item.id), await itemRow(child.item.id)];

    await inTx(async (tx) => {
      expect(
        await settleGreenVerdict({ item: storyRow, pullRequestIds: [story.pr.id] }, fx.ctx, tx),
      ).toEqual([{ pullRequestId: story.pr.id, headSha: HEAD }]);
      expect(
        await settleGreenVerdict({ item: childRow, pullRequestIds: [child.pr.id] }, fx.ctx, tx),
      ).toEqual([]);
    });

    await adminDb.githubPullRequest.update({
      where: { id: story.pr.id },
      data: { state: 'closed' },
    });
    await inTx(async (tx) => {
      expect(
        await settleGreenVerdict({ item: storyRow, pullRequestIds: [story.pr.id] }, fx.ctx, tx),
      ).toEqual([]);
    });
  });
});

describe('the merge ENTRY POINT refuses before it reaches a host', () => {
  // Since MOTIR-5613 the entry point is addressed by (the card's own gate, a pull request),
  // so these are the answers a RETRY gives before any host is called — and the approval it
  // could not act on is never re-asked.
  const retry = (approvalGateId: string, pullRequestId: string) =>
    pullRequestMergeService.retryApproveAndMergeMember(
      { approvalGateId, pullRequestId, source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

  it('an unknown gate is a not-found', async () => {
    await expect(retry('no-such-gate', 'no-such-pull-request')).rejects.toBeInstanceOf(
      ApprovalGateNotFoundError,
    );
  });

  it('a gate of ANOTHER kind is a programming error for the press, and decideGate hands it to the door', async () => {
    // ⚠️ `pull_request_merge`, not a PRIMARY kind — MOTIR-5664 ADMITS the design kind
    // by name, and MOTIR-5677 the decision kind, because pressing a primary is what
    // merges the set. The guard is still the guard: a kind it does not know is still a
    // programming error. (`decision_approval` stood here until MOTIR-5677.)
    const bare = await bareItem();
    const foreign = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: bare.id,
        kind: 'pull_request_merge',
        subjectId: 'ev-1',
      },
    });
    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: foreign.id, source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toThrow(/handed a pull_request_merge gate/);
    // …and a retry addressed at it is simply not a gate this path knows.
    await expect(retry(foreign.id, 'no-such-pull-request')).rejects.toBeInstanceOf(
      ApprovalGateNotFoundError,
    );

    const door = vi.spyOn(approvalGatesService, 'decide').mockResolvedValue({} as never);
    await pullRequestMergeService.decideGate(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: foreign.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    expect(door).toHaveBeenCalledWith(
      // The stamp travels to the door unchanged (MOTIR-5234).
      { gateId: foreign.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
  });

  it('a gate whose WORK ITEM is another workspace’s is a not-found', async () => {
    const foreign = await makeWorkItemFixture();
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: (await bareItem(foreign)).id,
        kind: 'pull_request_approval',
        subjectId: 'pr-foreign',
      },
    });
    await expect(retry(gate.id, 'no-such-pull-request')).rejects.toBeInstanceOf(
      ApprovalGateNotFoundError,
    );
  });

  it('each state that is not `approved` gets the refusal that is TRUE of it, with no host call', async () => {
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    // Withdrawn: the question is gone.
    const withdrawn = await cardWithPr();
    await adminDb.approvalGate.update({
      where: { id: withdrawn.gate!.id },
      data: { state: 'superseded' },
    });
    await expect(retry(withdrawn.gate!.id, withdrawn.pr.id)).rejects.toBeInstanceOf(
      ApprovalGateSupersededError,
    );

    // Changes requested: a decision, and one that merges nothing.
    const refused = await cardWithPr();
    await adminDb.approvalGate.update({
      where: { id: refused.gate!.id },
      data: { state: 'changes_requested', decidedById: fx.ownerId, decidedAt: new Date() },
    });
    await expect(retry(refused.gate!.id, refused.pr.id)).rejects.toBeInstanceOf(
      ApprovalGateAlreadyDecidedError,
    );

    // ⚠️ AWAITING IS NO LONGER A REFUSAL (MOTIR-5802; §4 FOURTH AMENDMENT, point 4):
    // the row's press on the RE-ASKED gate IS the new approval, and it goes through the
    // decide door. That path is asserted in `tests/github/queueAgain.test.ts`; what
    // belongs here is that the two DECIDED states still refuse, above.
    expect(seam).not.toHaveBeenCalled();
  });

  it('a pull request this card does not deliver is superseded — and the approval is NOT withdrawn', async () => {
    const { gate, pr } = await cardWithPr({ approved: true });
    await adminDb.workItemDelivery.deleteMany({ where: { githubPullRequestId: pr.id } });

    await expect(retry(gate!.id, pr.id)).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    // ⚠️ ONE GATE PER CARD: a member that left is not a reason to re-ask the whole set.
    expect((await gateRow(gate!.id)).state).toBe('approved');
  });

  it('a member on a provider that cannot merge is a programming error, never a refusal', async () => {
    const { repo, gate, pr } = await cardWithPr({ approved: true });
    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'gitlab' } });
    await expect(retry(gate!.id, pr.id)).rejects.toThrow(/is a member of an approved gate/);
  });

  it('a seam that throws something other than a host failure is rethrown, unlogged and unrecorded', async () => {
    const { gate, pr } = await cardWithPr({ approved: true });
    vi.spyOn(github, 'mergeChangeRequest').mockRejectedValue(new Error('a bug in the provider'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(retry(gate!.id, pr.id)).rejects.toThrow('a bug in the provider');
    expect(logged).not.toHaveBeenCalled();
    expect((await gateRow(gate!.id)).state).toBe('approved');
    expect(
      (await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } })).mergeOutcomeRef,
    ).toBeNull();
  });
});

describe('the AUTO merge skips what it was not dispatched for', () => {
  const data = (pullRequestId: string, workItemId: string) => ({
    workspaceId: fx.workspaceId,
    workItemId,
    pullRequestId,
    headSha: HEAD,
    actorUserId: fx.ownerId,
    idempotencyKey: `${pullRequestId}:${HEAD}`,
  });

  it('gone, not open, a provider that cannot merge, and a head that moved under the merge', async () => {
    const bare = await bareItem();
    const seam = vi.spyOn(github, 'mergeChangeRequest');
    await expect(
      pullRequestAutoMergeService.mergeOnGreen(data('no-such-pull-request', bare.id), {
        finalAttempt: false,
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'gone' });

    const closed = await cardWithPr({ gate: false });
    await adminDb.githubPullRequest.update({
      where: { id: closed.pr.id },
      data: { state: 'closed' },
    });
    await expect(
      pullRequestAutoMergeService.mergeOnGreen(data(closed.pr.id, closed.item.id), {
        finalAttempt: false,
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'not_open' });

    const gitlab = await cardWithPr({ gate: false });
    await adminDb.githubRepo.update({
      where: { id: gitlab.repo.id },
      data: { provider: 'gitlab' },
    });
    await expect(
      pullRequestAutoMergeService.mergeOnGreen(data(gitlab.pr.id, gitlab.item.id), {
        finalAttempt: false,
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'provider_cannot_merge' });
    expect(seam).not.toHaveBeenCalled();

    const moved = await cardWithPr({ gate: false });
    seam.mockResolvedValueOnce({ outcome: 'refused', refusal: { code: 'subject_changed' } });
    await expect(
      pullRequestAutoMergeService.mergeOnGreen(data(moved.pr.id, moved.item.id), {
        finalAttempt: false,
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'head_moved' });
    // A moved head is not a refusal to report — no comment on the card.
    expect(await adminDb.comment.count({ where: { workItemId: moved.item.id } })).toBe(0);
  });

  it('the permission refusal names the permission when GitHub named one, and says so when it did not', () => {
    expect(
      autoMergeRefusedCommentBody('acme/web#7', {
        code: 'app_permission_missing',
        permission: 'contents: write',
      }),
    ).toContain('grants contents: write');
    expect(autoMergeRefusedCommentBody('acme/web#7', { code: 'app_permission_missing' })).toContain(
      'the permission GitHub asked for',
    );
  });
});

describe('the gate repository write the raise uses', () => {
  it('create is the raise’s only writer and needs no mock — a sanity read of the row it writes', async () => {
    const { gate } = await cardWithPr();
    expect(await inTx((tx) => approvalGateRepository.findById(gate!.id, tx))).toMatchObject({
      kind: 'pull_request_approval',
      state: 'awaiting',
    });
  });
});
