import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';

// The §8 hostname-reservation data layer — Bug MOTIR-4366.
//
// `prisma/schema.prisma`'s `model PublicHostnameReservation` carries the shape
// and the reasoning; `lib/publicAddresses/hostnameReservation.ts` owns the
// transform. This file owns the queries and nothing else.
//
// Single Prisma operation per method, `tx` REQUIRED on every one — `CLAUDE.md`'s
// 4-layer contract. There is no `db` singleton read here on purpose: every
// caller is already inside a bound transaction (a claim, or the delete this
// table exists to survive), and a singleton read of a policy-gated table is the
// silent-zero the RLS singleton-read guard exists to refuse.
//
// ⚠️ A RESERVATION EXPIRES (§8 Amendment 3, Story MOTIR-4528 · MOTIR-9506).
// It used to be held for ever. A name a workspace renames or releases after
// holding it 24 hours or more is now held for 90 days, and one held less is not
// held at all (`lib/publicAddresses/nameHold.ts` is the rule). So every read here
// asks about an UNEXPIRED row, and a row whose `expires_at` has passed protects
// nothing: it is invisible to a claim, refreshed in place by the next
// reservation of the same digest, and deleted by the daily sweep.
//
// `retired_from_workspace_id` names the workspace that retired the name — a
// deleted one on the delete path, a living one on a rename or release. It is
// not a relation, and the insert arm's
// `retired_from_workspace_id = current_setting('app.workspace_id')` is satisfied
// by construction because every tenant writer runs inside `withWorkspaceContext`
// bound to the workspace it retires the name from.

