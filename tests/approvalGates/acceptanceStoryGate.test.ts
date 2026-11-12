import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY'S VITEST GATE (Story MOTIR-4949 · Subtask MOTIR-5791) — the ASSEMBLED
// acceptance gate against a real Postgres, driven the way an agent drives it: a receipt
// published through `publish_acceptance_result` with the E2E subtask's LEAF key.
//
// Each card in the story ships its own units, and each can be green while the story is
// wrong — the design-gate hole (MOTIR-5652) lived between two correct pieces. So this
// file stands at the joins:
//
//   · THE PLACEMENT MATRIX (`approval-gates.md` §1, the MOTIR-5787 amendment, points
//     1–3) — a STORY run and a SINGLE-CARD run, built as fixtures, and which card each
//     question lands on in each;
//   · THE LIFECYCLES — nothing asked before green (MOTIR-5903), a merge re-asked alone,
//     a newer receipt, and a republish after approval;
//   · THE GUARDS — one decide path, one loader, and nothing raised with the switch OFF.
//
// The object store and the billing entitlement seam are the only fakes; the host's merge
// is the git seam's `mergeChangeRequest`, stubbed per pull request.

const store = new Map<string, { size: number; contentType: string }>();
const minted = new Map<string, { contentType: string; maxBytes: number }>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/get/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

/** A paid plan, so the ONLY thing deciding eligibility is the project's switch. */
const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

const { runCreateAcceptanceUpload, runPublishAcceptanceResult } =
  await import('@/lib/mcp/tools/publishAcceptanceResult');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { settleGreenVerdict } = await import('@/lib/services/mergeGates');
const {
  withdrawPullRequestApprovalGatesOnHeadMove,
  withdrawPullRequestApprovalGatesOnClose,
  withdrawPullRequestApprovalGatesOnDraft,
  withdrawPullRequestApprovalGateOnSetChange,
} = await import('@/lib/services/pullRequestApprovalGates');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await truncateAuthTables();
  // The suite-wide lock order — see `acceptanceOnePress.test.ts`'s note and MOTIR-3066.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "approval_gate" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: 'manual', acceptanceVideoEnabled: true },
  });
  aiAccess.current = {
    applicable: true,
    organizationId: fx.workspace.organizationId,
    organizationName: 'Acme',
    canManageBilling: true,
    hasPaidAiPlan: true,
    balance: 100,
    tierName: 'Pro',
    tierAllotment: 100,
    renewsAt: null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function item(kind: 'story' | 'subtask', title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

/** The run's HOW TO TEST record — what makes a card its run's TARGET (`runTarget.ts`). */
async function runTargetRecord(workItemId: string) {
  await adminDb.testInstructions.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, workItemId, bodyMd: '## Run it' },
  });
}

/** One pull request delivered by `workItemId`, its latest check at `head` with `conclusion`. */
async function deliver(workItemId: string, number: number, head: string, conclusion: string) {
  seq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5791-${seq}`,
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
      repoId: `repo-5791-${seq}`,
      owner: 'acme',
      name: `web${seq}`,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number,
      title: `Change #${number}`,
      state: 'open',
      headRef: `parent/ACME-${number}`,
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: pr.id, repoId: repo.id },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion },
  });
  return pr;
}

/** A receipt published the way an agent publishes one: mint, PUT, publish — by `key`. */
async function publishVia(key: string, commitSha: string) {
  const grant = await runCreateAcceptanceUpload({ key }, fx.ctx);
  if (grant.isError) return grant;
  const video = (grant.structuredContent as { video: { pathname: string } }).video;
  const g = minted.get(video.pathname)!;
  store.set(video.pathname, { contentType: g.contentType, size: 4096 });
  return runPublishAcceptanceResult(
    { key, videoPathname: video.pathname, commitSha, producedByKey: key },
    fx.ctx,
  );
}

