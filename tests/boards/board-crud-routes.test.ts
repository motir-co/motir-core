import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';
import type { BoardSummaryDto } from '@/lib/dto/boards';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Board CRUD API routes (Story 3.7 · Subtask 3.7.3) — /api/boards (GET list,
// POST create) + /api/boards/[id] (PATCH rename/set-default, DELETE). Real
// Postgres; we stub only the two session/context resolvers the test env can't
// supply via cookies (getSession, getActiveProject). This asserts the TRANSPORT
// contract (status codes + typed-error → HTTP mapping); the lifecycle behaviour
// itself is covered by board-crud-service.test.ts.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// Import AFTER the mocks are registered.
const { GET: boardsGET, POST: boardsPOST } = await import('@/app/api/boards/route');
const { PATCH: boardPATCH, DELETE: boardDELETE } = await import('@/app/api/boards/[id]/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  userId: string;
  memberId: string;
  workspaceId: string;
  projectId: string;
  defaultBoardId: string;
}

async function makeFixture(label = 'a'): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `board-crud-routes-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Routes Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `CRUD Routes WS ${label}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'CRUD Routes Demo',
    identifier: 'CRD',
  });
  const member = await usersService.createUser({
    email: `board-crud-routes-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Routes Member',
  });
  await adminDb.workspaceMembership.create({
    data: {
      userId: member.id,
      workspaceId: ws.workspace.id,
      workspaceRole: 'member',
    },
  });
  const board = await withWorkspaceServiceContext(ws.workspace.id, (tx) =>
    boardRepository.findDefaultForProject(project.id, ws.workspace.id, tx),
  );
  if (!board) throw new Error('expected a seeded default board');

  const fx = {
    userId: owner.id,
    memberId: member.id,
    workspaceId: ws.workspace.id,
    projectId: project.id,
    defaultBoardId: board.id,
  };
  asOwner(fx, project);
  return fx;
}

function asOwner(fx: Fixture, project: ProjectContext['project']) {
  session.current = { user: { id: fx.userId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project,
  };
}

function asMember(fx: Fixture) {
  session.current = { user: { id: fx.memberId, email: 'member@example.com', name: 'Member' } };
  activeCtx.current = { ...activeCtx.current!, userId: fx.memberId };
}

function postReq(body: unknown) {
  return boardsPOST(
    new Request(`${BASE}/api/boards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function patchReq(id: string, body: unknown) {
  return boardPATCH(
    new Request(`${BASE}/api/boards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteReq(id: string) {
  return boardDELETE(new Request(`${BASE}/api/boards/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/boards', () => {
  it('→ 401 without a session', async () => {
    session.current = null;
    expect((await boardsGET()).status).toBe(401);
  });

  it('→ 200 lists the active project boards', async () => {
    await makeFixture('list');
    const res = await boardsGET();
    expect(res.status).toBe(200);
    const { boards } = (await res.json()) as { boards: BoardSummaryDto[] };
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ name: 'Board', isDefault: true });
  });
});

describe('POST /api/boards', () => {
  it('→ 201 creates a board', async () => {
    await makeFixture('create');
    const res = await postReq({ name: 'Triage' });
    expect(res.status).toBe(201);
    const board = (await res.json()) as BoardSummaryDto;
    expect(board).toMatchObject({ name: 'Triage', type: 'kanban', isDefault: false });
  });

  it('→ 400 on an empty name', async () => {
    await makeFixture('create-empty');
    expect((await postReq({ name: '  ' })).status).toBe(400);
  });

  it('→ 400 on a missing name', async () => {
    await makeFixture('create-missing');
    expect((await postReq({})).status).toBe(400);
  });

  it('→ 403 for a plain member', async () => {
    const fx = await makeFixture('create-member');
    asMember(fx);
    expect((await postReq({ name: 'Nope' })).status).toBe(403);
  });
});

describe('PATCH /api/boards/[id]', () => {
  it('→ 200 renames a board', async () => {
    const fx = await makeFixture('rename');
    const res = await patchReq(fx.defaultBoardId, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('Renamed');
  });

  it('→ 200 sets a board as default', async () => {
    await makeFixture('setdefault');
    const created = (await (await postReq({ name: 'Triage' })).json()) as BoardSummaryDto;
    const res = await patchReq(created.id, { isDefault: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: created.id, isDefault: true });
  });

  it('→ 400 when no recognized field is given', async () => {
    const fx = await makeFixture('patch-empty');
    expect((await patchReq(fx.defaultBoardId, { foo: 1 })).status).toBe(400);
  });

  it('→ 404 for a cross-workspace board', async () => {
    const fx = await makeFixture('patch-cross');
    const other = await makeFixture('patch-cross-other'); // switches active ctx to `other`
    asOwner(fx, activeCtx.current!.project); // back to fx's workspace
    expect((await patchReq(other.defaultBoardId, { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /api/boards/[id]', () => {
  it('→ 204 deletes a non-default board', async () => {
    await makeFixture('delete');
    const created = (await (await postReq({ name: 'Triage' })).json()) as BoardSummaryDto;
    expect((await deleteReq(created.id)).status).toBe(204);
  });

  it('→ 409 deleting the last board', async () => {
    const fx = await makeFixture('delete-last');
    expect((await deleteReq(fx.defaultBoardId)).status).toBe(409);
  });

  it('→ 403 for a plain member', async () => {
    const fx = await makeFixture('delete-member');
    const created = (await (await postReq({ name: 'Triage' })).json()) as BoardSummaryDto;
    asMember(fx);
    expect((await deleteReq(created.id)).status).toBe(403);
  });

  it('→ 404 for a cross-workspace board', async () => {
    const fx = await makeFixture('delete-cross');
    const other = await makeFixture('delete-cross-other');
    asOwner(fx, activeCtx.current!.project);
    expect((await deleteReq(other.defaultBoardId)).status).toBe(404);
  });
});

// ── The board's STORED filter over the wire (MOTIR-10560 · MOTIR-11331):
// POST /api/boards { filter } and PATCH /api/boards/[id] { filter }. The
// validation itself is covered by board-crud-service.test.ts; this asserts the
// transport: 201/200 with the stored value, the 422 `{ code, error }` arm, the
// 403/404 arms, and absent-versus-null on PATCH.

const BUGS = { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['bug']]] };

async function storedFilter(boardId: string): Promise<unknown> {
  return (await adminDb.board.findUniqueOrThrow({ where: { id: boardId } })).filter;
}

describe('POST /api/boards — stored filter', () => {
  it('→ 201 stores the filter on the new board', async () => {
    await makeFixture('sf-post');
    const res = await postReq({ name: 'Bugs', type: 'kanban', filter: BUGS });
    expect(res.status).toBe(201);
    const board = (await res.json()) as BoardSummaryDto;
    expect(await storedFilter(board.id)).toEqual(BUGS);
  });

  it('→ 201 with no stored filter when `filter` is absent', async () => {
    await makeFixture('sf-post-none');
    const board = (await (await postReq({ name: 'Plain' })).json()) as BoardSummaryDto;
    expect(await storedFilter(board.id)).toBeNull();
  });

  it.each([
    [
      'an unknown field',
      { v: 'v1', c: 'and', f: [['nope', 'is_any_of', ['x']]] },
      'UNKNOWN_FILTER_FIELD',
    ],
    [
      'an unknown operator',
      { v: 'v1', c: 'and', f: [['kind', 'gt', 1]] },
      'UNKNOWN_FILTER_OPERATOR',
    ],
    [
      'an invalid value',
      { v: 'v1', c: 'and', f: [['kind', 'is_any_of', ['dragon']]] },
      'INVALID_FILTER_VALUE',
    ],
    ['an unsupported version', { v: 'v2', c: 'and', f: [] }, 'MALFORMED_FILTER'],
    [
      '21 conditions',
      { v: 'v1', c: 'and', f: Array.from({ length: 21 }, () => ['kind', 'is_any_of', ['bug']]) },
      'FILTER_TOO_LARGE',
    ],
  ])('→ 422 on %s and creates no board', async (_label, filter, code) => {
    const fx = await makeFixture(`sf-post-422-${String(code).toLowerCase()}`);
    const res = await postReq({ name: 'Refused', filter });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe(code);
    expect(body.error).toEqual(expect.any(String));
    expect(await adminDb.board.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('→ 403 for a plain member, with no board created', async () => {
    const fx = await makeFixture('sf-post-member');
    asMember(fx);
    expect((await postReq({ name: 'Nope', filter: BUGS })).status).toBe(403);
    expect(await adminDb.board.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('a JSON `null` body', () => {
  it('→ 400 on POST and on PATCH', async () => {
    const fx = await makeFixture('null-body');
    expect((await postReq(null)).status).toBe(400);
    expect((await patchReq(fx.defaultBoardId, null)).status).toBe(400);
  });
});

describe('PATCH /api/boards/[id] — stored filter', () => {
  it('→ 200 sets, then `null` clears, answering the BoardDto', async () => {
    const fx = await makeFixture('sf-patch');
    const set = await patchReq(fx.defaultBoardId, { filter: BUGS });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ id: fx.defaultBoardId, filter: BUGS });
    expect(await storedFilter(fx.defaultBoardId)).toEqual(BUGS);

    const cleared = await patchReq(fx.defaultBoardId, { filter: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).filter).toBeNull();
    expect(await storedFilter(fx.defaultBoardId)).toBeNull();
  });

  it('a rename (no `filter` key) leaves the stored filter alone', async () => {
    const fx = await makeFixture('sf-patch-absent');
    await patchReq(fx.defaultBoardId, { filter: BUGS });
    const res = await patchReq(fx.defaultBoardId, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((await res.json()).filter).toEqual(BUGS);
    expect(await storedFilter(fx.defaultBoardId)).toEqual(BUGS);
  });

  it('→ 422 on an invalid filter, leaving the stored filter unchanged', async () => {
    const fx = await makeFixture('sf-patch-422');
    await patchReq(fx.defaultBoardId, { filter: BUGS });
    const res = await patchReq(fx.defaultBoardId, {
      filter: {
        v: 'v1',
        c: 'and',
        f: Array.from({ length: 25 }, () => ['kind', 'is_any_of', ['bug']]),
      },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('FILTER_TOO_LARGE');
    const malformed = await patchReq(fx.defaultBoardId, { filter: 'v1:abc' });
    expect(malformed.status).toBe(422);
    expect(((await malformed.json()) as { code: string }).code).toBe('MALFORMED_FILTER');
    expect(await storedFilter(fx.defaultBoardId)).toEqual(BUGS);
  });

  it('→ 403 for a plain member, leaving the stored filter unchanged', async () => {
    const fx = await makeFixture('sf-patch-member');
    asMember(fx);
    const res = await patchReq(fx.defaultBoardId, { filter: BUGS });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { permission?: string }).permission).toBe('board:configure');
    expect(await storedFilter(fx.defaultBoardId)).toBeNull();
  });

  it('→ 404 for a cross-workspace board, leaving its stored filter unchanged', async () => {
    const fx = await makeFixture('sf-patch-cross');
    const other = await makeFixture('sf-patch-cross-other');
    asOwner(fx, activeCtx.current!.project);
    expect((await patchReq(other.defaultBoardId, { filter: BUGS })).status).toBe(404);
    expect(await storedFilter(other.defaultBoardId)).toBeNull();
  });
});
