import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { PullRequestFiles } from '@/lib/github/pullRequestFiles';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { ApprovalGatePrimaryPendingError } from '@/lib/approvalGates/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { settleGreenVerdict } from '@/lib/services/mergeGates';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { evaluateForWorkItem } from '@/lib/services/pullRequestReviewSync';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';

// THE GATE SET ASKS THE DECISION QUESTION, over real Postgres (Story MOTIR-4907 · Subtask
// MOTIR-5677; `approval-gates.md` §8's FIFTH AMENDMENT, clauses 3–6). The host is stubbed
// at the two seams the path calls — the file list and the merge — and everything between
// them is the real capture, the real reconcile, the real door and the real press.
//
// ⚠️ THE CLAIM UNDER TEST IS *THE MERGE FOLLOWS ONLY THE DECISION*, through every door
// that could merge: `auto`'s green verdict, the approve-to-merge gate pressed alone, a
// complete set of GitHub approvals — and the decision's own press, which is the one that
// may.

const listFiles = vi.hoisted(() => vi.fn<() => Promise<PullRequestFiles>>());
vi.mock('@/lib/github/pullRequestFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/pullRequestFiles')>()),
  listPullRequestFiles: listFiles,
}));

// The auto merge is DISPATCHED as an event after the settle commits; capturing the call is
// the observable answer to "did the press settle the card" (MOTIR-5677, clause 6).
const sent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: sent,
}));

const github = getGitProvider('github') as Required<GitProvider>;
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const INSTALLATION = 'inst-decision-gate-set';
const DOC = 'docs/decisions/page-model.md';
const version = (blob: string) => `acme/web:${DOC}@${blob}`;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  listFiles.mockReset();
  vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({
    token: 'ghs_decision',
    expiresAt: new Date(Date.now() + 3_600_000),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function headFiles(blob: string, head = HEAD): PullRequestFiles {
  return {
    paths: [DOC, 'lib/pages/model.ts'],
    truncated: false,
    files: [
      { path: DOC, sha: blob, status: 'added' },
      { path: 'lib/pages/model.ts', sha: 'code-blob', status: 'modified' },
    ],
    headSha: head,
  };
}

/** A decision card in review, its one pull request linked (which captures), green at HEAD. */
async function decisionCard(opts: { mode?: 'manual' | 'auto'; blob?: string } = {}) {
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: opts.mode ?? 'manual', prMergeModeDecidedAt: new Date() },
  });
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'Decide the page model',
      type: 'decision',
      executor: 'coding_agent',
    },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: INSTALLATION,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: '4907',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  listFiles.mockResolvedValue(headFiles(opts.blob ?? 'blob-1'));
  await linkPr(
    {
      workItemId: item.id,
      projectId: fx.projectId,
      owner: 'acme',
      name: 'web',
      number: 21,
      headRef: 'docs/MOTIR-1-page-model',
    },
    fx.ctx,
  );
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 21 } });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });
  return { item, pr };
}

const gatesOf = (workItemId: string, kind: 'decision_approval' | 'pull_request_approval') =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });

const decide = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision,
      source: 'ui',
      noteMd: decision === 'request_changes' ? 'Needs changes.' : null,
    },
    fx.ctx,
  );

