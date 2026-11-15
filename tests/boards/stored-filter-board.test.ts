import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import {
  FilterTooLargeError,
  FilterValidationError,
  UnknownFilterOperatorError,
} from '@/lib/filters/errors';
import { FILTER_ROW_CAP, type FilterAst, type FilterEnvelope } from '@/lib/filters/ast';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// The story-level INTEGRATION gate for a board's STORED filter (Story
// MOTIR-10560 · Subtask MOTIR-11336). The write subtask (MOTIR-11331) and the
// read subtask (MOTIR-11332) each test their own half; this file drives the
// seam THROUGH: every stored filter here is written by the shipped write path
// (`boardsService.createBoard` with a `filter`, or `boardsService.setBoardFilter`,
// both behind `assertBoardConfigAdmin`) and read back by the shipped read path
// (`boardsService.getBoard` / `getColumnPage`, which run `loadBoardFrame`). It
// never writes `Board.filter` itself.
//
// Fixture rule: every narrowing case seeds cards that differ on the STORED axis
// and on the TOOLBAR axis, so "stored only", "toolbar only", "both" and
// "neither" are four different card sets, and the assertions name the exact
// cards. A fixture every card of which matched the stored filter could not tell
// an applied stored filter from an ignored one.
//
// Real Postgres (no mocks), per the convention; `createTestProject` seeds the
// default kanban board (one column per workflow status).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  /** The workspace OWNER: holds `board:configure`. */
  admin: ServiceContext;
  /** A plain workspace member: reads boards, does not configure them. */
  member: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  defaultBoardId: string;
}

let seq = 0;

async function makeFixture(): Promise<Fixture> {
  const n = seq++;
  const owner = await usersService.createUser({
    email: `stored-gate-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Admin',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Stored gate WS ${n}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({
    workspaceId,
    actorUserId: owner.id,
    identifier: `SG${n}`,
  });
  const member = await usersService.createUser({
    email: `stored-gate-member-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Member',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: member.id, workspaceId, workspaceRole: 'member' },
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return {
    admin: { userId: owner.id, workspaceId },
    member: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    defaultBoardId: board.id,
  };
}

/** A second project in the SAME workspace, created by the same admin. */
async function secondProject(fx: Fixture, identifier: string) {
  const project = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.admin.userId,
    identifier,
  });
  return { ...fx, projectId: project.id, projectKey: project.identifier };
}

/** Create a card through the service, then stamp the columns the board groups and
 * filters by (status, priority, assignee, sprint, points, labels). */
async function card(
  fx: Pick<Fixture, 'admin' | 'projectId'>,
  opts: {
    title: string;
    kind?: WorkItemKind;
    status?: string;
    priority?: WorkItemPriority;
    assigneeId?: string | null;
    parentId?: string;
    sprintId?: string | null;
    points?: number | null;
    labelIds?: string[];
  },
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.admin,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status ?? 'todo',
      priority: opts.priority ?? 'medium',
      ...(opts.assigneeId !== undefined ? { assigneeId: opts.assigneeId } : {}),
      ...(opts.sprintId !== undefined ? { sprintId: opts.sprintId } : {}),
      ...(opts.points !== undefined ? { storyPoints: opts.points } : {}),
    },
  });
  for (const labelId of opts.labelIds ?? []) {
    await adminDb.workItemLabel.create({ data: { workItemId: item.id, labelId } });
  }
  return item.id;
}

async function label(fx: Pick<Fixture, 'workspaceId' | 'projectId'>, name: string) {
  const row = await adminDb.label.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name,
      nameLower: name.toLowerCase(),
    },
  });
  return row.id;
}

