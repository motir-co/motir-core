import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveSelectedBoardId } from '@/app/(authed)/settings/project/board/page';
import type { FilterAst, FilterEnvelope } from '@/lib/filters/ast';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The board read's unmapped-status lists over a REAL Postgres (MOTIR-11658).
// The fixture is the "Bugs to fix" board that raised it: Done and Cancelled are
// mapped to no column on purpose, and the board's stored filter keeps only the
// open statuses. `unmappedStatusesInScope` (what the tray names) follows the
// EFFECTIVE filter — the header filter, else the stored one, unless
// `boardFilter=off` — while `unmappedStatuses` (what Board settings lists) stays
// every unmapped status whatever the filter.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  boardId: string;
  /** Every status key of the project's workflow except Done and Cancelled. */
  openKeys: string[];
}

let seq = 0;

const env = (c: 'and' | 'or', ...f: FilterEnvelope['f']): FilterEnvelope => ({ v: 'v1', c, f });
const ast = (combinator: 'and' | 'or', ...conditions: FilterAst['conditions']): FilterAst => ({
  combinator,
  conditions,
});

async function makeFixture(): Promise<Fixture> {
  const n = seq++;
  const user = await usersService.createUser({
    email: `unmapped-scope-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Board Admin',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Unmapped scope WS ${n}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    identifier: `UM${n}`,
  });
  const ctx = { userId: user.id, workspaceId };
  const board = await adminDb.board.findFirstOrThrow({ where: { projectId: project.id } });
  const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: project.id } });
  // Leave Done and Cancelled off the board's columns, through the shipped write.
  for (const s of statuses.filter((st) => st.key === 'done' || st.key === 'cancelled')) {
    await boardsService.unmapStatus(board.id, s.id, ctx);
  }
  return {
    ctx,
    projectId: project.id,
    boardId: board.id,
    openKeys: statuses.map((s) => s.key).filter((k) => k !== 'done' && k !== 'cancelled'),
  };
}

const keys = (list: { key: string }[]) => list.map((s) => s.key).sort();
const read = (fx: Fixture, filter?: Parameters<typeof boardsService.getBoard>[3]) =>
  boardsService.getBoard(fx.projectId, fx.ctx, fx.boardId, filter);

function expectAllUnmapped(board: BoardProjectionDto) {
  expect(keys(board.unmappedStatuses)).toEqual(['cancelled', 'done']);
}

describe('board read — unmapped statuses in the filter’s scope (MOTIR-11658)', () => {
  it('a stored filter of the open statuses AND Kind is Bug leaves the tray empty (criterion 1)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['kind', 'is_any_of', ['bug']], ['status', 'is_any_of', fx.openKeys]),
      fx.ctx,
    );
    const board = await read(fx);
    expectAllUnmapped(board);
    expect(board.unmappedStatusesInScope).toEqual([]);
  });

  it('a status list naming Done keeps Done only (criterion 2)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_any_of', [...fx.openKeys, 'done']], ['kind', 'is_any_of', ['bug']]),
      fx.ctx,
    );
    const board = await read(fx);
    expectAllUnmapped(board);
    expect(keys(board.unmappedStatusesInScope)).toEqual(['done']);
  });

  it('Status is none of Cancelled keeps Done only (criterion 3)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_none_of', ['cancelled']]),
      fx.ctx,
    );
    expect(keys((await read(fx)).unmappedStatusesInScope)).toEqual(['done']);
  });

  it('no filter, or boardFilter=off, names every unmapped status (criterion 4)', async () => {
    const fx = await makeFixture();
    const unfiltered = await read(fx);
    expect(keys(unfiltered.unmappedStatusesInScope)).toEqual(['cancelled', 'done']);

    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_any_of', fx.openKeys]),
      fx.ctx,
    );
    const off = await read(fx, { storedFilterOff: true });
    expectAllUnmapped(off);
    expect(keys(off.unmappedStatusesInScope)).toEqual(['cancelled', 'done']);
  });

  it('a header filter with no status row replaces the stored one, so Done is named again (criterion 5)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_none_of', ['done']]),
      fx.ctx,
    );
    expect(keys((await read(fx)).unmappedStatusesInScope)).toEqual(['cancelled']);

    const headered = await read(fx, {
      ast: ast('and', { field: 'kind', operator: 'is_any_of', value: ['bug'] }),
    });
    expect(keys(headered.unmappedStatusesInScope)).toEqual(['cancelled', 'done']);

    // And a header filter's own status row narrows exactly as a stored one does.
    const headerStatus = await read(fx, {
      ast: ast('and', { field: 'status', operator: 'is_any_of', value: fx.openKeys }),
    });
    expect(headerStatus.unmappedStatusesInScope).toEqual([]);
  });

  it('a status row under an OR combinator does not narrow the tray (criterion 6)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('or', ['kind', 'is_any_of', ['bug']], ['status', 'is_any_of', fx.openKeys]),
      fx.ctx,
    );
    expect(keys((await read(fx)).unmappedStatusesInScope)).toEqual(['cancelled', 'done']);
  });

  it('Board settings still lists every unmapped status under an excluding filter (criterion 7)', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_any_of', fx.openKeys]),
      fx.ctx,
    );
    // The settings page's own read: resolve `?board=` → getBoard with no header filter.
    const settings = await boardsService.getBoard(
      fx.projectId,
      fx.ctx,
      resolveSelectedBoardId(fx.boardId),
    );
    expectAllUnmapped(settings);
    expect(settings.unmappedStatusesInScope).toEqual([]);
  });

  it('a stored filter that no longer reads keeps every unmapped status in the tray', async () => {
    const fx = await makeFixture();
    await adminDb.board.update({ where: { id: fx.boardId }, data: { filter: { v: 'nope' } } });
    expect(keys((await read(fx)).unmappedStatusesInScope)).toEqual(['cancelled', 'done']);
  });

  it('a scrum board with no active sprint narrows the tray by its filter too', async () => {
    const fx = await makeFixture();
    await boardsService.setBoardFilter(
      fx.boardId,
      env('and', ['status', 'is_none_of', ['done']]),
      fx.ctx,
    );
    await adminDb.board.update({ where: { id: fx.boardId }, data: { type: 'scrum' } });
    const board = await read(fx);
    expect(board.sprint).toBeNull();
    expectAllUnmapped(board);
    expect(keys(board.unmappedStatusesInScope)).toEqual(['cancelled']);
  });
});
