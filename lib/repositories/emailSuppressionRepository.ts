import type { EmailSuppression, EmailSuppressionReason, Prisma } from '@/generated/prisma/client';

// Data access for the email suppression list (MOTIR-10565). Single-op methods
// only; writes require `tx` (the 4-layer contract). `emailSuppressionService`
// owns the transactions, the address normalisation and the system context the
// table's policy needs.

export interface EmailSuppressionWrite {
  /** Already normalised by the service — trimmed and lower-cased. */
  address: string;
  reason: EmailSuppressionReason;
  provider: string;
  detail: string | null;
  providerMessageId: string | null;
}

export const emailSuppressionRepository = {
  /**
   * Suppress an address, or refresh the row that already suppresses it. The
   * unique `address` makes a second event for one address an UPDATE: the
   * reason and its evidence follow the latest event, and `createdAt` keeps
   * when the address was first suppressed.
   */
  async upsert(
    data: EmailSuppressionWrite,
    tx: Prisma.TransactionClient,
  ): Promise<EmailSuppression> {
    const { address, ...rest } = data;
    return tx.emailSuppression.upsert({
      where: { address },
      create: data,
      update: rest,
    });
  },

  /** The row suppressing this (normalised) address, or null. */
  async findByAddress(
    address: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmailSuppression | null> {
    return tx.emailSuppression.findUnique({ where: { address } });
  },
};
