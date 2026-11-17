import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { encodeFilterParam, type FilterAst, type FilterEnvelope } from '@/lib/filters/ast';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type {
  BoardCellPageDto,
  BoardColumnPageDto,
  BoardLanePageDto,
  BoardProjectionDto,
} from '@/lib/dto/boards';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// MOTIR-11453 — the story's per-repository integration gate for the grouped
// board's CELL pages (MOTIR-11328), over real Postgres. A grouped board pages
// each (lane × column) cell on its own: the lane route answers a lane's first
// pages, the shipped column route answers a cell's next page when it is given a
// `lane`, and the grouped projection carries column META only. This file asserts
// the seams no unit sees — a cell's set and order against its column, the page
// bound and the keyset walk, the three counts (cell, lane header, column
// header) against each other, the four narrowings, the epic lane's
// nearest-ancestor rule, a statement count that does not grow with the
// project, and the merged read across a move.
//
// The member's reads go through the shipped ROUTE handlers with only
// `getSession` and `getActiveProject` mocked (the `board-routes.test.ts`
// harness): every read and write travels the real service → repository →
// Prisma chain. The Visitor's reads go through the service with
// `consentedVisitor`, because a Visitor's HTTP branch needs a consent cookie a
// request in this harness cannot carry. The reference for "the same narrowed
// set" is the shipped COLUMN page, read by setting the same board's group-by
// back to none — a grouped projection mints no column cursor.
//
// Fixtures: the shipped create path where the shape matters (the epic tree,
// which the kind-parent trigger polices), and bulk `adminDb` rows with valid
// chained fractional positions where only the count matters, as the shipped
// at-scale suites do. Nothing in production code is stubbed.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// Import AFTER the mocks are registered.
const { GET: boardGET } = await import('@/app/api/board/route');
const { POST: movePOST } = await import('@/app/api/board/move/route');
const { GET: pageGET } = await import('@/app/api/board/columns/[columnId]/cards/route');
const { GET: laneGET } = await import('@/app/api/board/lanes/[laneKey]/cells/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
  // A cross-column move emits `work-item/transitioned` post-commit; the test
  // env has no Inngest key.
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  identifier: string;
  boardId: string;
  /** The last bulk-row position and key, so rows chain in insertion order. */
  position: string | null;
  nextKey: number;
}

let seq = 0;

/** A workspace, a project with its seeded default board, and the member session. */
async function makeFixture(identifier = `CPM${seq}`): Promise<Fixture> {
  const n = seq++;
  const email = `cell-owner-${n}@example.com`;
  const owner = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Cell Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Cell WS ${n}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: `Cell Demo ${n}`,
    identifier,
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  session.current = { user: { id: owner.id, email, name: 'Cell Owner' } };
  activeCtx.current = {
    userId: owner.id,
    workspaceId: ws.workspace.id,
    projectId: project.id,
    project,
  };
  return {
    ctx: { userId: owner.id, workspaceId: ws.workspace.id },
    workspaceId: ws.workspace.id,
    projectId: project.id,
    identifier,
    boardId: board.id,
    position: null,
    nextKey: 1000,
  };
}

/** An assignee: a real user row (the assignee FK), no membership needed. */
async function person(name: string): Promise<string> {
  const u = await adminDb.user.create({
    data: { email: `${name.toLowerCase()}-${seq++}@example.com`, name, emailVerified: true },
  });
  return u.id;
}

interface Row {
  status?: string;
  assigneeId?: string | null;
  priority?: WorkItemPriority;
  kind?: WorkItemKind;
  sprintId?: string | null;
  updatedAt?: Date;
  title?: string;
}

/** Bulk rows, in insertion (rank) order; answers their ids in that order. */
async function seed(fx: Fixture, rows: readonly Row[]): Promise<string[]> {
  const data = rows.map((r) => {
    const key = fx.nextKey++;
    fx.position = keyForAppend(fx.position);
    return {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: r.kind ?? ('task' as const),
      key,
      identifier: `${fx.identifier}-${key}`,
      title: r.title ?? `Card ${key}`,
      status: r.status ?? 'todo',
      priority: r.priority ?? ('medium' as const),
      assigneeId: r.assigneeId ?? null,
      sprintId: r.sprintId ?? null,
      reporterId: fx.ctx.userId,
      position: fx.position,
      ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
    };
  });
  const made = await adminDb.workItem.createManyAndReturn({
    data,
    select: { id: true, key: true },
  });
  const byKey = new Map(made.map((m) => [m.key, m.id]));
  return data.map((d) => byKey.get(d.key)!);
}

