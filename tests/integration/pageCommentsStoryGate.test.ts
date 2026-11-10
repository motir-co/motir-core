import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, WorkspaceRole } from '@/generated/prisma/client';
import type { PageCommentResult } from '@/app/(authed)/pages/[pageId]/_components/pageCommentsClient';

// STORY MOTIR-10866's INTEGRATION GATE (MOTIR-10875) — page-level DISCUSSION,
// assembled, on real Postgres, through the real doors.
//
// Every card of the story tested its own layer with the next one faked: the
// table with rows seeded as the owner (MOTIR-10871), the procedures over the
// in-memory store and the adapter (MOTIR-10872), the gate order by calling the
// handlers (MOTIR-10873), the panel with its network module stubbed
// (MOTIR-10874). What none of them could see is the SEAMS:
//
//   1  every write goes through a route handler under
//      `app/api/pages/[pageId]/comments`, and every list is read back through
//      the PANEL'S OWN `pageCommentsClient.ts`, whose `fetch` is a dispatcher
//      onto those same handlers — so what is asserted is what the panel parses
//      from a real `Response`, never a fixture written on this side;
//   2  the guards that need the database: rows the routes wrote are invisible
//      under `motir_app` bound to another workspace, and every cross-workspace
//      route call is a 404 that writes nothing; an archived page refuses all six
//      writes and still reads; a permanent delete takes every comment with it.
//
// Mocked, and only these: the session and the active project (`getSession`,
// `getActiveProject`), which need cookies — the pattern of
// `pageArchiveStoryGate.test.ts`.

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

const actor = vi.hoisted(() => ({ current: null as Actor | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (actor.current ? { user: { id: actor.current.userId } } : null)),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () =>
    actor.current ? { ...actor.current, project: { identifier: actor.current.projectKey } } : null,
  ),
}));

const threadsRoute = await import('@/app/api/pages/[pageId]/comments/route');
const commentRoute = await import('@/app/api/pages/[pageId]/comments/[commentId]/route');
const repliesRoute = await import('@/app/api/pages/[pageId]/comments/[commentId]/replies/route');
const resolutionRoute =
  await import('@/app/api/pages/[pageId]/comments/[commentId]/resolution/route');
const { POST: ARCHIVE, DELETE: RESTORE } = await import('@/app/api/pages/[pageId]/archive/route');
const { DELETE: DESTROY } = await import('@/app/api/pages/[pageId]/route');
const client = await import('@/app/(authed)/pages/[pageId]/_components/pageCommentsClient');
const { pagesService } = await import('@/lib/services/pagesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

type ListResult = Awaited<ReturnType<typeof client.listPageComments>>;
type ThreadsList = Extract<ListResult, { ok: true }>['data'];

const ORIGIN = 'http://localhost:3000';

// ── The fetch dispatcher ─────────────────────────────────────────────────────
//
// The panel client builds relative URLs (`/api/pages/<id>/comments…`). This maps
// each onto the imported handler with a real `Request` and its `params`, and
// answers that handler's real `Response`. A URL or a method it does not know
// THROWS, so nothing can fall through to the network or pass by answering
// nothing.

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const COMMENT_PATH = /^\/api\/pages\/([^/]+)\/comments(?:\/([^/]+)(?:\/(replies|resolution))?)?$/;

const unrouted: string[] = [];

function handlerFor(method: string, tail: string | undefined, hasComment: boolean): Handler | null {
  const table: Record<string, Partial<Record<string, unknown>>> = {
    threads: threadsRoute,
    comment: commentRoute,
    replies: repliesRoute,
    resolution: resolutionRoute,
  };
  const which = tail ?? (hasComment ? 'comment' : 'threads');
  const handler = table[which]?.[method];
  return typeof handler === 'function' ? (handler as Handler) : null;
}

async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), ORIGIN);
  const method = (init?.method ?? 'GET').toUpperCase();
  const match = COMMENT_PATH.exec(url.pathname);
  const handler = match ? handlerFor(method, match[3], match[2] !== undefined) : null;
  if (!match || !handler) {
    unrouted.push(`${method} ${url.pathname}`);
    throw new Error(`the dispatcher does not route ${method} ${url.pathname}`);
  }
  const params: Record<string, string> = { pageId: decodeURIComponent(match[1]!) };
  if (match[2] !== undefined) params.commentId = decodeURIComponent(match[2]);
  return handler(new Request(url, init), { params: Promise.resolve(params) });
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  actor.current = null;
  unrouted.length = 0;
  vi.stubGlobal('fetch', vi.fn(dispatch));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-comments-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  /** The workspace owner — holds `comment:moderate`. */
  owner: Actor;
  pageId: string;
}

