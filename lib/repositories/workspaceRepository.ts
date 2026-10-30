import { Prisma, type Workspace } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Workspace repository — single Prisma operations on the `workspace` table.
// Membership operations live in workspaceMembershipRepository — the
// primary entity is `WorkspaceMembership`, not `Workspace`, even though
// the workspace is the parent.

export const workspaceRepository = {
  /**
   * Take the workspace row's `FOR UPDATE` lock, and report whether it matched.
   *
   * The serialization anchor for the subdomain claim/rename (Story MOTIR-3878 ·
   * MOTIR-4215), mirroring `organizationRepository.lockByIdForUpdate` — a
   * workspace subdomain is a workspace-level resource, so the workspace row is
   * the single row all of one workspace's claims contend on.
   *
   * ⚠️ Returns `false` rather than throwing when the row matched NOTHING. A
   * `SELECT … FOR UPDATE` over zero rows locks nothing and reports success, so a
   * caller that ignores this has a guard that silently does not serialize —
   * which is the failure `entitlementsService`'s `lockOrgRowOrRefuse` header
   * describes at length. The service turns a `false` into a refusal.
   */
  async lockByIdForUpdate(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workspace" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  /**
   * Make `applicationId` the workspace's DEFAULT application — only when it has
   * none (Decision MOTIR-9790 §2; Story MOTIR-9797 · MOTIR-10026). The condition
   * is in the statement, so a default a person already chose is never
   * overwritten. Returns whether the row changed.
   */
  async setDefaultApplicationIfUnset(
    id: string,
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.workspace.updateMany({
      where: { id, defaultApplicationId: null },
      data: { defaultApplicationId: applicationId },
    });
    return count > 0;
  },

  /**
   * BINDABLE (MOTIR-2789). `workspace` is a tenant-root table with no public arm, so a
   * caller that knows the workspace must be able to bind it — the public project
   * overview reads the project's own workspace and got null otherwise.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Workspace | null> {
    const client = tx ?? dbRead;
    return client.workspace.findUnique({ where: { id } });
  },

  async findBySlug(slug: string, tx?: Prisma.TransactionClient): Promise<Workspace | null> {
    const client = tx ?? dbRead;
    return client.workspace.findUnique({ where: { slug } });
  },

  /**
   * Same lookup as findById, but inside the caller's transaction so the
   * workspace RLS policy (which keys off the per-transaction app.workspace_id /
   * app.user_id GUCs) admits the row under the non-bypass motir_app role.
   * Used by the Story 6.10 org access gate to resolve a workspace's
   * organizationId inside the bound context; the db-singleton variant returns
   * NULL under RLS when no context is bound.
   */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<Workspace | null> {
    return tx.workspace.findUnique({ where: { id } });
  },

  /**
   * Every workspace id, ordered — or just `workspaceId` when given and it exists
   * (Story MOTIR-6588 · MOTIR-6603). The cross-tenant enumeration a sweep binds one
   * workspace at a time from; read under `withSystemContext`, which the
   * `workspace_system_read` arm admits.
   */
  async listIds(
    tx: Prisma.TransactionClient,
    scope: { workspaceId?: string } = {},
  ): Promise<string[]> {
    const rows = await tx.workspace.findMany({
      where: scope.workspaceId ? { id: scope.workspaceId } : {},
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  },

  /**
   * Every workspace under an organization, ordered by createdAt asc. Takes `tx`
   * because the workspace RLS policy reads the per-transaction GUCs. Used by the
   * Story 6.10 cross-workspace member-roster enrichment and the org-admin
   * workspace span (an org owner/admin's access reaches every workspace under
   * the org).
   */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Workspace[]> {
    return tx.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * One keyset-paginated PAGE of an organization's workspaces, ordered by
   * (name asc, id asc) so the order is stable across pages (MOTIR-6309 — the org
   * Workspaces section; by name since MOTIR-6312). Returns up to `limit + 1` rows so the service
   * can tell whether a next page exists without a second count; `cursorId` is
   * the last workspace id of the previous page (Prisma `cursor` + `skip: 1`).
   * `tx` REQUIRED: the org-member read arm (`workspace_org_member_read`) admits
   * the rows only under a bound org context.
   */
  async listByOrganizationPage(
    organizationId: string,
    limit: number,
    cursorId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<Workspace[]> {
    return tx.workspace.findMany({
      where: { organizationId },
      // By NAME, the id breaking ties so the keyset cursor stays total — the org
      // Workspaces card lists them the way a reader scans for one (MOTIR-6312 ·
      // design panel 1, "Sorted by name").
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },

  async create(
    // Story 6.10: a workspace is non-nullably nested under an Organization, so
    // organizationId is required here. The service creates/resolves the org and
    // passes its id (see workspacesService.insertWorkspaceWithOwner).
    data: { name: string; slug: string; organizationId: string },
    tx: Prisma.TransactionClient,
  ): Promise<Workspace> {
    return tx.workspace.create({ data });
  },

  async update(
    id: string,
    data: {
      name?: string;
      /** The workspace-tier require-2FA policy (Story MOTIR-1215 · MOTIR-3644). */
      requiresTwoFactor?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Workspace> {
    return tx.workspace.update({ where: { id }, data });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<Workspace> {
    return tx.workspace.delete({ where: { id } });
  },

  /**
   * The organization a workspace belongs to (the §4 cap path resolves the org
   * UP from the entity being created — 8.1.11). Takes `tx` so it reads the
   * workspace the enclosing create transaction operates in. Null when absent.
   */
  async findOrganizationId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const ws = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    return ws?.organizationId ?? null;
  },

  /**
   * Count workspaces in an organization (§4.4 cap, 8.1.11). Takes `tx` so the
   * count + the guarded create run in one transaction, serialized by the org
   * row lock (`organizationRepository.lockByIdForUpdate`).
   */
  async countByOrganization(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workspace.count({ where: { organizationId } });
  },
};
