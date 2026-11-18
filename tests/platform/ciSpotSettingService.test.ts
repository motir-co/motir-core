import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import {
  CI_SPOT_ALLOWED_INSTANCE_TYPES,
  CI_SPOT_DEFAULT_INSTANCE_TYPES,
  isCiSpotInstanceType,
} from '@/lib/ciFleet/ciSpotInstanceTypes';
import { InvalidCiSpotInstanceTypesError } from '@/lib/ciFleet/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CI SPOT SETTING (MOTIR-11725) against a real Postgres: the setting row and
// the hash-chained audit trail are real. `read()` is the system read the CI runner
// launch makes (MOTIR-11716) — no principal, no session, no platform transaction —
// and it follows every save on the next call, with no restart and no cache.

// The ONE mock is the session (`getSession()`, no cookies in tests); the platform
// gate itself runs for real and reads the user's standing from the database.
let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const { ciSpotSettingService: service } = await import('@/lib/services/ciSpotSettingService');

const DEFAULTS = ['m6i.large', 'm7i.large', 'm5.large', 'm6a.large'];

let superadmin: PlatformPrincipal;

/** A staff user at `role`, signed in as the current session. */
async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return { userId: user.id, email: user.email, role };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.ci_spot.update' },
    orderBy: { seq: 'asc' },
  });
}

async function storedRow() {
  return adminDb.platformCiSpotSetting.findUnique({ where: { scope: 'ci_runner' } });
}

beforeEach(async () => {
  await adminDb.platformCiSpotSetting.deleteMany();
  await truncateAuthTables();
  superadmin = await principal('superadmin');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.platformCiSpotSetting.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
});

describe('the instance types', () => {
  it('the four defaults, in launch order, are all on the allowlist', () => {
    expect(CI_SPOT_DEFAULT_INSTANCE_TYPES).toEqual(DEFAULTS);
    for (const type of CI_SPOT_DEFAULT_INSTANCE_TYPES)
      expect(isCiSpotInstanceType(type)).toBe(true);
  });

  it('the allowlist is closed to the 2 vCPU / 8 GiB x86 `.large` class', () => {
    expect(new Set(CI_SPOT_ALLOWED_INSTANCE_TYPES).size).toBe(
      CI_SPOT_ALLOWED_INSTANCE_TYPES.length,
    );
    for (const type of CI_SPOT_ALLOWED_INSTANCE_TYPES) expect(type).toMatch(/^m[5-7][ai]?\.large$/);
    expect(isCiSpotInstanceType('m6g.large')).toBe(false);
    expect(isCiSpotInstanceType('m6i.xlarge')).toBe(false);
  });
});

describe('read() — the system read', () => {
  it('no row ⇒ off with the defaults, with no session and outside any platform transaction', async () => {
    currentSession = null;
    expect(await storedRow()).toBeNull();
    expect(await service.read()).toEqual({ enabled: false, instanceTypes: DEFAULTS });
  });

  it('follows a save on the very next call — no restart, no cache', async () => {
    expect((await service.read()).enabled).toBe(false);
    await service.save(
      superadmin,
      { enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] },
      'spot is safe now',
    );
    expect(await service.read()).toEqual({
      enabled: true,
      instanceTypes: ['m7i.large', 'm6i.large'],
    });
    await service.save(superadmin, { enabled: false, instanceTypes: ['m7i.large'] }, 'pause');
    expect(await service.read()).toEqual({ enabled: false, instanceTypes: ['m7i.large'] });
  });

  it('trusts a stored row as it stands — it neither re-validates nor drops entries', async () => {
    await adminDb.platformCiSpotSetting.create({
      data: { scope: 'ci_runner', enabled: true, instanceTypes: ['m5a.large', 'm7a.large'] },
    });
    expect(await service.read()).toEqual({
      enabled: true,
      instanceTypes: ['m5a.large', 'm7a.large'],
    });
  });
});

