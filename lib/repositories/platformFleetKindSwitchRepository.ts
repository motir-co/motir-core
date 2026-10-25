import type { Prisma } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';

/**
 * One fleet kind's persisted Fly↔AWS switch (MOTIR-9503) — one row per kind,
 * written on its first flip. No row = OFF = Fly.
 *
 * The writes and the read that guards them take `tx`: they run inside
 * `withPlatformWrite` (the `app.platform_staff` arm the table's write policy
 * reads). The state read takes no `tx`: its SELECT policy is unconditional
 * (`USING (true)`), so placement and the console read it outside any platform
 * transaction — the `platformFleetOrgCiRepository` shape.
 */

/** One switch row, as stored. */
export interface PlatformFleetKindSwitchRow {
  fleetKind: string;
  onPool: boolean;
  lastReason: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

const ROW = {
  fleetKind: true,
  onPool: true,
  lastReason: true,
  updatedByUserId: true,
  updatedAt: true,
} as const;

export const platformFleetKindSwitchRepository = {
  /** The row for one kind, or null (OFF). */
  async find(fleetKind: FleetWorkloadKind): Promise<PlatformFleetKindSwitchRow | null> {
    return db.platformFleetKindSwitch.findUnique({ where: { fleetKind }, select: ROW });
  },

  /**
   * Lock the kind's row for the rest of the transaction and answer its `onPool`,
   * or null when there is no row yet. Two flips of one kind serialise here, so
   * the second re-reads what the first committed.
   */
  async lockForUpdate(
    fleetKind: FleetWorkloadKind,
    tx: Prisma.TransactionClient,
  ): Promise<{ onPool: boolean } | null> {
    const rows = await tx.$queryRaw<{ onPool: boolean }[]>`
      SELECT "on_pool" AS "onPool" FROM "platform_fleet_kind_switch"
      WHERE "fleet_kind" = ${fleetKind}
      FOR UPDATE`;
    return rows[0] ?? null;
  },

  /** Write the kind's state, creating its row on the first flip. */
  async upsert(
    input: {
      fleetKind: FleetWorkloadKind;
      onPool: boolean;
      lastReason: string;
      updatedByUserId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlatformFleetKindSwitchRow> {
    const { fleetKind, ...state } = input;
    return tx.platformFleetKindSwitch.upsert({
      where: { fleetKind },
      create: { fleetKind, ...state },
      update: state,
      select: ROW,
    });
  },
};
