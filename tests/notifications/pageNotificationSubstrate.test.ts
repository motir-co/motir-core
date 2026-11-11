import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Notification } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createPage, pageStoreFor, systemClock } from '@/lib/pages';
import { toNotificationDto } from '@/lib/mappers/notificationMappers';
import {
  isWorkItemNotificationData,
  type NotificationData,
  type NotificationPageMentionedData,
  type NotificationPageRepliedData,
} from '@/lib/dto/notifications';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The page notification SUBSTRATE (Story MOTIR-10868 · MOTIR-10922), on real
// Postgres: the two page arms of `Notification.data` survive the read boundary,
// the work-item guard keeps refusing them, `notifyProjectEvent` writes the page
// beside a null work item, and a permanent page delete takes the page's rows and
// no other page's.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makePage(fx: WorkItemFixture, title: string): Promise<string> {
  const page = await withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        actorId: fx.ownerId,
        title,
        parent: { kind: 'root' },
      }),
  );
  return page.id;
}

const mention = (pageId: string, over: Partial<NotificationPageMentionedData> = {}) =>
  ({
    kind: 'page_mentioned',
    pageId,
    pageTitle: 'Release checklist',
    projectKey: 'PROD',
    threadRootId: 'thread-root-1',
    excerpt: 'Can you check this, @Ben?',
    ...over,
  }) satisfies NotificationPageMentionedData;

const reply = (pageId: string, over: Partial<NotificationPageRepliedData> = {}) =>
  ({
    kind: 'page_replied',
    pageId,
    pageTitle: 'Release checklist',
    projectKey: 'PROD',
    threadRootId: 'thread-root-1',
    excerpt: 'Done.',
    ...over,
  }) satisfies NotificationPageRepliedData;

/** A bare row of the given payload — the mapper is pure, so no write is needed. */
function rowOf(data: unknown): Notification {
  return {
    id: 'n1',
    workspaceId: 'ws',
    recipientUserId: 'u',
    type: 'mentioned',
    category: 'direct',
    workItemId: null,
    pageId: 'p1',
    actorId: null,
    data: data as Notification['data'],
    dedupeKey: 'k',
    readAt: null,
    createdAt: new Date('2026-11-11T12:00:00Z'),
  } as Notification;
}

describe('the page arms at the read boundary', () => {
  it('round-trips both page arms through toNotificationDto', () => {
    for (const data of [mention('p1'), reply('p1')]) {
      expect(toNotificationDto(rowOf(data), new Map()).data).toEqual(data);
    }
  });

  it('keeps a page title of "" (the fallback is a render concern) and a null excerpt', () => {
    const data = mention('p1', { pageTitle: '', excerpt: null });
    expect(toNotificationDto(rowOf(data), new Map()).data).toEqual(data);
  });

  it('degrades malformed page fields to empty strings and a null excerpt, never a work-item mention', () => {
    const out = toNotificationDto(rowOf({ kind: 'page_replied', excerpt: 7 }), new Map()).data;
    expect(out).toEqual({
      kind: 'page_replied',
      pageId: '',
      pageTitle: '',
      projectKey: '',
      threadRootId: '',
      excerpt: null,
    });
  });

  it('isWorkItemNotificationData rejects the page arms and still admits the four work-item arms', () => {
    expect(isWorkItemNotificationData(mention('p1'))).toBe(false);
    expect(isWorkItemNotificationData(reply('p1'))).toBe(false);
    const workItemArms: NotificationData[] = [
      { kind: 'mentioned', source: 'comment', issueKey: 'PROD-1', title: 't', excerpt: null },
      { kind: 'transitioned', issueKey: 'PROD-1', title: 't', fromStatus: 'a', toStatus: 'b' },
      { kind: 'review_to_run', issueKey: 'PROD-1', title: 't', command: 'motir review PROD-1' },
      { kind: 'review_sent_back', issueKey: 'PROD-1', title: 't', recordId: 'r' },
    ];
    for (const data of workItemArms) expect(isWorkItemNotificationData(data)).toBe(true);
  });
});

describe('notifyProjectEvent and the page column', () => {
  it('writes the page id beside a null work item id', async () => {
    const fx = await makeWorkItemFixture();
    const recipient = await createTestUser({ name: 'Recipient' });
    const pageId = await makePage(fx, 'Release checklist');

    const wrote = await notificationFanInService.notifyProjectEvent({
      workspaceId: fx.workspaceId,
      recipientUserId: recipient.id,
      type: 'mentioned',
      category: 'direct',
      dedupeKey: `page-mention:${pageId}:c1:${recipient.id}`,
      data: mention(pageId),
      pageId,
      actorId: fx.ownerId,
    });

    expect(wrote).toBe(true);
    const row = await adminDb.notification.findFirstOrThrow({
      where: { recipientUserId: recipient.id },
    });
    expect(row.pageId).toBe(pageId);
    expect(row.workItemId).toBeNull();
    expect(toNotificationDto(row, new Map()).data).toEqual(mention(pageId));
  });

  it('leaves the page id null when the caller names none', async () => {
    const fx = await makeWorkItemFixture();
    const recipient = await createTestUser({ name: 'Recipient' });

    await notificationFanInService.notifyProjectEvent({
      workspaceId: fx.workspaceId,
      recipientUserId: recipient.id,
      type: 'code_access_refused',
      category: 'direct',
      dedupeKey: 'refused:1',
      data: { kind: 'code_access_refused', projectKey: 'PROD', projectName: 'P', repoRef: 'a/b' },
    });

    const row = await adminDb.notification.findFirstOrThrow({
      where: { recipientUserId: recipient.id },
    });
    expect(row.pageId).toBeNull();
  });

  it('a permanent page delete takes that page’s rows and leaves another page’s intact', async () => {
    const fx = await makeWorkItemFixture();
    const recipient = await createTestUser({ name: 'Recipient' });
    const pageA = await makePage(fx, 'Page A');
    const pageB = await makePage(fx, 'Page B');

    for (const [pageId, data] of [
      [pageA, mention(pageA, { pageTitle: 'Page A' })],
      [pageB, reply(pageB, { pageTitle: 'Page B' })],
    ] as const) {
      await notificationFanInService.notifyProjectEvent({
        workspaceId: fx.workspaceId,
        recipientUserId: recipient.id,
        type: data.kind === 'page_mentioned' ? 'mentioned' : 'commented',
        category: 'direct',
        dedupeKey: `page:${pageId}`,
        data,
        pageId,
      });
    }

    await adminDb.$transaction((tx) => pageRepository.deletePages([pageA], tx));

    const rows = await adminDb.notification.findMany({
      where: { recipientUserId: recipient.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pageId).toBe(pageB);
    expect(toNotificationDto(rows[0]!, new Map()).data).toEqual(
      reply(pageB, { pageTitle: 'Page B' }),
    );
  });
});