const many = (n: number, row: Row): Row[] => Array.from({ length: n }, () => ({ ...row }));

async function setBoard(
  fx: Fixture,
  data: {
    swimlaneGroupBy?: 'none' | 'assignee' | 'priority' | 'epic';
    filter?: unknown;
    type?: 'scrum';
  },
): Promise<void> {
  await adminDb.board.update({ where: { id: fx.boardId }, data: data as never });
}

async function activeSprint(fx: Fixture): Promise<string> {
  const now = Date.now();
  const sprint = await adminDb.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Sprint 1',
      state: 'active',
      startDate: new Date(now - 86_400_000),
      endDate: new Date(now + 5 * 86_400_000),
      sequence: 1,
    },
  });
  return sprint.id;
}

const env = (c: 'and' | 'or', ...f: FilterEnvelope['f']): FilterEnvelope => ({ v: 'v1', c, f });
const BUGS = env('and', ['kind', 'is_any_of', ['bug']]);
const HIGH: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
};

// ── the member's doors (route handlers) ─────────────────────────────────────

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return qs.toString();
}

const filterParam = (ast?: FilterAst) => (ast ? encodeFilterParam(ast) : undefined);

async function readBoard(fx: Fixture, ast?: FilterAst): Promise<BoardProjectionDto> {
  return json(
    await boardGET(
      new Request(`${BASE}/api/board?${query({ boardId: fx.boardId, filter: filterParam(ast) })}`),
    ),
  );
}

function lanePage(fx: Fixture, laneKey: string, ast?: FilterAst): Promise<BoardLanePageDto> {
  return laneGET(
    new Request(
      `${BASE}/api/board/lanes/${encodeURIComponent(laneKey)}/cells?${query({
        boardId: fx.boardId,
        filter: filterParam(ast),
      })}`,
    ),
    { params: Promise.resolve({ laneKey }) },
  ).then((r) => json<BoardLanePageDto>(r));
}

function cellPage(
  fx: Fixture,
  columnId: string,
  laneKey: string,
  cursor?: string,
  ast?: FilterAst,
): Promise<BoardCellPageDto> {
  return pageGET(
    new Request(
      `${BASE}/api/board/columns/${columnId}/cards?${query({
        boardId: fx.boardId,
        lane: laneKey,
        cursor,
        filter: filterParam(ast),
      })}`,
    ),
    { params: Promise.resolve({ columnId }) },
  ).then((r) => json<BoardCellPageDto>(r));
}

function columnPage(
  fx: Fixture,
  columnId: string,
  cursor: string,
  ast?: FilterAst,
): Promise<BoardColumnPageDto> {
  return pageGET(
    new Request(
      `${BASE}/api/board/columns/${columnId}/cards?${query({
        boardId: fx.boardId,
        cursor,
        filter: filterParam(ast),
      })}`,
    ),
    { params: Promise.resolve({ columnId }) },
  ).then((r) => json<BoardColumnPageDto>(r));
}

const todoOf = (b: BoardProjectionDto) => b.columns.find((c) => c.statusKeys[0] === 'todo')!;
const columnOf = (b: BoardProjectionDto, status: string) =>
  b.columns.find((c) => c.statusKeys.includes(status))!;

/** Every page of one cell: the lane route's first page, then the cell route. */
async function walkCell(
  fx: Fixture,
  columnId: string,
  laneKey: string,
  ast?: FilterAst,
): Promise<{ pages: BoardCellPageDto[]; ids: string[] }> {
  const lane = await lanePage(fx, laneKey, ast);
  const first = lane.cells.find((c) => c.columnId === columnId)!;
  const pages = [first];
  let cursor = first.cursor;
  while (cursor) {
    const next = await cellPage(fx, columnId, laneKey, cursor, ast);
    pages.push(next);
    cursor = next.cursor;
  }
  return { pages, ids: pages.flatMap((p) => p.cards.map((c) => c.id)) };
}

