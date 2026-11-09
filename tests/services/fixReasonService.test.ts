import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, WorkItemFixReason } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { fixTagFactsFor } from '@/lib/services/fixGroupService';
import { deriveFixReason, recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { homeService } from '@/lib/services/homeService';
import { workItemFixReasonBackfillService } from '@/lib/services/workItemFixReasonBackfillService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import {
  FIX_NOTE_PREVIEW_MAX,
  FIX_REASON_PRIORITY,
  answeredPullRequestReasonOf,
  deadRunReasonOf,
  fixingReasonOf,
  fixingWhileRepairing,
  priorWhileRepairing,
  notePreviewOf,
  raisedHeadsOf,
  REVIEW_AGENT_REVIEWER_NAME,
  reviewerNameOf,
  sameFixReason,
  type AnsweredMember,
} from '@/lib/workItems/fixReason';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// `WorkItem.fixReason` (Story MOTIR-6588 · MOTIR-6600), over real Postgres.
//
// What is under test: the stored answer is `motir fix`'s own — every shape the repair
// claim takes reads a pull-request reason, every refusal reads nothing (or a reviewer's
// standing Request changes) — the priority when several reasons hold, each clearing
// condition, and that two recomputes racing on one card store what a serial one would.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at

const recompute = (fx: WorkItemFixture, workItemId: string) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
    recomputeWorkItemFixReason(workItemId, tx),
  );

async function stored(workItemId: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { fixReason: row.fixReason, fixDetail: row.fixDetail };
}

async function exitOn(
  pullRequestId: string,
  opts: {
    rawReason?: string;
    disposition?: 'failure' | 'neutral';
    headSha?: string;
    failingCheckName?: string | null;
  } = {},
) {
  return adminDb.githubPullRequestQueueExit.create({
    data: {
      pullRequestId,
      deliveryId: `guid-${randomToken(8)}`,
      rawReason: opts.rawReason ?? 'CI_FAILURE',
      disposition: opts.disposition ?? 'failure',
      headSha: opts.headSha ?? HEAD,
      exitedAt: new Date('2026-09-18T10:00:00.000Z'),
      requeuedAt: null,
      failingCheckName:
        opts.failingCheckName === undefined ? 'Merge queue / e2e' : opts.failingCheckName,
      failingCheckUrl: null,
    },
  });
}

async function conflict(pullRequestId: string, headSha = HEAD) {
  await adminDb.githubPullRequest.update({
    where: { id: pullRequestId },
    data: { mergeableState: 'dirty', mergeableStateHeadSha: headSha },
  });
}

/** A card at `status` with one open pull request carrying `checks`. */
async function cardWith(
  fx: WorkItemFixture,
  status: string,
  checks: Record<string, 'success' | 'failure' | 'pending'> = { Vitest: 'success' },
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, status);
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, { headRef: `subtask/${randomToken(4)}`, checks });
  return { card, repo, pr };
}

/** A decided approve-to-merge Request changes on `workItemId`, about `subjectVersion`. */
async function requestChanges(
  fx: WorkItemFixture,
  workItemId: string,
  subjectVersion: string,
  opts: {
    noteMd?: string | null;
    decidedAt?: Date;
    state?: 'changes_requested' | 'approved';
    kind?: 'pull_request_approval' | 'agent_review' | 'design_result';
    decidedById?: string | null;
  } = {},
) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind: opts.kind ?? 'pull_request_approval',
      subjectId: workItemId,
      subjectVersion,
      state: opts.state ?? 'changes_requested',
      decidedById: opts.decidedById === undefined ? fx.ownerId : opts.decidedById,
      decidedAt: opts.decidedAt ?? new Date('2026-09-26T10:00:00Z'),
      decidedByLabel: 'Yue Zhu <yue@example.com>',
      decisionSource: 'ui',
      decidedUnderAuthority: opts.kind === 'agent_review' ? 'review_agent' : 'assignee',
      noteMd:
        opts.noteMd === undefined
          ? '\n  Rename the export button.  \nAnd the tooltip.'
          : opts.noteMd,
    },
  });
}

/** The dead-run fields, null on every pull-request reason (MOTIR-6880). */
const NO_DEAD_RUN = {
  lastHeardAt: null,
  ranByName: null,
  branch: null,
  branches: null,
  pushed: null,
  continueKey: null,
  diedReason: null,
} as const;

/** A pull-request set's entry key (MOTIR-7589) — a hash, so matched by shape. */
const PRS_KEY = expect.stringMatching(/^prs:[0-9a-f]{24}$/);

const versionOf = (repoName: string, number: number, head = HEAD) =>
  `acme/${repoName}#${number}@${head}`;

describe('the pure half', () => {
  it('the priority is the enum declaration order', () => {
    expect(FIX_REASON_PRIORITY).toEqual(Object.values(WorkItemFixReason));
  });

  it('a note preview is its first non-empty line, trimmed and cut', () => {
    expect(notePreviewOf(null)).toBeNull();
    expect(notePreviewOf('  \n\n')).toBeNull();
    expect(notePreviewOf('\n  first  \nsecond')).toBe('first');
    const long = 'x'.repeat(FIX_NOTE_PREVIEW_MAX + 20);
    const cut = notePreviewOf(long)!;
    expect(cut).toHaveLength(FIX_NOTE_PREVIEW_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('the reviewer is drawn by NAME — the live user row first, else the audit label without its email', () => {
    expect(
      reviewerNameOf({ name: 'Mei Lin', email: 'mei@example.com' }, 'Old <old@example.com>'),
    ).toBe('Mei Lin');
    expect(reviewerNameOf({ name: '  ', email: 'mei@example.com' }, null)).toBe('mei@example.com');
    expect(reviewerNameOf(null, 'Mei Lin <mei@example.com>')).toBe('Mei Lin');
    expect(reviewerNameOf(null, 'octocat')).toBe('octocat');
    expect(reviewerNameOf(null, '<only@example.com>')).toBe('<only@example.com>');
    expect(reviewerNameOf(null, null)).toBeNull();
  });

  it('sameFixReason compares the reason and the whole detail', () => {
    const detail = {
      groupKey: 'prs:abc',
      repair: 'fix' as const,
      check: 'Vitest',
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      ...NO_DEAD_RUN,
      affected: 1,
      total: 1,
      fixing: false,
      raisedHeads: { pr1: 'a'.repeat(40), pr2: 'b'.repeat(40) },
    };
    expect(
      sameFixReason({ fixReason: null, fixDetail: null }, { fixReason: null, fixDetail: null }),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: { ...detail, affected: 2 } },
      ),
    ).toBe(false);
    // A card whose ENTRY moved (MOTIR-7589) — a fix run re-delivered its set — is rewritten.
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: { ...detail, groupKey: 'prs:def' } },
      ),
    ).toBe(false);
    // FIXING (MOTIR-10307): a change of `fixing` or of any recorded head is a change…
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: { ...detail, fixing: true } },
      ),
    ).toBe(false);
    for (const raisedHeads of [
      { pr1: 'a'.repeat(40), pr2: 'd'.repeat(40) },
      { pr1: 'a'.repeat(40) },
      { pr1: 'a'.repeat(40), pr2: 'b'.repeat(40), pr3: 'e'.repeat(40) },
      null,
    ] as Array<Record<string, string> | null>) {
      expect(
        sameFixReason(
          { fixReason: 'ci_failed', fixDetail: detail },
          { fixReason: 'ci_failed', fixDetail: { ...detail, raisedHeads } },
        ),
      ).toBe(false);
    }
    // …a row stored before Fixing existed (no `fixing`, no heads) is rewritten once…
    const { fixing: _f, raisedHeads: _h, ...legacy } = detail;
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: legacy },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(false);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: { ...detail, raisedHeads: ['a'] } },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(false);
    // …and a stored detail with no heads equals an answer with none.
    expect(
      sameFixReason(
        { fixReason: 'run_died', fixDetail: legacy },
        { fixReason: 'run_died', fixDetail: { ...detail, raisedHeads: null } },
      ),
    ).toBe(true);
    // jsonb hands the keys back in its own order — still the same answer.
    const reordered = Object.fromEntries(Object.entries(detail).reverse());
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: reordered },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: null },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(false);
  });
});

