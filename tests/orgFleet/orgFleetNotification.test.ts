import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { toNotificationDto } from '@/lib/mappers/notificationMappers';
import { adminDb } from '../helpers/adminDb';
import { clock, fx, otherMember, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// THE OWNER OF A HIBERNATED AGENT IS TOLD (MOTIR-10368 · Story MOTIR-10363,
// `agent-instances.md` §8 AMENDMENT 8), against a real Postgres and the real
// hibernate (the instance harness's fake persistent fleet). One Hibernate or one
// Stop everything by an org owner/admin writes ONE in-app notification to each
// OTHER member whose agent it stopped: actor = the admin, data = the agent's name
// and the time. Nothing reaches the admin, a resting or moving agent, or a
// retry; a refused or failed write never costs the hibernation.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

const { orgFleetStopService } = await import('@/lib/services/orgFleetStopService');
const { orgFleetNotificationService } = await import('@/lib/services/orgFleetNotificationService');
const { notificationFanInService } = await import('@/lib/services/notificationFanInService');
const { notificationPreferencesService } =
  await import('@/lib/services/notificationPreferencesService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');

const TYPE = 'agent_hibernated_by_admin';

const actor = () => ({ organizationId: fx.workspace.organizationId, actorUserId: fx.ownerId });

async function agentOf(owner: { userId: string; workspaceId: string }, name: string) {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, owner);
  expect(dto.state).toBe('running');
  return dto.id;
}

const notifications = () =>
  adminDb.notification.findMany({ where: { type: TYPE }, orderBy: { createdAt: 'asc' } });

const FORBIDDEN_KEYS = [
  'organizationId',
  'awsAccountId',
  'shardId',
  'fleetShardId',
  'credentialRef',
  'machineId',
  'volumeId',
  'region',
  'flyApp',
  'app',
];

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
}

beforeEach(setUpHarness);
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('hibernateAgent → the owner is told', () => {
  it('another member’s agent: ONE notification to its owner, actor = the admin, name + time', async () => {
    const other = await otherMember();
    const id = await agentOf(other, 'theirs');
    const outcome = await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now());
    expect(outcome.kind).toBe('hibernated');

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientUserId: other.userId,
      actorId: fx.ownerId,
      workspaceId: fx.workspaceId,
      workItemId: null,
      category: 'direct',
      dedupeKey: `${TYPE}:${id}:${clock.now().toISOString()}`,
      data: { kind: TYPE, agentName: 'theirs', hibernatedAt: clock.now().toISOString() },
    });
    // Nobody else holds one — not the admin who did it.
    expect(await adminDb.notification.count({ where: { recipientUserId: fx.ownerId } })).toBe(0);
  });

  it('the admin’s own agent: hibernated, nobody told', async () => {
    const id = await agentOf({ userId: fx.ownerId, workspaceId: fx.workspaceId }, 'mine');
    expect((await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now())).kind).toBe(
      'hibernated',
    );
    expect(await notifications()).toHaveLength(0);
  });

  it.each([
    ['hibernated', 'already_resting'],
    ['starting', 'in_motion'],
  ] as const)('an agent %s answers %s and writes nothing', async (state, kind) => {
    const other = await otherMember();
    const id = await agentOf(other, 'resting');
    await adminDb.agentInstance.update({ where: { id }, data: { state } });
    expect((await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now())).kind).toBe(
      kind,
    );
    expect(await notifications()).toHaveLength(0);
  });

  it('an agent another path moved first answers in motion and writes nothing', async () => {
    const other = await otherMember();
    const id = await agentOf(other, 'raced');
    vi.spyOn(lifecycle, 'beginHibernate').mockResolvedValueOnce(false);
    expect((await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now())).kind).toBe(
      'in_motion',
    );
    expect(await notifications()).toHaveLength(0);
  });

  it('the owner turned the type off in-app: hibernated all the same, nothing written', async () => {
    const other = await otherMember();
    await notificationPreferencesService.setPreference(other.userId, {
      eventType: TYPE,
      channel: 'in_app',
      enabled: false,
    });
    const id = await agentOf(other, 'quiet');
    const outcome = await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now());
    expect(outcome.kind).toBe('hibernated');
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
      'hibernated',
    );
    expect(await notifications()).toHaveLength(0);
  });

  it('a write that throws never fails or reverses the hibernation, and is logged', async () => {
    const other = await otherMember();
    const id = await agentOf(other, 'unlucky');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(notificationFanInService, 'notifyProjectEvent').mockRejectedValueOnce(
      new Error('db down'),
    );
    const outcome = await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now());
    expect(outcome).toMatchObject({ kind: 'hibernated', instanceId: id });
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
      'hibernated',
    );
    expect(errors).toHaveBeenCalledWith(
      '[orgFleetNotificationService] could not notify the owner of a hibernated agent',
      { instanceId: id, error: 'Error' },
    );
    expect(await notifications()).toHaveLength(0);
  });
});

