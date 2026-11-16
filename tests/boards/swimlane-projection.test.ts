import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardSwimlaneGroupBy } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { keyForAppend } from '@/lib/workItems/positioning';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { BoardCardDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// boardsService.getBoard — swimlane projection (Story 3.3 · Subtask 3.3.4). Real
// Postgres (no mocks), per CLAUDE.md. createTestProject auto-seeds the default
// workflow + board (one column per status); cards created here land in `todo`
// (the initial status), so they are all on the board. These tests prove: the
// bounded lane list + per-lane counts (incl. the epic-ANCESTOR grouping and the
// catch-all), the `none` no-op, and — since MOTIR-11445 — that a GROUPED board's
// columns are META only: `cards: []`, `cursor: null`, the column's FULL
// `totalCount` and an empty `planHolds`, with no card read at all.
//
// A grouped projection carries no card, so it can no longer carry a per-card
// `swimlaneKey` either. The nearest-ancestor lane guarantee those assertions
// held (a task two levels under an epic lands in the EPIC's lane) is asserted
// by the lane-scoped read's own tests (`tests/boards/cell-page.test.ts`), whose
// cells are where a grouped board's cards now come from.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const ws = await workspacesService.createWorkspace({ name: 'Swimlane WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** Flip the project's (single) default board to a group-by. */
async function setGroupBy(fx: Fixture, groupBy: BoardSwimlaneGroupBy): Promise<void> {
  await adminDb.board.updateMany({
    where: { projectId: fx.projectId },
    data: { swimlaneGroupBy: groupBy },
  });
}

/** Create a `todo` card (optionally under a parent). */
async function card(
  fx: Fixture,
  title: string,
  opts: { kind?: 'epic' | 'story' | 'task'; parentId?: string } = {},
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: opts.kind ?? 'task', title, parentId: opts.parentId },
    fx.ctx,
  );
  return item.id;
}

/** Set an arbitrary assignee id (the user must exist; membership isn't gated by
 * the projection). */
async function assign(itemId: string, userId: string | null): Promise<void> {
  await adminDb.workItem.update({ where: { id: itemId }, data: { assigneeId: userId } });
}

async function setPriority(itemId: string, priority: 'high' | 'medium' | 'low'): Promise<void> {
  await adminDb.workItem.update({ where: { id: itemId }, data: { priority } });
}

