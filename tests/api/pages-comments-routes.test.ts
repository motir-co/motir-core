import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The PAGE-COMMENT routes (Story MOTIR-10866 · MOTIR-10873), called as handlers
// against real Postgres, the way `pages-archive-routes.test.ts` calls its
// siblings. Only the session and the active project are mocked, so every gate,
// the service, the package and the refusal map run for real.

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
const activeProject = vi.hoisted(() => ({
  current: null as {
    userId: string;
    workspaceId: string;
    projectId: string;
    project: { identifier: string };
  } | null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => activeProject.current),
}));

const { GET: LIST, POST: CREATE } = await import('@/app/api/pages/[pageId]/comments/route');
const { PATCH: EDIT, DELETE: REMOVE } =
  await import('@/app/api/pages/[pageId]/comments/[commentId]/route');
const { POST: REPLY } = await import('@/app/api/pages/[pageId]/comments/[commentId]/replies/route');
const { POST: RESOLVE, DELETE: REOPEN } =
  await import('@/app/api/pages/[pageId]/comments/[commentId]/resolution/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { db } = await import('@/lib/db');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const BASE = 'http://localhost:3000/api/pages';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeProject.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
  project: { identifier: string };
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: Actor;
  pageId: string;
}

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `pages-comments-route-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Route ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Routes', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Routes',
    identifier: 'PCR',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'PCQ',
  });
  const manager = {
    userId: owner.id,
    workspaceId,
    projectId: project.id,
    project: { identifier: 'PCR' },
  };
  const page = await pagesService.createPage(manager, { projectId: project.id, title: 'Plan' });
  return { workspaceId, projectId: project.id, otherProjectId: other.id, manager, pageId: page.id };
}

async function actorAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { ...f.manager, userId: user.id };
}

function as(actor: Actor | null): void {
  session.current = actor ? { user: { id: actor.userId } } : null;
  activeProject.current = actor;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const pageParams = (pageId: string) => ({ params: Promise.resolve({ pageId }) });
const commentParams = (pageId: string, commentId: string) => ({
  params: Promise.resolve({ pageId, commentId }),
});

const list = (pageId: string, query = '') =>
  LIST(new Request(`${BASE}/${pageId}/comments${query}`), pageParams(pageId));
const create = (pageId: string, body: unknown) =>
  CREATE(new Request(`${BASE}/${pageId}/comments`, json(body)), pageParams(pageId));
const reply = (pageId: string, commentId: string, body: unknown) =>
  REPLY(
    new Request(`${BASE}/${pageId}/comments/${commentId}/replies`, json(body)),
    commentParams(pageId, commentId),
  );
const edit = (pageId: string, commentId: string, body: unknown) =>
  EDIT(
    new Request(`${BASE}/${pageId}/comments/${commentId}`, { ...json(body), method: 'PATCH' }),
    commentParams(pageId, commentId),
  );
const remove = (pageId: string, commentId: string) =>
  REMOVE(
    new Request(`${BASE}/${pageId}/comments/${commentId}`, { method: 'DELETE' }),
    commentParams(pageId, commentId),
  );
const resolve = (pageId: string, commentId: string) =>
  RESOLVE(
    new Request(`${BASE}/${pageId}/comments/${commentId}/resolution`, { method: 'POST' }),
    commentParams(pageId, commentId),
  );
const reopen = (pageId: string, commentId: string) =>
  REOPEN(
    new Request(`${BASE}/${pageId}/comments/${commentId}/resolution`, { method: 'DELETE' }),
    commentParams(pageId, commentId),
  );

async function newThread(pageId: string, bodyMd = 'Root'): Promise<{ id: string }> {
  const res = await create(pageId, { bodyMd });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

const snapshot = () =>
  adminDb.pageComment.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, bodyMd: true, editedAt: true, resolvedAt: true },
  });

describe('the session and project gates', () => {
  it('answers 401 without a session and 400 NO_ACTIVE_PROJECT without a project, on every route', async () => {
    const f = await makeFixture();
    const calls = [
      () => list(f.pageId),
      () => create(f.pageId, { bodyMd: 'x' }),
      () => reply(f.pageId, 'c', { bodyMd: 'x' }),
      () => edit(f.pageId, 'c', { bodyMd: 'x' }),
      () => remove(f.pageId, 'c'),
      () => resolve(f.pageId, 'c'),
      () => reopen(f.pageId, 'c'),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    session.current = { user: { id: f.manager.userId } };
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
    }
  });
});

describe('GET /api/pages/[pageId]/comments', () => {
  it('answers threads, counts and the caller’s capabilities by role', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const member = await actorAs(f, 'member', 'member');
    as(f.manager);
    const root = await newThread(f.pageId);

    as(viewer);
    const res = await list(f.pageId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      nextCursor: null,
      counts: { open: 1, resolved: 0 },
      capabilities: { canComment: false, canModerate: false },
    });
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual([root.id]);

    as(member);
    expect((await (await list(f.pageId)).json()).capabilities).toEqual({
      canComment: true,
      canModerate: false,
    });

    as(f.manager);
    await resolve(f.pageId, root.id);
    const resolved = await (await list(f.pageId, '?status=resolved')).json();
    expect(resolved.threads.map((t: { id: string }) => t.id)).toEqual([root.id]);
  });

  it('pages with a cursor and runs newest first on order=desc', async () => {
    const f = await makeFixture();
    as(f.manager);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await newThread(f.pageId, `r${i}`)).id);
    const first = await (await list(f.pageId, '?limit=2')).json();
    expect(first.threads).toHaveLength(2);
    const second = await (
      await list(f.pageId, `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    expect([...first.threads, ...second.threads].map((t: { id: string }) => t.id)).toEqual(ids);
    const newest = await (await list(f.pageId, '?order=desc&limit=1')).json();
    expect(newest.threads[0].id).toBe(ids[2]);
  });

  it('answers 400 for an unknown status or order, a bad limit and a foreign cursor', async () => {
    const f = await makeFixture();
    as(f.manager);
    for (const query of ['?status=all', '?order=up', '?limit=0', '?limit=two']) {
      const res = await list(f.pageId, query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    const res = await list(f.pageId, '?cursor=nonsense');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PAGE_COMMENT_CURSOR_INVALID' });
  });

  it('answers a stranger and another project’s page the same 404', async () => {
    const f = await makeFixture();
    const foreign = await pagesService.createPage(f.manager, {
      projectId: f.otherProjectId,
      title: 'Elsewhere',
    });
    as(f.manager);
    const missing = await list(foreign.id);
    const stranger = await makeUser('stranger');
    as({ ...f.manager, userId: stranger.id });
    const hidden = await list(f.pageId);
    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    const expected = { code: 'PAGE_NOT_FOUND', error: 'Page not found.' };
    expect(await missing.json()).toEqual(expected);
    expect(await hidden.json()).toEqual(expected);
  });
});

