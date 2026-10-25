import type { Prisma } from '@/generated/prisma/client';

// The growth pass's SINGLE-FLIGHT LEASE (Story MOTIR-9362 · MOTIR-9462). The job
// runner has no single-flight option and a pass outlives any transaction (it
// creates AWS accounts), so the lease is a row: taken in one statement only when
// it has expired, released by the run that holds it. Platform-only — the caller
// holds a `withSystemContext` transaction.

export const fleetGrowthPassLeaseRepository = {
  /** Take the lease `id` for `holder` until `heldUntil` — only if nobody holds
   *  it at `now`. True when taken. */
  async tryAcquireInTx(
    id: string,
    holder: string,
    now: Date,
    heldUntil: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "fleet_growth_pass_lease" ("id", "held_until", "holder", "updated_at")
      VALUES (${id}, ${heldUntil}, ${holder}, ${now})
      ON CONFLICT ("id") DO UPDATE
        SET "held_until" = EXCLUDED."held_until",
            "holder" = EXCLUDED."holder",
            "updated_at" = EXCLUDED."updated_at"
        WHERE "fleet_growth_pass_lease"."held_until" <= ${now}
      RETURNING "id"`;
    return rows.length === 1;
  },

  /** Give the lease back — only the holder can. */
  async releaseInTx(id: string, holder: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetGrowthPassLease.deleteMany({ where: { id, holder } });
  },
};