/** A cell walked on from a cursor: every page after it, in order. */
async function walkFrom(
  fx: Fixture,
  columnId: string,
  laneKey: string,
  cursor: string,
): Promise<string[]> {
  const ids: string[] = [];
  let at: string | null = cursor;
  while (at) {
    const page = await cellPage(fx, columnId, laneKey, at);
    ids.push(...page.cards.map((c) => c.id));
    at = page.cursor;
  }
  return ids;
}

/**
 * The shipped COLUMN walk for the same board read flat: the board's first page,
 * then the column route. Leaves the board's group-by as it found it.
 */
async function walkColumn(
  fx: Fixture,
  status: string,
  groupBy: 'assignee' | 'priority' | 'epic',
  ast?: FilterAst,
): Promise<{ ids: string[]; totalCount: number }> {
  await setBoard(fx, { swimlaneGroupBy: 'none' });
  try {
    const board = await readBoard(fx, ast);
    const col = columnOf(board, status);
    const ids = col.cards.map((c) => c.id);
    let cursor = col.cursor;
    while (cursor) {
      const page = await columnPage(fx, col.id, cursor, ast);
      ids.push(...page.cards.map((c) => c.id));
      cursor = page.cursor;
    }
    return { ids, totalCount: col.totalCount };
  } finally {
    await setBoard(fx, { swimlaneGroupBy: groupBy });
  }
}

/** Every statement the pg driver sends, minus the transaction's own frames
 *  (the `board-paging-at-scale.test.ts` counter, file-local there too). */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([q]) => {
      const text = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? '');
      return !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

function expectNoRepeats(ids: readonly string[]): void {
  expect(new Set(ids).size).toBe(ids.length);
}

// ── the suite ───────────────────────────────────────────────────────────────

