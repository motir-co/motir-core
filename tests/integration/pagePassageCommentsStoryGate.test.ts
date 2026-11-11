import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { anchorDocument, anchorFromSelection, resolveStoredAnchor } from '@motir/pages';

// STORY MOTIR-10867's INTEGRATION GATE (MOTIR-10903) — COMMENT ON A PASSAGE,
// assembled, on real Postgres, through the real doors.
//
// Every card of the story tested its own layer with the next one faked: the codec
// over a hand-built Yjs document (MOTIR-10899), the selection and the composer in
// jsdom with the post stubbed (MOTIR-10900/10901), the arrival with its network
// module stubbed (MOTIR-10902). What none of them could see is the SEAM between
// the anchor the editor captures and the row the create door stores:
//
//   1  an anchor captured from a page body the SAVE door wrote, posted through
//      the panel's own `pageCommentsClient.ts` onto the real create route, lists
//      back with the same bytes and quote, and those stored bytes resolve against
//      the persisted `bodyState` to the passage — and to nothing once the passage
//      is deleted or emptied to whitespace;
//   2  commenting is not editing: the create leaves `revision` and `bodyState`
//      byte-identical, and a reader holding `comment:add` without `page:edit`
//      may comment on a passage while one without `comment:add` may not;
//   3  the columns pair: a page-level root and a reply carry neither part;
//   4  the package stays the app's dependency, never the reverse.
//
// Mocked, and only these: the session and the active project, which need cookies
// — the pattern of `pageCommentsStoryGate.test.ts`.

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
const threadRoute = await import('@/app/api/pages/[pageId]/comments/[commentId]/thread/route');
const client = await import('@/app/(authed)/pages/[pageId]/_components/pageCommentsClient');
const { pagesService } = await import('@/lib/services/pagesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const ORIGIN = 'http://localhost:3000';

// ── Yjs, as the package resolves it ──────────────────────────────────────────
//
// The anchor is relative positions into the page's Yjs document, so an edit that
// moves or removes the passage must be a real Yjs update — the one the editor's
// autosave ships. The app never names `yjs`; it is reached from the package's own
// resolution (`pagesStoryGate.test.ts`), so it is the SAME instance the codec uses.

interface YText {
  readonly length: number;
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  toString(): string;
}
interface YXml {
  readonly length: number;
  toArray(): unknown[];
}
interface YDoc {
  on(event: 'update', handler: (update: Uint8Array) => void): void;
  transact(fn: () => void): void;
  getXmlFragment(name: string): YXml;
}
interface Yjs {
  Doc: new () => YDoc;
  XmlText: new () => YText;
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  mergeUpdates(updates: Uint8Array[]): Uint8Array;
}
const Y = createRequire(join(process.cwd(), 'packages', 'pages', 'package.json'))('yjs') as Yjs;

/** Every text run of the body, depth first — where an edit finds its words. */
function textRuns(node: YXml | YText, out: YText[] = []): YText[] {
  if (node instanceof Y.XmlText) {
    out.push(node as YText);
    return out;
  }
  for (const child of (node as YXml).toArray()) textRuns(child as YXml, out);
  return out;
}

/** The update the editor would send after replacing `needle` with `replacement`. */
function editorEdit(state: Uint8Array, needle: string, replacement: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const batch: Uint8Array[] = [];
  doc.on('update', (update) => batch.push(update));
  const run = textRuns(doc.getXmlFragment('default')).find((t) => t.toString().includes(needle));
  if (!run) throw new Error(`no run holds "${needle}"`);
  const at = run.toString().indexOf(needle);
  doc.transact(() => {
    run.delete(at, needle.length);
    if (replacement) run.insert(at, replacement);
  });
  expect(batch.length).toBe(1);
  return Y.mergeUpdates(batch);
}

/** Where `needle` sits in the ProseMirror body: the selection a reader would make. */
function rangeOf(doc: ProseMirrorNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(needle);
    if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
    return false;
  });
  if (!found) throw new Error(`the body holds no "${needle}"`);
  return found;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