async function makeTenant(tag: string, key: string): Promise<Tenant> {
  const owner = await makeUser(tag);
  const ws = await workspacesService.createWorkspace({ name: tag, ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `${tag} project`,
    identifier: key,
  });
  const ownerActor = { userId: owner.id, workspaceId, projectId: project.id, projectKey: key };
  const page = await pagesService.createPage(
    { userId: owner.id, workspaceId },
    { projectId: project.id, title: 'Plan' },
  );
  return { workspaceId, projectId: project.id, owner: ownerActor, pageId: page.id };
}

async function memberOf(t: Tenant, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: t.workspaceId, workspaceRole: role },
  });
  return { ...t.owner, userId: user.id };
}

async function personOf(a: Actor) {
  const user = await adminDb.user.findUniqueOrThrow({
    where: { id: a.userId },
    select: { id: true, name: true, image: true },
  });
  return { id: user.id, name: user.name ?? '', image: user.image };
}

/** Run `fn` as `who` — the doors read the session and the active project. */
async function as<T>(who: Actor, fn: () => Promise<T>): Promise<T> {
  actor.current = who;
  try {
    return await fn();
  } finally {
    actor.current = null;
  }
}

function expectOk<T>(result: { ok: true; data: T } | { ok: false; status: number }): T {
  if (!result.ok) throw new Error(`expected ok, got HTTP ${result.status}`);
  return result.data;
}

async function list(who: Actor, pageId: string, status: 'open' | 'resolved'): Promise<ThreadsList> {
  return expectOk(await as(who, () => client.listPageComments(pageId, { status })));
}

const rowOf = (id: string) =>
  adminDb.pageComment.findUniqueOrThrow({
    where: { id },
    select: {
      bodyMd: true,
      editedAt: true,
      resolvedAt: true,
      resolvedById: true,
      anchor: true,
      anchorQuote: true,
    },
  });

/** Every row's mutable columns, to prove a refusal wrote nothing. */
const snapshot = (workspaceId?: string) =>
  adminDb.pageComment.findMany({
    where: workspaceId ? { workspaceId } : undefined,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      bodyMd: true,
      editedAt: true,
      resolvedAt: true,
      resolvedById: true,
      parentCommentId: true,
    },
  });

/** A count of `page_comment` as the app role, bound to one workspace (and project). */
function countAsApp(ctx: { userId: string; workspaceId: string; projectId: string }) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    const [row] = await tx.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM page_comment`;
    return Number(row!.n);
  });
}

const pageParams = (pageId: string) => ({ params: Promise.resolve({ pageId }) });
const archivePage = (pageId: string) =>
  ARCHIVE(
    new Request(`${ORIGIN}/api/pages/${pageId}/archive`, { method: 'POST' }),
    pageParams(pageId),
  );
const restorePage = (pageId: string) =>
  RESTORE(
    new Request(`${ORIGIN}/api/pages/${pageId}/archive`, { method: 'DELETE' }),
    pageParams(pageId),
  );
const destroyPage = (pageId: string) =>
  DESTROY(new Request(`${ORIGIN}/api/pages/${pageId}`, { method: 'DELETE' }), pageParams(pageId));

/** An anchored root, through the POST handler itself — the panel client sends no anchor. */
async function postAnchored(pageId: string, bodyMd: string, bytes: Uint8Array, quote: string) {
  const res = await threadsRoute.POST(
    new Request(`${ORIGIN}/api/pages/${pageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bodyMd,
        anchor: { bytes: Buffer.from(bytes).toString('base64'), quote },
      }),
    }),
    pageParams(pageId),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

