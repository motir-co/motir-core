import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { encodeFilterParam, facetFilterToAst, type FilterAst } from '@/lib/filters/ast';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import type { ProjectContext } from '@/lib/projects';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type {
  BoardCellPageDto,
  BoardColumnPageDto,
  BoardLanePageDto,
  BoardProjectionDto,
} from '@/lib/dto/boards';
import { spyOnJobDispatch } from '../helpers/jobs';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Board API routes (Story 3.1 · Subtask 3.1.6). Real Postgres; we stub only the
// two session/context resolvers the test env can't supply via cookies
// (getSession, getActiveProject) — every DB read/write goes through the real
// service → repo → Prisma chain. This asserts the TRANSPORT contract (status
// codes + the typed-error → HTTP mapping); the projection/move behaviour itself
// is covered by 3.1.4 / 3.1.5.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// Import AFTER the mocks are registered.
const { GET: boardGET, PATCH: boardPATCH } = await import('@/app/api/board/route');
const { PATCH: columnPATCH } = await import('@/app/api/board/columns/[columnId]/route');
const { POST: movePOST } = await import('@/app/api/board/move/route');
const { GET: pageGET } = await import('@/app/api/board/columns/[columnId]/cards/route');
const { GET: laneGET } = await import('@/app/api/board/lanes/[laneKey]/cells/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
  // Stub the Inngest publish: a cross-column move now emits
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'board-routes@example.com',
    password: 'hunter2hunter2',
    name: 'Board Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Board WS', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Board Demo',
    identifier: 'BRD',
  });
  const fx = { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
  session.current = {
    user: { id: owner.id, email: 'board-routes@example.com', name: 'Board Owner' },
  };
  activeCtx.current = { ...fx, project };
  return fx;
}