describe('each reason alone', () => {
  it('a red build is ci_failed, naming the first failing check', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented', {
      Vitest: 'failure',
      Lint: 'failure',
      Build: 'success',
    });

    const value = await recompute(fx, card.id);

    expect(value).toEqual({
      fixReason: 'ci_failed',
      fixDetail: {
        groupKey: PRS_KEY,
        repair: 'fix',
        check: 'Lint',
        queueReason: null,
        base: null,
        reviewerName: null,
        notePreview: null,
        gate: null,
        ...NO_DEAD_RUN,
        affected: 1,
        total: 1,
        // The head the reason was raised on (MOTIR-10307).
        fixing: false,
        raisedHeads: { [pr.id]: HEAD },
      },
    });
    expect(await stored(card.id)).toEqual(value);
  });

  it('a standing queue failure is queue_failed, naming the queue check and reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await exitOn(pr.id, { rawReason: 'CI_TIMEOUT' });

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: {
        repair: 'fix',
        check: 'Merge queue / e2e',
        queueReason: 'CI_TIMEOUT',
        affected: 1,
        total: 1,
      },
    });
  });

  it('a conflict is conflicted, naming the base', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await conflict(pr.id);

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { repair: 'fix', base: 'main', check: null },
    });
  });

  it('a Request changes at the current heads is changes_requested, naming the reviewer and the note’s first line', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'changes_requested',
      fixDetail: {
        groupKey: PRS_KEY,
        repair: 'fix',
        check: null,
        queueReason: null,
        base: null,
        reviewerName: fx.owner.name,
        notePreview: 'Rename the export button.',
        gate: 'pull_request_approval',
        ...NO_DEAD_RUN,
        affected: 1,
        total: 1,
        fixing: false,
        raisedHeads: { [pr.id]: HEAD },
      },
    });
  });

  it('an acceptance sent back with Re-run is changes_requested on the acceptance gate, repaired by `motir fix`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
    await setStatus(story.id, 'in_review');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, story.id, repo, {
      headRef: 'parent/exports',
      checks: { Vitest: 'success' },
    });
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: HEAD,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-26T10:00:00Z'),
        decidedByLabel: 'Yue Zhu <yue@example.com>',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'The empty board should say how to add the first card.',
        refusalVerdict: 'revise',
      },
    });

    expect(await recompute(fx, story.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: 'acceptance_result',
        reviewerName: fx.owner.name,
        notePreview: 'The empty board should say how to add the first card.',
      },
    });
    // …and it agrees with the claim, which takes it as its own repair class.
    const claim = await workItemRepairService.claimRepair(fx.projectId, story.identifier, fx.ctx);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'acceptance_rerun' });
  });
});

// MOTIR-7491 — the MOTIR-1408 shape: a card moved to In Review by hand while one of its two
// members was ALREADY red. The red hold is edge-triggered, so nothing moved it back, and the
// predicate refused every In Review card without a queue exit — so it sat in no queue.
describe('In Review with a red member (MOTIR-7491)', () => {
  /** A card at `status` delivered by one green and one red open pull request. */
  async function oneGreenOneRed(fx: WorkItemFixture, status: string) {
    const card = await createTestWorkItem(fx, { kind: 'story', title: `card ${randomToken(4)}` });
    await setStatus(card.id, status);
    const core = await connectRepairRepo(fx, `core-${randomToken(4)}`);
    const ai = await connectRepairRepo(fx, `ai-${randomToken(4)}`);
    const green = await deliveredPr(fx, card.id, core, {
      headRef: 'parent/x',
      checks: { Vitest: 'success' },
    });
    const red = await deliveredPr(fx, card.id, ai, {
      headRef: 'parent/x',
      checks: { 'Guard against the gateway artifact': 'failure', Vitest: 'success' },
    });
    return { card, red, green };
  }

  it.each(['in_review', 'implemented'])(
    'at %s, one green member and one red is ci_failed naming the red check, 1 of 2',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card, red, green } = await oneGreenOneRed(fx, status);

      const value = await recompute(fx, card.id);

      expect(value).toEqual({
        fixReason: 'ci_failed',
        fixDetail: {
          groupKey: PRS_KEY,
          repair: 'fix',
          check: 'Guard against the gateway artifact',
          queueReason: null,
          base: null,
          reviewerName: null,
          notePreview: null,
          gate: null,
          ...NO_DEAD_RUN,
          affected: 1,
          total: 2,
          // Every open member's head, the green one's too: either may be the one pushed.
          fixing: false,
          raisedHeads: { [red.id]: HEAD, [green.id]: HEAD },
        },
      });
      expect(await stored(card.id)).toEqual(value);
    },
  );

  it('…and `motir fix` claims it at In Review, handing over only the red member, status untouched', async () => {
    const fx = await makeWorkItemFixture();
    const { card, red } = await oneGreenOneRed(fx, 'in_review');

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'ci' });
    expect(claim.pullRequests).toEqual([
      expect.objectContaining({ number: red.number, ci: 'failing' }),
    ]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
  });

  it('In Review with every member green and no refusal stays null — To approve owns it', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'in_review');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('In Review with a red member only at an OLD head (a push since) is not red — it is Fixing the red build', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'in_review', { Vitest: 'failure' });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { headSha: 'd'.repeat(40) },
    });

    // The new head has no check rows yet — not reported, so not red. The red build the push
    // answers is still in its rows (Bug MOTIR-10747), so the card reads Fixing it, raised on
    // the old head, and the claim still refuses it.
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { check: 'Vitest', fixing: true, raisedHeads: { [pr.id]: HEAD } },
    });
    expect(
      await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
    ).toMatchObject({ outcome: 'not_repairable' });
  });
});

describe('agreement with `motir fix` — the repair claim’s own matrix', () => {
  // Each shape is built, recomputed, then CLAIMED: a claimable shape stores a
  // pull-request reason, and every refusal stores nothing. The claim runs last because
  // a successful one opens a `fix` run.
  const PR_REASONS = ['queue_failed', 'conflicted', 'ci_failed'];

  type Shape = [label: string, build: (fx: WorkItemFixture) => Promise<string>];
  const shapes: Shape[] = [
    [
      'implemented + red',
      async (fx) => (await cardWith(fx, 'implemented', { Vitest: 'failure' })).card.id,
    ],
    [
      'implemented + queue failure',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await exitOn(pr.id);
        return card.id;
      },
    ],
    [
      'implemented + conflict',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await conflict(pr.id);
        return card.id;
      },
    ],
    [
      'in_review + a code-fixable ejection',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'MERGE_CONFLICT', failingCheckName: null });
        return card.id;
      },
    ],
    ...(['todo', 'in_progress', 'approved', 'done'] as const).map(
      (status): Shape => [
        `${status} + red (not_implemented)`,
        async (fx) => (await cardWith(fx, status, { Vitest: 'failure' })).card.id,
      ],
    ),
    [
      'archived + red (not_implemented)',
      async (fx) => {
        const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
        await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });
        return card.id;
      },
    ],
    [
      'a child of a run target (repair_on_run_target)',
      async (fx) => {
        const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
        const child = await createTestWorkItem(fx, {
          kind: 'subtask',
          title: 'a child',
          parentId: story.id,
        });
        await setStatus(child.id, 'implemented');
        const repo = await connectRepairRepo(fx, 'web');
        await deliveredPr(fx, child.id, repo, {
          headRef: 'parent/x',
          checks: { Vitest: 'failure' },
        });
        await testInstructionsService.publish(
          {
            workItemId: story.id,
            bodyMd: '## Precondition\n\nSign in.',
            previewPath: null,
            repos: [{ repoId: repo.id, commitSha: HEAD }],
          },
          fx.ctx,
        );
        return child.id;
      },
    ],
    [
      'implemented with no pull requests (no_pull_requests)',
      async (fx) => {
        const card = await createTestWorkItem(fx, { kind: 'task', title: 'no PRs' });
        await setStatus(card.id, 'implemented');
        return card.id;
      },
    ],
    [
      'a running build (ci_running)',
      async (fx) => (await cardWith(fx, 'implemented', { Vitest: 'pending' })).card.id,
    ],
    ['a green build (not_failing)', async (fx) => (await cardWith(fx, 'implemented')).card.id],
    [
      'a conflict only at an OLD head (not_failing)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await conflict(pr.id, 'f'.repeat(40));
        return card.id;
      },
    ],
    [
      'in_review + a setting ejection (repair_not_code)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'BRANCH_PROTECTIONS' });
        return card.id;
      },
    ],
    [
      'in_review + a neutral ejection (repair_not_code)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'MANUAL', disposition: 'neutral' });
        return card.id;
      },
    ],
    [
      'in_review + red, no ejection (MOTIR-7491: claimed)',
      async (fx) => (await cardWith(fx, 'in_review', { Vitest: 'failure' })).card.id,
    ],
    [
      'in_review + conflict, no ejection (MOTIR-7491: claimed)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await conflict(pr.id);
        return card.id;
      },
    ],
    ['in_review + green (not_failing)', async (fx) => (await cardWith(fx, 'in_review')).card.id],
  ];

  it.each(shapes)('%s', async (_label, build) => {
    const fx = await makeWorkItemFixture();
    const id = await build(fx);
    const value = await recompute(fx, id);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id } });

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    if (claim.outcome === 'claimed') {
      expect(PR_REASONS).toContain(value.fixReason);
      // The claim opened a live `fix` run, and its open recomputed the card: the same
      // reason, now Fixing (MOTIR-10506).
      expect(await stored(id)).toEqual({
        fixReason: value.fixReason,
        fixDetail: { ...value.fixDetail, fixing: true },
      });
    } else {
      expect(claim.outcome).toBe('not_repairable');
      expect(value).toEqual({ fixReason: null, fixDetail: null });
      expect(await stored(id)).toEqual(value);
    }
  });
});

