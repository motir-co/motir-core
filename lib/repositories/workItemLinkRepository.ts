import { Prisma, type WorkItemLink, type WorkItemLinkKind } from '@/generated/prisma/client';
import { sqlStateOf } from '@/lib/prisma/sqlstate';
import { dbRead } from '@/lib/db';
import {
  CrossWorkspaceLinkError,
  DuplicateLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkspaceMismatchLinkError,
} from '@/lib/workItems/linkErrors';

// Work-item-link repository — single Prisma operations on the
// `work_item_link` table. Writes require `tx` (compile-time guarantee they
// run in a transaction); pure read paths use the `db` singleton. No business
// logic, no transactions, no DTO mapping here — those belong in the link-
// service in 1.4.4 (which will own the same-workspace + same-project
// validation reads, the cross-axis reciprocal `relates_to` writes, and the
// permission checks).
//
// The DB-layer triggers (prisma/sql/work_item_link_triggers.sql) enforce the
// cycle / self-link / workspace-consistency rules. On INSERT / UPDATE they
// reject with SQLSTATE 23514 + a WI_LINK_* message marker; `create`
// translates those markers into the typed errors from lib/workItems/
// linkErrors.ts at this edge, so the service layer never inspects raw
// Postgres error codes (the 4-layer rule). Prisma P2002 on the
// (fromId, toId, kind) unique constraint translates to DuplicateLinkError.