function moveReq(body: unknown) {
  return movePOST(
    new Request(`${BASE}/api/board/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// GET /api/board now reads a `?boardId=` selection (Subtask 3.7.5), so the
// handler needs a real Request. `query` lets a test target a specific board;
// omitted → the project's default board (the pre-3.7 behaviour).
function boardGetReq(query = '') {
  return boardGET(new Request(`${BASE}/api/board${query}`));
}

function boardPatchReq(body: unknown) {
  return boardPATCH(
    new Request(`${BASE}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function columnPatchReq(columnId: string, body: unknown) {
  return columnPATCH(
    new Request(`${BASE}/api/board/columns/${columnId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ columnId }) },
  );
}

describe('board API routes', () => {
  it('GET /api/board → 401 without a session', async () => {
    session.current = null;
    const res = await boardGetReq();
    expect(res.status).toBe(401);
  });

  it('GET /api/board → the projection for the active project', async () => {
    await makeFixture();
    const res = await boardGetReq();
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    expect(board.columns.map((c) => c.statusKeys[0])).toEqual([
      'todo',
      'blocked',
      'in_progress',
      // MOTIR-3003 — built, pull request open, CI not yet green.
      'implemented',
      'planning',
      'in_review',
      // MOTIR-5139 — a person's YES, between review and the merge.
      'approved',
      'done',
      'cancelled',
    ]);
  });

  it('GET /api/board?boardId= → the SELECTED board (Subtask 3.7.5)', async () => {
    const fx = await makeFixture();
    const triage = await boardsService.createBoard(
      fx.projectId,
      { name: 'Triage' },
      {
        userId: fx.userId,
        workspaceId: fx.workspaceId,
      },
    );

    const res = await boardGetReq(`?boardId=${triage.id}`);
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    expect(board.boardId).toBe(triage.id);
    expect(board.name).toBe('Triage');
  });

  it('GET /api/board?boardId= → 404 for a board outside the active project/workspace', async () => {
    await makeFixture();
    const res = await boardGetReq('?boardId=brd_not_a_real_board');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('BOARD_NOT_FOUND');
  });

  // Board FILTER (Story 6.15.3) — the route decodes the `?filter=v1:` param and
  // threads it into getBoard (the 6.15.2 read). The filtered PROJECTION itself
  // is covered by tests/boards/filtered-projection.test.ts; here we assert the
  // ROUTE transport: the param narrows, a forged param degrades, a bad field 422s.
  it('GET /api/board?filter= → re-projects the board to the matching set', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'a bug' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a task' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );

    // Unfiltered: both land in todo.
    const before = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const todoBefore = before.columns.find((c) => c.statusKeys[0] === 'todo')!;
    expect(todoBefore.totalCount).toBe(2);

    // Filtered to kind=bug → only the bug remains.
    const param = encodeFilterParam(facetFilterToAst({ ...EMPTY_FILTER, kinds: ['bug'] }));
    const res = await boardGetReq(`?filter=${encodeURIComponent(param)}`);
    expect(res.status).toBe(200);
    const after = (await res.json()) as BoardProjectionDto;
    const todoAfter = after.columns.find((c) => c.statusKeys[0] === 'todo')!;
    expect(todoAfter.totalCount).toBe(1);
    expect(todoAfter.cards).toHaveLength(1);
  });

  it('GET /api/board?filter= → a malformed/forged param degrades to the full board (200)', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a task' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    // No version prefix → decode fails → treated as NO filter (not a 400).
    const res = await boardGetReq('?filter=not-a-valid-param');
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    expect(board.columns.find((c) => c.statusKeys[0] === 'todo')!.totalCount).toBe(1);
  });

  it('GET /api/board?filter= → 422 for a structurally-decodable but invalid filter', async () => {
    await makeFixture();
    // Decodes fine (the codec is structural) but names a field the registry
    // doesn't know → resolveFilterAst throws FilterValidationError → 422.
    const badAst = {
      combinator: 'and',
      conditions: [{ field: 'not_a_field', operator: 'is_any_of', value: ['x'] }],
    } as unknown as FilterAst;
    const res = await boardGetReq(`?filter=${encodeURIComponent(encodeFilterParam(badAst))}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('UNKNOWN_FILTER_FIELD');
  });

  it('POST /api/board/move → 200 for a legal cross-column move (status persists)', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'movable' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const inProgress = board.columns.find((c) => c.statusKeys[0] === 'in_progress')!;

    const res = await moveReq({
      boardId: board.boardId,
      workItemId: card.id,
      toColumnId: inProgress.id,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { appliedStatus: string }).appliedStatus).toBe('in_progress');
  });

  it('POST /api/board/move → 409 for an illegal transition (the snap-back signal)', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'cannot reach done' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;

    // todo → done is NOT a legal transition in the default restricted workflow.
    const res = await moveReq({ boardId: board.boardId, workItemId: card.id, toColumnId: done.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');
  });

  it('POST /api/board/move → 400 when required fields are missing', async () => {
    await makeFixture();
    const res = await moveReq({ workItemId: 'x' }); // no boardId / toColumnId
    expect(res.status).toBe(400);
  });
});

// Board CONFIG routes (Subtask 3.3.3) — PATCH /api/board (swimlane group-by) +
// PATCH /api/board/columns/[columnId] (WIP limit). Transport contract only; the
// validation/authorization behaviour itself is covered in board-config-service.
describe('GET /api/board — the header filter replaces the stored filter (MOTIR-11564)', () => {
  const BUGS = { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['bug']]] };
  const tasks = encodeFilterParam(facetFilterToAst({ ...EMPTY_FILTER, kinds: ['task'] }));

  /** A default board storing Kind is Bug, over two bugs, a task and a story. */
  async function storedBugs() {
    const fx = await makeFixture();
    const ctx = { userId: fx.userId, workspaceId: fx.workspaceId };
    for (const [kind, title] of [
      ['bug', 'bug one'],
      ['bug', 'bug two'],
      ['task', 'a task'],
      ['story', 'a story'],
    ] as const) {
      await workItemsService.createWorkItem({ projectId: fx.projectId, kind, title }, ctx);
    }
    await adminDb.board.updateMany({
      where: { projectId: fx.projectId },
      data: { filter: BUGS as never },
    });
    return fx;
  }

  async function todoTitles(query: string) {
    const res = await boardGetReq(query);
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    return {
      board,
      todo,
      titles: todo.cards.map((c) => c.title).sort(),
    };
  }

  it('no header filter → the stored filter; ?filter= → the header filter alone', async () => {
    await storedBugs();
    const stored = await todoTitles('');
    expect(stored.titles).toEqual(['bug one', 'bug two']);
    expect(stored.todo.totalCount).toBe(2);
    expect(stored.board.storedFilter).toEqual({ envelope: BUGS, staleConditions: [], labels: [] });

    const header = await todoTitles(`?filter=${encodeURIComponent(tasks)}`);
    expect(header.titles).toEqual(['a task']);
    expect(header.todo.totalCount).toBe(1);
    // The response still carries the board's own filter.
    expect(header.board.storedFilter?.envelope).toEqual(BUGS);
  });

  it('?boardFilter=off → the whole scope; beside ?filter= → the header filter alone', async () => {
    await storedBugs();
    const off = await todoTitles('?boardFilter=off');
    expect(off.titles).toEqual(['a story', 'a task', 'bug one', 'bug two']);
    expect(off.todo.totalCount).toBe(4);

    const both = await todoTitles(`?boardFilter=off&filter=${encodeURIComponent(tasks)}`);
    expect(both.titles).toEqual(['a task']);
  });

  it('only `off` lifts it, and a forged ?filter= reads as the board’s own filter', async () => {
    await storedBugs();
    expect((await todoTitles('?boardFilter=on')).titles).toEqual(['bug one', 'bug two']);
    expect((await todoTitles('?filter=not-a-valid-param')).titles).toEqual(['bug one', 'bug two']);
  });

  it('the page doors read under the same rule as the projection', async () => {
    const fx = await storedBugs();
    const ctx = { userId: fx.userId, workspaceId: fx.workspaceId };
    for (let i = 0; i < 10; i++) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `more task ${i}` },
        ctx,
      );
    }
    const { board, todo } = await todoTitles('?boardFilter=off');
    expect(todo.totalCount).toBe(14);
    const qs = new URLSearchParams({
      boardId: board.boardId,
      cursor: todo.cursor!,
      boardFilter: 'off',
    });
    const res = await pageGET(new Request(`${BASE}/api/board/columns/${todo.id}/cards?${qs}`), {
      params: Promise.resolve({ columnId: todo.id }),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as BoardColumnPageDto;
    expect(page.totalCount).toBe(14);
    expect(page.cards).toHaveLength(4);

    await adminDb.board.updateMany({
      where: { projectId: fx.projectId },
      data: { swimlaneGroupBy: 'priority' },
    });
    const lane = await laneGET(
      new Request(
        `${BASE}/api/board/lanes/medium/cells?${new URLSearchParams({
          boardId: board.boardId,
          filter: tasks,
        })}`,
      ),
      { params: Promise.resolve({ laneKey: 'medium' }) },
    );
    expect(lane.status).toBe(200);
    const cells = (await lane.json()) as BoardLanePageDto;
    const todoCell = cells.cells.find((c) => c.columnId === todo.id)!;
    expect(todoCell.totalCount).toBe(11);
    expect(todoCell.cards.every((c) => c.title.includes('task'))).toBe(true);
  });
});

