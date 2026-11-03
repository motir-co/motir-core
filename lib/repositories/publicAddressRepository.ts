import {
  Prisma,
  type PublicAddress,
  type PublicAddressFailureKind,
  type PublicAddressStatus,
} from '@/generated/prisma/client';

import { db } from '@/lib/db';
import { HostnameTakenError, isHostnameUniqueViolation } from '@/lib/publicAddresses/errors';

// The public-address data layer — Story MOTIR-3878 · Subtask MOTIR-4209.
// `docs/decisions/public-tenant-addresses.md` is the record; the model's own
// doc comments in `prisma/schema.prisma` carry the shape.
//
// Single Prisma operation per method, `tx` REQUIRED on every write, no business
// logic and no transactions — `CLAUDE.md`'s 4-layer contract. The services above
// (MOTIR-4215 claim/rename, MOTIR-4216 the customer-domain lifecycle) own the
// transactions and the rules; this file owns the queries.
//
// ── The ONE thing here that is not a bare query ────────────────────────────
//
// Both create methods translate a unique-constraint violation into
// `HostnameTakenError`. That is business-shaped and it still belongs here,
// because the constraint is a database object and this is the only layer holding
// the Prisma call that raises it — the alternative is every caller matching on
// `P2002` themselves, which is what `CLAUDE.md`'s concurrency rule exists to
// prevent ("a raw DB error never escapes the service").

