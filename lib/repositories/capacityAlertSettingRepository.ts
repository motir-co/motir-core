import type { CapacityAlertSetting, Prisma } from '@/generated/prisma/client';

// Data access for the capacity ALERT SHARE (Story MOTIR-9539 · MOTIR-9609), a
// singleton row keyed `'platform'`. The table admits `app.system_admin` or
// `app.platform_staff`, so the caller holds one of those contexts.

const SINGLETON_ID = 'platform';

export const capacityAlertSettingRepository = {
  /** The stored setting, or `null` when nobody has set one (the default applies). */
  async find(tx: Prisma.TransactionClient): Promise<CapacityAlertSetting | null> {
    return tx.capacityAlertSetting.findUnique({ where: { id: SINGLETON_ID } });
  },

  async upsert(
    alertSharePercent: number,
    updatedByUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CapacityAlertSetting> {
    return tx.capacityAlertSetting.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, alertSharePercent, updatedByUserId },
      update: { alertSharePercent, updatedByUserId },
    });
  },
};