describe('board config API routes (Subtask 3.3.3)', () => {
  async function firstColumnId(boardId: string): Promise<string> {
    const col = await adminDb.boardColumn.findFirstOrThrow({
      where: { boardId },
      orderBy: { position: 'asc' },
    });
    return col.id;
  }

  async function boardId(): Promise<string> {
    return ((await (await boardGetReq()).json()) as BoardProjectionDto).boardId;
  }

  it('PATCH /api/board → 401 without a session', async () => {
    session.current = null;
    const res = await boardPatchReq({ boardId: 'x', swimlaneGroupBy: 'assignee' });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/board → 200 sets the group-by for the owner', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId(), swimlaneGroupBy: 'assignee' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { swimlaneGroupBy: string }).swimlaneGroupBy).toBe('assignee');
  });

  it('PATCH /api/board → 400 for an invalid group-by value', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId(), swimlaneGroupBy: 'sprint' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SWIMLANE_GROUP_BY');
  });

  it('PATCH /api/board → 400 when required fields are missing', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId() }); // no swimlaneGroupBy
    expect(res.status).toBe(400);
  });

  it('PATCH /api/board → 403 for a non-owner member', async () => {
    const fx = await makeFixture();
    const bId = await boardId();
    // A plain member in the same workspace, switched into the request context.
    const member = await usersService.createUser({
      email: 'board-routes-member@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    session.current = {
      user: { id: member.id, email: 'board-routes-member@example.com', name: 'Member' },
    };
    activeCtx.current = { ...activeCtx.current!, userId: member.id };

    const res = await boardPatchReq({ boardId: bId, swimlaneGroupBy: 'epic' });
    expect(res.status).toBe(403);
    // MOTIR-2296 retired `NOT_BOARD_ADMIN`. The gate is now the shared
    // `assertPermission(…, 'board:configure')`, so the refusal names the key.
    const body = (await res.json()) as { code: string; permission?: string };
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.permission).toBe('board:configure');
  });

  it('PATCH column → 200 sets + 200 clears the WIP limit for the owner', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());

    const set = await columnPatchReq(columnId, { wipLimit: 5 });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { wipLimit: number | null }).wipLimit).toBe(5);

    const clear = await columnPatchReq(columnId, { wipLimit: null });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { wipLimit: number | null }).wipLimit).toBeNull();
  });

  it('PATCH column → 400 for a negative limit', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());
    const res = await columnPatchReq(columnId, { wipLimit: -1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_WIP_LIMIT');
  });

  it('PATCH column → 400 for a non-numeric body', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());
    const res = await columnPatchReq(columnId, { wipLimit: 'three' });
    expect(res.status).toBe(400);
  });

  it('PATCH column → 404 for an unknown column', async () => {
    await makeFixture();
    const res = await columnPatchReq('col_does_not_exist', { wipLimit: 2 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('BOARD_COLUMN_NOT_FOUND');
  });
});