// Gates raised in ONE transaction share `createdAt` (Postgres `now()` is the transaction's
// start), so the kind NAME breaks the tie — never the enum, whose order is declaration order.
const gatesOn = async (workItemId: string) =>
  (await adminDb.approvalGate.findMany({ where: { workItemId } }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.kind.localeCompare(b.kind))
    .map((g) => [g.kind, g.state] as const);

const HEAD = 'a1'.repeat(20);

/** A STORY RUN: the story is its run's target and delivers the run's pull request. */
async function storyRun(conclusion = 'success') {
  const story = await item('story', 'Accept a story from its recording');
  const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
  // A run in hand, CI reported: the story is in review, where a real story run sits when
  // anything is pressed (the approve-to-merge approval writes `approved` from there).
  // Its child is landed first — a container reaches review only over built children.
  await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(e2e.id, 'implemented', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  await runTargetRecord(story.id);
  const pr = await deliver(story.id, 402, HEAD, conclusion);
  return { story, e2e, pr };
}

// ── the placement matrix ────────────────────────────────────────────────────

describe('the placement matrix — which card each question lands on (points 1–3)', () => {
  it('(a) a STORY run: the story holds acceptance (primary) + the merge question; the E2E child holds neither', async () => {
    const { story, e2e } = await storyRun('success');

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);
    expect(await gatesOn(e2e.id)).toEqual([]);
  });

  it('(b) a SINGLE-CARD run: while the E2E subtask is not done the story asks NOTHING; the subtask only its own merge question (MOTIR-5903)', async () => {
    const story = await item('story', 'Accept a story from its recording');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    await runTargetRecord(e2e.id);
    await deliver(e2e.id, 410, HEAD, 'success');

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    // The subtask's own green set asks its own question — exactly as the CI promotion does,
    // which writes `in_review` first: the merge question is asked only there (MOTIR-6971).
    await adminDb.workItem.update({ where: { id: e2e.id }, data: { status: 'in_review' } });
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor((await tx.workItem.findUniqueOrThrow({ where: { id: e2e.id } }))!, tx),
    );

    // The receipt exists, and there is nothing to approve yet: the story cannot finish
    // while the subtask that recorded it is unmerged.
    expect(await gatesOn(story.id)).toEqual([]);
    expect(await gatesOn(e2e.id)).toEqual([['pull_request_approval', 'awaiting']]);
  });

  it('(b′) the E2E subtask reaching DONE raises the story acceptance question with no further publish, and approving it moves the story to done (MOTIR-5903)', async () => {
    const story = await item('story', 'Accept a story from its recording');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await runTargetRecord(e2e.id);
    const pr = await deliver(e2e.id, 411, HEAD, 'success');
    await publishVia(e2e.identifier, 'c0ffee1');
    await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(e2e.id, 'implemented', fx.ctx);
    expect(await gatesOn(story.id)).toEqual([]);

    // The subtask's pull request merges and the merge sync writes its `done`.
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx, { keepPendingQuestions: true });

    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);
    // And the story's own move into `done` is now held by that question (§6d rule 1), so
    // the parent rollup cannot close it around the receipt.
    await expect(workItemsService.updateStatus(story.id, 'done', fx.ctx)).rejects.toThrow();

    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'approved']]);
  });

  it('(b″) a sibling still OPEN keeps the story question un-asked when the E2E subtask finishes; the sibling finishing asks it (MOTIR-5903)', async () => {
    const story = await item('story', 'Accept a story from its recording');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    const sibling = await item('subtask', 'A sibling not built yet', story.id);
    await publishVia(e2e.identifier, 'c0ffee1');
    await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx);
    expect(await gatesOn(story.id)).toEqual([]);

    await workItemsService.updateStatus(sibling.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(sibling.id, 'done', fx.ctx);
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);
  });
});

// ── a story run whose own pull requests merged before its video (MOTIR-10837) ───

