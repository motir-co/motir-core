import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// AN ACCEPTANCE SENT BACK ON A STORY RUN WITHDRAWS AND HOLDS THE MERGE (Story MOTIR-6071 ·
// MOTIR-6503; `docs/decisions/acceptance-refusal-verdict.md` §2–§3), on real Postgres.
//
// Either verdict — Re-run or Re-plan — writes NO status, withdraws the story's other
// waiting approvals `pulled_back` in the decision's transaction, and the gate set then
// owes no merge gate while the refusal stands over the CURRENT receipt: not on the next
// reconcile, not after a push goes green, and no manual-mode merge path proceeds. A newer
// receipt releases it. A verdict-less refusal (GitHub, or a finished story) moves nothing.
// The fixtures are `acceptanceStoryGate.test.ts`'s.

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
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
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

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { acceptanceResultHoldsMerge } = await import('@/lib/services/mergeGates');
const { evaluateForWorkItem } = await import('@/lib/services/pullRequestReviewSync');
const { githubPullRequestReviewRepository } =
  await import('@/lib/repositories/githubPullRequestReviewRepository');
const { ApprovalGatePrimaryPendingError } = await import('@/lib/approvalGates/errors');

const REASON = 'The empty board should say how to add the first card.';

async function awaitingGate(
  workItemId: string,
  kind: 'acceptance_result' | 'pull_request_approval',
) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { workItemId, kind, state: 'awaiting' } });
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

async function reconcile(workItemId: string) {
  await withWorkspaceContext(fx.ctx, async (tx) =>
    reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: workItemId } }), tx),
  );
}

/** A story run whose video waits beside its merge approval. */
async function waitingStoryRun() {
  const run = await storyRun('success');
  const published = await publishVia(run.e2e.identifier, 'c0ffee1');
  expect(published.isError, JSON.stringify(published)).toBeFalsy();
  expect(await gatesOn(run.story.id)).toEqual([
    ['acceptance_result', 'awaiting'],
    ['pull_request_approval', 'awaiting'],
  ]);
  return run;
}

async function refuse(storyId: string, verdict: 'revise' | 're_plan') {
  const gate = await awaitingGate(storyId, 'acceptance_result');
  return approvalGatesService.decide(
    {
      gateId: gate.id,
      decision: 'request_changes',
      source: 'ui',
      noteMd: REASON,
      refusalVerdict: verdict,
      stamp: DECIDED_WITHOUT_A_READER,
    },
    fx.ctx,
  );
}

describe('a story-run refusal WITHDRAWS the merge and writes no status (either verdict)', () => {
  for (const verdict of ['revise', 're_plan'] as const) {
    it(`${verdict}: the merge gate is pulled_back, nothing moves, the acceptance keeps its verdict`, async () => {
      const { story, e2e } = await waitingStoryRun();
      // A question waiting on the CHILD is not the story's, and is left alone.
      const childGate = await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: e2e.id,
          kind: 'design_result',
          subjectId: 'child-design',
          subjectVersion: 'v1',
          state: 'awaiting',
        },
      });
      const before = { story: await statusOf(story.id), e2e: await statusOf(e2e.id) };

      const decided = await refuse(story.id, verdict);

      expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: verdict });
      expect(decided.effect).toMatchObject({
        statusWritten: null,
        statusDeferredReason: 'acceptance_refusal_withdraws_merge_only',
      });
      const merge = await adminDb.approvalGate.findFirstOrThrow({
        where: { workItemId: story.id, kind: 'pull_request_approval' },
      });
      expect(merge).toMatchObject({ state: 'superseded', supersededCause: 'pulled_back' });
      expect({ story: await statusOf(story.id), e2e: await statusOf(e2e.id) }).toEqual(before);
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: childGate.id } })).state,
      ).toBe('awaiting');
    });
  }
});

describe('…and HOLDS it until a newer receipt is approved', () => {
  it('a reconcile at the SAME green set raises no merge gate', async () => {
    const { story } = await waitingStoryRun();
    await refuse(story.id, 'revise');

    await reconcile(story.id);

    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'changes_requested'],
      ['pull_request_approval', 'superseded'],
    ]);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) => acceptanceResultHoldsMerge(story.id, tx)),
    ).toBe(true);
  });

  it('a push that moves the head and goes green again (the fix, before a new video) still asks nothing', async () => {
    const { story, pr } = await waitingStoryRun();
    await refuse(story.id, 'revise');

    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'b2'.repeat(20),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    await reconcile(story.id);

    const awaitingNow = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id, state: 'awaiting' },
    });
    expect(awaitingNow).toEqual([]);
  });

  it('a merge gate pressed through any door is refused, naming the acceptance', async () => {
    const { story } = await waitingStoryRun();
    await refuse(story.id, 're_plan');
    // A stale row somebody could still name — the REST route, an old page.
    const stale = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'pull_request_approval',
        subjectId: story.id,
        subjectVersion: 'stale',
        state: 'awaiting',
      },
    });

    const refused = await approvalGatesService
      .decide(
        { gateId: stale.id, decision: 'approve', source: 'api', stamp: DECIDED_WITHOUT_A_READER },
        fx.ctx,
      )
      .catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(ApprovalGatePrimaryPendingError);
    expect(refused).toMatchObject({ primary: 'acceptance', workItemId: story.id });
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: stale.id } })).state).toBe(
      'awaiting',
    );
  });

  it('an approval synced from GitHub merges nothing while it holds', async () => {
    const { story, pr } = await waitingStoryRun();
    await refuse(story.id, 'revise');
    // The withdrawn gate's own set version, re-opened as a stale row the sync can find.
    const withdrawn = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'pull_request_approval' },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'pull_request_approval',
        subjectId: story.id,
        subjectVersion: withdrawn.subjectVersion,
        state: 'awaiting',
      },
    });
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        {
          githubReviewId: `gh-${story.id}`,
          githubPullRequestId: pr.id,
          reviewerGithubUserId: '4242',
          reviewerLogin: 'ada-l',
          reviewerType: 'User',
          state: 'approved',
          commitSha: HEAD,
          reviewerPermission: 'write',
          submittedAt: new Date('2026-09-26T10:00:00Z'),
          htmlUrl: null,
        },
        tx,
      ),
    );
    const merge = vi.spyOn(github, 'mergeChangeRequest');

    const evaluated = await evaluateForWorkItem(story.id, fx.workspaceId);

    expect(evaluated.outcome).toBe('held_by_acceptance');
    expect(merge).not.toHaveBeenCalled();
  });

  it('a NEWER receipt releases it: the next green asks the acceptance and the merge together, acceptance leading', async () => {
    const { story, e2e } = await waitingStoryRun();
    await refuse(story.id, 'revise');

    const republished = await publishVia(e2e.identifier, 'c0ffee2');
    expect(republished.isError, JSON.stringify(republished)).toBeFalsy();
    await reconcile(story.id);

    const awaitingNow = (
      await adminDb.approvalGate.findMany({ where: { workItemId: story.id, state: 'awaiting' } })
    )
      .map((g) => g.kind)
      .sort();
    expect(awaitingNow).toEqual(['acceptance_result', 'pull_request_approval']);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) => acceptanceResultHoldsMerge(story.id, tx)),
    ).toBe(false);
  });
});

