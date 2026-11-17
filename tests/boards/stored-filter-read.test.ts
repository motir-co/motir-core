import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { resolveStoredBoardFilter } from '@/lib/services/boardStoredFilter';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { FilterAst, FilterEnvelope } from '@/lib/filters/ast';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// The board READ of a board's STORED filter (Story MOTIR-10560 · Subtask
// MOTIR-11332). `board.filter` is a second predicate beside the toolbar's,
// compiled on its own and ANDed into every card read: each column's cards and
// `totalCount`, every lane page, the swimlane aggregates and the derived "No
// epic" total, the scrum sprint points, and the public project page's board
// preview. A stale condition matches nothing; an unreadable stored envelope
// narrows the board to nothing. Real Postgres (no mocks), per the convention;
// `createTestProject` seeds the default kanban board (one column per status).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  memberCtx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

let seq = 0;

async function makeFixture(): Promise<Fixture> {
  const n = seq++;
  const user = await usersService.createUser({
    email: `stored-read-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Stored WS ${n}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    identifier: `SR${n}`,
  });
  const member = await usersService.createUser({
    email: `stored-read-member-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Member',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: member.id, workspaceId, workspaceRole: 'member' },
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return {
    ctx: { userId: user.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    boardId: board.id,
  };
}

async function card(
  fx: Fixture,
  opts: {
    kind?: WorkItemKind;
    status?: string;
    title: string;
    priority?: WorkItemPriority;
    parentId?: string | null;
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
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status ?? 'todo',
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.sprintId !== undefined ? { sprintId: opts.sprintId } : {}),
      ...(opts.points !== undefined ? { storyPoints: opts.points } : {}),
    },
  });
  for (const labelId of opts.labelIds ?? []) {
    await adminDb.workItemLabel.create({ data: { workItemId: item.id, labelId } });
  }
  return item.id;
}

