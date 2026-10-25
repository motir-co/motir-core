import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The fleet kind switch's PUBLIC read arm (MOTIR-9503) — the evidence
 * `singleton-read-guard.test.ts`'s `public` verdict cites.
 *
 * Placement reads the switch on every new agent instance, outside any platform
 * transaction, so it relies on the table's SELECT policy admitting the row with
 * nothing bound. The arm must be read-only: a write with nothing bound is
 * refused, because `app.platform_staff` is what the write arm needs.
 */

async function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    // RLS is inert under the superuser (BYPASSRLS); the role switch is what
    // makes these assertions mean anything.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformFleetKindSwitch.deleteMany();
});

afterAll(async () => {
  await adminDb.platformFleetKindSwitch.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the fleet kind switch read', () => {
  it('ADMITS the row with nothing bound', async () => {
    await adminDb.platformFleetKindSwitch.create({
      data: { fleetKind: 'agent_instance', onPool: true, lastReason: 'try it' },
    });
    const row = await asAppRole((tx) =>
      tx.platformFleetKindSwitch.findUnique({
        where: { fleetKind: 'agent_instance' },
        select: { onPool: true, lastReason: true },
      }),
    );
    expect(row).toEqual({ onPool: true, lastReason: 'try it' });
  });

  it('REFUSES a write with nothing bound — the arm is read-only', async () => {
    await expect(
      asAppRole((tx) =>
        tx.platformFleetKindSwitch.create({ data: { fleetKind: 'agent_instance', onPool: true } }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.platformFleetKindSwitch.count()).toBe(0);
  });
});
