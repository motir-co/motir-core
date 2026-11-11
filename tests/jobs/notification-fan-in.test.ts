import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import {
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
} from '@/lib/jobs/definitions/notificationFanIn';
import { jobDefinitions } from '@/lib/jobs/registry';
import { pageCommentNotificationFanIn } from '@/lib/jobs/definitions/pageCommentNotificationFanIn';
import {
  notificationFanInService,
  NOTIFICATION_FAN_IN_REGISTRY,
  type NotificationFanInRegistry,
} from '@/lib/services/notificationFanInService';
import type { NotificationData } from '@/lib/dto/notifications';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { notificationsService } from '@/lib/services/notificationsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { commentsService } from '@/lib/services/commentsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type {
  WorkItemCommentCreatedData,
  WorkItemMentionedData,
  WorkItemTransitionedData,
} from '@/lib/jobs/types';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// In-app notification fan-in (Story 5.7 · Subtask 5.7.3). Real Postgres, no DB
// mocks (Yue's no-mocks rule); the only stubbed seams are the preference gate
// (to prove it's CONSULTED) and projectAccessService (to drive the
// ProjectNotFoundError vanish-tolerance branch) — every other call hits the
// real path. Covers:
//   1. the fan-in service's rules (one row per eligible recipient, the
//      denormalized data payload, actor-excluded, mention-deduped, view
//      re-validated, vanish-tolerant on deleted comment/issue, idempotent on
//      replay, preference-gated);
//   2. the registry EXTENSIBILITY seam — a SYNTHETIC event type produces rows
//      through the same core with no change, asserted WITHOUT importing 5.4/6.6
//      code; an unregistered event is a clean no-op;
//   3. the two registered jobs driving the fan-in in-process via the in-process JobTestEngine
//      (job_run bookkeeping included).

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
  await adminDb.$disconnect();
});

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

interface Scenario {
  fx: WorkItemFixture;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  /** Plain workspace member — a viewable mention target on the open project. */
  member: User;
}

