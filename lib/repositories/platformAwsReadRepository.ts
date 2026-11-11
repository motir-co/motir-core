import type { Prisma } from '@/generated/prisma/client';

/**
 * The last SUCCESSFUL read of an AWS figure the console shows live (MOTIR-10890)
 * — one row per subject, upserted when a read answers. It records WHEN and in
 * WHICH account, never the figure: a later read that fails names the time and
 * shows no number.
 *
 * Both methods take `tx`: the table is platform-staff only, read and write
 * (`app.platform_staff`), so they run inside the page read's `withPlatformRead`.
 */

export interface PlatformAwsReadRow {
  subject: string;
  accountId: string | null;
  readAt: Date;
}

const ROW = { subject: true, accountId: true, readAt: true } as const;

export const platformAwsReadRepository = {
  /** The rows for these subjects; a subject never read has none. */
  async findMany(subjects: string[], tx: Prisma.TransactionClient): Promise<PlatformAwsReadRow[]> {
    return tx.platformAwsRead.findMany({ where: { subject: { in: subjects } }, select: ROW });
  },

  /** Mark a subject read at `readAt`, keeping the stored account when none is given. */
  async markRead(
    input: { subject: string; accountId?: string | null; readAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAwsReadRow> {
    const { subject, readAt } = input;
    const accountId = input.accountId ?? undefined;
    return tx.platformAwsRead.upsert({
      where: { subject },
      create: { subject, readAt, accountId: accountId ?? null },
      update: { readAt, ...(accountId === undefined ? {} : { accountId }) },
      select: ROW,
    });
  },
};
