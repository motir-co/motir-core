import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import type { BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedLargeScrumSprint } from '../../scripts/seedLargeBoard';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Subtask 4.7.1 — the at-scale SCRUM fixture. The Scrum analogue of the 3.5.1
// at-scale board fixture test (tests/boards/at-scale-fixture.test.ts). Unit-level
// against real Postgres (CLAUDE.md, no mocks).
//
// It asserts that the sprint-shaped seed (`seedLargeScrumSprint`) yields the
// documented active-sprint / column / lane / Done-age / point distribution, AND
// that the 4.5.2 scrum projection (`boardsService.getBoard`) over it returns the
// sprint summary + the sprint-SCOPED set (an out-of-sprint backlog issue is
// absent). It does NOT re-prove the load model itself (3.8.2/3.8.6) nor the
// scrum scope mechanics (4.5.2's own scrum-projection.test.ts) — here the seed
// composes those into one at-scale fixture, reached with TENS of rows.
//
// MOTIR-10535 pages the board per lane and retired the cap/Done-age env seam
// this file used to re-affirm; a lane's cards are read here by paging it to its
// end, so an assertion about "the board" holds over every page.

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
  identifier: string;
  memberIds: string[];
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'scrum-at-scale-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: 'Scrum at-scale WS',
    ownerUserId: owner.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    identifier: 'BIG',
  });
  const memberIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await usersService.createUser({
      email: `scrum-at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.workspace.id });
    memberIds.push(m.id);
  }
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id, identifier: 'BIG', memberIds };
}

async function setGroupBy(projectId: string, groupBy: BoardSwimlaneGroupBy): Promise<void> {
  await adminDb.board.updateMany({ where: { projectId }, data: { swimlaneGroupBy: groupBy } });
}

// Small, fast distribution: ~22 spread cards over the 6 default statuses + 30
// extras into the tall `in_progress` column. Most join the sprint (every 8th
// stays in the backlog); 1-in-4 sprint issues is left unestimated.
const SMALL_OPTS = {
  epics: 3,
  storiesPerEpic: 5,
  rootStories: 4,
  tallColumnExtra: 30,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
  backlogSliceEvery: 8,
  unestimatedEvery: 4,
};

async function seed(fx: Fixture) {
  return seedLargeScrumSprint(
    {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectIdentifier: fx.identifier,
      ownerId: fx.ctx.userId,
      memberIds: fx.memberIds,
    },
    SMALL_OPTS,
    adminDb,
  );
}

/** Every card id of one lane: its first page, then every next page. */
async function laneIds(fx: Fixture, board: BoardProjectionDto, col: BoardColumnDto) {
  const ids = new Set(col.cards.map((c) => c.id));
  let cursor = col.cursor;
  while (cursor) {
    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      col.id,
      cursor,
    );
    for (const c of page.cards) ids.add(c.id);
    cursor = page.cursor;
  }
  return ids;
}

describe('sprint-shaped large seed distribution (4.7.1)', () => {
  it('flips the board to scrum and creates a large active sprint + a planned carry-over target', async () => {
    const fx = await makeFixture();
    const m = await seed(fx);

    // The default board is now scrum.
    const board = await adminDb.board.findFirstOrThrow({ where: { projectId: fx.projectId } });
    expect(board.type).toBe('scrum');

    // The active sprint holds the bulk of the issues; a backlog slice stays out.
    expect(m.sprintIssueCount).toBeGreaterThan(0);
    expect(m.backlogIssueCount).toBeGreaterThan(0);
    expect(m.sprintIssueCount).toBeGreaterThan(m.backlogIssueCount); // the bulk is in-sprint

    const active = await adminDb.sprint.findUniqueOrThrow({ where: { id: m.activeSprintId } });
    expect(active.state).toBe('active');
    expect(active.startDate).not.toBeNull();
    expect(active.endDate).not.toBeNull();

    // The planned carry-over target exists (the 4.7.3 complete journey's target).
    const target = await adminDb.sprint.findUniqueOrThrow({ where: { id: m.targetSprintId } });
    expect(target.state).toBe('planned');
    expect(target.id).not.toBe(active.id);

    // The DB agrees with the manifest on the in-sprint vs. backlog split.
    const inSprint = await adminDb.workItem.count({
      where: { projectId: fx.projectId, sprintId: m.activeSprintId },
    });
    const inBacklog = await adminDb.workItem.count({
      where: { projectId: fx.projectId, sprintId: null },
    });
    expect(inSprint).toBe(m.sprintIssueCount);
    expect(inBacklog).toBe(m.backlogIssueCount);
  });

  it('getBoard returns the sprint summary + scopes columns to the active sprint; an out-of-sprint issue is absent', async () => {
    const fx = await makeFixture();
    const m = await seed(fx);

    const projection = await boardsService.getBoard(fx.projectId, fx.ctx);

    // The scrum projection surfaces the active-sprint summary (not the kanban
    // `sprint: null`), and every column is sprint-scoped.
    expect(projection.sprint).not.toBeNull();

    const scopedTotal = projection.columns.reduce((s, c) => s + c.totalCount, 0);
    expect(scopedTotal).toBe(m.sprintIssueCount); // the board total == the sprint, not the project

    // A backlog issue (left OUTSIDE the sprint) is absent from the scrum board;
    // an in-sprint issue is present.
    const backlogIssue = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, sprintId: null },
    });
    const sprintIssue = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, sprintId: m.activeSprintId },
    });
    const onBoard = new Set<string>();
    for (const col of projection.columns) {
      for (const id of await laneIds(fx, projection, col)) onBoard.add(id);
    }
    expect(onBoard.size).toBe(m.sprintIssueCount);
    expect(onBoard.has(sprintIssue.id), 'in-sprint issue rendered').toBe(true);
    expect(onBoard.has(backlogIssue.id), 'out-of-sprint issue absent').toBe(false);
  });

  it('populates every column within the sprint, with one tall column far above the rest', async () => {
    const fx = await makeFixture();
    const m = await seed(fx);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated (sprint-scoped)`).toBeGreaterThan(0);
    }
    const tall = board.columns.find((c) => c.statusKeys.includes(m.tallStatusKey))!;
    for (const c of board.columns.filter((c) => c.id !== tall.id)) {
      expect(tall.totalCount, 'tall > others').toBeGreaterThan(c.totalCount);
    }
  });

  it('spreads many assignee lanes + an unassigned catch-all, all sprint-scoped', async () => {
    const fx = await makeFixture();
    await seed(fx);

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.assignee);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // One lane per assignee-with-(sprint)-cards + the unassigned catch-all.
    expect(board.swimlanes.length).toBeGreaterThanOrEqual(2);
    expect(board.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
  });

  it('seeds a Done-age spread whose aged-out sprint cards still page in (MOTIR-10535)', async () => {
    const fx = await makeFixture();
    const m = await seed(fx);
    expect(m.terminalAgedOut).toBeGreaterThan(0);
    expect(m.terminalInWindow).toBeGreaterThan(0);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const terminalCols = board.columns.filter((c) =>
      c.statusKeys.some((k) => m.terminalStatusKeys.includes(k)),
    );
    expect(terminalCols.length).toBeGreaterThan(0);
    // No Done-age window trims a terminal lane any more: its first page is at
    // most BOARD_PAGE_SIZE, and paging reaches its full sprint-scoped count.
    for (const col of terminalCols) {
      expect(col.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      expect((await laneIds(fx, board, col)).size, `${col.name} pages in full`).toBe(
        col.totalCount,
      );
    }
  });

  it('gives the sprint a story-point spread (some estimated, some NULL) the header aggregates surface', async () => {
    const fx = await makeFixture();
    const m = await seed(fx);

    // The manifest's point spread: some estimated, some unestimated.
    expect(m.estimatedSprintIssueCount).toBeGreaterThan(0);
    expect(m.sprintIssueCount - m.estimatedSprintIssueCount, 'some unestimated').toBeGreaterThan(0);
    expect(m.committedPoints).toBeGreaterThan(0);

    // The projection's sprint summary reflects those aggregates: committed points
    // are positive, the NULL-estimate issues contribute 0 (no NaN), and the
    // remaining = committed − completed invariant holds (never negative).
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const sprint = board.sprint!;
    expect(Number.isNaN(sprint.points.committed)).toBe(false);
    expect(sprint.points.committed).toBeGreaterThan(0);
    expect(sprint.points.completed).toBeGreaterThanOrEqual(0);
    expect(sprint.points.remaining).toBe(
      Math.max(0, sprint.points.committed - sprint.points.completed),
    );
    // The seeded committed total matches the live aggregate sum.
    expect(sprint.points.committed).toBeCloseTo(m.committedPoints, 2);
  });
});