// GET /api/board/columns/[columnId]/cards (MOTIR-10535) — the next page of one
// lane. The paging itself is tests/boards/projection.test.ts's; here, the
// transport: the required params, the typed refusals and the filter thread.
describe("GET /api/board/columns/[columnId]/cards — a lane's next page", () => {
  function pageReq(columnId: string, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return pageGET(new Request(`${BASE}/api/board/columns/${columnId}/cards?${qs}`), {
      params: Promise.resolve({ columnId }),
    });
  }

  async function pagedTodo(n: number, kind: 'task' | 'bug' = 'task') {
    const fx = await makeFixture();
    for (let i = 0; i < n; i++) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: i % 2 === 0 ? kind : 'task', title: `card ${i}` },
        { userId: fx.userId, workspaceId: fx.workspaceId },
      );
    }
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    return { fx, board, todo };
  }

  it('→ 401 without a session', async () => {
    const res = await pageReq('col_x', { boardId: 'b', cursor: 'c' });
    expect(res.status).toBe(401);
  });

  it('→ 200 with the page after the cursor', async () => {
    const { board, todo } = await pagedTodo(12);
    expect(todo.cards).toHaveLength(10);
    const res = await pageReq(todo.id, { boardId: board.boardId, cursor: todo.cursor! });
    expect(res.status).toBe(200);
    const page = (await res.json()) as BoardColumnPageDto;
    expect(page.columnId).toBe(todo.id);
    expect(page.cards.map((c) => c.title)).toEqual(['card 10', 'card 11']);
    expect(page.totalCount).toBe(12);
    expect(page.cursor).toBeNull();
  });

  it("→ 400 when `boardId` or `cursor` is missing, or the cursor is not the lane's", async () => {
    const { board, todo } = await pagedTodo(11);
    const partial: Array<Record<string, string>> = [
      { boardId: board.boardId },
      { cursor: todo.cursor! },
    ];
    for (const query of partial) {
      const res = await pageReq(todo.id, query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    }
    const bad = await pageReq(todo.id, { boardId: board.boardId, cursor: 'forged' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_BOARD_CURSOR');
  });

  it('→ 404 for a lane or a board the active project does not have', async () => {
    const { board, todo } = await pagedTodo(11);
    const noLane = await pageReq('col_does_not_exist', {
      boardId: board.boardId,
      cursor: todo.cursor!,
    });
    expect(noLane.status).toBe(404);
    expect(((await noLane.json()) as { code: string }).code).toBe('BOARD_COLUMN_NOT_FOUND');
    const noBoard = await pageReq(todo.id, { boardId: 'brd_not_real', cursor: todo.cursor! });
    expect(noBoard.status).toBe(404);
    expect(((await noBoard.json()) as { code: string }).code).toBe('BOARD_NOT_FOUND');
  });

  it('threads `?filter=` into the page, and 422s an invalid one', async () => {
    const { fx } = await pagedTodo(0);
    for (let i = 0; i < 12; i++) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'bug', title: `bug ${i}` },
        { userId: fx.userId, workspaceId: fx.workspaceId },
      );
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `task ${i}` },
        { userId: fx.userId, workspaceId: fx.workspaceId },
      );
    }
    const filter = encodeFilterParam(facetFilterToAst({ ...EMPTY_FILTER, kinds: ['bug'] }));
    const board = (await (
      await boardGetReq(`?filter=${encodeURIComponent(filter)}`)
    ).json()) as BoardProjectionDto;
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    expect(todo.totalCount).toBe(12);

    const res = await pageReq(todo.id, { boardId: board.boardId, cursor: todo.cursor!, filter });
    const page = (await res.json()) as BoardColumnPageDto;
    expect(page.cards.map((c) => c.title)).toEqual(['bug 10', 'bug 11']);
    expect(page.totalCount).toBe(12);

    const badAst = {
      combinator: 'and',
      conditions: [{ field: 'not_a_field', operator: 'is_any_of', value: ['x'] }],
    } as unknown as FilterAst;
    const bad = await pageReq(todo.id, {
      boardId: board.boardId,
      cursor: todo.cursor!,
      filter: encodeFilterParam(badAst),
    });
    expect(bad.status).toBe(422);
  });

  it('→ 404 BOARD_NOT_FOUND when the project gate refuses, and rethrows an untyped failure', async () => {
    await makeFixture();
    const spy = vi.spyOn(boardsService, 'getColumnPage');
    spy.mockRejectedValueOnce(new ProjectNotFoundError('p'));
    const gated = await pageReq('col_x', { boardId: 'b', cursor: 'c' });
    expect(gated.status).toBe(404);
    expect(((await gated.json()) as { code: string }).code).toBe('BOARD_NOT_FOUND');

    spy.mockRejectedValueOnce(new Error('boom'));
    await expect(pageReq('col_x', { boardId: 'b', cursor: 'c' })).rejects.toThrow('boom');
  });

  it('a malformed `?filter=` degrades to the unfiltered lane, as on the projection', async () => {
    const { board, todo } = await pagedTodo(12);
    const res = await pageReq(todo.id, {
      boardId: board.boardId,
      cursor: todo.cursor!,
      filter: 'not-a-valid-param',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BoardColumnPageDto).cards).toHaveLength(2);
  });

  it('→ 400 when there is no active project', async () => {
    await makeFixture();
    activeCtx.current = null;
    const res = await pageReq('col_x', { boardId: 'b', cursor: 'c' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('NO_ACTIVE_PROJECT');
  });
});