describe('priority — the first reason that holds is stored', () => {
  it('queue failure > conflict > red, with the affected count per reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr: ejected } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    const conflicted = await deliveredPr(fx, card.id, repo, {
      headRef: 'b',
      checks: { Vitest: 'success' },
    });
    await conflict(conflicted.id);
    const red = await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'failure' },
    });
    await deliveredPr(fx, card.id, repo, { headRef: 'd', checks: { Vitest: 'success' } });

    await exitOn(ejected.id);
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: { affected: 1, total: 4 },
    });

    await adminDb.githubPullRequestQueueExit.deleteMany({ where: { pullRequestId: ejected.id } });
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { affected: 1, total: 4 },
    });

    await adminDb.githubPullRequest.update({
      where: { id: conflicted.id },
      data: { mergeableState: 'clean' },
    });
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { affected: 2, total: 4 },
    });
    expect(red.id).toBeTruthy();
  });

  it('a pull-request reason outranks a standing Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));

    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');
  });
});

describe('each clearing condition', () => {
  it('a green push clears ci_failed', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');

    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'd'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    expect(await stored(card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a resolved conflict clears conflicted', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await conflict(pr.id);
    expect((await recompute(fx, card.id)).fixReason).toBe('conflicted');

    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'clean' },
    });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a new commit after changes were requested reads Fixing while its CI runs, and clears when it passes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');

    const check = await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'e'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });

    // The refusal no longer stands at the new head, and the push is being checked: the
    // card stays on To fix as Fixing (MOTIR-10307) rather than leaving while CI runs.
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true, raisedHeads: { [pr.id]: HEAD } },
    });

    await adminDb.githubCheckRun.update({
      where: { id: check.id },
      data: { conclusion: 'success' },
    });
    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a later approval of the same set clears a Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const version = versionOf(repo.name, pr.number);
    await requestChanges(fx, card.id, version);
    await requestChanges(fx, card.id, version, {
      state: 'approved',
      decidedAt: new Date('2026-09-26T11:00:00Z'),
    });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it.each(['done', 'cancelled', 'todo'])('a card moved to `%s` reads nothing', async (status) => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');

    await setStatus(card.id, status);

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('an archived card reads nothing, even with a standing Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');

    await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a refusal of a DIFFERENT kind is not a changes_requested reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number), { kind: 'design_result' });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });
});

// A standing review refusal on a card the `review` repair class does NOT admit (MOTIR-6822):
// a rung other than Implemented / In Review, or a set with no open member left. The claim
// refuses it, so the reason is read straight off the refusal (`readStandingReviewRefusal`)
// — and the review AGENT is named as the agent, never as the person its run is attributed to.
describe('a standing review refusal the repair claim does not admit', () => {
  it('the review agent’s refusal on a card at Approved is changes_requested on agent_review, naming the agent', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'approved');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number), { kind: 'agent_review' });
    // The claim refuses the card, so this is the not-claimable arm.
    expect(
      await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
    ).toMatchObject({ outcome: 'not_repairable', reason: 'not_implemented' });

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'changes_requested',
      fixDetail: {
        groupKey: PRS_KEY,
        repair: 'fix',
        check: null,
        queueReason: null,
        base: null,
        // The decider row is the workspace owner, but the agent decided — not a person.
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        notePreview: 'Rename the export button.',
        gate: 'agent_review',
        ...NO_DEAD_RUN,
        affected: 1,
        total: 1,
        fixing: false,
        raisedHeads: { [pr.id]: HEAD },
      },
    });
  });

  it.each([
    ['their live name', true, (fx: WorkItemFixture) => fx.owner.name],
    // A reviewer whose user row is gone is named by the audit label, email stripped.
    ['the audit label once the user row is gone', false, () => 'Yue Zhu'],
  ] as const)(
    'a person’s Request changes over a set with no open member names the person by %s',
    async (_label, withUser, nameOf) => {
      const fx = await makeWorkItemFixture();
      const card = await createTestWorkItem(fx, { kind: 'task', title: 'merged already' });
      await setStatus(card.id, 'in_review');
      const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
      const pr = await deliveredPr(fx, card.id, repo, {
        headRef: `subtask/${randomToken(4)}`,
        checks: { Vitest: 'success' },
        state: 'closed',
        merged: true,
      });
      await requestChanges(fx, card.id, versionOf(repo.name, pr.number), {
        decidedById: withUser ? fx.ownerId : null,
      });

      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: {
          repair: 'fix',
          gate: 'pull_request_approval',
          reviewerName: nameOf(fx),
          notePreview: 'Rename the export button.',
          // Nothing open is left to repair; the reason still stands until a head moves.
          affected: 0,
          total: 0,
        },
      });
    },
  );
});

describe('the write', () => {
  it('writes nothing when the answer has not moved', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await recompute(fx, card.id);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    await recompute(fx, card.id);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('a card no transaction can see reads nothing and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    expect(await recompute(fx, 'no-such-card')).toEqual({ fixReason: null, fixDetail: null });
  });

  it('two recomputes racing on one card store what a serial recompute would', async () => {
    await warmPool();
    const fx = await makeWorkItemFixture();
    const { card, repo } = await cardWith(fx, 'implemented');
    // Two events land at once: a red check on a second member, and a conflict on a third.
    const second = await deliveredPr(fx, card.id, repo, { headRef: 'b', checks: {} });
    const third = await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'success' },
    });

    await Promise.all([
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, async (tx) => {
        await tx.githubCheckRun.create({
          data: {
            pullRequestId: second.id,
            commitSha: HEAD,
            checkName: 'Vitest',
            conclusion: 'failure',
          },
        });
        return recomputeWorkItemFixReason(card.id, tx);
      }),
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, async (tx) => {
        await tx.githubPullRequest.update({
          where: { id: third.id },
          data: { mergeableState: 'dirty', mergeableStateHeadSha: HEAD },
        });
        return recomputeWorkItemFixReason(card.id, tx);
      }),
    ]);

    const serial = await recompute(fx, card.id);
    expect(serial.fixReason).toBe('conflicted');
    expect(await stored(card.id)).toEqual(serial);
  });
});

// ── `run_died` (Story MOTIR-6590 · MOTIR-6880) ─────────────────────────────────
// The reason is READ through the continue claim's own evaluation, so what is under
// test is agreement: the stored detail equals what the continue VIEW says about the
// same card, each refusal the view can give lands where § 31 puts it, and the reasons
// `motir fix` owns are left exactly as they were.

/** A local run over `card` that recorded `branch` and then went silent 10 minutes ago. */
async function deadRunOn(
  fx: WorkItemFixture,
  card: { id: string; identifier: string },
  opts: { branch?: string | null } = {},
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  const branch = opts.branch === undefined ? `subtask/${card.identifier}-work` : opts.branch;
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
  });
  return { runId: run.id, branch };
}

async function inProgressCard(fx: WorkItemFixture) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, 'in_progress');
  return card;
}

