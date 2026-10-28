import { randomUUID } from 'node:crypto';
import type { HostingTenantAccount, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { HostingTenantAccountState } from '@/lib/ciFleet/hostingTenantAccounts';

// An organisation's AWS hosting account record (Story MOTIR-9792 · MOTIR-9939):
// one row per organisation — the account id once known, the state, the
// consecutive refusals and the OU. Never a `fleet_shard` row. Platform-only — the
// caller holds a `withSystemContext` transaction.

export const hostingTenantAccountRepository = {
  async findByOrganizationId(
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount | null> {
    const client = tx ?? dbRead;
    return client.hostingTenantAccount.findUnique({ where: { organizationId } });
  },

  /** The organisation's row — created in `requested` when there is none, else
   *  returned unchanged. One statement, `INSERT … ON CONFLICT` on the unique
   *  organisation: two callers at once leave ONE row, the loser's insert becoming
   *  a no-op update of the winner's. Raw SQL because Prisma's `upsert` is a
   *  select-then-insert here and loses that race with a unique violation. */
  async ensureRequestedInTx(
    organizationId: string,
    region: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    const rows = await tx.$queryRaw<HostingTenantAccount[]>`
      INSERT INTO "hosting_tenant_account"
        ("id", "organization_id", "state", "region", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${organizationId}, 'requested', ${region}, NOW(), NOW())
      ON CONFLICT ("organization_id")
      DO UPDATE SET "organization_id" = EXCLUDED."organization_id"
      RETURNING "id", "organization_id" AS "organizationId", "aws_account_id" AS "awsAccountId",
        "state", "refused_count" AS "refusedCount", "last_refused_at" AS "lastRefusedAt",
        "ou_id" AS "ouId", "region", "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;
    return rows[0]!;
  },

  /** Every row not yet `ready`, oldest first — what the reconcile walks. */
  async listUnreadyInTx(tx: Prisma.TransactionClient): Promise<HostingTenantAccount[]> {
    return tx.hostingTenantAccount.findMany({
      where: { state: { not: 'ready' } },
      orderBy: { createdAt: 'asc' },
    });
  },

  async setStateInTx(
    organizationId: string,
    state: HostingTenantAccountState,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({ where: { organizationId }, data: { state } });
  },

  /** The AWS account and the OU it sits under, once the account is found. */
  async recordAccountInTx(
    organizationId: string,
    awsAccountId: string,
    ouId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({
      where: { organizationId },
      data: { awsAccountId, ouId },
    });
  },

  /** One more `CreateAccount` refusal in a row, at `at`. */
  async recordRefusalInTx(
    organizationId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({
      where: { organizationId },
      data: { refusedCount: { increment: 1 }, lastRefusedAt: at },
    });
  },

  /** The account exists: no refusal is outstanding. */
  async clearRefusalsInTx(organizationId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.hostingTenantAccount.updateMany({
      where: { organizationId, refusedCount: { gt: 0 } },
      data: { refusedCount: 0 },
    });
  },
};