async function activeSprint(fx: Pick<Fixture, 'workspaceId' | 'projectId'>): Promise<string> {
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

/** Create a board through the shipped write path (admin, `board:configure`). */
async function createBoard(
  fx: Fixture,
  filter: unknown,
  opts: { name?: string; type?: 'kanban' | 'scrum' } = {},
): Promise<string> {
  const created = await boardsService.createBoard(
    fx.projectId,
    {
      name: opts.name ?? 'Stored',
      ...(opts.type ? { type: opts.type } : {}),
      ...(filter !== undefined ? { filter } : {}),
    },
    fx.admin,
  );
  return created.id;
}

/** The stored filter as the database holds it (read only: never written here). */
async function storedColumn(boardId: string): Promise<unknown> {
  const row = await adminDb.board.findUniqueOrThrow({ where: { id: boardId } });
  return row.filter;
}

/** A swimlane group-by is board config the stored filter does not own; stamped
 * directly, as the projection tests do. */
async function groupBy(boardId: string, swimlaneGroupBy: 'priority' | 'assignee' | 'epic') {
  await adminDb.board.update({ where: { id: boardId }, data: { swimlaneGroupBy } });
}

const env = (c: 'and' | 'or', ...f: FilterEnvelope['f']): FilterEnvelope => ({ v: 'v1', c, f });
const ast = (combinator: 'and' | 'or', ...conditions: FilterAst['conditions']): FilterAst => ({
  combinator,
  conditions,
});

const BUGS = env('and', ['kind', 'is_any_of', ['bug']]);
const BUGS_AST: FilterAst['conditions'][number] = {
  field: 'kind',
  operator: 'is_any_of',
  value: ['bug'],
};
const TASKS = env('and', ['kind', 'is_any_of', ['task']]);
const assignedTo = (userId: string) =>
  ast('and', { field: 'assignee', operator: 'is_any_of', value: [userId] });

type Board = Awaited<ReturnType<typeof boardsService.getBoard>>;

/** Every card id on the board, sorted. */
function ids(board: Pick<BoardProjectionDto, 'columns'>): string[] {
  return board.columns.flatMap((c) => c.cards.map((x) => x.id)).sort();
}

function total(board: Pick<BoardProjectionDto, 'columns'>): number {
  return board.columns.reduce((sum, c) => sum + c.totalCount, 0);
}

function col(board: Pick<BoardProjectionDto, 'columns'>, statusKey: string) {
  return board.columns.find((c) => c.statusKeys.includes(statusKey))!;
}

const sorted = (...xs: string[]) => [...xs].sort();

/**
 * A board frame with its board's IDENTITY taken out (board id, name, column
 * ids), so two boards over the same project and columns compare
 * equal when they show the same cards, counts, lanes and sprint points. Column
 * ids key `columnPoints`, so those are re-keyed by column position.
 */
function frameShape(board: Board) {
  const colIndex = new Map(board.columns.map((c, i) => [c.id, i]));
  const { boardId: _boardId, name: _name, columns, sprint, ...rest } = board;
  return {
    ...rest,
    columns: columns.map(({ id: _id, ...c }) => c),
    sprint: sprint && {
      ...sprint,
      columnPoints: Object.fromEntries(
        Object.entries(sprint.columnPoints).map(([id, pts]) => [colIndex.get(id), pts]),
      ),
    },
  };
}

describe('stored filter — kanban round trip (write → read)', () => {
  it('a board created with Kind is Bug shows only bugs; the default board still shows every card', async () => {
    const fx = await makeFixture();
    const bugTodo = await card(fx, { kind: 'bug', title: 'bug todo' });
    const bugWip = await card(fx, { kind: 'bug', title: 'bug wip', status: 'in_progress' });
    const bugDone = await card(fx, { kind: 'bug', title: 'bug done', status: 'done' });
    const taskTodo = await card(fx, { title: 'task todo' });
    const taskWip = await card(fx, { title: 'task wip', status: 'in_progress' });
    const taskDone = await card(fx, { title: 'task done', status: 'done' });

    const boardId = await createBoard(fx, BUGS);
    const board = await boardsService.getBoard(fx.projectId, fx.admin, boardId);

    expect(ids(board)).toEqual(sorted(bugTodo, bugWip, bugDone));
    expect(col(board, 'todo').cards.map((c) => c.id)).toEqual([bugTodo]);
    expect(col(board, 'todo').totalCount).toBe(1);
    expect(col(board, 'in_progress').cards.map((c) => c.id)).toEqual([bugWip]);
    expect(col(board, 'in_progress').totalCount).toBe(1);
    expect(col(board, 'done').cards.map((c) => c.id)).toEqual([bugDone]);
    expect(col(board, 'done').totalCount).toBe(1);
    expect(board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });

    const project = await boardsService.getBoard(fx.projectId, fx.admin, fx.defaultBoardId);
    expect(ids(project)).toEqual(sorted(bugTodo, bugWip, bugDone, taskTodo, taskWip, taskDone));
    expect(project.storedFilter).toBeNull();
  });

  it('stored Kind is Bug AND toolbar Assignee is me: only my bugs, in columns, counts and every lane page', async () => {
    const fx = await makeFixture();
    const me = fx.admin.userId;
    const mine: string[] = [];
    // 12 of my bugs in To Do, so the lane pages (10 per page).
    for (let i = 0; i < 12; i++) {
      mine.push(await card(fx, { kind: 'bug', title: `my bug ${i}`, assigneeId: me }));
    }
    const myWipBug = await card(fx, {
      kind: 'bug',
      title: 'my wip bug',
      status: 'in_progress',
      assigneeId: me,
    });
    // Stored-only (a bug not mine), toolbar-only (my tasks), neither.
    await card(fx, { kind: 'bug', title: 'their bug', assigneeId: fx.member.userId });
    await card(fx, { kind: 'bug', title: 'unassigned bug' });
    await card(fx, { title: 'my task', assigneeId: me });
    await card(fx, { title: 'my wip task', status: 'in_progress', assigneeId: me });
    await card(fx, { title: 'their task', assigneeId: fx.member.userId });

    const boardId = await createBoard(fx, BUGS);
    const toolbar = { ast: assignedTo(me) };
    const board = await boardsService.getBoard(fx.projectId, fx.admin, boardId, toolbar);

    const todo = col(board, 'todo');
    expect(todo.totalCount).toBe(12);
    expect(todo.cards).toHaveLength(10);
    expect(col(board, 'in_progress').cards.map((c) => c.id)).toEqual([myWipBug]);
    expect(col(board, 'in_progress').totalCount).toBe(1);
    expect(col(board, 'done').totalCount).toBe(0);

    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.admin,
      boardId,
      todo.id,
      todo.cursor!,
      toolbar,
    );
    expect(page.totalCount).toBe(12);
    expect(page.cursor).toBeNull();
    expect(sorted(...todo.cards.map((c) => c.id), ...page.cards.map((c) => c.id))).toEqual(
      sorted(...mine),
    );
  });

  it('stored (Bug OR Label mobile) AND toolbar (Priority High OR Assignee me) is exactly the intersection', async () => {
    const fx = await makeFixture();
    const me = fx.admin.userId;
    const mobile = await label(fx, 'mobile');
    // Matches both sides.
    const bugHigh = await card(fx, { kind: 'bug', title: 'bug high', priority: 'high' });
    const mobileMine = await card(fx, { title: 'mobile mine', labelIds: [mobile], assigneeId: me });
    const bugMine = await card(fx, { kind: 'bug', title: 'bug mine', assigneeId: me });
    // Stored only.
    await card(fx, { kind: 'bug', title: 'bug low', priority: 'low' });
    await card(fx, { title: 'mobile low', labelIds: [mobile], priority: 'low' });
    // Toolbar only.
    await card(fx, { title: 'task high', priority: 'high' });
    await card(fx, { title: 'task mine', assigneeId: me });
    // Neither.
    await card(fx, { title: 'task low', priority: 'low' });

    const boardId = await createBoard(
      fx,
      env('or', ['kind', 'is_any_of', ['bug']], ['lbl', 'is_any_of', [mobile]]),
    );
    const toolbar = ast(
      'or',
      { field: 'priority', operator: 'is_any_of', value: ['high'] },
      { field: 'assignee', operator: 'is_any_of', value: [me] },
    );
    const board = await boardsService.getBoard(fx.projectId, fx.admin, boardId, { ast: toolbar });

    expect(ids(board)).toEqual(sorted(bugHigh, mobileMine, bugMine));
    expect(total(board)).toBe(3);
  });

  it('swimlanes are computed over the stored-filtered set, with and without a toolbar filter', async () => {
    const fx = await makeFixture();
    const me = fx.admin.userId;
    const myBugHigh = await card(fx, {
      kind: 'bug',
      title: 'my bug high',
      priority: 'high',
      assigneeId: me,
    });
    const bugHigh = await card(fx, { kind: 'bug', title: 'bug high', priority: 'high' });
    const myBugLow = await card(fx, {
      kind: 'bug',
      title: 'my bug low',
      priority: 'low',
      assigneeId: me,
    });
    // Tasks the stored filter excludes, in lanes of their own.
    await card(fx, { title: 'my task highest', priority: 'highest', assigneeId: me });
    await card(fx, { title: 'task high', priority: 'high' });

    const boardId = await createBoard(fx, BUGS);
    await groupBy(boardId, 'priority');

    const stored = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    expect(stored.swimlanes.map((l) => [l.key, l.count])).toEqual([
      ['high', 2],
      ['low', 1],
    ]);
    expect(ids(stored)).toEqual(sorted(myBugHigh, bugHigh, myBugLow));

    const both = await boardsService.getBoard(fx.projectId, fx.admin, boardId, {
      ast: assignedTo(me),
    });
    expect(both.swimlanes.map((l) => [l.key, l.count])).toEqual([
      ['high', 1],
      ['low', 1],
    ]);
    expect(ids(both)).toEqual(sorted(myBugHigh, myBugLow));
  });
});