describe('run_died — the pure half', () => {
  const verdict = {
    key: 'ACME-14',
    refusal: null,
    parentKey: null,
    branch: 'subtask/ACME-14-work',
    branches: [{ repository: 'web', branch: 'subtask/ACME-14-work' }],
    lastHeardAt: '2026-09-28T10:00:00.000Z',
    ranByName: 'Mara S.',
    diedReason: 'lapsed',
  } as const;

  it('a refusal `motir continue` does not own is no dead-run reason', () => {
    expect(deadRunReasonOf({ ...verdict, refusal: 'use_fix' })).toBeNull();
    expect(deadRunReasonOf({ ...verdict, refusal: 'not_in_progress' })).toBeNull();
    // `continue_the_parent` without a parent is no producer's — and is no command either.
    expect(deadRunReasonOf({ ...verdict, refusal: 'continue_the_parent' })).toBeNull();
  });

  it('two stored details differing only in their branch list are different answers', () => {
    const a = deadRunReasonOf(verdict)!;
    const b = deadRunReasonOf({
      ...verdict,
      branches: [...verdict.branches, { repository: 'api', branch: 'subtask/ACME-14-work' }],
    })!;
    expect(sameFixReason(a, a)).toBe(true);
    expect(sameFixReason(a, b)).toBe(false);
    expect(sameFixReason(b, a)).toBe(false);
    // jsonb hands each entry back with its keys in its own order — still the same.
    const reordered = {
      ...a.fixDetail,
      branches: a.fixDetail!.branches!.map((x) => ({ branch: x.branch, repository: x.repository })),
    };
    expect(sameFixReason({ fixReason: 'run_died', fixDetail: reordered }, a)).toBe(true);
    expect(
      sameFixReason({ fixReason: 'run_died', fixDetail: { ...a.fixDetail, branches: null } }, a),
    ).toBe(false);
  });
});

describe('run_died — read through the continue claim’s own evaluation', () => {
  it('a pushed dead run is run_died, repaired by `motir continue` on its own key, naming what the continue view names', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const { branch } = await deadRunOn(fx, card);

    const value = await recompute(fx, card.id);
    const view = await workItemContinueService.getContinueView(card.id, fx.ctx);

    expect(view.state).toBe('died');
    if (view.state !== 'died') return;
    expect(value).toEqual({
      fixReason: 'run_died',
      fixDetail: {
        // ONE ENTRY PER DEAD RUN (MOTIR-7589): keyed by the run the continue view names.
        groupKey: `run:${view.deadRun.id}`,
        repair: 'continue',
        check: null,
        queueReason: null,
        base: null,
        reviewerName: null,
        notePreview: null,
        gate: null,
        lastHeardAt: view.deadRun.lastHeardAt,
        ranByName: view.deadRun.dispatcher?.name ?? null,
        branch: view.branch,
        branches: view.branches.map((b) => ({ repository: b.repository, branch: b.branch })),
        pushed: true,
        continueKey: card.identifier,
        diedReason: view.reason,
        affected: 0,
        total: 0,
        // A dead run records no heads and is never Fixing (MOTIR-10307).
        fixing: false,
        raisedHeads: null,
      },
    });
    expect(value.fixDetail).toMatchObject({
      branch,
      ranByName: fx.owner.name,
      diedReason: 'lapsed',
    });
    expect(await stored(card.id)).toEqual(value);
    // Idempotent: the same answer writes nothing, whatever order jsonb kept the keys in.
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    await recompute(fx, card.id);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('a leg of a dead PARENT run is continued with its parent — continueKey is the parent’s', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    await setStatus(child.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);

    expect(await recompute(fx, child.id)).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { repair: 'continue', continueKey: story.identifier },
    });
  });

  it('a dead run that pushed nothing is run_died with no command — the card starts over', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    await deadRunOn(fx, card, { branch: null });

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { repair: 'none', pushed: false, branch: null, branches: [], continueKey: null },
    });
  });

  it('outranks a failing check on a card still at In Progress', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'in_progress', { Vitest: 'failure' });
    await deadRunOn(fx, card);

    expect((await recompute(fx, card.id)).fixReason).toBe('run_died');
  });

  it.each(['implemented', 'in_review', 'approved'])(
    'use_fix — a dead run on a card at %s falls through: the pull-request answer is exactly what it was',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card } = await cardWith(fx, status, { Vitest: 'failure' });
      const before = await recompute(fx, card.id);
      await deadRunOn(fx, card);

      expect(await recompute(fx, card.id)).toEqual(before);
      if (status === 'implemented') {
        expect(before).toMatchObject({
          fixReason: 'ci_failed',
          fixDetail: { repair: 'fix', check: 'Vitest', ...NO_DEAD_RUN },
        });
      }
    },
  );

  it('not_in_progress — a dead run on a card at Planning reads nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'planning' });
    await setStatus(card.id, 'planning');
    await deadRunOn(fx, card);

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a run that is alive, succeeded, continuing or absent is no run_died — nor is a CLI that never heartbeats, inside its window', async () => {
    const fx = await makeWorkItemFixture();

    const none = await inProgressCard(fx);
    expect((await recompute(fx, none.id)).fixReason).toBeNull();

    const alive = await inProgressCard(fx);
    const live = await deadRunOn(fx, alive);
    await adminDb.dispatchRun.update({
      where: { id: live.runId },
      data: { lastHeartbeatAt: new Date() },
    });
    expect((await recompute(fx, alive.id)).fixReason).toBeNull();

    const silent = await inProgressCard(fx);
    const legacy = await deadRunOn(fx, silent);
    await adminDb.dispatchRun.update({
      where: { id: legacy.runId },
      data: { lastHeartbeatAt: null, startedAt: new Date(Date.now() - 60 * 60_000) },
    });
    expect((await recompute(fx, silent.id)).fixReason).toBeNull();

    const done = await inProgressCard(fx);
    const ok = await deadRunOn(fx, done);
    await adminDb.dispatchRun.update({
      where: { id: ok.runId },
      data: { status: 'succeeded', endedAt: new Date() },
    });
    expect((await recompute(fx, done.id)).fixReason).toBeNull();

    const taken = await inProgressCard(fx);
    await deadRunOn(fx, taken);
    const claimed = await workItemContinueService.claimContinue(
      fx.projectId,
      taken.identifier,
      fx.ctx,
    );
    expect(claimed.outcome).toBe('claimed');
    expect((await recompute(fx, taken.id)).fixReason).toBeNull();
  });
});

// ── FIXING (Story MOTIR-10305 · MOTIR-10307) ─────────────────────────────────────────
// A pushed fix keeps the card on To fix with its earlier reason and `fixing: true` while
// CI runs at the new head; green clears it, red raises a fresh reason on the new heads.

const PUSHED = 'd'.repeat(40);

/** CI starting on a push: a pending check row at `sha`. */
const ciStarts = (pullRequestId: string, sha = PUSHED, checkName = 'Vitest') =>
  adminDb.githubCheckRun.create({
    data: { pullRequestId, commitSha: sha, checkName, conclusion: 'pending' },
  });

const finishes = (checkRunId: string, conclusion: 'success' | 'failure') =>
  adminDb.githubCheckRun.update({ where: { id: checkRunId }, data: { conclusion } });

const hctx = (fx: WorkItemFixture) => ({ ...fx.ctx, projectId: fx.projectId });

describe('Fixing — the pure half', () => {
  const prior = {
    fixReason: 'ci_failed' as const,
    fixDetail: {
      groupKey: 'prs:abc',
      repair: 'fix' as const,
      check: 'Vitest',
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      ...NO_DEAD_RUN,
      affected: 1,
      total: 2,
      fixing: false,
      raisedHeads: { pr1: HEAD, pr2: HEAD },
    },
  };

  it('a running member at a head other than its recorded one keeps the prior answer, Fixing', () => {
    expect(fixingReasonOf(prior, [{ pullRequestId: 'pr2', headSha: PUSHED }])).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...prior.fixDetail, fixing: true },
    });
  });

  it('is not Fixing without a moved head, recorded heads or a pull-request reason', () => {
    // A re-run of the same commit.
    expect(fixingReasonOf(prior, [{ pullRequestId: 'pr1', headSha: HEAD }])).toBeNull();
    // A member opened after the reason was raised proves nothing about the push.
    expect(fixingReasonOf(prior, [{ pullRequestId: 'pr9', headSha: PUSHED }])).toBeNull();
    // A member whose head is not known.
    expect(fixingReasonOf(prior, [{ pullRequestId: 'pr1', headSha: null }])).toBeNull();
    // A row stored before heads were recorded.
    expect(
      fixingReasonOf({ ...prior, fixDetail: { ...prior.fixDetail, raisedHeads: null } }, [
        { pullRequestId: 'pr1', headSha: PUSHED },
      ]),
    ).toBeNull();
    // run_died, nothing stored, or a reason with no detail.
    for (const p of [
      { ...prior, fixReason: 'run_died' as const },
      { fixReason: null, fixDetail: null },
      { fixReason: 'ci_failed' as const, fixDetail: null },
    ]) {
      expect(fixingReasonOf(p, [{ pullRequestId: 'pr1', headSha: PUSHED }])).toBeNull();
    }
  });

  it('records every member with a known head', () => {
    expect(
      raisedHeadsOf([
        { pullRequestId: 'a', headSha: HEAD },
        { pullRequestId: 'b', headSha: null },
      ]),
    ).toEqual({ a: HEAD });
  });
});

