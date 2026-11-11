import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@/generated/prisma/client';

// THE STORY INTEGRATION GATE (Story MOTIR-10868 · MOTIR-10928), on real Postgres:
// a page comment written through `pageCommentsService` (and once through the real
// POST route), the `page/comment.created` event taken off the shipped dispatch seam,
// BOTH consumers selected from `jobDefinitions` by that trigger and run in process,
// the rows read back through the admin client and through the drawer's own feed
// read (`notificationsService.listNotifications` → `toNotificationDto`), and the
// queued sends captured — one of them driven through the real `email.send` job.
//
// The cases assert the PROPERTIES the cards agreed — one dedupe key per comment,
// one send key per comment × recipient, an arm kind that reads back unchanged —
// rather than retyping each card's literals, so a typo shared by a producer and its
// own test cannot pass here. The trigger is the one literal taken as given: it is
// the event name the emit card publishes, and the registry is filtered on it.

// The route's session and active-project reads are the only things stubbed, and
// only for the one route-driven case: everything under the handler is real.
const session = vi.hoisted(() => ({
  current: null as { userId: string; workspaceId: string; projectId: string } | null,
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: async () => ({ ok: true }),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => session.current,
}));

const { db } = await import('@/lib/db');
const { POST: postPageCommentRoute } = await import('@/app/api/pages/[pageId]/comments/route');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { pageRepository } = await import('@/lib/repositories/pageRepository');
const { commentsService } = await import('@/lib/services/commentsService');
const { notificationsService } = await import('@/lib/services/notificationsService');
const { pageCommentsService } = await import('@/lib/services/pageCommentsService');
const { pagesService } = await import('@/lib/services/pagesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { createTestWorkItem } = await import('../fixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');
const { JobTestEngine, captureConsoleEmails, captureJobEvents, runEmailSendJob } =
  await import('../helpers/jobs');
import type { EmailSendData, PageCommentCreatedData } from '@/lib/jobs/types';
import type { NotificationData } from '@/lib/dto/notifications';

const PAGE_EVENT = 'page/comment.created';
const WORK_ITEM_EVENT = 'work-item/comment.created';

let captured: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  captured = captureJobEvents();
  session.current = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixture ────────────────────────────────────────────────────────────────

interface Person {
  userId: string;
  workspaceId: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  a: Person;
  b: Person;
  c: Person;
  d: Person;
  /** A workspace member holding no role in the project. */
  outsider: Person;
}

let seq = 0;
async function user(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${tag.toUpperCase()}${seq}`,
  });
}

async function makeTenant(identifier = 'PGT', title = 'Release checklist'): Promise<Tenant> {
  const owner = await user('a');
  const ws = await workspacesService.createWorkspace({ name: 'Gate', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Gate',
    identifier,
  });
  const a = { userId: owner.id, workspaceId, email: owner.email, name: owner.name };
  const pageId = await addPage({ workspaceId, projectId: project.id, a }, title);
  const member = async (tag: string, accessScope: 'full' | 'limited' = 'full') => {
    const u = await user(tag);
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId, workspaceRole: 'member', accessScope },
    });
    return { userId: u.id, workspaceId, email: u.email, name: u.name };
  };
  return {
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    pageId,
    a,
    b: await member('b'),
    c: await member('c'),
    d: await member('d'),
    outsider: await member('out', 'limited'),
  };
}

async function addPage(
  t: Pick<Tenant, 'workspaceId' | 'projectId' | 'a'>,
  title: string,
): Promise<string> {
  const page = await pagesService.createPage(t.a, { projectId: t.projectId, title: 'Draft' });
  // The stored title verbatim (`''` for an untitled page) is what the arm carries.
  await adminDb.page.update({ where: { id: page.id }, data: { title } });
  return page.id;
}

const token = (p: Person) => `[@${p.name}](mention:${p.userId})`;
const on = (t: Tenant, pageId = t.pageId) => ({ projectId: t.projectId, pageId });

// ── the joined path ────────────────────────────────────────────────────────

/** The consumers the WORKER would run for an event: the registry, filtered. */
const consumersOf = (event: string) => jobDefinitions.filter((d) => d.trigger === event);

function lastPageEvent(): PageCommentCreatedData {
  const events = captured.events.filter((e) => e.name === PAGE_EVENT);
  return events.at(-1)!.data as PageCommentCreatedData;
}

const pageEventCount = () => captured.events.filter((e) => e.name === PAGE_EVENT).length;

/** Every `email.send` queued since `from`. */
function sends(from = 0): EmailSendData[] {
  return captured.events
    .slice(from)
    .filter((e) => e.name === 'email.send')
    .map((e) => e.data as EmailSendData);
}

/** Run every registered consumer of `event` on `data`; their results by job id. */
async function dispatch(event: string, data: unknown): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const fn of consumersOf(event)) {
    const { result } = await new JobTestEngine({
      function: fn as never,
      events: [{ name: event, data } as never],
    }).execute();
    results[fn.id] = result;
  }
  return results;
}

/** Run the page consumers; the sends they queued and the in-app result. */
async function dispatchPage(event: PageCommentCreatedData) {
  const from = captured.events.length;
  const results = await dispatch(PAGE_EVENT, event);
  const inApp = Object.values(results).find(
    (r): r is { writtenUserIds: string[] } => !!r && typeof r === 'object' && 'writtenUserIds' in r,
  );
  return { results, inApp, sends: sends(from) };
}

async function thread(t: Tenant, author: Person, bodyMd: string, pageId = t.pageId) {
  const root = await pageCommentsService.postPageComment(author, { ...on(t, pageId), bodyMd });
  return { root, event: lastPageEvent() };
}

async function reply(t: Tenant, author: Person, rootId: string, bodyMd: string) {
  const row = await pageCommentsService.postPageReply(author, {
    ...on(t),
    parentCommentId: rootId,
    bodyMd,
  });
  return { row, event: lastPageEvent() };
}

const rowsFor = (where: { recipientUserId?: string; pageId?: string }): Promise<Notification[]> =>
  adminDb.notification.findMany({ where, orderBy: { createdAt: 'asc' } });

const dataOf = (row: Notification) => row.data as unknown as NotificationData;

/** Rows per recipient for the rows that share one comment's dedupe key. */
async function rowsPerRecipient(commentRowKey: string) {
  const rows = await adminDb.notification.findMany({ where: { dedupeKey: commentRowKey } });
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.recipientUserId, (counts.get(r.recipientUserId) ?? 0) + 1);
  return counts;
}

/** The one dedupe key every row of one comment carries (asserted, not spelled). */
async function oneKeyFor(pageId: string): Promise<string> {
  const keys = new Set((await rowsFor({ pageId })).map((r) => r.dedupeKey));
  expect(keys.size).toBe(1);
  return [...keys][0]!;
}

const feedOf = (p: Person) => notificationsService.listNotifications({}, p);

const variantOf = (s: EmailSendData) => (s.data as { variant: string }).variant;
const threadUrlOf = (s: EmailSendData) => (s.data as { threadUrl: string }).threadUrl;

// ── the registry seam ──────────────────────────────────────────────────────

describe('the registry seam', () => {
  it('exactly two registered definitions consume the page comment event', () => {
    const ids = consumersOf(PAGE_EVENT).map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// ── a mention ──────────────────────────────────────────────────────────────

describe('a page comment that mentions a project member', () => {
  it('writes exactly one whole page-mention row for B and none for A', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Can you check this, ${token(t.b)}?`);
    expect(event.commentId).toBe(root.id);

    const { inApp } = await dispatchPage(event);

    expect(inApp?.writtenUserIds).toEqual([t.b.userId]);
    expect(await rowsFor({ recipientUserId: t.a.userId })).toEqual([]);
    const [row, ...rest] = await rowsFor({ recipientUserId: t.b.userId });
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      workspaceId: t.workspaceId,
      type: 'mentioned',
      category: 'direct',
      actorId: t.a.userId,
      workItemId: null,
      pageId: t.pageId,
    });
    const data = dataOf(row!);
    expect(data.kind).toBe('page_mentioned');
    if (data.kind !== 'page_mentioned') throw new Error('unreachable');
    expect(data).toMatchObject({
      pageId: t.pageId,
      pageTitle: 'Release checklist',
      projectKey: t.projectKey,
      threadRootId: root.id,
    });
    expect(data.excerpt).toBeTruthy();
    expect(data.excerpt).toContain(`@${t.b.name}`);
  });

  it('queues exactly one mention send for B, and nothing for anyone else', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Can you check this, ${token(t.b)}?`);

    const { sends: queued } = await dispatchPage(event);

    expect(queued).toHaveLength(1);
    const [send] = queued;
    expect(send!.to).toBe(t.b.email);
    expect(send!.template).toBe('page-comment-notification');
    expect(variantOf(send!)).toBe('mention');
    expect((send!.data as { pageTitle: string }).pageTitle).toBe('Release checklist');
    const url = new URL(threadUrlOf(send!));
    expect(url.pathname).toBe(`/pages/${t.pageId}`);
    expect(url.searchParams.get('thread')).toBe(root.id);
    expect(send!.idempotencyKey).toContain(root.id);
    expect(send!.idempotencyKey).toContain(t.b.userId);
  });

  it('the queued send renders through the real email.send job under the console provider', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'console');
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `Can you check this, ${token(t.b)}?`);
    const {
      sends: [send],
    } = await dispatchPage(event);

    const mail = captureConsoleEmails();
    try {
      const { result } = await runEmailSendJob(send!);
      expect(JSON.stringify(result ?? {})).not.toContain('notification_budget_exhausted');
      expect(result).not.toMatchObject({ skipped: true });
      expect(mail.lines).toHaveLength(1);
      expect(mail.lines[0]).toContain(t.b.email);
      expect(mail.lines[0]).toContain(threadUrlOf(send!));
    } finally {
      mail.restore();
      vi.unstubAllEnvs();
    }
  });

  it('B’s drawer feed returns the page-mention arm with every field intact', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Can you check this, ${token(t.b)}?`);
    await dispatchPage(event);

    const feed = await feedOf(t.b);
    expect(feed.notifications).toHaveLength(1);
    const [n] = feed.notifications;
    expect(n!.workItemId).toBeNull();
    expect(n!.actor?.id).toBe(t.a.userId);
    // Positively the page arm — the mapper's unrecognised-kind fallback is the
    // mention arm with empty strings, which every one of these would catch.
    expect(n!.data).toEqual({
      kind: 'page_mentioned',
      pageId: t.pageId,
      pageTitle: 'Release checklist',
      projectKey: t.projectKey,
      threadRootId: root.id,
      excerpt: expect.stringContaining(`@${t.b.name}`),
    });
  });

  it('the feed is scoped to its recipient and to its workspace', async () => {
    const t = await makeTenant();
    const other = await makeTenant('PGO');
    const { event } = await thread(t, t.a, `cc ${token(t.b)}`);
    await dispatchPage(event);

    expect((await feedOf(t.b)).notifications).toHaveLength(1);
    expect((await feedOf(t.c)).notifications).toEqual([]);
    expect((await feedOf(other.a)).notifications).toEqual([]);
  });

  it('a page-level comment that mentions nobody notifies nobody, and neither handler throws', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, 'Starting a thread on the plan.');
    expect(event.mentionedUserIds).toEqual([]);

    const { inApp, sends: queued } = await dispatchPage(event);

    expect(inApp?.writtenUserIds).toEqual([]);
    expect(queued).toEqual([]);
    expect(await adminDb.notification.count()).toBe(0);
  });
});