async function buildScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Mentioned task' });
  const member = await usersService.createUser({
    email: 'mentionee@example.com',
    password: 'hunter2hunter2',
    name: 'Mention Target',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return {
    fx,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: 'Mentioned task',
    member,
  };
}

/** A real comment by the owner mentioning `mentioned`, via the real service. */
async function addMentioningComment(s: Scenario, mentioned: User) {
  return commentsService.addComment(
    s.issueId,
    { bodyMd: `Heads up ${mentionToken(mentioned)} — **please** review.` },
    s.fx.ctx,
  );
}

/** Read the notification rows for a recipient (tests may use db directly). */
function notificationsFor(recipientUserId: string) {
  return adminDb.notification.findMany({
    where: { recipientUserId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('notificationFanInService.fanIn — comment mentions', () => {
  it('writes one direct/mentioned row per viewable recipient with the denormalized data payload', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([s.member.id]);
    const rows = await notificationsFor(s.member.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.type).toBe('mentioned');
    expect(row.category).toBe('direct');
    expect(row.workspaceId).toBe(s.fx.workspaceId);
    expect(row.workItemId).toBe(s.issueId);
    expect(row.actorId).toBe(s.fx.ownerId);
    expect(row.readAt).toBeNull();
    expect(row.dedupeKey).toBe(`mentioned:${comment.id}`);
    const data = row.data as unknown as NotificationData;
    expect(data.kind).toBe('mentioned');
    if (data.kind !== 'mentioned') throw new Error('expected a mentioned payload');
    expect(data.source).toBe('comment');
    expect(data.issueKey).toBe(s.issueIdentifier);
    expect(data.title).toBe(s.issueTitle);
    // Plain-text excerpt: the mention token reads @Name, Markdown stripped, the
    // raw `mention:` scheme never leaks.
    expect(data.excerpt).toBe('Heads up @Mention Target — please review.');
  });

  it('excludes the author and dedupes repeated ids', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.fx.ownerId, s.member.id, s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([s.member.id]);
    expect(await notificationsFor(s.member.id)).toHaveLength(1);
    // The author never gets a row about their own mention.
    expect(await notificationsFor(s.fx.ownerId)).toHaveLength(0);
  });

  it('is idempotent: replaying the same event never double-writes a row', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    const event: WorkItemCommentCreatedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    };

    await notificationFanInService.fanIn('work-item/comment.created', event);
    const replay = await notificationFanInService.fanIn('work-item/comment.created', event);

    // The replay still reports the recipient (validation passed), but the
    // (dedupeKey, recipientUserId) unique + skipDuplicates means no new row.
    expect(replay.writtenUserIds).toEqual([s.member.id]);
    expect(await notificationsFor(s.member.id)).toHaveLength(1);
  });

  it('re-validates view access: a recipient who can no longer view the issue gets no row', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);

    // Going private adds nobody (Story MOTIR-6169): the member who keeps their
    // view is ADDED explicitly; a user added to the workspace AFTER the flip has
    // no project access — "lost view access between write and fan-in".
    await projectMembersService.setAccessMode({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      mode: 'members',
    });
    await adminDb.projectMembership.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
        userId: s.member.id,
      },
    });
    const lateMember = await usersService.createUser({
      email: 'late@example.com',
      password: 'hunter2hunter2',
      name: 'Late Member',
    });
    await workspacesService.addMember({ userId: lateMember.id, workspaceId: s.fx.workspaceId });

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [lateMember.id, s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([s.member.id]);
    expect(await notificationsFor(lateMember.id)).toHaveLength(0);
    expect(await notificationsFor(s.member.id)).toHaveLength(1);
  });

  // MOTIR-2867. The fan-in's WRITE was a bare `db.$transaction`, so under
  // `motir_app` every row it built was refused by `notification`'s
  // `workspace_id = current_setting('app.workspace_id', true)` WITH CHECK — 17
  // of them across this file and the journey suite. The failure is invisible
  // from outside: the mutation that fired the event succeeds, the recipient
  // simply never hears.
  //
  // The read-back deliberately goes through `notificationsService.listNotifications`
  // AS THE RECIPIENT, not through `adminDb` (which every other test here uses,
  // legitimately, to assert row shape). An owner-client read proves the row
  // exists; only a bound read as the recipient proves the application could
  // write it AND see it. Red on `origin/main` under `TEST_DB_APP_ROLE=1`.
  it('writes rows the RECIPIENT can then read back through the app (bound both ways)', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemCommentCreatedData);
    expect(result.writtenUserIds).toEqual([s.member.id]);

    const page = await notificationsService.listNotifications(
      {},
      { userId: s.member.id, workspaceId: s.fx.workspaceId },
    );
    expect(page.totalCount).toBe(1);
    expect(page.unreadCount).toBe(1);
    expect(page.notifications[0]!.type).toBe('mentioned');
    expect(page.notifications[0]!.workItemId).toBe(s.issueId);
  });

  // The mirror of the read-back above: binding the write to the event's
  // workspace must not become a way to write a row FOR someone outside it. A
  // user who is not in this workspace at all is filtered by the capability gate
  // before the write ever forms, and this asserts that end to end rather than
  // trusting the gate — a change that drops it is red here.
  it('never writes a row for a recipient outside the event workspace', async () => {
    const s = await buildScenario();
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    const comment = await addMentioningComment(s, s.member);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [outsider.id, s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([s.member.id]);
    expect(await notificationsFor(outsider.id)).toHaveLength(0);
  });

  it('no-ops on a mention-free comment event (every comment fires the event)', async () => {
    const s = await buildScenario();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'No tags.' }, s.fx.ctx);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });

  it('resolves to zero rows when the comment was hard-deleted since the write', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    await commentsService.deleteComment(comment.id, s.fx.ctx);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });

  it('resolves to zero rows when the work item is gone or belongs to another workspace', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    const base = {
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    };

    const missing = await notificationFanInService.fanIn('work-item/comment.created', {
      ...base,
      workspaceId: s.fx.workspaceId,
      workItemId: 'no-such-item',
    } satisfies WorkItemCommentCreatedData);
    expect(missing.writtenUserIds).toEqual([]);

    const crossWorkspace = await notificationFanInService.fanIn('work-item/comment.created', {
      ...base,
      workspaceId: 'some-other-workspace',
      workItemId: s.issueId,
    } satisfies WorkItemCommentCreatedData);
    expect(crossWorkspace.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });

  it('resolves to zero rows when the project vanished (ProjectNotFoundError)', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    vi.spyOn(projectAccessService, 'getCapabilities').mockRejectedValue(
      new ProjectNotFoundError(s.fx.projectId),
    );

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });

  it('rethrows an unexpected access-check error (only ProjectNotFoundError is vanish-tolerated)', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    vi.spyOn(projectAccessService, 'getCapabilities').mockRejectedValue(new Error('db down'));

    await expect(
      notificationFanInService.fanIn('work-item/comment.created', {
        workspaceId: s.fx.workspaceId,
        workItemId: s.issueId,
        commentId: comment.id,
        authorId: s.fx.ownerId,
        mentionedUserIds: [s.member.id],
      } satisfies WorkItemCommentCreatedData),
    ).rejects.toThrow('db down');
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });
});