describe('Fixing — a pushed fix while its CI runs', () => {
  async function redCard(fx: WorkItemFixture) {
    const made = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await adminDb.workItem.update({
      where: { id: made.card.id },
      data: { assigneeId: fx.ownerId },
    });
    const before = await recompute(fx, made.card.id);
    expect(before).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { fixing: false, raisedHeads: { [made.pr.id]: HEAD } },
    });
    return { ...made, before };
  }

  it('CI starting at a new head keeps ci_failed with fixing on — still listed, count unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    const countBefore = (await homeService.tabCounts(hctx(fx))).toFix;

    await ciStarts(pr.id);
    const value = await recompute(fx, card.id);

    expect(value).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
    expect(await stored(card.id)).toEqual(value);
    const [page, counts] = await Promise.all([
      homeService.listToFix(hctx(fx)),
      homeService.tabCounts(hctx(fx)),
    ]);
    expect(page.items.map((i) => i.id)).toEqual([card.id]);
    expect(counts.toFix).toBe(countBefore);
    // The claim is untouched: a card with CI running and nothing red is refused as before.
    expect(
      await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
    ).toMatchObject({ outcome: 'not_repairable', reason: 'ci_running' });
    // While CI keeps running, the answer holds and nothing is rewritten.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(await recompute(fx, card.id)).toEqual(value);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).updatedAt,
    ).toEqual(row.updatedAt);
  });

  it('green clears it — the card leaves To fix', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    const check = await ciStarts(pr.id);
    expect((await recompute(fx, card.id)).fixDetail?.fixing).toBe(true);

    await finishes(check.id, 'success');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    expect((await homeService.listToFix(hctx(fx))).items).toEqual([]);
  });

  it('red restores the failure reason, fixing off, raised on the NEW head', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    const check = await ciStarts(pr.id);
    expect((await recompute(fx, card.id)).fixDetail?.fixing).toBe(true);

    await finishes(check.id, 'failure');

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { check: 'Vitest', fixing: false, raisedHeads: { [pr.id]: PUSHED } },
    });
  });

  it('CI re-running at the RECORDED head is not Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'pending' },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a row stored with no recorded heads is not Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    const {
      raisedHeads: _h,
      fixing: _f,
      ...legacy
    } = (await stored(card.id)).fixDetail as Record<string, string | number | boolean | null>;
    await adminDb.workItem.update({ where: { id: card.id }, data: { fixDetail: legacy } });
    await ciStarts(pr.id);

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a prior run_died never reads Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    const detail = (await stored(card.id)).fixDetail as Record<string, unknown>;
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { fixReason: 'run_died', fixDetail: { ...detail, repair: 'continue' } },
    });
    await ciStarts(pr.id);

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  describe('several open pull requests', () => {
    async function twoMembers(fx: WorkItemFixture) {
      const card = await createTestWorkItem(fx, { kind: 'story', title: 'two repos' });
      await setStatus(card.id, 'implemented');
      const core = await connectRepairRepo(fx, `core-${randomToken(4)}`);
      const ai = await connectRepairRepo(fx, `ai-${randomToken(4)}`);
      const red = await deliveredPr(fx, card.id, core, {
        headRef: 'parent/x',
        checks: { Vitest: 'failure' },
      });
      const other = await deliveredPr(fx, card.id, ai, {
        headRef: 'parent/x',
        checks: { Vitest: 'success' },
      });
      expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');
      await ciStarts(red.id);
      return { card, red, other };
    }

    it('one pushed and running, the other green, is Fixing', async () => {
      const fx = await makeWorkItemFixture();
      const { card } = await twoMembers(fx);

      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'ci_failed',
        fixDetail: { fixing: true, affected: 1, total: 2 },
      });
    });

    it.each([
      [
        'red',
        'ci_failed',
        async (id: string) => {
          await adminDb.githubCheckRun.updateMany({
            where: { pullRequestId: id },
            data: { conclusion: 'failure' },
          });
        },
      ],
      ['conflicted', 'conflicted', (id: string) => conflict(id)],
      ['queue-held', 'queue_failed', (id: string) => exitOn(id).then(() => undefined)],
    ] as const)(
      'one running and the other %s reads the failure reason, not Fixing',
      async (_label, reason, makeStuck) => {
        const fx = await makeWorkItemFixture();
        const { card, other } = await twoMembers(fx);
        await makeStuck(other.id);

        expect(await recompute(fx, card.id)).toMatchObject({
          fixReason: reason,
          fixDetail: { fixing: false },
        });
      },
    );
  });

  describe('changes requested', () => {
    it('at Implemented: a standing refusal at the unchanged head is not Fixing; a push makes it Fixing', async () => {
      const fx = await makeWorkItemFixture();
      const { card, repo, pr } = await cardWith(fx, 'implemented');
      await requestChanges(fx, card.id, versionOf(repo.name, pr.number));
      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: { fixing: false, raisedHeads: { [pr.id]: HEAD } },
      });

      // A re-run of the same commit: the refusal still stands — the review class, not Fixing.
      await adminDb.githubCheckRun.updateMany({
        where: { pullRequestId: pr.id },
        data: { conclusion: 'pending' },
      });
      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: { fixing: false },
      });

      await ciStarts(pr.id);
      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: { fixing: true, gate: 'pull_request_approval', raisedHeads: { [pr.id]: HEAD } },
      });
    });

    it('at In Review: Fixing although the predicate refuses it not_failing — the claim’s refusal is unchanged', async () => {
      const fx = await makeWorkItemFixture();
      const { card, repo, pr } = await cardWith(fx, 'in_review');
      await requestChanges(fx, card.id, versionOf(repo.name, pr.number), { kind: 'agent_review' });
      expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');

      await ciStarts(pr.id);

      expect(await recompute(fx, card.id)).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: { fixing: true, gate: 'agent_review' },
      });
      expect(
        await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
      ).toMatchObject({ outcome: 'not_repairable', reason: 'not_failing' });
    });
  });

  it('the backfill leaves a Fixing card Fixing, its dry run predicts it, and a second run changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    await ciStarts(pr.id);

    const dry = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: true });
    expect(dry).toMatchObject({ fixing: 1, changed: [], failed: [] });
    expect(dry.byReason.ci_failed).toBe(1);
    // The rehearsal wrote nothing: the stored answer is still the one before the push.
    expect(await stored(card.id)).toEqual(before);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(
      await withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
        deriveFixReason(row, tx),
      ),
    ).toEqual({ fixReason: 'ci_failed', fixDetail: { ...before.fixDetail, fixing: true } });

    const run = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });
    expect(run).toMatchObject({ fixing: 1, changed: [], unchanged: 1, failed: [] });
    expect(await stored(card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });

    const again = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });
    expect(again).toMatchObject({ fixing: 1, changed: [], unchanged: 1 });
  });
});

// ── A LIVE REPAIR IS FIXING (MOTIR-10506) ─────────────────────────────────────────────
// A `fix` run alive on the card sets Fixing the moment it opens — a claimed `motir fix`, a
// hosted repair — keeping the reason, its heads and the To fix count. Its close recomputes
// the card; the moved-head rule is only the reconcile after it.