describe('who may read the state and save', () => {
  it.each(['support', 'operator'] as const)(
    'a %s is refused on getState and save, and nothing is written',
    async (role) => {
      const below = await principal(role);
      await expect(service.getState(below)).rejects.toBeInstanceOf(NotPlatformStaffError);
      await expect(
        service.save(below, { enabled: true, instanceTypes: DEFAULTS }, 'go'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(await storedRow()).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    },
  );
});

describe('getState', () => {
  it('no row ⇒ off, the defaults, isDefault, never changed', async () => {
    expect(await service.getState(superadmin)).toEqual({
      enabled: false,
      instanceTypes: DEFAULTS,
      isDefault: true,
      lastReason: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('a stored row answers its values, who saved it, when and why', async () => {
    await service.save(superadmin, { enabled: true, instanceTypes: ['m6a.large'] }, 'try AMD');
    const state = await service.getState(superadmin);
    expect(state).toMatchObject({
      enabled: true,
      instanceTypes: ['m6a.large'],
      isDefault: false,
      lastReason: 'try AMD',
      updatedBy: { userId: superadmin.userId, email: superadmin.email },
    });
    expect(state.updatedAt).not.toBeNull();
  });

  it('a stored row nobody is recorded against names no updater', async () => {
    await adminDb.platformCiSpotSetting.create({
      data: { scope: 'ci_runner', enabled: true, instanceTypes: DEFAULTS, lastReason: 'seeded' },
    });
    const state = await service.getState(superadmin);
    expect(state.isDefault).toBe(false);
    expect(state.updatedBy).toBeNull();
  });
});

describe('save', () => {
  it('stores the setting and writes ONE audit row with the target, the reason and from/to', async () => {
    const save = await service.save(
      superadmin,
      { enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] },
      '  interruption handling is live  ',
    );
    expect(save.outcome).toBe('changed');
    expect(save.state).toMatchObject({
      enabled: true,
      instanceTypes: ['m7i.large', 'm6i.large'],
      isDefault: false,
      lastReason: 'interruption handling is live',
    });
    const row = await storedRow();
    expect(row).toMatchObject({
      enabled: true,
      instanceTypes: ['m7i.large', 'm6i.large'],
      lastReason: 'interruption handling is live',
      updatedByUserId: superadmin.userId,
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'fleet.ci_spot.update',
      targetKind: 'platform',
      targetId: 'ci_runner',
      reason: 'interruption handling is live',
      actorUserId: superadmin.userId,
      metadata: {
        from: { enabled: false, instanceTypes: DEFAULTS },
        to: { enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] },
      },
    });
  });

  it('the same flag and the same ordered list ⇒ unchanged, neither row written', async () => {
    const save = await service.save(
      superadmin,
      { enabled: false, instanceTypes: [...DEFAULTS] },
      'make sure',
    );
    expect(save).toEqual({
      outcome: 'unchanged',
      state: {
        enabled: false,
        instanceTypes: DEFAULTS,
        isDefault: true,
        lastReason: null,
        updatedBy: null,
        updatedAt: null,
      },
    });
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a repeat of a stored value ⇒ unchanged, the first reason kept, one audit row only', async () => {
    await service.save(superadmin, { enabled: true, instanceTypes: ['m6i.large'] }, 'first');
    const again = await service.save(
      superadmin,
      { enabled: true, instanceTypes: ['m6i.large'] },
      'second',
    );
    expect(again.outcome).toBe('unchanged');
    expect(again.state.lastReason).toBe('first');
    expect(await auditRows()).toHaveLength(1);
  });

  it('a REORDER is a change: it writes the row and an audit row', async () => {
    await service.save(
      superadmin,
      { enabled: true, instanceTypes: ['m6i.large', 'm7i.large'] },
      'first',
    );
    const reorder = await service.save(
      superadmin,
      { enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] },
      'prefer the newer generation',
    );
    expect(reorder.outcome).toBe('changed');
    expect((await storedRow())?.instanceTypes).toEqual(['m7i.large', 'm6i.large']);
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.metadata).toEqual({
      from: { enabled: true, instanceTypes: ['m6i.large', 'm7i.large'] },
      to: { enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] },
    });
  });

  it.each([
    ['empty', [], null],
    ['duplicate', ['m6i.large', 'm7i.large', 'm6i.large'], 'm6i.large'],
    ['not_allowed', ['m6i.large', 'm6g.large'], 'm6g.large'],
    ['not_allowed', ['m6i.xlarge'], 'm6i.xlarge'],
  ] as const)(
    'a %s list (%j) is refused naming the rule and the type, and writes nothing',
    async (rule, instanceTypes, instanceType) => {
      const err = await service
        .save(superadmin, { enabled: true, instanceTypes: [...instanceTypes] }, 'go')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidCiSpotInstanceTypesError);
      expect(err).toMatchObject({ code: 'INVALID_CI_SPOT_INSTANCE_TYPES', rule, instanceType });
      expect(await storedRow()).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a list that is not an array of strings is refused as not allowed', async () => {
    await expect(
      service.save(superadmin, { enabled: true, instanceTypes: [42 as unknown as string] }, 'go'),
    ).rejects.toMatchObject({ rule: 'not_allowed', instanceType: '42' });
    await expect(
      service.save(superadmin, { enabled: true, instanceTypes: null as unknown as string[] }, 'go'),
    ).rejects.toMatchObject({ rule: 'empty', instanceType: null });
    expect(await storedRow()).toBeNull();
  });

  it.each(['', '   ', undefined as unknown as string])(
    'a blank reason (%j) is refused before any transaction and writes nothing',
    async (reason) => {
      await expect(
        service.save(superadmin, { enabled: true, instanceTypes: DEFAULTS }, reason),
      ).rejects.toBeInstanceOf(MissingAuditReasonError);
      expect(await storedRow()).toBeNull();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('two racing saves of one value ⇒ one changed, one unchanged, one audit row', async () => {
    const value = { enabled: true, instanceTypes: ['m7i.large'] };
    const outcomes = await Promise.all([
      service.save(superadmin, value, 'first'),
      service.save(superadmin, value, 'second'),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['changed', 'unchanged']);
    expect(await auditRows()).toHaveLength(1);
    expect((await storedRow())?.instanceTypes).toEqual(['m7i.large']);
  });

  it('a failure inside the transaction is re-thrown and writes nothing', async () => {
    const { platformCiSpotSettingRepository } =
      await import('@/lib/repositories/platformCiSpotSettingRepository');
    vi.spyOn(platformCiSpotSettingRepository, 'upsert').mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.save(superadmin, { enabled: true, instanceTypes: DEFAULTS }, 'on'),
    ).rejects.toThrow('boom');
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('the table', () => {
  it('holds one row for the ci_runner scope', async () => {
    await service.save(superadmin, { enabled: true, instanceTypes: DEFAULTS }, 'on');
    await expect(
      adminDb.platformCiSpotSetting.create({ data: { scope: 'ci_runner', instanceTypes: [] } }),
    ).rejects.toThrow();
  });

  it('keeps the setting when the user recorded against it is deleted', async () => {
    // Seeded directly: a real save also writes an audit row, whose actor key
    // (correctly) refuses the delete.
    const saver = await createTestUser();
    await adminDb.platformCiSpotSetting.create({
      data: {
        scope: 'ci_runner',
        enabled: true,
        instanceTypes: DEFAULTS,
        updatedByUserId: saver.id,
      },
    });
    await adminDb.user.delete({ where: { id: saver.id } });
    const row = await storedRow();
    expect(row?.enabled).toBe(true);
    expect(row?.updatedByUserId).toBeNull();
  });
});