/** All six writes, through the panel client, against one root. */
/** Each of the six writes, typed by what every one of them answers on a refusal. */
type AnyWrite = () => Promise<PageCommentResult<unknown>>;

function everyWrite(pageId: string, rootId: string): Record<string, AnyWrite> {
  return {
    create: () => client.createPageComment(pageId, 'new'),
    reply: () => client.replyToPageComment(pageId, rootId, 'reply'),
    edit: () => client.editPageComment(pageId, rootId, 'changed'),
    delete: () => client.deletePageComment(pageId, rootId),
    resolve: () => client.resolvePageCommentThread(pageId, rootId),
    reopen: () => client.reopenPageCommentThread(pageId, rootId),
  };
}

// ── 1 — the seams ────────────────────────────────────────────────────────────

describe('seam 1 — written through the routes, read back through the panel’s client', () => {
  it('create, reply, edit, resolve and reopen each read back as the row says', async () => {
    const t = await makeTenant('seam', 'PCS');
    const a = await memberOf(t, 'a', 'member');
    const b = await memberOf(t, 'b', 'member');
    const [aPerson, bPerson] = [await personOf(a), await personOf(b)];
    const body = `[@${bPerson.name}](mention:${b.userId}) can you review the rollout?`;

    // Create, reply, reply.
    const root = expectOk(await as(a, () => client.createPageComment(t.pageId, body)));
    const first = expectOk(
      await as(b, () => client.replyToPageComment(t.pageId, root.id, 'On it.')),
    );
    const second = expectOk(
      await as(a, () => client.replyToPageComment(t.pageId, root.id, 'Thanks!')),
    );

    let open = await list(a, t.pageId, 'open');
    expect(open.counts).toEqual({ open: 1, resolved: 0 });
    expect(open.threads).toHaveLength(1);
    const listed = open.threads[0]!;
    expect(listed).toMatchObject({
      id: root.id,
      author: aPerson,
      bodyMd: body,
      parentCommentId: null,
      anchor: null,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(listed.replies.map((r) => [r.id, r.author.id, r.parentCommentId])).toEqual([
      [first.id, b.userId, root.id],
      [second.id, a.userId, root.id],
    ]);
    expect((await rowOf(root.id)).bodyMd).toBe(body);

    // Edit.
    expectOk(await as(a, () => client.editPageComment(t.pageId, root.id, 'Reworded.')));
    open = await list(a, t.pageId, 'open');
    const edited = open.threads[0]!;
    expect(edited.bodyMd).toBe('Reworded.');
    expect(edited.editedAt).toBe((await rowOf(root.id)).editedAt!.toISOString());
    expect(edited.replies.map((r) => [r.id, r.bodyMd])).toEqual([
      [first.id, 'On it.'],
      [second.id, 'Thanks!'],
    ]);

    // Resolve, as B.
    expectOk(await as(b, () => client.resolvePageCommentThread(t.pageId, root.id)));
    open = await list(a, t.pageId, 'open');
    expect(open.threads).toEqual([]);
    expect(open.counts.open).toBe(0);
    const resolved = await list(a, t.pageId, 'resolved');
    expect(resolved.counts).toEqual({ open: 0, resolved: 1 });
    const row = await rowOf(root.id);
    expect(resolved.threads.map((th) => th.id)).toEqual([root.id]);
    expect(resolved.threads[0]!.resolvedBy).toEqual(bPerson);
    expect(resolved.threads[0]!.resolvedAt).toBe(row.resolvedAt!.toISOString());
    expect(row.resolvedById).toBe(b.userId);

    // Reopen, as A.
    expectOk(await as(a, () => client.reopenPageCommentThread(t.pageId, root.id)));
    open = await list(a, t.pageId, 'open');
    expect(open.threads.map((th) => [th.id, th.resolvedAt, th.resolvedBy])).toEqual([
      [root.id, null, null],
    ]);
    expect((await list(a, t.pageId, 'resolved')).threads).toEqual([]);
    expect(await rowOf(root.id)).toMatchObject({ resolvedAt: null, resolvedById: null });
    expect(unrouted).toEqual([]);
  });

  it('stores an anchor’s bytes unchanged and lists only its quote; a page-level root has none', async () => {
    const t = await makeTenant('anchor', 'PCA');
    const a = await memberOf(t, 'a', 'member');
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 127, 128]);
    const anchored = await as(a, () =>
      postAnchored(t.pageId, 'About this line', bytes, 'the second section'),
    );
    const plain = expectOk(await as(a, () => client.createPageComment(t.pageId, 'In general')));

    const open = await list(a, t.pageId, 'open');
    const byId = new Map(open.threads.map((th) => [th.id, th]));
    expect(byId.get(anchored.id)!.anchor).toEqual({ quote: 'the second section' });
    expect(byId.get(plain.id)!.anchor).toBeNull();
    const anchoredRow = await rowOf(anchored.id);
    expect(Buffer.from(anchoredRow.anchor!).equals(Buffer.from(bytes))).toBe(true);
    expect(anchoredRow.anchorQuote).toBe('the second section');
    expect(await rowOf(plain.id)).toMatchObject({ anchor: null, anchorQuote: null });
  });

  it('answers each reader’s capabilities: a viewer reads with none, a member may comment', async () => {
    const t = await makeTenant('caps', 'PCC');
    const a = await memberOf(t, 'a', 'member');
    const v = await memberOf(t, 'v', 'viewer');
    const root = expectOk(await as(a, () => client.createPageComment(t.pageId, 'Hello')));

    const asViewer = await list(v, t.pageId, 'open');
    expect(asViewer.threads.map((th) => th.id)).toEqual([root.id]);
    expect(asViewer.capabilities).toEqual({ canComment: false, canModerate: false });
    expect((await list(a, t.pageId, 'open')).capabilities).toEqual({
      canComment: true,
      canModerate: false,
    });
  });

  it('a URL the dispatcher does not route fails rather than falling through', async () => {
    await expect(dispatch('/api/pages/p/elsewhere')).rejects.toThrow('does not route');
    await expect(dispatch('/api/pages/p/comments', { method: 'PUT' })).rejects.toThrow(
      'does not route',
    );
    expect(unrouted).toEqual(['GET /api/pages/p/elsewhere', 'PUT /api/pages/p/comments']);
  });
});

