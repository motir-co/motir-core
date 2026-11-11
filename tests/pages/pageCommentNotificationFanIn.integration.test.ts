import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { NotificationData } from '@/lib/dto/notifications';
import { pageCommentNotificationFanIn } from '@/lib/jobs/definitions/pageCommentNotificationFanIn';
import type { PageCommentCreatedData } from '@/lib/jobs/types';
import { NOTIFICATION_PREFERENCE_EVENT_TYPES } from '@/lib/notifications/preferences';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  PAGE_COMMENT_DEDUPE_PREFIX,
  notificationFanInService,
} from '@/lib/services/notificationFanInService';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine, captureJobEvents } from '../helpers/jobs';

// The IN-APP FAN-IN of a page comment on real Postgres (Story MOTIR-10868 ·
// MOTIR-10924): who gets a row on a mention and on a reply, the exclusions, the
// send-time page-access and preference gates, the one shared dedupe key that keeps
// a person to one row per comment, and the job that delegates to it. Comments are
// written through the real service; the events it emits are captured (so no job
// runs on its own) and handed to the fan-in explicitly.

let captured: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  captured = captureJobEvents();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Person {
  userId: string;
  workspaceId: string;
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
  /** A workspace member holding no role in the project (limited scope, never added). */
  outsider: Person;
}