describe('stored filter — scrum round trip', () => {
  it('Label is mobile shows only mobile cards of the active sprint and sums only their points', async () => {
    const fx = await makeFixture();
    const sprintId = await activeSprint(fx);
    const mobile = await label(fx, 'mobile');
    const mobileTodo = await card(fx, {
      title: 'mobile todo',
      sprintId,
      points: 3,
      labelIds: [mobile],
    });
    const mobileDone = await card(fx, {
      title: 'mobile done',
      status: 'done',
      sprintId,
      points: 5,
      labelIds: [mobile],
    });
    await card(fx, { title: 'web todo', sprintId, points: 8 });
    await card(fx, { title: 'web done', status: 'done', sprintId, points: 2 });
    await card(fx, { title: 'mobile backlog', points: 13, labelIds: [mobile] });

    const boardId = await createBoard(fx, env('and', ['lbl', 'is_any_of', [mobile]]), {
      type: 'scrum',
    });
    const board = await boardsService.getBoard(fx.projectId, fx.admin, boardId);

    expect(ids(board)).toEqual(sorted(mobileTodo, mobileDone));
    expect(board.sprint!.points).toMatchObject({ committed: 8, completed: 5 });
    expect(board.sprint!.columnPoints[col(board, 'todo').id]).toBe(3);
    expect(board.sprint!.columnPoints[col(board, 'done').id]).toBe(5);
  });
});

