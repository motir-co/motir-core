import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  CapacityAlertKeyInvalidError,
  CapacityAlertShareInvalidError,
  CapacityAlertShareUnchangedError,
} from '@/lib/capacity/errors';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { withPlatformRead } from '@/lib/platform/context';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CAPACITY ALERT STATE (Story MOTIR-9539 · MOTIR-9609) against a real
// Postgres: the setting row, the raised-alert rows, their RLS and the
// hash-chained audit trail are real. The platform gate is stubbed to a chosen
// principal — `null` is a signed-in user with no platform role (a tenant user or
// a tenant owner).

let currentPrincipal: PlatformPrincipal | null;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!currentPrincipal || !actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const { capacityAlertStateService: service } =
  await import('@/lib/services/capacityAlertStateService');

const KEY = { provider: 'qwen', model: 'qwen-example-1', limitUnit: 'tpm' } as const;
const SNAPSHOT = { observedValue: 640_000, limitValue: 800_000, alertSharePercent: 80 };

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: 'capacity.alert_share.set' },
    orderBy: { seq: 'asc' },
  });
}

let operator: PlatformPrincipal;

beforeEach(async () => {
  await adminDb.capacityAlertSetting.deleteMany();
  await adminDb.capacityRaisedAlert.deleteMany();
  await truncateAuthTables();
  operator = await principal('operator');
  currentPrincipal = operator;
});

afterAll(async () => {
  await adminDb.capacityAlertSetting.deleteMany();
  await adminDb.capacityRaisedAlert.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
});

describe('getAlertShare', () => {
  it('answers the default 80 when nothing is stored', async () => {
    expect(await service.getAlertShare()).toEqual({
      percent: 80,
      isDefault: true,
      updatedAt: null,
    });
  });

  it('answers the stored percent after a set, and never who set it', async () => {
    await service.setAlertShare(operator, 90);
    const share = await service.getAlertShare();
    expect(share).toMatchObject({ percent: 90, isDefault: false });
    expect(share.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(share)).not.toContain(operator.userId);
    expect(share).not.toHaveProperty('updatedByUserId');
  });
});