async function label(fx: Fixture, name: string): Promise<string> {
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

async function store(fx: Fixture, filter: unknown): Promise<void> {
  await adminDb.board.update({
    where: { id: fx.boardId },
    data: { filter: filter as never },
  });
}

async function activeSprint(fx: Fixture): Promise<string> {
  await adminDb.board.update({ where: { id: fx.boardId }, data: { type: 'scrum' } });
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
const ast = (combinator: 'and' | 'or', ...conditions: FilterAst['conditions']): FilterAst => ({
  combinator,
  conditions,
});

const BUGS = env('and', ['kind', 'is_any_of', ['bug']]);

/** A board's columns as both the board read and the public preview shape them. */
type Columns = {
  columns: Array<{ statusKeys: string[]; cards: Array<{ title: string }>; totalCount: number }>;
};

function col(board: Pick<BoardProjectionDto, 'columns'>, statusKey: string) {
  return board.columns.find((c) => c.statusKeys.includes(statusKey))!;
}

function titles(board: Columns): string[] {
  return board.columns.flatMap((c) => c.cards.map((x) => x.title)).sort();
}

/**
 * Every card title on a GROUPED board, sorted. A grouped projection's columns
 * are meta only (MOTIR-11445), so its cards are read where the grid reads them:
 * each lane's cell pages, as the same reader.
 */
async function laneTitles(
  board: BoardProjectionDto,
  projectId: string,
  ctx: Parameters<typeof boardsService.getBoard>[1],
): Promise<string[]> {
  expect(titles(board)).toEqual([]);
  const pages = await Promise.all(
    board.swimlanes.map((lane) =>
      boardsService.getLanePage(projectId, ctx, board.boardId, lane.key),
    ),
  );
  return pages.flatMap((p) => p.cells.flatMap((c) => c.cards.map((x) => x.title))).sort();
}

function total(board: Columns): number {
  return board.columns.reduce((sum, c) => sum + c.totalCount, 0);
}

describe('resolveStoredBoardFilter', () => {
  it('is undefined for a board with no stored filter', async () => {
    const fx = await makeFixture();
    expect(await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, null)).toBeUndefined();
    expect(await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, undefined)).toBeUndefined();
  });

  it('narrows nothing for an envelope with zero conditions', async () => {
    const fx = await makeFixture();
    const resolved = await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, env('or'));
    expect(resolved).toEqual({
      predicate: undefined,
      dto: { envelope: env('or'), staleConditions: [], labels: [] },
    });
  });

  it('reports an unreadable envelope as one invalid entry and matches nothing', async () => {
    const fx = await makeFixture();
    for (const raw of ['v1:abc', { v: 'v9', c: 'and', f: [] }, { v: 'v1', c: 'xor', f: [] }]) {
      expect(await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, raw)).toEqual({
        predicate: { matchNothing: true },
        dto: {
          envelope: null,
          staleConditions: [{ index: null, field: null, reason: 'invalid' }],
          labels: [],
        },
      });
    }
  });

  it('names the condition that no longer validates, by index and field', async () => {
    const fx = await makeFixture();
    const stored = env('and', ['kind', 'is_any_of', ['bug']], ['kind', 'gt', 3]);
    expect(await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, stored)).toEqual({
      predicate: { matchNothing: true },
      dto: {
        envelope: stored,
        staleConditions: [{ index: 1, field: 'kind', reason: 'invalid' }],
        labels: [],
      },
    });
  });

  it('lists each stale referent with its index, field and reason', async () => {
    const fx = await makeFixture();
    const live = await label(fx, 'live');
    const severity = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'severity',
        label: 'Severity',
        fieldType: 'select',
        position: 'a0',
      },
    });
    const stored = env(
      'and',
      ['lbl', 'is_any_of', [live]],
      ['lbl', 'is_any_of', ['deleted-label']],
      ['cmp', 'is_any_of', ['deleted-component']],
      [`cf:${severity.id}`, 'is_any_of', ['deleted-option']],
      ['cf:deleted-field', 'is_any_of', ['x']],
    );
    const resolved = await resolveStoredBoardFilter(fx.projectId, fx.workspaceId, stored);
    expect(resolved!.predicate).toMatchObject({ ast: { combinator: 'and' } });
    expect(resolved!.dto).toEqual({
      envelope: stored,
      staleConditions: [
        { index: 1, field: 'lbl', reason: 'unknown-value' },
        { index: 2, field: 'cmp', reason: 'unknown-value' },
        { index: 3, field: `cf:${severity.id}`, reason: 'unknown-value' },
        { index: 4, field: 'cf:deleted-field', reason: 'unknown-field' },
      ],
      // The labels it names that still exist, by name — a deleted one is absent.
      labels: [{ id: live, name: 'live' }],
    });
  });
});