// A QUICK GREEN LANDED FIRST (Bug MOTIR-10747). GitHub delivers a push's checks one webhook at
// a time, in no order: a fast check finishing at the new head before anything running is
// recorded there reads the head green, and the card stores nothing to fix. The red build the
// push answers is still in its check rows, so the next recompute that sees CI running at the
// moved head reads it from them and is Fixing again — through the same moved-head rule.
describe('Fixing — a quick green at the new head landed first (Bug MOTIR-10747)', () => {
  const LATER = 'f'.repeat(40);

  async function redCard(fx: WorkItemFixture) {
    const made = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    const before = await recompute(fx, made.card.id);
    expect(before).toMatchObject({ fixReason: 'ci_failed', fixDetail: { fixing: false } });
    return { ...made, before };
  }

  /** The push, then a quick check finishing green at its head before anything runs. */
  async function quickGreen(pullRequestId: string, sha = PUSHED) {
    await adminDb.githubPullRequest.update({
      where: { id: pullRequestId },
      data: { headSha: sha },
    });
    await finishes((await ciStarts(pullRequestId, sha, 'Lint')).id, 'success');
  }

  it('the pure half: rebuilt as the failure raised it, red members at their red commit', () => {
    const red = (pullRequestId: string, failingChecks: string[]) => ({
      pullRequestId,
      baseRef: 'main',
      queueFailure: null,
      blockedReading: null,
      red: { commitSha: HEAD, failingChecks },
    });
    expect(answeredPullRequestReasonOf([], { pr1: HEAD }, 1)).toBeNull();
    // A red commit whose failing check has no name to show names none.
    expect(answeredPullRequestReasonOf([red('pr1', [])], {}, 1)?.fixDetail?.check).toBeNull();
    expect(
      answeredPullRequestReasonOf(
        [red('pr1', ['Lint', 'Vitest'])],
        { pr1: PUSHED, pr2: PUSHED },
        2,
      ),
    ).toEqual({
      fixReason: 'ci_failed',
      fixDetail: {
        groupKey: null,
        repair: 'fix',
        check: 'Lint',
        queueReason: null,
        base: null,
        reviewerName: null,
        notePreview: null,
        gate: null,
        ...NO_DEAD_RUN,
        affected: 1,
        total: 2,
        fixing: false,
        raisedHeads: { pr1: HEAD, pr2: PUSHED },
      },
    });
  });

  it('the card’s reproduction: the quick green clears it, the running check brings ci_failed back Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);

    await quickGreen(pr.id);
    // The partial set reads green for a moment: nothing running is recorded yet.
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    const vitest = await ciStarts(pr.id, PUSHED, 'Vitest');
    const value = await recompute(fx, card.id);
    // The same answer the stored rule would have kept: reason, check, count, group, heads.
    expect(value).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
    expect(await stored(card.id)).toEqual(value);
    expect((await homeService.listToFix(hctx(fx))).items.map((i) => i.id)).toEqual([card.id]);
    // The claim is untouched: CI running with nothing red is refused as before.
    expect(
      await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
    ).toMatchObject({ outcome: 'not_repairable', reason: 'ci_running' });
    // While CI keeps running, the answer holds and nothing is rewritten.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(await recompute(fx, card.id)).toEqual(value);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).updatedAt,
    ).toEqual(row.updatedAt);

    // Green clears it.
    await finishes(vitest.id, 'success');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('red at the new head raises a fresh reason there, fixing off', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await quickGreen(pr.id);
    await recompute(fx, card.id);
    const vitest = await ciStarts(pr.id, PUSHED, 'Vitest');
    expect((await recompute(fx, card.id)).fixDetail?.fixing).toBe(true);

    await finishes(vitest.id, 'failure');

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { check: 'Vitest', fixing: false, raisedHeads: { [pr.id]: PUSHED } },
    });
  });

  it('a later push after the fix went green is not Fixing — the build it answers was green', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    // The fix push goes green on its whole set.
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    await finishes((await ciStarts(pr.id, PUSHED, 'Vitest')).id, 'success');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    // A later push (a main merge), its checks out of order.
    await quickGreen(pr.id, LATER);
    await ciStarts(pr.id, LATER, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a push from a green build is never Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    await quickGreen(pr.id);
    await ciStarts(pr.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a push CI never decided on before the next one still answers the red build', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    // The first fix push starts CI and is replaced by a second before it reports.
    await ciStarts(pr.id, PUSHED, 'Vitest');
    await quickGreen(pr.id, LATER);
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    await ciStarts(pr.id, LATER, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
  });

  it('a re-run of a FAILED fix at its own head is never Fixing — however many recomputes it sees', async () => {
    // Review of MOTIR-10747: red at HEAD, a fix pushed at PUSHED goes red too, and its failing
    // check is re-run there. The first recompute declines the prior (a re-run at the recorded
    // head); every later one must not walk past PUSHED to the red build at HEAD.
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    const vitest = await ciStarts(pr.id, PUSHED, 'Vitest');
    await finishes(vitest.id, 'failure');
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { fixing: false, raisedHeads: { [pr.id]: PUSHED } },
    });

    // The re-run reopens the row in place, dated by its own start — after the row was recorded.
    const row = await adminDb.githubCheckRun.findUniqueOrThrow({ where: { id: vitest.id } });
    await adminDb.githubCheckRun.update({
      where: { id: vitest.id },
      data: { conclusion: 'pending', conclusionAt: new Date(row.createdAt.getTime() + 60_000) },
    });

    expect(await recompute(fx, card.id), 'first recompute').toEqual({
      fixReason: null,
      fixDetail: null,
    });
    expect(await recompute(fx, card.id), 'second recompute').toEqual({
      fixReason: null,
      fixDetail: null,
    });
    // A quick check finishing beside the re-run changes nothing either.
    await finishes((await ciStarts(pr.id, PUSHED, 'Lint')).id, 'success');
    expect(await recompute(fx, card.id), 'third recompute').toEqual({
      fixReason: null,
      fixDetail: null,
    });
  });

  it('a stored answer the rule declined is kept as the card’s word, not rebuilt', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    // A prior run_died, nothing about CI: the rows are not read while it is stored.
    const detail = (await stored(card.id)).fixDetail as Record<string, unknown>;
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { fixReason: 'run_died', fixDetail: { ...detail, repair: 'continue' } },
    });
    await quickGreen(pr.id);
    await ciStarts(pr.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('with several pull requests: the red one pushed, the other green, is Fixing 1 of 2', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'two repos' });
    await setStatus(card.id, 'implemented');
    const core = await connectRepairRepo(fx, `core-${randomToken(4)}`);
    const ai = await connectRepairRepo(fx, `ai-${randomToken(4)}`);
    const red = await deliveredPr(fx, card.id, core, {
      headRef: 'parent/x',
      checks: { Vitest: 'failure' },
    });
    const other = await deliveredPr(fx, card.id, ai, {
      headRef: 'parent/x',
      checks: { Vitest: 'success' },
    });
    const before = await recompute(fx, card.id);
    expect(before.fixReason).toBe('ci_failed');

    await quickGreen(red.id);
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    await ciStarts(red.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: {
        ...before.fixDetail,
        affected: 1,
        total: 2,
        fixing: true,
        raisedHeads: { [red.id]: HEAD, [other.id]: HEAD },
      },
    });
  });

  it('a live repair on a card whose stored answer was wiped is Fixing through the same read', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    expect(claim.outcome).toBe('claimed');

    // The repair's push: the quick green wipes the stored answer, the live run keeps nothing.
    await quickGreen(pr.id);
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    await ciStarts(pr.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
  });
});