// ── replies ────────────────────────────────────────────────────────────────

describe('a reply in a thread', () => {
  it('notifies the starter and earlier repliers once each, as replies, and never the author', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { row, event } = await reply(t, t.c, root.id, 'Agreed with both of you.');

    const { sends: queued } = await dispatchPage(event);

    const rows = await rowsFor({ pageId: t.pageId });
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([t.a.userId, t.b.userId].sort());
    for (const r of rows) {
      expect(r.type).toBe('commented');
      const data = dataOf(r);
      expect(data.kind).toBe('page_replied');
      if (data.kind !== 'page_replied') throw new Error('unreachable');
      expect(data.threadRootId).toBe(root.id);
      expect(data.excerpt).toBe('Agreed with both of you.');
    }
    expect(queued.map((s) => [s.to, variantOf(s)]).sort()).toEqual(
      [
        [t.a.email, 'reply'],
        [t.b.email, 'reply'],
      ].sort(),
    );
    expect(queued.every((s) => s.idempotencyKey.includes(row.id))).toBe(true);
  });

  it('the reply row reads back through the feed as the reply arm, never the fallback', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    const { event } = await reply(t, t.b, root.id, 'Done — merged it.');
    await dispatchPage(event);

    const [n] = (await feedOf(t.a)).notifications;
    expect(n!.data).toEqual({
      kind: 'page_replied',
      pageId: t.pageId,
      pageTitle: 'Release checklist',
      projectKey: t.projectKey,
      threadRootId: root.id,
      excerpt: 'Done — merged it.',
    });
  });

  it('a starter the reply also mentions holds one mention row and one mention send', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { row, event } = await reply(t, t.d, root.id, `Over to you, ${token(t.a)}`);

    const { sends: queued } = await dispatchPage(event);

    const counts = await rowsPerRecipient((await rowsFor({ pageId: t.pageId }))[0]!.dedupeKey);
    expect(Object.fromEntries(counts)).toEqual({ [t.a.userId]: 1, [t.b.userId]: 1 });
    const rows = await rowsFor({ pageId: t.pageId });
    const kinds = Object.fromEntries(rows.map((r) => [r.recipientUserId, dataOf(r).kind]));
    expect(kinds).toEqual({ [t.a.userId]: 'page_mentioned', [t.b.userId]: 'page_replied' });
    const variants = Object.fromEntries(queued.map((s) => [s.to, variantOf(s)]));
    expect(variants).toEqual({ [t.a.email]: 'mention', [t.b.email]: 'reply' });
    expect(queued.filter((s) => s.to === t.d.email)).toEqual([]);
    expect(rows.every((r) => r.dedupeKey.includes(row.id))).toBe(true);
  });
});

