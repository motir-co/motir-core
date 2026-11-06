import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { cursorAfter } from '@/lib/boards/columnCursor';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard — SCRUM sprint scope + SprintSummaryDto (Subtask 4.5.2).
// Real Postgres (no mocks), per CLAUDE.md. The 3.1.2 seed gives every project a
// KANBAN default board (one column per workflow status, each mapped). These
// tests flip that seeded board's `type` to `scrum` directly and create an active
// sprint directly (the 3.7 board CRUD + the 4.4 lifecycle are other stories'
// tests — mirroring how the projection tests set `status` directly rather than
// walking the transition graph). They assert the 4.5.2 layer on top of the
// proven 3.1/3.3 board: the sprint scope on the columns/counts/lanes, the
// `SprintSummaryDto` aggregates, and that the kanban path is untouched.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** UTC midnight of today — the base `sprintDaysRemaining` measures against. */
function todayUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  boardId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Scrum User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Scrum WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id, boardId: board.id };
}

/** Flip the seeded default board to `scrum` (it keeps its seeded columns +
 *  mappings; only the kind changes). */
async function makeScrum(fx: Fixture): Promise<void> {
  await adminDb.board.update({ where: { id: fx.boardId }, data: { type: 'scrum' } });
}

/** Create a sprint directly (the 4.4 lifecycle UI is another story). `endInDays`
 *  is measured from UTC-midnight-today so `daysRemaining` is exact. */
async function makeSprint(
  fx: Fixture,
  opts: { state?: 'planned' | 'active'; endInDays?: number; goal?: string | null } = {},
): Promise<string> {
  const { state = 'active', endInDays = 5, goal = 'Ship the thing' } = opts;
  const sprint = await adminDb.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Sprint 1',
      goal,
      state,
      startDate: new Date(todayUtcMidnight()),
      endDate: new Date(todayUtcMidnight() + endInDays * DAY_MS),
      sequence: 1,
    },
  });
  return sprint.id;
}

/** Create a card, force it into `status`, and (optionally) attach it to a sprint
 *  with story points — all set directly (the projection groups by these columns;
 *  the write paths are 3.1.5 / 4.1 / 4.3 tests). */
async function card(
  fx: Fixture,
  opts: { status: string; title: string; sprintId?: string | null; points?: number | null },
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status,
      sprintId: opts.sprintId ?? null,
      storyPoints: opts.points ?? null,
    },
  });
  return item.id;
}

function columnByStatus(
  board: Awaited<ReturnType<typeof boardsService.getBoard>>,
  statusKey: string,
) {
  return board.columns.find((c) => c.statusKeys.includes(statusKey))!;
}

