import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE, resolveBoardLane } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRepository, type BoardLanePredicate } from '@/lib/repositories/workItemRepository';
import { cursorAfter } from '@/lib/boards/columnCursor';
import { keyForAppend } from '@/lib/workItems/positioning';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { BoardCellPageDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { FilterEnvelope } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  BoardSwimlaneGroupBy,
  WorkItemKind,
  WorkItemPriority,
} from '@/generated/prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// The board CELL reads (Story MOTIR-11328 · Subtask MOTIR-11444):
// `boardsService.getCellPage` — one (lane × column) cell's page and total — and
// `getLanePage` — one lane's first page in every column. Real Postgres, the real
// service → repository → Prisma chain, nothing mocked (the posture of
// `board-routes.test.ts`, minus its session mock: these drive the service). One
// `vi.spyOn` OBSERVES `findEpicAncestors` without replacing it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  identifier: string;
}

let seq = 0;

async function makeFixture(): Promise<Fixture> {
  const n = seq++;
  const user = await usersService.createUser({
    email: `cell-page-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Cell WS ${n}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    identifier: `CP${n}`,
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return {
    ctx: { userId: user.id, workspaceId },
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    boardId: board.id,
    identifier: project.identifier,
  };
}

async function groupBy(fx: Fixture, value: BoardSwimlaneGroupBy): Promise<void> {
  await adminDb.board.update({ where: { id: fx.boardId }, data: { swimlaneGroupBy: value } });
}

async function person(name: string): Promise<string> {
  const u = await usersService.createUser({
    email: `${name.toLowerCase()}-${seq++}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  return u.id;
}

/** One card through the service (so hierarchy triggers run), then its fields. */
async function card(
  fx: Fixture,
  opts: {
    title: string;
    kind?: WorkItemKind;
    status?: string;
    parentId?: string;
    assigneeId?: string | null;
    priority?: WorkItemPriority;
    sprintId?: string;
  },
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status ?? 'todo',
      ...(opts.assigneeId !== undefined ? { assigneeId: opts.assigneeId } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.sprintId ? { sprintId: opts.sprintId } : {}),
    },
  });
  return item.id;
}

let bulkKey = 5000;
let bulkPosition: string | null = null;