// ── the negative cases ─────────────────────────────────────────────────────

describe('who is NOT notified', () => {
  it('a mentioned workspace member outside the project gets nothing; the member beside them does', async () => {
    const t = await makeTenant();
    const body = `${token(t.outsider)} and ${token(t.b)}, please look.`;
    const { root, event } = await thread(t, t.a, body);
    expect(root.bodyMd).toContain(`mention:${t.outsider.userId}`);

    const { sends: queued } = await dispatchPage(event);

    expect(await rowsFor({ recipientUserId: t.outsider.userId })).toEqual([]);
    expect(await rowsFor({ recipientUserId: t.b.userId })).toHaveLength(1);
    expect(queued.map((s) => s.to)).toEqual([t.b.email]);
  });

  it('a recipient who lost project access before dispatch gets neither; the other still gets both', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `${token(t.b)} ${token(t.c)}`);
    // The write-time check passed; the send-time one must decide.
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: t.b.userId, workspaceId: t.workspaceId } },
      data: { accessScope: 'limited' },
    });

    const { sends: queued } = await dispatchPage(event);

    expect(await rowsFor({ recipientUserId: t.b.userId })).toEqual([]);
    expect(await rowsFor({ recipientUserId: t.c.userId })).toHaveLength(1);
    expect(queued.map((s) => s.to)).toEqual([t.c.email]);
  });

  it('a comment deleted before dispatch writes no row and queues nothing, without throwing', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `cc ${token(t.b)}`);
    await pageCommentsService.removePageComment(t.a, { ...on(t), commentId: root.id });

    const { inApp, sends: queued } = await dispatchPage(event);

    expect(inApp?.writtenUserIds).toEqual([]);
    expect(queued).toEqual([]);
    expect(await adminDb.notification.count()).toBe(0);
  });
});