describe('POST /api/pages/[pageId]/comments', () => {
  it('starts a page-level thread with no anchor', async () => {
    const f = await makeFixture();
    as(f.manager);
    const res = await create(f.pageId, { bodyMd: 'Hello' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      bodyMd: 'Hello',
      parentCommentId: null,
      resolvedAt: null,
      anchor: null,
      replies: [],
    });
    expect(await adminDb.pageComment.findUniqueOrThrow({ where: { id: body.id } })).toMatchObject({
      anchor: null,
      anchorQuote: null,
    });
  });

  it('stores a base64 anchor’s bytes and answers both parts, the bytes as stored', async () => {
    const f = await makeFixture();
    as(f.manager);
    const bytes = Uint8Array.from([0, 1, 254, 255, 9]);
    const res = await create(f.pageId, {
      bodyMd: 'Inline',
      anchor: { bytes: Buffer.from(bytes).toString('base64'), quote: 'the passage' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.anchor).toEqual({ bytes: 'AAH+/wk=', quote: 'the passage' });
    const row = await adminDb.pageComment.findUniqueOrThrow({ where: { id: body.id } });
    expect([...row.anchor!]).toEqual([...bytes]);
    expect([...Buffer.from(body.anchor.bytes, 'base64')]).toEqual([...row.anchor!]);
    expect(row.anchorQuote).toBe('the passage');
  });

  it('accepts back the bytes a read returned, storing them byte-identical', async () => {
    const f = await makeFixture();
    as(f.manager);
    const bytes = Uint8Array.from([1, 0, 0, 0, 3, 250, 251, 252, 0, 128]);
    const first = await (
      await create(f.pageId, {
        bodyMd: 'First',
        anchor: { bytes: Buffer.from(bytes).toString('base64'), quote: 'the passage' },
      })
    ).json();
    const again = await create(f.pageId, { bodyMd: 'Again', anchor: first.anchor });
    expect(again.status).toBe(201);
    const second = await again.json();
    expect(second.anchor).toEqual(first.anchor);
    const rows = await adminDb.pageComment.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([...row.anchor!]).toEqual([...bytes]);
  });

  it('answers 400 for malformed input, and the package’s own codes for blank content', async () => {
    const f = await makeFixture();
    as(f.manager);
    for (const body of [
      '{not json',
      '[]',
      { bodyMd: 7 },
      { bodyMd: 'x', anchor: 'nope' },
      { bodyMd: 'x', anchor: [] },
      { bodyMd: 'x', anchor: { bytes: 1, quote: 'q' } },
      { bodyMd: 'x', anchor: { bytes: 'AQ==', quote: null } },
      { bodyMd: 'x', anchor: { bytes: 'not base64!', quote: 'q' } },
    ]) {
      const res = await create(f.pageId, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    for (const anchor of [
      { bytes: '', quote: 'q' },
      { bytes: 'AQ==', quote: '   ' },
    ]) {
      const res = await create(f.pageId, { bodyMd: 'x', anchor });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'PAGE_COMMENT_ANCHOR_INVALID' });
    }
    const blank = await create(f.pageId, { bodyMd: '  ' });
    expect(blank.status).toBe(422);
    expect(await blank.json()).toMatchObject({ code: 'PAGE_COMMENT_BODY_EMPTY' });
    expect(await adminDb.pageComment.count()).toBe(0);
  });
});

describe('replies', () => {
  it('replies to a root (201), refuses a reply to a reply (422) and a reply carrying an anchor (400)', async () => {
    const f = await makeFixture();
    as(f.manager);
    const root = await newThread(f.pageId);
    const res = await reply(f.pageId, root.id, { bodyMd: 'Agreed' });
    expect(res.status).toBe(201);
    const child = await res.json();
    expect(child.parentCommentId).toBe(root.id);

    const deep = await reply(f.pageId, child.id, { bodyMd: 'Deeper' });
    expect(deep.status).toBe(422);
    expect(await deep.json()).toMatchObject({ code: 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED' });

    const anchored = await reply(f.pageId, root.id, {
      bodyMd: 'x',
      anchor: { bytes: 'AQ==', quote: 'q' },
    });
    expect(anchored.status).toBe(400);
    const missing = await reply(f.pageId, 'nope', { bodyMd: 'x' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'PAGE_COMMENT_NOT_FOUND' });
    expect(await adminDb.pageComment.count()).toBe(2);
  });
});

describe('PATCH / DELETE /api/pages/[pageId]/comments/[commentId]', () => {
  it('lets the author and a moderator change a comment, and refuses another member', async () => {
    const f = await makeFixture();
    const author = await actorAs(f, 'author', 'member');
    const other = await actorAs(f, 'other', 'member');
    as(author);
    const root = await newThread(f.pageId, 'Mine');

    as(other);
    const forbidden = await edit(f.pageId, root.id, { bodyMd: 'Theirs' });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'PAGE_COMMENT_FORBIDDEN' });
    expect((await remove(f.pageId, root.id)).status).toBe(403);
    expect((await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } })).bodyMd).toBe(
      'Mine',
    );
    await reply(f.pageId, root.id, { bodyMd: 'a reply' });

    as(author);
    const mine = await edit(f.pageId, root.id, { bodyMd: 'Mine, edited' });
    expect(mine.status).toBe(200);
    expect((await mine.json()).editedAt).not.toBeNull();
    expect((await edit(f.pageId, root.id, { bodyMd: 7 })).status).toBe(400);

    as(f.manager);
    expect((await edit(f.pageId, root.id, { bodyMd: 'Moderated' })).status).toBe(200);
    const gone = await remove(f.pageId, root.id);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ commentId: root.id, parentCommentId: null, replyCount: 1 });
    expect(await adminDb.pageComment.count()).toBe(0);
  });
});

