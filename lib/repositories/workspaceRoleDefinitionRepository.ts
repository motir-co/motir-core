import { type Prisma, type WorkspaceRoleDefinition } from '@/generated/prisma/client';

// WorkspaceRoleDefinition repository — single Prisma operations on the
// `workspace_role_definition` table (Story MOTIR-6168 · Subtask MOTIR-6457). The
// persistence leaf for a workspace's OWN roles — the workspace-tier successor of
// `projectRoleDefinitionRepository`, whose shape it mirrors — under the workspace
// role service (MOTIR-6460), which owns the transactions, the permission-set
// validation and the delete-with-reassign.
//
// NO VALIDATION AND NO ERROR TRANSLATION LIVE HERE, for the reasons its project
// twin records: a duplicate `(workspaceId, name)` raises P2002 and the SERVICE
// names it; a delete that a holder still points at is refused by the
// `ON DELETE RESTRICT` foreign key — a RESTRICT violation, whose Prisma code
// depends on the server (`lib/prisma/restrictViolation.ts` reads every shape) —
// and the service's reassign-then-delete is the path that never reaches it.
//
// RLS: the table carries its own `workspace_id` and a FOR ALL policy keyed on the
// per-transaction `app.workspace_id` GUC that `withWorkspaceContext` binds. So
// every method REQUIRES `tx`: read off the singleton with nothing bound, the
// non-bypass `motir_app` role sees zero rows and raises nothing.

export const workspaceRoleDefinitionRepository = {
  /** Every custom role a workspace has defined, ordered by name. */
  async findManyByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceRoleDefinition[]> {
    return tx.workspaceRoleDefinition.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
  },

  /** One role definition by id, or null. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceRoleDefinition | null> {
    return tx.workspaceRoleDefinition.findUnique({ where: { id } });
  },

  /** Several role definitions by id in ONE query; only the rows that exist. */
  async findManyByIds(
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceRoleDefinition[]> {
    if (ids.length === 0) return [];
    return tx.workspaceRoleDefinition.findMany({ where: { id: { in: ids } } });
  },

  /**
   * Insert one role definition. The unchecked input carries `workspaceId` as a
   * scalar — the column the RLS policy gates on, so `WITH CHECK` rejects a row
   * naming a foreign workspace.
   */
  async create(
    data: Prisma.WorkspaceRoleDefinitionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceRoleDefinition> {
    return tx.workspaceRoleDefinition.create({ data });
  },

  /** Patch one role definition (rename → `name`; re-permission → `permissions`). */
  async update(
    id: string,
    patch: Prisma.WorkspaceRoleDefinitionUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceRoleDefinition> {
    return tx.workspaceRoleDefinition.update({ where: { id }, data: patch });
  },

  /**
   * Delete one role definition. Legal ONLY when no membership points at it; the
   * membership FK's `ON DELETE RESTRICT` refuses anything that slips past.
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<WorkspaceRoleDefinition> {
    return tx.workspaceRoleDefinition.delete({ where: { id } });
  },

  /**
   * How many workspace memberships hold each of the given custom roles, as
   * `roleDefinitionId → count`, in ONE grouped read over
   * `workspace_membership.role_definition_id`. A role nobody holds is ABSENT from
   * the map rather than present at 0 — the caller defaults it. The Roles list
   * shows the counts; the delete path reads one to decide whether a reassign is
   * owed.
   */
  async countHolders(
    roleDefinitionIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (roleDefinitionIds.length === 0) return new Map();
    const rows = await tx.workspaceMembership.groupBy({
      by: ['roleDefinitionId'],
      where: { roleDefinitionId: { in: roleDefinitionIds } },
      _count: { _all: true },
    });
    // The `in` filter excludes NULL, so every group key is one of the given ids.
    return new Map(rows.map((row) => [row.roleDefinitionId as string, row._count._all]));
  },
};