describe('stored filter — replace and clear through the settings write', () => {
  it('the next read follows a replace; after a clear the frame equals a board that never had one', async () => {
    const fx = await makeFixture();
    const bug = await card(fx, { kind: 'bug', title: 'bug', priority: 'high' });
    const task = await card(fx, { title: 'task', status: 'in_progress' });
    const story = await card(fx, { kind: 'story', title: 'story', status: 'done' });

    const boardId = await createBoard(fx, BUGS, { name: 'Filtered' });
    const never = await createBoard(fx, undefined, { name: 'Never filtered' });
    await groupBy(boardId, 'priority');
    await groupBy(never, 'priority');

    expect(ids(await boardsService.getBoard(fx.projectId, fx.admin, boardId))).toEqual([bug]);

    await boardsService.setBoardFilter(boardId, TASKS, fx.admin);
    const replaced = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    expect(ids(replaced)).toEqual([task]);
    expect(replaced.storedFilter).toEqual({ envelope: TASKS, staleConditions: [], labels: [] });

    await boardsService.setBoardFilter(boardId, null, fx.admin);
    expect(await storedColumn(boardId)).toBeNull();
    const cleared = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    const neverFrame = await boardsService.getBoard(fx.projectId, fx.admin, never);
    expect(cleared.storedFilter).toBeNull();
    expect(ids(cleared)).toEqual(sorted(bug, task, story));
    expect(frameShape(cleared)).toEqual(frameShape(neverFrame));
  });
});

