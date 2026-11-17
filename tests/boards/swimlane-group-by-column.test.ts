import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Schema check for the `board.swimlaneGroupBy` enum column (Story 3.3 ·
// Subtask 3.3.2). Real Postgres — proves the migration's CREATE TYPE +
// ADD COLUMN: a freshly-seeded board defaults to `none` (the flat 3.2 board,
// no backfill), and the column accepts each `BoardSwimlaneGroupBy` value.
//
// This subtask is schema-only: the config write SERVICE is 3.3.3 and the
// projection that consumes the value is 3.3.4 — so this test exercises the
// column directly via Prisma (the `prodect` test role bypasses RLS, the same
// reach the default-board seed test uses).
//
// truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
// cascades to project → board, so no dedicated board truncate is needed.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedBoard(label = 'swimlane'): Promise<{ boardId: string }> {
  const user = await usersService.createUser({
    email: `${label}@example.com`,
    password: 'hunter2hunter2',
    name: `Swimlane ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Swimlane WS ${label}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: 'Swimlaned',
  });
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  return { boardId: board.id };
}

describe('board.swimlaneGroupBy enum column (Subtask 3.3.2)', () => {
  it('defaults a freshly-seeded board to `none` (the flat 3.2 board, no backfill)', async () => {
    const { boardId } = await seedBoard('default');
    const board = await adminDb.board.findUniqueOrThrow({ where: { id: boardId } });
    expect(board.swimlaneGroupBy).toBe(BoardSwimlaneGroupBy.none);
  });

  it('accepts each BoardSwimlaneGroupBy value and persists it', async () => {
    const { boardId } = await seedBoard('accepts');
    // Every value the stub specifies, including a round-trip back to `none`.
    const values: BoardSwimlaneGroupBy[] = [
      BoardSwimlaneGroupBy.assignee,
      BoardSwimlaneGroupBy.epic,
      BoardSwimlaneGroupBy.priority,
      BoardSwimlaneGroupBy.none,
    ];
    for (const value of values) {
      const updated = await adminDb.board.update({
        where: { id: boardId },
        data: { swimlaneGroupBy: value },
      });
      expect(updated.swimlaneGroupBy).toBe(value);
      // Re-read to prove it persisted, not just echoed by the update return.
      const reread = await adminDb.board.findUniqueOrThrow({ where: { id: boardId } });
      expect(reread.swimlaneGroupBy).toBe(value);
    }
  });

  it('exposes exactly the stub-specified values plus the MOTIR-11585 fields', () => {
    expect(Object.values(BoardSwimlaneGroupBy).sort()).toEqual(
      [
        'assignee',
        'epic',
        'none',
        'priority',
        'reporter',
        'type',
        'difficulty',
        'executor',
        'kind',
        'label',
        'component',
        'repository',
      ].sort(),
    );
  });
});
