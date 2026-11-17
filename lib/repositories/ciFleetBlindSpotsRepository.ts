import type { Prisma } from '@/generated/prisma/client';

/**
 * THE CI FLEET'S BLIND-SPOT RECORD (MOTIR-11439) — the provision sweep's last
 * reconcile outcome, ONE row (`id = 'latest'`). The sweep writes it under
 * `withSystemContext`; the Fleet status page reads it inside `withPlatformRead`
 * (`20261116210000_ci_fleet_blind_spots`'s two arms). Both methods take `tx`.
 */

export const CI_FLEET_BLIND_SPOTS_ID = 'latest';

export interface CiFleetBlindSpotsRow {
  outcome: Prisma.JsonValue;
  computedAt: Date;
}

export const ciFleetBlindSpotsRepository = {
  /** The stored outcome, or `null` before any sweep has written one. */
  async findLatest(tx: Prisma.TransactionClient): Promise<CiFleetBlindSpotsRow | null> {
    return tx.ciFleetBlindSpots.findUnique({
      where: { id: CI_FLEET_BLIND_SPOTS_ID },
      select: { outcome: true, computedAt: true },
    });
  },

  /**
   * Replace the stored outcome with one computed at `computedAt` — unless the
   * stored one is newer, so a late (resumed) sweep never overwrites a later
   * tick's outcome. One statement; answers how many rows it wrote (0 or 1).
   */
  async replaceIfNewer(
    input: { outcome: Prisma.InputJsonValue; computedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const outcome = JSON.stringify(input.outcome);
    // Prisma keeps a `TIMESTAMP(3)` as UTC wall time; bind the instant as ISO and
    // convert it explicitly so the session's time zone can never shift it.
    const computedAt = input.computedAt.toISOString();
    return tx.$executeRaw`
      INSERT INTO "ci_fleet_blind_spots" ("id", "outcome", "computed_at")
      VALUES (${CI_FLEET_BLIND_SPOTS_ID}, ${outcome}::jsonb, (${computedAt}::timestamptz AT TIME ZONE 'UTC'))
      ON CONFLICT ("id") DO UPDATE
        SET "outcome" = EXCLUDED."outcome", "computed_at" = EXCLUDED."computed_at"
        WHERE "ci_fleet_blind_spots"."computed_at" <= EXCLUDED."computed_at"
    `;
  },
};
