import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';

/**
 * The CI runner Spot setting (MOTIR-11725) — ONE platform-wide row, keyed by
 * `scope = 'ci_runner'`, written on its first save. No row = Spot OFF and the
 * default instance types.
 *
 * The writes and the read that guards them take `tx`: they run inside
 * `withPlatformWrite` (the `app.platform_staff` arm the table's write policy
 * reads). The state read takes no `tx`: its SELECT policy is unconditional
 * (`USING (true)`), so the CI runner launch and the console read it outside any
 * platform transaction — the `platformFleetKindSwitchRepository` shape.
 */

/** The setting's one scope — its singleton key. */
export const CI_SPOT_SETTING_SCOPE = 'ci_runner' as const;

/** The setting row, as stored. */
export interface PlatformCiSpotSettingRow {
  enabled: boolean;
  instanceTypes: string[];
  lastReason: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

const ROW = {
  enabled: true,
  instanceTypes: true,
  lastReason: true,
  updatedByUserId: true,
  updatedAt: true,
} as const;

export const platformCiSpotSettingRepository = {
  /** The setting row, or null (never saved: OFF, the defaults). */
  async find(): Promise<PlatformCiSpotSettingRow | null> {
    return db.platformCiSpotSetting.findUnique({
      where: { scope: CI_SPOT_SETTING_SCOPE },
      select: ROW,
    });
  },

  /**
   * Lock the setting's row for the rest of the transaction and answer its stored
   * values, or null when there is no row yet. Two saves serialise here, so the
   * second re-reads what the first committed.
   */
  async lockForUpdate(
    tx: Prisma.TransactionClient,
  ): Promise<{ enabled: boolean; instanceTypes: string[] } | null> {
    const rows = await tx.$queryRaw<{ enabled: boolean; instanceTypes: string[] }[]>`
      SELECT "enabled", "instance_types" AS "instanceTypes" FROM "platform_ci_spot_setting"
      WHERE "scope" = ${CI_SPOT_SETTING_SCOPE}
      FOR UPDATE`;
    return rows[0] ?? null;
  },

  /** Write the setting, creating its row on the first save. */
  async upsert(
    input: {
      enabled: boolean;
      instanceTypes: string[];
      lastReason: string;
      updatedByUserId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlatformCiSpotSettingRow> {
    return tx.platformCiSpotSetting.upsert({
      where: { scope: CI_SPOT_SETTING_SCOPE },
      create: { scope: CI_SPOT_SETTING_SCOPE, ...input },
      update: input,
      select: ROW,
    });
  },
};