function synchronize(head: string) {
  return githubWebhookService.handlePullRequest({
    action: 'synchronize',
    installation: { id: INSTALLATION, account: { login: 'acme', type: 'Organization' } },
    repository: { id: 4907 },
    pull_request: {
      number: 21,
      state: 'open',
      merged: false,
      merged_at: null,
      title: 'Decide the page model',
      head: { ref: 'docs/MOTIR-1-page-model', sha: head },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** What the green verdict would dispatch for this card, read in a transaction. */
async function settle(item: { id: string }, pullRequestId: string) {
  return withWorkspaceContext(fx.ctx, async (tx) =>
    settleGreenVerdict(
      {
        item: await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }),
        pullRequestIds: [pullRequestId],
      },
      fx.ctx,
      tx,
    ),
  );
}

describe('the capture raises the decision question', () => {
  it('a linked pull request carrying ONE document raises an awaiting decision gate over its BLOB', async () => {
    const { item } = await decisionCard();

    const [gate] = await gatesOf(item.id, 'decision_approval');
    expect(gate).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      subjectVersion: version('blob-1'),
      routedToId: fx.ownerId,
    });
  });

  it('a push that CHANGES the document supersedes the question (head_moved) and asks the new one', async () => {
    const { item } = await decisionCard();

    listFiles.mockResolvedValue(headFiles('blob-2', HEAD_2));
    await synchronize(HEAD_2);

    const gates = await gatesOf(item.id, 'decision_approval');
    expect(gates.map((g) => [g.state, g.subjectVersion, g.supersededCause])).toEqual([
      ['superseded', version('blob-1'), 'head_moved'],
      ['awaiting', version('blob-2'), null],
    ]);
  });

  it('a push that leaves the document alone keeps the ANSWER — no new question', async () => {
    const { item } = await decisionCard();
    const [asked] = await gatesOf(item.id, 'decision_approval');
    await decide(asked!.id, 'approve');

    listFiles.mockResolvedValue(headFiles('blob-1', HEAD_2));
    await synchronize(HEAD_2);

    const gates = await gatesOf(item.id, 'decision_approval');
    expect(gates.map((g) => [g.state, g.subjectVersion])).toEqual([
      ['approved', version('blob-1')],
    ]);
  });

  it('an unresolvable head raises a gate Approve cannot pass', async () => {
    const { item } = await decisionCard();
    listFiles.mockResolvedValue({ ...headFiles('x', HEAD_2), files: [], paths: [] });
    await synchronize(HEAD_2);

    const live = (await gatesOf(item.id, 'decision_approval')).find((g) => g.state === 'awaiting');
    expect(live?.subjectVersion).toBe(`acme/web:unresolvable:none@${HEAD_2}`);
    await expect(decide(live!.id, 'approve')).rejects.toMatchObject({ reason: 'none' });
  });
});

describe('the merge follows ONLY the decision', () => {
  it('AUTO: a green verdict with the decision awaiting dispatches NOTHING; after Approve it dispatches', async () => {
    const { item, pr } = await decisionCard({ mode: 'auto' });

    expect(await settle(item, pr.id)).toEqual([]);

    const [asked] = await gatesOf(item.id, 'decision_approval');
    await decide(asked!.id, 'approve');
    expect(await settle(item, pr.id)).toEqual([{ pullRequestId: pr.id, headSha: HEAD }]);
  });

  it('AUTO: the decision pressed on a set ALREADY green dispatches its merge at once — no verdict to wait for', async () => {
    const { item, pr } = await decisionCard({ mode: 'auto' });
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    const [asked] = await gatesOf(item.id, 'decision_approval');
    sent.mockClear();

    const result = await pullRequestMergeService.decideGate(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: asked!.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    // No companion in `auto` — so the press settled the card itself.
    expect(result.members).toEqual([]);
    expect(sent).toHaveBeenCalledWith(
      'pull-request/auto-merge.requested',
      expect.objectContaining({ workItemId: item.id, pullRequestId: pr.id, headSha: HEAD }),
    );
  });

  it('AUTO: a decision SENT BACK still holds the merge', async () => {
    const { item, pr } = await decisionCard({ mode: 'auto' });
    const [asked] = await gatesOf(item.id, 'decision_approval');
    await decide(asked!.id, 'request_changes');
    expect(await settle(item, pr.id)).toEqual([]);
  });

  it('MANUAL: the approve-to-merge gate pressed ALONE is refused while the decision is unanswered', async () => {
    const { item } = await decisionCard();
    const merge = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion: `acme/web#21@${HEAD}`,
        routedToId: fx.ownerId,
      },
    });

    // The same refusal a design card's merge gate gets (MOTIR-5785), naming the DECISION.
    await expect(decide(merge.id, 'approve')).rejects.toMatchObject({
      tag: 'APPROVAL_GATE_PRIMARY_PENDING',
      primary: 'decision',
    });
    await expect(
      pullRequestMergeService.decideGate(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: merge.id, decision: 'approve', source: 'api' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGatePrimaryPendingError);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge.id } })).state).toBe(
      'awaiting',
    );
  });

  it('GITHUB: every member approved on GitHub is HELD by an unanswered decision, and nothing merges', async () => {
    const { item, pr } = await decisionCard();
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion: `acme/web#21@${HEAD}`,
        routedToId: fx.ownerId,
      },
    });
    await adminDb.githubPullRequestReview.create({
      data: {
        githubReviewId: 'review-1',
        githubPullRequestId: pr.id,
        reviewerGithubUserId: '777',
        reviewerLogin: 'reviewer',
        reviewerType: 'User',
        state: 'approved',
        commitSha: HEAD,
        reviewerPermission: 'write',
        submittedAt: new Date(),
      },
    });
    const host = vi.spyOn(github, 'mergeChangeRequest');

    const result = await evaluateForWorkItem(item.id, fx.workspaceId);

    expect(result.outcome).toBe('held_by_decision');
    expect(host).not.toHaveBeenCalled();
  });

  it('THE DECISION’S OWN PRESS decides both questions and merges — one press', async () => {
    const { item, pr } = await decisionCard();
    // In review, where a green card sits — and the companion raised beside the decision
    // (clause 5), exactly as the green verdict's reconcile raises it.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
      await reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }), tx);
    });
    const [decision] = await gatesOf(item.id, 'decision_approval');
    const [merge] = await gatesOf(item.id, 'pull_request_approval');
    expect(merge?.state).toBe('awaiting');
    // The decision's press asks the host whether the member can merge first (MOTIR-7006);
    // the token is stubbed above, so answer here rather than let it reach GitHub.
    vi.spyOn(github, 'readChangeRequestMergeability').mockResolvedValue({
      mergeable: true,
      mergeableState: 'clean',
      headSha: null,
    });
    const host = vi
      .spyOn(github, 'mergeChangeRequest')
      .mockResolvedValue({ outcome: 'merged', commitSha: 'merge-sha' });

    const result = await pullRequestMergeService.decideGate(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: decision!.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.members).toMatchObject([{ outcome: 'merged', pullRequestId: pr.id }]);
    expect(host).toHaveBeenCalledTimes(1);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge!.id } })).state).toBe(
      'approved',
    );
  });
});