describe('the grouped board cell pages over the real datastore (MOTIR-11453)', () => {
  it('reads through the merged doors, not a stand-in', () => {
    // A wrong import of the merged reads fails here rather than every case below
    // passing over `undefined`.
    expect(typeof boardsService.getCellPage).toBe('function');
    expect(typeof boardsService.getLanePage).toBe('function');
    expect(typeof laneGET).toBe('function');
    expect(typeof pageGET).toBe('function');
  });

  it("a column's cells partition the column: every card in exactly one lane, in the column's order", async () => {
    const fx = await makeFixture();
    const [ana, ben, cai] = [await person('Ana'), await person('Ben'), await person('Cai')];
    const who = [ana, ben, cai, null];
    await seed(
      fx,
      Array.from({ length: 34 }, (_, i) => ({ assigneeId: who[i % who.length] ?? null })),
    );
    await seed(fx, many(6, { status: 'in_progress', assigneeId: ana }));
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });

    const board = await readBoard(fx);
    expect(board.swimlanes.map((l) => l.key)).toEqual([ana, ben, cai, BOARD_SWIMLANE_NO_VALUE]);
    const todo = todoOf(board);
    const byLane = new Map<string, string[]>();
    for (const lane of board.swimlanes) {
      const { pages, ids } = await walkCell(fx, todo.id, lane.key);
      byLane.set(lane.key, ids);
      // A cell's cards are its own lane's — the lane key the page is stamped with.
      for (const card of pages.flatMap((p) => p.cards)) {
        expect(card.assigneeId ?? BOARD_SWIMLANE_NO_VALUE).toBe(lane.key);
      }
    }

    const column = await walkColumn(fx, 'todo', 'assignee');
    expect(column.ids).toHaveLength(34);
    expectNoRepeats(column.ids);
    const union = [...byLane.values()].flat();
    expect([...union].sort()).toEqual([...column.ids].sort());
    // Each card in exactly one lane.
    for (const id of column.ids) {
      expect([...byLane.values()].filter((ids) => ids.includes(id))).toHaveLength(1);
    }
    // Inside a lane, the column's own order.
    for (const ids of byLane.values()) {
      const lane = new Set(ids);
      expect(ids).toEqual(column.ids.filter((id) => lane.has(id)));
    }
  });

  it('a cell pages at most BOARD_PAGE_SIZE at a time, never repeats or skips, and reports its full count', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    const cards = await seed(fx, many(25, { assigneeId: ana }));
    await seed(fx, many(4, { assigneeId: null }));
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });

    const todo = todoOf(await readBoard(fx));
    const { pages, ids } = await walkCell(fx, todo.id, ana);
    expect(pages.length).toBe(Math.ceil(25 / BOARD_PAGE_SIZE));
    for (const page of pages) {
      expect(page.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      expect(page.totalCount).toBe(25);
    }
    for (let i = 1; i < pages.length; i++) {
      const prev = new Set(pages[i - 1]!.cards.map((c) => c.id));
      expect(pages[i]!.cards.some((c) => prev.has(c.id))).toBe(false);
    }
    expect(pages.at(-1)!.cursor).toBeNull();
    expectNoRepeats(ids);
    expect(ids).toEqual(cards);
  });

  it('a cell counts its lane in its column, and the cell, lane and column totals reconcile', async () => {
    const fx = await makeFixture();
    const [ana, ben] = [await person('Ana'), await person('Ben')];
    await seed(fx, many(12, { assigneeId: ana }));
    await seed(fx, many(3, { assigneeId: ana, status: 'done' }));
    await seed(fx, many(4, { assigneeId: ben }));
    await seed(fx, many(2, { assigneeId: null, status: 'in_progress' }));
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });

    const grouped = await readBoard(fx);
    const todo = todoOf(grouped);
    const done = columnOf(grouped, 'done');
    const cells = new Map<string, BoardLanePageDto>();
    for (const lane of grouped.swimlanes) cells.set(lane.key, await lanePage(fx, lane.key));
    const cellTotal = (laneKey: string, columnId: string) =>
      cells.get(laneKey)!.cells.find((c) => c.columnId === columnId)!.totalCount;

    // A cell is that lane in that column: not the lane's total, not the column's.
    expect(cellTotal(ana, todo.id)).toBe(12);
    expect(cellTotal(ana, done.id)).toBe(3);
    expect(cellTotal(ben, todo.id)).toBe(4);

    // One lane page is one cell per column of the board.
    for (const page of cells.values()) {
      expect(page.cells.map((c) => c.columnId)).toEqual(grouped.columns.map((c) => c.id));
    }
    // Lane header = Σ its cells over the columns.
    for (const lane of grouped.swimlanes) {
      const sum = cells.get(lane.key)!.cells.reduce((s, c) => s + c.totalCount, 0);
      expect(sum, lane.label).toBe(lane.count);
    }
    // Column header = Σ its cells over the lanes = the same column read flat.
    await setBoard(fx, { swimlaneGroupBy: 'none' });
    const flat = await readBoard(fx);
    for (const col of grouped.columns) {
      const sum = grouped.swimlanes.reduce((s, l) => s + cellTotal(l.key, col.id), 0);
      expect(sum, col.name).toBe(col.totalCount);
      expect(flat.columns.find((c) => c.id === col.id)!.totalCount, col.name).toBe(col.totalCount);
    }
  });

  it('the stored filter, the header filter and the header replacing the stored one read a cell exactly as the column', async () => {
    const fx = await makeFixture();
    const [ana, ben] = [await person('Ana'), await person('Ben')];
    const [bugHighAna, bugLowAna, taskHighAna] = await seed(fx, [
      { kind: 'bug', priority: 'high', assigneeId: ana },
      { kind: 'bug', priority: 'low', assigneeId: ana },
      { kind: 'task', priority: 'high', assigneeId: ana },
    ]);
    const [bugLowBen, taskHighBen] = await seed(fx, [
      { kind: 'bug', priority: 'low', assigneeId: ben },
      { kind: 'task', priority: 'high', assigneeId: ben },
    ]);
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });
    const todo = todoOf(await readBoard(fx));

    const cellIds = async (laneKey: string, ast?: FilterAst) => {
      const { pages, ids } = await walkCell(fx, todo.id, laneKey, ast);
      return { ids: [...ids].sort(), total: pages[0]!.totalCount, cursor: pages.at(-1)!.cursor };
    };
    const sameAsColumn = async (ast?: FilterAst) => {
      const union = [...(await cellIds(ana, ast)).ids, ...(await cellIds(ben, ast)).ids].sort();
      const column = await walkColumn(fx, 'todo', 'assignee', ast);
      expect(union).toEqual([...column.ids].sort());
    };

    // The toolbar filter alone.
    expect((await cellIds(ana, HIGH)).ids).toEqual([bugHighAna, taskHighAna].sort());
    expect((await cellIds(ben, HIGH)).ids).toEqual([taskHighBen]);
    await sameAsColumn(HIGH);

    // The stored filter alone.
    await setBoard(fx, { filter: BUGS });
    expect(await cellIds(ana)).toMatchObject({ ids: [bugHighAna, bugLowAna].sort(), total: 2 });
    expect(await cellIds(ben)).toMatchObject({ ids: [bugLowBen], total: 1 });
    await sameAsColumn();

    // Both present: the header filter REPLACES the stored one (MOTIR-11564), so
    // every high card shows, bug or not — exactly the header filter alone.
    expect(await cellIds(ana, HIGH)).toMatchObject({
      ids: [bugHighAna, taskHighAna].sort(),
      total: 2,
    });
    expect(await cellIds(ben, HIGH)).toMatchObject({ ids: [taskHighBen], total: 1 });
    await sameAsColumn(HIGH);

    // Clearing the header filter restores every stored-filtered bug.
    expect((await cellIds(ana)).ids).toEqual([bugHighAna, bugLowAna].sort());
    expect((await cellIds(ben)).ids).toEqual([bugLowBen]);
  });

  it('an active-sprint scrum board pages no backlog card in any cell, and counts only the sprint', async () => {
    const fx = await makeFixture();
    const [ana, ben] = [await person('Ana'), await person('Ben')];
    const sprint = await activeSprint(fx);
    const inSprint = [
      ...(await seed(fx, many(13, { assigneeId: ana, sprintId: sprint }))),
      ...(await seed(fx, many(2, { assigneeId: ben, sprintId: sprint }))),
      ...(await seed(fx, many(3, { assigneeId: ana, sprintId: sprint, status: 'in_progress' }))),
    ];
    const backlog = [
      ...(await seed(fx, many(6, { assigneeId: ana }))),
      ...(await seed(fx, many(2, { assigneeId: ben, status: 'in_progress' }))),
    ];
    await setBoard(fx, { swimlaneGroupBy: 'assignee', type: 'scrum' });

    const board = await readBoard(fx);
    expect(board.sprint).not.toBeNull();
    const seen: string[] = [];
    for (const lane of board.swimlanes) {
      for (const col of board.columns) {
        const { pages, ids } = await walkCell(fx, col.id, lane.key);
        if (lane.key === ana && col.id === todoOf(board).id) expect(pages.length).toBe(2);
        seen.push(...ids);
      }
    }
    expect(seen.filter((id) => backlog.includes(id))).toEqual([]);
    expect([...seen].sort()).toEqual([...inSprint].sort());
    expect(todoOf(board).totalCount).toBe(15);
    expect(columnOf(board, 'in_progress').totalCount).toBe(3);
  });

  it("a Visitor's cells withhold a private epic's card that the owner's hold, and match the Visitor's column walk", async () => {
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
    const privateEpic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Private epic' },
      fx.ctx,
    );
    const hidden = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Hidden task', parentId: privateEpic.id },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: privateEpic.id },
      data: { publicChildrenHidden: true, status: 'done' },
    });
    await adminDb.workItem.update({ where: { id: hidden.id }, data: { priority: 'high' } });
    const open = await seed(fx, many(11, { priority: 'high' }));
    await seed(fx, many(2, { priority: 'low' }));
    await setBoard(fx, { swimlaneGroupBy: 'priority' });
    const visitor: VisitorReadContext = await consentedVisitor(fx.identifier);

    const board = await boardsService.getBoard(fx.projectId, visitor, fx.boardId);
    const todo = todoOf(board);
    const visitorWalk = async () => {
      const lane = await boardsService.getLanePage(fx.projectId, visitor, fx.boardId, 'high');
      const first = lane.cells.find((c) => c.columnId === todo.id)!;
      const ids = first.cards.map((c) => c.id);
      let cursor = first.cursor;
      while (cursor) {
        const page = await boardsService.getCellPage(
          fx.projectId,
          visitor,
          fx.boardId,
          todo.id,
          'high',
          cursor,
        );
        ids.push(...page.cards.map((c) => c.id));
        cursor = page.cursor;
      }
      return { ids, total: first.totalCount };
    };

    const owner = await walkCell(fx, todo.id, 'high');
    expect(owner.ids).toContain(hidden.id);
    expect(owner.pages[0]!.totalCount).toBe(12);

    const seenByVisitor = await visitorWalk();
    expect(seenByVisitor.ids).not.toContain(hidden.id);
    expect([...seenByVisitor.ids].sort()).toEqual([...open].sort());
    expect(seenByVisitor.total).toBe(11);

    // The Visitor's lane equals the Visitor's own column walk restricted to it.
    await setBoard(fx, { swimlaneGroupBy: 'none' });
    const flat = await boardsService.getBoard(fx.projectId, visitor, fx.boardId);
    const col = todoOf(flat);
    const cards = [...col.cards];
    let cursor = col.cursor;
    while (cursor) {
      const page = await boardsService.getColumnPage(
        fx.projectId,
        visitor,
        fx.boardId,
        col.id,
        cursor,
      );
      cards.push(...page.cards);
      cursor = page.cursor;
    }
    expect(seenByVisitor.ids).toEqual(cards.filter((c) => c.priority === 'high').map((c) => c.id));
  });

  it("the epic lane is a card's nearest epic ancestor; an epic is its own lane; no ancestor is the catch-all", async () => {
    const fx = await makeFixture();
    const create = (kind: WorkItemKind, title: string, parentId?: string) =>
      workItemsService
        .createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx)
        .then((w) => w.id);
    const epic = await create('epic', 'Epic');
    const story = await create('story', 'Story', epic);
    const task = await create('task', 'Task', story);
    const otherEpic = await create('epic', 'Other epic');
    const orphan = await create('task', 'No epic');
    await setBoard(fx, { swimlaneGroupBy: 'epic' });

    const board = await readBoard(fx);
    const todo = todoOf(board);
    const cellOf = async (laneKey: string) => (await walkCell(fx, todo.id, laneKey)).ids;

    // The task two levels down sits in its story's epic — the climb walks up
    // through the story — and the epic card sits in its OWN lane.
    expect((await cellOf(epic)).sort()).toEqual([epic, story, task].sort());
    expect(await cellOf(otherEpic)).toEqual([otherEpic]);
    expect(await cellOf(BOARD_SWIMLANE_NO_VALUE)).toEqual([orphan]);
    // No card is in two lanes.
    const all = [
      ...(await cellOf(epic)),
      ...(await cellOf(otherEpic)),
      ...(await cellOf(BOARD_SWIMLANE_NO_VALUE)),
    ];
    expectNoRepeats(all);
    expect(all).toHaveLength(5);
  });

  it('a lane page is one page per column, and its statement count does not grow with the project', async () => {
    // The same shape at two sizes: two assignees × two statuses, round robin.
    const build = async (identifier: string, total: number) => {
      const fx = await makeFixture(identifier);
      const [ana, ben] = [await person('Ana'), await person('Ben')];
      const statuses = ['todo', 'in_progress'];
      await seed(
        fx,
        Array.from({ length: total }, (_, i) => ({
          assigneeId: i % 2 === 0 ? ana : ben,
          status: statuses[Math.floor(i / 2) % 2],
        })),
      );
      await setBoard(fx, { swimlaneGroupBy: 'assignee' });
      return { fx, ana, board: await readBoard(fx) };
    };
    const measure = async ({ fx, ana, board }: Awaited<ReturnType<typeof build>>) => {
      const todo = todoOf(board);
      const page = await lanePage(fx, ana);
      expect(page.cells.map((c) => c.columnId)).toEqual(board.columns.map((c) => c.id));
      for (const cell of page.cells) expect(cell.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      const cell = page.cells.find((c) => c.columnId === todo.id)!;
      // The lane route's cell is the service's own first page for that cell.
      const direct = await boardsService.getCellPage(
        fx.projectId,
        fx.ctx,
        fx.boardId,
        todo.id,
        ana,
      );
      expect(cell.cards.map((c) => c.id)).toEqual(direct.cards.map((c) => c.id));
      expect(cell.totalCount).toBe(direct.totalCount);
      expect(cell.cursor).toBe(direct.cursor);
      expect(cell.cursor).not.toBeNull();

      const lane = await countQueries(() => lanePage(fx, ana));
      const next = await countQueries(() => cellPage(fx, todo.id, ana, cell.cursor!));
      return { lane, next, cellTotal: cell.totalCount };
    };

    const small = await build('CPS', 60);
    const smallCounts = await measure(small);
    const big = await build('CPB', 3_000);
    const bigCounts = await measure(big);

    expect(smallCounts.cellTotal).toBe(15);
    expect(bigCounts.cellTotal).toBe(750);
    expect(smallCounts.lane).toBeGreaterThan(0);
    expect(smallCounts.next).toBeGreaterThan(0);
    expect(bigCounts.lane).toBe(smallCounts.lane);
    expect(bigCounts.next).toBe(smallCounts.next);
  });

  it('after a card moves between cells, a walk shows each card once and the total follows', async () => {
    const fx = await makeFixture();
    const [ana, ben] = [await person('Ana'), await person('Ben')];
    const anaCards = await seed(fx, many(14, { assigneeId: ana }));
    const [arriving] = await seed(fx, many(3, { assigneeId: ben }));
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });
    const board = await readBoard(fx);
    const todo = todoOf(board);
    const inProgress = columnOf(board, 'in_progress');

    const before = await walkCell(fx, todo.id, ana);
    expect(before.ids).toEqual(anaCards);
    const firstPage = before.pages[0]!;
    const staleCursor = firstPage.cursor!;
    // A card past the cursor leaves the cell (the column axis, through the
    // shipped move route) and a card of Ben's lane arrives (the lane axis).
    const leaving = anaCards[BOARD_PAGE_SIZE + 1]!;
    const moved = await movePOST(
      new Request(`${BASE}/api/board/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          boardId: fx.boardId,
          workItemId: leaving,
          toColumnId: inProgress.id,
        }),
      }),
    );
    expect(moved.status).toBe(200);
    await adminDb.workItem.update({ where: { id: arriving }, data: { assigneeId: ana } });

    // Continuing from the cursor minted before the moves.
    const continued = await walkFrom(fx, todo.id, ana, staleCursor);
    const stitched = [...firstPage.cards.map((c) => c.id), ...continued];
    expectNoRepeats(stitched);
    expect(continued).not.toContain(leaving);

    // A fresh walk from the start.
    const fresh = await walkCell(fx, todo.id, ana);
    expectNoRepeats(fresh.ids);
    expect(fresh.ids.filter((id) => id === arriving)).toHaveLength(1);
    expect(fresh.ids).not.toContain(leaving);
    const movedState = await adminDb.workItem.count({
      where: { projectId: fx.projectId, assigneeId: ana, status: 'todo' },
    });
    expect(movedState).toBe(14);
    for (const page of fresh.pages) expect(page.totalCount).toBe(movedState);
    expect(fresh.ids).toHaveLength(movedState);
  });

  it('a done-category cell walks newest update first, every card once', async () => {
    const fx = await makeFixture();
    const ana = await person('Ana');
    const base = Date.now() - 86_400_000;
    // Inserted oldest-rank-first with SHUFFLED update times, so rank order and
    // recency order disagree and only the recency order can pass.
    const minutes = [7, 2, 12, 0, 9, 4, 11, 1, 6, 10, 3, 8, 5];
    const ids = await seed(
      fx,
      minutes.map((m) => ({
        assigneeId: ana,
        status: 'done',
        updatedAt: new Date(base + m * 60_000),
      })),
    );
    await seed(fx, many(2, { assigneeId: null, status: 'done' }));
    await setBoard(fx, { swimlaneGroupBy: 'assignee' });

    const done = columnOf(await readBoard(fx), 'done');
    const { pages, ids: walked } = await walkCell(fx, done.id, ana);
    expect(pages.length).toBe(2);
    const newestFirst = ids
      .map((id, i) => ({ id, m: minutes[i]! }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.id);
    expect(walked).toEqual(newestFirst);
    expectNoRepeats(walked);
  });
});