export const publicAddressRepository = {
  // ── Reads ────────────────────────────────────────────────────────────────

  /** One address by id, inside the caller's transaction. */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<PublicAddress | null> {
    return tx.publicAddress.findUnique({ where: { id } });
  },

  /**
   * Resolve a hostname to its address row — the read the public host contract
   * (MOTIR-4217) makes on every request, ANONYMOUSLY.
   *
   * Uses the `db` singleton with no workspace context, which is what the
   * migration's `public_address_public_read` RLS arm exists to admit: the whole
   * question is which tenant a hostname belongs to, so binding a workspace first
   * would presume the answer. That arm is narrow — a workspace subdomain only when
   * its workspace has a public project, a customer domain only once its
   * certificate is issued (MOTIR-9523) — so anything else resolves to `null`
   * here rather than leaking that it exists.
   */
  async findByHostname(hostname: string): Promise<PublicAddress | null> {
    return db.publicAddress.findUnique({ where: { hostname } });
  },

  /**
   * The same read INSIDE a transaction — the guard a write runs before it acts.
   * Separate from {@link findByHostname} rather than an optional `tx`, per the
   * layer rule: a read that gates a write and a read that answers a request are
   * different methods even when the query is identical.
   */
  async findByHostnameInTx(
    hostname: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress | null> {
    return tx.publicAddress.findUnique({ where: { hostname } });
  },

  /**
   * Every customer domain of one workspace, oldest first (ADR MOTIR-9521 §1: a
   * domain is a workspace asset naming at most one application).
   *
   * Takes the caller's `tx`. Its consumer is the customer-domain lifecycle,
   * which always runs inside a bound workspace context — so this is a tenant
   * read, and the tenancy policy scopes it as well as the `where` clause.
   */
  async listCustomDomainsForWorkspaceInTx(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress[]> {
    return tx.publicAddress.findMany({
      where: { workspaceId, kind: 'custom_domain' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every address in one workspace — its live subdomain, its retained aliases,
   * and every customer domain it holds — INSIDE the caller's transaction.
   *
   * ⚠️ There is deliberately no singleton twin, and the `tx` is not a convenience.
   * The singleton read is a DIFFERENT CONNECTION: called from inside a
   * transaction it cannot see that transaction's uncommitted writes, and it
   * carries none of the transaction's GUCs, so under the non-bypass app role RLS
   * hides every row. A service that writes and then reads back to build its DTO
   * needs this one — using the other returns `null` for a claim that just
   * succeeded, which is exactly how this method came to exist.
   */
  async listForWorkspaceInTx(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress[]> {
    return tx.publicAddress.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The workspace's LIVE subdomain, or `null` if it has never claimed one.
   *
   * `findFirst`, not `findUnique`: "exactly one live subdomain per workspace" is
   * a rule the service holds inside its transaction, not a database constraint,
   * because the alias rows share the workspace and a partial unique index over
   * `(workspace_id) WHERE kind = 'workspace_subdomain'` would collide with the
   * `@@index([workspaceId])` column list — the permanent-spurious-RENAME shape
   * `CLAUDE.md`'s second migration rule describes. The `hostname` unique is what
   * actually arbitrates the race; this read is the service's own guard.
   */
  async findLiveSubdomainForWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress | null> {
    return tx.publicAddress.findFirst({
      where: { workspaceId, kind: 'workspace_subdomain' },
    });
  },

  /**
   * How many CUSTOM DOMAINS an organization holds — the entitlement cap's count
   * (MOTIR-4228, ADR §9).
   *
   * Counted across the org's workspaces, because that is the scope every other
   * §4 cap uses (`countByOrganization` on work items, projects, workspaces). The
   * join is on `workspace.organizationId`; there is no denormalized org column
   * on this table and adding one to save a join would be the second place the
   * same fact lives.
   *
   * Through `app_org_custom_domain_count` (MOTIR-10116), not a Prisma count: the
   * caller's `tx` is bound to ONE workspace, and `public_address`'s tenancy
   * policy hides the org's other workspaces from any invoker read, so a plain
   * count undercounted to that workspace. The function counts the whole org,
   * and only for the org that owns the bound workspace — 0 for any other.
   */
  async countCustomDomainsByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT app_org_custom_domain_count(${organizationId}) AS count
    `;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * The certificate job's sweep (MOTIR-4219): addresses in one state that have
   * not been checked since `before`, oldest first.
   *
   * A NULL `last_checked_at` — never checked — sorts FIRST under Postgres's
   * `NULLS FIRST` for ascending order, which is what the job wants: a row nobody
   * has ever asked the platform about is the most urgent, not the least.
   *
   * Takes a `tx`: the sweep runs ACROSS tenants, so the job binds a system
   * context for it. Left on the `db` singleton it would be an unbound read that
   * the public arm silently narrows to what is publicly readable — returning a
   * plausible, wrong subset rather than failing.
   */
  async listByStatusOlderThan(
    status: PublicAddressStatus,
    before: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress[]> {
    return tx.publicAddress.findMany({
      where: { status, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: before } }] },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
  },

  // ── Writes (every one takes `tx`) ────────────────────────────────────────

  /**
   * Claim a workspace subdomain. `status: 'active'`, no project, no verification
   * token — a subdomain of our own base is covered by the wildcard certificate
   * (ADR §6) and needs no ownership proof.
   */
  async createSubdomain(
    input: { workspaceId: string; hostname: string },
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    try {
      return await tx.publicAddress.create({
        data: {
          workspaceId: input.workspaceId,
          hostname: input.hostname,
          kind: 'workspace_subdomain',
          status: 'active',
        },
      });
    } catch (err) {
      if (isHostnameUniqueViolation(err)) throw new HostnameTakenError(input.hostname);
      throw err;
    }
  },

  /**
   * Connect a customer domain to the workspace, optionally naming the
   * application it serves (ADR MOTIR-9521 §1). Starts `unverified` with its
   * `_motir-verify` token — the ADR §5 order is strict that a certificate is
   * never requested before the TXT resolves, and starting anywhere else would
   * make that order unrepresentable.
   */
  async createCustomDomain(
    input: {
      workspaceId: string;
      applicationId: string | null;
      hostname: string;
      verificationToken: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    try {
      return await tx.publicAddress.create({
        data: {
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          hostname: input.hostname,
          kind: 'custom_domain',
          status: 'unverified',
          verificationToken: input.verificationToken,
        },
      });
    } catch (err) {
      if (isHostnameUniqueViolation(err)) throw new HostnameTakenError(input.hostname);
      throw err;
    }
  },

  /**
   * Move an address to a new status, recording what the platform said.
   *
   * `failureReason` is written on EVERY call rather than only on a failure, so a
   * row leaving `failed` for `issued` clears the stale reason instead of carrying
   * a resolved error into a healthy state. The caller passes `null` for it on the
   * happy path; the parameter is required so that is a decision rather than an
   * omission.
   */
  async updateStatus(
    addressId: string,
    patch: {
      status: PublicAddressStatus;
      failureReason: string | null;
      failureKind?: PublicAddressFailureKind | null;
      lastCheckedAt?: Date;
      issuedAt?: Date | null;
      /**
       * Only ever a date: a write not given one leaves the stored expiry alone,
       * because a reading that carried no date is not evidence there is none.
       */
      certificateExpiresAt?: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    // A cleared reason clears its KIND too (MOTIR-9526), so the lifecycle's
    // Re-check — which knows nothing of kinds — cannot leave a stale one behind.
    const data = patch.failureReason === null ? { ...patch, failureKind: null } : patch;
    return tx.publicAddress.update({ where: { id: addressId }, data });
  },

  /**
   * Name the application a customer domain serves, or unbind it with `null`
   * (ADR MOTIR-9521 §1). The service has already asserted the application is
   * the workspace's own.
   */
  async setApplication(
    addressId: string,
    applicationId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    return tx.publicAddress.update({ where: { id: addressId }, data: { applicationId } });
  },

  /**
   * Remove an address.
   *
   * A removed custom domain, and a workspace subdomain that is renamed or
   * released (§8 Amendment 3 rule 2: it stops being served in that
   * transaction). Which hostnames are HELD when they go is the service's rule,
   * not this layer's.
   */
  async remove(addressId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.publicAddress.delete({ where: { id: addressId } });
  },

  /**
   * Up to `limit` legacy `workspace_subdomain_alias` rows, oldest first — the
   * one-off cleanup's batch read (Story MOTIR-4528 · MOTIR-9520).
   *
   * Selected by KIND, explicitly, so the cleanup that deletes what this returns
   * can never reach a live subdomain or a custom domain. Read under the system
   * arm: the rows belong to every workspace.
   */
  async listAliasesInTx(limit: number, tx: Prisma.TransactionClient): Promise<PublicAddress[]> {
    return tx.publicAddress.findMany({
      where: { kind: 'workspace_subdomain_alias' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * Remove a SET of addresses in one statement — a bulk delete with no rule
   * about WHICH ids belong in the set (ADR §8 Amendment 2, MOTIR-4454). The
   * caller chooses them, through `reservesItsHostname` where a hold is owed.
   */
  async removeMany(addressIds: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    if (addressIds.length === 0) return 0;
    const { count } = await tx.publicAddress.deleteMany({
      where: { id: { in: [...addressIds] } },
    });
    return count;
  },
};
