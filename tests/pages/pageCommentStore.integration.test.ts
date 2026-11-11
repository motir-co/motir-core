import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  PageArchivedError,
  PageCommentForbiddenError,
  PageCommentNotFoundError,
  PageCommentNotRootError,
  PageCommentReplyDepthError,
  PageNotFoundError,
  archivePage,
  createPage,
  createPageComment,
  deletePageComment,
  editPageComment,
  listPageCommentThreads,
  pageStoreFor,
  reopenPageCommentThread,
  replyToPageComment,
  resolvePageCommentThread,
  systemClock,
  type Clock,
  type PageCommentActor,
  type PageCommentDto,
} from '@/lib/pages';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// PAGE COMMENTS through the `PageStore` adapter, on real Postgres (Story
// MOTIR-10866 · MOTIR-10872). The package's procedures run inside
// `withWorkspaceContext` over `pageStoreFor(tx)`, exactly as the service will run
// them, and every assertion that matters reads the row back through `adminDb`:
// replies, edit, delete with its cascade, resolve and reopen, the anchor bytes,
// the archived-page refusal, keyset paging, and tenancy under RLS.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  ownerId: string;
  memberId: string;
  workspaceId: string;
  projectId: string;
  pageId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: `page-comment-${tag}-owner@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${tag}`,
  });
  const member = await usersService.createUser({
    email: `page-comment-${tag}-member@example.com`,
    password: 'hunter2hunter2',
    name: `Member ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Comment ${tag}`,
    ownerUserId: owner.id,
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: ws.workspace.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: `Page Comment ${tag}`,
    identifier: `PCS${tag.toUpperCase()}`,
  });
  const t = {
    ownerId: owner.id,
    memberId: member.id,
    workspaceId: ws.workspace.id,
    projectId: project.id,
  };
  const page = await withWorkspaceContext(
    { userId: owner.id, workspaceId: t.workspaceId, projectId: t.projectId },
    (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        actorId: owner.id,
        title: `Plan ${tag}`,
        parent: { kind: 'root' },
      }),
  );
  return { ...t, pageId: page.id };
}

const inTenant = <T>(
  t: Tenant,
  userId: string,
  fn: (store: ReturnType<typeof pageStoreFor>) => Promise<T>,
) =>
  withWorkspaceContext({ userId, workspaceId: t.workspaceId, projectId: t.projectId }, (tx) =>
    fn(pageStoreFor(tx)),
  );

const scope = (t: Tenant, actor: PageCommentActor) => ({
  pageId: t.pageId,
  projectId: t.projectId,
  actor,
});
const owner = (t: Tenant): PageCommentActor => ({ userId: t.ownerId, canModerate: false });
const member = (t: Tenant): PageCommentActor => ({ userId: t.memberId, canModerate: false });

/** A clock that moves one second per read, so rows never share a timestamp. */
function steppingClock(start = new Date('2026-11-10T09:00:00.000Z')): Clock {
  let at = start.getTime();
  return {
    now() {
      at += 1000;
      return new Date(at);
    },
  };
}

const refused = (p: Promise<unknown>) => p.then(() => undefined).catch((err: unknown) => err);