export const workItemLinkRepository = {
  /**
   * Look up a single link by id.
   *
   * Takes an optional `tx` (MOTIR-2774) because `work_item_link` is
   * workspace-scoped: read off the `db` singleton with no workspace bound, the
   * policy returns NOTHING AND RAISES NOTHING. `unlinkWorkItems` had opened a
   * `withWorkspaceContext` transaction and then read here without it, so the link it
   * had just been handed came back null and the call threw
   * `WorkItemLinkNotFoundError` — unlinking was impossible under the non-bypass role,
   * and the error blamed the link's existence.
   *
   * Optional rather than required, unlike `findOrganizationsByUser`, because the
   * other caller (`getLink`) is deliberately unbound: it reads the link and compares
   * `workspaceId` in application code as the cross-tenant guard. That path wants the
   * singleton and is covered by its own tests.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<WorkItemLink | null> {
    const client = tx ?? dbRead;
    return client.workItemLink.findUnique({ where: { id } });
  },

  /**
   * Links whose `fromId` is the given work item — i.e., the OUT edges. With
   * no `kind` filter, returns every kind (the typical "show all links on
   * this issue" endpoint feeds from a from + to merge). With a `kind`
   * filter, narrows to the indexed `(fromId, kind)` lookup.
   */
  async findByFromItem(
    fromId: string,
    kind?: WorkItemLinkKind,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLink[]> {
    const client = tx ?? dbRead;
    return client.workItemLink.findMany({
      where: { fromId, ...(kind ? { kind } : {}) },
    });
  },

  /**
   * Links whose `toId` is the given work item — i.e., the IN edges. The
   * mirror of findByFromItem; for `is_blocked_by` this is the "what does
   * this item block?" reverse lookup the ready-set engine needs.
   */
  async findByToItem(
    toId: string,
    kind?: WorkItemLinkKind,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLink[]> {
    const client = tx ?? dbRead;
    return client.workItemLink.findMany({
      where: { toId, ...(kind ? { kind } : {}) },
    });
  },

  /**
   * Look up the single link with the exact (fromId, toId, kind) triple via
   * the @@unique([fromId, toId, kind]) index (Subtask 1.4.4). Named
   * "reciprocal" because its caller is the `relates_to` unlink path: given
   * the A→B link being removed, it resolves the B→A mirror row so both
   * halves of the symmetric pair drop together. Takes an optional `tx` so
   * the read joins the same transaction as the deletes it gates.
   */
  async findReciprocal(
    fromId: string,
    toId: string,
    kind: WorkItemLinkKind,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLink | null> {
    const client = tx ?? dbRead;
    return client.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId, toId, kind } },
    });
  },

  /**
   * Any link joining the two items in ANY kind and EITHER direction (a→b or
   * b→a) — the "are these two already linked at all?" gate the auto-relate-on-
   * mention path (Subtask 5.8.3) reads before adding a `relates_to` edge: a pair
   * already joined by e.g. `is_blocked_by` (or a manual `relates_to`) must NOT
   * gain a second, auto edge, and an existing block must never be downgraded.
   * ONE `findFirst` over the OR of the two orderings. Takes an optional `tx` so
   * it joins the write transaction it guards.
   */
  async findAnyBetween(
    aId: string,
    bId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLink | null> {
    const client = tx ?? dbRead;
    return client.workItemLink.findFirst({
      where: {
        OR: [
          { fromId: aId, toId: bId },
          { fromId: bId, toId: aId },
        ],
      },
    });
  },

  /**
   * Idempotent create: insert the link unless its (fromId, toId, kind) triple
   * already exists, via `ON CONFLICT DO NOTHING` (Prisma `createManyAndReturn`
   * + `skipDuplicates`). Returns the inserted row, or `null` when the unique
   * already held — WITHOUT raising P2002. This is the auto-relate path's
   * concurrency guard (Subtask 5.8.3): catching a thrown P2002 inside a Prisma
   * interactive transaction is impossible (the violation aborts the whole
   * enclosing tx), so the duplicate is swallowed at the INSERT instead. The
   * structural triggers still fire on the insert; for the only caller's shape
   * (same-workspace, non-self `relates_to`, which is cycle-exempt) none of them
   * reject, so no marker translation is needed here. Required `tx`.
   *
   * ⚠️ IT DELEGATES TO {@link createManyIfAbsent} NOW (MOTIR-3396), which is a
   * behaviour change in exactly one respect: a trigger rejection that used to
   * escape as a raw SQLSTATE-23514 Prisma error is now TRANSLATED to the typed
   * class, like every other write in this file. Nothing depended on the raw form
   * — the sentence above is why — and the batch form is where the array API this
   * method was already calling is actually used with more than one row.
   */
  async createIfAbsent(
    data: Prisma.WorkItemLinkUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemLink | null> {
    const rows = await workItemLinkRepository.createManyIfAbsent([data], tx);
    return rows[0] ?? null;
  },

  /**
   * The BATCH form of {@link createIfAbsent}: insert N links in ONE
   * `createManyAndReturn` + `skipDuplicates`, returning only the rows actually
   * inserted (a duplicate is skipped, never raised — same `ON CONFLICT DO
   * NOTHING` semantics as the single form, which now delegates here). An empty
   * input issues no query at all. Required `tx`.
   *
   * ⚠️ THIS EXISTS BECAUSE THE SINGLE FORM WAS AN ARRAY API CALLED WITH AN ARRAY
   * OF ONE (MOTIR-3396). `createManyAndReturn` has always taken N rows;
   * `createIfAbsent` wrapped it at N=1 because its first caller
   * (auto-relate-on-mention) had exactly one link to write. `plansService`'s
   * materialize then wired a whole plan's `blocked_by` graph one await at a
   * time, so a 15-item plan with 27 edges spent 27 sequential Fly→Neon round
   * trips inside an interactive transaction on Prisma's default 5 s budget, and
   * approving it returned P2028. One statement for the same 27 rows is the fix
   * Prisma's own error text names first ("or doing less work in the
   * transaction").
   *
   * **The structural triggers still fire per ROW**, so a batch is not a way to
   * smuggle a cycle or a self-link past them: `enforce_work_item_link_no_cycle`
   * is a BEFORE-ROW trigger and its recursive walk sees rows inserted earlier in
   * the SAME statement, so an intra-batch A↔B cycle is rejected exactly as two
   * separate inserts would reject it (asserted in
   * `tests/integration/work-items/link-repository.test.ts`). What a batch loses
   * is only WHICH row failed — Postgres aborts the statement without saying —
   * so the rejection is attributed by matching the trigger message's ids back to
   * the batch, and the typed error the callers already catch is preserved.
   */
  async createManyIfAbsent(
    data: Prisma.WorkItemLinkUncheckedCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemLink[]> {
    if (data.length === 0) return [];
    try {
      return await tx.workItemLink.createManyAndReturn({ data, skipDuplicates: true });
    } catch (err) {
      throw translateWriteError(err, attributeBatchRow(err, data));
    }
  },

  /**
   * The `(status, projectId)` of every `is_blocked_by` blocker of `workItemId`
   * — the raw input the service's `isReady` reduces to a readiness verdict
   * (Subtask 2.2.6, resolving finding #21). ONE query, no fetch-then-filter
   * loop; the terminal classification is NOT done here because "terminal" is a
   * per-project property (`category = done`, which can differ per blocker's
   * project) — that lives in `workflowsService.getTerminalStatusKeysByProjects`
   * and the service composes the two. (Earlier this was a single COUNT query
   * with a hardcoded `status <> 'done'`; finding #21 generalized it.)
   *
   * A blocker can live in a DIFFERENT project than `workItemId` (cross-project
   * blocks are legal in the link model), so each blocker carries its own
   * `projectId`. The blocker's `id` rides along too so a caller naming the OPEN
   * blockers (the 2.4.5 readiness banner) can correlate this row back to the
   * resolved blocker summary without a second lookup. Each blocker's
   * `sessionBranch` (Subtask 7.8.11) rides along too: an integrated-awaiting-
   * review blocker (non-terminal but with a recorded branch) satisfies its
   * dependents, so readiness needs the field, not just the status. Read-only →
   * `db` singleton.
   *
   * ARCHIVED blockers are EXCLUDED (`toItem.archivedAt IS NULL`; MOTIR-1328): an
   * archived item is a soft-removed / superseded node, so a stale `is_blocked_by`
   * edge to one must NOT hold its dependents out of the ready set. Filtering on
   * the blocker (`toItem`) here makes every readiness consumer agree
   * (`getReadiness` / `list_ready` / `next_ready` / the board ready column).
   */
  async findBlockerStates(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ id: string; status: string; projectId: string; sessionBranch: string | null }>
  > {
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: { fromId: workItemId, kind: 'is_blocked_by', toItem: { archivedAt: null } },
      select: {
        toItem: { select: { id: true, status: true, projectId: true, sessionBranch: true } },
      },
    });
    return rows.map((r) => ({
      id: r.toItem.id,
      status: r.toItem.status,
      projectId: r.toItem.projectId,
      sessionBranch: r.toItem.sessionBranch,
    }));
  },

  /**
   * Every non-archived `is_blocked_by` blocker of `workItemId` with what the Plan
   * button's pre-check needs to judge it (MOTIR-10544, `lib/planning/plannability.ts`):
   * its key, title, kind, status and project, and how many LIVE (non-archived)
   * children it has. The status is classified by the caller against the
   * blocker's own project's workflow, as {@link findBlockerStates}' readiness
   * consumers do. ARCHIVED blockers are excluded for the same reason as there
   * (MOTIR-1328). ONE query: the child count is a filtered relation count.
   */
  async findBlockersWithLiveChildCounts(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      key: number;
      title: string;
      kind: string;
      status: string;
      projectId: string;
      archivedAt: Date | null;
      liveChildCount: number;
    }>
  > {
    const rows = await tx.workItemLink.findMany({
      where: { fromId: workItemId, kind: 'is_blocked_by', toItem: { archivedAt: null } },
      select: {
        toItem: {
          select: {
            id: true,
            identifier: true,
            key: true,
            title: true,
            kind: true,
            status: true,
            projectId: true,
            archivedAt: true,
            _count: { select: { children: { where: { archivedAt: null } } } },
          },
        },
      },
    });
    return rows.map(({ toItem: { _count, ...item } }) => ({
      ...item,
      liveChildCount: _count.children,
    }));
  },

  /**
   * The DEPENDENTS of a work item — every non-archived item carrying an
   * `is_blocked_by` edge TO it, with the `status` + `projectId` a caller needs to
   * classify each against its own project's terminal set. The reverse of
   * {@link findBlockerStates}, and the read the design-result publish gate asks
   * "does any open work wait on this design?" with (MOTIR-5491;
   * `docs/decisions/design-result.md` AMENDMENT 4 Q2). ARCHIVED dependents are
   * EXCLUDED for the same reason archived blockers are: a person decided that
   * work should not be done, so it waits on nothing. Takes the caller's `tx` when
   * the answer gates a write in that transaction.
   */
  async findDependentStates(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; status: string; projectId: string }>> {
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: { toId: workItemId, kind: 'is_blocked_by', fromItem: { archivedAt: null } },
      select: { fromItem: { select: { id: true, status: true, projectId: true } } },
    });
    return rows.map((r) => ({
      id: r.fromItem.id,
      status: r.fromItem.status,
      projectId: r.fromItem.projectId,
    }));
  },

  /**
   * The DEPENDENTS of an init card, each with what the routing pass decides on
   * (Story MOTIR-10162 · MOTIR-11042) — the dependents-side mirror of
   * {@link findBlockersWithLiveChildCounts}: every NON-ARCHIVED item carrying an
   * `is_blocked_by` edge TO `initWorkItemId`, read from the `fromItem` side, with
   * its id, project, status, its own `initRepositoryName` (a dependent that is
   * itself an init card is never routed) and the same filtered count of LIVE
   * children. ONE query. {@link findDependentStates} carries no child count and
   * no declaration, which is why this is its own read rather than a widened one.
   */
  async findDependentsWithLiveChildCounts(
    initWorkItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      projectId: string;
      status: string;
      initRepositoryName: string | null;
      liveChildCount: number;
    }>
  > {
    const rows = await tx.workItemLink.findMany({
      where: { toId: initWorkItemId, kind: 'is_blocked_by', fromItem: { archivedAt: null } },
      select: {
        fromItem: {
          select: {
            id: true,
            projectId: true,
            status: true,
            initRepositoryName: true,
            _count: { select: { children: { where: { archivedAt: null } } } },
          },
        },
      },
    });
    return rows.map(({ fromItem: { _count, ...item } }) => ({
      ...item,
      liveChildCount: _count.children,
    }));
  },

  /**
   * The DEPENDENTS of a work item with their KEYS — {@link findDependentStates}
   * plus the `identifier`, ordered by the dependent's key number, for a surface
   * that NAMES the work waiting on an item (the design Re-plan seed's first turn,
   * MOTIR-6424). Archived dependents are excluded for the same reason.
   */
  async findDependentKeys(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ identifier: string; status: string; projectId: string }>> {
    const rows = await tx.workItemLink.findMany({
      where: { toId: workItemId, kind: 'is_blocked_by', fromItem: { archivedAt: null } },
      select: { fromItem: { select: { identifier: true, status: true, projectId: true } } },
      orderBy: { fromItem: { key: 'asc' } },
    });
    return rows.map((r) => ({
      identifier: r.fromItem.identifier,
      status: r.fromItem.status,
      projectId: r.fromItem.projectId,
    }));
  },

  /**
   * Batched form of {@link findBlockerStates} for MANY items at once — the board
   * projection (3.1.4) needs a ready flag per card without an N+1. Returns every
   * `is_blocked_by` blocker of any item in `fromIds`, each row carrying the
   * blocked item it belongs to (`fromId`) plus the blocker's `status` +
   * `projectId` for per-project terminal classification + its `sessionBranch`
   * (Subtask 7.8.11 — an integrated blocker with a recorded branch satisfies its
   * dependents and contributes its lineage to the conflicting-branch check). ONE
   * query. Empty `fromIds` short-circuits to `[]`. Read-only → `db` singleton.
   *
   * ARCHIVED blockers are EXCLUDED (`toItem.archivedAt IS NULL`; MOTIR-1328) — the
   * same rule as {@link findBlockerStates}, so the batch readiness path
   * (`getReadinessForItems` / `collectReadyLeaves`) agrees with the single one: a
   * stale edge to a soft-removed item never phantom-gates its dependents.
   */
  async findBlockerStatesForItems(
    fromIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ fromId: string; status: string; projectId: string; sessionBranch: string | null }>
  > {
    if (fromIds.length === 0) return [];
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: { fromId: { in: fromIds }, kind: 'is_blocked_by', toItem: { archivedAt: null } },
      select: {
        fromId: true,
        toItem: { select: { status: true, projectId: true, sessionBranch: true } },
      },
    });
    return rows.map((r) => ({
      fromId: r.fromId,
      status: r.toItem.status,
      projectId: r.toItem.projectId,
      sessionBranch: r.toItem.sessionBranch,
    }));
  },

  /**
   * The `is_blocked_by` EDGES among a set of items (the roadmap canvas draws these
   * — within-parent arrow vs the cross-parent flag, Subtask 7.20.2 / MOTIR-1194).
   * Unlike {@link findBlockerStatesForItems} (which carries the blocker's STATUS
   * for a readiness verdict), this returns the edge ENDPOINTS: `blockedId` (the
   * `fromId`) and `blockerId` (the `toId`). ONE query; empty `itemIds` → `[]`.
   * Read-only → `db` singleton.
   *
   * ARCHIVED blockers are EXCLUDED (`toItem.archivedAt IS NULL`; MOTIR-1328) — the
   * same rule as {@link findBlockerStates} and {@link findBlockerStatesForItems},
   * so what the canvas DRAWS agrees with what readiness COMPUTES: a stale edge to
   * a soft-removed item is not an arrow, not a cross-flag and not a ghost anchor,
   * exactly as it is not an open blocker (bug MOTIR-3927). Without it the roadmap
   * level read contradicted itself in one frame — `findProjectTreeLevel` drops the
   * archived row from the level, and this read then handed it straight back as an
   * OFF-level blocker, named by `findRoadmapBlockerStubs`, while `getReadiness` on
   * the very same card answered `ready: true` with no open blockers.
   */
  async findBlockedByEdges(
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ blockedId: string; blockerId: string }>> {
    if (itemIds.length === 0) return [];
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: { fromId: { in: itemIds }, kind: 'is_blocked_by', toItem: { archivedAt: null } },
      select: { fromId: true, toId: true },
    });
    return rows.map((r) => ({ blockedId: r.fromId, blockerId: r.toId }));
  },

  /**
   * The `supersedes` links running FROM any of `itemIds` (Story MOTIR-6577 ·
   * MOTIR-6630) — `fromId` is the NEWER card, `toId` the older one it replaces.
   * The plan gate's supersedes-cycle walk expands its closure from these, one
   * level per call, exactly as it does `findBlockedByEdges` for blockers.
   * Archived ends are NOT filtered: the database does not refuse a supersedes
   * ring, so the walk sees every committed row a ring could run through.
   */
  async findSupersedesEdges(
    itemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ fromId: string; toId: string }>> {
    if (itemIds.length === 0) return [];
    return (tx ?? dbRead).workItemLink.findMany({
      where: { fromId: { in: itemIds }, kind: 'supersedes' },
      select: { fromId: true, toId: true },
    });
  },

  /**
   * The `is_blocked_by` edges running FROM any of `fromIds` TO any of `toIds` —
   * the cross-parent coverage check's parent-level lookup (MOTIR-6370): given the
   * parents of every cross-parent edge's two ends, which parent pairs already
   * carry the edge? ONE read for the whole subtree. Workspace-scoped when given.
   */
  async findBlockedByAmong(
    fromIds: string[],
    toIds: string[],
    workspaceId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ fromId: string; toId: string }>> {
    if (fromIds.length === 0 || toIds.length === 0) return [];
    return (tx ?? dbRead).workItemLink.findMany({
      where: {
        fromId: { in: fromIds },
        toId: { in: toIds },
        kind: 'is_blocked_by',
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: { fromId: true, toId: true },
    });
  },

  /**
   * The `is_blocked_by` EDGES of many items at once (Subtask 7.8.15 —
   * `validate_sprint`), each carrying the blocking item's id, `identifier`,
   * `status`, `sprintId` and `projectId`. The sprint-finishability check walks
   * every in-sprint item (its OWN edges — MOTIR-6368) and asks, per blocker, "is it
   * done OR also in this sprint?" — which needs the blocker's IDENTITY (`id` for
   * the in-sprint membership test, `identifier` to NAME it) and `sprintId`
   * (in-sprint?), which neither {@link findBlockerStatesForItems} (the
   * `(status, projectId)` readiness pair) nor {@link findBlockedByEdges} (bare
   * endpoints) carries. Hence a sibling read rather than an extension of either.
   *
   * ONE query. Empty `fromIds` short-circuits to `[]`. ARCHIVED blockers are
   * EXCLUDED (`toItem.archivedAt IS NULL`; MOTIR-1328) — the same rule as the
   * readiness reads, so a stale edge to a soft-removed item never phantom-gates a
   * sprint. The blocker's `projectId` rides along because a block can be
   * cross-project, so "done" is judged against the blocker's OWN project's
   * terminal set. Read-only → `db` singleton.
   *
   * `blockerTitle` (MOTIR-1842) rides along so a caller can NAME the far end
   * without a second read — the edge PROJECTION the MCP list reads attach to
   * every row (`{ key, title, status }`). Additive: the readiness / sprint
   * callers select what they need and ignore it.
   *
   * `workspaceId`, when supplied, scopes the read to that tenant via the link
   * row's own indexed `workspaceId` column (MOTIR-1842). The DB triggers already
   * keep a link's two endpoints in ONE workspace, so this is defence in depth
   * rather than a correction — but it makes the tenancy guarantee local to the
   * query instead of resting on a trigger. Optional so the pre-existing
   * readiness / sprint callers (already workspace-gated upstream) are unchanged.
   */
  async findBlockerEdgesForItems(
    fromIds: string[],
    workspaceId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      fromId: string;
      blockerId: string;
      blockerKey: string;
      blockerTitle: string;
      blockerStatus: string;
      blockerSprintId: string | null;
      blockerProjectId: string;
      /** The blocker's kind — the far end the `crossLevelEdges` verdict reads (MOTIR-6509). */
      blockerKind: string;
      /** The blocker's parent — the cross-parent coverage check's far end (MOTIR-6370). */
      blockerParentId: string | null;
    }>
  > {
    if (fromIds.length === 0) return [];
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: {
        fromId: { in: fromIds },
        kind: 'is_blocked_by',
        toItem: { archivedAt: null },
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: {
        fromId: true,
        toItem: {
          select: {
            id: true,
            identifier: true,
            title: true,
            status: true,
            sprintId: true,
            projectId: true,
            kind: true,
            parentId: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      fromId: r.fromId,
      blockerId: r.toItem.id,
      blockerKind: r.toItem.kind,
      blockerParentId: r.toItem.parentId,
      blockerKey: r.toItem.identifier,
      blockerTitle: r.toItem.title,
      blockerStatus: r.toItem.status,
      blockerSprintId: r.toItem.sprintId,
      blockerProjectId: r.toItem.projectId,
    }));
  },

  /**
   * For a set of items, each one's blockers' recorded `sessionBranch` — the raw
   * material for "is this item ready from `main`, or on an inherited lineage?"
   * (Story 11.5 · Subtask 11.5.24 — MOTIR-2400).
   *
   * ⚠️ ONE query for a page of any size, and that is the whole reason this
   * method exists rather than the caller reaching for `getReadiness`. The
   * inherited branch is per-ITEM state a list read needs for every row, and
   * `getReadiness` computes it one item at a time — correct for the single item
   * a dispatch decorates, a per-row query storm for a 50-row page.
   *
   * Deliberately NOT a widening of {@link findBlockerEdgesForItems}. That
   * projection feeds the shared `WorkItemDependencyEdgesDto` carried by the
   * ready list, the issues list, two MCP tools and the v1 detail's children; a
   * field added there to serve ONE row type ripples through four surfaces and
   * their exact-shape tests. A second narrow read is cheaper than a shared shape
   * that grew a field most of its consumers ignore.
   *
   * Returns one row per (item, blocker-with-a-branch) pair — the caller
   * collapses. Blockers with no branch produce no row at all, so an item ready
   * from `main` is simply absent from the result.
   *
   * ⚠️ The branch filter lives in the MAPPER, not in the `where`. Having both —
   * `sessionBranch: { not: null }` in the query AND a null check on the way out
   * — is not defence in depth: it makes the mapper's null arm UNREACHABLE, so
   * it can never be exercised and the file's branch coverage can never be
   * complete. One filter, in the place that can be tested with an ordinary
   * blocker that has no branch, which is the common case.
   */
  async findBlockerSessionBranchesForItems(
    fromIds: string[],
    workspaceId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ fromId: string; sessionBranch: string }>> {
    if (fromIds.length === 0) return [];
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: {
        fromId: { in: fromIds },
        kind: 'is_blocked_by',
        toItem: { archivedAt: null },
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: { fromId: true, toItem: { select: { sessionBranch: true } } },
    });
    return rows.flatMap((r) =>
      r.toItem.sessionBranch === null
        ? []
        : [{ fromId: r.fromId, sessionBranch: r.toItem.sessionBranch }],
    );
  },

  /**
   * The REVERSE-direction sibling of {@link findBlockerEdgesForItems} (MOTIR-1842):
   * for a set of items, the `is_blocked_by` edges that point AT them — i.e. what
   * each item BLOCKS. Same shape, mirrored: keyed by `toId` (the item in the
   * page, the blocker end) and carrying the BLOCKED item's `id` / `identifier` /
   * `title` / `status` / `sprintId` / `projectId`.
   *
   * Together the two reads are the whole per-row dependency projection the MCP
   * list tools attach (`list_ready` / `search_work_items`): TWO queries for a
   * page of any size, never one per row.
   *
   * ONE query. Empty `toIds` short-circuits to `[]` WITHOUT a query. ARCHIVED
   * items on the far end are EXCLUDED (`fromItem.archivedAt IS NULL`) — the
   * mirror of the MOTIR-1328 rule its sibling applies to `toItem`: a stale edge
   * from a soft-removed item must not show up as something this item blocks.
   * `workspaceId` scopes the read to one tenant exactly as the sibling does.
   * Read-only → `db` singleton.
   */
  async findBlockedEdgesForItems(
    toIds: string[],
    workspaceId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      toId: string;
      blockedId: string;
      blockedKey: string;
      blockedTitle: string;
      blockedStatus: string;
      blockedSprintId: string | null;
      blockedProjectId: string;
    }>
  > {
    if (toIds.length === 0) return [];
    const rows = await (tx ?? dbRead).workItemLink.findMany({
      where: {
        toId: { in: toIds },
        kind: 'is_blocked_by',
        fromItem: { archivedAt: null },
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: {
        toId: true,
        fromItem: {
          select: {
            id: true,
            identifier: true,
            title: true,
            status: true,
            sprintId: true,
            projectId: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      toId: r.toId,
      blockedId: r.fromItem.id,
      blockedKey: r.fromItem.identifier,
      blockedTitle: r.fromItem.title,
      blockedStatus: r.fromItem.status,
      blockedSprintId: r.fromItem.sprintId,
      blockedProjectId: r.fromItem.projectId,
    }));
  },

  /**
   * The work items that SUPERSEDE any of `toIds` — the `supersedes` edges whose
   * `to` is the OLDER item and whose `from` is the newer one (MOTIR-6580) —
   * resolved to the superseder's key in the same round-trip (MOTIR-6657, the
   * dispatch prompt's obsolete-neighbour lines). ONE read for every marked
   * neighbour, however many there are; archived superseders are left out.
   * `tx` is REQUIRED: the edges sit behind the workspace policy, so an unbound
   * read answers nothing rather than failing.
   */
  async findSupersedersOf(
    toIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ toId: string; supersederKey: number; supersederIdentifier: string }>> {
    if (toIds.length === 0) return [];
    const rows = await tx.workItemLink.findMany({
      where: { toId: { in: toIds }, kind: 'supersedes', fromItem: { archivedAt: null } },
      select: { toId: true, fromItem: { select: { key: true, identifier: true } } },
    });
    return rows.map((r) => ({
      toId: r.toId,
      supersederKey: r.fromItem.key,
      supersederIdentifier: r.fromItem.identifier,
    }));
  },

  /**
   * The unarchived BUGS of one project joined to a work item by `relates_to`, in
   * either direction (MOTIR-7800 — what a guide conversation may cite instead of
   * filing again, and what its `file_bug` is checked against for a duplicate).
   * One row per link, so a reciprocal pair yields the same bug twice; the caller
   * dedupes. Workspace-scoped, so it takes the caller's bound `tx`.
   */
  async findRelatedBugs(
    workItemId: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; identifier: string; title: string; status: string }>> {
    const bug = { kind: 'bug' as const, projectId, archivedAt: null };
    const pick = { select: { id: true, identifier: true, title: true, status: true } };
    const rows = await tx.workItemLink.findMany({
      where: {
        kind: 'relates_to',
        OR: [
          { fromId: workItemId, toItem: bug },
          { toId: workItemId, fromItem: bug },
        ],
      },
      select: { fromId: true, fromItem: pick, toItem: pick },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.fromId === workItemId ? r.toItem : r.fromItem));
  },

  /**
   * Create a link. Required `tx`. The DB triggers validate cycle /
   * self-link / workspace consistency on insert; their SQLSTATE-23514
   * rejections and a P2002 unique violation are translated to typed errors
   * here. Accepts the unchecked input shape (fromId/toId/workspaceId/
   * createdById as scalar FKs) for parity with workItemRepository.create.
   */
  async create(
    data: Prisma.WorkItemLinkUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemLink> {
    try {
      return await tx.workItemLink.create({ data });
    } catch (err) {
      throw translateWriteError(err, {
        fromId: data.fromId,
        toId: data.toId,
        kind: data.kind as string,
      });
    }
  },

  /**
   * Delete a link by id. Required `tx`. Returns the deleted row. The repo
   * does not soft-delete links: revoking a dependency edge is a data-model
   * operation, not a history-preserving one (revision audit on links lives
   * with the parent issue's revision rows in 1.4.6 if at all).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<WorkItemLink> {
    return tx.workItemLink.delete({ where: { id } });
  },
};

// --- Prisma/Postgres error → typed error translation (repository edge) ------

/**
 * Which row of a BATCH insert the trigger rejected (MOTIR-3396). Postgres aborts
 * the whole statement and names no ordinal, but the WI_LINK_* rejections that
 * can carry a row identity INTERPOLATE the ids into their message
 * (`prisma/sql/work_item_link_triggers.sql`: `linking % is_blocked_by %`,
 * `fromId = toId = %`), so the offending row is recoverable by matching those
 * ids back to the batch.
 *
 * Falls back to the FIRST row when nothing matches — which is the honest answer
 * for the two rejections that name WORKSPACES rather than links
 * (`WI_LINK_CROSS_WORKSPACE`, `WI_LINK_WORKSPACE_MISMATCH`). Degrading there
 * costs nothing that matters: only {@link WorkItemLinkCycleError} carries the
 * attempted triple at all, the rest are constants, and it is a DIAGNOSTIC in
 * every case — never a control-flow input, so a wrong guess degrades a message
 * rather than a verdict.
 */
function attributeBatchRow(
  err: unknown,
  data: Prisma.WorkItemLinkUncheckedCreateInput[],
): { fromId: string; toId: string; kind: string } {
  const message = extractMessage(err);
  const named = data.find((d) => message.includes(d.fromId) && message.includes(d.toId));
  // `?? data[0]` also covers the single-row case exactly — a one-element batch
  // resolves to that element whether or not the message names it — so there is
  // deliberately no `length === 1` fast path here: it would be a branch that
  // cannot change an answer, and one no test could distinguish.
  const attributed = named ?? data[0]!;
  return { fromId: attributed.fromId, toId: attributed.toId, kind: attributed.kind as string };
}

/**
 * Translate a write-path error into a typed work-item-link error. Trigger
 * rejections arrive (via the pg driver adapter) as an error whose
 * `cause.code` is SQLSTATE 23514 and whose message carries one of the
 * WI_LINK_* markers; we key on the marker (unique strings we control) and
 * confirm via the SQLSTATE. P2002 → duplicate link. Anything else is
 * rethrown unchanged. Always throws — return type is `never`.
 *
 * The marker check uses the literal string per branch (rather than a single
 * pre-extracted set) so the produced typed error carries the most specific
 * class even when two markers share a prefix.
 */
function translateWriteError(
  err: unknown,
  attempted: { fromId: string; toId: string; kind: string },
): never {
  const message = extractMessage(err);
  const sqlState = sqlStateOf(err);

  if (sqlState === '23514' || isLinkTriggerMarker(message)) {
    if (message.includes('WI_LINK_CYCLE')) {
      throw new WorkItemLinkCycleError(attempted);
    }
    if (message.includes('WI_LINK_CROSS_WORKSPACE')) {
      throw new CrossWorkspaceLinkError();
    }
    if (message.includes('WI_LINK_WORKSPACE_MISMATCH')) {
      throw new WorkspaceMismatchLinkError();
    }
    /* istanbul ignore else -- defensive: within a 23514 block the four WI_LINK markers are exhaustive, so "not a self-link here" is unreachable */
    if (message.includes('WI_LINK_SELF')) {
      throw new SelfLinkError();
    }
  }

  /* istanbul ignore else -- defensive: a non-Prisma error never reaches here (every link write error is a 23514 trigger or a Prisma known-request error) */
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    /* istanbul ignore else -- defensive: P2002 (the (fromId,toId,kind) unique) is the only Prisma code this write produces */
    if (err.code === 'P2002') throw new DuplicateLinkError();
  }

  /* istanbul ignore next -- defensive rethrow: every work_item_link write error is a 23514 trigger marker or a Prisma P2002, all handled above */
  throw err;
}

function isLinkTriggerMarker(message: string): boolean {
  return (
    message.includes('WI_LINK_CYCLE') ||
    message.includes('WI_LINK_CROSS_WORKSPACE') ||
    message.includes('WI_LINK_WORKSPACE_MISMATCH') ||
    message.includes('WI_LINK_SELF')
  );
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* istanbul ignore next -- defensive: work_item_link write errors are always Error instances; these branches guard a non-Error throw */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* istanbul ignore next -- defensive: see above */
  return String(err);
}
