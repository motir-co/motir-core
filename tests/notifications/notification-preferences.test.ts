import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { notificationPreferenceRepository } from '@/lib/repositories/notificationPreferenceRepository';
import {
  UnknownNotificationChannelError,
  UnknownNotificationEventTypeError,
} from '@/lib/notifications/preferenceErrors';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// Notification preferences (Story 5.7 · Subtask 5.7.6). Real Postgres, no DB
// mocks (the standing rule); the one stubbed seam is the Inngest client's
// send() (captureEmailEvents) for the channel-gate fan-out assertions. Covers:
//   1. the resolver/service — getMatrix defaults, setPreference upsert +
//      validation, isChannelEnabled, the batch filterChannelEnabled;
//   2. the repository leaf (empty-input guard, cascade);
//   3. the CHANNEL GATE wired into the DONE 5.1.6 email job — toggling email
//      off suppresses the mention mail, in_app off leaves email untouched
//      (the single resolver drives both channels independently).

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
});

async function makeUser(email: string): Promise<User> {
  return usersService.createUser({ email, password: 'hunter2hunter2', name: `U ${email}` });
}

describe('notificationPreferencesService.getMatrix', () => {
  it('resolves every cell to the documented default for an untouched user (zero rows)', async () => {
    const user = await makeUser('matrix@example.com');
    const matrix = await notificationPreferencesService.getMatrix(user.id);

    expect(matrix.channels).toEqual(['email', 'in_app']);
    // ⚠️ ORDER IS THE ASSERTION, not just membership: the matrix renders
    // `NOTIFICATION_PREFERENCE_EVENT_TYPES` in array order, so a new member is
    // APPENDED and never sorted in — the four rows above keep the positions users
    // have learned (`design/notifications/design-notes.md`, the ACCESS-REFUSED
    // row's placement).
    expect(matrix.events.map((e) => e.eventType)).toEqual([
      'mentioned',
      'commented',
      'assigned',
      'transitioned',
      'code_access_refused',
      // MOTIR-10340 — a review waiting for the person's own agent, appended last.
      'review_to_run',
    ]);
    // Direct/mention events default ON for both channels — INCLUDING the
    // access-refused row, and its email arm is a decision rather than an
    // inherited default: that event exists because GITHUB's invitation email
    // never left the building, so Motir's own email is a second, independent
    // carrier and defaulting it off would re-create the silence the row ends.
    for (const event of matrix.events) {
      expect(event.channels.email).toBe(true);
      expect(event.channels.in_app).toBe(true);
    }
    // Every row is settable now — the Story 5.4 `transitioned` seam flipped
    // settable once both its channels became real (5.7.10 in_app + 5.7.11 email).
    for (const event of matrix.events) {
      expect(event.settable).toBe(true);
    }
    // No rows were written just by reading.
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(0);
  });

  it('reflects a stored toggle while leaving untouched cells on their default', async () => {
    const user = await makeUser('stored@example.com');
    await notificationPreferencesService.setPreference(user.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });

    const matrix = await notificationPreferencesService.getMatrix(user.id);
    const mentioned = matrix.events.find((e) => e.eventType === 'mentioned')!;
    expect(mentioned.channels.email).toBe(false); // stored
    expect(mentioned.channels.in_app).toBe(true); // still default
    const assigned = matrix.events.find((e) => e.eventType === 'assigned')!;
    expect(assigned.channels.email).toBe(true); // untouched row
  });
});

describe('notificationPreferencesService.setPreference', () => {
  it('inserts on first toggle then updates (upsert), returning the resolved cell', async () => {
    const user = await makeUser('upsert@example.com');

    const off = await notificationPreferencesService.setPreference(user.id, {
      eventType: 'assigned',
      channel: 'in_app',
      enabled: false,
    });
    expect(off).toEqual({ eventType: 'assigned', channel: 'in_app', enabled: false });
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(1);

    const on = await notificationPreferencesService.setPreference(user.id, {
      eventType: 'assigned',
      channel: 'in_app',
      enabled: true,
    });
    expect(on.enabled).toBe(true);
    // Still ONE row — an update, not a second insert.
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(1);
  });

  it('rejects an unknown channel and an unknown event type', async () => {
    const user = await makeUser('validate@example.com');

    await expect(
      notificationPreferencesService.setPreference(user.id, {
        eventType: 'mentioned',
        channel: 'sms',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UnknownNotificationChannelError);

    await expect(
      notificationPreferencesService.setPreference(user.id, {
        eventType: 'made_coffee',
        channel: 'email',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UnknownNotificationEventTypeError);

    // No rejection wrote a row.
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(0);
  });

  it('persists a `transitioned` toggle — the Story 5.4 seam is now settable (5.7.12)', async () => {
    const user = await makeUser('transitioned@example.com');

    // Was rejected with NotificationEventTypeNotSettableError until 5.7.10 +
    // 5.7.11 made both channels real; now it upserts like any other row.
    const cell = await notificationPreferencesService.setPreference(user.id, {
      eventType: 'transitioned',
      channel: 'email',
      enabled: false,
    });
    expect(cell).toEqual({ eventType: 'transitioned', channel: 'email', enabled: false });
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(1);

    // The gate now reflects the stored value; the untouched in_app cell stays on.
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'transitioned', 'email'),
    ).toBe(false);
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'transitioned', 'in_app'),
    ).toBe(true);
  });
});