// ── edits and replays ──────────────────────────────────────────────────────

describe('edits and replays', () => {
  it('an edit that adds a second person notifies only them, keyed to the same comment', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Hello ${token(t.b)}`);
    const first = await dispatchPage(event);
    const key = await oneKeyFor(t.pageId);

    await pageCommentsService.editPageCommentBody(t.a, {
      ...on(t),
      commentId: root.id,
      bodyMd: `Hello ${token(t.b)} and ${token(t.c)}`,
    });
    const refire = lastPageEvent();
    expect(refire.commentId).toBe(root.id);
    const second = await dispatchPage(refire);

    expect(Object.fromEntries(await rowsPerRecipient(key))).toEqual({
      [t.b.userId]: 1,
      [t.c.userId]: 1,
    });
    expect(second.inApp?.writtenUserIds).toEqual([t.c.userId]);
    // Every send of the comment, across both runs: one key per recipient.
    const all = [...first.sends, ...second.sends];
    const keysByRecipient = new Map<string, Set<string>>();
    for (const s of all) {
      keysByRecipient.set(s.to, (keysByRecipient.get(s.to) ?? new Set()).add(s.idempotencyKey));
    }
    expect([...keysByRecipient.keys()].sort()).toEqual([t.b.email, t.c.email].sort());
    for (const keys of keysByRecipient.values()) expect(keys.size).toBe(1);
    expect(second.sends.map((s) => s.to)).toEqual([t.c.email]);
  });

  it('an edit that changes only a word publishes nothing and changes no count', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Hello ${token(t.b)}`);
    await dispatchPage(event);
    const rowsBefore = await adminDb.notification.count();
    const eventsBefore = pageEventCount();
    const sendsBefore = sends().length;

    await pageCommentsService.editPageCommentBody(t.a, {
      ...on(t),
      commentId: root.id,
      bodyMd: `Hi ${token(t.b)}`,
    });

    expect(pageEventCount()).toBe(eventsBefore);
    expect(await adminDb.notification.count()).toBe(rowsBefore);
    expect(sends().length).toBe(sendsBefore);
  });

  it('a replay of the same payload adds no row and no second message', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `cc ${token(t.b)} ${token(t.c)}`);
    const first = await dispatchPage(event);
    const rowsBefore = await adminDb.notification.count();

    const second = await dispatchPage(event);

    expect(await adminDb.notification.count()).toBe(rowsBefore);
    expect(second.inApp?.writtenUserIds).toEqual([]);
    // The replay re-enqueues the IDENTICAL keys, which `email.send`'s idempotency
    // (`event.data.idempotencyKey`) collapses to the one delivery already queued.
    expect(second.sends.map((s) => s.idempotencyKey).sort()).toEqual(
      first.sends.map((s) => s.idempotencyKey).sort(),
    );
    expect(new Set([...first.sends, ...second.sends].map((s) => s.idempotencyKey)).size).toBe(2);
  });
});

