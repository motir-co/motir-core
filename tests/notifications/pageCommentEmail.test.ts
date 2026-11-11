import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pageCommentEmailOnCommentCreated } from '@/lib/jobs/definitions/pageCommentEmail';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import type { EmailSendData, PageCommentCreatedData } from '@/lib/jobs/types';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { pageCommentEmailService } from '@/lib/services/pageCommentEmailService';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine, captureJobEvents } from '../helpers/jobs';

// The page-comment EMAIL fan-out on real Postgres (Story MOTIR-10868 ·
// MOTIR-10925): who is mailed on a mention and on a reply, the two independent
// preference cells, the send-time access re-check, the vanished-subject races,
// one key per comment × recipient across both variants, each recipient's own
// language, and the job that delegates to it. Comments go through the real
// service; every queued event is captured, so no job runs on its own and the
// assertions read the `email.send` payloads the fan-out enqueued.

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
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  pageId: string;
  a: Person;
  b: Person;
  c: Person;
  d: Person;
  outsider: Person;
}

let seq = 0;
async function user(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-email-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Mail ${tag.toUpperCase()}`,
  });
}

async function makeTenant(identifier = 'PEM'): Promise<Tenant> {
  const owner = await user('a');
  const ws = await workspacesService.createWorkspace({ name: 'Mail', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Mail',
    identifier,
  });
  const a = { userId: owner.id, workspaceId, email: owner.email, name: owner.name };
  const page = await pagesService.createPage(a, { projectId: project.id, title: 'Plan' });
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
    pageId: page.id,
    a,
    b: await member('b'),
    c: await member('c'),
    d: await member('d'),
    outsider: await member('out', 'limited'),
  };
}

const token = (p: Person) => `[@${p.name}](mention:${p.userId})`;
const on = (t: Tenant) => ({ projectId: t.projectId, pageId: t.pageId });

function lastPageEvent(): PageCommentCreatedData {
  return captured.events.filter((e) => e.name === 'page/comment.created').at(-1)!
    .data as PageCommentCreatedData;
}

/** The `email.send` payloads queued since `from`. */
function sends(from = 0): EmailSendData[] {
  return captured.events
    .slice(from)
    .filter((e) => e.name === 'email.send')
    .map((e) => e.data as EmailSendData);
}

/** recipient address → the variant they were mailed. */
const variants = (list: EmailSendData[]) =>
  Object.fromEntries(list.map((s) => [s.to, (s.data as { variant: string }).variant] as const));

async function thread(t: Tenant, author: Person, bodyMd: string) {
  const root = await pageCommentsService.postPageComment(author, { ...on(t), bodyMd });
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

const off = (p: Person, eventType: 'mentioned' | 'commented') =>
  notificationPreferencesService.setPreference(p.userId, {
    eventType,
    channel: 'email',
    enabled: false,
  });

describe('pageCommentEmailService.fanOut — a mention', () => {
  it('mails each mentioned person once, gated by their own mention cell', async () => {
    const t = await makeTenant();
    await adminDb.page.update({ where: { id: t.pageId }, data: { title: 'Renamed plan' } });
    await off(t.b, 'mentioned');
    const { root, event } = await thread(t, t.a, `Over to ${token(t.b)} and ${token(t.c)}.`);
    const from = captured.events.length;

    const result = await pageCommentEmailService.fanOut(event);

    expect(result).toEqual({ notifiedUserIds: [t.c.userId] });
    const [send, ...rest] = sends(from);
    expect(rest).toEqual([]);
    const url = `${resolveBaseUrlTrimmed()}/pages/${t.pageId}?thread=${root.id}`;
    expect(send).toEqual({
      workspaceId: t.workspaceId,
      idempotencyKey: `page-comment:${root.id}:${t.c.userId}`,
      to: t.c.email,
      template: 'page-comment-notification',
      data: {
        recipientName: t.c.name,
        authorName: t.a.name,
        pageTitle: 'Renamed plan',
        variant: 'mention',
        excerpt: `Over to @${t.b.name} and @${t.c.name}.`,
        threadUrl: url,
        locale: 'en',
      },
    });
    expect(url).not.toContain('/items/');
  });

  it('nobody is mailed about their own write', async () => {
    const t = await makeTenant();
    const { root, event } = await thread(t, t.a, `Note to ${token(t.a)}`);
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });
    const { event: own } = await reply(t, t.a, root.id, 'Talking to myself');
    expect(await pageCommentEmailService.fanOut(own)).toEqual({ notifiedUserIds: [] });
    expect(sends()).toEqual([]);
  });

  it('drops a candidate who cannot view the pages and mails the rest', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `cc ${token(t.b)}`);
    const result = await pageCommentEmailService.fanOut({
      ...event,
      mentionedUserIds: [t.outsider.userId, t.b.userId],
    });
    expect(result).toEqual({ notifiedUserIds: [t.b.userId] });
  });

  it('writes each email in its recipient’s language, in one batch', async () => {
    const t = await makeTenant();
    await adminDb.user.update({ where: { id: t.b.userId }, data: { locale: 'de' } });
    await adminDb.user.update({ where: { id: t.c.userId }, data: { locale: 'fr' } });
    await adminDb.user.update({ where: { id: t.a.userId }, data: { locale: 'ja' } });
    const { event } = await thread(t, t.a, `${token(t.b)} ${token(t.c)}`);
    const from = captured.events.length;
    await pageCommentEmailService.fanOut(event);
    expect(
      Object.fromEntries(sends(from).map((s) => [s.to, (s.data as { locale: string }).locale])),
    ).toEqual({ [t.b.email]: 'de', [t.c.email]: 'fr' });
  });
});

describe('pageCommentEmailService.fanOut — a reply', () => {
  it('mails the starter and the earlier repliers the reply variant, never the author', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { event } = await reply(t, t.c, root.id, 'Agreed.');
    // A later reply is not a participant of this one.
    await reply(t, t.d, root.id, 'Later');
    const from = captured.events.length;

    await pageCommentEmailService.fanOut(event);

    expect(variants(sends(from))).toEqual({ [t.a.email]: 'reply', [t.b.email]: 'reply' });
    expect(sends(from)[0]!.data).toMatchObject({ excerpt: 'Agreed.' });
  });

  it('a participant the reply mentions is mailed once, as a mention', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { event } = await reply(t, t.d, root.id, `Over to ${token(t.a)}`);
    const from = captured.events.length;

    await pageCommentEmailService.fanOut(event);

    expect(sends(from)).toHaveLength(2);
    expect(variants(sends(from))).toEqual({ [t.a.email]: 'mention', [t.b.email]: 'reply' });
  });

  it('each set is gated by its own cell', async () => {
    const t = await makeTenant();
    await off(t.a, 'commented');
    await off(t.b, 'mentioned');
    const { root } = await thread(t, t.a, 'Root');
    await reply(t, t.b, root.id, 'First');
    const { event: quiet } = await reply(t, t.c, root.id, 'Agreed.');
    let from = captured.events.length;
    await pageCommentEmailService.fanOut(quiet);
    // A turned replies off; B turned only mentions off, so B still hears the reply.
    expect(variants(sends(from))).toEqual({ [t.b.email]: 'reply' });

    const { event: loud } = await reply(t, t.d, root.id, `Ping ${token(t.a)}`);
    from = captured.events.length;
    await pageCommentEmailService.fanOut(loud);
    // A is still reachable through the mention cell; C replied earlier, so hears it.
    expect(variants(sends(from))).toEqual({
      [t.a.email]: 'mention',
      [t.b.email]: 'reply',
      [t.c.email]: 'reply',
    });
  });
});

describe('pageCommentEmailService.fanOut — idempotency and races', () => {
  it('a replay enqueues the identical keys again', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `cc ${token(t.b)}`);
    let from = captured.events.length;
    await pageCommentEmailService.fanOut(event);
    const first = sends(from).map((s) => s.idempotencyKey);
    from = captured.events.length;
    await pageCommentEmailService.fanOut(event);
    expect(sends(from).map((s) => s.idempotencyKey)).toEqual(first);
  });

  it('an edit re-fire on a reply mails only the added person new; the thread’s keys repeat', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    const { row, event } = await reply(t, t.b, root.id, 'Hello');
    let from = captured.events.length;
    await pageCommentEmailService.fanOut(event);
    const before = new Set(sends(from).map((s) => s.idempotencyKey));
    expect(before).toEqual(new Set([`page-comment:${row.id}:${t.a.userId}`]));

    await pageCommentsService.editPageCommentBody(t.b, {
      ...on(t),
      commentId: row.id,
      bodyMd: `Hello ${token(t.c)}`,
    });
    const refire = lastPageEvent();
    expect(refire.mentionedUserIds).toEqual([t.c.userId]);
    from = captured.events.length;
    await pageCommentEmailService.fanOut(refire);
    const keys = sends(from).map((s) => s.idempotencyKey);
    // A's key is the one already sent, so the email.send dedup collapses it; C's is new.
    expect(keys.filter((k) => !before.has(k))).toEqual([`page-comment:${row.id}:${t.c.userId}`]);
  });

  it('a deleted comment, a missing thread root, a missing page and a vanished project send nothing', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, 'Root');
    const { row, event } = await reply(t, t.b, root.id, `cc ${token(t.c)}`);
    const from = captured.events.length;

    const real = pageCommentRepository.findById.bind(pageCommentRepository);
    const comments = vi
      .spyOn(pageCommentRepository, 'findById')
      .mockImplementation(async (id, tx) => (id === root.id ? null : real(id, tx)));
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });
    comments.mockRestore();

    vi.spyOn(pageRepository, 'findById').mockResolvedValueOnce(null);
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });

    const access = vi
      .spyOn(projectAccessService, 'getPageCapabilities')
      .mockRejectedValue(new ProjectNotFoundError(t.projectId));
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });
    access.mockRejectedValue(new Error('db down'));
    await expect(pageCommentEmailService.fanOut(event)).rejects.toThrow('db down');
    access.mockRestore();

    await pageCommentsService.removePageComment(t.b, { ...on(t), commentId: row.id });
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });
    expect(sends(from)).toEqual([]);
  });

  it('a recipient whose user row is gone at send time is skipped', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `cc ${token(t.b)}`);
    vi.spyOn(notificationPreferencesService, 'filterChannelEnabled').mockResolvedValue([
      t.b.userId,
    ]);
    const { userRepository } = await import('@/lib/repositories/userRepository');
    const real = userRepository.findByIds.bind(userRepository);
    vi.spyOn(userRepository, 'findByIds').mockImplementation(async (ids, tx) =>
      ids.includes(t.b.userId) ? [] : real(ids, tx),
    );
    expect(await pageCommentEmailService.fanOut(event)).toEqual({ notifiedUserIds: [] });
  });

  it('writes no notification row', async () => {
    const t = await makeTenant();
    const { root } = await thread(t, t.a, `cc ${token(t.b)}`);
    const { event } = await reply(t, t.c, root.id, `and ${token(t.d)}`);
    const before = await adminDb.notification.count();
    await pageCommentEmailService.fanOut(event);
    expect(await adminDb.notification.count()).toBe(before);
  });
});

describe('the page-comment email job', () => {
  beforeEach(async () => {
    await truncateJobRuns();
  });

  it('is an additional consumer of page/comment.created in the registry', () => {
    expect(jobDefinitions).toContain(pageCommentEmailOnCommentCreated);
    expect(pageCommentEmailOnCommentCreated).toMatchObject({
      id: 'page-comment-email/comment.created',
      trigger: 'page/comment.created',
      retryPolicy: 'transient',
      idempotency: undefined,
    });
  });

  it('delegates to the injected service in one step and returns its summary', async () => {
    const t = await makeTenant();
    const { event } = await thread(t, t.a, `cc ${token(t.b)}`);
    const fanOut = vi.spyOn(jobServices.pageCommentEmail, 'fanOut');

    const engine = new JobTestEngine({
      function: pageCommentEmailOnCommentCreated,
      events: [{ name: 'page/comment.created', data: event }],
    });
    const { result } = await engine.execute();

    expect(fanOut).toHaveBeenCalledWith(event);
    expect(result).toEqual({ notifiedUserIds: [t.b.userId] });
  });
});
