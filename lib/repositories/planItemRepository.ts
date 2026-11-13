import { Prisma, type Plan, type PlanItem, type PlanStatus } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { PlanProgressAddRow, PlanProgressWriteRow } from '@/lib/plans/planProgress';

/**
 * The `PlanItem` create shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanItemUncheckedCreateInput` itself is named only here.
 */
export type PlanItemCreateInput = Prisma.PlanItemUncheckedCreateInput;

/**
 * The `PlanItem` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanItemUncheckedUpdateInput` itself is named only here.
 */
export type PlanItemUpdateInput = Prisma.PlanItemUncheckedUpdateInput;

/**
 * One row of {@link planItemRepository.findProgressRowsByPlanIds}: an `add`'s
 * identity plus whether it is written (`authorFinished`), never its bodies
 * (MOTIR-7825, MOTIR-10496).
 */
export type PlanProgressRow = PlanProgressAddRow & { planId: string };

/**
 * One row of {@link planItemRepository.findWriteRowsByPlanIds}: a proposal's
 * identity and its last write, never its bodies (MOTIR-11184).
 */
export type PlanWriteRow = PlanProgressWriteRow & { planId: string; writtenAt: Date };

/**
 * One row of {@link planItemRepository.findHistoryByWorkItemId}: the proposal's
 * identity and the columns that say which relation it stands for, with the
 * plan's display fields (and its decider's name) on the same row.
 */
export type PlanHistoryItemRow = Pick<PlanItem, 'id' | 'op' | 'workItemId' | 'parentRef'> & {
  plan: Pick<
    Plan,
    | 'id'
    | 'title'
    | 'status'
    | 'createdAt'
    | 'plannedAt'
    | 'decidedAt'
    | 'decidedById'
    | 'authorSource'
    | 'authorHarness'
    | 'authorModel'
  > & { decidedBy: { name: string } | null };
};

/**
 * One row of {@link planItemRepository.findApprovedAfterTouching}: a proposal an
 * APPROVED plan made against a card (or under a container), with that plan's display
 * fields on the same row (MOTIR-8458).
 */
export type ApprovedPlanTouchRow = Pick<PlanItem, 'id' | 'op' | 'workItemId' | 'parentRef'> & {
  plan: Pick<Plan, 'id' | 'title' | 'decidedAt'>;
};

