import type { FleetGrowthEvent, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the POOL GROWTH record (Story MOTIR-9362 · MOTIR-9457). The
// table's policy is `app.system_admin` only, so the caller holds a
// `withSystemContext` transaction.

export type FleetGrowthEventCreateInput = Prisma.FleetGrowthEventUncheckedCreateInput;

export const fleetGrowthEventRepository = {
  async create(
    data: FleetGrowthEventCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<FleetGrowthEvent> {
    return tx.fleetGrowthEvent.create({ data });
  },

  /** One kind's growths, newest first. */
  async listByKind(
    fleetKind: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ): Promise<FleetGrowthEvent[]> {
    const client = tx ?? dbRead;
    return client.fleetGrowthEvent.findMany({
      where: { fleetKind },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  },

  /** The kind's newest UNFINISHED growth: not `refused`, and the quota raise it
   *  waits on still open. Read through the request, so no flag can drift. */
  async findLatestUnfinishedByKind(
    fleetKind: string,
    tx?: Prisma.TransactionClient,
  ): Promise<FleetGrowthEvent | null> {
    const client = tx ?? dbRead;
    return client.fleetGrowthEvent.findFirst({
      where: { fleetKind, outcome: { not: 'refused' }, quotaRequest: { closedAt: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
