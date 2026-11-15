import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import {
  BoardNotFoundError,
  InvalidBoardNameError,
  InvalidBoardTypeError,
  LastBoardError,
} from '@/lib/boards/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import {
  encodeFilterEnvelope,
  encodeFilterParam,
  type FilterAst,
  type FilterEnvelope,
} from '@/lib/filters/ast';
import {
  FilterTooLargeError,
  InvalidFilterValueError,
  MalformedFilterError,
  UnknownFilterFieldError,
  UnknownFilterOperatorError,
} from '@/lib/filters/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// boardsService board LIFECYCLE — multiple boards per project (Story 3.7 ·
// Subtask 3.7.3): createBoard (seed columns) / listBoards / setDefaultBoard /
// deleteBoard + the guards. Real Postgres (no mocks), per CLAUDE.md.
// createTestProject auto-seeds the DEFAULT board ("Board", isDefault, position
// a0) with one column per workflow status (3.1.2), so every fixture starts as a
// real one-board project.
//
// Authorization: board CRUD is a project-config write → workspace-OWNER-gated
// (finding #36 + the consistent build over the 3.7.3 card's "membership-gated"
// prose), so an owner succeeds and a plain member is denied (PermissionDeniedError).
// Tenancy (finding #26): a board/project from another workspace is a 404 (no
// cross-tenant existence leak).

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE →
  // project → board / board_column / board_column_status / work_item.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  workspaceId: string;
  projectId: string;
  /** The auto-seeded default board ("Board", isDefault, a0). */
  defaultBoardId: string;
}

