import { Prisma, type CustomFieldOption } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Custom-field-option repository — single Prisma operations on the
// `custom_field_option` table (Story 5.3 · Subtask 5.3.1). The persistence
// leaf for a `select` field's managed options, under customFieldsService
// (5.3.2), which owns the transactions, the 55-options-per-field cap, and
// the verified archive-vs-delete split (archive any time; DELETE only when
// unused — the value FK's Restrict backstops that rule at the DB layer, and
// counting the in-use rows is customFieldValueRepository.countByOption's job:
// the entity-name rule puts a `custom_field_value` count THERE, not here).
//
// The option row carries no `workspaceId` (its tenancy is its field's — the
// comment_mention / work_item_revision shape), so workspace-gated reads
// (finding #26) filter through the parent definition relation: still one
// Prisma operation, the relation filter compiles into the same query.
//
// No error translation EXCEPT delete: an in-use option hard-delete trips the
// value FK's ON DELETE RESTRICT (`isRestrictViolation` reads the refusal,
// whose Prisma code depends on the server), which the SERVICE translates to its
// typed OptionInUseError after its own countByOption pre-check (the DB is
// the backstop, not the messenger).

export const customFieldOptionRepository = {
  /**
   * Insert one option row. Required `tx` — an option write rides the same
   * transaction as its cap-guard read (and, at field-create time, its
   * siblings — 5.3.2 seeds a `select` field's initial set atomically).
   */
  async create(
    data: Prisma.CustomFieldOptionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CustomFieldOption> {
    return tx.customFieldOption.create({ data });
  },

  /**
   * Patch one option (rename → `label`; reorder → `position`; archive /
   * unarchive → `archived`). The single-op leaf — which patches are legal
   * is the service's call.
   */
  async update(
    id: string,
    patch: Prisma.CustomFieldOptionUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CustomFieldOption> {
    return tx.customFieldOption.update({ where: { id }, data: patch });
  },

  /**
   * HARD-delete one option — legal ONLY when unused (the verified
   * team-managed "Optimize" rule). The service pre-checks
   * customFieldValueRepository.countByOption === 0 inside the same
   * transaction; the value FK's ON DELETE RESTRICT rejects anything that
   * slips past (a RESTRICT violation — `lib/prisma/restrictViolation.ts`).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<CustomFieldOption> {
    return tx.customFieldOption.delete({ where: { id } });
  },

  /**
   * One option by id, workspace-gated through its parent definition
   * (finding #26 — the row has no workspaceId of its own). Null for unknown
   * ids AND cross-workspace probes.
   */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldOption | null> {
    const client = tx ?? dbRead;
    return client.customFieldOption.findFirst({
      where: { id, field: { workspaceId } },
    });
  },

  /**
   * A field's options in `position` order (the picker and the options
   * editor both consume this order; the picker excludes `archived` rows at
   * the SERVICE/UI layer — existing values referencing an archived option
   * must keep rendering, so the read returns them all). Bounded by the
   * 55-option cap. Backed by the (field_id, position) index.
   */
  async listByField(
    fieldId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldOption[]> {
    const client = tx ?? dbRead;
    return client.customFieldOption.findMany({
      where: { fieldId, field: { workspaceId } },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Every option across ALL of a project's fields in one query, `position`
   * order — the admin-list read (5.3.2) assembles per-field sets from this
   * in memory instead of a per-field round-trip (no N+1; bounded by the
   * 50-fields × 55-options caps). Workspace-gated through the parent
   * definition (finding #26).
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldOption[]> {
    const client = tx ?? dbRead;
    return client.customFieldOption.findMany({
      where: { field: { projectId, workspaceId } },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Bulk id resolution for the filter builder's stale-referent check
   * (Subtask 6.1.2): which of the ids a `?filter=` AST references still
   * exist, on which field — scoped to the project + workspace through the
   * parent definition (finding #26; a cross-tenant id resolves to nothing
   * and therefore reads as stale). Bounded by the filter's own value lists
   * (≤50 values × 20 rows), never a load-all. Archived options ARE returned
   * — they stay matchable for historical filtering (the verified Jira
   * rule). Empty input is an empty result by contract (coverage gate).
   */
  async findByIds(
    ids: string[],
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldOption[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.customFieldOption.findMany({
      where: { id: { in: ids }, field: { projectId, workspaceId } },
    });
  },

  /**
   * How many options the field already has — the 55-cap guard read. Runs
   * inside the add-option transaction (pass `tx`) so concurrent adds can't
   * slip past the cap unobserved.
   */
  async countByField(
    fieldId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    return client.customFieldOption.count({
      where: { fieldId, field: { workspaceId } },
    });
  },
};
