import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE AGENT HOSTING SETTING (MOTIR-9503) against a real Postgres: the switch row
// and the hash-chained audit trail are real. And the READER placement calls —
// `fleetKindOnPool('agent_instance')`, wired by `lib/ciFleet/fleetKindSwitches.ts`
// — reads the same row on every call, so a flip moves the next placement with
// no restart.

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const { agentHostingSettingService: service } =
  await import('@/lib/services/agentHostingSettingService');
const { agentHosterOnPool } = await import('@/lib/ciFleet/fleetKindSwitches');
const { fleetKindOnPool } = await import('@/lib/ciFleet/shardTargets');

let superadmin: PlatformPrincipal;

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { startsWith: 'fleet.agent_hosting.' } },
    orderBy: { seq: 'asc' },
  });
}

async function storedRow() {
  return adminDb.platformFleetKindSwitch.findUnique({ where: { fleetKind: 'agent_instance' } });
}

beforeEach(async () => {
  await truncateAuthTables();
  superadmin = await principal('superadmin');
  currentPrincipal = superadmin;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
});

describe('who may read and flip', () => {
  it.each(['support', 'operator'] as const)(
    'a %s is refused on read and write, and nothing is written',
    async (role) => {
      currentPrincipal = await principal(role);
      await expect(service.getState(currentPrincipal)).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      await expect(service.setOnPool(currentPrincipal, true, 'move agents')).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      expect(await storedRow()).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    },
  );
});

describe('getState', () => {
  it('no row ⇒ off (Fly), never changed', async () => {
    expect(await service.getState(superadmin)).toEqual({
      onPool: false,
      updatedBy: null,
      updatedAt: null,
      lastReason: null,
    });
  });

  it('a stored row answers its state, who changed it, when and why', async () => {
    await service.setOnPool(superadmin, true, 'hoster pool is ready');
    const state = await service.getState(superadmin);
    expect(state.onPool).toBe(true);
    expect(state.updatedBy).toEqual({ userId: superadmin.userId, email: superadmin.email });
    expect(state.lastReason).toBe('hoster pool is ready');
    expect(state.updatedAt).not.toBeNull();
  });

  it('a stored row nobody is recorded against names no updater', async () => {
    await adminDb.platformFleetKindSwitch.create({
      data: { fleetKind: 'agent_instance', onPool: true, lastReason: 'seeded' },
    });
    const state = await service.getState(superadmin);
    expect(state.onPool).toBe(true);
    expect(state.updatedBy).toBeNull();
  });
});

describe('setOnPool', () => {
  it.each(['', '   ', undefined as unknown as string])(
    'a blank reason (%j) is refused before any transaction',
    async (reason) => {
      await expect(service.setOnPool(superadmin, true, reason)).rejects.toBeInstanceOf(
        MissingAuditReasonError,
      );
      expect(await storedRow()).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('ON stores the switch and writes one enable row with the kind, from/to and the reason', async () => {
    const flip = await service.setOnPool(superadmin, true, '  hoster pool is ready  ');
    expect(flip.outcome).toBe('changed');
    expect(flip.state.onPool).toBe(true);
    expect(flip.state.lastReason).toBe('hoster pool is ready');
    expect((await storedRow())?.onPool).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'fleet.agent_hosting.enable',
      targetKind: 'platform',
      targetId: 'agent_instance',
      reason: 'hoster pool is ready',
      actorUserId: superadmin.userId,
      metadata: { fleetKind: 'agent_instance', from: false, to: true },
    });
  });

  it('OFF after ON stores Fly again and writes a disable row', async () => {
    await service.setOnPool(superadmin, true, 'on');
    const flip = await service.setOnPool(superadmin, false, 'back to Fly');
    expect(flip.outcome).toBe('changed');
    expect((await storedRow())?.onPool).toBe(false);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      'fleet.agent_hosting.enable',
      'fleet.agent_hosting.disable',
    ]);
  });

  it('OFF when never written ⇒ unchanged, no row created, no audit row', async () => {
    const flip = await service.setOnPool(superadmin, false, 'make sure');
    expect(flip).toEqual({
      outcome: 'unchanged',
      state: { onPool: false, updatedBy: null, updatedAt: null, lastReason: null },
    });
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a repeat ON ⇒ unchanged, the first flip’s reason kept, one audit row only', async () => {
    await service.setOnPool(superadmin, true, 'first');
    const again = await service.setOnPool(superadmin, true, 'second');
    expect(again.outcome).toBe('unchanged');
    expect(again.state.lastReason).toBe('first');
    expect(await auditRows()).toHaveLength(1);
  });

  it('two racing ON flips ⇒ one changed, one unchanged, one audit row', async () => {
    const outcomes = await Promise.all([
      service.setOnPool(superadmin, true, 'first'),
      service.setOnPool(superadmin, true, 'second'),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['changed', 'unchanged']);
    expect(await auditRows()).toHaveLength(1);
    expect((await storedRow())?.onPool).toBe(true);
  });

  it('a failure inside the transaction is re-thrown and writes nothing', async () => {
    const { platformFleetKindSwitchRepository } =
      await import('@/lib/repositories/platformFleetKindSwitchRepository');
    vi.spyOn(platformFleetKindSwitchRepository, 'upsert').mockRejectedValueOnce(new Error('boom'));
    await expect(service.setOnPool(superadmin, true, 'on')).rejects.toThrow('boom');
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('the reader placement calls', () => {
  it('reads Fly with no row, and follows every flip on the next read — no restart, no cache', async () => {
    expect(await agentHosterOnPool()).toBe(false);
    expect(await fleetKindOnPool('agent_instance')).toBe(false);

    await service.setOnPool(superadmin, true, 'on');
    expect(await agentHosterOnPool()).toBe(true);
    expect(await fleetKindOnPool('agent_instance')).toBe(true);

    await service.setOnPool(superadmin, false, 'off');
    expect(await fleetKindOnPool('agent_instance')).toBe(false);
  });

  it('touches no other kind: the switch on leaves the CI runner and indexer on Fly', async () => {
    await service.setOnPool(superadmin, true, 'on');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    expect(await fleetKindOnPool('code_graph_index')).toBe(false);
  });
});

describe('the table', () => {
  it('holds one row per fleet kind', async () => {
    await service.setOnPool(superadmin, true, 'on');
    await expect(
      adminDb.platformFleetKindSwitch.create({ data: { fleetKind: 'agent_instance' } }),
    ).rejects.toThrow();
  });

  it('keeps the switch when the user recorded against it is deleted', async () => {
    // Seeded directly: a real flip also writes an audit row, whose actor key
    // (correctly) refuses the delete.
    const flipper = await createTestUser();
    await adminDb.platformFleetKindSwitch.create({
      data: { fleetKind: 'agent_instance', onPool: true, updatedByUserId: flipper.id },
    });
    await adminDb.user.delete({ where: { id: flipper.id } });
    const row = await storedRow();
    expect(row?.onPool).toBe(true);
    expect(row?.updatedByUserId).toBeNull();
  });
});