async function makeFixture(label = 'a'): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `board-crud-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `CRUD WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });

  const member = await usersService.createUser({
    email: `board-crud-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Member',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: member.id, workspaceId, workspaceRole: 'member' },
  });

  const board = await withWorkspaceServiceContext(workspaceId, (tx) =>
    boardRepository.findDefaultForProject(project.id, workspaceId, tx),
  );
  if (!board) throw new Error('expected a seeded default board');

  return {
    ownerCtx: { userId: owner.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    defaultBoardId: board.id,
  };
}

describe('boardsService.createBoard (Subtask 3.7.3)', () => {
  it('creates a NON-default board with default columns seeded off the workflow', async () => {
    const fx = await makeFixture('create');
    const defaultCols = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnRepository.findByBoard(fx.defaultBoardId, fx.workspaceId, tx),
    );

    const created = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    expect(created).toMatchObject({ name: 'Triage', type: 'kanban', isDefault: false });
    // Appended after the default board's a0 position.
    expect(created.position > 'a0').toBe(true);

    // It seeded one column per workflow status (same shape as the default board),
    // each mapped to exactly one status.
    const cols = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnRepository.findByBoard(created.id, fx.workspaceId, tx),
    );
    expect(cols).toHaveLength(defaultCols.length);
    expect(defaultCols.length).toBeGreaterThan(0);
    const mappings = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByBoard(created.id, fx.workspaceId, tx),
    );
    expect(mappings).toHaveLength(cols.length);

    // The project's default is unchanged (still exactly one default).
    const defaults = await adminDb.board.count({
      where: { projectId: fx.projectId, isDefault: true },
    });
    expect(defaults).toBe(1);
  });

  it('accepts an explicit scrum type (the shipped enum, rung 2 — UI is Kanban-only)', async () => {
    const fx = await makeFixture('scrum');
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Sprint board', type: 'scrum' },
      fx.ownerCtx,
    );
    expect(created.type).toBe('scrum');
  });

  it('rejects an empty name (400) and an invalid type (400)', async () => {
    const fx = await makeFixture('invalid');
    await expect(
      boardsService.createBoard(fx.projectId, { name: '   ' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidBoardNameError);
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'X', type: 'gantt' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidBoardTypeError);
  });

  it('denies a plain member (403) and a cross-workspace project (404)', async () => {
    const fx = await makeFixture('authz');
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Nope' }, fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // A project in ANOTHER workspace, addressed with this owner's context → 404.
    const other = await makeFixture('authz-other');
    await expect(
      boardsService.createBoard(other.projectId, { name: 'Cross' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('boardsService.listBoards (Subtask 3.7.3)', () => {
  it('lists the project boards in switcher (position) order', async () => {
    const fx = await makeFixture('list');
    await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    const boards = await boardsService.listBoards(fx.projectId, fx.memberCtx); // a member may read
    expect(boards.map((b) => b.name)).toEqual(['Board', 'Triage']);
    expect(boards[0]).toMatchObject({ isDefault: true });
    expect(boards[1]).toMatchObject({ isDefault: false });
  });
});

describe('boardsService.setDefaultBoard (Subtask 3.7.3)', () => {
  it('promotes a board to default and clears the prior default (one-default invariant)', async () => {
    const fx = await makeFixture('setdefault');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    const updated = await boardsService.setDefaultBoard(triage.id, fx.ownerCtx);
    expect(updated).toMatchObject({ id: triage.id, isDefault: true });

    const rows = await adminDb.board.findMany({ where: { projectId: fx.projectId } });
    expect(rows.filter((b) => b.isDefault)).toHaveLength(1);
    expect(rows.find((b) => b.id === triage.id)?.isDefault).toBe(true);
    expect(rows.find((b) => b.id === fx.defaultBoardId)?.isDefault).toBe(false);
  });

  it('is a no-op when the board is already the default', async () => {
    const fx = await makeFixture('setdefault-noop');
    const updated = await boardsService.setDefaultBoard(fx.defaultBoardId, fx.ownerCtx);
    expect(updated).toMatchObject({ id: fx.defaultBoardId, isDefault: true });
    const defaults = await adminDb.board.count({
      where: { projectId: fx.projectId, isDefault: true },
    });
    expect(defaults).toBe(1);
  });

  it('denies a member (403) and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('setdefault-authz');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    await expect(boardsService.setDefaultBoard(triage.id, fx.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    const other = await makeFixture('setdefault-other');
    await expect(
      boardsService.setDefaultBoard(other.defaultBoardId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.deleteBoard (Subtask 3.7.3)', () => {
  it('deletes a non-default board + its columns/config, leaving the project issues intact', async () => {
    const fx = await makeFixture('delete');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    // A real issue on the project (belongs to the project, never a board).
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Survives a board delete' },
      fx.ownerCtx,
    );

    await boardsService.deleteBoard(triage.id, fx.ownerCtx);

    // The board + its column/config rows are gone (FK cascade)…
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        boardRepository.findById(triage.id, fx.workspaceId, tx),
      ),
    ).toBeNull();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        boardColumnRepository.findByBoard(triage.id, fx.workspaceId, tx),
      ),
    ).toHaveLength(0);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        boardColumnStatusRepository.findByBoard(triage.id, fx.workspaceId, tx),
      ),
    ).toHaveLength(0);
    // …the issue survives, and the default board is untouched.
    const workItemRow = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(workItemRow).not.toBeNull();
    const remaining = await adminDb.board.findMany({ where: { projectId: fx.projectId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(fx.defaultBoardId);
    expect(remaining[0]?.isDefault).toBe(true);
  });

  it('promotes the next board (by position) to default when the default is deleted', async () => {
    const fx = await makeFixture('delete-default');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    // Make Triage the default, so deleting it must promote the original Board.
    await boardsService.setDefaultBoard(triage.id, fx.ownerCtx);

    await boardsService.deleteBoard(triage.id, fx.ownerCtx);

    const rows = await adminDb.board.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fx.defaultBoardId);
    expect(rows[0]?.isDefault).toBe(true); // promoted — never a project with no default
  });

  it('refuses to delete the LAST board (409 LastBoardError)', async () => {
    const fx = await makeFixture('delete-last');
    await expect(boardsService.deleteBoard(fx.defaultBoardId, fx.ownerCtx)).rejects.toBeInstanceOf(
      LastBoardError,
    );
    // Still there.
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        boardRepository.findById(fx.defaultBoardId, fx.workspaceId, tx),
      ),
    ).not.toBeNull();
  });

  it('denies a member (403) and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('delete-authz');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    await expect(boardsService.deleteBoard(triage.id, fx.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    const other = await makeFixture('delete-other');
    await expect(
      boardsService.deleteBoard(other.defaultBoardId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

// ── The board's STORED filter (MOTIR-10560 · MOTIR-11331) — every write of
// `board.filter`: at create, and set / replace / clear in settings. Validated
// the way the toolbar's inline filter is (decode → referents → resolve); the
// stored value is the normalised envelope, a COPY of conditions.

const BUGS: FilterEnvelope = { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['bug']]] };
const URGENT_OR_TASK: FilterEnvelope = {
  v: 'v1',
  c: 'or',
  f: [
    ['priority', 'is_any_of', ['highest']],
    ['kind', 'is_any_of', ['task']],
  ],
};

async function storedFilter(boardId: string): Promise<unknown> {
  const row = await adminDb.board.findUniqueOrThrow({ where: { id: boardId } });
  return row.filter;
}

/** The SQL-level truth: NULL, never a JSON `null` value. */
async function filterIsSqlNull(boardId: string): Promise<boolean> {
  const rows = await adminDb.$queryRaw<Array<{ isnull: boolean }>>`
    SELECT filter IS NULL AS isnull FROM board WHERE id = ${boardId}`;
  return rows[0]!.isnull;
}

function tooMany(n: number): FilterEnvelope {
  return {
    v: 'v1',
    c: 'and',
    f: Array.from(
      { length: n },
      () => ['kind', 'is_any_of', ['bug']] as [string, string, string[]],
    ),
  };
}

describe('boardsService.createBoard — stored filter (MOTIR-11331)', () => {
  it('stores the normalised envelope of a valid filter', async () => {
    const fx = await makeFixture('sf-create');
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Urgent or task', filter: URGENT_OR_TASK },
      fx.ownerCtx,
    );
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'priority', operator: 'is_any_of', value: ['highest'] },
        { field: 'kind', operator: 'is_any_of', value: ['task'] },
      ],
    };
    expect(await storedFilter(created.id)).toEqual(encodeFilterEnvelope(ast));
  });

  it('normalises on write: unknown envelope keys are dropped', async () => {
    const fx = await makeFixture('sf-normalise');
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Bugs', filter: { ...BUGS, extra: 'ignored' } },
      fx.ownerCtx,
    );
    expect(await storedFilter(created.id)).toEqual(BUGS);
  });

  it('stores SQL NULL with no filter, a null filter, or zero conditions', async () => {
    const fx = await makeFixture('sf-null');
    const none = await boardsService.createBoard(fx.projectId, { name: 'None' }, fx.ownerCtx);
    const nul = await boardsService.createBoard(
      fx.projectId,
      { name: 'Null', filter: null },
      fx.ownerCtx,
    );
    const empty = await boardsService.createBoard(
      fx.projectId,
      { name: 'Empty', filter: { v: 'v1', c: 'and', f: [] } },
      fx.ownerCtx,
    );
    for (const b of [none, nul, empty]) expect(await filterIsSqlNull(b.id)).toBe(true);
  });

  it('keeps the copy byte-identical after the saved filter it came from is edited and deleted', async () => {
    const fx = await makeFixture('sf-copy');
    const bugAst: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    const saved = await savedFiltersService.create(
      'PROD',
      { name: 'Bugs', visibility: 'private', filterParam: encodeFilterParam(bugAst) },
      fx.ownerCtx,
    );
    // "Start from a saved filter" resolves client-side into conditions.
    const resolved = await savedFiltersService.resolve('PROD', saved.id, fx.ownerCtx);
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'From saved', filter: encodeFilterEnvelope(resolved.ast!) },
      fx.ownerCtx,
    );
    const before = JSON.stringify(await storedFilter(created.id));

    await savedFiltersService.delete('PROD', saved.id, fx.ownerCtx);

    expect(JSON.stringify(await storedFilter(created.id))).toBe(before);
    expect(await storedFilter(created.id)).toEqual(BUGS);
  });

  it.each([
    ['a non-object envelope', 'v1:abc', MalformedFilterError],
    ['a missing version', { c: 'and', f: [] }, MalformedFilterError],
    ['an unsupported version', { v: 'v9', c: 'and', f: [] }, MalformedFilterError],
    ['a bad combinator', { v: 'v1', c: 'xor', f: [] }, MalformedFilterError],
    ['a bad row shape', { v: 'v1', c: 'and', f: [['kind']] }, MalformedFilterError],
    [
      'an unknown field',
      { v: 'v1', c: 'and', f: [['nope', 'is_any_of', ['x']]] },
      UnknownFilterFieldError,
    ],
    [
      'an unknown operator',
      { v: 'v1', c: 'and', f: [['kind', 'gt', 3]] },
      UnknownFilterOperatorError,
    ],
    [
      'an invalid value',
      { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['dragon']]] },
      InvalidFilterValueError,
    ],
    ['21 conditions', tooMany(21), FilterTooLargeError],
  ])('refuses %s and creates no board', async (_label, filter, ErrorClass) => {
    const fx = await makeFixture(`sf-refuse-${String(_label).replace(/\W+/g, '-')}`);
    const before = await adminDb.board.count({ where: { projectId: fx.projectId } });
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Refused', filter }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(ErrorClass);
    expect(await adminDb.board.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('names the refused condition by its 0-based index, and none for a whole-filter refusal', async () => {
    const fx = await makeFixture('sf-refuse-index');
    const refusal = await boardsService
      .createBoard(
        fx.projectId,
        {
          name: 'Refused',
          filter: {
            v: 'v1',
            c: 'and',
            f: [
              ['kind', 'is_any_of', ['bug']],
              ['priority', 'is_any_of', ['high']],
              ['kind', 'is_any_of', ['dragon']],
            ],
          },
        },
        fx.ownerCtx,
      )
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(InvalidFilterValueError);
    expect((refusal as InvalidFilterValueError).conditionIndex).toBe(2);

    const whole = await boardsService
      .createBoard(fx.projectId, { name: 'Refused', filter: tooMany(21) }, fx.ownerCtx)
      .catch((err: unknown) => err);
    expect((whole as FilterTooLargeError).conditionIndex).toBeUndefined();
  });

  it('reports the condition count and the cap on the over-cap refusal', async () => {
    const fx = await makeFixture('sf-cap');
    const err = await boardsService
      .createBoard(fx.projectId, { name: 'Cap', filter: tooMany(23) }, fx.ownerCtx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilterTooLargeError);
    expect(err).toMatchObject({ code: 'FILTER_TOO_LARGE', rowCount: 23, cap: 20 });
  });

  it('accepts exactly 20 conditions', async () => {
    const fx = await makeFixture('sf-twenty');
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Twenty', filter: tooMany(20) },
      fx.ownerCtx,
    );
    expect(((await storedFilter(created.id)) as FilterEnvelope).f).toHaveLength(20);
  });

  it('accepts a stale label / component / option referent, stored as sent', async () => {
    const fx = await makeFixture('sf-stale');
    const stale: FilterEnvelope = {
      v: 'v1',
      c: 'and',
      f: [
        ['lbl', 'is_any_of', ['deleted-label-id']],
        ['cmp', 'is_any_of', ['deleted-component-id']],
      ],
    };
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Stale', filter: stale },
      fx.ownerCtx,
    );
    expect(await storedFilter(created.id)).toEqual(stale);
  });

  it("validates a cf:<id> condition against the field's real type", async () => {
    const fx = await makeFixture('sf-cf');
    const effort = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'effort',
        label: 'Effort',
        fieldType: 'number',
        position: 'a0',
      },
    });
    // A number field takes comparisons, not the enum list operators.
    await expect(
      boardsService.createBoard(
        fx.projectId,
        {
          name: 'Bad cf',
          filter: { v: 'v1', c: 'and', f: [[`cf:${effort.id}`, 'is_any_of', ['x']]] },
        },
        fx.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(UnknownFilterOperatorError);
    const ok: FilterEnvelope = { v: 'v1', c: 'and', f: [[`cf:${effort.id}`, 'gt', 3]] };
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Good cf', filter: ok },
      fx.ownerCtx,
    );
    expect(await storedFilter(created.id)).toEqual(ok);
  });

  it('runs the gate before the filter: a member is refused 403 even with an invalid filter', async () => {
    const fx = await makeFixture('sf-gate');
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Nope', filter: { v: 'v9' } }, fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('ensureScrumBoard creates its board with no stored filter', async () => {
    const fx = await makeFixture('sf-scrum');
    await boardsService.ensureScrumBoard(fx.projectId, fx.ownerCtx);
    const scrum = await adminDb.board.findFirstOrThrow({
      where: { projectId: fx.projectId, type: 'scrum' },
    });
    expect(await filterIsSqlNull(scrum.id)).toBe(true);
  });
});

describe('boardsService.setBoardFilter (MOTIR-11331)', () => {
  it('sets, replaces and clears the stored filter, returning the BoardDto', async () => {
    const fx = await makeFixture('sf-set');
    expect(await filterIsSqlNull(fx.defaultBoardId)).toBe(true);

    const set = await boardsService.setBoardFilter(fx.defaultBoardId, BUGS, fx.ownerCtx);
    expect(set).toMatchObject({ id: fx.defaultBoardId, filter: BUGS });
    expect(await storedFilter(fx.defaultBoardId)).toEqual(BUGS);

    const replaced = await boardsService.setBoardFilter(
      fx.defaultBoardId,
      URGENT_OR_TASK,
      fx.ownerCtx,
    );
    expect(replaced.filter).toEqual(URGENT_OR_TASK);
    expect(await storedFilter(fx.defaultBoardId)).toEqual(URGENT_OR_TASK);

    const cleared = await boardsService.setBoardFilter(fx.defaultBoardId, null, fx.ownerCtx);
    expect(cleared.filter).toBeNull();
    expect(await filterIsSqlNull(fx.defaultBoardId)).toBe(true);
  });

  it('clears to SQL NULL on an envelope with zero conditions', async () => {
    const fx = await makeFixture('sf-set-empty');
    await boardsService.setBoardFilter(fx.defaultBoardId, BUGS, fx.ownerCtx);
    const cleared = await boardsService.setBoardFilter(
      fx.defaultBoardId,
      { v: 'v1', c: 'or', f: [] },
      fx.ownerCtx,
    );
    expect(cleared.filter).toBeNull();
    expect(await filterIsSqlNull(fx.defaultBoardId)).toBe(true);
  });

  it('refuses an invalid or over-cap filter and leaves the stored filter unchanged', async () => {
    const fx = await makeFixture('sf-set-refuse');
    await boardsService.setBoardFilter(fx.defaultBoardId, BUGS, fx.ownerCtx);
    await expect(
      boardsService.setBoardFilter(
        fx.defaultBoardId,
        { v: 'v1', c: 'and', f: [['nope', 'is_any_of', []]] },
        fx.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(UnknownFilterFieldError);
    await expect(
      boardsService.setBoardFilter(fx.defaultBoardId, tooMany(21), fx.ownerCtx),
    ).rejects.toBeInstanceOf(FilterTooLargeError);
    await expect(
      boardsService.setBoardFilter(fx.defaultBoardId, 'not-an-envelope', fx.ownerCtx),
    ).rejects.toBeInstanceOf(MalformedFilterError);
    expect(await storedFilter(fx.defaultBoardId)).toEqual(BUGS);
  });

  it('denies a member (403) and 404s a cross-workspace board, leaving the filter unchanged', async () => {
    const fx = await makeFixture('sf-set-authz');
    await expect(
      boardsService.setBoardFilter(fx.defaultBoardId, BUGS, fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const other = await makeFixture('sf-set-authz-other');
    await expect(
      boardsService.setBoardFilter(other.defaultBoardId, BUGS, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
    expect(await filterIsSqlNull(fx.defaultBoardId)).toBe(true);
    expect(await filterIsSqlNull(other.defaultBoardId)).toBe(true);
  });

  it('carries the stored filter on renameBoard and setSwimlaneGroupBy responses', async () => {
    const fx = await makeFixture('sf-dto');
    const renamedBare = await boardsService.renameBoard(fx.defaultBoardId, 'Plain', fx.ownerCtx);
    expect(renamedBare.filter).toBeNull();
    await boardsService.setBoardFilter(fx.defaultBoardId, BUGS, fx.ownerCtx);
    const renamed = await boardsService.renameBoard(fx.defaultBoardId, 'Bugs', fx.ownerCtx);
    expect(renamed.filter).toEqual(BUGS);
    const grouped = await boardsService.setSwimlaneGroupBy(
      fx.defaultBoardId,
      'priority',
      fx.ownerCtx,
    );
    expect(grouped.filter).toEqual(BUGS);
  });
});
