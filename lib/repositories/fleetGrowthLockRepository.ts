import type { Prisma } from '@/generated/prisma/client';

// The per-kind POOL GROWTH lock (Story MOTIR-9362 · MOTIR-9461): a
// transaction-scoped Postgres advisory lock, so two growth passes of one fleet
// kind cannot both decide. Released when the transaction ends — the persisted
// growth claim, not this lock, is what keeps the kind held across the AWS call.

export const fleetGrowthLockRepository = {
  /** Take the kind's growth lock for the rest of `tx`, without waiting. False
   *  when another transaction holds it. */
  async tryLockKindInTx(fleetKind: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`fleet_growth:${fleetKind}`}, 0)) AS "locked"`;
    return rows[0]?.locked === true;
  },
};
