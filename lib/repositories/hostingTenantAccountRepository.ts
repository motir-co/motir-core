import { randomUUID } from 'node:crypto';
import type { HostingTenantAccount, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  TENANT_ACCOUNT_BRING_UP_STATES,
  type HostingTenantAccountState,
} from '@/lib/ciFleet/hostingTenantAccounts';

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
        "ou_id" AS "ouId", "quotas_checked_at" AS "quotasCheckedAt", "region",
        "handover_owner_email" AS "handoverOwnerEmail", "handover_github_owner" AS "handoverGithubOwner",
        "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;
    return rows[0]!;
  },

  /** Every row still being brought up (`requested`, `creating`, `bootstrapping`,
   *  `refused`), oldest first — what the reconcile walks. An account in a
   *  takeover handover state is not unready, so it is never listed (MOTIR-12126). */
  async listUnreadyInTx(tx: Prisma.TransactionClient): Promise<HostingTenantAccount[]> {
    return tx.hostingTenantAccount.findMany({
      where: { state: { in: [...TENANT_ACCOUNT_BRING_UP_STATES] } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Every row with its organisation's name, oldest first — what Fleet status
   *  lists (MOTIR-12014). */
  async listAllWithOrganizationInTx(
    tx: Prisma.TransactionClient,
  ): Promise<(HostingTenantAccount & { organization: { name: string } })[]> {
    return tx.hostingTenantAccount.findMany({
      include: { organization: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Every `ready` row, oldest first — what the deploy-policy convergence walks
   *  (MOTIR-10005). */
  async listReadyInTx(tx: Prisma.TransactionClient): Promise<HostingTenantAccount[]> {
    return tx.hostingTenantAccount.findMany({
      where: { state: 'ready' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Every `ready` row whose quota targets were last checked before `dueBefore`,
   *  or never, oldest check first — what the reconcile re-checks (MOTIR-12011). */
  async listReadyQuotaCheckDueInTx(
    dueBefore: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount[]> {
    return tx.hostingTenantAccount.findMany({
      where: {
        state: 'ready',
        OR: [{ quotasCheckedAt: null }, { quotasCheckedAt: { lt: dueBefore } }],
      },
      orderBy: [{ quotasCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    });
  },

  /** The row reached `ready` at `at`: its bootstrap has just checked the quota
   *  targets, so the next re-check is counted from then. */
  async markReadyInTx(
    organizationId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({
      where: { organizationId },
      data: { state: 'ready', quotasCheckedAt: at },
    });
  },

  /** A `ready` row's quota targets were checked at `at`. */
  async recordQuotasCheckedInTx(
    organizationId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({
      where: { organizationId },
      data: { quotasCheckedAt: at },
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

  /** The email address and GitHub owner the administrator names at takeover
   *  (MOTIR-12126) — kept so a restarted handover resumes with them. */
  async setHandoverOwnerInTx(
    organizationId: string,
    owner: { ownerEmail: string; githubOwner: string },
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantAccount> {
    return tx.hostingTenantAccount.update({
      where: { organizationId },
      data: { handoverOwnerEmail: owner.ownerEmail, handoverGithubOwner: owner.githubOwner },
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
