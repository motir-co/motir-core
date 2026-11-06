import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { BoardColumnNotFoundError, InvalidBoardCursorError } from '@/lib/boards/errors';
import type { BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard (Story 3.1 · Subtask 3.1.4, load model corrected by
// 3.8.2). Real Postgres (no mocks), per CLAUDE.md. createTestProject →
// createProject auto-seeds BOTH the default workflow (statuses todo / blocked /
// in_progress / in_review / done / cancelled, in that position order) AND the
// default board (3.1.2): one column per status, each mapped to its status. So
// getBoard reads a fully-seeded board with no manual row inserts.
//
// MOTIR-10535 pages the board PER LANE: each lane loads its first
// BOARD_PAGE_SIZE cards plus a keyset cursor and its FULL totalCount, and
// `getColumnPage` returns the page after a cursor. It reverses 3.8.2's
// whole-bounded-set model (the cap, the `truncated` banner and the Done-age
// window are gone), so a Done lane pages by recency like any other lane.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const DEFAULT_KEYS = [
  'todo',
  'blocked',
  'in_progress',
  // MOTIR-3003 — built, pull request open, CI not yet green; before `planning`
  // because slot 4 is the last board column a laptop shows in full.
  'implemented',
  'planning',
  'in_review',
  // MOTIR-5139 — a person's YES, between review and the merge.
  'approved',
  'done',
  'cancelled',
];

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Proj User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Proj WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** Create an issue (lands in `todo`) and force it into `status` (the projection
 * groups by `work_item.status`; we set it directly rather than walk the
 * transition graph — the transition path is 3.1.5's test, not this one). */
async function cardInStatus(fx: Fixture, status: string, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  if (status !== 'todo') {
    await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
  }
  return item.id;
}

/** Bulk-insert `n` cards directly in `status` with deterministic positions —
 * fast fixture for the scale/pagination assertions (keys start at 1000 to avoid
 * colliding with service-allocated keys). */
async function bulkCards(fx: Fixture, status: string, n: number): Promise<void> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  // A VALID fractional-index key per row, chained so the lexicographic position
  // sort is still the insertion order (MOTIR-2198). The old `p${padStart(4)}`
  // form sorted correctly but is a key nothing in the product can mint — head
  // `'p'` demands a 17-char integer part — so a fixture built from it seeds a
  // board state the application cannot reach.
  let position: string | null = null;
  await adminDb.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const key = 1000 + i;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${project.identifier}-${key}`,
        title: `Bulk ${i}`,
        status,
        reporterId: fx.ctx.userId,
        position: (position = keyForAppend(position)),
      };
    }),
  });
}

/** Like {@link bulkCards}, from a chosen key — for a second bulk set. The
 * positions chain AFTER every card already in the project. */
async function bulkCardsAt(fx: Fixture, status: string, n: number, from: number): Promise<void> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  const last = await adminDb.workItem.findFirst({
    where: { projectId: fx.projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  let position: string | null = last?.position ?? null;
  await adminDb.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: 'task' as const,
      key: from + i,
      identifier: `${project.identifier}-${from + i}`,
      title: `Extra ${i}`,
      status,
      reporterId: fx.ctx.userId,
      position: (position = keyForAppend(position)),
    })),
  });
}

function laneOf(board: BoardProjectionDto, statusKey: string): BoardColumnDto {
  return board.columns.find((c) => c.statusKeys[0] === statusKey)!;
}

/** Every card title of one lane, first page then every next page to the end. */
async function pageThrough(
  fx: Fixture,
  board: BoardProjectionDto,
  statusKey: string,
): Promise<string[]> {
  const lane = laneOf(board, statusKey);
  const titles = lane.cards.map((c) => c.title);
  let cursor = lane.cursor;
  while (cursor) {
    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      lane.id,
      cursor,
    );
    expect(page.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
    titles.push(...page.cards.map((c) => c.title));
    cursor = page.cursor;
  }
  return titles;
}

describe('boardsService.getBoard — projection', () => {
  it('groups cards into the right columns in workflow order, with per-column counts', async () => {
    const fx = await makeFixture('proj-group@example.com');
    await cardInStatus(fx, 'todo', 'A');
    await cardInStatus(fx, 'todo', 'B');
    await cardInStatus(fx, 'in_progress', 'C');
    await cardInStatus(fx, 'done', 'D');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.columns.map((c) => c.statusKeys[0])).toEqual(DEFAULT_KEYS);
    const byKey = new Map(board.columns.map((c) => [c.statusKeys[0], c]));
    expect(byKey.get('todo')!.totalCount).toBe(2);
    expect(byKey.get('todo')!.cards).toHaveLength(2);
    expect(byKey.get('in_progress')!.totalCount).toBe(1);
    expect(byKey.get('done')!.totalCount).toBe(1);
    expect(byKey.get('blocked')!.cards).toHaveLength(0);
    expect(byKey.get('blocked')!.cursor).toBeNull();
    expect(board.unmappedStatuses).toHaveLength(0);
    // every card carries the readiness flag (no blockers → ready)
    expect(byKey.get('todo')!.cards.every((c) => c.ready)).toBe(true);
  });

  it('surfaces a status mapped to no column in unmappedStatuses (never a column, never dropped)', async () => {
    const fx = await makeFixture('proj-unmapped@example.com');
    await workflowsService.createStatus({
      userId: fx.ctx.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'needs_triage',
      label: 'Needs Triage',
      category: 'todo',
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.unmappedStatuses.map((s) => s.key)).toEqual(['needs_triage']);
    // still the original default columns; the new status is NOT one of them
    expect(board.columns).toHaveLength(DEFAULT_KEYS.length);
    expect(board.columns.flatMap((c) => c.statusKeys)).not.toContain('needs_triage');
  });

  it("loads each lane's FIRST PAGE with a cursor and the full count (MOTIR-10535)", async () => {
    const fx = await makeFixture('proj-firstpage@example.com');
    await bulkCards(fx, 'todo', 25);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = laneOf(board, 'todo');
    expect(todo.totalCount).toBe(25);
    expect(todo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todo.cards.map((c) => c.title)).toEqual(
      Array.from({ length: BOARD_PAGE_SIZE }, (_, i) => `Bulk ${i}`),
    );
    expect(todo.cursor).not.toBeNull();
    // A lane that fits in one page has no cursor.
    expect(laneOf(board, 'blocked').cursor).toBeNull();
  });

  it('pages an open lane to its end in position order — no repeat, no skip', async () => {
    const fx = await makeFixture('proj-pagethrough@example.com');
    await bulkCards(fx, 'todo', 23);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const titles = await pageThrough(fx, board, 'todo');
    expect(titles).toEqual(Array.from({ length: 23 }, (_, i) => `Bulk ${i}`));
  });

  it('pages a Done lane by recency, and no longer windows old done cards out', async () => {
    const fx = await makeFixture('proj-donepaging@example.com');
    await bulkCards(fx, 'done', 14);
    // Spread updatedAt so the recency order is the REVERSE of insertion, and put
    // one card months in the past — the retired Done-age window would have
    // dropped it; paging keeps it, last.
    await adminDb.$executeRaw`
      UPDATE "work_item"
         SET "updatedAt" = now() - (("key" - 1000) || ' minutes')::interval
       WHERE "projectId" = ${fx.projectId}`;
    await adminDb.$executeRaw`
      UPDATE "work_item" SET "updatedAt" = now() - interval '120 days'
       WHERE "projectId" = ${fx.projectId} AND "key" = 1013`;

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const done = laneOf(board, 'done');
    expect(done.totalCount).toBe(14);
    expect(done.cards).toHaveLength(BOARD_PAGE_SIZE);
    const titles = await pageThrough(fx, board, 'done');
    expect(titles).toEqual(Array.from({ length: 14 }, (_, i) => `Bulk ${i}`));
  });

  it('breaks an updatedAt tie on the Done lane by key, across a page boundary', async () => {
    const fx = await makeFixture('proj-donetie@example.com');
    await bulkCards(fx, 'cancelled', 12);
    await adminDb.$executeRaw`
      UPDATE "work_item" SET "updatedAt" = '2026-01-01T00:00:00.000Z'
       WHERE "projectId" = ${fx.projectId}`;

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const titles = await pageThrough(fx, board, 'cancelled');
    expect(titles).toEqual(Array.from({ length: 12 }, (_, i) => `Bulk ${i}`));
  });

  it('pages a lane that maps SEVERAL statuses as one ordered lane', async () => {
    const fx = await makeFixture('proj-multistatus@example.com');
    await bulkCards(fx, 'todo', 7);
    await bulkCardsAt(fx, 'blocked', 7, 2000);
    // Re-map `blocked` onto the To Do column (a status sits in one column).
    const board0 = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todoCol = laneOf(board0, 'todo');
    const blocked = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, key: 'blocked' },
    });
    await adminDb.boardColumnStatus.updateMany({
      where: { boardId: board0.boardId, statusId: blocked.id },
      data: { columnId: todoCol.id },
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const lane = board.columns.find((c) => c.id === todoCol.id)!;
    expect(lane.statusKeys).toEqual(['todo', 'blocked']); // workflow position order
    expect(lane.totalCount).toBe(14);
    const titles = await pageThrough(fx, board, 'todo');
    expect(titles).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `Bulk ${i}`),
      ...Array.from({ length: 7 }, (_, i) => `Extra ${i}`),
    ]);
  });

  it('refuses a cursor the lane did not mint, and a lane that is not on the board', async () => {
    const fx = await makeFixture('proj-badcursor@example.com');
    await bulkCards(fx, 'todo', 12);
    await bulkCardsAt(fx, 'done', 12, 2000);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = laneOf(board, 'todo');
    const done = laneOf(board, 'done');

    await expect(
      boardsService.getColumnPage(fx.projectId, fx.ctx, board.boardId, todo.id, 'not-a-cursor'),
    ).rejects.toBeInstanceOf(InvalidBoardCursorError);
    // A position cursor handed to a recency lane is not that lane's cursor.
    await expect(
      boardsService.getColumnPage(fx.projectId, fx.ctx, board.boardId, done.id, todo.cursor!),
    ).rejects.toBeInstanceOf(InvalidBoardCursorError);
    await expect(
      boardsService.getColumnPage(
        fx.projectId,
        fx.ctx,
        board.boardId,
        'no-such-lane',
        todo.cursor!,
      ),
    ).rejects.toBeInstanceOf(BoardColumnNotFoundError);
  });

  it("a page answers the lane's CURRENT count when cards moved after the first page", async () => {
    const fx = await makeFixture('proj-livecount@example.com');
    await bulkCards(fx, 'todo', 15);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = laneOf(board, 'todo');
    await bulkCardsAt(fx, 'todo', 3, 3000);

    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      todo.id,
      todo.cursor!,
    );
    expect(page.columnId).toBe(todo.id);
    expect(page.totalCount).toBe(18);
    expect(page.cards).toHaveLength(8);
    expect(page.cursor).toBeNull();
  });

  it('orders a terminal (done) column by recency, not rank', async () => {
    const fx = await makeFixture('proj-terminal@example.com');
    // earlierByPosition has the EARLIER position but is touched LAST, so
    // position-order and recency-order disagree — proving the done column uses
    // recency (most-recently-updated first).
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    const earlierKey = keyForAppend(null);
    const laterKey = keyForAppend(earlierKey);
    await adminDb.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2001,
        identifier: `${project.identifier}-2001`,
        title: 'earlier position',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: earlierKey,
      },
    });
    const laterPos = await adminDb.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2002,
        identifier: `${project.identifier}-2002`,
        title: 'later position, touched last',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: laterKey,
      },
    });
    // touch the later-position card so it is the most recently updated
    await adminDb.workItem.update({ where: { id: laterPos.id }, data: { title: 'touched' } });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;
    expect(done.cards[0]!.id).toBe(laterPos.id); // recency wins over position
  });

  it('is workspace-scoped — a board read for another workspace 404s, and never leaks cards', async () => {
    const a = await makeFixture('proj-ws-a@example.com');
    const b = await makeFixture('proj-ws-b@example.com');
    await cardInStatus(a, 'todo', 'A-only');

    // B's context cannot read A's board. The project access gate (6.4.3) now
    // fronts getBoard, so a cross-workspace projectId is rejected as
    // ProjectNotFoundError (still a 404, still no existence leak — same family
    // as getProjectTree's cross-tenant read) BEFORE the board lookup.
    await expect(boardsService.getBoard(a.projectId, b.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    // B's own board sees none of A's cards.
    const boardB = await boardsService.getBoard(b.projectId, b.ctx);
    expect(boardB.columns.every((c) => c.totalCount === 0)).toBe(true);
  });

  it('marks a card with an open (non-terminal) blocker as not ready (batch readiness, finding #21)', async () => {
    const fx = await makeFixture('proj-ready@example.com');
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'blocker (todo = non-terminal)' },
      fx.ctx,
    );
    const blocked = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'blocked by the open blocker',
        links: [{ targetId: blocker.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    const cardById = new Map(todo.cards.map((c) => [c.id, c]));
    expect(cardById.get(blocked.id)!.ready).toBe(false); // open blocker → not ready
    expect(cardById.get(blocker.id)!.ready).toBe(true); // the blocker itself has none
  });

  it('carries the canvas tag-row facts: readyToStart, statusLabel, hasChildren, type, executor (MOTIR-10534)', async () => {
    const fx = await makeFixture('proj-tags@example.com');
    const planned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'story with a child' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'the child', parentId: planned.id },
      fx.ctx,
    );
    const unplanned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'childless story' },
      fx.ctx,
    );
    // An ARCHIVED child is not a child: its parent still reads unplanned.
    const archivedParent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'story whose only child is archived' },
      fx.ctx,
    );
    const gone = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'archived child',
        parentId: archivedParent.id,
      },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    const blocked = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'blocked by the planned story',
        links: [{ targetId: planned.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: blocked.id },
      data: { type: 'manual', executor: 'human' },
    });
    const started = await cardInStatus(fx, 'in_progress', 'already started');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const cards = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));

    expect(cards.get(planned.id)).toMatchObject({
      statusLabel: 'To Do',
      hasChildren: true,
      ready: true,
      readyToStart: true,
    });
    expect(cards.get(unplanned.id)).toMatchObject({ hasChildren: false, readyToStart: true });
    expect(cards.get(archivedParent.id)!.hasChildren).toBe(false);
    // Blocked: unready, so never Ready; its type and executor ride along for Manual.
    expect(cards.get(blocked.id)).toMatchObject({
      ready: false,
      readyToStart: false,
      type: 'manual',
      executor: 'human',
    });
    // Unblocked but already started: not startable, so not Ready.
    expect(cards.get(started)).toMatchObject({
      statusLabel: 'In Progress',
      ready: true,
      readyToStart: false,
    });
  });

  it('findParentIdsWithLiveChildren short-circuits an empty id set', async () => {
    const fx = await makeFixture('empty-live-children@example.com');
    const result = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findParentIdsWithLiveChildren([], fx.workspaceId, tx),
    );
    expect(result.size).toBe(0);
  });

  it('findBlockerStatesForItems short-circuits an empty id set without a query', async () => {
    // Bound even though the short-circuit returns before any client is touched
    // (MOTIR-2911): `work_item_link` is gated and this method is bindable, so an
    // unbound call here is indistinguishable — to a reader and to
    // `tests/rls/test-call-site-guard.test.ts` — from one that DOES reach the
    // singleton and silently reads nothing.
    const fx = await makeFixture('empty-blocker-states@example.com');
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockerStatesForItems([], tx),
      ),
    ).toEqual([]);
  });
});