describe('notificationPreferencesService resolver (isChannelEnabled / filterChannelEnabled)', () => {
  it('isChannelEnabled returns the default when unset and the stored value when set', async () => {
    const user = await makeUser('resolve@example.com');
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'mentioned', 'email'),
    ).toBe(true);
    await notificationPreferencesService.setPreference(user.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'mentioned', 'email'),
    ).toBe(false);
    // A different channel on the same event is unaffected (still default).
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'mentioned', 'in_app'),
    ).toBe(true);
  });

  it('fails open for an unmodelled event type — never silently suppresses', async () => {
    const user = await makeUser('failopen@example.com');
    // An event Motir has no preference row/meta for resolves to ENABLED.
    expect(
      await notificationPreferencesService.isChannelEnabled(user.id, 'made_coffee', 'email'),
    ).toBe(true);
  });

  it('filterChannelEnabled mixes stored + default, preserves order, and short-circuits on empty input', async () => {
    const a = await makeUser('a@example.com');
    const b = await makeUser('b@example.com');
    const c = await makeUser('c@example.com');
    // b opts out of email mentions; a and c keep the default (on).
    await notificationPreferencesService.setPreference(b.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });

    const enabled = await notificationPreferencesService.filterChannelEnabled(
      [a.id, b.id, c.id],
      'mentioned',
      'email',
    );
    expect(enabled).toEqual([a.id, c.id]); // b dropped, order preserved

    expect(
      await notificationPreferencesService.filterChannelEnabled([], 'mentioned', 'email'),
    ).toEqual([]);
  });
});

describe('notificationPreferenceRepository', () => {
  it('findByUsersForChannel short-circuits empty input to [] (no DB round-trip)', async () => {
    expect(
      await notificationPreferenceRepository.findByUsersForChannel([], 'mentioned', 'email'),
    ).toEqual([]);
  });

  it('cascades: deleting the user removes their preference rows', async () => {
    const user = await makeUser('cascade@example.com');
    await notificationPreferencesService.setPreference(user.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(1);

    await adminDb.user.delete({ where: { id: user.id } });
    expect(await notificationPreferenceRepository.findByUser(user.id)).toHaveLength(0);
  });
});

// ── The channel gate, wired into the DONE 5.1.6 email job ────────────────────

interface GateScenario {
  fx: WorkItemFixture;
  issueId: string;
  member: User;
}

async function buildGateScenario(): Promise<GateScenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Gated mention' });
  const member = await makeUser('member@example.com');
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, issueId: issue.id, member };
}

async function fanOutMention(s: GateScenario) {
  const comment = await commentsService.addComment(
    s.issueId,
    { bodyMd: `Heads up [@${s.member.name}](mention:${s.member.id})` },
    s.fx.ctx,
  );
  return mentionNotificationsService.fanOut({
    workspaceId: s.fx.workspaceId,
    workItemId: s.issueId,
    authorId: s.fx.ownerId,
    mentionedUserIds: [s.member.id],
    source: { kind: 'comment', commentId: comment.id },
  });
}

describe('mention email fan-out honours the notification-preference channel gate (5.7.6 → 5.1.6)', () => {
  it('sends by default, and stops the mail when the recipient turns email off for mentions', async () => {
    const s = await buildGateScenario();

    // Default (no preference row): the mention email is enqueued.
    const cap1 = captureEmailEvents();
    const before = await fanOutMention(s);
    expect(before.notifiedUserIds).toEqual([s.member.id]);
    expect(cap1.events.some((e) => e.data.to === 'member@example.com')).toBe(true);
    cap1.restore();

    // Recipient turns OFF the email channel for mentions.
    await notificationPreferencesService.setPreference(s.member.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });

    const cap2 = captureEmailEvents();
    const after = await fanOutMention(s);
    expect(after.notifiedUserIds).toEqual([]); // gated out at the send decision
    expect(cap2.events.some((e) => e.data.to === 'member@example.com')).toBe(false);
    cap2.restore();
  });

  it('is channel-independent: turning IN-APP off leaves the email mention untouched', async () => {
    const s = await buildGateScenario();
    await notificationPreferencesService.setPreference(s.member.id, {
      eventType: 'mentioned',
      channel: 'in_app',
      enabled: false,
    });

    const cap = captureEmailEvents();
    const result = await fanOutMention(s);
    expect(result.notifiedUserIds).toEqual([s.member.id]); // email still sends
    expect(cap.events.some((e) => e.data.to === 'member@example.com')).toBe(true);
    cap.restore();
  });
});