describe('getBoard — a kanban board with a stored filter', () => {
  it('shows only matching cards in every column, with counts over the same set', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug todo' });
    await card(fx, { kind: 'task', status: 'todo', title: 'Task todo' });
    await card(fx, { kind: 'bug', status: 'in_progress', title: 'Bug WIP' });
    await card(fx, { kind: 'task', status: 'done', title: 'Task done' });
    await store(fx, BUGS);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(titles(board)).toEqual(['Bug WIP', 'Bug todo']);
    expect(col(board, 'todo').totalCount).toBe(1);
    expect(col(board, 'in_progress').totalCount).toBe(1);
    expect(col(board, 'done').totalCount).toBe(0);
    expect(board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });
  });

  it('pages a lane through the stored-filtered set only', async () => {
    const fx = await makeFixture();
    for (let i = 0; i < 13; i++) await card(fx, { kind: 'bug', title: `Bug ${i}` });
    for (let i = 0; i < 5; i++) await card(fx, { kind: 'task', title: `Task ${i}` });
    await store(fx, BUGS);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = col(board, 'todo');
    expect(todo.totalCount).toBe(13);
    expect(todo.cards).toHaveLength(10);
    expect(todo.cursor).not.toBeNull();

    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      todo.id,
      todo.cursor!,
    );
    expect(page.totalCount).toBe(13);
    expect(page.cards).toHaveLength(3);
    expect(page.cursor).toBeNull();
    expect([...todo.cards, ...page.cards].every((c) => c.title.startsWith('Bug'))).toBe(true);
  });

  it('counts the priority swimlanes over the stored-filtered set', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug high', priority: 'high' });
    await card(fx, { kind: 'bug', title: 'Bug low', priority: 'low' });
    await card(fx, { kind: 'task', title: 'Task high', priority: 'high' });
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'priority', filter: BUGS as never },
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.swimlanes.map((l) => [l.key, l.count])).toEqual([
      ['high', 1],
      ['low', 1],
    ]);
  });

  it('counts the epic lanes and the derived "No epic" lane over the stored-filtered set', async () => {
    const fx = await makeFixture();
    const epic = await card(fx, { kind: 'epic', title: 'Epic', status: 'done' });
    const story = await card(fx, { kind: 'story', title: 'Story', parentId: epic, status: 'done' });
    await card(fx, { kind: 'bug', title: 'Bug under epic', parentId: story });
    await card(fx, { kind: 'bug', title: 'Loose bug 1' });
    await card(fx, { kind: 'bug', title: 'Loose bug 2' });
    await card(fx, { kind: 'task', title: 'Loose task' });
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'epic', filter: BUGS as never },
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.swimlanes.map((l) => [l.key === epic ? 'epic' : l.label, l.count])).toEqual([
      ['epic', 1],
      ['No epic', 2],
    ]);
  });

  it('counts the assignee swimlanes over the stored-filtered set', async () => {
    const fx = await makeFixture();
    const mine = await card(fx, { kind: 'bug', title: 'My bug' });
    await adminDb.workItem.update({ where: { id: mine }, data: { assigneeId: fx.ctx.userId } });
    await card(fx, { kind: 'bug', title: 'Unassigned bug' });
    const myTask = await card(fx, { kind: 'task', title: 'My task' });
    await adminDb.workItem.update({ where: { id: myTask }, data: { assigneeId: fx.ctx.userId } });
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'assignee', filter: BUGS as never },
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.swimlanes.map((l) => l.count)).toEqual([1, 1]);
  });

  it('is applied identically for a member who did not create the board', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug' });
    await card(fx, { kind: 'task', title: 'Task' });
    await store(fx, BUGS);

    const owner = await boardsService.getBoard(fx.projectId, fx.ctx);
    const member = await boardsService.getBoard(fx.projectId, fx.memberCtx);
    expect(titles(member)).toEqual(['Bug']);
    expect(member.columns.map((c) => c.totalCount)).toEqual(owner.columns.map((c) => c.totalCount));
    expect(member.storedFilter).toEqual(owner.storedFilter);
  });
});