describe('stored filter — null filter parity', () => {
  it('a kanban board created without a filter reads exactly as the default board, with and without a toolbar filter', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'bug high', priority: 'high' });
    await card(fx, { kind: 'bug', title: 'bug low', priority: 'low', status: 'in_progress' });
    await card(fx, { title: 'task', priority: 'high', status: 'done' });
    await card(fx, { kind: 'story', title: 'story', priority: 'low' });

    const boardId = await createBoard(fx, undefined);
    expect(await storedColumn(boardId)).toBeNull();
    await groupBy(boardId, 'priority');
    await groupBy(fx.defaultBoardId, 'priority');

    for (const filter of [undefined, { ast: ast('and', BUGS_AST) }]) {
      const created = await boardsService.getBoard(fx.projectId, fx.admin, boardId, filter);
      const today = await boardsService.getBoard(fx.projectId, fx.admin, fx.defaultBoardId, filter);
      expect(created.storedFilter).toBeNull();
      expect(today.storedFilter).toBeNull();
      expect(frameShape(created)).toEqual(frameShape(today));
      expect(total(created)).toBe(filter ? 2 : 4);
    }
  });

  it('the scrum board ensureScrumBoard creates reads exactly as a scrum board created without a filter', async () => {
    const fx = await makeFixture();
    const sprintId = await activeSprint(fx);
    await card(fx, { kind: 'bug', title: 'bug', sprintId, points: 3 });
    await card(fx, { title: 'task', sprintId, points: 5, status: 'done' });
    await card(fx, { title: 'backlog task', points: 8 });

    await boardsService.ensureScrumBoard(fx.projectId, fx.admin);
    const ensured = await adminDb.board.findFirstOrThrow({
      where: { projectId: fx.projectId, type: 'scrum' },
    });
    expect(ensured.filter).toBeNull();
    const created = await createBoard(fx, undefined, { type: 'scrum', name: 'Scrum 2' });

    for (const filter of [undefined, { ast: ast('and', BUGS_AST) }]) {
      const a = await boardsService.getBoard(fx.projectId, fx.admin, ensured.id, filter);
      const b = await boardsService.getBoard(fx.projectId, fx.admin, created, filter);
      expect(a.storedFilter).toBeNull();
      expect(frameShape(a)).toEqual(frameShape(b));
      // Sprint points take no toolbar filter (unchanged), so they are the whole sprint.
      expect(a.sprint!.points).toMatchObject({ committed: 8, completed: 5 });
      expect(total(a)).toBe(filter ? 1 : 2);
    }
  });
});