describe('POST / DELETE …/resolution', () => {
  it('resolves as the caller and reopens; either on a reply is 422', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    as(f.manager);
    const root = await newThread(f.pageId);
    const child = await (await reply(f.pageId, root.id, { bodyMd: 'r' })).json();

    as(member);
    const res = await resolve(f.pageId, root.id);
    expect(res.status).toBe(200);
    const thread = await res.json();
    expect(thread.resolvedAt).not.toBeNull();
    expect(thread.resolvedBy.id).toBe(member.userId);
    expect((await (await list(f.pageId)).json()).threads).toEqual([]);
    expect((await (await list(f.pageId, '?status=resolved')).json()).threads).toHaveLength(1);

    const back = await reopen(f.pageId, root.id);
    expect(back.status).toBe(200);
    expect((await back.json()).resolvedAt).toBeNull();
    expect((await (await list(f.pageId)).json()).threads).toHaveLength(1);

    for (const call of [resolve, reopen]) {
      const onReply = await call(f.pageId, child.id);
      expect(onReply.status).toBe(422);
      expect(await onReply.json()).toMatchObject({ code: 'PAGE_COMMENT_NOT_ROOT' });
    }
  });
});

describe('refused writes write nothing', () => {
  const sixWrites = (pageId: string, commentId: string) => [
    () => create(pageId, { bodyMd: 'new' }),
    () => reply(pageId, commentId, { bodyMd: 'r' }),
    () => edit(pageId, commentId, { bodyMd: 'changed' }),
    () => resolve(pageId, commentId),
    () => reopen(pageId, commentId),
    () => remove(pageId, commentId),
  ];

  it('refuses a viewer each write 403 PERMISSION_DENIED naming comment:add', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    as(f.manager);
    const root = await newThread(f.pageId);
    const before = await snapshot();
    as(viewer);
    for (const write of sixWrites(f.pageId, root.id)) {
      const res = await write();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'PERMISSION_DENIED',
        permission: 'comment:add',
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses each write 409 PAGE_ARCHIVED on an archived page, for a member and a moderator', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    as(member);
    const root = await newThread(f.pageId);
    await pagesService.archivePage(f.manager, { projectId: f.projectId, pageId: f.pageId });
    const before = await snapshot();
    for (const actor of [member, f.manager]) {
      as(actor);
      for (const write of sixWrites(f.pageId, root.id)) {
        const res = await write();
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'PAGE_ARCHIVED' });
      }
    }
    expect(await snapshot()).toEqual(before);

    as(member);
    const listed = await list(f.pageId);
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.threads).toHaveLength(1);
    expect(body.capabilities.canComment).toBe(false);
  });
});
