import { Prisma, type PublicAddress, type PublicAddressStatus } from '@/generated/prisma/client';

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
   * would presume the answer. That arm is narrow — it admits a row only when
   * what it points at is public — so a private project's domain resolves to
   * `null` here rather than leaking that it exists.
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
   * The workspace's LIVE subdomain, read ANONYMOUSLY — the alias-redirect half
   * of host resolution (MOTIR-4217).
   *
   * Separate from {@link findLiveSubdomainForWorkspace}, which takes a `tx`
   * because it guards a write. This one answers a public request that has no
   * workspace bound at all, so it goes through the `db` singleton and is
   * admitted by the migration's `public_address_public_read` arm — which means
   * a workspace holding no public project resolves to `null` here rather than
   * leaking that it has a subdomain.
   */
  async findLiveSubdomainForWorkspacePublic(workspaceId: string): Promise<PublicAddress | null> {
    return db.publicAddress.findFirst({
      where: { workspaceId, kind: 'workspace_subdomain' },
    });
  },

  /**
   * Every address across SEVERAL workspaces, in one query — the batched read
   * behind the crawl index's per-row canonical host (MOTIR-4217).
   *
   * A page of the index is up to a hundred projects, and asking per project
   * would be a hundred sequential round trips to answer one sitemap build. One
   * `IN` is the whole cost.
   */
  async listForWorkspaces(workspaceIds: readonly string[]): Promise<PublicAddress[]> {
    if (workspaceIds.length === 0) return [];
    return db.publicAddress.findMany({
      where: { workspaceId: { in: [...workspaceIds] } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every address belonging to one project (its customer domains).
   *
   * Takes the caller's `tx`. Its consumer is the customer-domain lifecycle
   * (MOTIR-4216), which always runs inside a bound workspace context — so this
   * is a tenant read, not an anonymous one, and binding it is what makes the
   * tenancy policy do the scoping instead of the `where` clause.
   */
  async listForProjectInTx(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress[]> {
    return tx.publicAddress.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every address in one workspace — its live subdomain, its retained aliases,
   * and every customer domain of every project under it.
   */
  async listForWorkspace(workspaceId: string): Promise<PublicAddress[]> {
    return db.publicAddress.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The same list INSIDE the caller's transaction.
   *
   * ⚠️ NOT an optional `tx` on {@link listForWorkspace}, and not a convenience.
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
   */
  async countCustomDomainsByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.publicAddress.count({
      where: { kind: 'custom_domain', workspace: { organizationId } },
    });
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
   * the public arm silently narrows to public projects only — returning a
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
   * Connect a customer domain to one project. Starts `unverified` with its
   * `_motir-verify` token — the ADR §5 order is strict that a certificate is
   * never requested before the TXT resolves, and starting anywhere else would
   * make that order unrepresentable.
   */
  async createCustomDomain(
    input: {
      workspaceId: string;
      projectId: string;
      hostname: string;
      verificationToken: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    try {
      return await tx.publicAddress.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
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
      lastCheckedAt?: Date;
      issuedAt?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PublicAddress> {
    return tx.publicAddress.update({ where: { id: addressId }, data: patch });
  },

  /**
   * Make one address the project's canonical one — the ADR §7 *make primary*.
   * Writes `project.primaryAddressId`, not a column on the address: the FK is
   * the constraint that makes "exactly one" hold.
   *
   * `null` restores the default rule (the subdomain path when one is claimed,
   * else `motir.co/p/<identifier>`), which is what removing the primary address
   * must fall back to.
   */
  async setPrimary(
    projectId: string,
    addressId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.project.update({
      where: { id: projectId },
      data: { primaryAddressId: addressId },
    });
  },

  /**
   * Remove an address.
   *
   * A removed custom domain, and a workspace subdomain that is renamed or
   * released (§8 Amendment 3 rule 2: it stops being served in that
   * transaction). Which hostnames are HELD when they go is the service's rule,
   * not this layer's. The `SET NULL` on `project.primary_address_id` means a
   * project whose primary this was falls back to the default rather than being
   * deleted with it.
   */
  async remove(addressId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.publicAddress.delete({ where: { id: addressId } });
  },

  /**
   * Remove a SET of addresses in one statement — a bulk delete with no rule
   * about WHICH ids belong in the set (ADR §8 Amendment 2, MOTIR-4454). The
   * caller chooses them, through `reservesItsHostname` where a hold is owed.
   *
   * The `SET NULL` on `project.primary_address_id` applies exactly as it does
   * to {@link remove}, so a project whose primary was the released subdomain
   * falls back to §7's default rather than being deleted with it. That is why
   * there is no companion `setPrimary(null)` sweep: adding one would be a
   * second, hand-run copy of a constraint the database already enforces.
   */
  async removeMany(addressIds: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    if (addressIds.length === 0) return 0;
    const { count } = await tx.publicAddress.deleteMany({
      where: { id: { in: [...addressIds] } },
    });
    return count;
  },
};
