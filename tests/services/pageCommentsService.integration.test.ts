import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  PageArchivedError,
  PageCommentForbiddenError,
  PageNotFoundError,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { PermissionDeniedError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

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