describe('stored filter — write refusals leave Board.filter unchanged', () => {
  it('a member without board:configure can neither create a filtered board nor change a board’s filter', async () => {
    const fx = await makeFixture();
    const boardId = await createBoard(fx, BUGS);
    const before = await adminDb.board.count({ where: { projectId: fx.projectId } });

    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Sneaky', filter: TASKS }, fx.member),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await adminDb.board.count({ where: { projectId: fx.projectId } })).toBe(before);

    await expect(boardsService.setBoardFilter(boardId, TASKS, fx.member)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(boardsService.setBoardFilter(boardId, null, fx.member)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(await storedColumn(boardId)).toEqual(BUGS);
    expect((await boardsService.getBoard(fx.projectId, fx.member, boardId)).storedFilter).toEqual({
      envelope: BUGS,
      staleConditions: [],
      labels: [],
    });
  });

  it('an invalid condition and an over-cap filter are refused with the typed error, on create and on the settings write', async () => {
    const fx = await makeFixture();
    const boardId = await createBoard(fx, BUGS);
    const before = await adminDb.board.count({ where: { projectId: fx.projectId } });

    const invalid = env('and', ['kind', 'gt', 3]);
    const overCap = env(
      'and',
      ...Array.from(
        { length: FILTER_ROW_CAP + 1 },
        () => ['kind', 'is_any_of', ['bug']] as FilterEnvelope['f'][number],
      ),
    );

    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Bad', filter: invalid }, fx.admin),
    ).rejects.toBeInstanceOf(UnknownFilterOperatorError);
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Big', filter: overCap }, fx.admin),
    ).rejects.toBeInstanceOf(FilterTooLargeError);
    expect(await adminDb.board.count({ where: { projectId: fx.projectId } })).toBe(before);

    for (const bad of [invalid, overCap]) {
      const refusal = boardsService.setBoardFilter(boardId, bad, fx.admin);
      await expect(refusal).rejects.toBeInstanceOf(FilterValidationError);
    }
    await expect(boardsService.setBoardFilter(boardId, overCap, fx.admin)).rejects.toMatchObject({
      code: 'FILTER_TOO_LARGE',
    });
    expect(await storedColumn(boardId)).toEqual(BUGS);
  });
});

describe('stored filter — every reader sees the same board', () => {
  it('a teammate who did not create the board, and a Visitor, see exactly the creator’s bugs', async () => {
    const fx = await makeFixture();
    // A Visitor exists only on a cloud build (`isCloud()`).
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
    const bugTodo = await card(fx, { kind: 'bug', title: 'bug todo' });
    const bugDone = await card(fx, { kind: 'bug', title: 'bug done', status: 'done' });
    await card(fx, { title: 'task todo' });
    // A private epic's bug: the creator and the teammate see it, a Visitor does not.
    const privateEpic = await card(fx, { kind: 'epic', title: 'private epic', status: 'done' });
    await adminDb.workItem.update({
      where: { id: privateEpic },
      data: { publicChildrenHidden: true },
    });
    const hiddenBug = await card(fx, { kind: 'bug', title: 'hidden bug', parentId: privateEpic });

    const boardId = await createBoard(fx, BUGS);
    const creator = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    const teammate = await boardsService.getBoard(fx.projectId, fx.member, boardId);
    const visitor: VisitorReadContext = await consentedVisitor(fx.projectKey);
    const visiting = await boardsService.getBoard(fx.projectId, visitor, boardId);

    expect(ids(creator)).toEqual(sorted(bugTodo, bugDone, hiddenBug));
    expect(frameShape(teammate)).toEqual(frameShape(creator));
    expect(ids(visiting)).toEqual(sorted(bugTodo, bugDone));
    expect(total(visiting)).toBe(2);
    expect(visiting.storedFilter).toEqual(creator.storedFilter);
  });
});