describe('getBoard — scrum sprint scope', () => {
  it('scopes columns + counts to the active sprint; an out-of-sprint issue is absent', async () => {
    const fx = await makeFixture('scrum-scope@example.com');
    await makeScrum(fx);
    const sprintId = await makeSprint(fx);
    await card(fx, { status: 'todo', title: 'In sprint A', sprintId, points: 3 });
    await card(fx, { status: 'in_progress', title: 'In sprint B', sprintId, points: 5 });
    // Backlog issue (no sprint) — must NOT appear on the scrum board.
    await card(fx, { status: 'todo', title: 'Backlog C', sprintId: null, points: 8 });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    const todo = columnByStatus(board, 'todo');
    expect(todo.cards.map((c) => c.title)).toEqual(['In sprint A']); // not "Backlog C"
    expect(todo.totalCount).toBe(1); // sprint-scoped count, not 2
    expect(columnByStatus(board, 'in_progress').cards.map((c) => c.title)).toEqual(['In sprint B']);
    expect(board.sprint).not.toBeNull();
  });

  it('returns a SprintSummaryDto with aggregate points (committed/completed/remaining + columnPoints)', async () => {
    const fx = await makeFixture('scrum-summary@example.com');
    await makeScrum(fx);
    const sprintId = await makeSprint(fx, { endInDays: 5, goal: 'Sprint goal' });
    await card(fx, { status: 'todo', title: 'A', sprintId, points: 3 });
    await card(fx, { status: 'in_progress', title: 'B', sprintId, points: 5 });
    await card(fx, { status: 'done', title: 'C', sprintId, points: 2 });
    // Out-of-sprint issue with big points — must not leak into ANY aggregate.
    await card(fx, { status: 'todo', title: 'Backlog', sprintId: null, points: 100 });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const sprint = board.sprint!;

    expect(sprint.name).toBe('Sprint 1');
    expect(sprint.goal).toBe('Sprint goal');
    expect(sprint.state).toBe('active');
    expect(sprint.daysRemaining).toBe(5);
    // committed = all sprint issues (3+5+2); completed = done-category only (2);
    // remaining = committed − completed. The backlog's 100 pts are excluded.
    expect(sprint.points).toEqual({ committed: 10, completed: 2, remaining: 8 });
    // per-column point totals come from the SUM aggregate, NOT the loaded page.
    const todo = columnByStatus(board, 'todo');
    const inProgress = columnByStatus(board, 'in_progress');
    const done = columnByStatus(board, 'done');
    expect(sprint.columnPoints[todo.id]).toBe(3);
    expect(sprint.columnPoints[inProgress.id]).toBe(5);
    expect(sprint.columnPoints[done.id]).toBe(2);
    expect(sprint.columnPoints[columnByStatus(board, 'blocked').id]).toBe(0);
  });

  it('an overdue active sprint floors daysRemaining at 0 (never negative)', async () => {
    const fx = await makeFixture('scrum-overdue@example.com');
    await makeScrum(fx);
    await makeSprint(fx, { endInDays: -3 }); // ended 3 days ago
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.sprint!.daysRemaining).toBe(0);
  });

  it('a wholly-unestimated sprint returns 0 points (no NaN) and still renders', async () => {
    const fx = await makeFixture('scrum-unestimated@example.com');
    await makeScrum(fx);
    const sprintId = await makeSprint(fx);
    await card(fx, { status: 'todo', title: 'A', sprintId, points: null });
    await card(fx, { status: 'in_progress', title: 'B', sprintId, points: null });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.sprint!.points).toEqual({ committed: 0, completed: 0, remaining: 0 });
    for (const v of Object.values(board.sprint!.columnPoints)) expect(v).toBe(0);
    // the board still renders the cards
    expect(columnByStatus(board, 'todo').cards).toHaveLength(1);
  });

  it('a scrum board with NO active sprint → sprint: null + empty columns (no backlog fallback)', async () => {
    const fx = await makeFixture('scrum-no-sprint@example.com');
    await makeScrum(fx);
    // A PLANNED (not active) sprint with issues — must NOT be rendered as active.
    const sprintId = await makeSprint(fx, { state: 'planned' });
    await card(fx, { status: 'todo', title: 'Planned-sprint card', sprintId, points: 3 });
    await card(fx, { status: 'todo', title: 'Backlog card', sprintId: null, points: 1 });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.sprint).toBeNull();
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
    expect(board.columns.every((c) => c.totalCount === 0)).toBe(true);
    expect(board.swimlanes).toEqual([]);
    expect(board.columns.every((c) => c.cursor === null)).toBe(true);
    // ...and a page read for one of its lanes answers an empty last page.
    const lane = board.columns[0]!;
    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      lane.id,
      cursorAfter('position', { position: 'a0', key: 1, updatedAt: new Date() }),
    );
    expect(page).toEqual({
      columnId: lane.id,
      cards: [],
      totalCount: 0,
      cursor: null,
      planHolds: {},
    });
    // the column meta (names/statusKeys) is still present — an honest shape
    expect(board.columns.length).toBeGreaterThan(0);
  });

  it('swimlanes compose with the sprint filter — lanes count only sprint issues', async () => {
    const fx = await makeFixture('scrum-lanes@example.com');
    await makeScrum(fx);
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'assignee' },
    });
    const sprintId = await makeSprint(fx);
    await card(fx, { status: 'todo', title: 'Sprint unassigned 1', sprintId });
    await card(fx, { status: 'in_progress', title: 'Sprint unassigned 2', sprintId });
    // Out-of-sprint unassigned issue — must not inflate the lane count.
    await card(fx, { status: 'todo', title: 'Backlog unassigned', sprintId: null });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const noAssignee = board.swimlanes.find((l) => l.label === 'No assignee')!;
    expect(noAssignee.count).toBe(2); // the 2 sprint issues, not 3
  });

  it('priority swimlanes are sprint-scoped', async () => {
    const fx = await makeFixture('scrum-lanes-prio@example.com');
    await makeScrum(fx);
    await adminDb.board.update({
      where: { id: fx.boardId },
      data: { swimlaneGroupBy: 'priority' },
    });
    const sprintId = await makeSprint(fx);
    const a = await card(fx, { status: 'todo', title: 'Sprint A', sprintId });
    await adminDb.workItem.update({ where: { id: a }, data: { priority: 'high' } });
    // out-of-sprint high-priority issue — excluded from the lane count
    const b = await card(fx, { status: 'todo', title: 'Backlog', sprintId: null });
    await adminDb.workItem.update({ where: { id: b }, data: { priority: 'high' } });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const high = board.swimlanes.find((l) => l.key === 'high')!;
    expect(high.count).toBe(1); // only the sprint issue
  });

  it('epic swimlanes are sprint-scoped (catch-all counts only sprint issues)', async () => {
    const fx = await makeFixture('scrum-lanes-epic@example.com');
    await makeScrum(fx);
    await adminDb.board.update({ where: { id: fx.boardId }, data: { swimlaneGroupBy: 'epic' } });
    const sprintId = await makeSprint(fx);
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic 1' },
      fx.ctx,
    );
    // a sprint story under the epic
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story under epic', parentId: epic.id },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: story.id }, data: { sprintId } });
    // a sprint issue with NO epic ancestor → the "No epic" catch-all
    await card(fx, { status: 'todo', title: 'No-epic sprint card', sprintId });
    // out-of-sprint no-epic card — excluded from the catch-all count
    await card(fx, { status: 'todo', title: 'No-epic backlog card', sprintId: null });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const epicLane = board.swimlanes.find((l) => l.key === epic.id)!;
    expect(epicLane.count).toBe(1); // the story in the sprint
    const noEpic = board.swimlanes.find((l) => l.label === 'No epic')!;
    expect(noEpic.count).toBe(1); // only the sprint no-epic card, not the backlog one
  });
});

describe('getBoard — kanban is unaffected by 4.5.2', () => {
  it('a kanban board carries sprint: null and is unscoped even when an active sprint exists', async () => {
    const fx = await makeFixture('kanban-noop@example.com');
    // do NOT makeScrum — the board stays kanban
    const sprintId = await makeSprint(fx);
    await card(fx, { status: 'todo', title: 'In sprint', sprintId, points: 3 });
    await card(fx, { status: 'todo', title: 'In backlog', sprintId: null, points: 5 });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.sprint).toBeNull();
    // unscoped: BOTH issues show (the sprint filter never applied)
    expect(
      columnByStatus(board, 'todo')
        .cards.map((c) => c.title)
        .sort(),
    ).toEqual(['In backlog', 'In sprint']);
    expect(columnByStatus(board, 'todo').totalCount).toBe(2);
  });
});
