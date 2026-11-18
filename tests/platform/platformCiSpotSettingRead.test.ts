import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The CI Spot setting's ROW-LEVEL SECURITY (MOTIR-11725) — the evidence
 * `singleton-read-guard.test.ts`'s `public` verdict cites.
 *
 * The CI runner launch reads the setting outside any platform transaction, so it
 * relies on the table's SELECT policy admitting the row with nothing bound. The
 * arm must be read-only: a write with nothing bound is refused by the database,
 * because `app.platform_staff` — bound only by `withPlatformWrite` — is what the
 * write arm needs.
 */

async function asAppRole<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  platformStaff = false,
): Promise<T> {
  return db.$transaction(async (tx) => {
    // RLS is inert under the superuser (BYPASSRLS); the role switch is what
    // makes these assertions mean anything.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    if (platformStaff)
      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_staff', 'true', true)`);
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
});

afterAll(async () => {
  await adminDb.platformCiSpotSetting.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the CI Spot setting read', () => {
  it('ADMITS the row with nothing bound', async () => {
    await adminDb.platformCiSpotSetting.create({
      data: { scope: 'ci_runner', enabled: true, instanceTypes: ['m7i.large'], lastReason: 'go' },
    });
    const row = await asAppRole((tx) =>
      tx.platformCiSpotSetting.findUnique({
        where: { scope: 'ci_runner' },
        select: { enabled: true, instanceTypes: true, lastReason: true },
      }),
    );
    expect(row).toEqual({ enabled: true, instanceTypes: ['m7i.large'], lastReason: 'go' });
  });

  it('REFUSES a write with nothing bound — the arm is read-only', async () => {
    await expect(
      asAppRole((tx) =>
        tx.platformCiSpotSetting.create({
          data: { scope: 'ci_runner', enabled: true, instanceTypes: ['m6i.large'] },
        }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
  });

  it('REFUSES an update of a stored row with nothing bound', async () => {
    await adminDb.platformCiSpotSetting.create({
      data: { scope: 'ci_runner', enabled: false, instanceTypes: ['m6i.large'] },
    });
    const updated = await asAppRole((tx) =>
      tx.platformCiSpotSetting.updateMany({
        where: { scope: 'ci_runner' },
        data: { enabled: true },
      }),
    );
    expect(updated.count).toBe(0);
    expect((await adminDb.platformCiSpotSetting.findFirst())?.enabled).toBe(false);
  });

  it('ADMITS a write under the platform-staff flag withPlatformWrite binds', async () => {
    await asAppRole(
      (tx) =>
        tx.platformCiSpotSetting.create({
          data: { scope: 'ci_runner', enabled: true, instanceTypes: ['m6i.large'] },
        }),
      true,
    );
    expect(await adminDb.platformCiSpotSetting.count()).toBe(1);
  });

  it('the migration enables AND forces row-level security, with one read and one write policy', async () => {
    const [table] = await adminDb.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'platform_ci_spot_setting'`;
    expect(table).toEqual({ enabled: true, forced: true });
    const policies = await adminDb.$queryRaw<{ policyname: string; cmd: string; qual: string }[]>`
      SELECT policyname, cmd, qual FROM pg_policies
      WHERE tablename = 'platform_ci_spot_setting' ORDER BY policyname`;
    expect(policies.map((p) => [p.policyname, p.cmd])).toEqual([
      ['platform_ci_spot_setting_platform_staff', 'ALL'],
      ['platform_ci_spot_setting_read', 'SELECT'],
    ]);
    expect(policies[0]?.qual).toContain('app.platform_staff');
    expect(policies[1]?.qual).toBe('true');
  });
});