// ── the page's lifecycle ───────────────────────────────────────────────────

describe('the page’s lifecycle', () => {
  it('a permanent delete takes that page’s consumer-written rows and leaves the other page’s', async () => {
    const t = await makeTenant();
    const otherPageId = await addPage(t, 'Launch notes');
    const { event: onFirst } = await thread(t, t.a, `cc ${token(t.b)}`);
    await dispatchPage(onFirst);
    const { root: otherRoot, event: onOther } = await thread(
      t,
      t.a,
      `and ${token(t.b)}`,
      otherPageId,
    );
    await dispatchPage(onOther);
    expect(await rowsFor({ recipientUserId: t.b.userId })).toHaveLength(2);

    await withWorkspaceContext(t.a, (tx) => pageRepository.deletePages([t.pageId], tx));

    const [survivor, ...rest] = await rowsFor({ recipientUserId: t.b.userId });
    expect(rest).toEqual([]);
    expect(survivor!.pageId).toBe(otherPageId);
    expect(dataOf(survivor!)).toMatchObject({
      kind: 'page_mentioned',
      pageId: otherPageId,
      pageTitle: 'Launch notes',
      threadRootId: otherRoot.id,
    });
  });

  it('an archived page still delivers the mention and the reply raised on it', async () => {
    const t = await makeTenant();
    const { root, event: mention } = await thread(t, t.a, `cc ${token(t.b)}`);
    const { event: replied } = await reply(t, t.c, root.id, 'Noted.');
    await pagesService.archivePage(t.a, on(t));

    await dispatchPage(mention);
    await dispatchPage(replied);

    expect(dataOf((await rowsFor({ recipientUserId: t.b.userId }))[0]!).kind).toBe(
      'page_mentioned',
    );
    expect(dataOf((await rowsFor({ recipientUserId: t.a.userId }))[0]!).kind).toBe('page_replied');
  });
});

