import type { FleetQuotaRequest, FleetQuotaRequestStatus, Prisma } from '@/generated/prisma/client';

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

  async findById(id: string, tx: Prisma.TransactionClient): Promise<FleetQuotaRequest | null> {
    return tx.fleetQuotaRequest.findUnique({ where: { id } });
  },

  /** The account's open request for this quota, if any — at most one (the
   *  partial unique index `fleet_quota_request_one_open`). */
  async findOpenByShardAndCode(
    shardId: string,
    quotaCode: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest | null> {
    return tx.fleetQuotaRequest.findFirst({ where: { shardId, quotaCode, closedAt: null } });
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
    tx: Prisma.TransactionClient,
  ): Promise<FleetQuotaRequest[]> {
    return tx.fleetQuotaRequest.findMany({
      where: {
        closedAt: null,
        ...(filter.fleetKind !== undefined ? { fleetKind: filter.fleetKind } : {}),
        ...(filter.shardId !== undefined ? { shardId: filter.shardId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Every request of one account, open or closed — newest first. */
  /** The largest granted value among every quota request of one AWS ACCOUNT —
   *  across all its rows, so the merged account's two rows read one figure
   *  (MOTIR-9586). Null while none reads a granted value. */
  async maxGrantedForAwsAccountInTx(
    awsAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number | null> {
    const { _max } = await tx.fleetQuotaRequest.aggregate({
      _max: { grantedValue: true },
      where: { shard: { awsAccountId } },
    });
    return _max.grantedValue;
  },

  async listByShard(shardId: string, tx: Prisma.TransactionClient): Promise<FleetQuotaRequest[]> {
    return tx.fleetQuotaRequest.findMany({
      where: { shardId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The requests the growth pass owes an alert (MOTIR-9462), with their
   *  account's name: open since before `openBefore` and never alerted, or closed
   *  `denied` / `not_approved` and not alerted since the close. */
  async listToAlertInTx(
    openBefore: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Array<FleetQuotaRequest & { shard: { name: string } }>> {
    return tx.fleetQuotaRequest.findMany({
      where: {
        OR: [
          { closedAt: null, createdAt: { lt: openBefore }, alertedAt: null },
          {
            status: { in: ['denied', 'not_approved'] },
            closedAt: { not: null },
            OR: [{ alertedAt: null }, { alertedAt: { lt: tx.fleetQuotaRequest.fields.closedAt } }],
          },
        ],
      },
      include: { shard: { select: { name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  async markAlertedInTx(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetQuotaRequest.update({ where: { id }, data: { alertedAt: at } });
  },

  /** A kind's requests still open or closed since `closedSince`, with their
   *  account's name — newest first (MOTIR-9463's `pool-status`). */
  async listRecentByKindInTx(
    fleetKind: string,
    closedSince: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Array<FleetQuotaRequest & { shard: { name: string } }>> {
    return tx.fleetQuotaRequest.findMany({
      where: { fleetKind, OR: [{ closedAt: null }, { closedAt: { gte: closedSince } }] },
      include: { shard: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