describe('notificationFanInService.fanIn — description mentions', () => {
  it('writes a description-sourced row scoped to the revision id', async () => {
    const s = await buildScenario();
    await adminDb.$transaction((tx) =>
      workItemRepository.update(
        s.issueId,
        { descriptionMd: `Owned by ${mentionToken(s.member)}.` },
        tx,
      ),
    );

    const result = await notificationFanInService.fanIn('work-item/mentioned', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      revisionId: 'rev-123',
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemMentionedData);

    expect(result.writtenUserIds).toEqual([s.member.id]);
    const rows = await notificationsFor(s.member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe('mentioned:rev-123');
    const data = rows[0]!.data as unknown as NotificationData;
    if (data.kind !== 'mentioned') throw new Error('expected a mentioned payload');
    expect(data.source).toBe('description');
    expect(data.excerpt).toBe('Owned by @Mention Target.');
  });

  it('no-ops on a mention-free description event', async () => {
    const s = await buildScenario();
    const result = await notificationFanInService.fanIn('work-item/mentioned', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      revisionId: 'rev-empty',
      authorId: s.fx.ownerId,
      mentionedUserIds: [],
    } satisfies WorkItemMentionedData);
    expect(result.writtenUserIds).toEqual([]);
  });
});

describe('notificationFanInService.fanIn — preference gate', () => {
  it('writes no row when the in-app channel is disabled for the event type', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);
    const gate = vi
      .spyOn(notificationPreferencesService, 'isChannelEnabled')
      .mockResolvedValue(false);

    const result = await notificationFanInService.fanIn('work-item/comment.created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    } satisfies WorkItemCommentCreatedData);

    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
    // The gate was consulted for the in_app channel, per event type.
    expect(gate).toHaveBeenCalledWith(s.member.id, 'mentioned', 'in_app');
  });
});

