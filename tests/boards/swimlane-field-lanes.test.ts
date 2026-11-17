import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService, resolveBoardLane } from '@/lib/services/boardsService';
import { resolveFieldLaneKeys } from '@/lib/services/boardLanesService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  BoardSwimlaneGroupBy,
  Executor,
  WorkItemDifficulty,
  WorkItemKind,
  WorkItemType,
} from '@/generated/prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The board's FIELD lanes (MOTIR-11585) — group-by reporter, type, difficulty,
// executor, kind, label, component and repository. Real Postgres through the real
// service → repository → Prisma chain, nothing mocked (the posture of
// `cell-page.test.ts`). Per option it proves the three halves the card names:
//
//   - the LANE PREDICATE — a cell holds exactly that lane's cards (`getCellPage`
//     / `getLanePage`, which compile it to SQL), its total included;
//   - the KEY RESOLUTION — `resolveBoardLane` parses the lane key (refusing what
//     the field cannot hold), and `resolveFieldLaneKeys` keys a loaded card;
//   - the LANE LIST — the projection's `swimlanes`, in the option's order, with
//     the catch-all last and only when it holds a card.
//
// A multi-value field (label, component, repository) puts one card in each of
// its values' lanes: each lane counts it once, the column total once.

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
  boardId: string;
}

let seq = 0;

