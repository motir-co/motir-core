import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consentedVisitor } from './_consentedVisitor';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';
import { boardsService } from '@/lib/services/boardsService';

// The client DATA DOORS a Visitor view calls (Story MOTIR-6170 · MOTIR-6647),
// driven as the browser drives them: the Visitor tab's `x-motir-visitor` address
// naming the public project (MOTIR-6892 — never the address), the reader's session, and the real resolver and datastore behind them.
// A signed-in, consented stranger is served that project's data, with every
// private-epic descendant withheld; everyone else — no session, no consent, a
// member — is answered exactly as the route answers today.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const wsCtx = { current: null as WorkspaceContext | null };
const incoming = { current: new Headers() };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
vi.mock('next/headers', () => ({
  headers: async () => incoming.current,
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getLocale: async () => 'en',
}));

const { GET: boardGET } = await import('@/app/api/board/route');
const { GET: boardsGET } = await import('@/app/api/boards/route');
const { GET: lanePageGET } = await import('@/app/api/board/columns/[columnId]/cards/route');
const { GET: peekGET } = await import('@/app/api/work-items/peek/route');
const { GET: commentsGET } = await import('@/app/api/work-items/[id]/comments/route');
const { GET: allGET } = await import('@/app/api/work-items/[id]/activity/all/route');
const { GET: historyGET } = await import('@/app/api/work-items/[id]/activity/history/route');
const { GET: rollupGET } = await import('@/app/api/work-items/[id]/rollup/route');
const { GET: roadmapGET } = await import('@/app/api/projects/[key]/roadmap/route');
const { GET: runGET } = await import('@/app/api/dispatch-runs/[id]/route');
const { listRootIssuesAction, listChildIssuesAction } =
  await import('@/app/(authed)/items/actions');

const BASE = 'http://localhost:3000';

