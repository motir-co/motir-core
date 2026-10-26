import { Prisma, type WorkItemRevision } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { FilterAst } from '@/lib/filters/ast';
import type { ProjectFilterReferents } from '@/lib/filters/registry';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';

// Work-item-revision repository — single Prisma operations on the
// `work_item_revision` table (Subtask 1.4.6). The audit-trail leaf the
// work-item write flows persist through: workItemsService records a revision
// via workItemRevisionsService.recordRevision, which calls `create` here
// inside the SAME transaction as the mutation it describes.
//
// Layer rules (CLAUDE.md): the write (`create`) REQUIRES `tx` so a revision
// can only be written inside a transaction — that's the compile-time half of
// the atomicity guarantee (a revision commits with its mutation, or not at
// all). The read (`listByWorkItem`) is a pure read path → `db` singleton.
// No business logic, no transactions, no DTO mapping here (the mapper —
// lib/mappers/workItemRevisionMappers.ts — owns the Prisma → DTO conversion).
//
// No error translation: the table has no triggers, and a cross-workspace
// write attempt is caught by the RLS policy's WITH CHECK (42501) rather than
// by anything this layer needs to interpret.

export const workItemRevisionRepository = {
  /**
   * Insert one revision row. Required `tx` — a revision MUST commit atomically
   * with the work-item mutation it describes (if the mutation rolls back, so
   * does the revision, and vice versa). Uses the unchecked create input so the
   * caller passes scalar foreign keys (`workItemId` / `changedById`) directly
   * rather than nested `connect` wrappers — the service already holds the ids.
   */
  async create(
    data: Prisma.WorkItemRevisionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemRevision> {
    return tx.workItemRevision.create({ data });
  },

  /**
   * The body a work item was CREATED with — the `descriptionMd` its `created`
   * revision recorded, or `null` when it was created with none (Story MOTIR-4930 ·
   * Subtask MOTIR-5851).
   *
   * The bug-enrichment write compares the CURRENT body against this: equal means
   * nobody has touched the card since it was filed, which is both "this delivery
   * has not written yet" and "no person has edited it" in one test. The row is
   * immutable, so the answer cannot drift the way a recomputed body can when the
   * facts it was computed from move on.
   */
  async findCreatedDescription(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.workItemRevision.findFirst({
      where: { workItemId, changeKind: 'created' },
      orderBy: { changedAt: 'asc' },
      select: { diff: true },
    });
    const diff = row?.diff;
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
    const cell = (diff as Record<string, unknown>)['descriptionMd'];
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
    const to = (cell as { to?: unknown }).to;
    return typeof to === 'string' ? to : null;
  },

  /**
   * WHEN one specific revision was written — the `changedAt` of the row the
   * caller already holds the id of (Bug MOTIR-3334;
   * `docs/decisions/status-derivation.md` §5).
   *
   * The DOWNWARD cascade reads it to date the transition that woke it. Every
   * `work-item/transitioned` event carries the `revisionId` of the move it
   * announces, and that row is IMMUTABLE — so this is the one instant a cascade
   * can read that is stable under redelivery and unaffected by anything written
   * since. {@link findLatestStatusChangeAt} is deliberately NOT that instant: it
   * answers "where does this row stand now", which for a late-running cascade is
   * a different, younger transition.
   *
   * Scoped by nothing beyond the id: the caller is already inside a workspace
   * context, so RLS answers the tenant question.
   */
  async findChangedAtById(revisionId: string, tx?: Prisma.TransactionClient): Promise<Date | null> {
    const client = tx ?? dbRead;
    const row = await client.workItemRevision.findUnique({
      where: { id: revisionId },
      select: { changedAt: true },
    });
    return row?.changedAt ?? null;
  },

  /**
   * WHEN this work item's status was last changed — the `changedAt` of its most
   * recent revision carrying a `status` diff, or `null` if it has never moved
   * (Bug MOTIR-2965; `docs/decisions/status-derivation.md` §5).
   *
   * The upward recompute's BACKWARD arm reads it to date the row it is about to
   * overwrite. A status set AFTER the child-set edit that woke the recompute was
   * set by someone who already knew about those children, so a derived claim
   * about them is stale ABOUT THE ROW even when its reading of the children is
   * perfectly accurate — the ordering hole MOTIR-2957 closed on the cascade's
   * side, here on the rollup's.
   *
   * `diff -> 'status' IS NOT NULL` is the established status-revision predicate
   * in this file (the sprint burndown + cycle-time reads use it), and the query
   * walks the `(workItemId, changedAt)` index to a single row. Takes the caller's
   * `tx` so the rollup reads it inside the transaction that locked the parent —
   * the comparison and the write must see one consistent snapshot.
   */
  async findLatestStatusChangeAt(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ changed_at: Date }>>`
      SELECT r."changedAt" AS "changed_at"
        FROM "work_item_revision" r
       WHERE r."workItemId" = ${workItemId}
         AND r."diff" -> 'status' IS NOT NULL
       ORDER BY r."changedAt" DESC
       LIMIT 1`;
    return rows[0]?.changed_at ?? null;
  },

  /**
   * WHO last changed this work item's status, and WHEN (MOTIR-2961).
   *
   * The same single-row walk of the `(workItemId, changedAt)` index that
   * {@link findLatestStatusChangeAt} makes, returning the ACTOR alongside the
   * timestamp — which is what a keyed CLAIM's typed refusal needs and the date
   * alone cannot supply. Kept beside it rather than folded into it: the rollup
   * compares a date and has no use for an actor, and widening its return would
   * make every caller carry a field one of them reads.
   *
   * `null` when the item's status has never MOVED — a row created directly at
   * its status (the importer's authoritative set) writes no status revision, so
   * "nobody moved it" is a real answer and not a missing read.
   *
   * Takes the caller's `tx` so the claim reads it inside the transaction that
   * holds the row lock: on a successful claim the revision it must see is the
   * one that same transaction has just written.
   */
  async findLatestStatusChange(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ changedById: string; changedAt: Date } | null> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ changed_by_id: string; changed_at: Date }>>`
      SELECT r."changedById" AS "changed_by_id", r."changedAt" AS "changed_at"
        FROM "work_item_revision" r
       WHERE r."workItemId" = ${workItemId}
         AND r."diff" -> 'status' IS NOT NULL
       ORDER BY r."changedAt" DESC
       LIMIT 1`;
    const row = rows[0];
    return row ? { changedById: row.changed_by_id, changedAt: row.changed_at } : null;
  },

  /**
   * The revision history of one work item, newest first (`changedAt DESC`) by
   * default so the activity feed renders most-recent-at-top; `order: 'asc'`
   * (Subtask 5.5.1 — the Activity section's oldest-first toggle) walks the
   * SAME (workItemId, changedAt) index in the other direction. Read-only path
   * → `db` singleton. Cursor-paginated like workItemRepository.findByProject:
   * `cursor` is a revision id, and when present the row AT the cursor is
   * skipped (`skip: 1`) so paging doesn't repeat it.
   */
  async listByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemRevision[]> {
    const { take = 50, cursor, order = 'desc' } = options;
    const client = tx ?? dbRead;
    return client.workItemRevision.findMany({
      where: { workItemId },
      // `id` is a required secondary sort: `changedAt` alone is not a total
      // order — two revisions written in the same millisecond tie, and an
      // unbroken tie makes BOTH the rendered order AND cursor pagination
      // (cursor:{id}+skip:1) non-deterministic, so a page boundary that lands
      // mid-tie can skip or repeat a row. cuid `id`s are monotonic-ish and
      // unique, giving a stable tiebreaker (PRODECT_FINDINGS #38).
      orderBy: [{ changedAt: order }, { id: order }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The id of the LATEST revision per work item across a set of ids, in ONE
   * query via `DISTINCT ON ("workItemId")` ordered newest-first (the same total
   * order {@link listByWorkItem} uses — `changedAt DESC, id DESC` — so a tie in
   * the millisecond stamp resolves deterministically). This is the optimistic-
   * concurrency anchor behind plan-staleness `base_revision_drift` (7.21.3 /
   * MOTIR-1340): a `modify`/`remove` PlanItem stores the target's latest revision
   * id at proposal time as `baseRevision`; if the target's CURRENT latest id
   * differs, the target was edited since the plan was generated. Served by the
   * `[workItemId, changedAt]` index; batched (no N+1) across all of a plan's
   * targets. A work item with no revisions simply has no entry in the map.
   * Read-only path → `db` singleton; empty input short-circuits to an empty map.
   *
   * ⚠️ IT SKIPS A PURE STATUS MOVE — a revision whose diff carries `status` and
   * NOTHING ELSE (MOTIR-5646).
   *
   * Right on the rule's own terms: the question `base_revision_drift` asks is
   * whether the target changed such that *"applying the patch may conflict with
   * a newer edit / clobber it"*, and a content patch cannot clobber a status
   * change. The two do not compete for a field.
   *
   * And REQUIRED, which is how it was found. A plan now PARKS every committed
   * target it names at `planning` when it appends (MOTIR-5645), recording a
   * status revision on the very card the plan is about — so without this skip
   * EVERY plan read as stale the moment it was authored, against a
   * `baseRevision` its author had captured correctly seconds earlier.
   * `tests/integration/plans/planStalenessService.test.ts`'s all-clear case is
   * the one that failed.
   */
  async findLatestIdsByWorkItemIds(
    workItemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    if (workItemIds.length === 0) return new Map();
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ workItemId: string; id: string }>>`
      SELECT DISTINCT ON ("workItemId") "workItemId", "id"
      FROM "work_item_revision"
      WHERE "workItemId" IN (${Prisma.join(workItemIds)})
        -- A PURE STATUS MOVE IS NOT AN EDIT THIS ANCHOR IS ABOUT (MOTIR-5646).
        -- See the note above this method for why.
        AND NOT (
          "diff" ?& ARRAY['status']
          AND (SELECT count(*) FROM jsonb_object_keys("diff")) = 1
        )
      ORDER BY "workItemId", "changedAt" DESC, "id" DESC
    `;
    return new Map(rows.map((r) => [r.workItemId, r.id]));
  },

  /**
   * Resolve a set of client-supplied `baseRevision` values to the anchor
   * {@link findLatestIdsByWorkItemIds} would have answered at that revision's
   * moment (MOTIR-9603): the newest revision of the SAME work item at or before
   * it, in that method's total order (`changedAt DESC, id DESC`), skipping a pure
   * status move exactly as it does.
   *
   * Keyed by the value passed in, answering the revision's own `workItemId` and
   * the resolved `anchorId`. A value naming no revision in this workspace — a
   * timestamp, a work-item id, another tenant's revision under RLS — has no
   * entry, which is how the caller tells an anchor from a value that cannot be
   * one. `anchorId` is null only when nothing but status moves precedes it.
   */
  async resolveAnchors(
    revisionIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, { workItemId: string; anchorId: string | null }>> {
    if (revisionIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      Array<{ baseId: string; workItemId: string; anchorId: string | null }>
    >`
      SELECT b."id" AS "baseId", b."workItemId", (
        SELECT r."id"
        FROM "work_item_revision" r
        WHERE r."workItemId" = b."workItemId"
          AND (r."changedAt", r."id") <= (b."changedAt", b."id")
          AND NOT (
            r."diff" ?& ARRAY['status']
            AND (SELECT count(*) FROM jsonb_object_keys(r."diff")) = 1
          )
        ORDER BY r."changedAt" DESC, r."id" DESC
        LIMIT 1
      ) AS "anchorId"
      FROM "work_item_revision" b
      WHERE b."id" IN (${Prisma.join(revisionIds)})
    `;
    return new Map(rows.map((r) => [r.baseId, { workItemId: r.workItemId, anchorId: r.anchorId }]));
  },

  /**
   * The `perItem` NEWEST revisions of each work item in `workItemIds`, reduced to
   * their `changeKind`, `changedAt` and the top-level KEYS of their `diff` — newest
   * first within each item (MOTIR-5399).
   *
   * The read behind the body-edit-above-field-move advisory, which asks WHICH
   * fields each write moved and never what they were moved to. So the diff itself
   * is not selected: a body edit's `{ from, to }` carries the whole text on both
   * sides, and twenty such rows per card across a subtree would be a load of prose
   * nobody reads.
   *
   * ONE query for the whole batch — `ROW_NUMBER()` over the `(workItemId,
   * changedAt)` index, in the total order {@link listByWorkItem} uses
   * (`changedAt DESC, id DESC`). A work item with no revisions has no entry.
   * `jsonb_typeof` guards the (never-written, but JSON-typed) non-object diff, which
   * reads as no keys rather than an error.
   *
   * `tx` is REQUIRED, unlike the reads above: `work_item_revision` is RLS-scoped,
   * so a read outside a workspace context returns NO rows rather than failing —
   * and a check that silently reads an empty trail reports nothing, forever. The
   * only caller reads inside `withWorkspaceServiceContext`; requiring the handle
   * makes the other spelling a type error rather than a quiet miss.
   */
  async listRecentKeysByWorkItemIds(
    workItemIds: string[],
    perItem: number,
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, Array<{ changeKind: string; changedAt: Date; keys: string[] }>>> {
    if (workItemIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      Array<{ workItemId: string; changeKind: string; changedAt: Date; keys: string[] }>
    >`
      SELECT t."workItemId", t."changeKind", t."changedAt", t."keys"
      FROM (
        SELECT r."workItemId", r."changeKind", r."changedAt", r."id",
               CASE WHEN jsonb_typeof(r."diff") = 'object'
                    THEN ARRAY(SELECT jsonb_object_keys(r."diff"))
                    ELSE ARRAY[]::text[] END AS "keys",
               ROW_NUMBER() OVER (
                 PARTITION BY r."workItemId" ORDER BY r."changedAt" DESC, r."id" DESC
               ) AS rn
        FROM "work_item_revision" r
        WHERE r."workItemId" IN (${Prisma.join(workItemIds)})
      ) t
      WHERE t.rn <= ${perItem}
      ORDER BY t."workItemId", t."changedAt" DESC, t."id" DESC
    `;
    const byItem = new Map<
      string,
      Array<{ changeKind: string; changedAt: Date; keys: string[] }>
    >();
    for (const r of rows) {
      const entry = { changeKind: r.changeKind, changedAt: r.changedAt, keys: r.keys };
      const list = byItem.get(r.workItemId);
      if (list) list.push(entry);
      else byItem.set(r.workItemId, [entry]);
    }
    return byItem;
  },

  /**
   * The ACTOR of the latest `'archived'` revision of one work item (Story 2.9 ·
   * Subtask 2.9.6) — the detail page's archived banner reads WHO archived it
   * from here (the WHEN comes from `work_item.archivedAt`). A re-archived item
   * has several `'archived'` revisions, so we take the most recent
   * (`changedAt DESC`, `id DESC` as the deterministic tiebreaker — the same
   * total order {@link listByWorkItem} uses). The author join resolves the
   * display name + avatar in the SAME read. Returns `null` when the item has no
   * `'archived'` revision (an item archived by a path that recorded none —
   * defensive; in practice `archiveWorkItem` always records one). Read-only
   * path → `db` singleton. Scopes the LATERAL pick the 2.9.3 list read does in
   * `workItemRepository.findArchivedByProject` down to one item.
   */
  async findLatestArchivedActor(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string | null; image: string | null } | null> {
    const client = tx ?? dbRead;
    const revision = await client.workItemRevision.findFirst({
      where: { workItemId, changeKind: 'archived' },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { changedBy: { select: { id: true, name: true, image: true } } },
    });
    return revision?.changedBy ?? null;
  },

  /**
   * How many of a work item's revisions are DISPLAYABLE in the History feed
   * (Subtask 5.5.1) — the `totalCount` behind the tab badge / "Show more"
   * copy. A revision displays unless it is an `updated`-family row whose
   * EVERY diff key is in `suppressedKeys` (the registry's explicit noise
   * policy — pure board-reorder writes); `created` / `archived` anchors always
   * display. One grouped count, never a load-all (finding #57). The predicate
   * mirrors `isDisplayableRevision` in lib/activity/renderers.ts — both read
   * the same suppression list, so the count and the page filter can't drift.
   * `jsonb_typeof` guards the (never-written, but JSON-typed) non-object diff.
   * Read-only path → `db` singleton.
   */
  async countDisplayableByWorkItem(
    workItemId: string,
    suppressedKeys: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count
      FROM "work_item_revision" r
      WHERE r."workItemId" = ${workItemId}
        AND (
          r."changeKind" IN ('created', 'archived', 'unarchived')
          OR (
            jsonb_typeof(r."diff") = 'object'
            AND EXISTS (
              SELECT 1 FROM jsonb_object_keys(r."diff") AS k(key)
              WHERE NOT (k.key = ANY(${suppressedKeys}))
            )
          )
        )
    `;
    // count(*) always yields exactly one row.
    return Number((rows[0] as { count: bigint }).count);
  },

  /**
   * How many DISTINCT issues were associated with `sprintId` AFTER `after` — the
   * Jira "issues added during the sprint" figure the sprint report shows (Story
   * 4.4.4). An association write records a `{ sprintId: { from, to } }` diff
   * (`assignToSprint` / `setSprint`, Story 4.1.4), so an issue "added after
   * start" is one with an `updated` revision whose `diff.sprintId.to` equals this
   * sprint and whose `changedAt` is past the sprint's `startDate`. The relation
   * filter scopes to issues CURRENTLY in the sprint (non-archived) so a
   * removed-then-not-readded issue doesn't inflate the count, and `workspaceId`
   * gates the read (finding #26). `distinct` collapses an issue with several such
   * revisions to one — the result is bounded by the sprint's own additions (an
   * aggregate, not a load-all; finding #57). Read-only path → `db` singleton.
   */
  async countItemsAddedToSprintAfter(
    sprintId: string,
    workspaceId: string,
    after: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const rows = await client.workItemRevision.findMany({
      where: {
        changeKind: 'updated',
        changedAt: { gt: after },
        diff: { path: ['sprintId', 'to'], equals: sprintId },
        workItem: { sprintId, workspaceId, archivedAt: null },
      },
      distinct: ['workItemId'],
      select: { workItemId: true },
    });
    return rows.length;
  },

  /**
   * The IDS of the issues currently in `sprintId` that were associated with it
   * AFTER `after` — the same "added during sprint" set
   * `countItemsAddedToSprintAfter` counts, returned as ids so
   * `sprintsService.completeSprint` can FREEZE the flag per issue into the
   * sprint-report snapshot (bug-sprint-report-incomplete-list-zero-after-carry-
   * over). Called inside the completion transaction BEFORE the carry-over moves
   * anything, so the `workItem: { sprintId }` relation filter still matches the
   * about-to-be-carried issues; takes an optional `tx` so the read shares that
   * transaction. `distinct` collapses an issue with several such revisions to
   * one; `workspaceId` gates the read (finding #26). Bounded by the sprint's own
   * additions (finding #57).
   */
  async findItemIdsAddedToSprintAfter(
    sprintId: string,
    workspaceId: string,
    after: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? dbRead;
    const rows = await client.workItemRevision.findMany({
      where: {
        changeKind: 'updated',
        changedAt: { gt: after },
        diff: { path: ['sprintId', 'to'], equals: sprintId },
        workItem: { sprintId, workspaceId, archivedAt: null },
      },
      distinct: ['workItemId'],
      select: { workItemId: true },
    });
    return rows.map((r) => r.workItemId);
  },

  /**
   * The BOUNDED per-day event aggregate that drives the Linear-style CYCLE
   * GRAPH (Story 8.14.3) — the burn-UP of LIVE scope vs completed. In ONE
   * grouped `$queryRaw` (finding #57 — never a load-all + JS reduce) over the
   * `work_item_revision` trail scoped to (the sprint window) ∧ (this sprint's
   * issues OR a sprint-association change touching this sprint), it emits, per
   * UTC calendar day, three signed deltas the assembler cumulates into the three
   * actual series:
   *   • `scopeDelta` — the change to the LIVE total estimate in the sprint:
   *       a NOT-current-membership sprint ADD (`+stat`) / REMOVE (`−stat`), AND
   *       a `storyPoints` EDIT of a CURRENT sprint member (`to − from`). Scope is
   *       the total estimate REGARDLESS of status (a done item still counts), so
   *       — unlike the burndown — there is NO done-gate here. This live derivation
   *       is exactly what frees the chart from the immutable `committedPoints`
   *       snapshot (the MOTIR-1288 root cause). In count mode a re-estimate is a
   *       no-op (`0`); an add/remove is `±1`.
   *   • `completedDelta` — `+stat` on a transition INTO a `done`-category status
   *       (from a non-done one), `−stat` on a transition OUT of done (a reopen).
   *       Cumulates to `rollupForSprint().completed` (the SAME category predicate),
   *       so the chart reconciles with the scrum header.
   *   • `startedDelta` — `+stat` when an item LEAVES the `todo` category (into
   *       in-progress OR done — i.e. it has "started"), `−stat` when it returns to
   *       `todo`. The cumulative `started` line is therefore always ≥ `completed`
   *       and ≤ `scope` (the amber band between completed and started is the
   *       in-progress work). The default workflow has no todo→done edge, so every
   *       completion is first a start; the boundary rule generalises that safely.
   *
   * `stat` is the per-issue statistic: `COALESCE(storyPoints, 0)` for points, or
   * `1` for the issue-count series (`useCount`). Status is resolved by joining
   * `workflow_status` on the diff's `from`/`to` KEYS (the 1.4.6 trail stores keys)
   * and reading `category` — the SAME predicate `aggregateSprintCycleByDay` /
   * `sumPointsForSprint` use. Status/`storyPoints` events are scoped to issues
   * CURRENTLY in the sprint (matching the roll-up's current-members basis); add/
   * remove events match on the diff regardless of current membership.
   * `workspaceId` gates the read (finding #26); the result is bounded by the
   * sprint length (one row per day with events). Read-only path → `db` singleton.
   *
   * A sprint with no qualifying revisions returns no rows (the assembler derives
   * a flat-at-baseline series).
   */
  async aggregateSprintCycleByDay(
    sprintId: string,
    workspaceId: string,
    window: { start: Date; end: Date },
    useCount: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ day: string; scopeDelta: number; completedDelta: number; startedDelta: number }>
  > {
    // The per-issue statistic value — an internal literal expression, never user
    // input (the same `pointsAggExpr` pattern the sprint rollups use).
    const stat = useCount ? Prisma.sql`1` : Prisma.sql`COALESCE(w."storyPoints", 0)`;
    // Status events (completed / started) are scoped to CURRENT sprint members.
    const isStatusEvent = Prisma.sql`r."diff" -> 'status' IS NOT NULL AND w."sprintId" = ${sprintId}`;
    // Completed: into a done-category status (+) / out of done on a reopen (−).
    const intoDone = Prisma.sql`${isStatusEvent} AND ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done')`;
    const outOfDone = Prisma.sql`${isStatusEvent} AND (ts."category" IS NULL OR ts."category" <> 'done') AND fs."category" = 'done'`;
    // Started: crossing the `todo` boundary. Entering = from todo/initial to a
    // non-todo category (+); leaving = from a non-todo category back to todo (−).
    // A NULL `from` category is the initial (todo) status.
    const startedEnter = Prisma.sql`${isStatusEvent} AND (fs."category" IS NULL OR fs."category" = 'todo') AND ts."category" IS NOT NULL AND ts."category" <> 'todo'`;
    const startedLeave = Prisma.sql`${isStatusEvent} AND fs."category" IS NOT NULL AND fs."category" <> 'todo' AND ts."category" = 'todo'`;
    // Scope: sprint association add/remove (matched on the diff, any membership),
    // counting ALL points (no done-gate — scope is the total live estimate).
    const scopeUp = Prisma.sql`(r."diff" -> 'sprintId' ->> 'to') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'from', '') <> ${sprintId}`;
    const scopeDown = Prisma.sql`(r."diff" -> 'sprintId' ->> 'from') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'to', '') <> ${sprintId}`;
    // Scope: a `storyPoints` re-estimate of a CURRENT sprint member moves live
    // scope by `to − from` (each NULL = 0). In count mode a re-estimate is a no-op.
    const isPointsEdit = Prisma.sql`r."diff" -> 'storyPoints' IS NOT NULL AND w."sprintId" = ${sprintId}`;
    const pointsEditDelta = useCount
      ? Prisma.sql`0`
      : Prisma.sql`(COALESCE((r."diff" -> 'storyPoints' ->> 'to')::numeric, 0) - COALESCE((r."diff" -> 'storyPoints' ->> 'from')::numeric, 0))`;

    const client = tx ?? dbRead;
    return client.$queryRaw<
      Array<{ day: string; scopeDelta: number; completedDelta: number; startedDelta: number }>
    >`
      SELECT
        to_char(date_trunc('day', r."changedAt"), 'YYYY-MM-DD') AS "day",
        COALESCE(SUM(
          CASE
            WHEN ${scopeUp} THEN (${stat})
            WHEN ${scopeDown} THEN -1 * (${stat})
            WHEN ${isPointsEdit} THEN (${pointsEditDelta})
            ELSE 0
          END
        ), 0)::float8 AS "scopeDelta",
        COALESCE(SUM(
          CASE
            WHEN ${intoDone} THEN (${stat})
            WHEN ${outOfDone} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "completedDelta",
        COALESCE(SUM(
          CASE
            WHEN ${startedEnter} THEN (${stat})
            WHEN ${startedLeave} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "startedDelta"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      LEFT JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
        AND (
              ${isStatusEvent}
              OR (r."diff" -> 'sprintId' ->> 'to') = ${sprintId}
              OR (r."diff" -> 'sprintId' ->> 'from') = ${sprintId}
              OR ${isPointsEdit}
            )
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * The RESOLVED series of the created-vs-resolved report (Story 6.3 ·
   * Subtask 6.3.2): per `date_trunc(period, changedAt)` bucket, the NET
   * count of status transitions into a `done`-CATEGORY status — `+1` for a
   * transition INTO done (from a non-done status), `-1` for a transition OUT
   * of done (a reopen inside the window subtracts, the card's net rule) — in
   * ONE bounded grouped `$queryRaw` over the 1.4.6 trail (the 4.6.3 pattern;
   * finding #57 — never an all-revisions load + JS reduce; the result is
   * bounded by the bucket cap the service validates).
   *
   * "Done" resolves exactly like `aggregateSprintCycleByDay`: join
   * `workflow_status` on the diff's from/to status KEYS and read
   * `category = 'done'` — the SAME predicate `getTerminalStatusKeys` / the
   * burndown / velocity / rollups resolve (the recorded deviation: our
   * "resolution" IS the done category), so every report agrees on "done".
   * `period` is a closed `day|week|month` union bound as a parameter. The
   * optional compiled FilterAST (the 6.1.1 compiler over the joined
   * `work_item` alias `w`; stale referents → match-nothing per 6.1.2)
   * narrows to the saved-filter scope; archived items are excluded (matching
   * the created series + the /items parity basis). `workspaceId` gates the
   * read (finding #26). Buckets with no events return no row (the service
   * fills the axis). Read-only path → `db` singleton.
   */
  async aggregateNetResolvedByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ bucket: string; resolved: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ bucket: string; resolved: number }>>`
      SELECT
        to_char(date_trunc(${period}, r."changedAt"), 'YYYY-MM-DD') AS "bucket",
        COALESCE(SUM(
          CASE
            WHEN ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done') THEN 1
            WHEN (ts."category" IS NULL OR ts."category" <> 'done') AND fs."category" = 'done' THEN -1
            ELSE 0
          END
        ), 0)::int AS "resolved"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND (${astSql})
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      LEFT JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."diff" -> 'status' IS NOT NULL
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * The RESOLUTION-TIME aggregate (Story 8.8 · Subtask 8.8.13): per
   * `date_trunc(period, changedAt)` bucket keyed by the RESOLUTION date, the
   * AVERAGE of `(changedAt − createdAt)` in DAYS over every status transition
   * INTO a `done`-category status (from a non-done one) inside the window — one
   * bounded grouped `$queryRaw` over the 1.4.6 trail (the
   * `aggregateNetResolvedByBucket` pattern; finding #57). An item resolved,
   * reopened, then resolved again contributes once PER resolution event ("issues
   * that entered a done-category status in that period"). "Done" resolves like
   * every report (join `workflow_status` on the diff's from/to keys, read
   * `category = 'done'`), so the reports agree on "done". `avgDays` is `float8`
   * (a fractional day average); `resolvedCount` is the population per bucket (the
   * data-table column). Archived / triage items are excluded (the created-series
   * parity basis); `workspaceId` gates the read (finding #26). Event-less buckets
   * return no row (the service fills the axis with `avgDays: null`). Read-only →
   * `db` singleton.
   */
  async aggregateResolutionTimeByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ bucket: string; avgDays: number; resolvedCount: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ bucket: string; avgDays: number; resolvedCount: number }>>`
      SELECT
        to_char(date_trunc(${period}, r."changedAt"), 'YYYY-MM-DD') AS "bucket",
        AVG(EXTRACT(EPOCH FROM (r."changedAt" - w."createdAt")) / 86400.0)::float8 AS "avgDays",
        COUNT(*)::int AS "resolvedCount"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND w."triagedAt" IS NULL
       AND (${astSql})
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."diff" -> 'status' IS NOT NULL
        AND ts."category" = 'done'
        AND (fs."category" IS NULL OR fs."category" <> 'done')
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * The AVERAGE-AGE aggregate (Story 8.8 · Subtask 8.8.13): for each bucket's
   * period-END instant (passed in by the service via `lib/reports/buckets`
   * `bucketEnds` — the exclusive upper edge, capped at "now" for the current
   * bucket), the AVERAGE of `(periodEnd − createdAt)` in DAYS over issues created
   * by then and NOT yet resolved at that instant. An item's resolution point is
   * its FIRST transition INTO a `done`-category status (the `resolved` CTE — the
   * SAME done predicate every report uses); an item with no such transition (or
   * one whose first resolution is AFTER `periodEnd`) is still open. One bounded
   * grouped `$queryRaw`: the bucket (key, periodEnd) pairs are UNNESTed and
   * CROSS-joined to the scoped items, so it is a single point-in-time pass, never
   * a per-bucket round-trip (finding #57; bounded by items × ≤120 buckets).
   * Archived / triage items excluded; `workspaceId` gates the read (finding #26).
   * A bucket with no open items returns no row (the service fills `avgDays:
   * null`). Read-only → `db` singleton.
   */
  async aggregateAverageAgeByBucket(
    projectId: string,
    workspaceId: string,
    buckets: Array<{ key: string; end: Date }>,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ bucket: string; avgDays: number; openCount: number }>> {
    if (buckets.length === 0) return [];
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const keys = buckets.map((b) => b.key);
    const ends = buckets.map((b) => b.end);
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ bucket: string; avgDays: number; openCount: number }>>`
      WITH be AS (
        SELECT * FROM unnest(${keys}::text[], ${ends}::timestamptz[]) AS t("key", "periodEnd")
      ),
      resolved AS (
        SELECT r."workItemId" AS "itemId", MIN(r."changedAt") AS "firstDoneAt"
        FROM "work_item_revision" r
        JOIN "work_item" w2
          ON w2."id" = r."workItemId"
         AND w2."projectId" = ${projectId}
         AND w2."workspaceId" = ${workspaceId}
        LEFT JOIN "workflow_status" fs
          ON fs."project_id" = w2."projectId" AND fs."key" = (r."diff" -> 'status' ->> 'from')
        JOIN "workflow_status" ts
          ON ts."project_id" = w2."projectId" AND ts."key" = (r."diff" -> 'status' ->> 'to')
        WHERE r."changeKind" = 'updated'
          AND r."diff" -> 'status' IS NOT NULL
          AND ts."category" = 'done'
          AND (fs."category" IS NULL OR fs."category" <> 'done')
        GROUP BY 1
      )
      SELECT
        be."key" AS "bucket",
        AVG(EXTRACT(EPOCH FROM (be."periodEnd" - w."createdAt")) / 86400.0)::float8 AS "avgDays",
        COUNT(*)::int AS "openCount"
      FROM be
      JOIN "work_item" w
        ON w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND w."triagedAt" IS NULL
       AND w."createdAt" <= be."periodEnd"
       AND (${astSql})
      LEFT JOIN resolved rs ON rs."itemId" = w."id"
      WHERE rs."firstDoneAt" IS NULL OR rs."firstDoneAt" > be."periodEnd"
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * The revisions of ONE work item written strictly AFTER `after`, oldest first —
   * the walk the approved-shape verdict makes past the approving plan's
   * `decidedAt` (Story MOTIR-5544 · MOTIR-6225). Rides the
   * `(workItemId, changedAt)` index.
   *
   * BOUNDED: at most {@link WORK_ITEM_REVISIONS_AFTER_MAX} rows per call, however
   * large `take` is. A caller that needs more pages on with `cursor` — the last
   * row it holds — and the `(changedAt, id)` keyset is what keeps rows written
   * in ONE transaction (which share a `changedAt`) from being skipped or
   * repeated across a page boundary.
   */
  async findChangedAfter(
    workItemId: string,
    after: Date,
    cursor: { changedAt: Date; id: string } | null,
    take: number,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemRevision[]> {
    const client = tx ?? dbRead;
    return client.workItemRevision.findMany({
      where: {
        workItemId,
        changedAt: { gt: after },
        ...(cursor
          ? {
              OR: [
                { changedAt: { gt: cursor.changedAt } },
                { changedAt: cursor.changedAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(WORK_ITEM_REVISIONS_AFTER_MAX, Math.floor(take))),
    });
  },
};

/** The server-side cap on one {@link workItemRevisionRepository.findChangedAfter} page. */
export const WORK_ITEM_REVISIONS_AFTER_MAX = 200;