describe('entering review asks again — once', () => {
  it('pulled back and returned, the card holds ONE awaiting decision gate, never two', async () => {
    const { item } = await decisionCard();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    const awaiting = async () =>
      (await gatesOf(item.id, 'decision_approval')).filter((g) => g.state === 'awaiting');
    expect(await awaiting()).toHaveLength(1);

    // Pulling it back withdraws the question (§6d rule 6); returning asks it again.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    expect(await awaiting()).toHaveLength(0);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    expect(await awaiting()).toHaveLength(1);
  });
});

describe('a card that is not an agent’s decision is untouched', () => {
  it('a CODE card whose pull request adds an ADR raises no decision gate, and its auto merge is not held', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { prMergeMode: 'auto', prMergeModeDecidedAt: new Date() },
    });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Build it', type: 'code' },
      fx.ctx,
    );
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: INSTALLATION,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: '4907',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    listFiles.mockResolvedValue(headFiles('blob-1'));
    await linkPr(
      {
        workItemId: item.id,
        projectId: fx.projectId,
        owner: 'acme',
        name: 'web',
        number: 21,
        headRef: 'subtask/MOTIR-1-build',
      },
      fx.ctx,
    );
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 21 } });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
    });

    expect(await gatesOf(item.id, 'decision_approval')).toEqual([]);
    expect(await settle(item, pr.id)).toEqual([{ pullRequestId: pr.id, headSha: HEAD }]);
  });
});

// Bug MOTIR-7006 — the decision's press decides the merge gate too, so a member the host
// reports `dirty` refuses it BEFORE the decision is written, as the merge gate's own press
// does (MOTIR-5915).
describe('a conflict found at the DECISION press writes nothing (MOTIR-7006)', () => {
  it('a `dirty` member refuses the press: neither gate approved, the merge gate withdrawn as `conflict`, the card at Implemented, nothing merged', async () => {
    const { item } = await decisionCard();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
      await reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }), tx);
    });
    const [decision] = await gatesOf(item.id, 'decision_approval');
    const [merge] = await gatesOf(item.id, 'pull_request_approval');
    expect(merge?.state).toBe('awaiting');
    vi.spyOn(github, 'readChangeRequestMergeability').mockResolvedValue({
      mergeable: false,
      mergeableState: 'dirty',
      headSha: HEAD,
    });
    const host = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.decideGate(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: decision!.id,
          decision: 'approve',
          source: 'ui',
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({
      tag: 'MERGE_CONFLICT',
      atPress: true,
      conflicts: [{ pullRequest: 'acme/web#21', baseRef: 'main' }],
    });

    const gate = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
    expect([(await gate(decision!.id)).state, (await gate(decision!.id)).decidedAt]).toEqual([
      'awaiting',
      null,
    ]);
    const mergeRow = await gate(merge!.id);
    expect([mergeRow.state, mergeRow.supersededCause]).toEqual(['superseded', 'conflict']);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'implemented',
    );
    expect(host).not.toHaveBeenCalled();
  });
});