describe('getBoard — stored filter AND toolbar filter', () => {
  // Cards spanning kind × priority so every pairing has a distinct answer.
  async function seed(fx: Fixture) {
    await card(fx, { kind: 'bug', priority: 'high', title: 'bug-high' });
    await card(fx, { kind: 'bug', priority: 'low', title: 'bug-low' });
    await card(fx, { kind: 'task', priority: 'high', title: 'task-high' });
    await card(fx, { kind: 'task', priority: 'low', title: 'task-low' });
    await card(fx, { kind: 'story', priority: 'medium', title: 'story-medium' });
  }

  const storedAnd = env(
    'and',
    ['kind', 'is_any_of', ['bug', 'task']],
    ['priority', 'is_none_of', ['low']],
  );
  const storedOr = env('or', ['kind', 'is_any_of', ['bug']], ['priority', 'is_any_of', ['medium']]);
  const toolbarAnd = ast(
    'and',
    { field: 'priority', operator: 'is_any_of', value: ['high', 'medium'] },
    { field: 'kind', operator: 'is_none_of', value: ['task'] },
  );
  const toolbarOr = ast(
    'or',
    { field: 'kind', operator: 'is_any_of', value: ['story'] },
    { field: 'priority', operator: 'is_any_of', value: ['low'] },
  );

  it.each([
    // stored ∧ toolbar, each side evaluated on its own
    ['and', 'and', storedAnd, toolbarAnd, ['bug-high']],
    ['and', 'or', storedAnd, toolbarOr, []],
    ['or', 'and', storedOr, toolbarAnd, ['bug-high', 'story-medium']],
    ['or', 'or', storedOr, toolbarOr, ['bug-low', 'story-medium']],
  ])(
    'stored %s ∧ toolbar %s returns the intersection',
    async (_s, _t, stored, toolbar, expected) => {
      const fx = await makeFixture();
      await seed(fx);
      await store(fx, stored);

      const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, { ast: toolbar });
      expect(titles(board)).toEqual(expected);
      expect(total(board)).toBe(expected.length);
    },
  );

  it('a toolbar filter alone still narrows the epic lanes, with no stored filter', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug' });
    await card(fx, { kind: 'task', title: 'Task' });
    await adminDb.board.update({ where: { id: fx.boardId }, data: { swimlaneGroupBy: 'epic' } });
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: ast('and', { field: 'kind', operator: 'is_any_of', value: ['bug'] }),
    });
    expect(board.storedFilter).toBeNull();
    expect(board.swimlanes.map((l) => [l.label, l.count])).toEqual([['No epic', 1]]);
  });

  it('falls back to the stored-filtered board when the toolbar filter is removed', async () => {
    const fx = await makeFixture();
    await seed(fx);
    await store(fx, storedOr);
    const filtered = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: toolbarOr,
    });
    expect(titles(filtered)).toEqual(['bug-low', 'story-medium']);
    const cleared = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(titles(cleared)).toEqual(['bug-high', 'bug-low', 'story-medium']);
  });

  it('keeps the toolbar filter’s 422 for an invalid inline filter', async () => {
    const fx = await makeFixture();
    await store(fx, BUGS);
    await expect(
      boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
        ast: ast('and', { field: 'kind', operator: 'gt', value: 3 }),
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_FILTER_OPERATOR' });
  });
});

describe('getBoard — a scrum board with a stored filter', () => {
  it('shows only matching cards in the active sprint and sums only their points', async () => {
    const fx = await makeFixture();
    const sprintId = await activeSprint(fx);
    const mobile = await label(fx, 'mobile');
    await card(fx, { title: 'Mobile todo', sprintId, points: 3, labelIds: [mobile] });
    await card(fx, {
      title: 'Mobile done',
      status: 'done',
      sprintId,
      points: 5,
      labelIds: [mobile],
    });
    await card(fx, { title: 'Web todo', sprintId, points: 8 });
    await card(fx, { title: 'Mobile backlog', points: 13, labelIds: [mobile] });
    await store(fx, env('and', ['lbl', 'is_any_of', [mobile]]));

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(titles(board)).toEqual(['Mobile done', 'Mobile todo']);
    expect(board.sprint!.points).toMatchObject({ committed: 8, completed: 5 });
    expect(board.sprint!.columnPoints[col(board, 'todo').id]).toBe(3);
    expect(board.sprint!.columnPoints[col(board, 'done').id]).toBe(5);
  });

  it('reports storedFilter: null on the no-active-sprint frame of an unfiltered board', async () => {
    const fx = await makeFixture();
    await adminDb.board.update({ where: { id: fx.boardId }, data: { type: 'scrum' } });
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.sprint).toBeNull();
    expect(board.storedFilter).toBeNull();
  });

  it('carries the stored filter on the no-active-sprint frame', async () => {
    const fx = await makeFixture();
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { type: 'scrum', filter: BUGS as never },
    });
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.sprint).toBeNull();
    expect(board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });
  });
});

