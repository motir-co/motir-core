import type { Prisma } from '@/generated/prisma/client';

// THE DEFERRED CODEQL MOVE's cross-process claim (MOTIR-12034). Every runner
// boot fires the catch-up, and one CI run boots its runners on separate workers
// in the same second, so the claim is a row: taken in ONE statement, only while
// no lease is live and no landed move is remembered, and settled by the boot
// that holds it. Keys are lower-cased by the caller. Platform-only — the caller
// holds a `withSystemContext` transaction.

export const fleetCodeScanningMoveRepository = {
  /** Until when a move of `org/repo` that landed is remembered, or null. */
  async findOnFleetUntilInTx(
    org: string,
    repo: string,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const row = await tx.fleetCodeScanningMove.findUnique({
      where: { org_repo: { org, repo } },
      select: { onFleetUntil: true },
    });
    return row?.onFleetUntil ?? null;
  },

  /** Take the move of `org/repo` for `holder` until `heldUntil` — only if no
   *  lease is live at `now` and no landed move is remembered past `now`. True
   *  when taken. */
  async tryClaimInTx(
    input: { org: string; repo: string; holder: string; now: Date; heldUntil: Date },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { org, repo, holder, now, heldUntil } = input;
    const rows = await tx.$queryRaw<Array<{ org: string }>>`
      INSERT INTO "fleet_code_scanning_move" ("org", "repo", "held_until", "holder", "updated_at")
      VALUES (${org}, ${repo}, ${heldUntil}, ${holder}, ${now})
      ON CONFLICT ("org", "repo") DO UPDATE
        SET "held_until" = EXCLUDED."held_until",
            "holder" = EXCLUDED."holder",
            "updated_at" = EXCLUDED."updated_at"
        WHERE "fleet_code_scanning_move"."held_until" <= ${now}
          AND ("fleet_code_scanning_move"."on_fleet_until" IS NULL
               OR "fleet_code_scanning_move"."on_fleet_until" <= ${now})
      RETURNING "org"`;
    return rows.length === 1;
  },

  /** Settle the holder's lease — only the holder can — so it is held until
   *  `heldUntil` (now, to give it back; later, for a cooldown) and, when the
   *  setup is on the fleet label, remember it until `onFleetUntil`. */
  async settleInTx(
    input: {
      org: string;
      repo: string;
      holder: string;
      heldUntil: Date;
      onFleetUntil: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const { org, repo, holder, heldUntil, onFleetUntil } = input;
    await tx.fleetCodeScanningMove.updateMany({
      where: { org, repo, holder },
      data: { heldUntil, ...(onFleetUntil ? { onFleetUntil } : {}) },
    });
  },
};
