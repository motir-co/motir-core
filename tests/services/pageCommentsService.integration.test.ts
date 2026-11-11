import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import type { PageCommentCreatedData } from '@/lib/jobs/types';
import {
  PageArchivedError,
  PageCommentBodyEmptyError,
  PageCommentForbiddenError,
  PageCommentNotFoundError,
  PageCommentReplyDepthError,
  PageNotFoundError,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { PermissionDeniedError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents } from '../helpers/jobs';

// The PAGE-COMMENT SERVICE on real Postgres (Story MOTIR-10866 · MOTIR-10873):
// the gate order — browse, then `page:view`, then `comment:add`, then the
// package — at every permission tier, the capabilities the list answers, an
// archived page, and tenancy across workspaces.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Actor {
  userId: string;
  workspaceId: string;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  owner: Actor;
  pageId: string;
}

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-comments-svc-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Svc ${tag}`,
  });
}

async function makeFixture(identifier = 'PCV'): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Svc', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Svc',
    identifier,
  });
  const actor = { userId: owner.id, workspaceId };
  const page = await pagesService.createPage(actor, { projectId: project.id, title: 'Plan' });
  return { workspaceId, projectId: project.id, owner: actor, pageId: page.id };
}

async function actorAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

const on = (f: Fixture) => ({ projectId: f.projectId, pageId: f.pageId });
const refused = (p: Promise<unknown>) => p.then(() => undefined).catch((err: unknown) => err);

/** Every write, against one existing root, as one actor. */
function everyWrite(actor: Actor, f: Fixture, root: PageCommentThreadDto) {
  const target = { ...on(f), commentId: root.id };
  return [
    () => pageCommentsService.postPageComment(actor, { ...on(f), bodyMd: 'new' }),
    () =>
      pageCommentsService.postPageReply(actor, { ...on(f), parentCommentId: root.id, bodyMd: 'r' }),
    () => pageCommentsService.editPageCommentBody(actor, { ...target, bodyMd: 'changed' }),
    () => pageCommentsService.resolvePageThread(actor, target),
    () => pageCommentsService.reopenPageThread(actor, target),
    () => pageCommentsService.removePageComment(actor, target),
  ];
}

/** Every row's mutable columns, to prove a refusal wrote nothing. */
const snapshot = () =>
  adminDb.pageComment.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, bodyMd: true, editedAt: true, resolvedAt: true, parentCommentId: true },
  });

describe('pageCommentsService — reads', () => {
  it('answers the work items the listed bodies link, roots and replies alike', async () => {
    const f = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: f.projectId, kind: 'task', title: 'Rotate the keys' },
      f.owner,
    );
    const other = await workItemsService.createWorkItem(
      { projectId: f.projectId, kind: 'task', title: 'Ship the notes' },
      f.owner,
    );
    const plain = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Hi' });
    expect(
      (await pageCommentsService.listPageThreads(f.owner, { ...on(f), status: 'open' }))
        .workItemRefs,
    ).toEqual({});

    const root = await pageCommentsService.postPageComment(f.owner, {
      ...on(f),
      bodyMd: `Blocked by [${item.identifier}](motir:${item.id}).`,
    });
    await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: `And [${other.identifier}](motir:${other.id}).`,
    });
    const listed = await pageCommentsService.listPageThreads(f.owner, { ...on(f), status: 'open' });
    expect(listed.threads.map((t) => t.id)).toEqual(expect.arrayContaining([root.id, plain.id]));
    expect(listed.workItemRefs[other.id]).toMatchObject({ identifier: other.identifier });
    expect(listed.workItemRefs[item.id]).toMatchObject({
      accessible: true,
      identifier: item.identifier,
      title: 'Rotate the keys',
    });
  });

  it('answers each write with the work items its OWN body links', async () => {
    const f = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: f.projectId, kind: 'task', title: 'Rotate the keys' },
      f.owner,
    );
    const other = await workItemsService.createWorkItem(
      { projectId: f.projectId, kind: 'task', title: 'Ship the notes' },
      f.owner,
    );
    const root = await pageCommentsService.postPageComment(f.owner, {
      ...on(f),
      bodyMd: `Blocked by [${item.identifier}](motir:${item.id}).`,
    });
    expect(root.workItemRefs[item.id]).toMatchObject({ identifier: item.identifier });

    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'No links here.',
    });
    expect(reply.workItemRefs).toEqual({});

    const edited = await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: reply.id,
      bodyMd: `Now [${other.identifier}](motir:${other.id}).`,
    });
    expect(edited.workItemRefs[other.id]).toMatchObject({ identifier: other.identifier });
    // Only its own body: the root's link is not in the edit's answer.
    expect(edited.workItemRefs[item.id]).toBeUndefined();
  });

  it('a viewer reads with no write capabilities; a member may comment; the owner moderates', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const member = await actorAs(f, 'member', 'member');
    await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Hello' });

    const asViewer = await pageCommentsService.listPageThreads(viewer, {
      ...on(f),
      status: 'open',
    });
    expect(asViewer.threads).toHaveLength(1);
    expect(asViewer.counts).toEqual({ open: 1, resolved: 0 });
    expect(asViewer.capabilities).toEqual({ canComment: false, canModerate: false });

    const asMember = await pageCommentsService.listPageThreads(member, {
      ...on(f),
      status: 'open',
    });
    expect(asMember.capabilities).toEqual({ canComment: true, canModerate: false });

    const asOwner = await pageCommentsService.listPageThreads(f.owner, {
      ...on(f),
      status: 'open',
    });
    expect(asOwner.capabilities).toEqual({ canComment: true, canModerate: true });
  });

  it('refuses a stranger as browse, and a page of another project as not found', async () => {
    const f = await makeFixture();
    const stranger = await makeUser('stranger');
    const err = await refused(
      pageCommentsService.listPageThreads(
        { userId: stranger.id, workspaceId: f.workspaceId },
        { ...on(f), status: 'open' },
      ),
    );
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect(err).toMatchObject({ kind: 'browse' });

    const other = await projectsService.createProject({
      workspaceId: f.workspaceId,
      actorUserId: f.owner.userId,
      name: 'Other',
      identifier: 'PCO',
    });
    const foreign = await pagesService.createPage(f.owner, { projectId: other.id, title: 'X' });
    const missing = await refused(
      pageCommentsService.listPageThreads(f.owner, {
        projectId: f.projectId,
        pageId: foreign.id,
        status: 'open',
      }),
    );
    expect(missing).toBeInstanceOf(PageNotFoundError);
  });
});

describe('pageCommentsService.readPageThread', () => {
  it('a viewer reads a thread at 200 with its replies, and it equals the listed thread', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'A reply',
    });
    const read = await pageCommentsService.readPageThread(viewer, {
      ...on(f),
      commentId: reply.id,
    });
    expect(read.id).toBe(root.id);
    expect(read.replies.map((r) => r.id)).toEqual([reply.id]);
    expect(read.workItemRefs).toEqual({});
    const listed = await pageCommentsService.listPageThreads(viewer, { ...on(f), status: 'open' });
    const { workItemRefs: _refs, ...thread } = read;
    expect(thread).toEqual(listed.threads[0]);
  });

  it('refuses a stranger as browse and a reader without page:view as the page gate', async () => {
    const f = await makeFixture();
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const stranger = await makeUser('stranger');
    const asStranger = await refused(
      pageCommentsService.readPageThread(
        { userId: stranger.id, workspaceId: f.workspaceId },
        { ...on(f), commentId: root.id },
      ),
    );
    expect(asStranger).toBeInstanceOf(ProjectAccessDeniedError);
    expect(asStranger).toMatchObject({ kind: 'browse' });

    const noPages = await actorAs(f, 'nopages', 'member');
    // A custom role that browses the project but holds no `page:view`.
    const role = await adminDb.workspaceRoleDefinition.create({
      data: {
        workspaceId: f.workspaceId,
        name: 'No pages',
        permissions: ['project:browse', 'work_item:view'],
      },
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: noPages.userId, workspaceId: f.workspaceId } },
      data: { roleDefinitionId: role.id },
    });
    const asNoPages = await refused(
      pageCommentsService.readPageThread(noPages, { ...on(f), commentId: root.id }),
    );
    const listRefusal = await refused(
      pageCommentsService.listPageThreads(noPages, { ...on(f), status: 'open' }),
    );
    expect(asNoPages).toBeInstanceOf(ProjectAccessDeniedError);
    expect(asNoPages).toMatchObject({ kind: (listRefusal as ProjectAccessDeniedError).kind });
  });

  it('answers another project’s page as not found, another page’s comment as comment-not-found, and reads an archived page', async () => {
    const f = await makeFixture();
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const other = await projectsService.createProject({
      workspaceId: f.workspaceId,
      actorUserId: f.owner.userId,
      name: 'Other',
      identifier: 'PCR',
    });
    const foreign = await pagesService.createPage(f.owner, { projectId: other.id, title: 'X' });
    expect(
      await refused(
        pageCommentsService.readPageThread(f.owner, {
          projectId: f.projectId,
          pageId: foreign.id,
          commentId: root.id,
        }),
      ),
    ).toBeInstanceOf(PageNotFoundError);

    const sibling = await pagesService.createPage(f.owner, { projectId: f.projectId, title: 'Y' });
    const wrongPage = await refused(
      pageCommentsService.readPageThread(f.owner, {
        projectId: f.projectId,
        pageId: sibling.id,
        commentId: root.id,
      }),
    );
    expect(wrongPage).toBeInstanceOf(PageCommentNotFoundError);
    expect(wrongPage).toMatchObject({ code: 'PAGE_COMMENT_NOT_FOUND' });

    await pagesService.archivePage(f.owner, on(f));
    const archived = await pageCommentsService.readPageThread(f.owner, {
      ...on(f),
      commentId: root.id,
    });
    expect(archived.id).toBe(root.id);
  });
});

describe('pageCommentsService — writes', () => {
  it('refuses a viewer every write with comment:add, writing nothing', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const before = await snapshot();
    for (const write of everyWrite(viewer, f, root)) {
      const err = await refused(write());
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect(err).toMatchObject({ permission: 'comment:add' });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('lets a member edit and delete only their own, and the owner moderate', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    const other = await actorAs(f, 'other', 'member');
    const root = await pageCommentsService.postPageComment(member, { ...on(f), bodyMd: 'Mine' });
    const target = { ...on(f), commentId: root.id };

    const edit = await refused(
      pageCommentsService.editPageCommentBody(other, { ...target, bodyMd: 'Theirs' }),
    );
    expect(edit).toBeInstanceOf(PageCommentForbiddenError);
    const del = await refused(pageCommentsService.removePageComment(other, target));
    expect(del).toMatchObject({ action: 'delete' });
    expect((await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } })).bodyMd).toBe(
      'Mine',
    );

    const mine = await pageCommentsService.editPageCommentBody(member, {
      ...target,
      bodyMd: 'Mine, edited',
    });
    expect(mine.editedAt).not.toBeNull();
    const moderated = await pageCommentsService.editPageCommentBody(f.owner, {
      ...target,
      bodyMd: 'Moderated',
    });
    expect(moderated.bodyMd).toBe('Moderated');
    await pageCommentsService.postPageReply(other, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'reply',
    });
    expect(await pageCommentsService.removePageComment(f.owner, target)).toEqual({
      commentId: root.id,
      parentCommentId: null,
      replyCount: 1,
    });
    expect(await adminDb.pageComment.count()).toBe(0);
  });

  it('resolves as the caller and reopens', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Q' });
    const resolved = await pageCommentsService.resolvePageThread(member, {
      ...on(f),
      commentId: root.id,
    });
    expect(resolved.resolvedBy?.id).toBe(member.userId);
    const lists = {
      open: await pageCommentsService.listPageThreads(member, { ...on(f), status: 'open' }),
      resolved: await pageCommentsService.listPageThreads(member, { ...on(f), status: 'resolved' }),
    };
    expect(lists.open.threads).toEqual([]);
    expect(lists.resolved.threads.map((t) => t.id)).toEqual([root.id]);

    await pageCommentsService.reopenPageThread(member, { ...on(f), commentId: root.id });
    const open = await pageCommentsService.listPageThreads(member, { ...on(f), status: 'open' });
    expect(open.threads.map((t) => t.id)).toEqual([root.id]);
  });

  it('refuses every write on an archived page for a member and a moderator; reads still work', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    const root = await pageCommentsService.postPageComment(member, { ...on(f), bodyMd: 'Root' });
    await pagesService.archivePage(f.owner, on(f));
    const before = await snapshot();
    for (const actor of [member, f.owner]) {
      for (const write of everyWrite(actor, f, root)) {
        expect(await refused(write())).toBeInstanceOf(PageArchivedError);
      }
    }
    expect(await snapshot()).toEqual(before);

    const listed = await pageCommentsService.listPageThreads(member, { ...on(f), status: 'open' });
    expect(listed.threads.map((t) => t.id)).toEqual([root.id]);
    expect(listed.capabilities).toEqual({ canComment: false, canModerate: false });
    const asOwner = await pageCommentsService.listPageThreads(f.owner, {
      ...on(f),
      status: 'open',
    });
    expect(asOwner.capabilities).toEqual({ canComment: false, canModerate: true });
  });
});

describe('pageCommentsService — tenancy', () => {
  it('hides a W1 page’s comments from a W2 member, and refuses their writes, writing nothing', async () => {
    const w1 = await makeFixture('PCW');
    const w2 = await makeFixture('PCX');
    const root = await pageCommentsService.postPageComment(w1.owner, { ...on(w1), bodyMd: 'W1' });
    const intruder = { projectId: w2.projectId, pageId: w1.pageId };

    expect(
      await refused(pageCommentsService.listPageThreads(w2.owner, { ...intruder, status: 'open' })),
    ).toBeInstanceOf(PageNotFoundError);

    const before = await snapshot();
    const target = { ...intruder, commentId: root.id };
    for (const write of [
      () => pageCommentsService.postPageComment(w2.owner, { ...intruder, bodyMd: 'x' }),
      () =>
        pageCommentsService.postPageReply(w2.owner, {
          ...intruder,
          parentCommentId: root.id,
          bodyMd: 'x',
        }),
      () => pageCommentsService.editPageCommentBody(w2.owner, { ...target, bodyMd: 'x' }),
      () => pageCommentsService.removePageComment(w2.owner, target),
      () => pageCommentsService.resolvePageThread(w2.owner, target),
      () => pageCommentsService.reopenPageThread(w2.owner, target),
    ]) {
      expect(await refused(write())).toBeInstanceOf(PageNotFoundError);
    }
    expect(await snapshot()).toEqual(before);
  });
});

// ── The `page/comment.created` event (Story MOTIR-10868 · MOTIR-10923) ───────

describe('pageCommentsService — the page/comment.created event', () => {
  const EVENT = 'page/comment.created';
  let captured: ReturnType<typeof captureJobEvents>;

  beforeEach(() => {
    captured = captureJobEvents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The payloads of the page event, in emit order. */
  const payloads = () =>
    captured.events.filter((e) => e.name === EVENT).map((e) => e.data as PageCommentCreatedData);

  const token = (a: Actor, name = 'Person') => `[@${name}](mention:${a.userId})`;

  /** A workspace member who cannot ENTER the project: limited scope, never added. */
  async function outsider(f: Fixture): Promise<Actor> {
    const user = await makeUser('outsider');
    await adminDb.workspaceMembership.create({
      data: {
        userId: user.id,
        workspaceId: f.workspaceId,
        workspaceRole: 'member',
        accessScope: 'limited',
      },
    });
    return { userId: user.id, workspaceId: f.workspaceId };
  }

  it('starting a thread emits once, after the commit, with the mentions in body order', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const ben = await actorAs(f, 'ben', 'member');
    // At the moment of the emit, the row the payload names must already be readable.
    const readable: boolean[] = [];
    vi.spyOn(jobDispatcher, 'dispatchEventToEngine').mockImplementation(async (name, data) => {
      captured.events.push({ name, data });
      if (name === EVENT) {
        const id = (data as PageCommentCreatedData).commentId;
        readable.push((await adminDb.pageComment.findUnique({ where: { id } })) !== null);
      }
      return { dispatched: 0 } as never;
    });

    const root = await pageCommentsService.postPageComment(f.owner, {
      ...on(f),
      bodyMd: `Over to ${token(ben)} and ${token(ana)}, and ${token(ben)} again.`,
    });

    expect(payloads()).toEqual([
      {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        pageId: f.pageId,
        commentId: root.id,
        threadRootCommentId: root.id,
        authorId: f.owner.userId,
        mentionedUserIds: [ben.userId, ana.userId],
        isReply: false,
        isEdit: false,
      },
    ]);
    expect(readable).toEqual([true]);
  });

  it('a comment that mentions nobody still emits, with an empty list and no member read', async () => {
    const f = await makeFixture();
    const members = vi.spyOn(assignableMembersService, 'list');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Hi' });
    await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'Still here',
    });
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: root.id,
      bodyMd: 'Hello',
    });
    expect(members).not.toHaveBeenCalled();
    expect(payloads().map((p) => [p.commentId, p.mentionedUserIds])).toEqual([
      [root.id, []],
      [expect.any(String), []],
    ]);
  });

  it('reads the mentionable set once, before the write, scoped by the project access mode', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const rowsAtRead: number[] = [];
    const real = assignableMembersService.list.bind(assignableMembersService);
    const members = vi.spyOn(assignableMembersService, 'list').mockImplementation(async (input) => {
      rowsAtRead.push(await adminDb.pageComment.count());
      return real(input);
    });
    await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: token(ana) });
    expect(members).toHaveBeenCalledTimes(1);
    expect(members.mock.calls[0]![0]).toMatchObject({
      projectId: f.projectId,
      accessMode: 'workspace',
    });
    expect(rowsAtRead).toEqual([0]);
  });

  it('a reply emits once, rooted at its parent, even when it mentions nobody', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const silent = await pageCommentsService.postPageReply(ana, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'Agreed.',
    });
    const loud = await pageCommentsService.postPageReply(ana, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: `Thanks ${token(f.owner)}`,
    });
    expect(payloads().slice(1)).toEqual([
      expect.objectContaining({
        commentId: silent.id,
        threadRootCommentId: root.id,
        authorId: ana.userId,
        mentionedUserIds: [],
        isReply: true,
        isEdit: false,
      }),
      expect.objectContaining({
        commentId: loud.id,
        threadRootCommentId: root.id,
        mentionedUserIds: [f.owner.userId],
        isReply: true,
      }),
    ]);
  });

  it('never names a person who cannot enter the project, and keeps their token in the body', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const out = await outsider(f);
    const body = `${token(out, 'Out')} and ${token(ana)}`;

    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: body });
    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: body,
    });
    const plain = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'x' });
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: plain.id,
      bodyMd: body,
    });

    expect(payloads().map((p) => p.mentionedUserIds)).toEqual([
      [ana.userId],
      [ana.userId],
      [],
      [ana.userId],
    ]);
    for (const id of [root.id, reply.id, plain.id]) {
      const row = await adminDb.pageComment.findUniqueOrThrow({ where: { id } });
      expect(row.bodyMd).toBe(body);
    }
  });

  it('an edit names only the people it added; a rewording and a removal are silent', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const ben = await actorAs(f, 'ben', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: `Ask ${token(ana)}`,
    });
    const before = payloads().length;
    const target = { ...on(f), commentId: reply.id };

    await pageCommentsService.editPageCommentBody(f.owner, {
      ...target,
      bodyMd: `Ask ${token(ana)} and ${token(ben)}`,
    });
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...target,
      bodyMd: `Please ask ${token(ana)} and ${token(ben)}`,
    });
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...target,
      bodyMd: `Please ask ${token(ana)}`,
    });

    expect(payloads().slice(before)).toEqual([
      {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        pageId: f.pageId,
        commentId: reply.id,
        threadRootCommentId: root.id,
        authorId: f.owner.userId,
        mentionedUserIds: [ben.userId],
        isReply: true,
        isEdit: true,
      },
    ]);
  });

  it('a moderator’s edit of a root is authored by the moderator and rooted at the root itself', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const root = await pageCommentsService.postPageComment(ana, { ...on(f), bodyMd: 'Root' });
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: root.id,
      bodyMd: `Root, cc ${token(ana)}`,
    });
    expect(payloads().at(-1)).toMatchObject({
      commentId: root.id,
      threadRootCommentId: root.id,
      authorId: f.owner.userId,
      mentionedUserIds: [ana.userId],
      isReply: false,
      isEdit: true,
    });
  });

  it('a token moved out of code counts as added; a token kept in code counts on neither side', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const ben = await actorAs(f, 'ben', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, {
      ...on(f),
      bodyMd: `\`${token(ana)}\` and \`${token(ben)}\``,
    });
    expect(payloads().at(-1)!.mentionedUserIds).toEqual([]);
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: root.id,
      bodyMd: `${token(ana)} and \`${token(ben)}\``,
    });
    expect(payloads().at(-1)).toMatchObject({ mentionedUserIds: [ana.userId] });
  });

  it('a byte-identical edit writes nothing and emits nothing', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const body = `Ask ${token(ana)}`;
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: body });
    const before = captured.events.length;
    await pageCommentsService.editPageCommentBody(f.owner, {
      ...on(f),
      commentId: root.id,
      bodyMd: body,
    });
    expect(captured.events.length).toBe(before);
    const row = await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } });
    expect(row.editedAt).toBeNull();
  });

  it('delete, resolve and reopen emit no event of any name', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, {
      ...on(f),
      bodyMd: `Root ${token(ana)}`,
    });
    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: `Reply ${token(ana)}`,
    });
    const before = captured.events.length;
    const target = { ...on(f), commentId: root.id };
    await pageCommentsService.resolvePageThread(f.owner, target);
    await pageCommentsService.reopenPageThread(f.owner, target);
    await pageCommentsService.removePageComment(f.owner, { ...on(f), commentId: reply.id });
    await pageCommentsService.removePageComment(f.owner, target);
    expect(captured.events.slice(before)).toEqual([]);
  });

  it('a refused write emits nothing', async () => {
    const f = await makeFixture();
    const ana = await actorAs(f, 'ana', 'member');
    const root = await pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: 'Root' });
    const reply = await pageCommentsService.postPageReply(f.owner, {
      ...on(f),
      parentCommentId: root.id,
      bodyMd: 'Reply',
    });
    const elsewhere = await makeFixture('PCX');
    const foreign = await pageCommentsService.postPageComment(elsewhere.owner, {
      ...on(elsewhere),
      bodyMd: 'Theirs',
    });
    const before = captured.events.length;

    expect(
      await refused(pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: '   ' })),
    ).toBeInstanceOf(PageCommentBodyEmptyError);
    expect(
      await refused(
        pageCommentsService.postPageReply(f.owner, {
          ...on(f),
          parentCommentId: reply.id,
          bodyMd: `Deep ${token(ana)}`,
        }),
      ),
    ).toBeInstanceOf(PageCommentReplyDepthError);
    expect(
      await refused(
        pageCommentsService.editPageCommentBody(f.owner, {
          ...on(f),
          commentId: foreign.id,
          bodyMd: `Mine ${token(ana)}`,
        }),
      ),
    ).toBeInstanceOf(PageCommentNotFoundError);
    await pagesService.archivePage(f.owner, on(f));
    expect(
      await refused(
        pageCommentsService.postPageComment(f.owner, { ...on(f), bodyMd: `Late ${token(ana)}` }),
      ),
    ).toBeInstanceOf(PageArchivedError);

    expect(captured.events.slice(before).filter((e) => e.name === EVENT)).toEqual([]);
  });
});