describe('a STORY run whose own pull requests ALL merged before the receipt was published (MOTIR-10837)', () => {
  /** The story run, its one pull request already landed, its E2E child done. */
  async function landedStoryRun(merged: boolean) {
    const run = await storyRun('success');
    await adminDb.githubPullRequest.update({
      where: { id: run.pr.id },
      data: { state: 'closed', merged },
    });
    await workItemsService.updateStatus(run.e2e.id, 'done', fx.ctx);
    return run;
  }

  it('the publish asks the acceptance question ALONE, and approving it moves the story to done', async () => {
    const { story, e2e } = await landedStoryRun(true);

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    // No merge question: there is nothing left to land.
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);

    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'approved']]);
  });

  it('a story run merged on the HOST with its acceptance question awaiting keeps that question — only the merge question is withdrawn', async () => {
    const { story, e2e, pr } = await storyRun('success');
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx);
    await publishVia(e2e.identifier, 'c0ffee1');
    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);

    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });
    await withWorkspaceContext(fx.ctx, (tx) => withdrawPullRequestApprovalGatesOnClose(pr.id, tx));

    const rows = await adminDb.approvalGate.findMany({ where: { workItemId: story.id } });
    expect(rows.map((g) => [g.kind, g.state, g.supersededCause]).sort()).toEqual([
      ['acceptance_result', 'awaiting', null],
      ['pull_request_approval', 'superseded', 'member_closed'],
    ]);
  });

  it('a pull request CLOSED WITHOUT MERGING still holds the question back', async () => {
    const { story, e2e } = await landedStoryRun(false);

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    expect(await gatesOn(story.id)).toEqual([]);
  });
});

// ── the lifecycles ──────────────────────────────────────────────────────────