describe('stored filter — stale referents, empty results and other projects', () => {
  it('a deleted label is reported stale and matches nothing; a deleted user matches nothing; the board loads', async () => {
    const fx = await makeFixture();
    const gone = await label(fx, 'gone');
    const leaver = await usersService.createUser({
      email: `stored-gate-leaver-${seq++}@example.com`,
      password: 'hunter2hunter2',
      name: 'Leaver',
    });
    const bug = await card(fx, { kind: 'bug', title: 'plain bug' });
    await card(fx, { title: 'labelled task', labelIds: [gone] });
    await card(fx, { title: 'leaver task', assigneeId: leaver.id });

    const boardId = await createBoard(
      fx,
      env(
        'or',
        ['kind', 'is_any_of', ['bug']],
        ['lbl', 'is_any_of', [gone]],
        ['assignee', 'is_any_of', [leaver.id]],
      ),
    );
    const before = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    expect(total(before)).toBe(3);
    expect(before.storedFilter!.staleConditions).toEqual([]);

    await adminDb.label.delete({ where: { id: gone } });
    await adminDb.user.delete({ where: { id: leaver.id } });

    const after = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    expect(ids(after)).toEqual([bug]);
    // The resolver stale-checks labels (and components, folders, custom fields);
    // a user id that matches no one simply matches nothing (the 2.5.4 rule).
    expect(after.storedFilter!.staleConditions).toEqual([
      { index: 1, field: 'lbl', reason: 'unknown-value' },
    ]);
  });

  it('a stored filter that matches no card returns the filtered-empty frame', async () => {
    const fx = await makeFixture();
    await card(fx, { title: 'task todo' });
    await card(fx, { title: 'task done', status: 'done' });

    const boardId = await createBoard(fx, BUGS);
    const board = await boardsService.getBoard(fx.projectId, fx.admin, boardId);
    expect(board.columns.length).toBeGreaterThan(0);
    expect(board.columns.every((c) => c.cards.length === 0 && c.totalCount === 0)).toBe(true);
    expect(board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });
  });

  it('a stored filter naming another project’s referents shows none of that project’s cards', async () => {
    const fx = await makeFixture();
    const other = await secondProject(fx, `SGB${seq++}`);
    const sprintB = await activeSprint(other);
    const labelB = await label(other, 'mobile');
    const epicB = await card(other, { kind: 'epic', title: 'B epic', status: 'done' });
    await card(other, { kind: 'bug', title: 'B bug', labelIds: [labelB], sprintId: sprintB });
    await card(other, { title: 'B child', parentId: epicB, labelIds: [labelB], points: 5 });
    await card(other, { title: 'B sprint task', sprintId: sprintB, points: 3 });

    // Project A: an active sprint of its own, and one bug in it.
    const sprintA = await activeSprint(fx);
    const bugA = await card(fx, { kind: 'bug', title: 'A bug', sprintId: sprintA, points: 2 });
    await card(fx, { title: 'A task', sprintId: sprintA, points: 1 });

    // The grammar has no epic field, so B's epic is named by what reaches it:
    // B's label (carried by B's epic child) and B's sprint.
    const stored = env(
      'or',
      ['kind', 'is_any_of', ['bug']],
      ['lbl', 'is_any_of', [labelB]],
      ['sprint', 'is_any_of', [sprintB]],
    );
    const kanbanId = await createBoard(fx, stored);
    await groupBy(kanbanId, 'epic');
    const scrumId = await createBoard(fx, stored, { type: 'scrum', name: 'A scrum' });

    const kanban = await boardsService.getBoard(fx.projectId, fx.admin, kanbanId);
    expect(ids(kanban)).toEqual([bugA]);
    expect(total(kanban)).toBe(1);
    expect(kanban.swimlanes.reduce((sum, l) => sum + l.count, 0)).toBe(1);
    expect(kanban.swimlanes.some((l) => l.key === epicB)).toBe(false);
    // B's label is not a label of A: the condition is stale in A.
    expect(kanban.storedFilter!.staleConditions).toEqual([
      { index: 1, field: 'lbl', reason: 'unknown-value' },
    ]);

    const scrum = await boardsService.getBoard(fx.projectId, fx.admin, scrumId);
    expect(ids(scrum)).toEqual([bugA]);
    expect(scrum.sprint!.points).toMatchObject({ committed: 2 });
  });
});