// ── 2 — the guards ───────────────────────────────────────────────────────────

describe('guard 1 — another workspace sees and changes nothing', () => {
  it('rows the routes wrote are invisible to motir_app bound to W2, and every W2 call is a 404', async () => {
    const w1 = await makeTenant('w1', 'PW1');
    const w2 = await makeTenant('w2', 'PW2');
    const a = await memberOf(w1, 'a', 'member');
    const root = expectOk(await as(a, () => client.createPageComment(w1.pageId, 'W1 only')));
    expectOk(await as(a, () => client.replyToPageComment(w1.pageId, root.id, 'Also W1')));

    // Not vacuous: bound to W1 the rows are there.
    expect(await countAsApp({ ...a })).toBe(2);
    expect(await countAsApp({ ...w2.owner })).toBe(0);

    const before = await snapshot(w1.workspaceId);
    const listRefusal = await as(w2.owner, () =>
      client.listPageComments(w1.pageId, { status: 'open' }),
    );
    expect(listRefusal).toMatchObject({ ok: false, status: 404, code: 'PAGE_NOT_FOUND' });
    for (const [name, write] of Object.entries(everyWrite(w1.pageId, root.id))) {
      const res = await as(w2.owner, write);
      expect(res, name).toMatchObject({ ok: false, status: 404, code: 'PAGE_NOT_FOUND' });
    }
    expect(await snapshot(w1.workspaceId)).toEqual(before);
    expect(await adminDb.pageComment.count({ where: { workspaceId: w2.workspaceId } })).toBe(0);
  });
});

