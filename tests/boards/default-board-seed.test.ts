import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Default-board seed (Story 3.1 · Subtask 3.1.2). Real Postgres — runs in CI.
// Proves the board seed wired into createProject (same transaction → atomic
// with the project + workflow), the column-from-workflow projection (one column
// per status, in workflow order, each mapped to its status), and the
// idempotent one-off backfill.
//
// truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
// cascades to project → board / board_column / board_column_status, so no
// dedicated board truncate is needed.

const WORKFLOW_ORDER = [
  'To Do',
  'Blocked',
  'In Progress',
  // MOTIR-3003 — built, pull request open, CI not yet green; before `planning`
  // because slot 4 is the last board column a laptop shows in full.
  'Implemented',
  'Planning',
  // MOTIR-10139 — planned, but a decision it rests on was corrected since.
  'To plan',
  'In Review',
  // MOTIR-5139 — a person's YES, between review and the merge.
  'Approved',
  'Done',
  'Cancelled',
];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeWorkspaceAndUser(
  label = 'board-seed',
): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: `${label}@example.com`,
    password: 'hunter2hunter2',
    name: `Board Seed ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Board Seed WS ${label}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: ws.workspace.id };
}

describe('createProject seeds the default board (same transaction)', () => {
  it('a fresh project ends with exactly one Kanban board named "Board"', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Boarded',
    });

    const boards = await adminDb.board.findMany({ where: { projectId: project.id } });
    expect(boards).toHaveLength(1);
    expect(boards[0]?.name).toBe('Board');
    expect(boards[0]?.type).toBe('kanban');
    expect(boards[0]?.workspaceId).toBe(workspaceId);
  });

  it('seeds one column per workflow status, in order, each mapped 1:1', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Columns',
    });

    const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
    const columns = await adminDb.boardColumn.findMany({
      where: { boardId: board.id },
      orderBy: { position: 'asc' },
    });
    expect(columns.map((c) => c.name)).toEqual(WORKFLOW_ORDER);

    // Column positions mirror the workflow-status positions (same order).
    const statuses = await adminDb.workflowStatus.findMany({
      where: { projectId: project.id },
      orderBy: { position: 'asc' },
    });
    expect(columns.map((c) => c.position)).toEqual(statuses.map((s) => s.position));

    // Exactly one mapping per column, pointing at the same-labelled status.
    const mappings = await adminDb.boardColumnStatus.findMany({ where: { boardId: board.id } });
    // Seven since MOTIR-2425 added `planning`. The count is stated rather than
    // derived so adding a status is a deliberate edit here.
    expect(mappings).toHaveLength(WORKFLOW_ORDER.length);

    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const columnById = new Map(columns.map((c) => [c.id, c]));
    for (const m of mappings) {
      expect(m.workspaceId).toBe(workspaceId);
      // The default is 1:1: the mapped status's label equals its column's name.
      expect(statusById.get(m.statusId)?.label).toBe(columnById.get(m.columnId)?.name);
    }
    // Every status is mapped exactly once (no unmapped status in the default).
    expect(new Set(mappings.map((m) => m.statusId)).size).toBe(WORKFLOW_ORDER.length);
    expect(new Set(mappings.map((m) => m.columnId)).size).toBe(WORKFLOW_ORDER.length);
  });

  it('does not leak the board into another project in the same workspace', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const a = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Alpha',
    });
    const b = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Beta',
    });
    const boardCount = await adminDb.board.count({ where: { projectId: a.id } });
    expect(boardCount).toBe(1);
    const boardCount2 = await adminDb.board.count({ where: { projectId: b.id } });
    expect(boardCount2).toBe(1);
    // Each board's columns belong only to that project.
    const aBoard = await adminDb.board.findFirstOrThrow({ where: { projectId: a.id } });
    const aCols = await adminDb.boardColumn.findMany({ where: { boardId: aBoard.id } });
    expect(aCols.every((c) => c.projectId === a.id)).toBe(true);
  });
});

describe('boardsService.backfillDefaultBoard (one-off, idempotent)', () => {
  it('seeds a board for a board-less project, then no-ops on a second call', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    // A project WITH its workflow but no board — mimics a project predating
    // this Story. Build it via createProject (so it has the six statuses), then
    // drop its board (cascades to columns + mappings).
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Predates',
    });
    await adminDb.board.deleteMany({ where: { projectId: project.id } });
    const boardCount = await adminDb.board.count({ where: { projectId: project.id } });
    expect(boardCount).toBe(0);

    const seeded = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(seeded).toBe(true);
    const boardCount2 = await adminDb.board.count({ where: { projectId: project.id } });
    expect(boardCount2).toBe(1);
    const boardColumnCount = await adminDb.boardColumn.count({ where: { projectId: project.id } });
    expect(boardColumnCount).toBe(WORKFLOW_ORDER.length);
    const boardColumnStatusCount = await adminDb.boardColumnStatus.count({
      where: { projectId: project.id },
    });
    expect(boardColumnStatusCount).toBe(WORKFLOW_ORDER.length);

    // Idempotent — already has a board, so the second call is a no-op and adds
    // no duplicate board/columns.
    const again = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(again).toBe(false);
    const boardCount3 = await adminDb.board.count({ where: { projectId: project.id } });
    expect(boardCount3).toBe(1);
    const boardColumnCount2 = await adminDb.boardColumn.count({ where: { projectId: project.id } });
    expect(boardColumnCount2).toBe(WORKFLOW_ORDER.length);
  });

  it('leaves an already-boarded project untouched (no second board)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'AlreadyBoarded',
    });
    const seeded = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(seeded).toBe(false);
    const boardCount = await adminDb.board.count({ where: { projectId: project.id } });
    expect(boardCount).toBe(1);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    const { userId } = await makeWorkspaceAndUser();
    await expect(
      boardsService.backfillDefaultBoard('nonexistent-id', userId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
