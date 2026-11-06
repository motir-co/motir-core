import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

// boardsService.getBoard — swimlane projection (Story 3.3 · Subtask 3.3.4). Real
// Postgres (no mocks), per CLAUDE.md. createTestProject auto-seeds the default
// workflow + board (one column per status); cards created here land in `todo`
// (the initial status), so they are all on the board. These tests prove: each
// group-by stamps the right per-card `swimlaneKey` (incl. epic-ANCESTOR and the
// catch-all), the bounded lane list + per-lane counts, the `none` no-op, and
// that pagination/bounding is preserved (the lane list comes from the aggregate,
// not a load-all).

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
    // the flat board stamps NO swimlaneKey (byte-for-byte 3.1.4 card shape)
    expect(findCard(board, a)).not.toHaveProperty('swimlaneKey');
  });

  it('group-by assignee: per-card key + alpha lanes + "No assignee" catch-all last', async () => {
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
    // per-card key: assignee id, or the catch-all sentinel when unassigned
    expect(findCard(board, a1)!.swimlaneKey).toBe(alice.id);
    expect(findCard(board, b1)!.swimlaneKey).toBe(bob.id);
    expect(findCard(board, u1)!.swimlaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);
    // lanes: Alice, Bob (alpha by name), then the catch-all LAST
    expect(board.swimlanes.map((l) => l.key)).toEqual([alice.id, bob.id, BOARD_SWIMLANE_NO_VALUE]);
    expect(board.swimlanes.map((l) => l.label)).toEqual(['Alice', 'Bob', 'No assignee']);
    expect(board.swimlanes.every((l) => l.kind === 'assignee')).toBe(true);
    const byKey = new Map(board.swimlanes.map((l) => [l.key, l.count]));
    expect(byKey.get(alice.id)).toBe(2);
    expect(byKey.get(bob.id)).toBe(1);
    expect(byKey.get(BOARD_SWIMLANE_NO_VALUE)).toBe(1);
  });

  it('group-by priority: per-card key + severity-ranked lanes, no catch-all', async () => {
    const fx = await makeFixture('swl-priority@example.com');
    const h1 = await card(fx, 'h1');
    const h2 = await card(fx, 'h2');
    const m1 = await card(fx, 'm1');
    await setPriority(h1, 'high');
    await setPriority(h2, 'high');
    await setPriority(m1, 'medium');
    await setGroupBy(fx, BoardSwimlaneGroupBy.priority);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(findCard(board, h1)!.swimlaneKey).toBe('high');
    expect(findCard(board, m1)!.swimlaneKey).toBe('medium');
    // highest severity first; priority is non-null so there is NO catch-all
    expect(board.swimlanes.map((l) => l.key)).toEqual(['high', 'medium']);
    expect(board.swimlanes.find((l) => l.key === 'high')!.count).toBe(2);
    expect(board.swimlanes.every((l) => l.kind === 'priority')).toBe(true);
    expect(board.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(false);
  });

  it('group-by epic: groups by the ANCESTOR epic (not the immediate parent) + "No epic" catch-all', async () => {
    const fx = await makeFixture('swl-epic@example.com');
    const epic = await card(fx, 'Epic', { kind: 'epic' });
    const story = await card(fx, 'Story', { kind: 'story', parentId: epic });
    const task = await card(fx, 'Task', { kind: 'task', parentId: story });
    const orphan = await card(fx, 'No-epic task'); // top-level task, no epic ancestor
    await setGroupBy(fx, BoardSwimlaneGroupBy.epic);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    // the task two levels down groups by the EPIC, not its immediate parent story
    expect(findCard(board, task)!.swimlaneKey).toBe(epic);
    expect(findCard(board, story)!.swimlaneKey).toBe(epic);
    expect(findCard(board, epic)!.swimlaneKey).toBe(epic); // an epic card is its own lane
    expect(findCard(board, orphan)!.swimlaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);

    const epicLane = board.swimlanes.find((l) => l.key === epic)!;
    const catchAll = board.swimlanes.find((l) => l.key === BOARD_SWIMLANE_NO_VALUE)!;
    expect(epicLane.kind).toBe('epic');
    expect(epicLane.label).toContain('Epic'); // identifier + title
    // the epic lane counts every card whose ancestor epic is this epic (epic + story + task)
    const inEpicLane = board.columns
      .flatMap((c) => c.cards)
      .filter((c) => c.swimlaneKey === epic).length;
    expect(epicLane.count).toBe(inEpicLane);
    expect(epicLane.count).toBe(3);
    expect(catchAll.count).toBe(1);
    // catch-all sorts last
    expect(board.swimlanes[board.swimlanes.length - 1]!.key).toBe(BOARD_SWIMLANE_NO_VALUE);
  });

  it('pages a lane under a group-by while the swimlane count stays the full aggregate (MOTIR-10535)', async () => {
    const fx = await makeFixture('swl-bound@example.com');
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    // 120 unassigned todo cards — well past the old 50-card page size.
    // `position` is a VALID fractional-index key chained in insertion order
    // (MOTIR-2198): the old `p${padStart(4)}` form sorted correctly but is a key
    // nothing in the product can mint (head `'p'` demands a 17-char integer
    // part), so the fixture seeded a state the application cannot reach.
    let position: string | null = null;
    await adminDb.workItem.createMany({
      data: Array.from({ length: 120 }, (_, i) => {
        const key = 1000 + i;
        return {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          kind: 'task' as const,
          key,
          identifier: `${project.identifier}-${key}`,
          title: `Bulk ${i}`,
          status: 'todo',
          reporterId: fx.ctx.userId,
          position: (position = keyForAppend(position)),
        };
      }),
    });
    await setGroupBy(fx, BoardSwimlaneGroupBy.assignee);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = todoColumn(board);
    // MOTIR-10535: the lane opens on its first page, with a cursor for the rest.
    expect(todo.totalCount).toBe(120);
    expect(todo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todo.cursor).not.toBeNull();
    // the swimlane list is the AGGREGATE over all 120 (a bounded distinct query,
    // never derived from the loaded page) and every loaded card carries its key
    const catchAll = board.swimlanes.find((l) => l.key === BOARD_SWIMLANE_NO_VALUE)!;
    expect(catchAll.count).toBe(120);
    expect(todo.cards.every((c) => c.swimlaneKey === BOARD_SWIMLANE_NO_VALUE)).toBe(true);

    // A next page carries its cards' swimlane keys too.
    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      todo.id,
      todo.cursor!,
    );
    expect(page.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(page.cards.every((c) => c.swimlaneKey === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
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
    const task = await card(a, 'A Task', { kind: 'task', parentId: epic });
    await setGroupBy(a, BoardSwimlaneGroupBy.epic);

    const board = await boardsService.getBoard(a.projectId, a.ctx);
    expect(findCard(board, task)!.swimlaneKey).toBe(epic);
    expect(board.swimlanes.find((l) => l.key === epic)!.count).toBe(2);
  });
});
