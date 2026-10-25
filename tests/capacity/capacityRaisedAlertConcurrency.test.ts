import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CAPACITY ALERT STATE UNDER CONCURRENCY (Story MOTIR-9539 · MOTIR-9609).
// The scheduled job and a screen load can evaluate at the same moment; each
// answer below must hold when two calls really race on Postgres, which a serial
// test cannot show.

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, requirePlatformStaff: async () => currentPrincipal };
});

const { capacityAlertStateService: service } =
  await import('@/lib/services/capacityAlertStateService');

const KEY = { provider: 'claude', model: 'claude-example-2', limitUnit: 'rpm' } as const;
const SNAPSHOT = { observedValue: 3_400, limitValue: 4_000, alertSharePercent: 80 };

async function operatorPrincipal(): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
  return { userId: user.id, email: user.email, role: 'operator' as PlatformRole };
}

beforeEach(async () => {
  await adminDb.capacityAlertSetting.deleteMany();
  await adminDb.capacityRaisedAlert.deleteMany();
  await truncateAuthTables();
  currentPrincipal = await operatorPrincipal();
});

afterAll(async () => {
  await adminDb.capacityAlertSetting.deleteMany();
  await adminDb.capacityRaisedAlert.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
});

describe('concurrent evaluation', () => {
  it('two raises on one key leave one row, and exactly one is newlyRaised', async () => {
    const answers = await Promise.all([service.raise(KEY, SNAPSHOT), service.raise(KEY, SNAPSHOT)]);
    expect(answers.filter((a) => a.newlyRaised)).toHaveLength(1);
    expect(await adminDb.capacityRaisedAlert.count()).toBe(1);
  });

  it('two clears on a raised key leave no row, and exactly one cleared it', async () => {
    await service.raise(KEY, SNAPSHOT);
    const answers = await Promise.all([service.clear(KEY), service.clear(KEY)]);
    expect(answers.filter((a) => a.cleared)).toHaveLength(1);
    expect(await adminDb.capacityRaisedAlert.count()).toBe(0);
  });
});

describe('concurrent alert-share saves', () => {
  it('both commit, and their audit rows chain from → to', async () => {
    const other = await operatorPrincipal();
    await Promise.all([
      service.setAlertShare(currentPrincipal, 85),
      service.setAlertShare(other, 90),
    ]);
    const rows = await adminDb.platformAuditLog.findMany({
      where: { action: 'capacity.alert_share.set' },
      orderBy: { seq: 'asc' },
    });
    expect(rows).toHaveLength(2);
    const [first, second] = rows.map(
      (r) => r.metadata as { fromPercent: number; toPercent: number },
    );
    expect(first!.fromPercent).toBe(80);
    expect(second!.fromPercent).toBe(first!.toPercent);
    const stored = await adminDb.capacityAlertSetting.findUniqueOrThrow({
      where: { id: 'platform' },
    });
    expect(stored.alertSharePercent).toBe(second!.toPercent);
  });
});