describe('guard 2 — an archived page’s discussion reads and refuses every write', () => {
  it('409 PAGE_ARCHIVED for a member and a moderator, the list still reads, and restore reopens it', async () => {
    const t = await makeTenant('archive', 'PCR');
    const a = await memberOf(t, 'a', 'member');
    const root = expectOk(await as(a, () => client.createPageComment(t.pageId, 'Root')));
    expectOk(await as(a, () => client.replyToPageComment(t.pageId, root.id, 'Reply')));

    expect((await as(t.owner, () => archivePage(t.pageId))).status).toBe(200);
    const before = await snapshot();
    for (const who of [a, t.owner]) {
      for (const [name, write] of Object.entries(everyWrite(t.pageId, root.id))) {
        const res = await as(who, write);
        expect(res, name).toMatchObject({ ok: false, status: 409, code: 'PAGE_ARCHIVED' });
      }
    }
    expect(await snapshot()).toEqual(before);
    const listed = await list(a, t.pageId, 'open');
    expect(listed.threads.map((th) => th.id)).toEqual([root.id]);
    expect(listed.capabilities.canComment).toBe(false);
    expect((await list(t.owner, t.pageId, 'open')).capabilities.canComment).toBe(false);

    expect((await as(t.owner, () => restorePage(t.pageId))).status).toBe(200);
    const after = await as(a, () => client.createPageComment(t.pageId, 'Back again'));
    expect(after.ok).toBe(true);
    const reopened = await list(a, t.pageId, 'open');
    expect(reopened.capabilities.canComment).toBe(true);
    expect(reopened.threads.map((th) => th.bodyMd)).toContain('Back again');
  });
});

describe('guard 3 — permanently deleting a page takes its whole discussion', () => {
  it('no comment of the page survives, and a sibling page keeps its own', async () => {
    const t = await makeTenant('cascade', 'PCD');
    const a = await memberOf(t, 'a', 'member');
    const sibling = await pagesService.createPage(
      { userId: t.owner.userId, workspaceId: t.workspaceId },
      { projectId: t.projectId, title: 'Sibling' },
    );
    const root = expectOk(await as(a, () => client.createPageComment(t.pageId, 'Root')));
    expectOk(await as(a, () => client.replyToPageComment(t.pageId, root.id, 'Reply one')));
    expectOk(await as(a, () => client.replyToPageComment(t.pageId, root.id, 'Reply two')));
    const settled = expectOk(await as(a, () => client.createPageComment(t.pageId, 'Settled')));
    expectOk(await as(a, () => client.resolvePageCommentThread(t.pageId, settled.id)));
    await as(a, () => postAnchored(t.pageId, 'Anchored', Uint8Array.from([7, 7]), 'a quote'));
    const kept = expectOk(await as(a, () => client.createPageComment(sibling.id, 'Sibling note')));
    expect(await adminDb.pageComment.count({ where: { pageId: t.pageId } })).toBe(5);

    expect((await as(t.owner, () => archivePage(t.pageId))).status).toBe(200);
    expect((await as(t.owner, () => destroyPage(t.pageId))).status).toBe(200);

    expect(await adminDb.pageComment.count({ where: { pageId: t.pageId } })).toBe(0);
    expect((await adminDb.pageComment.findMany({ select: { id: true } })).map((r) => r.id)).toEqual(
      [kept.id],
    );
  });
});