// ── A QUICK GREEN LANDED FIRST, ON A PUSH THAT ANSWERED A QUEUE EXIT OR A CONFLICT ─────
// (Bug MOTIR-10791). The same out-of-order delivery as MOTIR-10747's, for the reasons that
// mean the members cannot land as they are: the queue exit row, and the mergeability reading
// the push replaced (carried into `previous_mergeable_state`), are what the push answered.
describe('Fixing — a quick green landed first on a push answering a queue exit or a conflict (Bug MOTIR-10791)', () => {
  const LATER = 'f'.repeat(40);

  /** The push, then a quick check finishing green at its head before anything runs. */
  async function quickGreen(pullRequestId: string, sha = PUSHED) {
    await adminDb.githubPullRequest.update({
      where: { id: pullRequestId },
      data: { headSha: sha },
    });
    await finishes((await ciStarts(pullRequestId, sha, 'Lint')).id, 'success');
  }

  /** The host's reading, written the way the app writes it (the carrying writers). */
  const reads = (pullRequestId: string, mergeableState: string, headSha: string) =>
    adminDb.$transaction((tx) =>
      githubPullRequestRepository.setMergeability(pullRequestId, { mergeableState, headSha }, tx),
    );
  const pushMarksPending = (pullRequestId: string, headSha: string) =>
    adminDb.$transaction((tx) =>
      githubPullRequestRepository.markMergeabilityPending(pullRequestId, headSha, tx),
    );

  async function stuckCard(
    fx: WorkItemFixture,
    how: 'conflicted' | 'out_of_date' | 'queue_failed',
  ) {
    const made = await cardWith(fx, 'implemented');
    if (how === 'queue_failed') await exitOn(made.pr.id);
    else await reads(made.pr.id, how === 'conflicted' ? 'dirty' : 'behind', HEAD);
    const before = await recompute(fx, made.card.id);
    expect(before).toMatchObject({ fixReason: how, fixDetail: { fixing: false } });
    return { ...made, before };
  }

  for (const how of ['conflicted', 'out_of_date', 'queue_failed'] as const) {
    it(`the card’s reproduction (${how}): the quick green clears it, the running check brings it back Fixing`, async () => {
      const fx = await makeWorkItemFixture();
      const { card, pr, before } = await stuckCard(fx, how);

      // Step 2: the push alone is Fixing, by the stored prior.
      await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
      expect(await recompute(fx, card.id)).toEqual({
        fixReason: how,
        fixDetail: { ...before.fixDetail, fixing: true },
      });
      // Step 3: the partial set reads green for a moment.
      await finishes((await ciStarts(pr.id, PUSHED, 'Lint')).id, 'success');
      expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

      // Step 4: the running check — the step-1 reason, Fixing, as at step 2.
      const vitest = await ciStarts(pr.id, PUSHED, 'Vitest');
      const value = await recompute(fx, card.id);
      expect(value).toEqual({ fixReason: how, fixDetail: { ...before.fixDetail, fixing: true } });
      expect(await stored(card.id)).toEqual(value);
      expect((await homeService.listToFix(hctx(fx))).items.map((i) => i.id)).toEqual([card.id]);

      // Green clears it.
      await finishes(vitest.id, 'success');
      expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    });
  }

  it('the app’s own writes: the push marks the reading pending, the host answers clean, and the conflict is still what it answered', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await stuckCard(fx, 'conflicted');
    await pushMarksPending(pr.id, PUSHED);
    await reads(pr.id, 'clean', PUSHED);
    expect(
      await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } }),
    ).toMatchObject({
      mergeableState: 'clean',
      mergeableStateHeadSha: PUSHED,
      previousMergeableState: 'dirty',
      previousMergeableStateHeadSha: HEAD,
    });
    await quickGreen(pr.id);
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    await ciStarts(pr.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'conflicted',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
  });

  it('a later push after the conflict was resolved and went green is not Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await stuckCard(fx, 'conflicted');
    await pushMarksPending(pr.id, PUSHED);
    await reads(pr.id, 'clean', PUSHED);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    await finishes((await ciStarts(pr.id, PUSHED, 'Vitest')).id, 'success');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    // A later push carries the CLEAN reading, so it answers nothing.
    await pushMarksPending(pr.id, LATER);
    await quickGreen(pr.id, LATER);
    await ciStarts(pr.id, LATER, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a push the host never answered about keeps the conflict before it as what the next push answers', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await stuckCard(fx, 'conflicted');
    await pushMarksPending(pr.id, PUSHED);
    // Replaced before the host answered: the pending reading is not carried.
    await pushMarksPending(pr.id, LATER);
    expect(
      await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } }),
    ).toMatchObject({
      previousMergeableState: 'dirty',
      previousMergeableStateHeadSha: HEAD,
    });
    await quickGreen(pr.id, LATER);
    await ciStarts(pr.id, LATER, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'conflicted',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
  });

  it('a reading at the same head replaces the stored one without carrying it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await stuckCard(fx, 'conflicted');
    // The base moved back: the host answers clean at the same head, nothing to fix.
    await reads(pr.id, 'clean', HEAD);
    expect(
      await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } }),
    ).toMatchObject({
      previousMergeableState: null,
      previousMergeableStateHeadSha: null,
    });
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    // A push after it answers the clean reading.
    await pushMarksPending(pr.id, PUSHED);
    await quickGreen(pr.id);
    await ciStarts(pr.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a later push after the queue exit’s fix went green is not Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await stuckCard(fx, 'queue_failed');
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    await finishes((await ciStarts(pr.id, PUSHED, 'Vitest')).id, 'success');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

    await quickGreen(pr.id, LATER);
    await ciStarts(pr.id, LATER, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a re-queued or neutral exit is not what a push answered', async () => {
    const fx = await makeWorkItemFixture();
    for (const exit of [{ disposition: 'neutral' as const, rawReason: 'MANUAL' }, null]) {
      const { card, pr } = await cardWith(fx, 'implemented');
      const row = await exitOn(pr.id, exit ?? {});
      if (exit === null) {
        await adminDb.githubPullRequestQueueExit.update({
          where: { id: row.id },
          data: { requeuedAt: new Date('2026-09-18T11:00:00.000Z') },
        });
      }
      await recompute(fx, card.id);
      await quickGreen(pr.id);
      await ciStarts(pr.id, PUSHED, 'Vitest');

      expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    }
  });

  it('the priority holds when the push answered several things: the queue exit outranks the red build and the conflict', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'two repos' });
    await setStatus(card.id, 'implemented');
    const core = await connectRepairRepo(fx, `core-${randomToken(4)}`);
    const ai = await connectRepairRepo(fx, `ai-${randomToken(4)}`);
    const queued = await deliveredPr(fx, card.id, core, {
      headRef: 'parent/x',
      checks: { Vitest: 'success' },
    });
    const conflicting = await deliveredPr(fx, card.id, ai, {
      headRef: 'parent/x',
      checks: { Vitest: 'failure' },
    });
    await exitOn(queued.id);
    await reads(conflicting.id, 'dirty', HEAD);
    const before = await recompute(fx, card.id);
    expect(before).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: { affected: 1, total: 2 },
    });

    // Both pushed; quick greens at both new heads wipe the stored answer.
    await quickGreen(queued.id);
    await quickGreen(conflicting.id);
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    await ciStarts(queued.id, PUSHED, 'Vitest');
    await ciStarts(conflicting.id, PUSHED, 'Vitest');

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'queue_failed',
      fixDetail: {
        ...before.fixDetail,
        fixing: true,
        raisedHeads: { [queued.id]: HEAD, [conflicting.id]: PUSHED },
      },
    });
  });

  // ── A HEAD CI HAD ALREADY DECIDED answers nothing (review of MOTIR-10791) ──────────────
  // The carried conflict reading stands until the next push, and the queue exit and the red
  // build stay in their rows, so the rebuild must refuse a head whose CI had a verdict before
  // the checks running there now: a re-run, or a check that began after the verdict.

  /** A check row at PUSHED with its provider time (`conclusionAt`): a pending row's start,
   *  a decided row's finish. Times sit in the past, so a fresh row is never "reopened". */
  const T0 = () => new Date(Date.now() - 600_000);
  const checkAt = (
    pullRequestId: string,
    checkName: string,
    conclusion: 'pending' | 'success' | 'failure',
    conclusionAt: Date,
  ) =>
    adminDb.githubCheckRun.create({
      data: { pullRequestId, commitSha: PUSHED, checkName, conclusion, conclusionAt },
    });
  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
  /** A re-run: the row reopened in place, dated by its own start, after it was recorded. */
  async function reRun(checkRunId: string) {
    const row = await adminDb.githubCheckRun.findUniqueOrThrow({ where: { id: checkRunId } });
    await adminDb.githubCheckRun.update({
      where: { id: checkRunId },
      data: { conclusion: 'pending', conclusionAt: new Date(row.createdAt.getTime() + 60_000) },
    });
  }
  async function twiceNothing(fx: WorkItemFixture, cardId: string) {
    expect(await recompute(fx, cardId), 'first recompute').toEqual({
      fixReason: null,
      fixDetail: null,
    });
    expect(await recompute(fx, cardId), 'second recompute').toEqual({
      fixReason: null,
      fixDetail: null,
    });
  }

  it('the push’s own checks, delivered out of order with real times, still bring the conflict back Fixing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await stuckCard(fx, 'conflicted');
    await pushMarksPending(pr.id, PUSHED);
    await reads(pr.id, 'clean', PUSHED);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    const t0 = T0();
    // Lint finished at +30s and is recorded first; Vitest STARTED at +5s and is recorded later.
    await checkAt(pr.id, 'Lint', 'success', at(t0, 30));
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    await checkAt(pr.id, 'Vitest', 'pending', at(t0, 5));

    for (const pass of ['first', 'second']) {
      expect(await recompute(fx, card.id), `${pass} recompute`).toEqual({
        fixReason: 'conflicted',
        fixDetail: { ...before.fixDetail, fixing: true },
      });
    }
  });

  it('a re-run of a FAILED fix that answered a conflict is never Fixing — however many recomputes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await stuckCard(fx, 'conflicted');
    await pushMarksPending(pr.id, PUSHED);
    await reads(pr.id, 'clean', PUSHED);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    const vitest = await ciStarts(pr.id, PUSHED, 'Vitest');
    await finishes(vitest.id, 'failure');
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { fixing: false, raisedHeads: { [pr.id]: PUSHED } },
    });

    await reRun(vitest.id);

    await twiceNothing(fx, card.id);
  });

  for (const how of ['conflicted', 'queue_failed', 'ci_failed'] as const) {
    for (const later of ['a re-run', 'a check that starts after the verdict'] as const) {
      it(`${how}: a fix that went green, then ${later} at its head, is never Fixing`, async () => {
        const fx = await makeWorkItemFixture();
        const { card, pr } =
          how === 'ci_failed'
            ? await cardWith(fx, 'implemented', { Vitest: 'failure' })
            : await stuckCard(fx, how);
        if (how === 'ci_failed') await recompute(fx, card.id);
        if (how === 'conflicted') {
          await pushMarksPending(pr.id, PUSHED);
          await reads(pr.id, 'clean', PUSHED);
        }
        await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
        // The fix's whole CI: Vitest started at +0s and finished green at +30s.
        const t0 = T0();
        const vitest = await checkAt(pr.id, 'Vitest', 'pending', t0);
        await adminDb.githubCheckRun.update({
          where: { id: vitest.id },
          data: { conclusion: 'success', conclusionAt: at(t0, 30) },
        });
        expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });

        if (later === 'a re-run') await reRun(vitest.id);
        else await checkAt(pr.id, 'Labeled', 'pending', at(t0, 90));

        await twiceNothing(fx, card.id);
      });
    }
  }

  it('the pure half: conflicted outranks out_of_date, which outranks a red build, each on its own head', () => {
    const member = (pullRequestId: string, over: Partial<AnsweredMember>): AnsweredMember => ({
      pullRequestId,
      baseRef: 'main',
      queueFailure: null,
      blockedReading: null,
      red: null,
      ...over,
    });
    const behind = member('pr1', {
      blockedReading: { blocked: 'out_of_date', headSha: HEAD },
      baseRef: 'release',
    });
    const conflicting = member('pr2', {
      blockedReading: { blocked: 'conflicted', headSha: LATER },
    });
    const red = member('pr3', { red: { commitSha: HEAD, failingChecks: ['Vitest'] } });
    const heads = { pr1: PUSHED, pr2: PUSHED, pr3: PUSHED };

    expect(answeredPullRequestReasonOf([behind, conflicting, red], heads, 3)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: {
        base: 'main',
        affected: 1,
        total: 3,
        raisedHeads: { pr1: PUSHED, pr2: LATER, pr3: PUSHED },
      },
    });
    expect(answeredPullRequestReasonOf([red, behind], heads, 3)).toMatchObject({
      fixReason: 'out_of_date',
      fixDetail: { base: 'release', check: null, affected: 1, raisedHeads: { pr1: HEAD } },
    });
  });
});