/** `n` top-level task cards in one insert, ranked in insertion order. */
async function bulk(
  fx: Fixture,
  n: number,
  data: { status?: string; assigneeId?: string | null; priority?: WorkItemPriority } = {},
): Promise<void> {
  await adminDb.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const key = bulkKey++;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${fx.identifier}-${key}`,
        title: `Bulk ${key} ${i}`,
        status: data.status ?? 'todo',
        reporterId: fx.ctx.userId,
        assigneeId: data.assigneeId ?? null,
        priority: data.priority ?? 'medium',
        position: (bulkPosition = keyForAppend(bulkPosition)),
      };
    }),
  });
}

function column(board: BoardProjectionDto, statusKey: string) {
  return board.columns.find((c) => c.statusKeys[0] === statusKey)!;
}

const cell = (
  fx: Fixture,
  columnId: string,
  laneKey: string,
  cursor?: string,
  filter?: Parameters<typeof boardsService.getCellPage>[6],
) => boardsService.getCellPage(fx.projectId, fx.ctx, fx.boardId, columnId, laneKey, cursor, filter);

/** Every cell of a board: one lane page per lane the projection reports. */
async function allCells(fx: Fixture, board: BoardProjectionDto) {
  const pages = await Promise.all(
    board.swimlanes.map((l) => boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, l.key)),
  );
  return pages.flatMap((p) => p.cells);
}

/** A lane's cell totals sum to its header; a column's sum to its total. */
async function expectArithmetic(fx: Fixture): Promise<void> {
  const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
  const cells = await allCells(fx, board);
  for (const lane of board.swimlanes) {
    const sum = cells.filter((c) => c.laneKey === lane.key).reduce((s, c) => s + c.totalCount, 0);
    expect(sum, `lane ${lane.label}`).toBe(lane.count);
  }
  for (const col of board.columns) {
    const sum = cells.filter((c) => c.columnId === col.id).reduce((s, c) => s + c.totalCount, 0);
    expect(sum, `column ${col.name}`).toBe(col.totalCount);
  }
}

describe('getCellPage — the lane predicate per dimension', () => {
  it('assignee: pages one person’s cards in one column, 10 at a time, with that cell’s total', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    const kenji = await person('Kenji');
    await bulk(fx, 40, { assigneeId: ana });
    await bulk(fx, 12, { assigneeId: kenji });
    await bulk(fx, 3, { assigneeId: ana, status: 'in_progress' });
    await bulk(fx, 4, { assigneeId: null });
    await groupBy(fx, 'assignee');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');

    // The column's own first page is ten cards — Kenji's may not be among them.
    expect(todo.totalCount).toBe(56);

    const first = await cell(fx, todo.id, kenji);
    expect(first.columnId).toBe(todo.id);
    expect(first.laneKey).toBe(kenji);
    expect(first.totalCount).toBe(12);
    expect(first.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(first.cursor).not.toBeNull();
    expect(first.cards.every((c) => c.assigneeId === kenji && c.swimlaneKey === kenji)).toBe(true);

    const second = await cell(fx, todo.id, kenji, first.cursor!);
    expect(second.cards).toHaveLength(2);
    expect(second.cursor).toBeNull();
    expect(second.totalCount).toBe(12);
    const ids = [...first.cards, ...second.cards].map((c) => c.id);
    expect(new Set(ids).size).toBe(12); // the two pages never overlap
    // In the column's own order (rank on an open column).
    const ranks = [...first.cards, ...second.cards].map((c) => c.position);
    expect(ranks).toEqual([...ranks].sort());

    const unassigned = await cell(fx, todo.id, BOARD_SWIMLANE_NO_VALUE);
    expect(unassigned.totalCount).toBe(4);
    expect(unassigned.cursor).toBeNull();
    expect(unassigned.cards.every((c) => c.assigneeId === null)).toBe(true);
    expect(unassigned.cards.every((c) => c.swimlaneKey === BOARD_SWIMLANE_NO_VALUE)).toBe(true);

    const anaWip = await cell(fx, column(board, 'in_progress').id, ana);
    expect(anaWip.totalCount).toBe(3);

    // A key the dimension can denote, holding nothing: an empty cell, not an error.
    const stranger = await cell(fx, todo.id, 'no-such-person');
    expect(stranger).toEqual({
      columnId: todo.id,
      laneKey: 'no-such-person',
      cards: [],
      totalCount: 0,
      cursor: null,
      planHolds: {},
    });

    await expectArithmetic(fx);
  });

  it('priority: the card’s priority; the catch-all and a non-priority are refused', async () => {
    const fx = await makeFixture();
    await bulk(fx, 11, { priority: 'high' });
    await bulk(fx, 2, { priority: 'low', status: 'done' });
    await bulk(fx, 5, { priority: 'medium' });
    await groupBy(fx, 'priority');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');

    const high = await cell(fx, todo.id, 'high');
    expect(high.totalCount).toBe(11);
    expect(high.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(high.cards.every((c) => c.priority === 'high' && c.swimlaneKey === 'high')).toBe(true);
    expect((await cell(fx, column(board, 'done').id, 'low')).totalCount).toBe(2);
    expect((await cell(fx, todo.id, 'lowest')).totalCount).toBe(0);

    await expect(cell(fx, todo.id, BOARD_SWIMLANE_NO_VALUE)).rejects.toMatchObject({
      code: 'INVALID_BOARD_LANE',
      laneKey: BOARD_SWIMLANE_NO_VALUE,
      groupBy: 'priority',
    });
    await expect(cell(fx, todo.id, 'urgent')).rejects.toMatchObject({
      code: 'INVALID_BOARD_LANE',
    });

    await expectArithmetic(fx);
  });

  it('epic: the ancestor epic two levels up, the epic itself, an archived epic, and the exact complement', async () => {
    const fx = await makeFixture();
    const billing = await card(fx, { title: 'Billing', kind: 'epic' });
    const story = await card(fx, { title: 'Invoices', kind: 'story', parentId: billing });
    const deep = await card(fx, { title: 'PDF export', kind: 'task', parentId: story });
    // An archived epic keeps its lane: the climb filters no parent's archivedAt.
    const archived = await card(fx, { title: 'Legacy', kind: 'epic' });
    const underArchived = await card(fx, { title: 'Old task', kind: 'task', parentId: archived });
    await adminDb.workItem.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    const orphan = await card(fx, { title: 'Loose task' });
    const orphanStory = await card(fx, { title: 'Loose story', kind: 'story' });
    const orphanChild = await card(fx, { title: 'Loose child', parentId: orphanStory });
    await groupBy(fx, 'epic');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');
    const idsOf = (page: BoardCellPageDto) => page.cards.map((c) => c.id).sort();

    expect(idsOf(await cell(fx, todo.id, billing))).toEqual([billing, story, deep].sort());

    const legacy = await cell(fx, todo.id, archived);
    expect(idsOf(legacy)).toEqual([underArchived]);
    // …exactly as the lane header counts it.
    expect(board.swimlanes.find((l) => l.key === archived)?.count).toBe(1);

    const none = await cell(fx, todo.id, BOARD_SWIMLANE_NO_VALUE);
    expect(idsOf(none)).toEqual([orphan, orphanStory, orphanChild].sort());
    expect(none.cards.every((c) => c.swimlaneKey === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
    expect(board.swimlanes.find((l) => l.key === BOARD_SWIMLANE_NO_VALUE)?.count).toBe(3);

    // A key left over from a deleted epic is an empty cell.
    expect((await cell(fx, todo.id, 'gone-epic')).totalCount).toBe(0);

    await expectArithmetic(fx);
  });

  it('is the card the column page returns, field for field, stamped without the epic climb', async () => {
    const fx = await makeFixture();
    const epic = await card(fx, { title: 'Epic', kind: 'epic' });
    const task = await card(fx, { title: 'Task', parentId: epic });
    await groupBy(fx, 'epic');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');
    const fromColumn = todo.cards.find((c) => c.id === task)!;

    const spy = vi.spyOn(workItemRepository, 'findEpicAncestors');
    onTestFinished(() => spy.mockRestore());
    const page = await cell(fx, todo.id, epic);
    const lane = await boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, epic);
    expect(spy).not.toHaveBeenCalled();

    expect(page.cards.find((c) => c.id === task)).toEqual(fromColumn);
    expect(
      lane.cells.find((c) => c.columnId === todo.id)!.cards.find((c) => c.id === task),
    ).toEqual(fromColumn);
  });
});

describe('getCellPage — paging bounds and the cursor', () => {
  it('asks for one row past the page: exactly 10 leaves no cursor, 11 leaves one', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await bulk(fx, BOARD_PAGE_SIZE, { assigneeId: ana });
    await groupBy(fx, 'assignee');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');

    const spy = vi.spyOn(workItemRepository, 'findColumnCards');
    onTestFinished(() => spy.mockRestore());
    const exact = await cell(fx, todo.id, ana);
    expect(exact.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(exact.cursor).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![4]).toMatchObject({
      limit: BOARD_PAGE_SIZE + 1,
      lane: { kind: 'assignee', assigneeId: ana },
    });

    await bulk(fx, 1, { assigneeId: ana });
    const over = await cell(fx, todo.id, ana);
    expect(over.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(over.cursor).not.toBeNull();
    expect(over.totalCount).toBe(BOARD_PAGE_SIZE + 1);
  });

  it('pages a done-category column most-recent-first', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await bulk(fx, 13, { assigneeId: ana, status: 'done' });
    const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    for (const [i, r] of rows.entries()) {
      await adminDb.workItem.update({
        where: { id: r.id },
        data: { updatedAt: new Date(Date.UTC(2026, 0, 1 + i)) },
      });
    }
    await groupBy(fx, 'assignee');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const done = column(board, 'done');

    const first = await cell(fx, done.id, ana);
    const second = await cell(fx, done.id, ana, first.cursor!);
    const stampById = new Map(
      (await adminDb.workItem.findMany({ where: { projectId: fx.projectId } })).map((r) => [
        r.id,
        r.updatedAt.getTime(),
      ]),
    );
    const stamps = [...first.cards, ...second.cards].map((c) => stampById.get(c.id)!);
    expect(stamps).toHaveLength(13);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});

describe('getCellPage — the set it reads over', () => {
  const BUGS: FilterEnvelope = { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['bug']]] };

  it('honours the stored filter, the toolbar filter and the sprint scope', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await card(fx, { title: 'Bug one', kind: 'bug', assigneeId: ana, priority: 'high' });
    await card(fx, { title: 'Bug two', kind: 'bug', assigneeId: ana });
    await card(fx, { title: 'Task one', assigneeId: ana, priority: 'high' });
    await groupBy(fx, 'assignee');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');

    expect((await cell(fx, todo.id, ana)).totalCount).toBe(3);

    // The board's stored filter narrows the cell…
    await adminDb.board.update({ where: { id: fx.boardId }, data: { filter: BUGS as never } });
    const stored = await cell(fx, todo.id, ana);
    expect(stored.totalCount).toBe(2);
    expect(stored.cards.map((c) => c.title).sort()).toEqual(['Bug one', 'Bug two']);

    // …and the toolbar filter ANDs beside it.
    const both = await cell(fx, todo.id, ana, undefined, {
      ast: {
        combinator: 'and',
        conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
      },
    });
    expect(both.totalCount).toBe(1);
    expect(both.cards.map((c) => c.title)).toEqual(['Bug one']);

    // A scrum board reads its active sprint only.
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { filter: null as never, type: 'scrum' },
    });
    const empty = await cell(fx, todo.id, ana);
    expect(empty).toMatchObject({ cards: [], totalCount: 0, cursor: null });
    const noSprintLane = await boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, ana);
    expect(noSprintLane.cells).toHaveLength(board.columns.length);
    expect(noSprintLane.cells.every((c) => c.totalCount === 0 && c.cards.length === 0)).toBe(true);

    const sprint = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Sprint 1',
        state: 'active',
        sequence: 1,
      },
    });
    await card(fx, { title: 'In sprint', assigneeId: ana, sprintId: sprint.id });
    const scoped = await cell(fx, todo.id, ana);
    expect(scoped.totalCount).toBe(1);
    expect(scoped.cards.map((c) => c.title)).toEqual(['In sprint']);
    await expectArithmetic(fx);
  });

  it('withholds a private epic’s descendants from a Visitor', async () => {
    const fx = await makeFixture();
    const previousCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
    onTestFinished(() => {
      if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previousCloud;
    });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    const privateEpic = await card(fx, { title: 'Private', kind: 'epic', status: 'done' });
    await adminDb.workItem.update({
      where: { id: privateEpic },
      data: { publicChildrenHidden: true },
    });
    await card(fx, { title: 'Hidden', parentId: privateEpic, priority: 'high' });
    await card(fx, { title: 'Shown', priority: 'high' });
    await groupBy(fx, 'priority');
    const visitor = await consentedVisitor(fx.projectKey);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');

    expect((await cell(fx, todo.id, 'high')).totalCount).toBe(2);
    const seen = await boardsService.getCellPage(
      fx.projectId,
      visitor,
      fx.boardId,
      todo.id,
      'high',
    );
    expect(seen.totalCount).toBe(1);
    expect(seen.cards.map((c) => c.title)).toEqual(['Shown']);
  });
});

describe('getCellPage — gates and refusals', () => {
  it('refuses as getColumnPage does, and refuses a lane the group-by cannot hold', async () => {
    const fx = await makeFixture();
    const other = await makeFixture();
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
    const todo = column(board, 'todo');
    const done = column(board, 'done');

    // A flat board has no lanes at all.
    await expect(cell(fx, todo.id, BOARD_SWIMLANE_NO_VALUE)).rejects.toMatchObject({
      code: 'INVALID_BOARD_LANE',
      groupBy: 'none',
    });
    await expect(
      boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, 'anything'),
    ).rejects.toMatchObject({ code: 'INVALID_BOARD_LANE' });

    await groupBy(fx, 'assignee');
    await expect(
      boardsService.getCellPage(fx.projectId, fx.ctx, other.boardId, todo.id, 'x'),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
    await expect(
      boardsService.getLanePage(fx.projectId, fx.ctx, other.boardId, 'x'),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
    const foreignColumn = await adminDb.boardColumn.findFirstOrThrow({
      where: { boardId: other.boardId },
    });
    await expect(cell(fx, foreignColumn.id, 'x')).rejects.toMatchObject({
      code: 'BOARD_COLUMN_NOT_FOUND',
    });
    await expect(cell(fx, todo.id, 'x', 'not-a-cursor')).rejects.toMatchObject({
      code: 'INVALID_BOARD_CURSOR',
    });
    // A cursor minted for the other order (recent → an open column) is refused.
    const recent = cursorAfter('recent', { position: 'a0', key: 1, updatedAt: new Date() });
    await expect(cell(fx, todo.id, 'x', recent)).rejects.toMatchObject({
      code: 'INVALID_BOARD_CURSOR',
    });
    expect(
      (await cell(fx, done.id, 'x', recent)).cursor, // …and accepted by a done column
    ).toBeNull();
  });

  it('answers an empty cell for a column that maps no live status, without reading cards', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await bulk(fx, 2, { assigneeId: ana });
    await groupBy(fx, 'assignee');
    const unmapped = await adminDb.boardColumn.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: fx.boardId,
        name: 'Parked',
        position: 'zzzz',
      },
    });
    const count = vi.spyOn(workItemRepository, 'countProjectIssues');
    onTestFinished(() => count.mockRestore());
    const page = await cell(fx, unmapped.id, ana);
    expect(page).toMatchObject({ cards: [], totalCount: 0, cursor: null });
    expect(count).not.toHaveBeenCalled();
  });

  it('resolveBoardLane maps each dimension’s keys and refuses what it cannot hold', () => {
    expect(resolveBoardLane('assignee', 'u1')).toEqual({ kind: 'assignee', assigneeId: 'u1' });
    expect(resolveBoardLane('assignee', BOARD_SWIMLANE_NO_VALUE)).toEqual({
      kind: 'assignee',
      assigneeId: null,
    });
    expect(resolveBoardLane('epic', 'e1')).toEqual({ kind: 'epic', epicId: 'e1' });
    expect(resolveBoardLane('epic', BOARD_SWIMLANE_NO_VALUE)).toEqual({
      kind: 'epic',
      epicId: null,
    });
    expect(resolveBoardLane('priority', 'highest')).toEqual({
      kind: 'priority',
      priority: 'highest',
    });
    expect(() => resolveBoardLane('priority', BOARD_SWIMLANE_NO_VALUE)).toThrow(
      /not a lane of a board grouped by priority/,
    );
    expect(() => resolveBoardLane('none', 'u1')).toThrow(/grouped by none/);
  });
});

describe('getLanePage — one lane across every column', () => {
  it('answers one first page per column, decorated once, sharing one planHolds map', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await bulk(fx, 14, { assigneeId: ana });
    await bulk(fx, 3, { assigneeId: ana, status: 'in_progress' });
    await bulk(fx, 6, { assigneeId: null });
    await groupBy(fx, 'assignee');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);

    const readiness = vi.spyOn(workItemsService, 'getReadinessForItems');
    onTestFinished(() => readiness.mockRestore());
    const lane = await boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, ana);
    expect(readiness).toHaveBeenCalledTimes(1);

    expect(lane.laneKey).toBe(ana);
    expect(lane.cells.map((c) => c.columnId)).toEqual(board.columns.map((c) => c.id));
    const todo = lane.cells.find((c) => c.columnId === column(board, 'todo').id)!;
    expect(todo).toMatchObject({ totalCount: 14, laneKey: ana });
    expect(todo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todo.cursor).not.toBeNull();
    const wip = lane.cells.find((c) => c.columnId === column(board, 'in_progress').id)!;
    expect(wip).toMatchObject({ totalCount: 3, cursor: null });
    expect(lane.cells.every((c) => c.cards.length <= BOARD_PAGE_SIZE)).toBe(true);
    expect(lane.cells.every((c) => c.planHolds === lane.cells[0]!.planHolds)).toBe(true);
    expect(lane.cells.flatMap((c) => c.cards).every((c) => c.assigneeId === ana)).toBe(true);

    // The lane page's first cell is the cell page's first page.
    const single = await cell(fx, todo.columnId, ana);
    expect(single.cards.map((c) => c.id)).toEqual(todo.cards.map((c) => c.id));
    expect(single.cursor).toBe(todo.cursor);
  });
});

describe('the lane option leaves lane-less reads alone', () => {
  it('countProjectIssues and findColumnCards without a lane read the whole column', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    await bulk(fx, 3, { assigneeId: ana });
    await bulk(fx, 2, { assigneeId: null });
    const read = (lane?: BoardLanePredicate) =>
      withWorkspaceServiceContext(fx.workspaceId, async (tx) => ({
        count: await workItemRepository.countProjectIssues(
          fx.projectId,
          fx.workspaceId,
          { statuses: ['todo'], ...(lane ? { lane } : {}) },
          tx,
        ),
        cards: await workItemRepository.findColumnCards(
          fx.projectId,
          fx.workspaceId,
          ['todo'],
          'position',
          { limit: 50, ...(lane ? { lane } : {}) },
          tx,
        ),
      }));

    const whole = await read();
    expect(whole.count).toBe(5);
    expect(whole.cards).toHaveLength(5);
    const narrowed = await read({ kind: 'assignee', assigneeId: null });
    expect(narrowed.count).toBe(2);
    // The raw path returns the same rows, in the same order, as the builder path.
    expect(narrowed.cards.map((c) => c.id)).toEqual(
      whole.cards.filter((c) => c.assigneeId === null).map((c) => c.id),
    );
    const byPriority = await read({ kind: 'priority', priority: 'medium' });
    expect(byPriority.count).toBe(5);
  });
});