describe('the cell and lane page doors (MOTIR-11446)', () => {
  function pageReq(columnId: string, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return pageGET(new Request(`${BASE}/api/board/columns/${columnId}/cards?${qs}`), {
      params: Promise.resolve({ columnId }),
    });
  }

  function laneReq(laneKey: string, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return laneGET(
      new Request(`${BASE}/api/board/lanes/${encodeURIComponent(laneKey)}/cells?${qs}`),
      { params: Promise.resolve({ laneKey }) },
    );
  }

  /** A board grouped by `groupBy` with 12 high-priority bugs and 3 tasks in To Do. */
  async function groupedBoard(groupBy: 'assignee' | 'priority' | 'none' = 'priority') {
    const fx = await makeFixture();
    const ctx = { userId: fx.userId, workspaceId: fx.workspaceId };
    for (let i = 0; i < 12; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'bug', title: `bug ${i}` },
        ctx,
      );
      await adminDb.workItem.update({ where: { id: item.id }, data: { priority: 'high' } });
    }
    for (let i = 0; i < 3; i++) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `task ${i}` },
        ctx,
      );
    }
    await adminDb.board.updateMany({
      where: { projectId: fx.projectId },
      data: { swimlaneGroupBy: groupBy },
    });
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    return { fx, board, todo };
  }

  it('→ 401 without a session, on both doors', async () => {
    expect((await pageReq('col_x', { boardId: 'b', lane: 'high' })).status).toBe(401);
    expect((await laneReq('high', { boardId: 'b' })).status).toBe(401);
  });

  it('?lane= answers the cell’s first page with no cursor, then its next page', async () => {
    const { board, todo } = await groupedBoard();
    const first = await pageReq(todo.id, { boardId: board.boardId, lane: 'high' });
    expect(first.status).toBe(200);
    const page = (await first.json()) as BoardCellPageDto;
    expect(page).toMatchObject({ columnId: todo.id, laneKey: 'high', totalCount: 12 });
    expect(page.cards).toHaveLength(10);
    expect(page.cards.every((c) => c.priority === 'high')).toBe(true);
    expect(page.planHolds).toEqual({});

    const next = await pageReq(todo.id, {
      boardId: board.boardId,
      lane: 'high',
      cursor: page.cursor!,
    });
    const rest = (await next.json()) as BoardCellPageDto;
    expect(rest.cards.map((c) => c.title).sort()).toEqual(['bug 10', 'bug 11']);
    expect(rest.cursor).toBeNull();

    // The service is handed the cursor exactly as it arrived.
    const spy = vi.spyOn(boardsService, 'getCellPage');
    await pageReq(todo.id, { boardId: board.boardId, lane: 'high', cursor: page.cursor! });
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      board.boardId,
      todo.id,
      'high',
      page.cursor,
      undefined,
    );
  });

  it('?lane= passes the catch-all sentinel through to the read', async () => {
    const { board, todo } = await groupedBoard('assignee');
    const res = await pageReq(todo.id, { boardId: board.boardId, lane: BOARD_SWIMLANE_NO_VALUE });
    expect(res.status).toBe(200);
    const page = (await res.json()) as BoardCellPageDto;
    expect(page.totalCount).toBe(15);
    expect(page.cards.every((c) => c.swimlaneKey === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
  });

  it('?lane= answers 400 for a missing boardId, a lane the group-by cannot hold, a bad cursor', async () => {
    const { board, todo } = await groupedBoard();
    const noBoard = await pageReq(todo.id, { lane: 'high' });
    expect(noBoard.status).toBe(400);
    expect(((await noBoard.json()) as { code: string }).code).toBe('BAD_REQUEST');

    const catchAll = await pageReq(todo.id, {
      boardId: board.boardId,
      lane: BOARD_SWIMLANE_NO_VALUE,
    });
    expect(catchAll.status).toBe(400);
    expect(((await catchAll.json()) as { code: string }).code).toBe('INVALID_BOARD_LANE');

    const forged = await pageReq(todo.id, {
      boardId: board.boardId,
      lane: 'high',
      cursor: 'forged',
    });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe('INVALID_BOARD_CURSOR');

    const unknown = await pageReq('col_does_not_exist', { boardId: board.boardId, lane: 'high' });
    expect(unknown.status).toBe(404);
  });

  it('?lane= threads the filter, and 422s an invalid one', async () => {
    const { board, todo } = await groupedBoard('assignee');
    const filter = encodeFilterParam(facetFilterToAst({ ...EMPTY_FILTER, kinds: ['task'] }));
    const res = await pageReq(todo.id, {
      boardId: board.boardId,
      lane: BOARD_SWIMLANE_NO_VALUE,
      filter,
    });
    expect(((await res.json()) as BoardCellPageDto).totalCount).toBe(3);

    const badAst = {
      combinator: 'and',
      conditions: [{ field: 'not_a_field', operator: 'is_any_of', value: ['x'] }],
    } as unknown as FilterAst;
    const bad = await pageReq(todo.id, {
      boardId: board.boardId,
      lane: BOARD_SWIMLANE_NO_VALUE,
      filter: encodeFilterParam(badAst),
    });
    expect(bad.status).toBe(422);
  });

  it('GET lanes/[laneKey]/cells → one first page per column', async () => {
    const { board, todo } = await groupedBoard();
    const res = await laneReq('high', { boardId: board.boardId });
    expect(res.status).toBe(200);
    const lane = (await res.json()) as BoardLanePageDto;
    expect(lane.laneKey).toBe('high');
    expect(lane.cells.map((c) => c.columnId)).toEqual(board.columns.map((c) => c.id));
    const cell = lane.cells.find((c) => c.columnId === todo.id)!;
    expect(cell.totalCount).toBe(12);
    expect(cell.cards).toHaveLength(10);
    expect(cell.cursor).not.toBeNull();

    const medium = (await (
      await laneReq('medium', { boardId: board.boardId })
    ).json()) as BoardLanePageDto;
    expect(medium.cells.find((c) => c.columnId === todo.id)!.totalCount).toBe(3);
  });

  it('GET lanes/[laneKey]/cells → 400, 404, 422 and an untyped failure rethrown', async () => {
    const { board } = await groupedBoard();
    const noBoard = await laneReq('high', {});
    expect(noBoard.status).toBe(400);
    expect(((await noBoard.json()) as { code: string }).code).toBe('BAD_REQUEST');

    const refused = await laneReq(BOARD_SWIMLANE_NO_VALUE, { boardId: board.boardId });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('INVALID_BOARD_LANE');

    const missing = await laneReq('high', { boardId: 'brd_not_real' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('BOARD_NOT_FOUND');

    const badAst = {
      combinator: 'and',
      conditions: [{ field: 'not_a_field', operator: 'is_any_of', value: ['x'] }],
    } as unknown as FilterAst;
    const bad = await laneReq('high', {
      boardId: board.boardId,
      filter: encodeFilterParam(badAst),
    });
    expect(bad.status).toBe(422);

    const spy = vi.spyOn(boardsService, 'getLanePage');
    spy.mockRejectedValueOnce(new ProjectNotFoundError('p'));
    expect((await laneReq('high', { boardId: 'b' })).status).toBe(404);
    spy.mockRejectedValueOnce(new Error('boom'));
    await expect(laneReq('high', { boardId: 'b' })).rejects.toThrow('boom');
  });

  it('GET lanes/[laneKey]/cells → 400 when there is no active project', async () => {
    await makeFixture();
    activeCtx.current = null;
    const res = await laneReq('high', { boardId: 'b' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('NO_ACTIVE_PROJECT');
  });
});