describe('Fixing while repairing — the pure half', () => {
  const reason = {
    fixReason: 'ci_failed' as const,
    fixDetail: {
      groupKey: 'prs:abc',
      repair: 'fix' as const,
      check: 'Vitest',
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      ...NO_DEAD_RUN,
      affected: 1,
      total: 1,
      fixing: false,
      raisedHeads: { pr1: HEAD },
    },
  };

  it('a reason reads Fixing, everything else on it unchanged', () => {
    expect(fixingWhileRepairing(reason)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...reason.fixDetail, fixing: true },
    });
    expect(priorWhileRepairing(reason)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...reason.fixDetail, fixing: true },
    });
  });

  it('nothing to fix stays nothing, and run_died is never Fixing', () => {
    const died = { ...reason, fixReason: 'run_died' as const };
    expect(fixingWhileRepairing({ fixReason: null, fixDetail: null })).toEqual({
      fixReason: null,
      fixDetail: null,
    });
    expect(fixingWhileRepairing(died)).toBe(died);
    expect(fixingWhileRepairing({ fixReason: 'ci_failed', fixDetail: null })).toEqual({
      fixReason: 'ci_failed',
      fixDetail: null,
    });
    for (const p of [died, { fixReason: null, fixDetail: null }, { ...reason, fixDetail: null }]) {
      expect(priorWhileRepairing(p)).toBeNull();
    }
  });
});

describe('Fixing while repairing — a live `fix` run on the card', () => {
  async function redCard(fx: WorkItemFixture) {
    const made = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    const before = await recompute(fx, made.card.id);
    expect(before).toMatchObject({ fixReason: 'ci_failed', fixDetail: { fixing: false } });
    return { ...made, before };
  }

  const tagFacts = (fx: WorkItemFixture, id: string) =>
    withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
      fixTagFactsFor(fx.workspaceId, [id], tx),
    );

  it('claiming `motir fix` stores Fixing at once — reason, heads and To fix count unchanged — and the row tag reads it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, before } = await redCard(fx);
    expect((await tagFacts(fx, card.id)).fixingIds.has(card.id)).toBe(false);
    const countBefore = (await homeService.tabCounts(hctx(fx))).toFix;

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    expect(claim.outcome).toBe('claimed');

    // No recompute by the test: the run's open wrote it.
    expect(await stored(card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
    expect((await tagFacts(fx, card.id)).fixingIds.has(card.id)).toBe(true);
    const [page, counts] = await Promise.all([
      homeService.listToFix(hctx(fx)),
      homeService.tabCounts(hctx(fx)),
    ]);
    expect(page.items.map((i) => i.id)).toEqual([card.id]);
    expect(counts.toFix).toBe(countBefore);
    // A recompute on any other event while the run is live holds it, writing nothing.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect((await recompute(fx, card.id)).fixDetail?.fixing).toBe(true);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).updatedAt,
    ).toEqual(row.updatedAt);
  });

  it('closing the repair with nothing pushed clears Fixing and shows the earlier reason unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { card, before } = await redCard(fx);
    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    expect((await stored(card.id)).fixDetail).toMatchObject({ fixing: true });

    await workItemRepairService.closeRepair(
      fx.projectId,
      card.identifier,
      claim.runId!,
      'gave_up',
      fx.ctx,
    );

    expect(await stored(card.id)).toEqual(before);
    expect((await tagFacts(fx, card.id)).fixingIds.has(card.id)).toBe(false);
  });

  it('a hosted repair is Fixing from the moment it opens', async () => {
    const fx = await makeWorkItemFixture();
    const { card, before } = await redCard(fx);

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
      opening: {
        origin: 'hosted',
        agent: 'opencode',
        model: 'test-model',
        idempotencyKey: `fix-${randomToken(8)}`,
      },
    });
    expect(claim.outcome).toBe('claimed');

    expect(await stored(card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });
  });

  it('a live repair keeps the prior reason Fixing while CI re-runs at the recorded head — and its close then clears it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    // The repair re-runs the same commit: nothing red, a member running, no head moved.
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'pending' },
    });

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });

    await workItemRepairService.closeRepair(
      fx.projectId,
      card.identifier,
      claim.runId!,
      'gave_up',
      fx.ctx,
    );
    // No run, no moved head: the moved-head rule does not hold it, as before MOTIR-10506.
    expect(await stored(card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a live repair with CI running keeps nothing to keep when the card stored no reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { fixReason: null, fixDetail: Prisma.DbNull },
    });
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'pending' },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('after the repair pushed and closed, the moved-head rule is the reconcile that keeps Fixing until CI decides', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, before } = await redCard(fx);
    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: PUSHED } });
    const check = await ciStarts(pr.id);

    await workItemRepairService.closeRepair(
      fx.projectId,
      card.identifier,
      claim.runId!,
      'halted',
      fx.ctx,
    );
    expect(await stored(card.id)).toEqual({
      fixReason: 'ci_failed',
      fixDetail: { ...before.fixDetail, fixing: true },
    });

    await finishes(check.id, 'success');
    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('green CI while the repair is still open leaves nothing to fix — a live run keeps no fixed card listed', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'success' },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a local repair whose heartbeat has lapsed is not live — Fixing clears before the reap closes it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, before } = await redCard(fx);
    const claim = await workItemRepairService.claimRepairAsAgent(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect((await stored(card.id)).fixDetail).toMatchObject({ fixing: true });
    await adminDb.dispatchRun.update({
      where: { id: claim.runId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    expect(await recompute(fx, card.id)).toEqual(before);
  });
});