describe('stopEverything → each other owner is told once', () => {
  it('one per hibernated agent of another member; none for the admin’s own or a resting one', async () => {
    const other = await otherMember();
    const third = await otherMember();
    const theirsA = await agentOf(other, 'other-a');
    const theirsB = await agentOf(other, 'other-b');
    const thirds = await agentOf(third, 'third-a');
    await agentOf({ userId: fx.ownerId, workspaceId: fx.workspaceId }, 'admin-own');
    const resting = await agentOf(third, 'third-resting');
    await adminDb.agentInstance.update({ where: { id: resting }, data: { state: 'hibernated' } });

    const result = await orgFleetStopService.stopEverything(actor(), () => clock.now());
    expect(result.agentsHibernated).toBe(4);

    const rows = await notifications();
    expect(
      rows.map((r) => [r.recipientUserId, (r.data as { agentName: string }).agentName]),
    ).toEqual(
      expect.arrayContaining([
        [other.userId, 'other-a'],
        [other.userId, 'other-b'],
        [third.userId, 'third-a'],
      ]),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.actorId).toBe(fx.ownerId);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [theirsA, theirsB, thirds].map((id) => `${TYPE}:${id}:${clock.now().toISOString()}`).sort(),
    );
  });

  it('an agent that failed to stop is not notified', async () => {
    const other = await otherMember();
    const ok = await agentOf(other, 'ok');
    const broken = await agentOf(other, 'broken');
    const begin = lifecycle.beginHibernate.bind(lifecycle);
    vi.spyOn(lifecycle, 'beginHibernate').mockImplementation(async (id, reason) => {
      if (id === broken) throw new Error('machine refused');
      return begin(id, reason);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await orgFleetStopService.stopEverything(actor(), () => clock.now());
    expect(result.agentsHibernated).toBe(1);
    expect(result.failures.agents).toBe(1);
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toContain(ok);
  });
});

describe('notifyOwnerOfAdminHibernate', () => {
  it('a repeated call for the same hibernation writes no second row; a later one does', async () => {
    const other = await otherMember();
    const instanceId = await agentOf(other, 'twice');
    const at = clock.now();
    const args = { instanceId, actorUserId: fx.ownerId, at };
    expect(await orgFleetNotificationService.notifyOwnerOfAdminHibernate(args)).toBe(true);
    await orgFleetNotificationService.notifyOwnerOfAdminHibernate(args);
    expect(await notifications()).toHaveLength(1);

    await orgFleetNotificationService.notifyOwnerOfAdminHibernate({
      ...args,
      at: new Date(at.getTime() + 60_000),
    });
    expect(await notifications()).toHaveLength(2);
  });

  it('an unknown instance writes nothing and answers false', async () => {
    expect(
      await orgFleetNotificationService.notifyOwnerOfAdminHibernate({
        instanceId: 'no-such-agent',
        actorUserId: fx.ownerId,
        at: clock.now(),
      }),
    ).toBe(false);
    expect(await notifications()).toHaveLength(0);
  });

  it('a non-Error throw is logged as UnknownError and answers false', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(notificationFanInService, 'notifyProjectEvent').mockRejectedValueOnce('nope');
    const other = await otherMember();
    const instanceId = await agentOf(other, 'odd');
    expect(
      await orgFleetNotificationService.notifyOwnerOfAdminHibernate({
        instanceId,
        actorUserId: fx.ownerId,
        at: clock.now(),
      }),
    ).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.any(String), {
      instanceId,
      error: 'UnknownError',
    });
  });
});

describe('the stored data and the mapped DTO carry names and a time only', () => {
  it('no organisation, account, shard, machine, volume, region or app id', async () => {
    const other = await otherMember();
    const id = await agentOf(other, 'shape');
    await orgFleetStopService.hibernateAgent(actor(), id, () => clock.now());
    const [row] = await notifications();
    expect(Object.keys(row!.data as object).sort()).toEqual(['agentName', 'hibernatedAt', 'kind']);

    const admin = (await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } })) as User;
    const dto = toNotificationDto(row!, new Map([[admin.id, admin]]));
    expect(dto.data).toEqual({
      kind: TYPE,
      agentName: 'shape',
      hibernatedAt: clock.now().toISOString(),
    });
    expect(dto.actor).toMatchObject({ id: admin.id, name: admin.name });

    const instance = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    for (const answer of [row!.data, dto]) {
      const keys = keysOf(JSON.parse(JSON.stringify(answer)));
      for (const key of FORBIDDEN_KEYS) expect(keys.has(key), `key ${key}`).toBe(false);
      const text = JSON.stringify(answer);
      expect(text).not.toContain(fx.workspace.organizationId);
      for (const secret of [instance.machineId, instance.volumeId, instance.flyApp]) {
        if (secret) expect(text).not.toContain(secret);
      }
    }

    // A deleted admin degrades to no actor — the drawer's shipped fallback.
    expect(toNotificationDto(row!, new Map()).actor).toBeNull();
    // A malformed stored payload reads as empty strings, never a crash.
    expect(toNotificationDto({ ...row!, data: { kind: TYPE } }, new Map()).data).toEqual({
      kind: TYPE,
      agentName: '',
      hibernatedAt: '',
    });
  });
});
