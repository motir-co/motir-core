import type { CapacityRaisedAlert, Prisma } from '@/generated/prisma/client';
import type { CapacityStoreKey } from '@/lib/capacity/alertKeys';

// Data access for RAISED capacity alerts (Story MOTIR-9539 · MOTIR-9609). Writes
// pass the `app.system_admin` arm only, so the caller holds a `withSystemContext`
// transaction. Raise and clear are each ONE statement, so of two concurrent
// evaluations exactly one is told it raised (or cleared) the alert.

export interface CapacityRaisedAlertRow {
  provider: string;
  model: string;
  limitUnit: string;
  observedValue: bigint;
  limitValue: bigint;
  alertSharePercent: number;
}

export const capacityRaisedAlertRepository = {
  /** Insert the row unless the key is already raised. True when THIS call inserted it. */
  async insertIfAbsent(
    row: CapacityRaisedAlertRow,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.capacityRaisedAlert.createMany({
      data: [row],
      skipDuplicates: true,
    });
    return count > 0;
  },

  /** Delete the key's row. True when THIS call deleted it. */
  async deleteByKey(key: CapacityStoreKey, tx: Prisma.TransactionClient): Promise<boolean> {
    const { count } = await tx.capacityRaisedAlert.deleteMany({
      where: { provider: key.provider, model: key.model, limitUnit: key.limitUnit },
    });
    return count > 0;
  },

  async findByKey(
    key: CapacityStoreKey,
    tx: Prisma.TransactionClient,
  ): Promise<CapacityRaisedAlert | null> {
    return tx.capacityRaisedAlert.findFirst({
      where: { provider: key.provider, model: key.model, limitUnit: key.limitUnit },
    });
  },

  async listAll(tx: Prisma.TransactionClient): Promise<CapacityRaisedAlert[]> {
    return tx.capacityRaisedAlert.findMany({
      orderBy: [{ provider: 'asc' }, { model: 'asc' }, { limitUnit: 'asc' }],
    });
  },
};
