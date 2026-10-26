import {
  type Organization,
  type OrganizationMembership,
  type OrganizationRole,
  Prisma,
  type User,
} from '@/generated/prisma/client';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';

// A membership row joined with the slice of its user the cross-workspace member
// roster (6.10.5) renders. Kept here (not in the service) because the join shape
// is a data-access concern; the service maps it to a DTO.
export type OrgMembershipWithUser = OrganizationMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

// A membership row joined with the organization state the access gate reads
// (MOTIR-748 — a suspended org refuses its members on every door).
export type OrgMembershipWithOrgState = OrganizationMembership & {
  organization: Pick<Organization, 'id' | 'name' | 'suspendedAt'>;
};

// OrganizationMembership repository — single Prisma operations on the
// `organization_membership` join table (Story 6.10). Owns its own file (not
// nested under organizationRepository) because the primary entity it operates on
// is OrganizationMembership, not Organization. Mirrors
// `workspaceMembershipRepository`: writes require `tx`, reads that guard a write
// take `tx` so the RLS policy's org/user GUCs admit the row under the non-bypass
// `motir_app` role. The membership-gating logic + the cross-workspace roster
// pagination live in `organizationsService` (6.10.4).

/**
 * Optional narrowing of the roster page (MOTIR-6313). `q` matches a member's
 * name or email, case-insensitively; `excludeOwner` leaves the Owner's row out —
 * the transfer dialog's picker, which never offers the Owner. Both apply to the
 * page AND its count, so the pager's total describes the list it pages.
 */
export interface OrgMemberPageFilter {
  q?: string | null;
  excludeOwner?: boolean;
}