describe('getBoard — stale, unreadable and empty stored filters', () => {
  it('loads with a stale label: that condition matches nothing and is reported', async () => {
    const fx = await makeFixture();
    const gone = await label(fx, 'gone');
    await card(fx, { kind: 'bug', title: 'Labelled bug', labelIds: [gone] });
    await card(fx, { kind: 'bug', title: 'Plain bug' });
    await store(fx, env('or', ['kind', 'is_any_of', ['bug']], ['lbl', 'is_any_of', [gone]]));
    await adminDb.label.delete({ where: { id: gone } });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // `or`: the live kind condition still matches; the stale label adds nothing.
    expect(titles(board)).toEqual(['Labelled bug', 'Plain bug']);
    expect(board.storedFilter!.staleConditions).toEqual([
      { index: 1, field: 'lbl', reason: 'unknown-value' },
    ]);
  });

  it('narrows to nothing, never everything, when the stored envelope no longer reads', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug' });
    await store(fx, { v: 'v2', c: 'and', f: [] });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(total(board)).toBe(0);
    expect(board.storedFilter).toEqual({
      envelope: null,
      staleConditions: [{ index: null, field: null, reason: 'invalid' }],
      labels: [],
    });
  });

  it('narrows to nothing when a stored condition no longer validates', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug' });
    await store(fx, env('and', ['nope', 'is_any_of', ['x']]));
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(total(board)).toBe(0);
    expect(board.storedFilter!.staleConditions).toEqual([
      { index: 0, field: 'nope', reason: 'invalid' },
    ]);
  });

  it('returns the filtered-empty frame when the stored filter matches nothing', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'task', title: 'Task' });
    await store(fx, BUGS);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.columns.every((c) => c.cards.length === 0 && c.totalCount === 0)).toBe(true);
    expect(board.columns.length).toBeGreaterThan(0);
  });
});

describe('getBoard — no stored filter (parity)', () => {
  it('reads exactly as an unfiltered board and reports storedFilter: null', async () => {
    const fx = await makeFixture();
    await card(fx, { kind: 'bug', title: 'Bug', priority: 'high' });
    await card(fx, { kind: 'task', title: 'Task', status: 'in_progress' });
    await card(fx, { kind: 'story', title: 'Story', status: 'done' });
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'priority' },
    });

    const bare = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(bare.storedFilter).toBeNull();
    expect(await laneTitles(bare, fx.projectId, fx.ctx)).toEqual(['Bug', 'Story', 'Task']);

    // A stored filter with zero conditions narrows nothing: the same board.
    await store(fx, env('and'));
    const empty = await boardsService.getBoard(fx.projectId, fx.ctx);
    const { storedFilter: _a, ...bareRest } = bare;
    const { storedFilter: _b, ...emptyRest } = empty;
    expect(emptyRest).toEqual(bareRest);
  });
});

describe('the stored filter for a Visitor and on the public preview', () => {
  async function publicFixture() {
    const fx = await makeFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    await card(fx, { kind: 'bug', title: 'Public bug' });
    await card(fx, { kind: 'task', title: 'Public task' });
    await store(fx, BUGS);
    return fx;
  }

  it('applies the stored filter to a Visitor’s board', async () => {
    const fx = await publicFixture();
    // A Visitor exists only on a cloud build (`isCloud()`).
    const previousCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
    onTestFinished(() => {
      if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previousCloud;
    });
    // A private epic's hidden bug: withheld from the Visitor on top of the filter.
    const privateEpic = await card(fx, { kind: 'epic', title: 'Private epic', status: 'done' });
    await adminDb.workItem.update({
      where: { id: privateEpic },
      data: { publicChildrenHidden: true },
    });
    await card(fx, { kind: 'bug', title: 'Hidden bug', parentId: privateEpic });
    const visitor = await consentedVisitor(fx.projectKey);
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'priority' },
    });
    const board = await boardsService.getBoard(fx.projectId, visitor);
    expect(await laneTitles(board, fx.projectId, visitor)).toEqual(['Public bug']);
    expect(total(board)).toBe(1);
    // The Visitor's lanes count the same stored-filtered set.
    expect(board.swimlanes.reduce((sum, l) => sum + l.count, 0)).toBe(1);
    expect(board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });
  });

  it('applies the default board’s stored filter to the public preview', async () => {
    const fx = await publicFixture();
    const preview = await publicProjectsService.getBoard(fx.projectKey, null);
    expect(titles(preview)).toEqual(['Public bug']);
    expect(total(preview)).toBe(1);

    await store(fx, null);
    const unfiltered = await publicProjectsService.getBoard(fx.projectKey, null);
    expect(titles(unfiltered)).toEqual(['Public bug', 'Public task']);
  });
});