describe('the lifecycles', () => {
  it('a story run NOT yet green asks nothing; the green asks BOTH together, and nothing is carried or merged before a press (MOTIR-5903)', async () => {
    const { story, e2e, pr } = await storyRun('pending');
    await publishVia(e2e.identifier, 'c0ffee1');
    // A receipt on a red/pending story is evidence waiting for its question, not a question.
    expect(await gatesOn(story.id)).toEqual([]);

    // The set goes green.
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'success' },
    });
    const requests = await withWorkspaceContext(fx.ctx, async (tx) => {
      const row = await tx.workItem.findUniqueOrThrow({ where: { id: story.id } });
      await reconcileGatesFor(row, tx);
      return settleGreenVerdict({ item: row, pullRequestIds: [pr.id] }, fx.ctx, tx);
    });
    // ONE decision to make — the acceptance leads, the merge rides on it — and nothing is
    // merged until somebody presses it.
    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);
    expect(requests).toEqual([]);
  });

  it('a push that takes a green story run red again withdraws the acceptance question WITH the merge question (MOTIR-5903)', async () => {
    const { story, e2e, pr } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);

    const moved = 'c3'.repeat(20);
    await withWorkspaceContext(fx.ctx, (tx) =>
      withdrawPullRequestApprovalGatesOnHeadMove(pr.id, tx, moved),
    );
    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id },
      orderBy: { createdAt: 'asc' },
    });
    // Both rows are written in one transaction, so `createdAt` does not order them.
    expect(rows.map((g) => [g.kind, g.state, g.supersededCause]).sort()).toEqual([
      ['acceptance_result', 'superseded', 'head_moved'],
      ['pull_request_approval', 'superseded', 'head_moved'],
    ]);

    // Green again at the new head: both are asked again, together.
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: moved, checkName: 'Vitest', conclusion: 'success' },
    });
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: story.id } }), tx),
    );
    const awaiting = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
    expect(awaiting.map((g) => g.kind).sort()).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
  });

  it('a merge re-asked ALONE: after the press, a push moves the head and the next green asks only the merge', async () => {
    const { story, e2e, pr } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    vi.spyOn(github, 'mergeChangeRequest').mockImplementation(
      async () =>
        ({
          outcome: 'refused',
          refusal: { code: 'conflict' },
        }) as unknown as MergeChangeRequestResult,
    );
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    // The agent pushes a fix: a NEW head, and a new green verdict at it.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'b2'.repeat(20),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    // The refused merge dropped the story to `implemented` (can't land), where nothing is
    // asked (MOTIR-6971). The new head's green is what promotes it back to review — the
    // CI-green latch — and the merge question is asked there.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'implemented',
    );
    const { promoteIfCiAlreadyGreen } = await import('@/lib/services/ciPromotion');
    expect(await promoteIfCiAlreadyGreen(story.id, fx.ctx, async () => null)).toBe(true);

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id },
      orderBy: { createdAt: 'asc' },
    });
    // Acceptance stands, decided once; the merge is asked again, alone, over the new head.
    expect(rows.filter((g) => g.kind === 'acceptance_result').map((g) => g.state)).toEqual([
      'approved',
    ]);
    const awaitingMerge = rows.filter(
      (g) => g.kind === 'pull_request_approval' && g.state === 'awaiting',
    );
    expect(awaitingMerge).toHaveLength(1);
    expect(awaitingMerge[0]!.subjectVersion).toContain('b2'.repeat(20));
  });

  // Every event that takes a story run's set out of green withdraws the acceptance question
  // WITH the merge question, under the same cause (MOTIR-5903, the ADR amendment's point 2).
  for (const [cause, takeOutOfGreen] of [
    [
      'member_closed',
      async (prId: string) => {
        await adminDb.githubPullRequest.update({ where: { id: prId }, data: { state: 'closed' } });
        return withWorkspaceContext(fx.ctx, (tx) =>
          withdrawPullRequestApprovalGatesOnClose(prId, tx),
        );
      },
    ],
    [
      'member_drafted',
      async (prId: string) => {
        await adminDb.githubPullRequest.update({ where: { id: prId }, data: { draft: true } });
        return withWorkspaceContext(fx.ctx, (tx) =>
          withdrawPullRequestApprovalGatesOnDraft(prId, tx),
        );
      },
    ],
    [
      'set_changed',
      async (prId: string) => {
        const delivery = await adminDb.workItemDelivery.findFirstOrThrow({
          where: { githubPullRequestId: prId },
        });
        await adminDb.workItemDelivery.delete({ where: { id: delivery.id } });
        return withWorkspaceContext(fx.ctx, (tx) =>
          withdrawPullRequestApprovalGateOnSetChange(delivery.workItemId, tx),
        );
      },
    ],
  ] as const) {
    it(`a story run leaving green by \`${cause}\` withdraws the acceptance question WITH the merge question (MOTIR-5903)`, async () => {
      const { story, e2e, pr } = await storyRun('success');
      await publishVia(e2e.identifier, 'c0ffee1');
      expect(await gatesOn(story.id)).toEqual([
        ['acceptance_result', 'awaiting'],
        ['pull_request_approval', 'awaiting'],
      ]);

      await takeOutOfGreen(pr.id);

      const rows = await adminDb.approvalGate.findMany({
        where: { workItemId: story.id },
        orderBy: { createdAt: 'asc' },
      });
      // Both rows are written in one transaction, so `createdAt` does not order them.
      expect(rows.map((g) => [g.kind, g.state, g.supersededCause]).sort()).toEqual([
        ['acceptance_result', 'superseded', cause],
        ['pull_request_approval', 'superseded', cause],
      ]);
    });
  }

  it('a draft on a story run with NO receipt withdraws the merge question alone — there is no acceptance question to retire', async () => {
    const { story, pr } = await storyRun('success');
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: story.id } }), tx),
    );
    expect(await gatesOn(story.id)).toEqual([['pull_request_approval', 'awaiting']]);

    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { draft: true } });
    await withWorkspaceContext(fx.ctx, (tx) => withdrawPullRequestApprovalGatesOnDraft(pr.id, tx));
    expect(await gatesOn(story.id)).toEqual([['pull_request_approval', 'superseded']]);
  });

  it('a head move naming the head the questions were ASKED about is a late delivery: it withdraws neither', async () => {
    const { story, e2e, pr } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    await withWorkspaceContext(fx.ctx, (tx) =>
      withdrawPullRequestApprovalGatesOnHeadMove(pr.id, tx, HEAD),
    );
    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);
  });

  it('an `auto` story run: a push withdraws the acceptance question even with NO merge gate beside it (MOTIR-5903)', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { prMergeMode: 'auto', prMergeModeDecidedAt: new Date() },
    });
    const { story, e2e, pr } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);

    await withWorkspaceContext(fx.ctx, (tx) =>
      withdrawPullRequestApprovalGatesOnHeadMove(pr.id, tx, 'c4'.repeat(20)),
    );
    const rows = await adminDb.approvalGate.findMany({ where: { workItemId: story.id } });
    expect(rows.map((g) => [g.kind, g.state, g.supersededCause])).toEqual([
      ['acceptance_result', 'superseded', 'head_moved'],
    ]);
  });

  it('a withdrawer leaves a question that is STILL owed where it is — a subtask-run story whose subtree is settled (MOTIR-5903)', async () => {
    const story = await item('story', 'Accept a story from its recording');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx);
    await publishVia(e2e.identifier, 'c0ffee1');
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);

    // A set change on the story (nothing was linked, nothing is now) re-asks nothing new
    // and retires nothing: the question does not ride on a delivery set here.
    await withWorkspaceContext(fx.ctx, (tx) =>
      withdrawPullRequestApprovalGateOnSetChange(story.id, tx),
    );
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);
  });

  it('a NEWER receipt supersedes the awaiting question with cause `republished`', async () => {
    const { story, e2e } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    await publishVia(e2e.identifier, 'd00d002');

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id, kind: 'acceptance_result' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'republished'],
      ['awaiting', null],
    ]);
  });

  it('after APPROVAL, with the story pull request still open, a republish through the MCP door is refused', async () => {
    const { story, e2e } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    // The host refuses the merge the press carries, so the pull request stays open.
    vi.spyOn(github, 'mergeChangeRequest').mockImplementation(
      async () =>
        ({
          outcome: 'refused',
          refusal: { code: 'conflict' },
        }) as unknown as MergeChangeRequestResult,
    );
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    const refused = await publishVia(e2e.identifier, 'd00d002');
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('ACCEPTANCE_EVIDENCE_STORY_CLOSED');
    expect((await gatesOn(story.id)).filter(([kind]) => kind === 'acceptance_result')).toEqual([
      ['acceptance_result', 'approved'],
    ]);
  });
});