/** Find a card across all columns of the projection. */
function findCard(board: BoardProjectionDto, id: string): BoardCardDto | undefined {
  for (const col of board.columns) {
    const hit = col.cards.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Every grouped column is meta only: no cards, no cursor (MOTIR-11445). */
function expectMetaOnly(board: BoardProjectionDto): void {
  expect(board.columns.length).toBeGreaterThan(0);
  for (const col of board.columns) {
    expect(col.cards).toEqual([]);
    expect(col.cursor).toBeNull();
    expect(typeof col.id).toBe('string');
    expect(typeof col.name).toBe('string');
    expect(typeof col.position).toBe('string');
    expect(col).toHaveProperty('wipLimit');
    expect(Array.isArray(col.statusKeys)).toBe(true);
  }
  expect(board.planHolds).toEqual({});
}

/** Seed `n` unassigned `todo` cards in insertion order (valid fractional keys). */
async function bulk(fx: Fixture, n: number, status = 'todo'): Promise<void> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  // `position` is a VALID fractional-index key chained in insertion order
  // (MOTIR-2198): a key nothing in the product can mint would seed a state the
  // application cannot reach.
  let position: string | null = null;
  const base = 1000 + (await adminDb.workItem.count({ where: { projectId: fx.projectId } }));
  await adminDb.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const key = base + i;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${project.identifier}-${key}`,
        title: `Bulk ${status} ${i}`,
        status,
        reporterId: fx.ctx.userId,
        position: (position = keyForAppend(position)),
      };
    }),
  });
}

function todoColumn(board: BoardProjectionDto) {
  return board.columns.find((c) => c.statusKeys[0] === 'todo')!;
}

describe('boardsService.getBoard — swimlane projection (3.3.4)', () => {
  it('group-by none is the flat shape: no lanes, no per-card swimlaneKey', async () => {
    const fx = await makeFixture('swl-none@example.com');
    const a = await card(fx, 'A');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.swimlaneGroupBy).toBe('none');
    expect(board.swimlanes).toEqual([]);
    // the flat board still carries its first page (MOTIR-11445 leaves it alone)
    expect(findCard(board, a)).toBeDefined();
    // the flat board stamps NO swimlaneKey (byte-for-byte 3.1.4 card shape)
    expect(findCard(board, a)).not.toHaveProperty('swimlaneKey');
  });

  it('group-by assignee: meta-only columns + alpha lanes + "No assignee" catch-all last', async () => {
    const fx = await makeFixture('swl-assignee@example.com');
    const alice = await usersService.createUser({
      email: 'alice@example.com',
      password: 'hunter2hunter2',
      name: 'Alice',
    });
    const bob = await usersService.createUser({
      email: 'bob@example.com',
      password: 'hunter2hunter2',
      name: 'Bob',
    });
    const a1 = await card(fx, 'a1');
    const a2 = await card(fx, 'a2');
    const b1 = await card(fx, 'b1');
    const u1 = await card(fx, 'unassigned');
    await assign(a1, alice.id);
    await assign(a2, alice.id);
    await assign(b1, bob.id);
    await assign(u1, null);
    await setGroupBy(fx, BoardSwimlaneGroupBy.assignee);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.swimlaneGroupBy).toBe('assignee');
    expectMetaOnly(board);
    // the column's FULL count across every lane, against an empty `cards`
    expect(todoColumn(board).totalCount).toBe(4);
    // lanes: Alice, Bob (alpha by name), then the catch-all LAST
    expect(board.swimlanes.map((l) => l.key)).toEqual([alice.id, bob.id, BOARD_SWIMLANE_NO_VALUE]);
    expect(board.swimlanes.map((l) => l.label)).toEqual(['Alice', 'Bob', 'No assignee']);
    expect(board.swimlanes.every((l) => l.kind === 'assignee')).toBe(true);
    const byKey = new Map(board.swimlanes.map((l) => [l.key, l.count]));
    expect(byKey.get(alice.id)).toBe(2);
    expect(byKey.get(bob.id)).toBe(1);
    expect(byKey.get(BOARD_SWIMLANE_NO_VALUE)).toBe(1);
  });

  it('group-by priority: meta-only columns + severity-ranked lanes, no catch-all', async () => {
    const fx = await makeFixture('swl-priority@example.com');
    const h1 = await card(fx, 'h1');
    const h2 = await card(fx, 'h2');
    const m1 = await card(fx, 'm1');
    await setPriority(h1, 'high');
    await setPriority(h2, 'high');
    await setPriority(m1, 'medium');
    await setGroupBy(fx, BoardSwimlaneGroupBy.priority);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expectMetaOnly(board);
    expect(todoColumn(board).totalCount).toBe(3);
    // highest severity first; priority is non-null so there is NO catch-all
    expect(board.swimlanes.map((l) => l.key)).toEqual(['high', 'medium']);
    expect(board.swimlanes.find((l) => l.key === 'high')!.count).toBe(2);
    expect(board.swimlanes.every((l) => l.kind === 'priority')).toBe(true);
    expect(board.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(false);
  });

  it('group-by epic: lanes group by the ANCESTOR epic + "No epic" catch-all, columns meta-only', async () => {
    const fx = await makeFixture('swl-epic@example.com');
    const epic = await card(fx, 'Epic', { kind: 'epic' });
    const story = await card(fx, 'Story', { kind: 'story', parentId: epic });
    await card(fx, 'Task', { kind: 'task', parentId: story });
    await card(fx, 'No-epic task'); // top-level task, no epic ancestor
    await setGroupBy(fx, BoardSwimlaneGroupBy.epic);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expectMetaOnly(board);
    expect(todoColumn(board).totalCount).toBe(4);
    const epicLane = board.swimlanes.find((l) => l.key === epic)!;
    const catchAll = board.swimlanes.find((l) => l.key === BOARD_SWIMLANE_NO_VALUE)!;
    expect(epicLane.kind).toBe('epic');
    expect(epicLane.label).toContain('Epic'); // identifier + title
    // the epic lane counts every card whose ancestor epic is this epic (epic +
    // story + the task two levels down), from the aggregate — not the cards
    expect(epicLane.count).toBe(3);
    expect(catchAll.count).toBe(1);
    // catch-all sorts last
    expect(board.swimlanes[board.swimlanes.length - 1]!.key).toBe(BOARD_SWIMLANE_NO_VALUE);
  });

  it('a grouped board counts the full column and reads no card; its cells page instead (MOTIR-11445)', async () => {
    const fx = await makeFixture('swl-bound@example.com');
    // 120 unassigned todo + 30 in_progress cards — well past a page per column.
    await bulk(fx, 120, 'todo');
    await bulk(fx, 30, 'in_progress');
    await setGroupBy(fx, BoardSwimlaneGroupBy.assignee);

    const grouped = await countDelegateCalls('workItem', 'findMany', () =>
      boardsService.getBoard(fx.projectId, fx.ctx),
    );
    const board = grouped.result;
    // No card read at all: the card read's delegate never ran.
    expect(grouped.queries).toBe(0);
    expectMetaOnly(board);
    const todo = todoColumn(board);
    expect(todo.totalCount).toBe(120);
    expect(board.columns.find((c) => c.statusKeys.includes('in_progress'))!.totalCount).toBe(30);
    // the swimlane list is the AGGREGATE over all 150 (a bounded distinct query)
    const catchAll = board.swimlanes.find((l) => l.key === BOARD_SWIMLANE_NO_VALUE)!;
    expect(catchAll.count).toBe(150);

    // The same board read FLAT reads each mapped column's first page.
    await setGroupBy(fx, BoardSwimlaneGroupBy.none);
    const flat = await countDelegateCalls('workItem', 'findMany', () =>
      boardsService.getBoard(fx.projectId, fx.ctx),
    );
    const mapped = flat.result.columns.filter((c) => c.statusKeys.length > 0).length;
    expect(flat.queries).toBeGreaterThanOrEqual(mapped);
    expect(todoColumn(flat.result).cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todoColumn(flat.result).cursor).not.toBeNull();

    // On the grouped board the catch-all lane's cell pages carry the cards.
    await setGroupBy(fx, BoardSwimlaneGroupBy.assignee);
    const lane = await boardsService.getLanePage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      BOARD_SWIMLANE_NO_VALUE,
    );
    const todoCell = lane.cells.find((c) => c.columnId === todo.id)!;
    expect(todoCell.totalCount).toBe(120);
    expect(todoCell.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todoCell.cursor).not.toBeNull();
  });

  it('a column mapping no live status is empty and uncounted, grouped or flat', async () => {
    const fx = await makeFixture('swl-unmapped@example.com');
    await card(fx, 'A');
    const board0 = await adminDb.board.findFirstOrThrow({ where: { projectId: fx.projectId } });
    const orphan = await adminDb.boardColumn.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: board0.id,
        name: 'Unmapped',
        position: 'zz',
      },
    });

    for (const groupBy of [BoardSwimlaneGroupBy.priority, BoardSwimlaneGroupBy.none]) {
      await setGroupBy(fx, groupBy);
      const count = vi.spyOn(workItemRepository, 'countProjectIssues');
      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const col = board.columns.find((c) => c.id === orphan.id)!;
      expect(col).toMatchObject({ statusKeys: [], totalCount: 0, cards: [], cursor: null });
      // one count per MAPPED column; none for the unmapped one
      const mapped = board.columns.filter((c) => c.statusKeys.length > 0).length;
      const columnCounts = count.mock.calls.filter(
        ([, , opts]) => (opts as { statuses: string[] }).statuses.length > 0,
      );
      expect(
        count.mock.calls.every(
          ([, , opts]) => (opts as { statuses: string[] }).statuses.length > 0,
        ),
      ).toBe(true);
      expect(columnCounts).toHaveLength(mapped);
      count.mockRestore();
    }
  });

  it('a scrum board with no active sprint is empty and uncounted, grouped or flat', async () => {
    const fx = await makeFixture('swl-nosprint@example.com');
    await card(fx, 'A');
    await adminDb.board.updateMany({ where: { projectId: fx.projectId }, data: { type: 'scrum' } });

    for (const groupBy of [BoardSwimlaneGroupBy.assignee, BoardSwimlaneGroupBy.none]) {
      await setGroupBy(fx, groupBy);
      const count = vi.spyOn(workItemRepository, 'countProjectIssues');
      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      expect(board.sprint).toBeNull();
      expect(board.columns.length).toBeGreaterThan(0);
      for (const col of board.columns) {
        expect(col).toMatchObject({ cards: [], cursor: null, totalCount: 0 });
      }
      expect(board.planHolds).toEqual({});
      expect(count).not.toHaveBeenCalled();
      count.mockRestore();
    }
  });

  it('lane aggregates + epic-ancestor lookup short-circuit empty input without a query', async () => {
    // A board with no mapped statuses (and a load-more with no ids) never hits
    // the DB — the empty-input guards return [] (mirrors the
    // findBlockerStatesForItems([]) short-circuit).
    // Bound to a REAL workspace (MOTIR-2830) even though the ids are fake: these
    // assert a SHORT-CIRCUIT, and an unbound read returns [] as well, so without
    // a binding each one would pass for the wrong reason.
    const fx = await makeFixture('swl-shortcircuit@example.com');
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.aggregateBoardLanesByAssignee('p', 'w', [], undefined, undefined, tx),
      ),
    ).toEqual([]);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.aggregateBoardLanesByPriority('p', 'w', [], undefined, undefined, tx),
      ),
    ).toEqual([]);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.aggregateBoardLanesByEpic('p', 'w', [], undefined, undefined, tx),
      ),
    ).toEqual([]);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.findEpicAncestors([], 'w', tx),
      ),
    ).toEqual([]);
  });

  it('is workspace-scoped: epic ancestry never crosses tenants', async () => {
    const a = await makeFixture('swl-tenant-a@example.com');
    const epic = await card(a, 'A Epic', { kind: 'epic' });
    await card(a, 'A Task', { kind: 'task', parentId: epic });
    // A second tenant with an epic of its own must not leak into A's lanes.
    const b = await makeFixture('swl-tenant-b@example.com');
    const otherEpic = await card(b, 'B Epic', { kind: 'epic' });
    await card(b, 'B Task', { kind: 'task', parentId: otherEpic });
    await setGroupBy(a, BoardSwimlaneGroupBy.epic);

    const board = await boardsService.getBoard(a.projectId, a.ctx);
    expectMetaOnly(board);
    expect(board.swimlanes.find((l) => l.key === epic)!.count).toBe(2);
    expect(board.swimlanes.some((l) => l.key === otherEpic)).toBe(false);
  });
});