// ── callers ────────────────────────────────────────────────────────────────

describe('the callers', () => {
  it('a comment through the real POST route and one through the service notify identically', async () => {
    const t = await makeTenant();
    const body = `Please review, ${token(t.b)}`;

    session.current = { userId: t.a.userId, workspaceId: t.workspaceId, projectId: t.projectId };
    const res = await postPageCommentRoute(
      new Request(`http://localhost/api/pages/${t.pageId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bodyMd: body }),
      }),
      { params: Promise.resolve({ pageId: t.pageId }) },
    );
    expect(res.status).toBe(201);
    const viaRoute = await dispatchPage(lastPageEvent());

    // No route in the path: what any non-route caller (an agent) inherits.
    const { event } = await thread(t, t.a, body);
    const viaService = await dispatchPage(event);

    const shape = (r: Notification) => ({
      recipient: r.recipientUserId,
      type: r.type,
      category: r.category,
      actor: r.actorId,
      kind: dataOf(r).kind,
      excerpt: (dataOf(r) as { excerpt: string | null }).excerpt,
    });
    const rows = await rowsFor({ recipientUserId: t.b.userId });
    expect(rows).toHaveLength(2);
    expect(shape(rows[0]!)).toEqual(shape(rows[1]!));
    const sendShape = (s: EmailSendData) => ({
      to: s.to,
      template: s.template,
      variant: variantOf(s),
      path: new URL(threadUrlOf(s)).pathname,
    });
    expect(viaRoute.sends.map(sendShape)).toEqual(viaService.sends.map(sendShape));
    expect(viaRoute.sends).toHaveLength(1);
  });

  it('the work-item comment path still writes its shipped mention row and send', async () => {
    const t = await makeTenant();
    const issue = await createTestWorkItem(
      {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        ownerId: t.a.userId,
        ctx: { userId: t.a.userId, workspaceId: t.workspaceId },
      } as never,
      { kind: 'task', title: 'A task' },
    );
    const comment = await commentsService.addComment(
      issue.id,
      { bodyMd: `Heads up ${token(t.b)}` },
      { userId: t.a.userId, workspaceId: t.workspaceId },
    );
    const event = captured.events.filter((e) => e.name === WORK_ITEM_EVENT).at(-1)!;
    const from = captured.events.length;

    await dispatch(WORK_ITEM_EVENT, event.data);

    const [row, ...rest] = await rowsFor({ recipientUserId: t.b.userId });
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ type: 'mentioned', workItemId: issue.id, pageId: null });
    expect(row!.dedupeKey).toContain(comment.id);
    expect(dataOf(row!).kind).toBe('mentioned');
    // The work-item consumers may hop through `work-item/mentioned`; drive it too.
    const hop = captured.events.slice(from).find((e) => e.name === 'work-item/mentioned');
    const hopFrom = captured.events.length;
    if (hop) await dispatch('work-item/mentioned', hop.data);
    const queued = [...sends(from), ...sends(hopFrom)].filter(
      (s, i, all) => all.findIndex((x) => x.idempotencyKey === s.idempotencyKey) === i,
    );
    expect(queued.map((s) => [s.to, s.template])).toEqual([[t.b.email, 'mention-notification']]);
  });
});