// PlanItem repository — single Prisma operations on the `plan_item` table
// (Story 7.21 · MOTIR-1336). Writes require `tx`; pure reads use the `db`
// singleton. No business logic, no transactions, no DTO mapping.
export const planItemRepository = {
  async create(data: PlanItemCreateInput, tx: Prisma.TransactionClient): Promise<PlanItem> {
    return tx.planItem.create({ data });
  },

  /** A plan's proposal items in append order (createdAt asc, id asc). Optional
   *  `tx` joins a surrounding transaction (the materialize read in approve). */
  async findByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<PlanItem[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The proposals that TARGET a given work item — the reverse lookup
   * (MOTIR-3579). `modify` / `remove` only: an `add` has a null `workItemId` by
   * construction, so it can never be the target of one.
   *
   * ⚠️ THIS IS THE READ THE `plan_item_work_item_id_workspace_id_idx` INDEX
   * EXISTS FOR, and it runs on EVERY status change in the tenant — the drift
   * listener consumes `work-item/transitioned`, which every ingress emits. The
   * `@@unique([planId, workItemId])` cannot serve it: its leftmost column is
   * `planId`, so without the composite this is a sequential scan of every
   * proposal in the workspace, per board drag.
   *
   * `workspaceId` is an explicit filter and not merely an RLS matter — RLS is
   * inert under the dev/CI superuser, so the predicate is the actual gate
   * (finding #26).
   */
  async findByWorkItemId(
    workItemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanItem[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: { workItemId, workspaceId, op: { in: ['modify', 'remove'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The UNDECIDED proposals that NAME a given work item, with the plan each one
   * belongs to — the work-item page's pending-plan read (bug MOTIR-4197 · design
   * MOTIR-4256 §3, widened by bug MOTIR-4365 · design MOTIR-4364 AMENDMENT A).
   *
   * ⚠️ TWO ARMS, BECAUSE A PROPOSAL NAMES A CARD IN TWO DIFFERENT COLUMNS — and
   * that is a fact about the substrate, not a filter someone chose narrowly:
   *
   *   * a `modify` / `remove` TARGETS the card: `workItemId`, the reverse index
   *     `[workItemId, workspaceId]` (MOTIR-3579);
   *   * an `add` PARENTS on the card: `parentRef`, the forward-parent index
   *     `[parentRef, workspaceId]` (MOTIR-4365). An `add` has NO `workItemId` at
   *     all — the row it would name does not exist until the plan is approved —
   *     so widening the `op` list alone would have changed nothing, which is why
   *     this is an `OR` of two indexed predicates rather than a looser one.
   *
   * `parentRef` is matched on the RESOLVED work-item id, which is what the
   * column holds: `add_plan_items` rewrites a `MOTIR-<n>` key to its id on the
   * way IN (MOTIR-3576, `resolveKeyRefs`), so the stored value is either a real
   * id or an intra-plan `planItem:<id>` temp-ref — and a temp-ref names another
   * PROPOSAL as the parent, which is correctly not this card.
   *
   * Narrowed to the plans in `statuses` (the caller passes
   * `WORK_ITEM_PENDING_PLAN_STATUSES`; the SET is the service's decision, not
   * this method's) and to the plans of `projectId`, so a caller granted browse
   * on one project cannot read another project's proposals through a work-item
   * id it happens to know. The plan's `id` / `title` / `status` ride back on the
   * SAME query — ONE query, never a read per row — which is the figure the item
   * page's tier-two group is allowed to add. A plan may now return SEVERAL rows
   * (N `add`s under one card), and collapsing them to one row per plan is the
   * service's in-memory fold, deliberately not a second query.
   *
   * ⚠️ NO `tx`-less arm: this read runs inside the page's request, and on a card
   * with no pending plan — nearly every card — it must cost exactly the index
   * probes and nothing more.
   */
  async findPendingByWorkItemId(
    workItemId: string,
    workspaceId: string,
    projectId: string,
    statuses: readonly PlanStatus[],
    tx?: Prisma.TransactionClient,
  ): Promise<Array<PlanItem & { plan: Pick<Plan, 'id' | 'title' | 'status'> }>> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: {
        workspaceId,
        plan: { projectId, status: { in: [...statuses] } },
        OR: [
          { workItemId, op: { in: ['modify', 'remove'] } },
          { parentRef: workItemId, op: 'add' },
        ],
      },
      include: { plan: { select: { id: true, title: true, status: true } } },
      orderBy: [{ plan: { createdAt: 'asc' } }, { id: 'asc' }],
    });
  },

  /**
   * EVERY proposal, in a plan of ANY status, that relates to a given work item —
   * the rows the item page's PLAN HISTORY is folded from (Story MOTIR-5542 ·
   * MOTIR-5546). The pending read above, widened from two arms to THREE and
   * with its status filter dropped:
   *
   *   * **created it** — an `add` whose `workItemId` is this card. An `add` is
   *     born with a null `workItemId`; `plansService.materialize` writes the
   *     created id back at approve, so this arm only ever matches an APPROVED
   *     plan's `add`;
   *   * **changed / archived it** — a `modify` / `remove` TARGETING the card;
   *   * **added children under it** — an `add` whose `parentRef` is this card.
   *
   * Arms one and two share the `[workItemId, workspaceId]` index and arm three
   * uses `[parentRef, workspaceId]`. They are written as three predicates rather
   * than a bare `{ workItemId }` so the relation each row stands for is legible
   * at the query, and so a fourth op can never slip into arm two unnoticed.
   *
   * ⚠️ KNOWN LIMITATION, stated rather than fixed: an `add` whose `parentRef` is
   * an intra-plan `planItem:<id>` temp-ref (a child laid under a story the SAME
   * plan adds) is NOT matched by arm three — the stored value names the parent
   * PROPOSAL, not the card it became. No plan is lost by it: after approve the
   * story's own `add` carries the story's id, so that plan still arrives for the
   * story through arm one, as *created it* — only its child count reads 0.
   *
   * `planIds` narrows to one page of plans (`planRepository
   * .findPageRelatedToWorkItem` pages them); `null` reads every related row.
   * The plan's display fields — including the decider's NAME, through the
   * `decidedBy` relation — ride back on this SAME query. Ordered by plan
   * creation, then the row's own append order, so a caller folding in memory
   * keeps the page's order without a second sort.
   */
  async findHistoryByWorkItemId(
    workItemId: string,
    workspaceId: string,
    projectId: string,
    planIds: readonly string[] | null,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanHistoryItemRow[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: {
        workspaceId,
        ...(planIds ? { planId: { in: [...planIds] } } : {}),
        plan: { projectId },
        OR: [
          { workItemId, op: 'add' },
          { workItemId, op: { in: ['modify', 'remove'] } },
          { parentRef: workItemId, op: 'add' },
        ],
      },
      select: {
        id: true,
        op: true,
        workItemId: true,
        parentRef: true,
        plan: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            plannedAt: true,
            decidedAt: true,
            decidedById: true,
            authorSource: true,
            authorHarness: true,
            authorModel: true,
            decidedBy: { select: { name: true } },
          },
        },
      },
      orderBy: [
        { plan: { createdAt: 'asc' } },
        { planId: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
  },

  /**
   * Every proposal an APPROVED plan of these projects, decided strictly AFTER `after`,
   * made against one of `workItemIds` (any op), or added under one of `parentIds`
   * (MOTIR-8458) — what re-shaped a gated scope run's story since the run stopped.
   * Ordered by the plan's decision, oldest first, then the row's own append order.
   */
  async findApprovedAfterTouching(
    workspaceId: string,
    projectIds: readonly string[],
    workItemIds: readonly string[],
    parentIds: readonly string[],
    after: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovedPlanTouchRow[]> {
    if (projectIds.length === 0 || (workItemIds.length === 0 && parentIds.length === 0)) {
      return [];
    }
    return tx.planItem.findMany({
      where: {
        workspaceId,
        plan: { projectId: { in: [...projectIds] }, status: 'approved', decidedAt: { gt: after } },
        OR: [
          { workItemId: { in: [...workItemIds] } },
          { op: 'add', parentRef: { in: [...parentIds] } },
        ],
      },
      select: {
        id: true,
        op: true,
        workItemId: true,
        parentRef: true,
        plan: { select: { id: true, title: true, decidedAt: true } },
      },
      orderBy: [
        { plan: { decidedAt: 'asc' } },
        { planId: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
  },

  /**
   * The proposals of ONE NAMED plan that relate to ONE NAMED work item — the
   * TARGET (the `add` that created it, or the `modify` / `remove` naming it) and
   * its CHILDREN (every `add` parented on it) — read by the approved-shape
   * verdict (Story MOTIR-5544 · MOTIR-6225) to learn which cards the approving
   * plan put under a container.
   *
   * ⚠️ A CHILD ARRIVES THROUGH ONE OF TWO `parentRef` SPELLINGS, and the second is
   * the whole reason this is not {@link findHistoryByWorkItemId} narrowed to one
   * plan: a child laid under a story the SAME plan adds carries the intra-plan
   * temp-ref `planItem:<storyAddId>`, not the story's id (that read's stated
   * known limitation). The caller passes the target proposal's id as
   * `targetParentRef` (already `planItem:`-prefixed) so those children are
   * matched too; `null` when the plan did not create the card.
   *
   * `workItemId` rides back so a child `add` names the card it became (materialize
   * writes it back at approve).
   */
  async findByPlanForWorkItem(
    planId: string,
    workItemId: string,
    targetParentRef: string | null,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<Pick<PlanItem, 'id' | 'op' | 'workItemId' | 'parentRef'>>> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: {
        planId,
        workspaceId,
        OR: [
          { workItemId },
          { parentRef: workItemId, op: 'add' },
          ...(targetParentRef ? [{ parentRef: targetParentRef, op: 'add' as const }] : []),
        ],
      },
      select: { id: true, op: true, workItemId: true, parentRef: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  async countByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.planItem.count({ where: { planId } });
  },

  /** Item counts for a set of plans in one grouped query — the list view's
   *  `itemCount` without an N+1. Returns a `planId → count` map. */
  async countByPlanIds(
    planIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (planIds.length === 0) return new Map();
    const client = tx ?? dbRead;
    const rows = await client.planItem.groupBy({
      by: ['planId'],
      where: { planId: { in: planIds } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.planId, r._count._all]));
  },

  /**
   * The `add` rows of many plans, as the PROGRESS derivation reads them (Story
   * MOTIR-7820 · MOTIR-7825) — ONE query for a whole page of generating plans.
   * Whether each is WRITTEN is computed from `proposed_fields` IN SQL, so no
   * description or explanation body crosses the wire for a list. The flag is the
   * SQL twin of `progressRowOfAdd` / `isProposalWritten` (MOTIR-10496): an EXACT
   * JSON comparison with `true`, so absent, JSON `null` and a string `"true"` all
   * read false here exactly as they do in TypeScript.
   */
  async findProgressRowsByPlanIds(
    planIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<PlanProgressRow[]> {
    if (planIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.$queryRaw<PlanProgressRow[]>`
      SELECT
        pi."id"            AS "id",
        pi."plan_id"       AS "planId",
        pi."work_item_id"  AS "workItemId",
        pi."parent_ref"    AS "parentRef",
        pi."proposed_fields"->>'kind'                AS "kind",
        COALESCE(pi."proposed_fields"->>'title', '')  AS "title",
        (pi."proposed_fields"->'authorFinished' = 'true'::jsonb) IS TRUE AS "authorFinished"
      FROM "plan_item" pi
      WHERE pi."plan_id" = ANY(${[...planIds]}::text[])
        AND pi."op" = 'add'
      ORDER BY pi."plan_id", pi."created_at", pi."id"
    `;
  },

  /**
   * Every proposal of many plans with its LAST WRITE — the quiet drop's input
   * (MOTIR-11184, `PlanProgressWriteRow`). ONE query for a whole page of plans.
   * `writtenAt` is the later of the proposal's append (`created_at`) and its
   * latest `edited` timeline row — a deepen, a correction, a merged `modify`;
   * `GREATEST` skips the NULL of a proposal never edited. Any op: an author step
   * on a committed card writes a `modify`. No body crosses the wire.
   */
  async findWriteRowsByPlanIds(
    planIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<PlanWriteRow[]> {
    if (planIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.$queryRaw<PlanWriteRow[]>`
      SELECT
        pi."id"            AS "id",
        pi."plan_id"       AS "planId",
        pi."op"::text      AS "op",
        pi."work_item_id"  AS "workItemId",
        pi."parent_ref"    AS "parentRef",
        GREATEST(pi."created_at", MAX(pr."changed_at")) AS "writtenAt"
      FROM "plan_item" pi
      LEFT JOIN "plan_revision" pr
        ON pr."plan_item_id" = pi."id" AND pr."change_kind" = 'edited'
      WHERE pi."plan_id" = ANY(${[...planIds]}::text[])
      GROUP BY pi."id"
      ORDER BY pi."plan_id", pi."created_at", pi."id"
    `;
  },

  /** A single PlanItem by id. Optional `tx` joins a surrounding transaction
   *  (the proposal-edit path re-reads the item under the plan lock). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<PlanItem | null> {
    const client = tx ?? dbRead;
    return client.planItem.findUnique({ where: { id } });
  },

  /**
   * The `add` rows among `ids` that have MATERIALIZED, in this workspace, each with
   * the card it became (`workItemId`) — the read that tells a body link written in
   * the proposal scheme which card it meant (MOTIR-10104). An `add` not yet
   * approved has no `workItemId` and is not returned.
   */
  async findMaterializedAddsByIds(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; workItemId: string }[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.planItem.findMany({
      where: { id: { in: ids }, workspaceId, op: 'add', workItemId: { not: null } },
      select: { id: true, workItemId: true },
    });
    return rows.map((r) => ({ id: r.id, workItemId: r.workItemId! }));
  },

  /** Edit a PlanItem's mutable JSON/columns in place — the proposal-edit path
   *  (7.21.6 · MOTIR-1370) patches an `add`'s `proposedFields` while the plan is
   *  `planned`. A write, so `tx` is required. */
  async update(
    id: string,
    data: PlanItemUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data });
  },

  /** Delete ONE proposal — the WITHDRAW path (Story MOTIR-3533 · MOTIR-3540).
   *
   *  The per-item delete `agent-authored-plans.md` AMENDMENT 3 D4 recorded as
   *  absent: `deleteByPlan` is a whole-plan operation and could not express a
   *  single proposal coming off a plan. A write, so `tx` is required. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<PlanItem> {
    return tx.planItem.delete({ where: { id } });
  },

  /** Write the materialized work-item id back onto an `add` PlanItem (approve). */
  async setWorkItemId(
    id: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data: { workItemId } });
  },
};