// ── the guards ──────────────────────────────────────────────────────────────

describe('the guards', () => {
  const files = (root: string) =>
    execSync(`grep -rl --include=*.ts --include=*.tsx . ${root} || true`, {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  const code = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it('ONE decide path: nothing but the acceptance HANDLER writes a receipt status from production code', () => {
    // A receipt's `approved` IS the freeze (point 6), so a second writer would be a second
    // way to accept a story — one that skips the gate, its audit and its status rule.
    // `acceptanceEvidenceService.setStatus` survives for tests; it must have no caller here.
    const writers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => code(f).includes('acceptanceEvidenceRepository.updateStatus('))
      .sort();
    expect(writers).toEqual([
      'lib/approvalGates/acceptanceResultHandler.ts',
      'lib/services/acceptanceEvidenceService.ts',
    ]);
    const setStatusCallers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => code(f).includes('acceptanceEvidenceService.setStatus('));
    expect(setStatusCallers).toEqual([]);
  });

  it('ONE loader: the predicate is called from `gateSetFor` alone, which is where the receipt is read', () => {
    const callers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => f !== 'lib/approvalGates/gateSet.ts' && code(f).includes('resolveGateSet('));
    expect(callers).toEqual(['lib/services/gateSetFor.ts']);
    expect(code('lib/services/gateSetFor.ts')).toContain(
      "approvalGateRepository.findLatestByWorkItem(item.id, 'acceptance_result', tx)",
    );
  });

  it('the switch OFF: the publish is refused, no receipt is written, and NO gate is raised', async () => {
    const { story, e2e } = await storyRun('success');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { acceptanceVideoEnabled: false },
    });

    const refused = await publishVia(e2e.identifier, 'c0ffee1');
    expect(refused.isError).toBe(true);
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(0);
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: story.id, kind: 'acceptance_result' },
      }),
    ).toBe(0);
  });
});
