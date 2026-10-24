import type { FleetGrowthEvent, FleetGrowthOutcome, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the POOL GROWTH record (Story MOTIR-9362 · MOTIR-9457). The
// table's policy is `app.system_admin` only, so the caller holds a
// `withSystemContext` transaction.

export type FleetGrowthEventCreateInput = Prisma.FleetGrowthEventUncheckedCreateInput;

/** A growth CLAIM (MOTIR-9461): the row a pass writes before its AWS call, not
 *  yet settled — `waiting_for_quota` with no account created and no raise. */
const CLAIM: Prisma.FleetGrowthEventWhereInput = {
  outcome: 'waiting_for_quota',
  newShardId: null,
  quotaRequestId: null,
};

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

  /** The kind's newest UNFINISHED growth: not `refused`, and either the quota
   *  raise it waits on still open (read through the request, so no flag can
   *  drift) or an unsettled CLAIM written after `claimFreshAfter` (MOTIR-9461).
   *  Without `claimFreshAfter` no claim counts. */
  async findLatestUnfinishedByKind(
    fleetKind: string,
    tx?: Prisma.TransactionClient,
    claimFreshAfter?: Date,
  ): Promise<FleetGrowthEvent | null> {
    const client = tx ?? dbRead;
    return client.fleetGrowthEvent.findFirst({
      where: {
        fleetKind,
        OR: [
          { outcome: { not: 'refused' }, quotaRequest: { closedAt: null } },
          ...(claimFreshAfter ? [{ ...CLAIM, createdAt: { gt: claimFreshAfter } }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Settle a growth into what it did (MOTIR-9461): a claim into its one event,
   *  or a `waiting_for_quota` growth once its account joins the pool. */
  async settleInTx(
    id: string,
    data: {
      outcome: FleetGrowthOutcome;
      newShardId?: string | null;
      spareShardId?: string | null;
      quotaRequestId?: string | null;
      reason?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<FleetGrowthEvent> {
    return tx.fleetGrowthEvent.update({ where: { id }, data });
  },

  /** Drop an unsettled claim — a growth whose create was refused leaves no row
   *  of its own; the job records the refusal. */
  async deleteClaimInTx(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetGrowthEvent.deleteMany({ where: { id, ...CLAIM } });
  },

  /** The kind's `waiting_for_quota` growth that created `newShardId`, if any. */
  async findWaitingForShardInTx(
    fleetKind: string,
    newShardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetGrowthEvent | null> {
    return tx.fleetGrowthEvent.findFirst({
      where: { fleetKind, newShardId, outcome: 'waiting_for_quota' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