describe('a VERDICT-LESS refusal moves nothing and holds nothing (today’s behaviour)', () => {
  it('a GitHub-sourced refusal of a story run leaves the merge gate waiting', async () => {
    const { story } = await waitingStoryRun();
    const gate = await awaitingGate(story.id, 'acceptance_result');
    const before = await statusOf(story.id);

    const decided = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'github',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
      { synced: { reviewerGithubUserId: '999001', reviewerLogin: 'octo' } },
    );

    expect(decided.effect).toMatchObject({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect((await awaitingGate(story.id, 'pull_request_approval')).state).toBe('awaiting');
    expect(await statusOf(story.id)).toBe(before);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) => acceptanceResultHoldsMerge(story.id, tx)),
    ).toBe(false);
  });

  it('a FINISHED story (subtask run) is refused with a reason only, and nothing moves', async () => {
    const story = await item('story', 'Accept a finished story');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await runTargetRecord(e2e.id);
    const pr = await deliver(e2e.id, 420, HEAD, 'success');
    await publishVia(e2e.identifier, 'c0ffee1');
    await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(e2e.id, 'implemented', fx.ctx);
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx, { keepPendingQuestions: true });
    const gate = await awaitingGate(story.id, 'acceptance_result');
    const before = await statusOf(story.id);

    const decided = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: REASON,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );

    expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
    expect(decided.effect.statusDeferredReason).toBe('request_changes_moves_nothing');
    expect(await statusOf(story.id)).toBe(before);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) => acceptanceResultHoldsMerge(story.id, tx)),
    ).toBe(false);
  });
});

describe('…and the MIRROR: a refused MERGE on a story run withdraws the waiting acceptance', () => {
  async function refuseMerge(storyId: string) {
    const gate = await awaitingGate(storyId, 'pull_request_approval');
    return approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: REASON,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );
  }

  it('Request changes on the merge gate withdraws the video `pulled_back`, moves nothing, and the receipt stays unanswered', async () => {
    const { story } = await waitingStoryRun();
    const before = await statusOf(story.id);

    const decided = await refuseMerge(story.id);

    expect(decided.gate.state).toBe('changes_requested');
    expect(
      await adminDb.approvalGate.findFirstOrThrow({
        where: { workItemId: story.id, kind: 'acceptance_result' },
      }),
    ).toMatchObject({ state: 'superseded', supersededCause: 'pulled_back' });
    expect(await statusOf(story.id)).toBe(before);
    expect(
      (await adminDb.acceptanceEvidence.findFirstOrThrow({ where: { workItemId: story.id } }))
        .status,
    ).toBe('pending');
  });

  it('a reconcile at the SAME set asks nothing again; a push that goes green asks both, acceptance leading', async () => {
    const { story, pr } = await waitingStoryRun();
    await refuseMerge(story.id);

    await reconcile(story.id);
    expect(
      await adminDb.approvalGate.findMany({ where: { workItemId: story.id, state: 'awaiting' } }),
    ).toEqual([]);

    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'b2'.repeat(20),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    await reconcile(story.id);
    const awaitingNow = (
      await adminDb.approvalGate.findMany({ where: { workItemId: story.id, state: 'awaiting' } })
    )
      .map((g) => g.kind)
      .sort();
    expect(awaitingNow).toEqual(['acceptance_result', 'pull_request_approval']);
  });

  it('a GitHub review requesting changes withdraws the video too', async () => {
    const { story, pr } = await waitingStoryRun();
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        {
          githubReviewId: `gh-cr-${story.id}`,
          githubPullRequestId: pr.id,
          reviewerGithubUserId: '4242',
          reviewerLogin: 'ada-l',
          reviewerType: 'User',
          state: 'changes_requested',
          commitSha: HEAD,
          reviewerPermission: 'write',
          submittedAt: new Date('2026-09-26T10:00:00Z'),
          htmlUrl: null,
        },
        tx,
      ),
    );

    const evaluated = await evaluateForWorkItem(story.id, fx.workspaceId);

    expect(evaluated.outcome).toBe('decided_changes_requested');
    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'superseded'],
      ['pull_request_approval', 'changes_requested'],
    ]);
  });
});
