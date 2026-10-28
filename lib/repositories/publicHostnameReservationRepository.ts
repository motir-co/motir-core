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
   * How many hostnames a workspace has RETIRED into the reservation table — the
   * second half of ADR §8's rename-cap input (Amendment 2, MOTIR-4454).
   *
   * The cap used to read `countAliasesForWorkspace` alone, which is a count of
   * live alias ROWS. A release deletes those rows, so a cap that reads only them
   * is handed back in full on every release and
   * `claim → rename ×5 → release`, repeated, burns names out of a shared
   * namespace without bound. Amendment 2 therefore measures the cap over names
   * BURNT — aliases held PLUS hostnames this workspace has reserved — and this
   * is that second term. For a workspace that has never released it is `0`, so
   * the generalisation returns exactly the old number.
   *
   * ⚠️ `retired_from_workspace_id` is NOT only a deleted workspace's id any
   * more. Amendment 1 wrote it from the workspace delete (`deleteWorkspaceCascade`), where
   * the workspace was on its way out; a release writes it while the workspace is
   * alive, which is what makes this count answerable at all.
   */
  async countForWorkspaceInTx(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.publicHostnameReservation.count({
      where: { retiredFromWorkspaceId: workspaceId },
    });
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
};
