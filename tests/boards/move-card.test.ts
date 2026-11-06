import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  IllegalBoardMoveError,
  UnmappedColumnTargetError,
} from '@/lib/boards/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { spyOnJobDispatch } from '../helpers/jobs';

// boardsService.moveCard (Story 3.1 · Subtask 3.1.5). Real Postgres (no mocks),
// per CLAUDE.md. The project comes from createTestProject (→ createProject,
// which auto-seeds the default workflow: statuses todo / blocked / in_progress
// / in_review / done / cancelled in that position order, `restricted` policy,
// transitions todo→in_progress legal, todo→done NOT). The board rows are
// inserted directly here (the default-board seed is 3.1.2, not yet built) — the
// move path under test only reads/writes them.

beforeEach(async () => {
  // Stub the Inngest publish: the status-transition paths now emit
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  spyOnJobDispatch();
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE →
  // project → board / board_column / board_column_status / work_item.
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
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
  // status key → column id (the per-status board)
  columns: Record<string, string>;
  // A SECOND board in the same project. `@@unique([boardId, statusId])` forbids
  // a status mapping to two columns on the SAME board, so the multi-status +
  // unmapped columns live on their own board (a project may own many boards).
  multiBoardId: string;
  multiColumnId: string; // on multiBoard — maps [in_progress, in_review]
  unmappedColumnId: string; // on multiBoard — maps nothing
}

let positionCounter = 0;
function nextColumnPosition(): string {
  positionCounter += 1;
  return `c${positionCounter.toString(36)}`;
}

async function makeFixture(email = 'move-a@example.com'): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Move User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Move WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const workspaceId = ws.workspace.id;

  const statuses = await workflowsService.listStatusesByProject(project.id, workspaceId);
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));

  const board = await adminDb.board.create({
    data: { workspaceId, projectId: project.id, name: 'Board', type: 'kanban', position: 'a0' },
  });

  // One single-status column per status (the default-board projection shape).
  const columns: Record<string, string> = {};
  for (const s of statuses) {
    const col = await adminDb.boardColumn.create({
      data: {
        workspaceId,
        projectId: project.id,
        boardId: board.id,
        name: s.label,
        position: nextColumnPosition(),
      },
    });
    columns[s.key] = col.id;
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId,
        projectId: project.id,
        boardId: board.id,
        columnId: col.id,
        statusId: s.id,
      },
    });
  }

  // A SECOND board (same project) hosting the multi-status + unmapped columns,
  // so they don't collide with board 1's per-status mappings under
  // `@@unique([boardId, statusId])`.
  const multiBoard = await adminDb.board.create({
    data: {
      workspaceId,
      projectId: project.id,
      name: 'Working Board',
      type: 'kanban',
      position: 'a1',
    },
  });

  // A multi-status column mapping BOTH in_progress and in_review (the Jira
  // "merge In Progress + In Review" shape). in_progress sorts before in_review,
  // so it is the first-by-position pick.
  const multi = await adminDb.boardColumn.create({
    data: {
      workspaceId,
      projectId: project.id,
      boardId: multiBoard.id,
      name: 'Working',
      position: nextColumnPosition(),
    },
  });
  for (const key of ['in_review', 'in_progress']) {
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId,
        projectId: project.id,
        boardId: multiBoard.id,
        columnId: multi.id,
        statusId: statusIdByKey.get(key)!,
      },
    });
  }

  // An unmapped column — no board_column_status rows at all.
  const unmapped = await adminDb.boardColumn.create({
    data: {
      workspaceId,
      projectId: project.id,
      boardId: multiBoard.id,
      name: 'Orphan',
      position: nextColumnPosition(),
    },
  });

  return {
    ctx,
    workspaceId,
    projectId: project.id,
    boardId: board.id,
    columns,
    multiBoardId: multiBoard.id,
    multiColumnId: multi.id,
    unmappedColumnId: unmapped.id,
  };
}

async function makeItem(fx: Fixture, title = 'Card'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.id; // lands in 'todo' (initial)
}

async function statusOf(fx: Fixture, itemId: string): Promise<string> {
  return (await workItemsService.getWorkItem(itemId, fx.ctx)).status;
}