export const publicHostnameReservationRepository = {
  /**
   * Is this digest reserved at `now`?
   *
   * A count rather than a row read: the caller never needs the reservation, only
   * the answer, and returning the row would hand a claim path the provenance of
   * a workspace it has no business knowing about. A lapsed row is not a
   * reservation, whether or not the sweep has deleted it yet.
   */
  async isReservedInTx(
    hostnameHash: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const count = await tx.publicHostnameReservation.count({
      where: { hostnameHash, expiresAt: { gt: now } },
    });
    return count > 0;
  },

  /**
   * When this digest's hold ends, or `null` if nothing holds it at `now`.
   *
   * The claim path's refusal needs the DATE, because story rule 5 tells a
   * claimer when a quarantined name returns. The date is all that leaves this
   * method: `retired_from_workspace_id` is never selected, so the answer carries
   * no provenance.
   */
  async findActiveExpiryInTx(
    hostnameHash: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const row = await tx.publicHostnameReservation.findFirst({
      where: { hostnameHash, expiresAt: { gt: now } },
      select: { expiresAt: true },
    });
    return row?.expiresAt ?? null;
  },

  /**
   * Each of these digests that has a row, mapped to its `expires_at` — lapsed
   * or live. The legacy-alias cleanup's batched classify read (MOTIR-9520), so
   * a batch of two hundred aliases is one query rather than two hundred.
   * Operator-only, under the `system` arm; the answer carries no provenance.
   */
  async findExpiriesInTx(
    hostnameHashes: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, Date>> {
    if (hostnameHashes.length === 0) return new Map();
    const rows = await tx.publicHostnameReservation.findMany({
      where: { hostnameHash: { in: [...hostnameHashes] } },
      select: { hostnameHash: true, expiresAt: true },
    });
    return new Map(rows.map((r) => [r.hostnameHash, r.expiresAt]));
  },

  /**
   * Delete every hold that has lapsed at `now` (`expires_at <= now`) — the daily
   * sweep's one write (MOTIR-9509). Returns how many rows went.
   *
   * Housekeeping, not a rule: a lapsed row already protects nothing (every read
   * here asks about an unexpired row, and `reserveMany` refreshes one in place).
   * Deleting it keeps the table to what Amendment 1 says it holds — a digest
   * and the date it stops mattering.
   */
  async deleteExpiredInTx(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.publicHostnameReservation.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  },

  /**
   * Reserve a set of digests until each row's `expiresAt`, retiring them from
   * one workspace.
   *
   * ONE statement, `INSERT … ON CONFLICT (hostname_hash) DO UPDATE`, because a
   * digest may already have a row, and what happens to it depends on the row:
   *
   *   * LAPSED (expired, not yet swept) — raised to the new expiry and attributed
   *     to the reserving workspace. Skipping it, as the old `skipDuplicates`
   *     insert did, would leave a released name free.
   *   * LIVE and written by the SAME workspace — keeps the LATER expiry. That is
   *     what makes a resumed erasure tick re-running this write a no-op rather
   *     than a 23505 that aborts the erasure, and it never shortens a hold.
   *   * LIVE and written by ANOTHER workspace — left exactly as it is. The
   *     `WHERE` filters it before the update, so no tenant can move another
   *     workspace's hold.
   *
   * The table's `refresh` RLS arm admits exactly the first two rows. Raw SQL
   * because Prisma's upsert takes one row and its `createMany` cannot update;
   * the id is bound client-side as Prisma's `cuid()` default would be (a UUID,
   * as `ciPeriodChargeRepository.ensureRow` documents).
   *
   * Returns the number of rows inserted or refreshed.
   */
  async reserveMany(
    rows: ReadonlyArray<{ hostnameHash: string; retiredFromWorkspaceId: string; expiresAt: Date }>,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const values = Prisma.join(
      rows.map(
        (row) =>
          Prisma.sql`(${randomUUID()}, ${row.hostnameHash}, ${row.retiredFromWorkspaceId}, ${now}, ${row.expiresAt})`,
      ),
    );
    return tx.$executeRaw`
      INSERT INTO "public_hostname_reservation" (
        "id", "hostname_hash", "retired_from_workspace_id", "retired_at", "expires_at"
      )
      VALUES ${values}
      ON CONFLICT ("hostname_hash") DO UPDATE SET
        "retired_from_workspace_id" = EXCLUDED."retired_from_workspace_id",
        "retired_at" = EXCLUDED."retired_at",
        "expires_at" = GREATEST("public_hostname_reservation"."expires_at", EXCLUDED."expires_at")
      WHERE "public_hostname_reservation"."expires_at" <= ${now}
         OR "public_hostname_reservation"."retired_from_workspace_id" = EXCLUDED."retired_from_workspace_id"
    `;
  },

  /**
   * Hold each digest until AT LEAST its `expiresAt`, whoever wrote an existing
   * row — the legacy-alias cleanup's write (MOTIR-9520). Returns the number of
   * rows inserted or raised.
   *
   * Unlike {@link reserveMany} this is an OPERATOR write, run under the table's
   * `system` arm, so it has no tenant to protect from another: on a digest
   * conflict it sets `expires_at` to the LATER of the stored and the given
   * value, whether the stored row is lapsed or live. It never lowers a hold.
   * The stored `retired_from_workspace_id` and `retired_at` are replaced only
   * when the hold is actually raised, so a row this leaves alone keeps its
   * provenance.
   */
  async holdUntilInTx(
    rows: ReadonlyArray<{ hostnameHash: string; retiredFromWorkspaceId: string; expiresAt: Date }>,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const values = Prisma.join(
      rows.map(
        (row) =>
          Prisma.sql`(${randomUUID()}, ${row.hostnameHash}, ${row.retiredFromWorkspaceId}, ${now}, ${row.expiresAt})`,
      ),
    );
    return tx.$executeRaw`
      INSERT INTO "public_hostname_reservation" (
        "id", "hostname_hash", "retired_from_workspace_id", "retired_at", "expires_at"
      )
      VALUES ${values}
      ON CONFLICT ("hostname_hash") DO UPDATE SET
        "retired_from_workspace_id" = EXCLUDED."retired_from_workspace_id",
        "retired_at" = EXCLUDED."retired_at",
        "expires_at" = EXCLUDED."expires_at"
      WHERE "public_hostname_reservation"."expires_at" < EXCLUDED."expires_at"
    `;
  },
};