// ── The fetch dispatcher (the pattern of `pageCommentsStoryGate.test.ts`) ────

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const COMMENT_PATH =
  /^\/api\/pages\/([^/]+)\/comments(?:\/([^/]+)(?:\/(replies|resolution|thread))?)?$/;

const unrouted: string[] = [];

async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), ORIGIN);
  const method = (init?.method ?? 'GET').toUpperCase();
  const match = COMMENT_PATH.exec(url.pathname);
  const table: Record<string, Partial<Record<string, unknown>>> = {
    threads: threadsRoute,
    comment: commentRoute,
    replies: repliesRoute,
    resolution: resolutionRoute,
    thread: threadRoute,
  };
  const which = match ? (match[3] ?? (match[2] !== undefined ? 'comment' : 'threads')) : '';
  const handler = table[which]?.[method];
  if (!match || typeof handler !== 'function') {
    unrouted.push(`${method} ${url.pathname}`);
    throw new Error(`the dispatcher does not route ${method} ${url.pathname}`);
  }
  const params: Record<string, string> = { pageId: decodeURIComponent(match[1]!) };
  if (match[2] !== undefined) params.commentId = decodeURIComponent(match[2]);
  return (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) });
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

const BODY = [
  '# Rollout',
  '',
  'The rollout starts on Monday with the internal workspace.',
  '',
  'Customers follow a week later, once the dashboards are green.',
].join('\n');

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `passage-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  owner: Actor;
  pageId: string;
}

/** A workspace, a project, and a page whose body the SAVE door wrote. */
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
  const page = await pagesService.createPageFromMarkdown(
    { userId: owner.id, workspaceId },
    { projectId: project.id, title: 'Plan', markdown: BODY },
  );
  return {
    workspaceId,
    owner: { userId: owner.id, workspaceId, projectId: project.id, projectKey: key },
    pageId: page.id,
  };
}

async function memberOf(t: Tenant, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: t.workspaceId, workspaceRole: role },
  });
  return { ...t.owner, userId: user.id };
}

/** A member on a workspace custom role holding exactly `permissions`. */
async function customOf(t: Tenant, tag: string, permissions: string[]): Promise<Actor> {
  const role = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: t.workspaceId, name: `Gate ${tag} ${seq}`, permissions },
  });
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: {
      userId: user.id,
      workspaceId: t.workspaceId,
      workspaceRole: 'member',
      roleDefinitionId: role.id,
    },
  });
  return { ...t.owner, userId: user.id };
}

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

const pageRow = (pageId: string) =>
  adminDb.page.findUniqueOrThrow({
    where: { id: pageId },
    select: { bodyState: true, revision: true, updatedAt: true },
  });

/** What the editor captures when a reader selects `needle` on the stored body. */
async function captured(pageId: string, needle: string) {
  const { bodyState } = await pageRow(pageId);
  const d = anchorDocument(new Uint8Array(bodyState));
  const range = rangeOf(d.doc, needle);
  const anchor = anchorFromSelection(d, range.from, range.to);
  if (!anchor) throw new Error(`the codec captured nothing for "${needle}"`);
  return { range, bytes: anchor.bytes, quote: anchor.quote };
}

/** Where the stored anchor of comment `id` lands on the page's stored body now. */
async function resolvedNow(pageId: string, id: string) {
  const [row, page] = await Promise.all([
    adminDb.pageComment.findUniqueOrThrow({ where: { id }, select: { anchor: true } }),
    pageRow(pageId),
  ]);
  return resolveStoredAnchor(new Uint8Array(row.anchor!), new Uint8Array(page.bodyState));
}

async function saveEdit(t: Tenant, needle: string, replacement: string) {
  const { bodyState } = await pageRow(t.pageId);
  await pagesService.savePageUpdate(
    { userId: t.owner.userId, workspaceId: t.workspaceId },
    {
      projectId: t.owner.projectId,
      pageId: t.pageId,
      update: editorEdit(new Uint8Array(bodyState), needle, replacement),
    },
  );
}

const PASSAGE = 'starts on Monday';

// ── 1 — captured, stored, listed, resolved ──────────────────────────────────

describe('seam 1 — the anchor the editor captures is the anchor the page resolves', () => {
  it('lists back with the same bytes and quote, and resolves to the passage on the stored body', async () => {
    const t = await makeTenant('seam', 'PPS');
    const a = await memberOf(t, 'a', 'member');
    const cap = await captured(t.pageId, PASSAGE);
    expect(cap.quote).toBe(PASSAGE);

    const root = expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Monday is a holiday.', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    expect(root.anchor).toEqual({ bytes: toBase64(cap.bytes), quote: PASSAGE });

    const listed = expectOk(
      await as(a, () => client.listPageComments(t.pageId, { status: 'open' })),
    );
    expect(listed.threads.map((th) => [th.id, th.anchor])).toEqual([
      [root.id, { bytes: toBase64(cap.bytes), quote: PASSAGE }],
    ]);
    const row = await adminDb.pageComment.findUniqueOrThrow({
      where: { id: root.id },
      select: { anchor: true, anchorQuote: true },
    });
    expect(Buffer.from(row.anchor!).equals(Buffer.from(cap.bytes))).toBe(true);
    expect(row.anchorQuote).toBe(PASSAGE);

    // The stored bytes, decoded, land on exactly the range the reader selected.
    expect(await resolvedNow(t.pageId, root.id)).toEqual(cap.range);

    // An edit BEFORE the passage moves it, and the anchor follows.
    await saveEdit(t, 'The rollout', 'The staged rollout');
    const moved = await resolvedNow(t.pageId, root.id);
    expect(moved).toEqual({ from: cap.range.from + 7, to: cap.range.to + 7 });
    expect(unrouted).toEqual([]);
  });

  it('is gone once the passage is deleted', async () => {
    const t = await makeTenant('gone', 'PPG');
    const a = await memberOf(t, 'a', 'member');
    const cap = await captured(t.pageId, PASSAGE);
    const root = expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Too soon?', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    expect(await resolvedNow(t.pageId, root.id)).toEqual(cap.range);
    await saveEdit(t, ` ${PASSAGE}`, '');
    expect(await resolvedNow(t.pageId, root.id)).toBeNull();
    // The quote is kept for the panel's gone line.
    const listed = expectOk(
      await as(a, () => client.listPageComments(t.pageId, { status: 'open' })),
    );
    expect(listed.threads[0]!.anchor).toEqual({ bytes: toBase64(cap.bytes), quote: PASSAGE });
  });

  it('is gone once the passage is emptied to whitespace', async () => {
    const t = await makeTenant('blank', 'PPW');
    const a = await memberOf(t, 'a', 'member');
    const cap = await captured(t.pageId, PASSAGE);
    const root = expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Which Monday?', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    await saveEdit(t, PASSAGE, ' '.repeat(PASSAGE.length));
    expect(await resolvedNow(t.pageId, root.id)).toBeNull();
  });

  it('a resolved thread keeps an anchor that still resolves', async () => {
    const t = await makeTenant('resolved', 'PPR');
    const a = await memberOf(t, 'a', 'member');
    const cap = await captured(t.pageId, 'the dashboards are green');
    const root = expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Which dashboards?', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    expectOk(await as(a, () => client.resolvePageCommentThread(t.pageId, root.id)));

    const resolved = expectOk(
      await as(a, () => client.listPageComments(t.pageId, { status: 'resolved' })),
    );
    expect(resolved.threads.map((th) => [th.id, th.anchor])).toEqual([
      [root.id, { bytes: toBase64(cap.bytes), quote: 'the dashboards are green' }],
    ]);
    const read = expectOk(await as(a, () => client.readPageThread(t.pageId, root.id)));
    expect(read.anchor).toEqual({ bytes: toBase64(cap.bytes), quote: 'the dashboards are green' });
    expect(await resolvedNow(t.pageId, root.id)).toEqual(cap.range);
  });
});

// ── 2 — commenting is not editing ───────────────────────────────────────────

describe('seam 2 — an inline comment never writes the page, and needs comment:add only', () => {
  it('leaves revision and bodyState byte-identical', async () => {
    const t = await makeTenant('still', 'PPB');
    const a = await memberOf(t, 'a', 'member');
    const before = await pageRow(t.pageId);
    const cap = await captured(t.pageId, PASSAGE);
    expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Noted.', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    const after = await pageRow(t.pageId);
    expect(after.revision).toBe(before.revision);
    expect(Buffer.from(after.bodyState).equals(Buffer.from(before.bodyState))).toBe(true);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('a reader with comment:add and no page:edit comments; one without comment:add is refused', async () => {
    const t = await makeTenant('perm', 'PPP');
    const commenter = await customOf(t, 'commenter', [
      'project:browse',
      'page:view',
      'comment:add',
    ]);
    const viewer = await memberOf(t, 'viewer', 'viewer');
    const cap = await captured(t.pageId, PASSAGE);
    const anchor = { bytes: toBase64(cap.bytes), quote: cap.quote };

    // Not vacuous: the commenter may not edit the page.
    const { bodyState } = await pageRow(t.pageId);
    await expect(
      pagesService.savePageUpdate(
        { userId: commenter.userId, workspaceId: t.workspaceId },
        {
          projectId: t.owner.projectId,
          pageId: t.pageId,
          update: editorEdit(new Uint8Array(bodyState), 'Monday', 'Tuesday'),
        },
      ),
    ).rejects.toMatchObject({ name: 'ProjectAccessDeniedError' });

    const listed = expectOk(
      await as(commenter, () => client.listPageComments(t.pageId, { status: 'open' })),
    );
    expect(listed.capabilities.canComment).toBe(true);
    const root = expectOk(
      await as(commenter, () => client.createPageComment(t.pageId, 'From a commenter', anchor)),
    );
    expect(root.anchor).toEqual(anchor);

    const refused = await as(viewer, () =>
      client.createPageComment(t.pageId, 'From a viewer', anchor),
    );
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(await adminDb.pageComment.count({ where: { pageId: t.pageId } })).toBe(1);
  });
});

// ── 3 — the columns pair ────────────────────────────────────────────────────

describe('seam 3 — a page-level root and a reply carry neither part of an anchor', () => {
  it('stores null anchor and anchor_quote for both, and every row is both or neither', async () => {
    const t = await makeTenant('pair', 'PPN');
    const a = await memberOf(t, 'a', 'member');
    const cap = await captured(t.pageId, PASSAGE);
    const inline = expectOk(
      await as(a, () =>
        client.createPageComment(t.pageId, 'Inline', {
          bytes: toBase64(cap.bytes),
          quote: cap.quote,
        }),
      ),
    );
    const pageLevel = expectOk(await as(a, () => client.createPageComment(t.pageId, 'Overall')));
    const reply = expectOk(
      await as(a, () => client.replyToPageComment(t.pageId, inline.id, 'A reply')),
    );

    const rows = await adminDb.$queryRaw<
      { id: string; anchor: Uint8Array | null; anchor_quote: string | null }[]
    >`SELECT id, anchor, anchor_quote FROM page_comment ORDER BY created_at`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pageLevel.id)).toMatchObject({ anchor: null, anchor_quote: null });
    expect(byId.get(reply.id)).toMatchObject({ anchor: null, anchor_quote: null });
    expect(byId.get(inline.id)!.anchor_quote).toBe(PASSAGE);
    for (const row of rows) {
      expect(row.anchor === null, row.id).toBe(row.anchor_quote === null);
    }
  });
});

// ── 4 — the dependency points one way ───────────────────────────────────────

describe('seam 4 — nothing under packages/pages/src imports from the app', () => {
  const ROOT = resolve(process.cwd(), 'packages', 'pages');
  const SRC = join(ROOT, 'src');

  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (/\.(ts|tsx|mts|cts|js|jsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  const SPECIFIER =
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

  it('every import is the package’s own file or a dependency, never `@/` or a path out of it', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    const escapes: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[1] ?? m[2]!;
        const rel = relative(ROOT, file);
        if (spec.startsWith('@/') || spec === '@') escapes.push(`${rel} → ${spec}`);
        else if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (target !== ROOT && !target.startsWith(ROOT + sep)) escapes.push(`${rel} → ${spec}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });
});