async function positionOf(itemId: string): Promise<string> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
  return row.position;
}

async function revisionCount(itemId: string, workspaceId: string): Promise<number> {
  return (
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRevisionRepository.listByWorkItem(itemId, {}, tx),
    )
  ).length;
}

describe('moveCard — cross-column move = workflow transition', () => {
  it('a legal cross-column move changes status (via the workflow path) AND rank', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);

    const result = await boardsService.moveCard(
      fx.boardId,
      id,
      { toColumnId: fx.columns['in_progress']! },
      fx.ctx,
    );

    expect(result.appliedStatus).toBe('in_progress');
    expect(result.card.status).toBe('in_progress');
    expect(result.column.id).toBe(fx.columns['in_progress']);
    expect(await statusOf(fx, id)).toBe('in_progress');
    // The persisted rank matches what the move returned (rank-change mechanics
    // are exercised by the in-column reorder test, which passes a neighbour).
    expect(await positionOf(id)).toBe(result.card.position);
  });

  it('an illegal cross-column transition under restricted policy → IllegalBoardMoveError, no mutation', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);
    const posBefore = await positionOf(id);
    const revsBefore = await revisionCount(id, fx.workspaceId);

    // todo → done has no seed transition edge → illegal under restricted.
    await expect(
      boardsService.moveCard(fx.boardId, id, { toColumnId: fx.columns['done']! }, fx.ctx),
    ).rejects.toBeInstanceOf(IllegalBoardMoveError);

    // The snapback contract: status, rank, and history are all untouched.
    expect(await statusOf(fx, id)).toBe('todo');
    expect(await positionOf(id)).toBe(posBefore);
    expect(await revisionCount(id, fx.workspaceId)).toBe(revsBefore);
  });

  it('a drop onto an unmapped column → UnmappedColumnTargetError', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);
    await expect(
      boardsService.moveCard(fx.multiBoardId, id, { toColumnId: fx.unmappedColumnId }, fx.ctx),
    ).rejects.toBeInstanceOf(UnmappedColumnTargetError);
  });

  it('a multi-status target column resolves to the FIRST status by position (Jira rule)', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx); // todo
    // The "Working" column maps [in_progress, in_review]; in_progress sorts
    // first, and todo→in_progress is legal — so the card lands in in_progress.
    const result = await boardsService.moveCard(
      fx.multiBoardId,
      id,
      { toColumnId: fx.multiColumnId },
      fx.ctx,
    );
    expect(result.appliedStatus).toBe('in_progress');
    expect(await statusOf(fx, id)).toBe('in_progress');
  });

  it('a drop into a multi-status column that already holds the card’s status changes ONLY rank', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);
    const neighbour = await makeItem(fx, 'Neighbour');
    await workItemsService.updateStatus(id, 'in_progress', fx.ctx); // now in_progress
    const revsBefore = await revisionCount(id, fx.workspaceId);
    const posBefore = await positionOf(id);

    // Drop AFTER the neighbour so the rank genuinely moves; in_progress is
    // already mapped by the target column, so NO transition should be attempted.
    const result = await boardsService.moveCard(
      fx.multiBoardId,
      id,
      { toColumnId: fx.multiColumnId, beforeId: neighbour },
      fx.ctx,
    );

    expect(result.appliedStatus).toBe('in_progress');
    expect(await statusOf(fx, id)).toBe('in_progress');
    expect(await revisionCount(id, fx.workspaceId)).toBe(revsBefore); // no new 'updated' revision
    expect(await positionOf(id)).toBe(result.card.position);
    expect(await positionOf(id)).not.toBe(posBefore); // rank recomputed (after neighbour)
    expect((await positionOf(id)) > (await positionOf(neighbour))).toBe(true);
  });
});