async function makeFixture(): Promise<Fixture> {
  const n = seq++;
  const user = await usersService.createUser({
    email: `field-lanes-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: `FL WS ${n}`, ownerUserId: user.id });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    identifier: `FL${n}`,
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return {
    ctx: { userId: user.id, workspaceId },
    workspaceId,
    projectId: project.id,
    boardId: board.id,
  };
}

async function groupBy(fx: Fixture, value: BoardSwimlaneGroupBy): Promise<BoardProjectionDto> {
  await adminDb.board.update({ where: { id: fx.boardId }, data: { swimlaneGroupBy: value } });
  return boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
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
    parentId?: string;
    status?: string;
    reporterId?: string;
    type?: WorkItemType;
    difficulty?: WorkItemDifficulty;
    executor?: Executor;
    priority?: 'high' | 'medium';
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
      // A typed leaf may carry the seeded executor; set every field explicitly.
      type: opts.type ?? null,
      difficulty: opts.difficulty ?? null,
      executor: opts.executor ?? null,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    },
  });
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

async function component(fx: Fixture, name: string): Promise<string> {
  const row = await adminDb.component.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name,
      nameLower: name.toLowerCase(),
    },
  });
  return row.id;
}

let repoPosition: string | null = null;
async function repo(fx: Fixture, name: string): Promise<string> {
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'other',
      name,
      seedSource: 'blank',
      state: 'connected',
      position: (repoPosition = keyForAppend(repoPosition)),
    },
  });
  return row.id;
}

const tag = {
  label: (workItemId: string, labelId: string) =>
    adminDb.workItemLabel.create({ data: { workItemId, labelId } }),
  component: (workItemId: string, componentId: string) =>
    adminDb.workItemComponent.create({ data: { workItemId, componentId } }),
  repository: async (fx: Fixture, workItemId: string, projectRepoId: string) => {
    const position = await adminDb.workItemRepo.count({ where: { workItemId } });
    return adminDb.workItemRepo.create({
      data: { workspaceId: fx.workspaceId, workItemId, projectRepoId, position },
    });
  },
};

function column(board: BoardProjectionDto, statusKey: string) {
  return board.columns.find((c) => c.statusKeys[0] === statusKey)!;
}

const lanes = (board: BoardProjectionDto) =>
  board.swimlanes.map((l) => ({ key: l.key, label: l.label, count: l.count }));

/** The titles one lane holds in one column, and that cell's total. */
async function cellTitles(fx: Fixture, columnId: string, laneKey: string) {
  const page = await boardsService.getCellPage(fx.projectId, fx.ctx, fx.boardId, columnId, laneKey);
  return { titles: page.cards.map((c) => c.title).sort(), total: page.totalCount };
}

/** Every lane's cells (one lane page per lane) sum to that lane's header count. */
async function expectLaneArithmetic(fx: Fixture, board: BoardProjectionDto): Promise<void> {
  for (const lane of board.swimlanes) {
    const page = await boardsService.getLanePage(fx.projectId, fx.ctx, fx.boardId, lane.key);
    const sum = page.cells.reduce((s, c) => s + c.totalCount, 0);
    expect(sum, `lane ${lane.label}`).toBe(lane.count);
    for (const c of page.cells) expect(c.cards.every((k) => k.swimlaneKey === lane.key)).toBe(true);
  }
}

describe('group by reporter', () => {
  it('lanes per reporter by name, no catch-all, each cell that person’s cards', async () => {
    const fx = await makeFixture();
    const zoe = await person('Zoe');
    const ana = await person('Ana');
    await card(fx, { title: 'By Zoe', reporterId: zoe });
    await card(fx, { title: 'By Ana 1', reporterId: ana });
    await card(fx, { title: 'By Ana 2', reporterId: ana, status: 'in_progress' });

    const board = await groupBy(fx, 'reporter');
    expect(lanes(board)).toEqual([
      { key: ana, label: 'Ana', count: 2 },
      { key: zoe, label: 'Zoe', count: 1 },
    ]);
    expect(await cellTitles(fx, column(board, 'todo').id, ana)).toEqual({
      titles: ['By Ana 1'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);

    expect(resolveBoardLane('reporter', ana)).toEqual({
      kind: 'field',
      field: 'reporterId',
      value: ana,
    });
    expect(() => resolveBoardLane('reporter', BOARD_SWIMLANE_NO_VALUE)).toThrow(
      /grouped by reporter/,
    );
  });
});

describe('group by the leaf-only fields', () => {
  it('type: enum order, the untyped (an epic, a story, an untyped leaf) last', async () => {
    const fx = await makeFixture();
    await card(fx, { title: 'Design it', type: 'design' });
    await card(fx, { title: 'Code it', type: 'code' });
    await card(fx, { title: 'Code more', type: 'code' });
    await card(fx, { title: 'A story', kind: 'story' });
    await card(fx, { title: 'Untyped task' });

    const board = await groupBy(fx, 'type');
    expect(lanes(board)).toEqual([
      { key: 'code', label: 'code', count: 2 },
      { key: 'design', label: 'design', count: 1 },
      { key: BOARD_SWIMLANE_NO_VALUE, label: 'No type', count: 2 },
    ]);
    const todo = column(board, 'todo').id;
    expect(await cellTitles(fx, todo, 'code')).toEqual({
      titles: ['Code it', 'Code more'],
      total: 2,
    });
    expect(await cellTitles(fx, todo, BOARD_SWIMLANE_NO_VALUE)).toEqual({
      titles: ['A story', 'Untyped task'],
      total: 2,
    });
    await expectLaneArithmetic(fx, board);
    expect(() => resolveBoardLane('type', 'not-a-type')).toThrow(/grouped by type/);
    expect(resolveBoardLane('type', BOARD_SWIMLANE_NO_VALUE)).toEqual({
      kind: 'field',
      field: 'type',
      value: null,
    });
  });

  it('difficulty: trivial → high, the catch-all last', async () => {
    const fx = await makeFixture();
    await card(fx, { title: 'Hard', difficulty: 'high' });
    await card(fx, { title: 'Easy', difficulty: 'trivial' });
    await card(fx, { title: 'Middling', difficulty: 'medium' });
    await card(fx, { title: 'Unsized' });

    const board = await groupBy(fx, 'difficulty');
    expect(board.swimlanes.map((l) => l.key)).toEqual([
      'trivial',
      'medium',
      'high',
      BOARD_SWIMLANE_NO_VALUE,
    ]);
    expect(board.swimlanes.at(-1)!.label).toBe('No difficulty');
    expect(await cellTitles(fx, column(board, 'todo').id, 'high')).toEqual({
      titles: ['Hard'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);
  });

  it('executor: coding agent, human, then no executor', async () => {
    const fx = await makeFixture();
    await card(fx, { title: 'By hand', executor: 'human' });
    await card(fx, { title: 'By agent', executor: 'coding_agent' });
    await card(fx, { title: 'Nobody yet' });

    const board = await groupBy(fx, 'executor');
    expect(lanes(board)).toEqual([
      { key: 'coding_agent', label: 'coding_agent', count: 1 },
      { key: 'human', label: 'human', count: 1 },
      { key: BOARD_SWIMLANE_NO_VALUE, label: 'No executor', count: 1 },
    ]);
    expect(await cellTitles(fx, column(board, 'todo').id, BOARD_SWIMLANE_NO_VALUE)).toEqual({
      titles: ['Nobody yet'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);
  });
});

describe('group by kind', () => {
  it('epic → subtask, every card in its kind’s lane, no catch-all', async () => {
    const fx = await makeFixture();
    const epic = await card(fx, { title: 'The epic', kind: 'epic' });
    const story = await card(fx, { title: 'The story', kind: 'story', parentId: epic });
    await card(fx, { title: 'The task', parentId: story });
    await card(fx, { title: 'A bug', kind: 'bug' });

    const board = await groupBy(fx, 'kind');
    expect(board.swimlanes.map((l) => [l.key, l.count])).toEqual([
      ['epic', 1],
      ['story', 1],
      ['task', 1],
      ['bug', 1],
    ]);
    expect(await cellTitles(fx, column(board, 'todo').id, 'task')).toEqual({
      titles: ['The task'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);
    expect(() => resolveBoardLane('kind', BOARD_SWIMLANE_NO_VALUE)).toThrow(/grouped by kind/);
    expect(() => resolveBoardLane('kind', 'theme')).toThrow(/grouped by kind/);
  });
});

describe('group by a multi-value field', () => {
  it('label: a two-label card is in both lanes, counted once in each and once in its column', async () => {
    const fx = await makeFixture();
    const ui = await label(fx, 'ui');
    const api = await label(fx, 'API');
    const both = await card(fx, { title: 'Both' });
    const uiOnly = await card(fx, { title: 'UI only' });
    await card(fx, { title: 'Unlabelled' });
    await tag.label(both, ui);
    await tag.label(both, api);
    await tag.label(uiOnly, ui);

    const board = await groupBy(fx, 'label');
    // By name, case-insensitively — "API" before "ui" — the catch-all last.
    expect(lanes(board)).toEqual([
      { key: api, label: 'API', count: 1 },
      { key: ui, label: 'ui', count: 2 },
      { key: BOARD_SWIMLANE_NO_VALUE, label: 'No label', count: 1 },
    ]);
    const todo = column(board, 'todo');
    expect(todo.totalCount).toBe(3);
    expect(await cellTitles(fx, todo.id, ui)).toEqual({ titles: ['Both', 'UI only'], total: 2 });
    expect(await cellTitles(fx, todo.id, api)).toEqual({ titles: ['Both'], total: 1 });
    expect(await cellTitles(fx, todo.id, BOARD_SWIMLANE_NO_VALUE)).toEqual({
      titles: ['Unlabelled'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);

    // A card read outside a lane is keyed by its FIRST value in lane order.
    const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    const keys = await resolveFieldLaneKeys('label', fx.projectId, rows, fx.workspaceId);
    expect(keys.get(both)).toBe(api);
    expect(keys.get(uiOnly)).toBe(ui);
    expect(resolveBoardLane('label', BOARD_SWIMLANE_NO_VALUE)).toEqual({
      kind: 'tag',
      tag: 'label',
      valueId: null,
    });

    // A moved card comes back keyed the same way, so the board files its echo.
    const moved = await boardsService.moveCard(
      fx.boardId,
      both,
      { toColumnId: column(board, 'in_progress').id },
      fx.ctx,
    );
    expect(moved.card.swimlaneKey).toBe(api);
  });

  it('the lane aggregates answer nothing for no statuses, and honour a sprint scope', async () => {
    const fx = await makeFixture();
    const ui = await label(fx, 'ui');
    const id = await card(fx, { title: 'Tagged', type: 'code' });
    await tag.label(id, ui);
    const read = <T>(
      fn: (tx: Parameters<Parameters<typeof withWorkspaceServiceContext>[1]>[0]) => Promise<T>,
    ) => withWorkspaceServiceContext(fx.workspaceId, fn);
    const args = [fx.projectId, fx.workspaceId] as const;
    expect(
      await read((tx) =>
        workItemRepository.aggregateBoardLanesByField(
          'type',
          ...args,
          [],
          undefined,
          undefined,
          tx,
        ),
      ),
    ).toEqual([]);
    expect(
      await read((tx) =>
        workItemRepository.aggregateBoardLanesByTag('label', ...args, [], undefined, undefined, tx),
      ),
    ).toEqual([]);
    expect(await read((tx) => workItemRepository.findLaneTagValues('label', [], tx))).toEqual([]);
    // A sprint the card is not in holds none of its lanes.
    const sprint = 'cl0000000000000000000000';
    expect(
      await read((tx) =>
        workItemRepository.aggregateBoardLanesByField(
          'type',
          ...args,
          ['todo'],
          sprint,
          undefined,
          tx,
        ),
      ),
    ).toEqual([]);
    expect(
      await read((tx) =>
        workItemRepository.aggregateBoardLanesByTag(
          'label',
          ...args,
          ['todo'],
          sprint,
          undefined,
          tx,
        ),
      ),
    ).toEqual([]);
    expect(
      await read((tx) =>
        workItemRepository.aggregateBoardLanesByTag(
          'label',
          ...args,
          ['todo'],
          undefined,
          undefined,
          tx,
        ),
      ),
    ).toEqual([{ valueId: ui, count: 1 }]);
  });

  it('label: the toolbar filter narrows every lane and cell, and an emptied lane disappears', async () => {
    const fx = await makeFixture();
    const ui = await label(fx, 'ui');
    const api = await label(fx, 'api');
    const high = await card(fx, { title: 'High', priority: 'high' });
    const medium = await card(fx, { title: 'Medium', priority: 'medium' });
    await tag.label(high, ui);
    await tag.label(medium, api);
    await groupBy(fx, 'label');
    const filter = {
      ast: {
        combinator: 'and' as const,
        conditions: [
          { field: 'priority' as const, operator: 'is_any_of' as const, value: ['high'] },
        ],
      },
    };
    const board = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId, filter);
    expect(lanes(board)).toEqual([{ key: ui, label: 'ui', count: 1 }]);
    const page = await boardsService.getCellPage(
      fx.projectId,
      fx.ctx,
      fx.boardId,
      column(board, 'todo').id,
      api,
      undefined,
      filter,
    );
    expect(page).toMatchObject({ cards: [], totalCount: 0 });
  });

  it('component: by name, the catch-all last', async () => {
    const fx = await makeFixture();
    const web = await component(fx, 'Web');
    const billing = await component(fx, 'Billing');
    const a = await card(fx, { title: 'Checkout' });
    const b = await card(fx, { title: 'Invoice' });
    await card(fx, { title: 'Loose' });
    await tag.component(a, web);
    await tag.component(a, billing);
    await tag.component(b, billing);

    const board = await groupBy(fx, 'component');
    expect(lanes(board)).toEqual([
      { key: billing, label: 'Billing', count: 2 },
      { key: web, label: 'Web', count: 1 },
      { key: BOARD_SWIMLANE_NO_VALUE, label: 'No component', count: 1 },
    ]);
    expect(await cellTitles(fx, column(board, 'todo').id, billing)).toEqual({
      titles: ['Checkout', 'Invoice'],
      total: 2,
    });
    await expectLaneArithmetic(fx, board);
  });

  it('repository: in the project repository set’s order, not by name', async () => {
    const fx = await makeFixture();
    const zeta = await repo(fx, 'zeta-web');
    const alpha = await repo(fx, 'alpha-api');
    const a = await card(fx, { title: 'Front' });
    const b = await card(fx, { title: 'Back' });
    await card(fx, { title: 'Nowhere' });
    await tag.repository(fx, a, zeta);
    await tag.repository(fx, b, alpha);
    await tag.repository(fx, b, zeta);

    const board = await groupBy(fx, 'repository');
    expect(lanes(board)).toEqual([
      { key: zeta, label: 'zeta-web', count: 2 },
      { key: alpha, label: 'alpha-api', count: 1 },
      { key: BOARD_SWIMLANE_NO_VALUE, label: 'No repository', count: 1 },
    ]);
    expect(await cellTitles(fx, column(board, 'todo').id, alpha)).toEqual({
      titles: ['Back'],
      total: 1,
    });
    await expectLaneArithmetic(fx, board);
    const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    const keys = await resolveFieldLaneKeys('repository', fx.projectId, rows, fx.workspaceId);
    expect(keys.get(b)).toBe(zeta);
  });

  it('saves the option on the board, so it survives a fresh read', async () => {
    const fx = await makeFixture();
    for (const value of [
      'reporter',
      'type',
      'difficulty',
      'executor',
      'kind',
      'label',
      'component',
      'repository',
    ] as const) {
      const saved = await boardsService.setSwimlaneGroupBy(fx.boardId, value, fx.ctx);
      expect(saved.swimlaneGroupBy).toBe(value);
      const read = await boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId);
      expect(read.swimlaneGroupBy).toBe(value);
    }
  });
});
