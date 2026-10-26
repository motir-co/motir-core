import type { HostAccountAttempt, Prisma } from '@/generated/prisma/client';

// A Host organisation's refused account creations (Story MOTIR-9365 ·
// MOTIR-9582): one row per (organisation, slot), counts and times only. The
// reconcile's backoff reads it; platform-only — the caller holds a
// `withSystemContext` transaction.

export const hostAccountAttemptRepository = {
  async findInTx(
    organizationId: string,
    slot: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostAccountAttempt | null> {
    return tx.hostAccountAttempt.findUnique({
      where: { organizationId_slot: { organizationId, slot } },
    });
  },

  /** One more refusal in a row, at `at`. */
  async recordRefusalInTx(
    organizationId: string,
    slot: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostAccountAttempt> {
    return tx.hostAccountAttempt.upsert({
      where: { organizationId_slot: { organizationId, slot } },
      create: { organizationId, slot, refusedCount: 1, lastRefusedAt: at },
      update: { refusedCount: { increment: 1 }, lastRefusedAt: at },
    });
  },

  /** The slot's account exists: no refusal is outstanding. */
  async clearRefusalsInTx(
    organizationId: string,
    slot: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostAccountAttempt.updateMany({
      where: { organizationId, slot, refusedCount: { gt: 0 } },
      data: { refusedCount: 0 },
    });
  },
};
