import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// WITH THE REVIEW GATE ON, NO APPROVAL IS ASKED BEFORE THE REVIEW HAS PASSED (Bug
// MOTIR-11992; `approval-gates.md` §12.20, reversing §12.2's "a primary question is not
// delayed"), against a REAL Postgres through the receipt publish, the reconcile and the
// review's decide door. A STORY run with a receipt goes green at `in_review`; before this,
// one reconcile raised `agent_review` AND `acceptance_result` together, so To approve showed
// the acceptance approval beside the review to run (seen on MOTIR-11319). Pinned:
//   - the publish asks the REVIEW alone, and the pass asks the acceptance with the merge;
//   - an acceptance already AWAITING when the review is owed is withdrawn as
//     `review_not_passed` by the next reconcile, and the pass asks it again;
//   - a send-back asks no acceptance either.

vi.mock('@/lib/blob/uploader', () => {
  let n = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({ url: `https://blob.example/${p}-${++n}` })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++n}` })),
    signedDownloadUrl: vi.fn(async (p: string) => `https://blob.example/signed/${p}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const SET_VERSION = `acme/api#12@${HEAD_API},acme/web#7@${HEAD_WEB}`;
const video = () => new File([new Uint8Array(1024)], 'run.webm', { type: 'video/webm' });

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  // The suite's truncate order (MOTIR-3066; `tests/truncate-lock-order.test.ts`).
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "approval_gate" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  // The review gate ON, in the only mode it is honoured in (§12.2a).
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: 'manual', reviewAgentEnabled: true },
  });
});

async function storyInReview(title: string) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

/** A STORY in review whose own run delivered `acme/web#7` and `acme/api#12`, both green. */
async function storyRun() {
  const story = await storyInReview('Accept a story from its recording');
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-11992-${seq}`,
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
        repoId: `repo-11992-${seq}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change in ${name}`,
        state: 'open',
        headRef: 'parent/ACME-20-acceptance',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: story.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
  }
  return story;
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaitingKinds = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting').map((g) => g.kind);

const publishReceipt = (workItemId: string) =>
  acceptanceEvidenceService.recordFromUpload(
    { workItemId, video: video(), commitSha: 'c0ffee1' },
    fx.ctx,
  );

const reconcile = (workItemId: string) =>
  withWorkspaceContext(fx.ctx, async (tx) => {
    const fresh = await tx.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    return reconcileGatesFor(fresh, tx);
  });

const reviewOf = async (workItemId: string) => {
  const review = (await gatesOf(workItemId)).find(
    (g) => g.kind === 'agent_review' && g.state === 'awaiting',
  );
  expect(review).toBeDefined();
  return review!;
};

describe('the review holds a story run’s acceptance question until it passes (MOTIR-11992)', () => {
  it('the publish asks the REVIEW alone; the pass asks the acceptance and the merge together', async () => {
    const story = await storyRun();
    await publishReceipt(story.id);
    // Before the fix this read ['acceptance_result', 'agent_review'].
    expect(await awaitingKinds(story.id)).toEqual(['agent_review']);

    const review = await reviewOf(story.id);
    expect(review.subjectVersion).toBe(SET_VERSION);
    await approvalGatesService.decideAgentReview(
      { gateId: review.id, subjectVersion: SET_VERSION, verdict: 'pass', noteMd: 'Looks right.' },
      fx.ctx,
    );

    expect((await awaitingKinds(story.id)).sort()).toEqual(
      ['acceptance_result', 'pull_request_approval'].sort(),
    );
    const merge = (await gatesOf(story.id)).find((g) => g.kind === 'pull_request_approval');
    expect(merge!.subjectVersion).toBe(SET_VERSION);
  });

  it('an acceptance AWAITING while the review is owed is withdrawn as review_not_passed, and asked again on the pass', async () => {
    const story = await storyRun();
    const receipt = await publishReceipt(story.id);
    // A question raised before the rule: the acceptance awaiting beside the review.
    const early = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: 'c0ffee1',
        state: 'awaiting',
      },
    });

    expect(await reconcile(story.id)).toEqual([]);
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: early.id } })).toMatchObject(
      { state: 'superseded', supersededCause: 'review_not_passed', decidedAt: null },
    );
    expect(await awaitingKinds(story.id)).toEqual(['agent_review']);

    const review = await reviewOf(story.id);
    await approvalGatesService.decideAgentReview(
      { gateId: review.id, subjectVersion: SET_VERSION, verdict: 'pass' },
      fx.ctx,
    );
    const asked = (await gatesOf(story.id)).filter(
      (g) => g.kind === 'acceptance_result' && g.state === 'awaiting',
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.id).not.toBe(early.id);
    expect(asked[0]!.subjectId).toBe(receipt.id);
  });

  it('a review that SENDS THE CODE BACK asks no acceptance either', async () => {
    const story = await storyRun();
    await publishReceipt(story.id);
    const review = await reviewOf(story.id);
    await approvalGatesService.decideAgentReview(
      {
        gateId: review.id,
        subjectVersion: SET_VERSION,
        verdict: 'changes_requested',
        noteMd: 'The empty state is not handled.',
      },
      fx.ctx,
    );

    expect(await reconcile(story.id)).toEqual([]);
    expect(await awaitingKinds(story.id)).toEqual([]);
  });

  it('with the review gate OFF the acceptance is asked beside the merge, as before', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { reviewAgentEnabled: false },
    });
    const story = await storyRun();
    await publishReceipt(story.id);
    expect(await awaitingKinds(story.id)).toEqual(['acceptance_result', 'pull_request_approval']);
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});