function memberPageWhere(
  organizationId: string,
  filter: OrgMemberPageFilter,
): Prisma.OrganizationMembershipWhereInput {
  const q = filter.q?.trim();
  return {
    organizationId,
    ...(filter.excludeOwner ? { role: { not: ORGANIZATION_ROLE.owner } } : {}),
    ...(q
      ? {
          user: {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };
}

export const organizationMembershipRepository = {
  /**
   * The membership lookup, inside the caller's transaction so the
   * organization_membership RLS policy (keyed off the per-transaction
   * `app.organization_id` / `app.user_id` GUCs) admits the row under the
   * non-bypass `motir_app` role. Used by the 6.10.4 access gate, whose result
   * must be correct in production.
   *
   * The `…InTx` suffix is now vestigial and kept only so the six call sites in
   * `organizationsService` need not churn: the un-suffixed singleton variant was
   * retired in MOTIR-2775, having had zero production callers and returning NULL
   * under RLS by design.
   */
  async findByOrgAndUserInTx(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership | null> {
    return tx.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  },

  /**
   * {@link findByOrgAndUserInTx} with the slice of the ORGANIZATION the access
   * gate decides on — its suspension (MOTIR-748). One query: the org is visible
   * to its own member under `organization_membership_visible`, so the join costs
   * the gate no extra round trip and no extra RLS arm.
   */
  async findByOrgAndUserWithOrgStateInTx(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgMembershipWithOrgState | null> {
    return tx.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: { select: { id: true, name: true, suspendedAt: true } } },
    });
  },

  /**
   * Is `userId` the OWNER or an ADMIN of the organization that owns
   * `workspaceId`? — the org roles that reach every workspace of the org as its
   * Manager, member or not (Story MOTIR-6168; `role-model.md` AMENDMENT
   * 2026-09-26, which overturned reading R1 at the MOTIR-6456 design gate). Same
   * one round trip — the project permission gate asks it on every resolution
   * for an actor who is not already a Manager.
   *
   * ⚠️ BINDING: the caller's `tx` must bind `app.workspace_id` to `workspaceId`
   * (a `withWorkspaceContext` body). The `workspace` row is admitted by
   * `workspace_active` off that GUC — a non-member has no
   * `workspace_membership_visible` arm to fall back on — and the membership row
   * by the "or your own" arm of `org_membership_visible_active_or_own`, keyed on
   * `app.user_id`. Unbound, the join sees no workspace and answers `false`,
   * which fails CLOSED (treated as a non-member), never open.
   */
  async isOrgManagerOfWorkspaceOrg(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one
      FROM "workspace" w
      JOIN "organization_membership" om ON om."organizationId" = w."organizationId"
      WHERE w."id" = ${workspaceId}
        AND om."userId" = ${userId}
        AND om."role" IN ('owner', 'admin')
      LIMIT 1
    `;
    return rows.length > 0;
  },

  /**
   * {@link findByOrgAndUserInTx}, taking a ROW LOCK (`FOR UPDATE`) on the
   * membership — the lock-then-re-read the one-Owner guards use before they
   * decide on a role (MOTIR-6307): a transfer committing concurrently blocks on
   * this row or is blocked by it, so the decision is made on the committed role,
   * never a stale one. `tx` REQUIRED — a row lock lives only for its transaction.
   */
  async findByOrgAndUserForUpdate(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership | null> {
    const rows = await tx.$queryRaw<OrganizationMembership[]>`
      SELECT * FROM "organization_membership"
      WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * The organizations a user belongs to, ordered by membership.createdAt asc so
   * the auto-provisioned default org (6.10.4 signup flow) lands first in the
   * switcher list (6.10.5). Mirrors workspaceMembershipRepository.findWorkspacesByUser.
   *
   * Takes `tx` for the same reason `findMembersByOrg` below does, and it is REQUIRED
   * rather than optional (MOTIR-2774): both call sites already ran inside
   * `withUserContext`, and both discarded the transaction it handed them, so the read
   * went to the `@/lib/db` singleton where the membership policy sees no
   * `app.user_id`. It then returned an EMPTY ARRAY AND RAISED NOTHING — the org
   * switcher rendered empty and `resolveActiveOrganization` reported that the user
   * belonged to no organization at all. An optional `tx` would have left exactly that
   * mistake available to the next caller; a required one makes it a type error.
   */
  async findOrganizationsByUser(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Organization[]> {
    const rows = await tx.organizationMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { organization: true },
    });
    return rows.map((r) => r.organization);
  },

  /**
   * Members of an organization joined with the user fields the roster renders,
   * ordered by membership.createdAt asc so the owner (first membership) lands
   * first. Takes `tx` because the organization_membership RLS policy reads the
   * per-transaction GUCs bound by the 6.10.4 org-context layer; outside that
   * transaction the policy sees NULL and returns zero rows under the non-bypass
   * app role. The PAGINATED cross-workspace roster (the at-scale read) is
   * assembled in the service (6.10.4) on top of this.
   */
  async findMembersByOrg(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgMembershipWithUser[]> {
    return tx.organizationMembership.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  /**
   * Count of memberships in an organization. Takes `tx` so a last-owner guard in
   * the service (6.10.4) can read the count and mutate in the same transaction,
   * preventing a TOCTOU race (mirrors workspaceMembershipRepository.countByWorkspace).
   */
  async countByOrg(
    organizationId: string,
    tx: Prisma.TransactionClient,
    filter: OrgMemberPageFilter = {},
  ): Promise<number> {
    return tx.organizationMembership.count({ where: memberPageWhere(organizationId, filter) });
  },

  /**
   * The user ids of every member of `organizationId` (MOTIR-9660), whatever the
   * role. The caller's `tx` must bind `app.organization_id` to this org: these
   * are other people's rows.
   */
  async findUserIdsByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.organizationMembership.findMany({
      where: { organizationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  /**
   * The user ids holding the OWNER or an ADMIN role in `organizationId` — each a
   * Manager of every workspace of the org (MOTIR-6168), whose workspace role the
   * Members page shows locked (MOTIR-6456 panel 6a). The caller's `tx` must bind
   * `app.organization_id` to this org: these are other people's rows.
   */
  async findManagerUserIdsByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.organizationMembership.findMany({
      where: { organizationId, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  /**
   * The organizations `userId` is the OWNER or an ADMIN of — the org roles that
   * reach every workspace of the org (MOTIR-6168). Oldest membership first; the
   * workspace switcher lists each one's workspaces.
   */
  async findManagedOrganizationsByUser(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Organization[]> {
    const rows = await tx.organizationMembership.findMany({
      where: { userId, role: { in: [ORGANIZATION_ROLE.owner, ORGANIZATION_ROLE.admin] } },
      orderBy: { createdAt: 'asc' },
      include: { organization: true },
    });
    return rows.map((r) => r.organization);
  },

  /**
   * The organizations a user is an OWNER of, ordered by membership.createdAt asc
   * (the same order {@link findOrganizationsByUser} uses, so the erasure
   * preview's blocking organization is deterministic when a reader owns more
   * than one).
   *
   * Used by the account-erasure impact preview (MOTIR-3699): only the OWNER's
   * membership is locked against removal (`OwnerMembershipLockedError`,
   * MOTIR-6307), so this is the candidate set the block is computed over — a
   * non-owner membership can always be removed and needs no per-org read at all.
   *
   * `tx` REQUIRED, for the reason {@link findOrganizationsByUser} spells out: the
   * `org_membership_visible_active_or_own` policy admits the caller's OWN rows
   * off `app.user_id`, which only a bound transaction supplies. Unbound it
   * returns an EMPTY ARRAY and raises nothing — which the preview would render
   * as "nothing blocks you".
   */
  async findOwnedOrganizationsByUser(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Organization[]> {
    const rows = await tx.organizationMembership.findMany({
      where: { userId, role: ORGANIZATION_ROLE.owner },
      orderBy: { createdAt: 'asc' },
      include: { organization: true },
    });
    return rows.map((r) => r.organization);
  },

  /**
   * Count of OWNER memberships in an organization. Exactly one on every
   * organization since MOTIR-6307 (the one-owner partial unique index holds "at
   * most one", the member paths refuse to remove or demote the Owner), so the
   * account-erasure preview reads it as a consistency check rather than a race:
   * it writes nothing and decides nothing, and takes no lock.
   *
   * `tx` REQUIRED: `organization_membership`'s policy admits the ACTIVE org's
   * rows off `app.organization_id`, so counting the OTHER owners needs an
   * `withOrgContext` binding. Unbound, this returns the caller's own row only.
   */
  async countOwnersByOrg(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.organizationMembership.count({
      where: { organizationId, role: ORGANIZATION_ROLE.owner },
    });
  },

  /**
   * One keyset-paginated PAGE of an org's members joined with the user fields
   * the roster renders, ordered by (createdAt asc, id asc) so the owner (first
   * membership) leads and the order is stable across pages. Returns up to
   * `limit + 1` rows so the service can detect "is there a next page?" and
   * compute the next cursor without a second count. `cursorId` is the last
   * membership id of the previous page (Prisma `cursor` + `skip: 1`); omit it
   * for the first page. This is the at-scale read (finding #57) — a large org's
   * roster is NEVER loaded whole. Takes `tx` so the RLS policy's per-transaction
   * GUCs admit the rows.
   */
  async findMembersByOrgPage(
    organizationId: string,
    limit: number,
    cursorId: string | null,
    tx: Prisma.TransactionClient,
    filter: OrgMemberPageFilter = {},
  ): Promise<OrgMembershipWithUser[]> {
    return tx.organizationMembership.findMany({
      where: memberPageWhere(organizationId, filter),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  async create(
    data: { organizationId: string; userId: string; role: OrganizationRole },
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership> {
    return tx.organizationMembership.create({ data });
  },

  /**
   * The orgs a user OWNS or ADMINS, each with its scaled-tracker subscription
   * state AND its `isMeta` flag — the input to the §4.5 org-creation gate
   * (8.1.11): a 2nd+ org requires the user to own/admin ≥1 org that is either
   * scaled-active OR the meta org, and an empty result means "this is the user's
   * first org" (always free). Joins `organization_membership → organization` so
   * one read yields the count, the per-org subscription, and the exemption flag.
   * Takes `tx` so it runs in the create's transaction. Raw SQL keeps it
   * context-independent (it spans orgs the active GUC doesn't scope to).
   */
  async findOwnerAdminOrgsWithSubscription(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      organizationId: string;
      scaledTrackerSubscription: Prisma.JsonValue | null;
      isMeta: boolean;
    }>
  > {
    return tx.$queryRaw<
      Array<{
        organizationId: string;
        scaledTrackerSubscription: Prisma.JsonValue | null;
        isMeta: boolean;
      }>
    >`
      SELECT m."organizationId" AS "organizationId",
             o."scaledTrackerSubscription" AS "scaledTrackerSubscription",
             o."isMeta" AS "isMeta"
      FROM "organization_membership" m
      JOIN "organization" o ON o."id" = m."organizationId"
      WHERE m."userId" = ${userId} AND m."role" IN ('owner', 'admin')
    `;
  },

  async updateRole(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership> {
    return tx.organizationMembership.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    });
  },

  /**
   * Returns the deleted membership row, or null if no matching row existed
   * (treats "already gone" as a no-op rather than an error — the remove flow in
   * 6.10.5 relies on this, mirroring workspaceMembershipRepository.deleteByUserAndWorkspace).
   */
  async deleteByOrgAndUser(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership | null> {
    try {
      return await tx.organizationMembership.delete({
        where: { organizationId_userId: { organizationId, userId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },

  /** Remove EVERY membership of an organization — the erasure tombstone's
   *  (MOTIR-6400). Requires `app.organization_id` bound
   *  (`org_membership_delete_active_or_self`). Returns the delete count. */
  async deleteAllByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.organizationMembership.deleteMany({ where: { organizationId } });
    return result.count;
  },

  /**
   * Drop every organization membership this user holds — the erasure sweep's
   * org arm (MOTIR-3702).
   *
   * ⚠️ IT DOES NOT CONSULT the Owner lock (`OwnerMembershipLockedError`,
   * MOTIR-6307), AND THAT GUARD IS STILL HONOURED — one tier up, as a READ. `accountErasureService.previewAccountErasure`
   * computes the block (sole owner of a SHARED organization) and the sweep
   * REFUSES to erase a blocked account at all, leaving the request scheduled for
   * a later tick. So by the time this runs, either no organization the user owns
   * has other members, or the ownership has been handed over. Re-deriving the
   * verdict here would need every owned org's owner count on a transaction bound
   * to `app.user_id`, which cannot see them (`organization_membership` narrows to
   * the reader's OWN rows).
   *
   * Removed in the sweep's LAST step, after the workspace deletes, for the
   * reason `workspaceMembershipRepository.deleteAllByUser` carries: the
   * workspace-delete gate resolves through the ORG tier, so dropping this row
   * first makes that delete refuse.
   */
  async deleteAllByUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.organizationMembership.deleteMany({ where: { userId } });
    return count;
  },
};