describe('moveCard — in-column reorder = pure rank change', () => {
  it('reorders within a column without attempting a transition or writing a revision', async () => {
    const fx = await makeFixture();
    const a = await makeItem(fx, 'A');
    const b = await makeItem(fx, 'B');
    const revsBefore = await revisionCount(a, fx.workspaceId);

    // Move A within the To Do column to sit AFTER B (B is the card above the
    // drop slot; nothing below) → A's rank changes, status stays todo.
    const result = await boardsService.moveCard(
      fx.boardId,
      a,
      { toColumnId: fx.columns['todo']!, beforeId: b },
      fx.ctx,
    );

    expect(result.appliedStatus).toBe('todo');
    expect(await statusOf(fx, a)).toBe('todo');
    expect(await revisionCount(a, fx.workspaceId)).toBe(revsBefore); // no status revision
    expect(await positionOf(a)).toBe(result.card.position);
    expect((await positionOf(a)) > (await positionOf(b))).toBe(true); // sorts after B now
  });

  it("a drop under the LAST LOADED card lands right after it, not at the lane's far end (MOTIR-10535)", async () => {
    // A paged lane: the client holds only A (the first page); B and C are on a
    // page it has not loaded. Dropping D under A sends `beforeId: A` and no
    // `afterId` — D must rank between A and its true successor B, exactly
    // where the user saw it land, not after C at the end of the whole lane.
    const fx = await makeFixture();
    const a = await makeItem(fx, 'A');
    const b = await makeItem(fx, 'B');
    const c = await makeItem(fx, 'C');
    const d = await makeItem(fx, 'D');
    await adminDb.workItem.update({ where: { id: d }, data: { status: 'in_progress' } });

    await boardsService.moveCard(
      fx.boardId,
      d,
      { toColumnId: fx.columns['todo']!, beforeId: a },
      fx.ctx,
    );

    const pa = await positionOf(a);
    const pb = await positionOf(b);
    const pc = await positionOf(c);
    const pd = await positionOf(d);
    expect(pd > pa).toBe(true);
    expect(pd < pb).toBe(true);
    expect(pb < pc).toBe(true);
  });

  it('a missing rank neighbour id → WorkItemNotFoundError', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);
    await expect(
      boardsService.moveCard(
        fx.boardId,
        id,
        { toColumnId: fx.columns['todo']!, beforeId: 'no-such-item' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('moveCard — not-found + tenant scoping', () => {
  it('an unknown board id → BoardNotFoundError', async () => {
    const fx = await makeFixture();
    const id = await makeItem(fx);
    await expect(
      boardsService.moveCard('no-such-board', id, { toColumnId: fx.columns['todo']! }, fx.ctx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });

  it('a column id that belongs to another board → BoardColumnNotFoundError', async () => {
    const fx = await makeFixture();
    const other = await makeFixture('move-other@example.com');
    const id = await makeItem(fx);
    // fx's board, but a column id from the OTHER fixture's board.
    await expect(
      boardsService.moveCard(fx.boardId, id, { toColumnId: other.columns['todo']! }, fx.ctx),
    ).rejects.toBeInstanceOf(BoardColumnNotFoundError);
  });

  it('moving with a foreign workspace ctx → BoardNotFoundError (no cross-tenant move)', async () => {
    const fx = await makeFixture('move-w1@example.com');
    const id = await makeItem(fx);
    const userB = await usersService.createUser({
      email: 'move-w2@example.com',
      password: 'hunter2hunter2',
      name: 'Move W2',
    });
    const w2 = await workspacesService.createWorkspace({ name: 'Move W2', ownerUserId: userB.id });
    const ctxB: ServiceContext = { userId: userB.id, workspaceId: w2.workspace.id };
    // The board is in W1; W2's ctx must not see it. `BoardNotFoundError` is the
    // DECIDED answer, not the one that happened to fall out (MOTIR-2952): the
    // service used to lock the card before resolving the board, so this case
    // answered `BoardNotFoundError` as the BYPASSRLS owner and
    // `WorkItemNotFoundError` as `motir_app` — one boundary, two errors, chosen
    // by the connection. `moveCard` now resolves the board first, which is the
    // only workspace-filtered gate of the two, so the answer is the same in
    // every mode. Verdict + rejected alternative:
    // docs/decisions/public-api-conventions.md §4.
    await expect(
      boardsService.moveCard(fx.boardId, id, { toColumnId: fx.columns['in_progress']! }, ctxB),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});
