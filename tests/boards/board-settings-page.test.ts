import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { BoardNotFoundError } from '@/lib/boards/errors';
import { resolveSelectedBoardId } from '@/app/(authed)/settings/project/board/page';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Board SETTINGS page resolution (Story 3.7 · Subtask 3.7.8). The per-board
// settings page reads `?board=<id>` and builds its config model from THAT board's
// projection — exactly the `resolveSelectedBoardId(sp.board)` →
// `boardsService.getBoard(projectId, ctx, selectedBoardId)` path the page runs.
// These tests drive that contract over a REAL Postgres (no mocks, per CLAUDE.md):
//   - the param parsing (blank/whitespace → absent → the default board);
//   - selected vs default resolution;
//   - a cross-tenant / unknown id → BoardNotFoundError (the page's tenant-safe
//     not-found state, never a cross-tenant read).
// The selected-board read itself is exercised more broadly by board-selection
// (3.7.5); this file pins the PAGE's use of it.

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
  defaultBoardId: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email: `board-settings-page-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Settings User',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Settings WS ${label}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: user.id });
  const board = await withWorkspaceServiceContext(workspaceId, (tx) =>
    boardRepository.findDefaultForProject(project.id, workspaceId, tx),
  );
  if (!board) throw new Error('expected a seeded default board');
  return {
    ctx: { userId: user.id, workspaceId },
    workspaceId,
    projectId: project.id,
    defaultBoardId: board.id,
  };
}

/** Replicates the page's resolve → getBoard path for a given `?board=` value. */
function loadSettingsBoard(fx: Fixture, boardParam: string | undefined) {
  const selectedBoardId = resolveSelectedBoardId(boardParam);
  return boardsService.getBoard(fx.projectId, fx.ctx, selectedBoardId);
}

describe('resolveSelectedBoardId (3.7.8 param parsing)', () => {
  it('treats undefined / blank / whitespace as absent (→ default board)', () => {
    expect(resolveSelectedBoardId(undefined)).toBeUndefined();
    expect(resolveSelectedBoardId('')).toBeUndefined();
    expect(resolveSelectedBoardId('   ')).toBeUndefined();
  });
  it('returns a non-blank id (trimmed)', () => {
    expect(resolveSelectedBoardId('b2')).toBe('b2');
    expect(resolveSelectedBoardId('  b2  ')).toBe('b2');
  });
});

describe('Board settings page — ?board= resolution (Subtask 3.7.8)', () => {
  it('configures the SELECTED board when ?board=<id> names a non-default board', async () => {
    const fx = await makeFixture('selected');
    const second = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ctx);

    const model = await loadSettingsBoard(fx, second.id);
    expect(model.boardId).toBe(second.id);
    expect(model.name).toBe('Triage');
    expect(model.boardId).not.toBe(fx.defaultBoardId);
  });

  it('configures the project DEFAULT board when ?board= is absent or blank', async () => {
    const fx = await makeFixture('default');
    await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ctx);

    for (const param of [undefined, '', '   ']) {
      const model = await loadSettingsBoard(fx, param);
      expect(model.boardId).toBe(fx.defaultBoardId);
      expect(model.name).toBe('Board');
    }
  });

  it('not-founds a ?board= id from another WORKSPACE (tenant-safe — the page renders not-found)', async () => {
    const a = await makeFixture('tenant-a');
    const b = await makeFixture('tenant-b');
    await expect(loadSettingsBoard(a, b.defaultBoardId)).rejects.toBeInstanceOf(BoardNotFoundError);
  });

  it('not-founds an unknown ?board= id', async () => {
    const fx = await makeFixture('unknown');
    await expect(loadSettingsBoard(fx, 'brd_nope')).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});
