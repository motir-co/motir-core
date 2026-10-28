import type { Prisma } from '@/generated/prisma/client';

// The subdomain change ledger — §8 Amendment 3 rule 4 (Story MOTIR-4528 ·
// MOTIR-9506). `prisma/schema.prisma`'s `model PublicSubdomainChange` carries the
// reasoning; `lib/publicAddresses/nameHold.ts` owns the 30-day rule. This file
// owns the queries and nothing else.
//
// `tx` REQUIRED on both methods: the only caller is a rename or release, which
// reads the ledger and writes it under the same workspace row lock, and a read
// taken outside that transaction would be a stale input to the limit.

export const publicSubdomainChangeRepository = {
  /** The workspace's last rename or release, or `null` if it has never changed its name. */
  async findByWorkspaceInTx(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ lastChangedAt: Date } | null> {
    return tx.publicSubdomainChange.findUnique({
      where: { workspaceId },
      select: { lastChangedAt: true },
    });
  },

  /** Record a rename or release at `changedAt` — one row per workspace, upserted. */
  async recordChangeInTx(
    workspaceId: string,
    changedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.publicSubdomainChange.upsert({
      where: { workspaceId },
      create: { workspaceId, lastChangedAt: changedAt },
      update: { lastChangedAt: changedAt },
    });
  },
};