describe('setAlertShare — who may', () => {
  it.each([
    ['a tenant user or tenant owner', null],
    ['support staff', 'support'],
  ] as const)('%s is refused, and nothing is written', async (_label, role) => {
    currentPrincipal = role ? await principal(role) : null;
    await expect(service.setAlertShare(operator, 90)).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await adminDb.capacityAlertSetting.count()).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each(['operator', 'superadmin'] as const)('a %s succeeds', async (role) => {
    currentPrincipal = await principal(role);
    expect(await service.setAlertShare(currentPrincipal, 85)).toMatchObject({ percent: 85 });
  });
});

describe('setAlertShare — what it writes', () => {
  it.each([0, 101, 79.5, '90', null])(
    'refuses %j before any transaction, changing nothing',
    async (percent) => {
      await expect(service.setAlertShare(operator, percent)).rejects.toBeInstanceOf(
        CapacityAlertShareInvalidError,
      );
      expect(await adminDb.capacityAlertSetting.count()).toBe(0);
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('80 → 90 stores 90, records who, and appends one chained audit row', async () => {
    await service.setAlertShare(operator, 90);
    const row = await adminDb.capacityAlertSetting.findUniqueOrThrow({ where: { id: 'platform' } });
    expect(row.alertSharePercent).toBe(90);
    expect(row.updatedByUserId).toBe(operator.userId);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetKind: 'platform',
      targetId: 'capacity.alert_share',
      metadata: { fromPercent: 80, toPercent: 90 },
    });
    expect(rows[0]!.reason?.trim()).toBeTruthy();
  });

  it('records a supplied reason as given', async () => {
    await service.setAlertShare(operator, 75, 'tier upgrade');
    expect((await auditRows())[0]!.reason).toBe('tier upgrade');
  });

  it('saving the value already held throws and leaves no audit row', async () => {
    await service.setAlertShare(operator, 90);
    await expect(service.setAlertShare(operator, 90)).rejects.toBeInstanceOf(
      CapacityAlertShareUnchangedError,
    );
    expect(await auditRows()).toHaveLength(1);
  });

  it('runs in the platform context: the console write passes the platform-staff arm', async () => {
    // The write runs in `withPlatformWrite`, which binds `app.platform_staff` and
    // not `app.system_admin`; it committed, so that arm admits the setting.
    await service.setAlertShare(operator, 70);
    const read = await withPlatformRead(
      operator,
      { action: 'audit.read', targetKind: 'platform' },
      (tx) => tx.capacityAlertSetting.findUnique({ where: { id: 'platform' } }),
    );
    expect(read?.alertSharePercent).toBe(70);
  });
});

describe('raise and clear', () => {
  it('raise inserts once; a second raise keeps the first raisedAt and snapshot', async () => {
    expect(await service.raise(KEY, SNAPSHOT)).toEqual({ newlyRaised: true });
    const first = await adminDb.capacityRaisedAlert.findFirstOrThrow();
    expect(
      await service.raise(KEY, {
        observedValue: 790_000,
        limitValue: 800_000,
        alertSharePercent: 90,
      }),
    ).toEqual({ newlyRaised: false });
    const after = await adminDb.capacityRaisedAlert.findFirstOrThrow();
    expect(after.raisedAt).toEqual(first.raisedAt);
    expect(after.observedValue).toBe(BigInt(640_000));
    expect(after.alertSharePercent).toBe(80);
  });

  it('clear deletes a raised key, answers false on none, and a later raise is new again', async () => {
    await service.raise(KEY, SNAPSHOT);
    expect(await service.clear(KEY)).toEqual({ cleared: true });
    expect(await adminDb.capacityRaisedAlert.count()).toBe(0);
    expect(await service.clear(KEY)).toEqual({ cleared: false });
    expect(await service.raise(KEY, SNAPSHOT)).toEqual({ newlyRaised: true });
  });

  it('carries a figure past 2^31 (a tpd limit)', async () => {
    const tpd = { ...KEY, limitUnit: 'tpd' } as const;
    await service.raise(tpd, {
      observedValue: 4_000_000_000,
      limitValue: 5_000_000_000,
      alertSharePercent: 80,
    });
    const [listed] = await service.listRaised();
    expect(listed).toMatchObject({
      limitUnit: 'tpd',
      observedValue: 4_000_000_000,
      limitValue: 5_000_000_000,
    });
  });

  it.each([
    ['a provider outside the three', { ...KEY, provider: 'openai' }, 'provider'],
    ['a blank model', { ...KEY, model: '  ' }, 'model'],
    ['a unit outside the six', { ...KEY, limitUnit: 'rpd' }, 'limitUnit'],
  ])('refuses %s and writes nothing', async (_label, key, field) => {
    const bad = key as unknown as typeof KEY;
    await expect(service.raise(bad, SNAPSHOT)).rejects.toMatchObject({ field });
    await expect(service.clear(bad)).rejects.toBeInstanceOf(CapacityAlertKeyInvalidError);
    expect(await adminDb.capacityRaisedAlert.count()).toBe(0);
  });

  it('listRaised orders by provider, model, unit and carries no person or tenant id', async () => {
    await service.raise({ provider: 'qwen', model: 'b', limitUnit: 'tpm' }, SNAPSHOT);
    await service.raise({ provider: 'claude', model: 'a', limitUnit: 'rpm' }, SNAPSHOT);
    await service.raise({ provider: 'qwen', model: 'b', limitUnit: 'rpm' }, SNAPSHOT);
    const listed = await service.listRaised();
    expect(listed.map((r) => `${r.provider}/${r.model}/${r.limitUnit}`)).toEqual([
      'claude/a/rpm',
      'qwen/b/rpm',
      'qwen/b/tpm',
    ]);
    expect(Object.keys(listed[0]!).sort()).toEqual([
      'alertSharePercent',
      'limitUnit',
      'limitValue',
      'model',
      'observedValue',
      'provider',
      'raisedAt',
    ]);
  });
});

describe('the system arm (the job path: no principal)', () => {
  it('raise, clear, listRaised and getAlertShare run with no platform principal', async () => {
    currentPrincipal = null;
    expect(await service.getAlertShare()).toMatchObject({ percent: 80 });
    expect(await service.raise(KEY, SNAPSHOT)).toEqual({ newlyRaised: true });
    expect(await service.listRaised()).toHaveLength(1);
    expect(await service.clear(KEY)).toEqual({ cleared: true });
  });

  it('the raised-alert table admits no write from the platform-staff arm', async () => {
    await expect(
      withPlatformRead(operator, { action: 'audit.read', targetKind: 'platform' }, (tx) =>
        tx.capacityRaisedAlert.create({
          data: { ...KEY, observedValue: BigInt(1), limitValue: BigInt(2), alertSharePercent: 80 },
        }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.capacityRaisedAlert.count()).toBe(0);
  });
});
