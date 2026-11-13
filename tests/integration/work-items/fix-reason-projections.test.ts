import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6589 · MOTIR-6610 — `fixReason` rides every read the To fix TAG is
// drawn from: the board card, the `/items` List page, the filtered Tree (forest),
// the lazy Tree's root level and the quick view. These reads PROJECT four
// different ways — a whole-row Prisma read, two fixed `$queryRaw` projections and
// the detail aggregate — and a column left out of any one of them arrives as
// `undefined` with nothing going red. So each read is compared to the STORED value
// with `toBe`, never `toBeTruthy`: two reads that both dropped the column agree
// perfectly, at `undefined`.

async function card(fx: WorkItemFixture, title: string, fixReason: WorkItemFixReasonDto | null) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status: 'in_progress', fixReason },
  });
  return item;
}

describe('fixReason on every tag read (MOTIR-6610)', () => {
  beforeEach(async () => {
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
    await adminDb.$disconnect();
  });

  it('carries the stored value — each reason, and null — through all five reads', async () => {
    const fx = await makeWorkItemFixture();
    const cases: Array<[string, WorkItemFixReasonDto | null]> = [
      ['queue', 'queue_failed'],
      ['conflict', 'conflicted'],
      ['red', 'ci_failed'],
      ['sent back', 'changes_requested'],
      ['healthy', null],
    ];
    const items = [];
    for (const [title, reason] of cases) items.push(await card(fx, title, reason));

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const boardCards = board.columns.flatMap((c) => c.cards);
    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const forest = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    const root = await workItemsService.listRootIssues(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );

    for (const [i, [, expected]] of cases.entries()) {
      const item = items[i]!;
      expect(boardCards.find((c) => c.id === item.id)?.fixReason, 'board').toBe(expected);
      expect(list.items.find((r) => r.id === item.id)?.fixReason, 'list').toBe(expected);
      expect(forest.find((n) => n.id === item.id)?.fixReason, 'tree (forest)').toBe(expected);
      const rootRow = root.rows.find((r) => 'id' in r && r.id === item.id) as
        | { fixReason?: WorkItemFixReasonDto | null }
        | undefined;
      expect(rootRow?.fixReason, 'tree (lazy root level)').toBe(expected);
      const peek = await workItemsService.getQuickView(
        fx.projectId,
        item.identifier,
        'workspace',
        fx.ctx,
        'en',
      );
      expect(peek.fixReason, 'quick view').toBe(expected);
    }
  });
});

describe('fixReason + fixDetail on the item page read (MOTIR-6611)', () => {
  beforeEach(async () => {
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
  });

  it('carries the stored reason and its detail, and null for both on a card with none', async () => {
    const fx = await makeWorkItemFixture();
    const stuck = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Sent back' },
      fx.ctx,
    );
    const healthy = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Healthy' },
      fx.ctx,
    );
    const detail = {
      repair: 'run',
      check: null,
      queueReason: null,
      base: null,
      reviewerName: 'Ana Ruiz',
      notePreview: 'Double-counts a moved card.',
      gate: 'pull_request_approval',
      reviewRef: null,
      affected: 2,
      total: 2,
    } as const;
    await adminDb.workItem.update({
      where: { id: stuck.id },
      data: { status: 'in_progress', fixReason: 'changes_requested', fixDetail: detail },
    });

    const read = await workItemsService.getIssueDetail(fx.projectId, stuck.identifier, fx.ctx);
    expect(read.fixReason).toBe('changes_requested');
    // A detail stored before the dead-run fields existed (MOTIR-6880) reads them as null.
    expect(read.fixDetail).toEqual({
      ...detail,
      groupKey: null,
      lastHeardAt: null,
      ranByName: null,
      branch: null,
      branches: null,
      pushed: null,
      continueKey: null,
      diedReason: null,
      // …and one stored before Fixing (MOTIR-10307) reads as not Fixing, with no heads.
      fixing: false,
      raisedHeads: null,
    });

    const none = await workItemsService.getIssueDetail(fx.projectId, healthy.identifier, fx.ctx);
    expect(none.fixReason).toBeNull();
    expect(none.fixDetail).toBeNull();
  });
});
