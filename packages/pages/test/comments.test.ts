import { beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_COMMENT_THREADS_MAX_LIMIT,
  PageArchivedError,
  PageCommentAnchorInvalidError,
  PageCommentBodyEmptyError,
  PageCommentCursorInvalidError,
  PageCommentForbiddenError,
  PageCommentNotFoundError,
  PageCommentNotRootError,
  PageCommentReplyDepthError,
  PageError,
  PageNotFoundError,
  archivePage,
  createPage,
  createPageComment,
  decodePageCommentCursor,
  deletePageComment,
  editPageComment,
  encodePageCommentCursor,
  listPageCommentThreads,
  pageCommentThreadsLimit,
  reopenPageCommentThread,
  replyToPageComment,
  resolvePageCommentThread,
  type PageCommentActor,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

// PAGE COMMENTS (Story MOTIR-10866 · MOTIR-10872), against the in-memory store:
// what each procedure writes, what it refuses and that it wrote nothing then,
// the lock it takes first, and how the thread lists page.

const author: PageCommentActor = { userId: 'u1', canModerate: false };
const other: PageCommentActor = { userId: 'u2', canModerate: false };
const moderator: PageCommentActor = { userId: 'u3', canModerate: true };

let store: MemoryPageStore;
let clock: FixedClock;
let pageId: string;

beforeEach(async () => {
  store = new MemoryPageStore();
  clock = new FixedClock(new Date('2026-11-10T09:00:00.000Z'));
  store.addPerson('u1', 'Ada', 'https://img/ada.png');
  store.addPerson('u2', 'Bo');
  store.addPerson('u3', 'Cy');
  pageId = (
    await createPage(store, clock, {
      workspaceId: 'w1',
      projectId: 'p1',
      actorId: 'u1',
      title: 'Plan',
      parent: { kind: 'root' },
    })
  ).id;
});

const scope = (actor: PageCommentActor = author, id = pageId) => ({
  pageId: id,
  projectId: 'p1',
  actor,
});
const refused = (p: Promise<unknown>) => p.then(() => undefined).catch((err: unknown) => err);
const tick = (ms = 1000) => {
  clock.current = new Date(clock.current.getTime() + ms);
};
const root = async (bodyMd = 'A root', actor = author) => {
  tick();
  return createPageComment(store, clock, { ...scope(actor), bodyMd });
};
const reply = async (parentCommentId: string, bodyMd = 'A reply', actor = author) => {
  tick();
  return replyToPageComment(store, clock, { ...scope(actor), parentCommentId, bodyMd });
};
/** How many comment writes the store saw. */
const writes = () =>
  store.called('insertPageComment') +
  store.called('updatePageCommentBody') +
  store.called('deletePageCommentRow') +
  store.called('setPageCommentResolved');

describe('createPageComment', () => {
  it('starts a thread with no anchor, author joined', async () => {
    const thread = await root('Hello');
    expect(thread).toMatchObject({
      pageId,
      parentCommentId: null,
      author: { id: 'u1', name: 'Ada', image: 'https://img/ada.png' },
      bodyMd: 'Hello',
      editedAt: null,
      createdAt: clock.current.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      anchor: null,
      replies: [],
    });
    const stored = store.comments.get(thread.id)!;
    expect(stored).toMatchObject({
      workspaceId: 'w1',
      projectId: 'p1',
      anchor: null,
      anchorQuote: null,
    });
  });

  it('stores an anchor’s bytes unchanged and returns only its quote', async () => {
    const thread = await createPageComment(store, clock, {
      ...scope(),
      bodyMd: 'Inline',
      anchor: { bytes: Uint8Array.from([7, 8, 9]), quote: 'the quoted text' },
    });
    expect(thread.anchor).toEqual({ quote: 'the quoted text' });
    const stored = store.comments.get(thread.id)!;
    expect([...stored.anchor!]).toEqual([7, 8, 9]);
    expect(stored.anchorQuote).toBe('the quoted text');
  });

  it('refuses empty anchor bytes and a blank quote, writing nothing', async () => {
    const empty = await refused(
      createPageComment(store, clock, {
        ...scope(),
        bodyMd: 'x',
        anchor: { bytes: new Uint8Array(), quote: 'q' },
      }),
    );
    expect(empty).toBeInstanceOf(PageCommentAnchorInvalidError);
    expect(empty).toMatchObject({
      code: 'PAGE_COMMENT_ANCHOR_INVALID',
      status: 400,
      reason: 'empty_bytes',
    });
    const blank = await refused(
      createPageComment(store, clock, {
        ...scope(),
        bodyMd: 'x',
        anchor: { bytes: Uint8Array.from([1]), quote: '  ' },
      }),
    );
    expect(blank).toMatchObject({ reason: 'blank_quote' });
    expect(writes()).toBe(0);
  });
});

describe('blank bodies', () => {
  it('are refused on create, reply and edit', async () => {
    const thread = await root();
    const before = writes();
    for (const attempt of [
      createPageComment(store, clock, { ...scope(), bodyMd: ' \n\t' }),
      replyToPageComment(store, clock, { ...scope(), parentCommentId: thread.id, bodyMd: '' }),
      editPageComment(store, clock, { ...scope(), commentId: thread.id, bodyMd: '   ' }),
    ]) {
      const err = await refused(attempt);
      expect(err).toBeInstanceOf(PageCommentBodyEmptyError);
      expect(err).toMatchObject({ code: 'PAGE_COMMENT_BODY_EMPTY', status: 422 });
    }
    expect(writes()).toBe(before);
  });
});

describe('replyToPageComment', () => {
  it('stores a reply under its root', async () => {
    const thread = await root();
    const r = await reply(thread.id, 'Agreed', other);
    expect(r).toMatchObject({
      parentCommentId: thread.id,
      author: { id: 'u2', name: 'Bo', image: null },
      bodyMd: 'Agreed',
      anchor: null,
    });
    expect(store.comments.get(r.id)!.anchor).toBeNull();
  });

  it('refuses a reply to a reply, writing nothing', async () => {
    const thread = await root();
    const r = await reply(thread.id);
    const before = writes();
    const err = await refused(reply(r.id));
    expect(err).toBeInstanceOf(PageCommentReplyDepthError);
    expect(err).toMatchObject({ code: 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED', status: 422 });
    expect(writes()).toBe(before);
  });

  it('refuses a reply to another page’s comment, and to a missing one, as not found', async () => {
    const otherPage = (
      await createPage(store, clock, {
        workspaceId: 'w1',
        projectId: 'p1',
        actorId: 'u1',
        title: 'Other',
        parent: { kind: 'root' },
      })
    ).id;
    const foreign = await createPageComment(store, clock, {
      ...scope(author, otherPage),
      bodyMd: 'x',
    });
    const err = await refused(reply(foreign.id));
    expect(err).toBeInstanceOf(PageCommentNotFoundError);
    expect(err).toMatchObject({ code: 'PAGE_COMMENT_NOT_FOUND', status: 404 });
    expect(await refused(reply('nope'))).toBeInstanceOf(PageCommentNotFoundError);
  });
});

describe('editPageComment', () => {
  it('changes the body and stamps editedAt for the author', async () => {
    const thread = await root('Draft');
    tick(5000);
    const edited = await editPageComment(store, clock, {
      ...scope(),
      commentId: thread.id,
      bodyMd: 'Final',
    });
    expect(edited).toMatchObject({ bodyMd: 'Final', editedAt: clock.current.toISOString() });
  });

  it('refuses a non-author without moderation, and lets a moderator edit', async () => {
    const thread = await root('Draft');
    const before = writes();
    const err = await refused(
      editPageComment(store, clock, { ...scope(other), commentId: thread.id, bodyMd: 'Hijack' }),
    );
    expect(err).toBeInstanceOf(PageCommentForbiddenError);
    expect(err).toMatchObject({ code: 'PAGE_COMMENT_FORBIDDEN', status: 403, action: 'edit' });
    expect(writes()).toBe(before);

    const edited = await editPageComment(store, clock, {
      ...scope(moderator),
      commentId: thread.id,
      bodyMd: 'Tidied',
    });
    expect(edited.bodyMd).toBe('Tidied');
  });

  it('writes nothing for the identical body and leaves editedAt alone', async () => {
    const thread = await root('Same');
    const before = writes();
    tick();
    const result = await editPageComment(store, clock, {
      ...scope(),
      commentId: thread.id,
      bodyMd: 'Same',
    });
    expect(result.editedAt).toBeNull();
    expect(writes()).toBe(before);
  });
});

describe('deletePageComment', () => {
  it('deletes a reply and leaves its root', async () => {
    const thread = await root();
    const r = await reply(thread.id);
    expect(await deletePageComment(store, { ...scope(), commentId: r.id })).toEqual({
      commentId: r.id,
      parentCommentId: thread.id,
      replyCount: 0,
    });
    expect(store.comments.has(thread.id)).toBe(true);
    expect(store.comments.has(r.id)).toBe(false);
  });

  it('deletes a root with every reply and counts them', async () => {
    const thread = await root();
    await reply(thread.id);
    await reply(thread.id);
    expect(await deletePageComment(store, { ...scope(), commentId: thread.id })).toEqual({
      commentId: thread.id,
      parentCommentId: null,
      replyCount: 2,
    });
    expect(store.comments.size).toBe(0);
  });

  it('refuses a non-author without moderation, and lets a moderator delete', async () => {
    const thread = await root();
    const err = await refused(deletePageComment(store, { ...scope(other), commentId: thread.id }));
    expect(err).toMatchObject({ code: 'PAGE_COMMENT_FORBIDDEN', action: 'delete' });
    expect(store.called('deletePageCommentRow')).toBe(0);
    await deletePageComment(store, { ...scope(moderator), commentId: thread.id });
    expect(store.comments.size).toBe(0);
  });
});

describe('resolve and reopen', () => {
  it('resolve records who and when; the thread moves to the resolved list and back', async () => {
    const thread = await root();
    await reply(thread.id);
    tick(60_000);
    const resolved = await resolvePageCommentThread(store, clock, {
      ...scope(other),
      commentId: thread.id,
    });
    expect(resolved).toMatchObject({
      resolvedAt: clock.current.toISOString(),
      resolvedBy: { id: 'u2', name: 'Bo', image: null },
    });
    expect(resolved.replies).toHaveLength(1);

    const open = await listPageCommentThreads(store, { ...scope(), status: 'open' });
    const done = await listPageCommentThreads(store, { ...scope(), status: 'resolved' });
    expect(open.threads).toEqual([]);
    expect(done.threads.map((t) => t.id)).toEqual([thread.id]);
    expect(done.threads[0]!.resolvedBy).toEqual({ id: 'u2', name: 'Bo', image: null });
    expect(done.counts).toEqual({ open: 0, resolved: 1 });

    const reopened = await reopenPageCommentThread(store, { ...scope(), commentId: thread.id });
    expect(reopened).toMatchObject({ resolvedAt: null, resolvedBy: null });
    const again = await listPageCommentThreads(store, { ...scope(), status: 'open' });
    expect(again.threads.map((t) => t.id)).toEqual([thread.id]);
  });

  it('refuses a reply on both', async () => {
    const thread = await root();
    const r = await reply(thread.id);
    for (const attempt of [
      resolvePageCommentThread(store, clock, { ...scope(), commentId: r.id }),
      reopenPageCommentThread(store, { ...scope(), commentId: r.id }),
    ]) {
      const err = await refused(attempt);
      expect(err).toBeInstanceOf(PageCommentNotRootError);
      expect(err).toMatchObject({ code: 'PAGE_COMMENT_NOT_ROOT', status: 422 });
    }
    expect(store.called('setPageCommentResolved')).toBe(0);
  });

  it('writes nothing to resolve a resolved thread or reopen an open one', async () => {
    const thread = await root();
    const unchanged = await reopenPageCommentThread(store, { ...scope(), commentId: thread.id });
    expect(unchanged.resolvedAt).toBeNull();
    expect(store.called('setPageCommentResolved')).toBe(0);

    const first = await resolvePageCommentThread(store, clock, {
      ...scope(),
      commentId: thread.id,
    });
    tick();
    const second = await resolvePageCommentThread(store, clock, {
      ...scope(moderator),
      commentId: thread.id,
    });
    expect(second).toEqual(first);
    expect(store.called('setPageCommentResolved')).toBe(1);
  });
});

describe('the page a write lands on', () => {
  const everyWrite = (commentId: string) => [
    () => createPageComment(store, clock, { ...scope(), bodyMd: 'x' }),
    () => replyToPageComment(store, clock, { ...scope(), parentCommentId: commentId, bodyMd: 'x' }),
    () => editPageComment(store, clock, { ...scope(), commentId, bodyMd: 'changed' }),
    () => resolvePageCommentThread(store, clock, { ...scope(), commentId }),
    () => reopenPageCommentThread(store, { ...scope(), commentId }),
    // Last: it removes the comment the others act on.
    () => deletePageComment(store, { ...scope(), commentId }),
  ];

  it('takes the page lock before any comment read or write', async () => {
    const thread = await root();
    for (const write of everyWrite(thread.id)) {
      store.calls.length = 0;
      await write();
      const methods = store.calls.map((c) => c.method);
      expect(methods[0]).toBe('lockPage');
      expect(methods).not.toContain('lockSiblings');
    }
  });

  it('refuses every write on an archived page, writing nothing', async () => {
    const thread = await root();
    await archivePage(store, clock, { pageId, projectId: 'p1', actorId: 'u1' });
    const before = writes();
    for (const write of everyWrite(thread.id)) {
      const err = await refused(write());
      expect(err).toBeInstanceOf(PageArchivedError);
      expect(err).toMatchObject({ code: 'PAGE_ARCHIVED', status: 409 });
    }
    expect(writes()).toBe(before);
    // Reading an archived page's discussion is still allowed.
    const listed = await listPageCommentThreads(store, { ...scope(), status: 'open' });
    expect(listed.threads.map((t) => t.id)).toEqual([thread.id]);
  });

  it('refuses every write and the list on a page outside the caller’s project', async () => {
    const thread = await root();
    const elsewhere = { pageId, projectId: 'p2', actor: author };
    for (const attempt of [
      createPageComment(store, clock, { ...elsewhere, bodyMd: 'x' }),
      replyToPageComment(store, clock, { ...elsewhere, parentCommentId: thread.id, bodyMd: 'x' }),
      editPageComment(store, clock, { ...elsewhere, commentId: thread.id, bodyMd: 'y' }),
      deletePageComment(store, { ...elsewhere, commentId: thread.id }),
      resolvePageCommentThread(store, clock, { ...elsewhere, commentId: thread.id }),
      reopenPageCommentThread(store, { ...elsewhere, commentId: thread.id }),
      listPageCommentThreads(store, { ...elsewhere, status: 'open' }),
      listPageCommentThreads(store, { ...scope(author, 'missing'), status: 'open' }),
    ]) {
      const err = await refused(attempt);
      expect(err).toBeInstanceOf(PageNotFoundError);
      expect(err).toBeInstanceOf(PageError);
    }
  });
});

describe('listPageCommentThreads', () => {
  it('lists open roots oldest first, each with its replies oldest first, and both counts', async () => {
    const a = await root('A');
    const b = await root('B');
    const c = await root('C');
    const b1 = await reply(b.id, 'b1');
    const b2 = await reply(b.id, 'b2');
    await resolvePageCommentThread(store, clock, { ...scope(), commentId: c.id });

    const page = await listPageCommentThreads(store, { ...scope(), status: 'open' });
    expect(page.threads.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(page.threads[1]!.replies.map((r) => r.id)).toEqual([b1.id, b2.id]);
    expect(page.threads[0]!.replies).toEqual([]);
    expect(page.counts).toEqual({ open: 2, resolved: 1 });
    expect(page.nextCursor).toBeNull();
  });

  it('lists resolved roots most recently resolved first', async () => {
    const a = await root('A');
    const b = await root('B');
    tick();
    await resolvePageCommentThread(store, clock, { ...scope(), commentId: b.id });
    tick();
    await resolvePageCommentThread(store, clock, { ...scope(), commentId: a.id });
    const page = await listPageCommentThreads(store, { ...scope(), status: 'resolved' });
    expect(page.threads.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it('pages 25 open roots as 20 then 5, none repeated or skipped', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) ids.push((await root(`r${i}`)).id);
    const first = await listPageCommentThreads(store, { ...scope(), status: 'open', limit: 20 });
    expect(first.threads).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPageCommentThreads(store, {
      ...scope(),
      status: 'open',
      limit: 20,
      cursor: first.nextCursor,
    });
    expect(second.threads).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.threads, ...second.threads].map((t) => t.id)).toEqual(ids);
  });

  it('pages newest first when asked, along the same key', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await root(`r${i}`)).id);
    const first = await listPageCommentThreads(store, {
      ...scope(),
      status: 'open',
      order: 'desc',
      limit: 3,
    });
    const second = await listPageCommentThreads(store, {
      ...scope(),
      status: 'open',
      order: 'desc',
      limit: 3,
      cursor: first.nextCursor,
    });
    expect([...first.threads, ...second.threads].map((t) => t.id)).toEqual([...ids].reverse());
    expect(second.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not issue, or one issued for another list', async () => {
    for (let i = 0; i < 3; i += 1) await root();
    const first = await listPageCommentThreads(store, { ...scope(), status: 'open', limit: 1 });
    const bad = [
      'not-a-cursor',
      btoa('null'),
      btoa(JSON.stringify({ s: 'other', o: 'asc', t: '2026-11-10T09:00:00.000Z', i: 'x' })),
      btoa(JSON.stringify({ s: 'open', o: 'up', t: '2026-11-10T09:00:00.000Z', i: 'x' })),
      btoa(JSON.stringify({ s: 'open', o: 'asc', t: 7, i: 'x' })),
      btoa(JSON.stringify({ s: 'open', o: 'asc', t: '2026-11-10T09:00:00.000Z', i: '' })),
      btoa(JSON.stringify({ s: 'open', o: 'asc', t: 'yesterday', i: 'x' })),
      btoa(JSON.stringify({ s: 'open', o: 'asc', t: '2026-11-10', i: 'x' })),
    ];
    for (const cursor of bad) {
      const err = await refused(
        listPageCommentThreads(store, { ...scope(), status: 'open', cursor }),
      );
      expect(err).toBeInstanceOf(PageCommentCursorInvalidError);
      expect(err).toMatchObject({ code: 'PAGE_COMMENT_CURSOR_INVALID', status: 400 });
    }
    for (const mismatch of [
      { status: 'resolved' as const },
      { status: 'open' as const, order: 'desc' as const },
    ]) {
      const err = await refused(
        listPageCommentThreads(store, { ...scope(), ...mismatch, cursor: first.nextCursor }),
      );
      expect(err).toBeInstanceOf(PageCommentCursorInvalidError);
    }
  });

  it('clamps the limit to 1–50 and defaults it to 20', async () => {
    expect(pageCommentThreadsLimit(undefined)).toBe(20);
    expect(pageCommentThreadsLimit(Number.NaN)).toBe(20);
    expect(pageCommentThreadsLimit(500)).toBe(PAGE_COMMENT_THREADS_MAX_LIMIT);
    expect(pageCommentThreadsLimit(0)).toBe(1);
    expect(pageCommentThreadsLimit(7.9)).toBe(7);
    await listPageCommentThreads(store, { ...scope(), status: 'open', limit: 500 });
    const query = store.calls.find((c) => c.method === 'findPageCommentRoots')!.args[0];
    expect(query).toMatchObject({ limit: 51 });
  });

  it('reads no replies for an empty list', async () => {
    const page = await listPageCommentThreads(store, { ...scope(), status: 'open' });
    expect(page).toEqual({ threads: [], nextCursor: null, counts: { open: 0, resolved: 0 } });
    expect(store.called('findPageCommentReplies')).toBe(0);
  });
});

describe('the cursor codec', () => {
  it('round-trips and is URL-safe', () => {
    const cursor = {
      status: 'resolved' as const,
      order: 'desc' as const,
      key: { at: new Date('2026-11-10T09:00:00.123Z'), id: 'cmabc???>>>' },
    };
    const raw = encodePageCommentCursor(cursor);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePageCommentCursor(raw)).toEqual(cursor);
  });
});