describe('page comments through the adapter', () => {
  it('stores a reply under its root and refuses a reply to a reply', async () => {
    const t = await makeTenant('a');
    const clock = steppingClock();
    const root = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'Root' }),
    );
    const reply = await inTenant(t, t.memberId, (s) =>
      replyToPageComment(s, clock, {
        ...scope(t, member(t)),
        parentCommentId: root.id,
        bodyMd: 'Reply',
      }),
    );
    expect(reply).toMatchObject({
      parentCommentId: root.id,
      author: { id: t.memberId, name: 'Member a', image: null },
    });
    expect(await adminDb.pageComment.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({
      parentCommentId: root.id,
      workspaceId: t.workspaceId,
      projectId: t.projectId,
    });

    const err = await refused(
      inTenant(t, t.ownerId, (s) =>
        replyToPageComment(s, clock, {
          ...scope(t, owner(t)),
          parentCommentId: reply.id,
          bodyMd: 'Too deep',
        }),
      ),
    );
    expect(err).toBeInstanceOf(PageCommentReplyDepthError);
    expect(await adminDb.pageComment.count()).toBe(2);
  });

  it('refuses a reply to another page’s comment as not found', async () => {
    const t = await makeTenant('b');
    const clock = steppingClock();
    const other = await inTenant(t, t.ownerId, (s) =>
      createPage(s, clock, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        actorId: t.ownerId,
        title: 'Other',
        parent: { kind: 'root' },
      }),
    );
    const foreign = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), pageId: other.id, bodyMd: 'There' }),
    );
    const err = await refused(
      inTenant(t, t.ownerId, (s) =>
        replyToPageComment(s, clock, {
          ...scope(t, owner(t)),
          parentCommentId: foreign.id,
          bodyMd: 'Here',
        }),
      ),
    );
    expect(err).toBeInstanceOf(PageCommentNotFoundError);
  });

  it('edits for the author and a moderator only, stamping editedAt', async () => {
    const t = await makeTenant('c');
    const clock = steppingClock();
    const root = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'Draft' }),
    );
    const forbidden = await refused(
      inTenant(t, t.memberId, (s) =>
        editPageComment(s, clock, { ...scope(t, member(t)), commentId: root.id, bodyMd: 'No' }),
      ),
    );
    expect(forbidden).toBeInstanceOf(PageCommentForbiddenError);

    const same = await inTenant(t, t.ownerId, (s) =>
      editPageComment(s, clock, { ...scope(t, owner(t)), commentId: root.id, bodyMd: 'Draft' }),
    );
    expect(same.editedAt).toBeNull();

    const edited = await inTenant(t, t.memberId, (s) =>
      editPageComment(s, clock, {
        ...scope(t, { userId: t.memberId, canModerate: true }),
        commentId: root.id,
        bodyMd: 'Final',
      }),
    );
    const row = await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } });
    expect(row.bodyMd).toBe('Final');
    expect(row.editedAt?.toISOString()).toBe(edited.editedAt);
  });

  it('deletes a reply alone, and a root with every reply', async () => {
    const t = await makeTenant('d');
    const clock = steppingClock();
    const s = scope(t, owner(t));
    const root = await inTenant(t, t.ownerId, (st) =>
      createPageComment(st, clock, { ...s, bodyMd: 'Root' }),
    );
    const replies: PageCommentDto[] = [];
    for (const body of ['one', 'two', 'three']) {
      replies.push(
        await inTenant(t, t.ownerId, (st) =>
          replyToPageComment(st, clock, { ...s, parentCommentId: root.id, bodyMd: body }),
        ),
      );
    }
    await inTenant(t, t.ownerId, (st) =>
      deletePageComment(st, { ...s, commentId: replies[0]!.id }),
    );
    expect(await adminDb.pageComment.count()).toBe(3);

    const result = await inTenant(t, t.ownerId, (st) =>
      deletePageComment(st, { ...s, commentId: root.id }),
    );
    expect(result).toEqual({ commentId: root.id, parentCommentId: null, replyCount: 2 });
    expect(await adminDb.pageComment.count()).toBe(0);
  });

  it('resolves and reopens a thread, read back from Postgres', async () => {
    const t = await makeTenant('e');
    const clock = steppingClock();
    const root = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'Decide' }),
    );
    const reply = await inTenant(t, t.ownerId, (s) =>
      replyToPageComment(s, clock, {
        ...scope(t, owner(t)),
        parentCommentId: root.id,
        bodyMd: 'Reply',
      }),
    );
    const notRoot = await refused(
      inTenant(t, t.memberId, (s) =>
        resolvePageCommentThread(s, clock, { ...scope(t, member(t)), commentId: reply.id }),
      ),
    );
    expect(notRoot).toBeInstanceOf(PageCommentNotRootError);

    const resolved = await inTenant(t, t.memberId, (s) =>
      resolvePageCommentThread(s, clock, { ...scope(t, member(t)), commentId: root.id }),
    );
    const row = await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } });
    expect(row.resolvedById).toBe(t.memberId);
    expect(row.resolvedAt?.toISOString()).toBe(resolved.resolvedAt);

    const lists = await inTenant(t, t.ownerId, async (s) => ({
      open: await listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'open' }),
      resolved: await listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'resolved' }),
    }));
    expect(lists.open.threads).toEqual([]);
    expect(lists.resolved.threads.map((th) => th.id)).toEqual([root.id]);
    expect(lists.resolved.threads[0]!.resolvedBy).toEqual({
      id: t.memberId,
      name: 'Member e',
      image: null,
    });
    expect(lists.resolved.threads[0]!.replies.map((r) => r.id)).toEqual([reply.id]);
    expect(lists.resolved.counts).toEqual({ open: 0, resolved: 1 });

    await inTenant(t, t.ownerId, (s) =>
      reopenPageCommentThread(s, { ...scope(t, owner(t)), commentId: root.id }),
    );
    expect(await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({
      resolvedAt: null,
      resolvedById: null,
    });
  });

  it('stores an anchor’s bytes unchanged, and NULLs without one', async () => {
    const t = await makeTenant('f');
    const clock = steppingClock();
    const plain = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'Plain' }),
    );
    const inline = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, {
        ...scope(t, owner(t)),
        bodyMd: 'Inline',
        anchor: { bytes: Uint8Array.from([0, 255, 3, 128]), quote: 'this sentence' },
      }),
    );
    expect(inline.anchor).toEqual({ bytes: 'AP8DgA==', quote: 'this sentence' });
    const rows = await adminDb.pageComment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.id)).toEqual([plain.id, inline.id]);
    expect(rows[0]).toMatchObject({ anchor: null, anchorQuote: null });
    expect([...rows[1]!.anchor!]).toEqual([0, 255, 3, 128]);
    expect(rows[1]!.anchorQuote).toBe('this sentence');
    expect([...Buffer.from(inline.anchor!.bytes, 'base64')]).toEqual([...rows[1]!.anchor!]);
  });

  it('refuses every write on an archived page and still lists its threads', async () => {
    const t = await makeTenant('g');
    const clock = steppingClock();
    const root = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'Before' }),
    );
    await inTenant(t, t.ownerId, (s) =>
      archivePage(s, clock, { pageId: t.pageId, projectId: t.projectId, actorId: t.ownerId }),
    );
    const err = await refused(
      inTenant(t, t.ownerId, (s) =>
        createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: 'After' }),
      ),
    );
    expect(err).toBeInstanceOf(PageArchivedError);
    expect(await adminDb.pageComment.count()).toBe(1);
    const listed = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'open' }),
    );
    expect(listed.threads.map((th) => th.id)).toEqual([root.id]);
  });

  it('pages 25 open roots as 20 then 5, none repeated or skipped', async () => {
    const t = await makeTenant('h');
    const clock = steppingClock();
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(
        (
          await inTenant(t, t.ownerId, (s) =>
            createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: `r${i}` }),
          )
        ).id,
      );
    }
    const first = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'open', limit: 20 }),
    );
    const second = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, {
        ...scope(t, owner(t)),
        status: 'open',
        limit: 20,
        cursor: first.nextCursor,
      }),
    );
    expect(first.threads).toHaveLength(20);
    expect(second.threads).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.threads, ...second.threads].map((th) => th.id)).toEqual(ids);
    expect(first.counts).toEqual({ open: 25, resolved: 0 });

    const newest = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'open', order: 'desc', limit: 3 }),
    );
    expect(newest.threads.map((th) => th.id)).toEqual(ids.slice(-3).reverse());
  });

  it('pages resolved roots most recently resolved first', async () => {
    const t = await makeTenant('i');
    const clock = steppingClock();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        (
          await inTenant(t, t.ownerId, (s) =>
            createPageComment(s, clock, { ...scope(t, owner(t)), bodyMd: `r${i}` }),
          )
        ).id,
      );
    }
    for (const id of [ids[1]!, ids[0]!, ids[2]!]) {
      await inTenant(t, t.ownerId, (s) =>
        resolvePageCommentThread(s, clock, { ...scope(t, owner(t)), commentId: id }),
      );
    }
    const first = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, { ...scope(t, owner(t)), status: 'resolved', limit: 2 }),
    );
    const second = await inTenant(t, t.ownerId, (s) =>
      listPageCommentThreads(s, {
        ...scope(t, owner(t)),
        status: 'resolved',
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect([...first.threads, ...second.threads].map((th) => th.id)).toEqual([
      ids[2]!,
      ids[0]!,
      ids[1]!,
    ]);
  });

  it('hides another workspace’s comments under RLS', async () => {
    const w1 = await makeTenant('j');
    const w2 = await makeTenant('k');
    const clock = steppingClock();
    const root = await inTenant(w1, w1.ownerId, (s) =>
      createPageComment(s, clock, { ...scope(w1, owner(w1)), bodyMd: 'Private' }),
    );

    // The W1 page itself is hidden from a W2 context, so the list reads it as missing.
    const err = await refused(
      inTenant(w2, w2.ownerId, (s) =>
        listPageCommentThreads(s, {
          pageId: w1.pageId,
          projectId: w2.projectId,
          actor: owner(w2),
          status: 'open',
        }),
      ),
    );
    expect(err).toBeInstanceOf(PageNotFoundError);

    // And the store's own comment reads see nothing of W1.
    const seen = await inTenant(w2, w2.ownerId, async (s) => ({
      roots: await s.findPageCommentRoots({
        pageId: w1.pageId,
        status: 'open',
        order: 'asc',
        after: null,
        limit: 10,
      }),
      replies: await s.findPageCommentReplies([root.id]),
      counts: await s.countPageCommentRoots(w1.pageId),
      locked: await s.lockPageComment(root.id),
    }));
    expect(seen).toEqual({
      roots: [],
      replies: [],
      counts: { open: 0, resolved: 0 },
      locked: null,
    });
  });

  it('findPageComment answers the stored row joined and unlocked, null when absent or out of context', async () => {
    const t = await makeTenant('l');
    const other = await makeTenant('m');
    const clock = steppingClock();
    const inline = await inTenant(t, t.ownerId, (s) =>
      createPageComment(s, clock, {
        ...scope(t, owner(t)),
        bodyMd: 'Inline',
        anchor: { bytes: Uint8Array.from([5, 6, 7]), quote: 'the passage' },
      }),
    );
    await inTenant(t, t.memberId, (s) =>
      resolvePageCommentThread(s, clock, { ...scope(t, member(t)), commentId: inline.id }),
    );
    const found = await inTenant(t, t.ownerId, (s) => s.findPageComment(inline.id));
    expect(found).toMatchObject({
      id: inline.id,
      pageId: t.pageId,
      parentCommentId: null,
      author: { id: t.ownerId, name: 'Owner l' },
      resolvedBy: { id: t.memberId, name: 'Member l' },
      anchorQuote: 'the passage',
    });
    expect([...found!.anchor!]).toEqual([5, 6, 7]);
    expect(await inTenant(t, t.ownerId, (s) => s.findPageComment('missing'))).toBeNull();
    // Bound to another workspace, the policy does not admit the row.
    expect(await inTenant(other, other.ownerId, (s) => s.findPageComment(inline.id))).toBeNull();
  });
});
