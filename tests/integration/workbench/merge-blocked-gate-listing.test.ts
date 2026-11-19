import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalGateKind, WorkItemFixReason } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PRIMARY_GATE_KINDS } from '@/lib/approvalGates/gateSet';
import { PULL_REQUEST_FIX_REASONS } from '@/lib/workItems/fixReason';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr } from '../../helpers/repairFixtures';

// Bug MOTIR-11823 — a card stuck on To fix for a PULL-REQUEST reason was also listed on
// Waiting on you by its acceptance video, whose Approve is approve-and-merge and is refused
// at the press (`MERGE_OUT_OF_DATE`). A gate whose Approve merges is now off Waiting on you
// while its card holds such a reason (`design/workbench/design-notes.md` § 42), and comes
// back when the reason clears. Against real Postgres, through the queue's own reads: the
// rows and the count from the one builder, the strip's counts and the watermark.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = () => ({ ...fx.ctx, projectId: fx.projectId });

/** A card reported by the owner and unassigned — routed to the owner (§2). */
async function card(opts: { delivers: boolean; kind?: 'story' | 'task' }): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: opts.kind ?? 'story', title: `Card ${Math.random()}` },
    fx.ctx,
  );
  // `implemented` — in the in-progress category, where To fix lists a card.
  await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });
  if (opts.delivers) {
    const repo = await connectRepairRepo(fx, `repo-${item.id.slice(-6)}`);
    await deliveredPr(fx, item.id, repo, { headRef: `story/${item.id}` });
  }
  return item.id;
}

async function awaitingGate(workItemId: string, kind: ApprovalGateKind): Promise<string> {
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind,
      subjectId: `subject-${kind}-${workItemId}`,
      state: 'awaiting',
      routedToId: fx.ownerId,
    },
  });
  return row.id;
}

/** What the recompute stores — set directly: how it is derived has its own suites. */
async function setFixReason(workItemId: string, fixReason: WorkItemFixReason | null) {
  await adminDb.workItem.update({
    where: { id: workItemId },
    data: {
      fixReason,
      fixDetail:
        fixReason === null
          ? undefined
          : { repair: 'fix', affected: 1, total: 1, groupKey: `card:${workItemId}` },
    },
  });
  if (fixReason === null) {
    await adminDb.$executeRawUnsafe(
      'UPDATE "work_item" SET "fixDetail" = NULL WHERE id = $1',
      workItemId,
    );
  }
}

/** The queue as the builder answers it: its rows' ids and its count, in one transaction. */
async function queue(): Promise<{ ids: string[]; count: number }> {
  return withWorkspaceContext(fx.ctx, async (tx) => {
    const scope = { projectIds: [fx.projectId], userId: fx.ownerId, awaitingSessionIds: [] };
    const rows = await approvalGateRepository.findAwaitingRoutedTo(
      scope,
      { skip: 0, take: 50 },
      tx,
    );
    const count = await approvalGateRepository.countAwaitingRoutedTo(scope, tx);
    return { ids: rows.map((row) => row.id), count };
  });
}

/** The two tabs as the strip and the stream read them. */
async function tabs() {
  const [counts, watermark, awaitingMe] = await Promise.all([
    homeService.tabCounts(me()),
    workbenchWatermarkService.read(me()),
    approvalGatesService.countAwaitingMe(me()),
  ]);
  return {
    approvals: counts.approvals,
    toFix: counts.toFix,
    watermarkApprovals: watermark.tabs.approvals.count,
    awaitingMe,
  };
}