let seq = 0;
async function user(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-fan-in-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Fan ${tag.toUpperCase()}`,
  });
}

async function makeTenant(identifier = 'PFI', title = 'Release checklist'): Promise<Tenant> {
  const owner = await user('a');
  const ws = await workspacesService.createWorkspace({ name: 'Fan', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Fan',
    identifier,
  });
  const a = { userId: owner.id, workspaceId };
  const page = await pagesService.createPage(a, { projectId: project.id, title: 'Draft' });
  await adminDb.page.update({ where: { id: page.id }, data: { title } });
  const member = async (tag: string, accessScope: 'full' | 'limited' = 'full') => {
    const u = await user(tag);
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId, workspaceRole: 'member', accessScope },
    });
    return { userId: u.id, workspaceId };
  };
  return {
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    pageId: page.id,
    a,
    b: await member('b'),
    c: await member('c'),
    d: await member('d'),
    outsider: await member('out', 'limited'),
  };
}

const token = (p: Person) => `[@Someone](mention:${p.userId})`;
const on = (t: Tenant) => ({ projectId: t.projectId, pageId: t.pageId });

/** The last `page/comment.created` payload the service emitted. */
function lastEvent(): PageCommentCreatedData {
  const events = captured.events.filter((e) => e.name === 'page/comment.created');
  return events.at(-1)!.data as PageCommentCreatedData;
}

const rowsFor = (commentId: string): Promise<Notification[]> =>
  adminDb.notification.findMany({
    where: { dedupeKey: `${PAGE_COMMENT_DEDUPE_PREFIX}${commentId}` },
    orderBy: { recipientUserId: 'asc' },
  });

const kindOf = (row: Notification) => (row.data as unknown as NotificationData).kind;

async function startThread(t: Tenant, author: Person, bodyMd: string) {
  const root = await pageCommentsService.postPageComment(author, { ...on(t), bodyMd });
  return { root, event: lastEvent() };
}

async function reply(t: Tenant, author: Person, rootId: string, bodyMd: string) {
  const row = await pageCommentsService.postPageReply(author, {
    ...on(t),
    parentCommentId: rootId,
    bodyMd,
  });
  return { row, event: lastEvent() };
}

describe('fanInPageComment — a mention', () => {
  it('writes one page_mentioned row for the mentioned person and none for the author', async () => {
    const t = await makeTenant();
    const { root, event } = await startThread(t, t.a, `Can you check this, ${token(t.b)}?`);

    const result = await notificationFanInService.fanInPageComment(event);

    expect(result).toEqual({ writtenUserIds: [t.b.userId] });
    const rows = await rowsFor(root.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientUserId: t.b.userId,
      type: 'mentioned',
      category: 'direct',
      actorId: t.a.userId,
      pageId: t.pageId,
      workItemId: null,
    });
    expect(rows[0]!.data).toEqual({
      kind: 'page_mentioned',
      pageId: t.pageId,
      pageTitle: 'Release checklist',
      projectKey: t.projectKey,
      threadRootId: root.id,
      excerpt: 'Can you check this, @Someone?',
    });
  });

  it('an author who mentions themselves gets no row', async () => {
    const t = await makeTenant();
    const { root, event } = await startThread(t, t.a, `Note to ${token(t.a)}`);
    expect(event.mentionedUserIds).toEqual([t.a.userId]);
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    expect(await rowsFor(root.id)).toEqual([]);
  });
});

describe('fanInPageComment — a reply', () => {
  it('a reply that mentions nobody reaches the thread starter and earlier repliers, not its author', async () => {
    const t = await makeTenant();
    const { root } = await startThread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { row, event } = await reply(t, t.c, root.id, 'Agreed.');

    const result = await notificationFanInService.fanInPageComment(event);

    expect([...result.writtenUserIds].sort()).toEqual([t.a.userId, t.b.userId].sort());
    const rows = await rowsFor(row.id);
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([t.a.userId, t.b.userId].sort());
    for (const r of rows) {
      expect(r.type).toBe('commented');
      expect(r.data).toMatchObject({
        kind: 'page_replied',
        threadRootId: root.id,
        excerpt: 'Agreed.',
      });
    }
  });

  it('a participant the reply also mentions gets the mention row and no reply row', async () => {
    const t = await makeTenant();
    const { root } = await startThread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { row, event } = await reply(t, t.d, root.id, `Over to ${token(t.a)}`);

    await notificationFanInService.fanInPageComment(event);

    const rows = await rowsFor(row.id);
    expect(rows.filter((r) => r.recipientUserId === t.a.userId)).toHaveLength(1);
    expect(Object.fromEntries(rows.map((r) => [r.recipientUserId, kindOf(r)]))).toEqual({
      [t.a.userId]: 'page_mentioned',
      [t.b.userId]: 'page_replied',
    });
    expect(new Set(rows.map((r) => r.dedupeKey))).toEqual(
      new Set([`${PAGE_COMMENT_DEDUPE_PREFIX}${row.id}`]),
    );
  });

  it('an edit re-fire under the same comment id writes only the person it added', async () => {
    const t = await makeTenant();
    const { root } = await startThread(t, t.a, 'Root');
    const { row, event } = await reply(t, t.b, root.id, 'Hello');
    expect((await notificationFanInService.fanInPageComment(event)).writtenUserIds).toEqual([
      t.a.userId,
    ]);

    await pageCommentsService.editPageCommentBody(t.b, {
      ...on(t),
      commentId: row.id,
      bodyMd: `Hello ${token(t.a)} and ${token(t.c)}`,
    });
    const refire = lastEvent();
    expect(refire.mentionedUserIds).toEqual([t.a.userId, t.c.userId]);

    expect(await notificationFanInService.fanInPageComment(refire)).toEqual({
      writtenUserIds: [t.c.userId],
    });
    const rows = await rowsFor(row.id);
    expect(rows).toHaveLength(2);
    // A keeps the one row it already had for this comment.
    expect(rows.filter((r) => r.recipientUserId === t.a.userId)).toHaveLength(1);
  });
});

describe('fanInPageComment — exclusions and gates', () => {
  it('a candidate who cannot view the project gets nothing while another does', async () => {
    const t = await makeTenant();
    const { root, event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    // The emitter already filters this person; the send-time check re-filters anyway.
    const result = await notificationFanInService.fanInPageComment({
      ...event,
      mentionedUserIds: [t.outsider.userId, t.b.userId],
    });
    expect(result.writtenUserIds).toEqual([t.b.userId]);
    expect((await rowsFor(root.id)).map((r) => r.recipientUserId)).toEqual([t.b.userId]);
  });

  it('a comment deleted before the fan-out writes nothing and does not throw', async () => {
    const t = await makeTenant();
    const { root, event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    await pageCommentsService.removePageComment(t.a, { ...on(t), commentId: root.id });
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    expect(await adminDb.notification.count()).toBe(0);
  });

  it('a comment id from another workspace resolves to nothing', async () => {
    const t = await makeTenant();
    const other = await makeTenant('PFO');
    const { event } = await startThread(other, other.a, `cc ${token(other.b)}`);
    const result = await notificationFanInService.fanInPageComment({
      ...event,
      workspaceId: t.workspaceId,
      mentionedUserIds: [t.b.userId],
    });
    expect(result).toEqual({ writtenUserIds: [] });
    expect(await adminDb.notification.count()).toBe(0);
  });

  it('a page or project that no longer resolves writes nothing', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    vi.spyOn(pageRepository, 'findById').mockResolvedValueOnce(null);
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    vi.spyOn(projectRepository, 'findById').mockResolvedValueOnce(null);
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    expect(await adminDb.notification.count()).toBe(0);
  });

  it('a reply whose thread root no longer resolves still reaches the earlier repliers', async () => {
    const t = await makeTenant();
    const { root } = await startThread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { event } = await reply(t, t.c, root.id, 'Second');
    const real = pageCommentRepository.findById.bind(pageCommentRepository);
    vi.spyOn(pageCommentRepository, 'findById').mockImplementation(async (id, tx) =>
      id === root.id ? null : real(id, tx),
    );
    expect((await notificationFanInService.fanInPageComment(event)).writtenUserIds).toEqual([
      t.b.userId,
    ]);
  });

  it('a fan-out whose every candidate is dropped writes nothing', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    expect(
      await notificationFanInService.fanInPageComment({
        ...event,
        mentionedUserIds: [t.outsider.userId],
      }),
    ).toEqual({ writtenUserIds: [] });
    await notificationPreferencesService.setPreference(t.b.userId, {
      eventType: 'mentioned',
      channel: 'in_app',
      enabled: false,
    });
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    expect(await adminDb.notification.count()).toBe(0);
  });

  it('a vanished project ends the walk with no row', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    vi.spyOn(projectAccessService, 'getPageCapabilities').mockRejectedValue(
      new ProjectNotFoundError(t.projectId),
    );
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
  });

  it('rethrows an access failure that is not a vanished project, so the job retries', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    vi.spyOn(projectAccessService, 'getPageCapabilities').mockRejectedValue(new Error('db down'));
    await expect(notificationFanInService.fanInPageComment(event)).rejects.toThrow('db down');
  });

  it('the mentioned in_app cell off drops that person and keeps another', async () => {
    const t = await makeTenant();
    await notificationPreferencesService.setPreference(t.b.userId, {
      eventType: 'mentioned',
      channel: 'in_app',
      enabled: false,
    });
    const { root, event } = await startThread(t, t.a, `${token(t.b)} ${token(t.c)}`);
    expect((await notificationFanInService.fanInPageComment(event)).writtenUserIds).toEqual([
      t.c.userId,
    ]);
    expect((await rowsFor(root.id)).map((r) => r.recipientUserId)).toEqual([t.c.userId]);
  });

  it('the commented in_app cell off drops that participant and keeps another', async () => {
    const t = await makeTenant();
    await notificationPreferencesService.setPreference(t.a.userId, {
      eventType: 'commented',
      channel: 'in_app',
      enabled: false,
    });
    const { root } = await startThread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { row, event } = await reply(t, t.c, root.id, 'Second');
    expect((await notificationFanInService.fanInPageComment(event)).writtenUserIds).toEqual([
      t.b.userId,
    ]);
    expect((await rowsFor(row.id)).map((r) => r.recipientUserId)).toEqual([t.b.userId]);
  });

  it('adds no preference type: page rows carry the existing mentioned and commented types', () => {
    const types = NOTIFICATION_PREFERENCE_EVENT_TYPES.map((meta) => meta.type);
    expect(types).toContain('mentioned');
    expect(types).toContain('commented');
  });
});

describe('fanInPageComment — idempotency, batching and the page', () => {
  it('a replay writes no second row and reports nobody', async () => {
    const t = await makeTenant();
    const { root, event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    await notificationFanInService.fanInPageComment(event);
    expect(await notificationFanInService.fanInPageComment(event)).toEqual({ writtenUserIds: [] });
    expect(await rowsFor(root.id)).toHaveLength(1);
  });

  it('the existence read answers nothing for no recipients, without a query', async () => {
    const reads = vi.spyOn(adminDb.notification, 'findMany');
    expect(
      await adminDb.$transaction((tx) =>
        notificationRepository.findRecipientIdsByDedupeKey('page-comment:x', [], tx),
      ),
    ).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('writes one createMany per page of recipients', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `${token(t.b)} ${token(t.c)}`);
    const writes = vi.spyOn(notificationRepository, 'createMany');

    await notificationFanInService.fanInPageComment(event, { pageSize: 1 });
    expect(writes.mock.calls.map(([rows]) => rows.length)).toEqual([1, 1]);
  });

  it('writes one createMany of two at the default width', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `${token(t.b)} ${token(t.c)}`);
    const writes = vi.spyOn(notificationRepository, 'createMany');

    await notificationFanInService.fanInPageComment(event);
    expect(writes.mock.calls.map(([rows]) => rows.length)).toEqual([2]);
  });

  it('stores an untitled page’s empty title verbatim', async () => {
    const t = await makeTenant('PFU', '');
    const { root, event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    await notificationFanInService.fanInPageComment(event);
    const [row] = await rowsFor(root.id);
    expect(row!.data).toMatchObject({ pageTitle: '' });
  });

  it('a page archived between the comment and the fan-out still notifies', async () => {
    const t = await makeTenant();
    const { root } = await startThread(t, t.a, `cc ${token(t.b)}`);
    const mention = lastEvent();
    const { row, event: replyEvent } = await reply(t, t.b, root.id, 'On it');
    await pagesService.archivePage(t.a, on(t));

    expect((await notificationFanInService.fanInPageComment(mention)).writtenUserIds).toEqual([
      t.b.userId,
    ]);
    expect((await notificationFanInService.fanInPageComment(replyEvent)).writtenUserIds).toEqual([
      t.a.userId,
    ]);
    expect(await rowsFor(row.id)).toHaveLength(1);
  });
});

describe('the page-comment fan-in job', () => {
  beforeEach(async () => {
    await truncateJobRuns();
  });

  it('delegates the event to fanInPageComment in one step and returns its summary', async () => {
    const t = await makeTenant();
    const { event } = await startThread(t, t.a, `cc ${token(t.b)}`);
    captured.restore();
    const fanIn = vi.spyOn(notificationFanInService, 'fanInPageComment');

    const engine = new JobTestEngine({
      function: pageCommentNotificationFanIn,
      events: [{ name: 'page/comment.created', data: event }],
    });
    const { result } = await engine.execute();

    expect(fanIn).toHaveBeenCalledTimes(1);
    expect(fanIn).toHaveBeenCalledWith(event);
    expect(result).toEqual({ writtenUserIds: [t.b.userId] });
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'notification-fan-in/page-comment.created' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
  });
});