describe('notificationFanInService.fanIn — registry extensibility (the 5.4/6.6 seam)', () => {
  it('a SYNTHETIC event type fans in through the same core with only a registry entry', async () => {
    const s = await buildScenario();
    // A synthetic descriptor — the shape Story 5.4 (`transitioned`/`watching`)
    // and 6.6 add LATER. No import of, or dependency on, 5.4 / 6.6 code: this
    // proves the seam carries no forward dep.
    const syntheticRegistry: NotificationFanInRegistry = {
      ...NOTIFICATION_FAN_IN_REGISTRY,
      'synthetic/watched.thing': {
        notificationType: 'synthetic',
        category: 'watching',
        async buildPlan() {
          return {
            actorId: s.fx.ownerId,
            candidateUserIds: [s.member.id],
            dedupeSourceId: 'syn-1',
            data: {
              kind: 'mentioned',
              source: 'description',
              issueKey: s.issueIdentifier,
              title: s.issueTitle,
              excerpt: null,
            } satisfies NotificationData,
          };
        },
      },
    };

    const result = await notificationFanInService.fanIn(
      'synthetic/watched.thing',
      { workspaceId: s.fx.workspaceId, workItemId: s.issueId },
      syntheticRegistry,
    );

    expect(result.writtenUserIds).toEqual([s.member.id]);
    const rows = await notificationsFor(s.member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('synthetic');
    expect(rows[0]!.category).toBe('watching');
    expect(rows[0]!.dedupeKey).toBe('synthetic:syn-1');
  });

  it('an unregistered event name is a clean no-op, not an error', async () => {
    const s = await buildScenario();
    const result = await notificationFanInService.fanIn('work-item/created', {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
    });
    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsFor(s.member.id)).toHaveLength(0);
  });
});

describe('notificationFanIn jobs — in-process runs', () => {
  it('registers all three consumers in the job registry', () => {
    expect(jobDefinitions).toContain(notificationFanInOnCommentCreated);
    expect(jobDefinitions).toContain(notificationFanInOnWorkItemMentioned);
    expect(jobDefinitions).toContain(notificationFanInOnTransitioned);
  });

  it('registers the page-comment consumer on page/comment.created (MOTIR-10924)', () => {
    expect(jobDefinitions).toContain(pageCommentNotificationFanIn);
    expect(pageCommentNotificationFanIn).toMatchObject({
      id: 'notification-fan-in/page-comment.created',
      trigger: 'page/comment.created',
      retryPolicy: 'transient',
      idempotency: undefined,
    });
  });

  it('drives the comment-created event end-to-end: rows written, job_run recorded', async () => {
    const s = await buildScenario();
    const comment = await addMentioningComment(s, s.member);

    const data: WorkItemCommentCreatedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    };
    const engine = new JobTestEngine({
      function: notificationFanInOnCommentCreated,
      events: [{ name: 'work-item/comment.created', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ writtenUserIds: [s.member.id] });
    expect(await notificationsFor(s.member.id)).toHaveLength(1);

    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'notification-fan-in/comment.created' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(s.fx.workspaceId);
  });

  it('drives the description-mentioned event end-to-end', async () => {
    const s = await buildScenario();
    await adminDb.$transaction((tx) =>
      workItemRepository.update(s.issueId, { descriptionMd: `cc ${mentionToken(s.member)}` }, tx),
    );

    const data: WorkItemMentionedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      revisionId: 'rev-e2e',
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    };
    const engine = new JobTestEngine({
      function: notificationFanInOnWorkItemMentioned,
      events: [{ name: 'work-item/mentioned', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ writtenUserIds: [s.member.id] });
    expect(await notificationsFor(s.member.id)).toHaveLength(1);
  });

  it('drives the transitioned event end-to-end: a watching row for each watcher, job_run recorded (5.7.10)', async () => {
    const s = await buildScenario();
    // The member watches the issue; the actor (owner) is excluded by the core.
    await watchersService.watch(s.issueId, { userId: s.member.id, workspaceId: s.fx.workspaceId });

    const data: WorkItemTransitionedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
      revisionId: 'rev-transition-e2e',
    };
    const engine = new JobTestEngine({
      function: notificationFanInOnTransitioned,
      events: [{ name: 'work-item/transitioned', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ writtenUserIds: [s.member.id] });
    const rows = await notificationsFor(s.member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('transitioned');
    expect(rows[0]!.category).toBe('watching');
    expect(rows[0]!.dedupeKey).toBe('transitioned:rev-transition-e2e');

    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'notification-fan-in/transitioned' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(s.fx.workspaceId);
  });
});