describe('the reported case — a story run whose pull request fell behind a strict base', () => {
  it('lists the acceptance video under To fix only, and brings it back when the reason clears', async () => {
    const story = await card({ delivers: true });
    const acceptance = await awaitingGate(story, 'acceptance_result');
    // The approve-to-merge gate the acceptance press carries — never listed beside it.
    await awaitingGate(story, 'pull_request_approval');

    // Before the base moves: one decision, on Waiting on you only. (The watermark's count
    // adds the review reading of a story run's acceptance row — MOTIR-10734 — so it is
    // compared across the three moments, never to a literal.)
    expect(await queue()).toEqual({ ids: [acceptance], count: 1 });
    const before = await tabs();
    expect(before).toMatchObject({ approvals: 1, toFix: 0, awaitingMe: 1 });
    expect(before.watermarkApprovals).toBeGreaterThan(0);

    // The recompute stores `out_of_date`: one tab, To fix.
    await setFixReason(story, 'out_of_date');
    expect(await queue()).toEqual({ ids: [], count: 0 });
    expect(await tabs()).toEqual({ approvals: 0, toFix: 1, watermarkApprovals: 0, awaitingMe: 0 });

    // The repair lands and the reason clears: back on Waiting on you, gate untouched.
    await setFixReason(story, null);
    expect(await queue()).toEqual({ ids: [acceptance], count: 1 });
    expect(await tabs()).toEqual(before);
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: acceptance } })).state,
    ).toBe('awaiting');
  });
});

describe('which reasons hold the gate back', () => {
  it.each(PULL_REQUEST_FIX_REASONS)(
    'a pull-request reason (%s) takes the merging gate off',
    async (reason) => {
      const story = await card({ delivers: true });
      await awaitingGate(story, 'acceptance_result');
      await setFixReason(story, reason);

      expect(await queue()).toEqual({ ids: [], count: 0 });
    },
  );

  it.each(['run_died', 'changes_requested'] as const)(
    'a reason that is not about the pull requests (%s) leaves the gate listed',
    async (reason) => {
      const story = await card({ delivers: true });
      const acceptance = await awaitingGate(story, 'acceptance_result');
      await setFixReason(story, reason);

      expect(await queue()).toEqual({ ids: [acceptance], count: 1 });
    },
  );
});

describe('which gates merge', () => {
  it('the approve-to-merge gate asked alone is held back', async () => {
    const task = await card({ delivers: true, kind: 'task' });
    await awaitingGate(task, 'pull_request_approval');
    await setFixReason(task, 'conflicted');

    expect(await queue()).toEqual({ ids: [], count: 0 });
  });

  it.each(PRIMARY_GATE_KINDS)(
    'a %s gate on a card that delivers pull requests is held back',
    async (kind) => {
      const task = await card({ delivers: true, kind: 'task' });
      await awaitingGate(task, kind);
      await setFixReason(task, 'ci_failed');

      expect(await queue()).toEqual({ ids: [], count: 0 });
    },
  );

  it.each(PRIMARY_GATE_KINDS)(
    'a %s gate on a card with no pull request merges nothing and stays listed',
    async (kind) => {
      const task = await card({ delivers: false, kind: 'task' });
      const gate = await awaitingGate(task, kind);
      await setFixReason(task, 'out_of_date');

      expect(await queue()).toEqual({ ids: [gate], count: 1 });
    },
  );

  it.each(['decision_choice', 'manual_work'] as const)(
    'a %s gate merges nothing and stays listed beside a pull-request reason',
    async (kind) => {
      const task = await card({ delivers: true, kind: 'task' });
      const gate = await awaitingGate(task, kind);
      await setFixReason(task, 'out_of_date');

      expect(await queue()).toEqual({ ids: [gate], count: 1 });
    },
  );

  it('only the stuck card leaves — a sibling card in the same queue stays', async () => {
    const stuck = await card({ delivers: true });
    const fine = await card({ delivers: true });
    await awaitingGate(stuck, 'acceptance_result');
    const kept = await awaitingGate(fine, 'acceptance_result');
    await setFixReason(stuck, 'queue_failed');

    expect(await queue()).toEqual({ ids: [kept], count: 1 });
  });
});

describe('a card-less gate is untouched by the card terms', () => {
  it('a plan gate stays listed — NOT over a NULL relation does not drop it', async () => {
    const row = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: 'plan-without-a-card',
        state: 'awaiting',
        routedToId: fx.ownerId,
      },
    });

    expect(await queue()).toEqual({ ids: [row.id], count: 1 });
  });
});