let previousCloud: string | undefined;
// The read budget's window for the budget case: large enough for its slow
// calls, aligned by headroom rather than a whole-window sleep (rateLimitWindow.ts).
const READ_WINDOW_MS = 20_000;
const READ_HEADROOM_MS = 10_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  session.current = null;
  activeCtx.current = null;
  wsCtx.current = null;
  incoming.current = new Headers();
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'];
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A public project with a private epic (child C, grandchild G) and a visible item V. */
async function publicProject() {
  const identifier = `VD${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VD ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  const E = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic E' });
  const C = await createTestWorkItem(fx, { kind: 'story', title: 'Hidden C', parentId: E.id });
  const G = await createTestWorkItem(fx, { kind: 'subtask', title: 'Hidden G', parentId: C.id });
  const V = await createTestWorkItem(fx, { kind: 'story', title: 'Visible V' });
  for (const w of [E, C, G, V]) {
    await adminDb.workItem.update({ where: { id: w.id }, data: { status: 'todo' } });
  }
  await adminDb.workItem.update({ where: { id: E.id }, data: { publicChildrenHidden: true } });
  return { fx, identifier, E, C, G, V, hidden: [C, G] };
}

type Fixture = Awaited<ReturnType<typeof publicProject>>;

/** Sign the reader in as a consented stranger of `t`, addressed to it, no workspace. */
async function asVisitor(t: Fixture) {
  const ctx = await consentedVisitor(t.identifier);
  session.current = { user: { id: ctx.actorUserId, email: 'stranger@example.com', name: 'S' } };
  incoming.current = new Headers({ [VISITOR_ADDRESS_HEADER]: t.identifier });
  return ctx.actorUserId;
}

/** Sign the reader in as the project's own owner, with its active project and workspace. */
function asMember(t: Fixture) {
  session.current = { user: { id: t.fx.ownerId, email: 'owner@example.com', name: 'O' } };
  activeCtx.current = {
    userId: t.fx.ownerId,
    workspaceId: t.fx.workspaceId,
    projectId: t.fx.projectId,
    project: t.fx.project as unknown as ProjectContext['project'],
  };
  wsCtx.current = { userId: t.fx.ownerId, workspaceId: t.fx.workspaceId };
}

/** A request as a tab sends it: carrying `address` as its Visitor address, or none. */
const req = (path: string, address?: string) =>
  new Request(`${BASE}${path}`, {
    headers: address ? { [VISITOR_ADDRESS_HEADER]: address } : {},
  });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const text = async (res: Response) => JSON.stringify(await res.clone().json());

describe('a consented Visitor is served the public project, withheld rows excluded', () => {
  it('the board, boards, peek, comments, activity, rollup, roadmap and tree answer 200', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const address = t.identifier;

    const board = await boardGET(req('/api/board', address));
    expect(board.status).toBe(200);
    const boardBody = await text(board);
    expect(boardBody).toContain(t.V.id);
    for (const h of t.hidden) expect(boardBody).not.toContain(h.id);

    expect((await boardsGET(req('/api/boards', address))).status).toBe(200);

    const peek = await peekGET(req(`/api/work-items/peek?key=${t.V.identifier}`, address));
    expect(peek.status).toBe(200);
    expect(await text(peek)).not.toContain('@');

    for (const get of [commentsGET, allGET, historyGET]) {
      const res = await get(req(`/api/work-items/${t.V.id}/x`, address), params({ id: t.V.id }));
      expect(res.status).toBe(200);
    }
    const rollup = await rollupGET(
      req(`/api/work-items/${t.E.id}/rollup`, address),
      params({ id: t.E.id }),
    );
    expect(rollup.status).toBe(200);

    const roadmap = await roadmapGET(
      req(`/api/projects/${t.identifier}/roadmap`, address),
      params({ key: t.identifier }),
    );
    expect(roadmap.status).toBe(200);
    const roadmapBody = await text(roadmap);
    for (const h of t.hidden) expect(roadmapBody).not.toContain(h.id);

    const root = await listRootIssuesAction({ sortParam: '' });
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.level.rows.map((r) => r.id)).toEqual(expect.arrayContaining([t.E.id, t.V.id]));
      for (const h of t.hidden) expect(root.level.rows.map((r) => r.id)).not.toContain(h.id);
    }
    const drill = await listChildIssuesAction({ sortParam: '', parentId: t.E.id });
    expect(drill.ok && drill.level.rows).toEqual([]);
  });

  it("a lane's next page withholds private-epic rows exactly as the first page does (MOTIR-10535)", async () => {
    const t = await publicProject();
    // Enough visible rows to page the To Do lane, then two more withheld rows
    // created LAST so they rank onto the second page.
    const visible = [t.V.id];
    for (let i = 0; i < 11; i++) {
      const w = await createTestWorkItem(t.fx, { kind: 'story', title: `Visible ${i}` });
      visible.push(w.id);
    }
    const lateHidden = [];
    for (let i = 0; i < 2; i++) {
      const h = await createTestWorkItem(t.fx, {
        kind: 'story',
        title: `Hidden late ${i}`,
        parentId: t.E.id,
      });
      lateHidden.push(h.id);
    }
    await adminDb.workItem.updateMany({
      where: { projectId: t.fx.projectId },
      data: { status: 'todo' },
    });
    await asVisitor(t);
    const address = t.identifier;

    const board = (await (await boardGET(req('/api/board', address))).json()) as {
      boardId: string;
      columns: Array<{
        id: string;
        statusKeys: string[];
        cursor: string | null;
        cards: Array<{ id: string }>;
      }>;
    };
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    expect(todo.cursor).not.toBeNull();
    const seen = todo.cards.map((c) => c.id);
    const qs = new URLSearchParams({ boardId: board.boardId, cursor: todo.cursor! });
    const res = await lanePageGET(
      req(`/api/board/columns/${todo.id}/cards?${qs.toString()}`, address),
      params({ columnId: todo.id }),
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as { cards: Array<{ id: string }>; cursor: string | null };
    seen.push(...page.cards.map((c) => c.id));
    expect(page.cursor).toBeNull();
    // Every visible row exactly once, and no withheld row on either page.
    for (const id of visible) expect(seen.filter((s) => s === id)).toHaveLength(1);
    for (const id of [...t.hidden.map((h) => h.id), ...lateHidden]) {
      expect(seen).not.toContain(id);
    }
  });

  it('a Visitor lane page refuses a missing or forged cursor, and rethrows an untyped failure', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const address = t.identifier;
    const board = (await (await boardGET(req('/api/board', address))).json()) as {
      boardId: string;
      columns: Array<{ id: string }>;
    };
    const lane = board.columns[0]!.id;
    const pageOf = (qs: Record<string, string>) =>
      lanePageGET(
        req(`/api/board/columns/${lane}/cards?${new URLSearchParams(qs).toString()}`, address),
        params({ columnId: lane }),
      );

    expect((await pageOf({ boardId: board.boardId })).status).toBe(400);
    const forged = await pageOf({ boardId: board.boardId, cursor: 'forged' });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe('INVALID_BOARD_CURSOR');

    const spy = vi
      .spyOn(boardsService, 'getColumnPage')
      .mockRejectedValueOnce(new Error('visitor boom'));
    await expect(pageOf({ boardId: board.boardId, cursor: 'c' })).rejects.toThrow('visitor boom');
    spy.mockRestore();
  });

  it('a hidden item answers exactly as an unknown one does', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const address = t.identifier;
    const hidden = await commentsGET(req('/x', address), params({ id: t.C.id }));
    const unknown = await commentsGET(req('/x', address), params({ id: 'cm-not-an-item' }));
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    const hiddenPeek = await peekGET(req(`/api/work-items/peek?key=${t.C.identifier}`, address));
    const unknownPeek = await peekGET(
      req(`/api/work-items/peek?key=${t.identifier}-9999`, address),
    );
    expect(hiddenPeek.status).toBe(404);
    expect(await hiddenPeek.json()).toEqual(await unknownPeek.json());
    const drill = await listChildIssuesAction({ sortParam: '', parentId: t.C.id });
    expect(drill).toEqual({ ok: false, error: 'That issue no longer exists.' });
  });

  it('an address naming project A never serves a resource of project B', async () => {
    const a = await publicProject();
    const b = await publicProject();
    await asVisitor(a);
    const res = await commentsGET(req('/x', a.identifier), params({ id: b.V.id }));
    expect(res.status).toBe(404);
    const roadmap = await roadmapGET(req('/x', a.identifier), params({ key: b.identifier }));
    expect(roadmap.status).toBe(404);
  });

  it('a run touching a withheld item is not found; one on a visible item is served', async () => {
    const t = await publicProject();
    await asVisitor(t);
    const address = t.identifier;
    const run = (scopeWorkItemId: string) =>
      adminDb.dispatchRun.create({
        data: {
          workspaceId: t.fx.workspaceId,
          projectId: t.fx.projectId,
          command: 'run_scope',
          status: 'running',
          scopeWorkItemId,
          cards: {
            create: { workspaceId: t.fx.workspaceId, workItemId: scopeWorkItemId, position: 0 },
          },
        },
      });
    const visible = await run(t.V.id);
    const hidden = await run(t.C.id);
    expect((await runGET(req('/x', address), params({ id: visible.id }))).status).toBe(200);
    expect((await runGET(req('/x', address), params({ id: hidden.id }))).status).toBe(404);
  });
});

describe('everyone else is answered exactly as today', () => {
  it('no session answers 401, address or not', async () => {
    const t = await publicProject();
    const address = t.identifier;
    expect((await boardGET(req('/api/board', address))).status).toBe(401);
    const withAddress = await commentsGET(req('/x', address), params({ id: t.V.id }));
    const without = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(withAddress.status).toBe(401);
    expect(await withAddress.json()).toEqual(await without.json());
  });

  it('a signed-in stranger WITHOUT a consent gets the answer they get with no address', async () => {
    const t = await publicProject();
    const stranger = await adminDb.user.create({
      data: { email: `nc-${seq++}@example.com`, name: 'No consent', emailVerified: true },
    });
    session.current = { user: { id: stranger.id, email: stranger.email, name: 'N' } };
    const address = t.identifier;
    const withAddress = await boardGET(req('/api/board', address));
    const without = await boardGET(req('/api/board'));
    expect(withAddress.status).toBe(without.status);
    expect(await withAddress.json()).toEqual(await without.json());
    const cWith = await commentsGET(req('/x', address), params({ id: t.V.id }));
    const cWithout = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(cWith.status).toBe(cWithout.status);
  });

  it('an address naming a non-public or unknown project changes nothing', async () => {
    const t = await publicProject();
    await asVisitor(t);
    await adminDb.project.update({
      where: { id: t.fx.projectId },
      data: projectAccessData('members'),
    });
    const gone = await commentsGET(req('/x', t.identifier), params({ id: t.V.id }));
    const unknown = await commentsGET(req('/x', 'NOPE404'), params({ id: t.V.id }));
    const none = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(gone.status).toBe(none.status);
    expect(unknown.status).toBe(none.status);
  });

  it('a member of the project, address or not, is served exactly as today', async () => {
    const t = await publicProject();
    asMember(t);
    const address = t.identifier;
    const withAddress = await boardGET(req('/api/board', address));
    const without = await boardGET(req('/api/board'));
    expect(withAddress.status).toBe(200);
    expect(await text(withAddress)).toEqual(await text(without));
    const cWith = await commentsGET(req('/x', address), params({ id: t.C.id }));
    expect(cWith.status).toBe(200);
  });
});

describe('the per-person read budget', () => {
  it('a Visitor past the budget answers 429; a member is never counted', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '2';
    // The counted calls must share ONE epoch-aligned window cell (MOTIR-2648):
    // pin a window, and guarantee the calls below its headroom before spending.
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'] = String(READ_WINDOW_MS);
    const t = await publicProject();
    await asVisitor(t);
    await waitForWindowHeadroom(READ_WINDOW_MS, READ_HEADROOM_MS);
    const address = t.identifier;
    expect((await boardGET(req('/api/board', address))).status).toBe(200);
    expect((await boardGET(req('/api/board', address))).status).toBe(200);
    const refused = await boardGET(req('/api/board', address));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();

    asMember(t);
    for (let i = 0; i < 3; i += 1) {
      expect((await boardGET(req('/api/board', address))).status).toBe(200);
    }
  });
});

// ── MOTIR-6892 — the Visitor's address travels on the REQUEST, not in the browser ──
//
// The `motir_visitor` cookie is one value per browser, and a member page in the
// reader's OTHER tab clears it. So a Visitor tab names its project on every
// request it makes (`x-motir-visitor`, `lib/visitor/address.ts`), and the doors
// read that — the cookie is the proxy's redirect hint alone.
describe('the Visitor address is the request header, never the cookie (MOTIR-6892)', () => {
  /** The reader owns project M (their active project) AND is a consented Visitor of public T. */
  async function memberOfMVisitorOfT() {
    const m = await publicProject();
    const t = await publicProject();
    asMember(m);
    await visitorRecordsService.recordConsent({ identifier: t.identifier, userId: m.fx.ownerId });
    return { m, t };
  }
  const addressed = (path: string, identifier: string) => req(path, identifier);
  /** A request carrying `cookie` (and no address) — the member tab with a stale cookie. */
  const withCookie = (path: string, cookie: string) =>
    new Request(`${BASE}${path}`, { headers: { cookie } });

  it('with the cookie CLEARED, the address alone serves the public project on every Visitor read', async () => {
    const { m, t } = await memberOfMVisitorOfT();
    incoming.current = new Headers({ [VISITOR_ADDRESS_HEADER]: t.identifier });

    const board = await boardGET(addressed('/api/board', t.identifier));
    expect(board.status).toBe(200);
    const boardBody = await text(board);
    expect(boardBody).toContain(t.V.id);
    expect(boardBody).not.toContain(m.V.id);
    for (const h of t.hidden) expect(boardBody).not.toContain(h.id);

    expect((await boardsGET(addressed('/api/boards', t.identifier))).status).toBe(200);

    const peek = await peekGET(
      addressed(`/api/work-items/peek?key=${t.V.identifier}`, t.identifier),
    );
    expect(peek.status).toBe(200);
    expect(await text(peek)).toContain(t.V.identifier);

    for (const get of [commentsGET, allGET, historyGET]) {
      const res = await get(addressed('/x', t.identifier), params({ id: t.V.id }));
      expect(res.status).toBe(200);
    }
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: t.fx.workspaceId,
        projectId: t.fx.projectId,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId: t.V.id,
        cards: { create: { workspaceId: t.fx.workspaceId, workItemId: t.V.id, position: 0 } },
      },
    });
    expect((await runGET(addressed('/x', t.identifier), params({ id: run.id }))).status).toBe(200);

    const root = await listRootIssuesAction({ sortParam: '' });
    expect(root.ok).toBe(true);
    if (root.ok) {
      const ids = root.level.rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([t.E.id, t.V.id]));
      expect(ids).not.toContain(m.V.id);
    }
  });

  it('a member request with NO address is answered by the member path, even with a stale cookie', async () => {
    const { m, t } = await memberOfMVisitorOfT();
    const stale = `motir_visitor=${t.identifier}`;
    incoming.current = new Headers({ cookie: stale });

    const withStale = await boardGET(withCookie('/api/board', stale));
    const without = await boardGET(req('/api/board'));
    expect(withStale.status).toBe(200);
    const body = await text(withStale);
    expect(body).toEqual(await text(without));
    expect(body).toContain(m.V.id);
    expect(body).not.toContain(t.V.id);

    const peek = await peekGET(withCookie(`/api/work-items/peek?key=${m.V.identifier}`, stale));
    expect(peek.status).toBe(200);
    // Addressed by a resource of the public project, the member path's own answer stands.
    const foreign = await commentsGET(withCookie('/x', stale), params({ id: t.V.id }));
    const foreignNone = await commentsGET(req('/x'), params({ id: t.V.id }));
    expect(foreign.status).toBe(foreignNone.status);

    const root = await listRootIssuesAction({ sortParam: '' });
    expect(root.ok && root.level.rows.map((r) => r.id)).toEqual(expect.arrayContaining([m.V.id]));
    expect(root.ok && root.level.rows.map((r) => r.id)).not.toContain(t.V.id);
  });

  it('an address the session cannot visit grants nothing: not_found, enter and consent answer as the member path', async () => {
    const { m, t } = await memberOfMVisitorOfT();
    const memberBoard = await text(await boardGET(req('/api/board')));
    const memberComments = await commentsGET(req('/x'), params({ id: t.V.id }));

    // not_found — an unknown project, and a project that is no longer public.
    const other = await publicProject();
    await visitorRecordsService.recordConsent({
      identifier: other.identifier,
      userId: m.fx.ownerId,
    });
    await adminDb.project.update({
      where: { id: other.fx.projectId },
      data: projectAccessData('members'),
    });
    // enter — the reader's OWN project, which they can enter.
    // consent — a public project the reader never consented to.
    const unconsented = await publicProject();
    for (const address of ['NOPE404', other.identifier, m.identifier, unconsented.identifier]) {
      const board = await boardGET(addressed('/api/board', address));
      expect(board.status).toBe(200);
      expect(await text(board)).toEqual(memberBoard);
      const c = await commentsGET(addressed('/x', address), params({ id: t.V.id }));
      expect(c.status).toBe(memberComments.status);
    }
    // A malformed address is no address at all.
    const odd = await boardGET(addressed('/api/board', 'not a key!'));
    expect(await text(odd)).toEqual(memberBoard);
  });
});
