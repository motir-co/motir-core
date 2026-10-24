import type { FleetQuotaRequest, FleetQuotaRequestStatus, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the QUOTA RAISES filed for a fleet account (Story MOTIR-9362 ·
// MOTIR-9457). The table's policy is `app.system_admin` only, so the caller holds
// a `withSystemContext` transaction.

export type FleetQuotaRequestCreateInput = Prisma.FleetQuotaRequestUncheckedCreateInput;

export const fleetQuotaRequestRepository = {
  async create(
    data: FleetQuotaRequestCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest> {
    return tx.fleetQuotaRequest.create({ data });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<FleetQuotaRequest | null> {
    const client = tx ?? dbRead;
    return client.fleetQuotaRequest.findUnique({ where: { id } });
  },

  /** The account's open request for this quota, if any — at most one (the
   *  partial unique index `fleet_quota_request_one_open`). */
  async findOpenByShardAndCode(
    shardId: string,
    quotaCode: string,
    tx?: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest | null> {
    const client = tx ?? dbRead;
    return client.fleetQuotaRequest.findFirst({ where: { shardId, quotaCode, closedAt: null } });
  },

  /** Record one Service Quotas read: its status and granted value, and — when
   *  the status is terminal — the close. */
  async updateRead(
    id: string,
    read: {
      status: FleetQuotaRequestStatus;
      grantedValue: number | null;
      lastReadAt: Date;
      closedAt: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest> {
    return tx.fleetQuotaRequest.update({ where: { id }, data: read });
  },

  /** The open requests, optionally of one kind or one account — oldest first. */
  async listOpen(
    filter: { fleetKind?: string; shardId?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest[]> {
    const client = tx ?? dbRead;
    return client.fleetQuotaRequest.findMany({
      where: {
        closedAt: null,
        ...(filter.fleetKind !== undefined ? { fleetKind: filter.fleetKind } : {}),
        ...(filter.shardId !== undefined ? { shardId: filter.shardId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Every request of one account, open or closed — newest first. */
  async listByShard(shardId: string, tx?: Prisma.TransactionClient): Promise<FleetQuotaRequest[]> {
    const client = tx ?? dbRead;
    return client.fleetQuotaRequest.findMany({
      where: { shardId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
