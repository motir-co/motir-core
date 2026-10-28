import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { plansService, TEMP_REF_PREFIX } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  workItemRepository,
  type WorkItemValidityRow,
} from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanWithItemsDto,
} from '@/lib/dto/plans';
import { DEFAULT_PROPOSED_KIND } from '@/lib/plans/validateProposals';
import { isContainerKind } from '@/lib/plans/validateProposedKind';
import { isWorkItemRef } from '@/lib/plans/refs';
import { edgeDisposition, type EdgeDisposition } from '@/lib/workItems/edgeDisposition';
import type { WorkItem } from '@/generated/prisma/client';

// ── The PROJECTION, lifted (Story MOTIR-3093 · Subtask MOTIR-3096) ───────────
//
// *The project's live tree ⊕ a Plan's `PlanItem` delta*, assembled in memory and
// never persisted. It shipped with MOTIR-1386 as a module-private helper of
// `planValidityService`, because validity was its only consumer. MOTIR-3096 adds
// a second — the PROJECTED READS (`get_work_item` / `search_work_items` with a
// `planId`) — so it moves here rather than being written a second time. Two
// overlays answering the same question is exactly how they come to disagree
// about what a plan means, and `motir-ai`'s client-side `ctx.proposals` bag is
// already a separate one on the other side of a repo boundary that must NOT
// share code with this.
//
// Nothing about the semantics changed in the move. The projection rules below
// are MOTIR-1386's, verbatim, and they still match `plansService.materialize`:
//
//   • `add`    → a NEW not-done node under `resolve(parentRef)` with `blocked_by`
//                = `resolve(blockedByRefs)`. It lands in the BACKLOG (no sprint),
//                so it is NOT a sprint member unless a future field says so.
//   • `modify` → `patch.parentRef` MOVES the target (the projected `parentId`,
//                and therefore `childrenByParent` on BOTH sides), and
//                `patch.blockedByAdd` / `blockedByRemove` change its edge set.
//                Those three are what alter the SHAPE the walks read; the rest of
//                the patch is content the projected READS surface — see
//                `proposalByRef` / `patchByWorkItemId` below. Every one of them is
//                SPARSE: an absent key leaves the live value, and an explicit
//                `null` `parentRef` projects the target at the ROOT.
//                (MOTIR-3859 added the key to `PlanItemPatch`; until MOTIR-3867
//                this line said only the two edge keys, and it was the rule this
//                file was actually applying.)
//   • `remove` → the target node AND every edge touching it are dropped (a removed
//                item neither gates nor is gated — single-node, like archive).
//   • a temp-ref `planItem:<id>` resolves to that same-plan `add`; a real id to
//                itself.
//
// ── THE COST, MEASURED (MOTIR-3096) ─────────────────────────────────────────
// `buildProjection` loads the project's WHOLE live node set
// (`findAllByProjectForValidity`, six columns, no descriptions). That is plainly
// proportionate for a validity check run once before closing a plan and is NOT
// obviously proportionate for a read an agent calls every turn — so it was
// measured before shipping, on a project the size of MOTIR (3 201 work items,
// 20 proposals, local Postgres, mean of five runs after a warm-up):
//
//   search WITHOUT planId (getProjectIssuesList, one 50-row page)   15.9 ms
//   projectedSearchDelta  (a full buildProjection)                  35.5 ms
//   projectedWorkItem     (projection + root resolve + stored read) 113.5 ms
//
// So a projected search costs about 35 ms MORE than the plain one — roughly 2×,
// on an opt-in argument an authoring agent passes deliberately, a few times per
// turn, not on the hot path of anything. The bound HOLDS and no cap was added:
// capping a full-project load would mean answering about a PARTIAL tree, and a
// projection that silently omits nodes is worse than one that costs 35 ms.
//
// The detail read's 113 ms is dominated by its own batched stored-column read,
// and the fixture is the pathological shape for it — ONE epic with 3 200
// children, so `loadStoredRows` fetches 3 200 rows. The committed
// `get_work_item` aggregate reads the same children on the same card, so this is
// the shape's cost rather than the projection's. A card with a normal child
// count pays the projection build and little else.
//
// MOTIR-8146: the plan REVIEW's read no longer pays this. It asks only for off-level
// edge dispositions, so `buildProjection(…, { scope: 'edge_coverage' })` loads the
// nodes the plan names, the children of its `modify` targets, their blockers and
// every ancestor chain — a cost that scales with the plan, not the project. The
// default scope is unchanged and is still what every validity walk gets.
//
// ⚠️ READ-ONLY, and that is a contract rather than a happy accident: every load
// below is a read, the plan is fetched through `plansService.getPlan` (which
// applies the browse gate, so no consumer adds a second check), and nothing here
// writes. A consumer must not cache a projection across calls either — it is a
// snapshot of a tree two other sessions may be editing.

/** One node in the projected virtual graph (a real work item, or a plan `add`). */
export interface ProjectedNode {
  /** Real `workItemId`, or the temp-ref `planItem:<planItemId>` for an `add`. */
  id: string;
  /** Real identifier (e.g. "MOTIR-1337"), or the temp-ref for an `add`. */
  identifier: string;
  /** Raw workflow status key (an `add` carries the project's initial status). */
  status: string;
  /** The node's project (a blocker can be cross-project; finding #21). */
  projectId: string;
  /** Projected parent id (a real id or a temp-ref), or null. */
  parentId: string | null;
  /** Sprint membership; an `add` lands in the backlog → null. */
  sprintId: string | null;
  /**
   * The node's kind — an `add`'s proposed kind (defaulted as `materialize`
   * defaults it), a live row's stored kind. Read by the cross-parent coverage
   * check (MOTIR-6370), which judges SAME-level edges only.
   */
  kind: string;
}

/** The assembled projection: nodes + projected `blocked_by` adjacency. */
export interface Projection {
  projectId: string;
  /** id → node. Removed nodes are absent. */
  nodes: Map<string, ProjectedNode>;
  /** from-id → set of blocker (to) ids — the projected `is_blocked_by` edges. */
  blockedBy: Map<string, Set<string>>;
  /** from-id → (blocker id → reason): the reason each edge THIS PLAN draws carries
   *  (MOTIR-9827). A proposed edge with no reason, and every committed edge, is
   *  absent. */
  edgeReasons: Map<string, Map<string, string>>;
  /** parent-id → child ids — derived from `nodes`' projected `parentId`. */
  childrenByParent: Map<string, string[]>;
  /** Per-project terminal (`category = 'done'`) status keys, for done-ness. */
  terminalByProject: Map<string, Set<string>>;
  /**
   * The PROPOSED body of each `add`, keyed by its temp-ref — the only place a
   * not-yet-materialized node's `descriptionMd` exists, so the prose-vs-graph
   * advisory (MOTIR-1969) can scan a projected card the same way it scans a live
   * one. Real nodes' bodies are read on demand for the members actually scanned;
   * they are deliberately NOT loaded here, because `buildProjection` reads the
   * WHOLE project and descriptions are long.
   */
  projectedDescription: Map<string, string | null>;
  /**
   * The PROJECTED `type` / `executor` of each node the plan sets one on — an
   * `add`'s proposed values, or a `modify`'s patched `type`. Read ONLY by the
   * ORDERING advisory's exemption (MOTIR-2175), which suppresses on
   * `type: 'deploy'` / `executor: 'human'`: a plan that PROPOSES the release
   * trio's *cut* leg must not be warned about the very shape gate 14 asked for.
   *
   * Sparse, with `has()` semantics exactly like {@link projectedDescription}:
   * absent means "the plan does not touch it", so the stored value wins. (A
   * `modify` patch carries no `executor` field at all, so a modified node's
   * executor is always the stored one.)
   */
  projectedType: Map<string, string | null>;
  projectedExecutor: Map<string, string | null>;
  /**
   * The FULL `add` proposal behind each virtual node, keyed by its temp-ref
   * (MOTIR-3096). The validity walk needs only status/parent/edges, so it never
   * had a reason to keep the proposed BODY around; a projected READ has to
   * render the card an agent proposed — its title, kind, sizing, repo pin — and
   * re-reading the plan to get them would be a second `getPlan` per call.
   */
  proposalByRef: Map<string, PlanItemDto>;
  /**
   * The `modify` patch aimed at each REAL work item, keyed by its id. Same
   * reason: finishability reads only `blockedByAdd` / `blockedByRemove` from a
   * patch, and a projected read has to show the whole thing — *"this is the row
   * as it stands, and this is what the plan would change about it."*
   */
  patchByWorkItemId: Map<string, PlanItemPatch>;
  /** Ids the plan `remove`s. The nodes are already gone from {@link nodes}; this
   *  is what lets a READ say WHY a committed row it would otherwise return is
   *  absent, instead of silently dropping it. */
  removedIds: Set<string>;
}

function addEdge(blockedBy: Map<string, Set<string>>, fromId: string, toId: string): void {
  const set = blockedBy.get(fromId);
  if (set) set.add(toId);
  else blockedBy.set(fromId, new Set([toId]));
}

function removeEdge(blockedBy: Map<string, Set<string>>, fromId: string, toId: string): void {
  blockedBy.get(fromId)?.delete(toId);
}

/** How much of the live tree {@link buildProjection} loads. See its `scope` option. */
export type ProjectionScope = 'project' | 'edge_coverage';

type LiveEdges = Awaited<ReturnType<typeof workItemLinkRepository.findBlockerEdgesForItems>>;

/** The default load: the project's whole live node set and every blocker edge among it. */
async function loadWholeLiveGraph(
  projectId: string,
  ctx: ServiceContext,
): Promise<{ liveItems: WorkItemValidityRow[]; liveEdges: LiveEdges }> {
  const liveItems = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findAllByProjectForValidity(projectId, ctx.workspaceId, tx),
  );
  const liveEdges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemLinkRepository.findBlockerEdgesForItems(
      liveItems.map((it) => it.id),
      undefined,
      tx,
    ),
  );
  return { liveItems, liveEdges };
}

/**
 * The FOCUSED load behind `scope: 'edge_coverage'` (MOTIR-8146), in ONE bound
 * transaction. What the review's disposition reads, and so what is loaded:
 *
 *  - the real items the plan names (targets, parents, blockers) and the live
 *    children of every `modify` target — the child edges a parent's `blocked_by`
 *    change re-covers or uncovers;
 *  - the `blocked_by` edges out of those, whose blockers are the far ends;
 *  - every ancestor of every one of those ends (the level rule walks the chain),
 *    and the edges out of those ancestors (`parentBlockedBy` asks whether one
 *    parent is directly blocked by the other).
 *
 * The ancestor edges' own blockers are NOT closed over: they are never an end of a
 * pair the review asks about, and closing over them would walk the project's
 * dependency graph transitively. Depth is bounded by the tree's four levels, so the
 * ancestor loop is at most a few reads.
 */
async function loadFocusedLiveGraph(
  plan: { items: PlanItemDto[] },
  projectId: string,
  ctx: ServiceContext,
): Promise<{ liveItems: WorkItemValidityRow[]; liveEdges: LiveEdges }> {
  const named = new Set<string>();
  const modifyTargets = new Set<string>();
  const note = (ref: string | null | undefined) => {
    if (ref && isWorkItemRef(ref)) named.add(ref);
  };
  for (const item of plan.items) {
    note(item.workItemId);
    if (item.op === 'modify' && item.workItemId) modifyTargets.add(item.workItemId);
    note(item.parentRef);
    item.blockedByRefs.forEach(note);
    note(item.patch?.parentRef);
    item.patch?.blockedByAdd?.forEach(note);
    item.patch?.blockedByRemove?.forEach(note);
  }

  return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const rows = new Map<string, WorkItemValidityRow>();
    const keep = (found: WorkItemValidityRow[]) => {
      for (const r of found) rows.set(r.id, r);
    };
    keep(await workItemRepository.findForValidityByIds([...named], ctx.workspaceId, tx));
    keep(
      await workItemRepository.findForValidityByParentIds(
        [...modifyTargets],
        projectId,
        ctx.workspaceId,
        tx,
      ),
    );

    // The pair ENDS: every item loaded so far, and the blockers of the edges out of them.
    const edges = await workItemLinkRepository.findBlockerEdgesForItems(
      [...rows.keys()],
      undefined,
      tx,
    );
    const parentOf = new Map<string, string | null>();
    for (const r of rows.values()) parentOf.set(r.id, r.parentId);
    for (const e of edges) {
      if (!parentOf.has(e.blockerId) && e.blockerProjectId === projectId) {
        parentOf.set(e.blockerId, e.blockerParentId);
      }
    }

    // Close over the ancestors of every end, one level per read. A parent the read
    // does not return (archived, or in another workspace) is remembered as tried, so
    // the chain ends there exactly as `chainOf` ends it on a node the projection
    // does not hold.
    const tried = new Set<string>();
    const ancestorIds: string[] = [];
    for (;;) {
      const missing = new Set<string>();
      for (const parentId of parentOf.values()) {
        if (parentId && !rows.has(parentId) && !tried.has(parentId)) missing.add(parentId);
      }
      if (missing.size === 0) break;
      for (const id of missing) tried.add(id);
      for (const r of await workItemRepository.findForValidityByIds(
        [...missing],
        ctx.workspaceId,
        tx,
      )) {
        rows.set(r.id, r);
        ancestorIds.push(r.id);
        parentOf.set(r.id, r.parentId);
      }
    }

    // `findBlockerEdgesForItems` answers `[]` for no ids without a query.
    const ancestorEdges = await workItemLinkRepository.findBlockerEdgesForItems(
      ancestorIds,
      undefined,
      tx,
    );
    return { liveItems: [...rows.values()], liveEdges: [...edges, ...ancestorEdges] };
  });
}

/**
 * Build the virtual graph = the project's live tree ⊕ the plan's PlanItem delta.
 * Pure in-memory over read-only repository loads — NOTHING is persisted. The plan
 * is read through `plansService.getPlan`, which applies the browse access gate, so
 * the caller never reaches a plan/project it can't see.
 */
export async function buildProjection(
  planId: string,
  ctx: ServiceContext,
  opts: {
    caller?: 'actor' | 'system';
    /**
     * The plan with its items, ALREADY READ AND ADMITTED for `ctx` by the caller (MOTIR-8127). The
     * review read has just admitted the reader and read every proposal; re-doing both here cost
     * three transactions and a second full item read on every poll of a `generating` plan. Only a
     * caller that passed the reader gate itself may hand one in — it replaces the gate below.
     */
    plan?: PlanWithItemsDto;
    /**
     * HOW MUCH OF THE LIVE TREE to load (MOTIR-8146). `project` (the default) is the
     * project's whole live node set — what every validity walk and projected read
     * needs, because each can reach any node. `edge_coverage` loads only what the
     * plan REVIEW's off-level edge dispositions read: the nodes the plan names, the
     * children of its `modify` targets, those nodes' blockers, and every ancestor
     * chain — so the cost scales with the plan, not the project. A projection built
     * that way answers {@link projectedEdgeDisposition} and the `childrenByParent` /
     * `blockedBy` walks the review makes from the nodes the plan names, and NOTHING
     * ELSE: a validity walk over it would be answering about a partial tree.
     */
    scope?: ProjectionScope;
  } = {},
): Promise<Projection> {
  // An ACTOR's read of what a plan proposes (`validate_plan`, `get_work_item` /
  // `search_work_items` / `validate_work_item` / `validate_sprint` with `planId`)
  // admits by the Plans room's scope (MOTIR-6330): a plan the reader may not see
  // projects nothing and is not-found. The one SYSTEM caller — motir-ai's
  // internal `validate-plan-forest` route, validating a plan its own job wrote —
  // passes `caller: 'system'` and keeps the browse floor alone.
  const plan =
    opts.plan ??
    (opts.caller === 'system'
      ? await plansService.getPlan(planId, ctx)
      : await plansService.getPlanForReader(planId, ctx));
  const projectId = plan.projectId;

  // The project's live node set + the initial status an `add` would be created in.
  // The plan-health verdict's whole input, in ONE bound transaction. Unbound
  // these returned nothing, and a validity check over an empty set does not
  // report "I could not tell" — every rule is satisfied by an absence, so a plan
  // with real problems was pronounced healthy.
  const focused = opts.scope === 'edge_coverage';
  const { liveItems, liveEdges } = focused
    ? await loadFocusedLiveGraph(plan, projectId, ctx)
    : await loadWholeLiveGraph(projectId, ctx);
  const initialStatus =
    (await workflowsService.getInitialStatusKey(projectId, ctx.workspaceId)) ?? '';

  const nodes = new Map<string, ProjectedNode>();
  for (const it of liveItems) {
    nodes.set(it.id, {
      id: it.id,
      identifier: it.identifier,
      status: it.status,
      projectId: it.projectId,
      parentId: it.parentId,
      sprintId: it.sprintId,
      kind: it.kind,
    });
  }

  // Live `is_blocked_by` edges among the project's items. The blocker may be
  // cross-project (a block can span projects) — carry it in as a node from the
  // edge's own fields so its done-ness/membership is judged against its OWN project.
  const blockedBy = new Map<string, Set<string>>();
  for (const e of liveEdges) {
    if (!nodes.has(e.blockerId)) {
      nodes.set(e.blockerId, {
        id: e.blockerId,
        identifier: e.blockerKey,
        status: e.blockerStatus,
        projectId: e.blockerProjectId,
        // The whole-project load has every in-project blocker as a node already, so
        // only a cross-project one lands here (parent unknown → null, the permissive
        // answer). The focused load did not read the whole project, so an in-project
        // blocker lands here too and its own parent is what the edge row carries.
        parentId: focused && e.blockerProjectId === projectId ? e.blockerParentId : null,
        sprintId: e.blockerSprintId,
        kind: e.blockerKind,
      });
    }
    addEdge(blockedBy, e.fromId, e.blockerId);
  }

  const resolveRef = (ref: string): string =>
    ref.startsWith(TEMP_REF_PREFIX)
      ? `${TEMP_REF_PREFIX}${ref.slice(TEMP_REF_PREFIX.length)}`
      : ref;

  const adds = plan.items.filter((i) => i.op === 'add');
  const modifies = plan.items.filter((i) => i.op === 'modify');
  const removes = plan.items.filter((i) => i.op === 'remove');

  // Pass 1 — virtual `add` nodes (keyed by their temp-ref, so an intra-plan
  // parent/blocker ref resolves with no topo ordering needed).
  const projectedDescription = new Map<string, string | null>();
  const projectedType = new Map<string, string | null>();
  const projectedExecutor = new Map<string, string | null>();
  const proposalByRef = new Map<string, PlanItemDto>();
  for (const item of adds) {
    const id = `${TEMP_REF_PREFIX}${item.id}`;
    proposalByRef.set(id, item);
    projectedDescription.set(id, item.proposedFields?.descriptionMd ?? null);
    // An `add` has no stored row, so its proposed shape is the ONLY shape there
    // is — set both keys unconditionally, absent proposal included (`null`).
    projectedType.set(id, item.proposedFields?.type ?? null);
    projectedExecutor.set(id, item.proposedFields?.executor ?? null);
    nodes.set(id, {
      id,
      identifier: id,
      status: initialStatus,
      projectId,
      parentId: item.parentRef ? resolveRef(item.parentRef) : null,
      sprintId: null,
      kind: item.proposedFields?.kind ?? DEFAULT_PROPOSED_KIND,
    });
  }

  // A real id an `add`/`modify` references but the project load didn't cover (a
  // cross-project blocker not already on a live edge). Resolve it to a node so its
  // status/project/sprint are real; an archived/missing ref simply yields no node,
  // so the edge is dropped (mirrors the archived-blocker read-exclusion).
  const referenced = new Set<string>();
  const note = (ref: string) => {
    const id = resolveRef(ref);
    if (!id.startsWith(TEMP_REF_PREFIX) && !nodes.has(id)) referenced.add(id);
  };
  for (const item of adds) item.blockedByRefs.forEach(note);
  for (const item of modifies) (item.patch?.blockedByAdd ?? []).forEach(note);
  if (referenced.size > 0) {
    const extra = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace([...referenced], ctx.workspaceId, tx),
    );
    for (const row of extra) {
      if (row.archivedAt) continue;
      nodes.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        status: row.status,
        projectId: row.projectId,
        parentId: row.parentId,
        sprintId: row.sprintId,
        kind: row.kind,
      });
    }
  }

  // Pass 2 — `add` blocked_by edges (all add targets now exist).
  const edgeReasons = new Map<string, Map<string, string>>();
  const noteReason = (fromId: string, toId: string, reason: string | undefined) => {
    if (!reason) return;
    const byBlocker = edgeReasons.get(fromId) ?? new Map<string, string>();
    byBlocker.set(toId, reason);
    edgeReasons.set(fromId, byBlocker);
  };
  for (const item of adds) {
    const fromId = `${TEMP_REF_PREFIX}${item.id}`;
    for (const ref of item.blockedByRefs) {
      const toId = resolveRef(ref);
      if (nodes.has(toId)) addEdge(blockedBy, fromId, toId);
      noteReason(fromId, toId, item.edgeReasons?.[ref]);
    }
  }

  // Pass 3 — `modify` edge changes (title/priority/type ignored for finishability).
  const patchByWorkItemId = new Map<string, PlanItemPatch>();
  for (const item of modifies) {
    if (!item.workItemId || !nodes.has(item.workItemId)) continue;
    if (item.patch) patchByWorkItemId.set(item.workItemId, item.patch);
    // A patched BODY is what the prose-vs-graph advisory must scan — the plan's
    // proposed text, not the stored one. Sparse-patch semantics: the key being
    // ABSENT means unchanged (fall through to the live body); present-but-null
    // means the plan clears it.
    if (item.patch && 'descriptionMd' in item.patch) {
      projectedDescription.set(item.workItemId, item.patch.descriptionMd ?? null);
    }
    // Same sparse-patch semantics for the ORDERING exemption's `type`
    // (MOTIR-2175). `PlanItemPatch` has no `executor` key, so a modified node's
    // executor is never projected — the stored value stands.
    if (item.patch && 'type' in item.patch) {
      projectedType.set(item.workItemId, item.patch.type ?? null);
    }
    // The RE-KIND (bug MOTIR-8192 · AMENDMENT 25) — the node takes the kind the
    // approve will write, so every kind-reading rule downstream judges a task
    // turned story as a story. A re-kind to a container also DERIVES the
    // executor to `null` at approve (`applyModify`), so it is projected so.
    if (item.patch?.kind) {
      nodes.get(item.workItemId)!.kind = item.patch.kind;
      if (isContainerKind(item.patch.kind)) projectedExecutor.set(item.workItemId, null);
    }
    // The RE-PARENT (MOTIR-3859's `patch.parentRef`, projected by MOTIR-3867).
    // Same sparse-patch semantics, and here they are load-bearing rather than
    // tidy: collapsing ABSENT into `null` would project every untouched `modify`
    // at the project root. Mutating the node's `parentId` in place is the whole
    // fix — `childrenByParent` is derived from the FINAL `nodes` map below, so
    // the vacated parent loses the child and the joined parent gains it from this
    // one write, in the same pass and with no second adjacency to keep in step.
    //
    // Applied UNCONDITIONALLY, exactly as `materialize` applies it: a
    // cross-project, kind-illegal, cyclic, too-deep or terminal parent is refused
    // at the append (`validateProposals`' `assertReparentLegal`), so a `parentRef`
    // that reaches here names a live, legal, same-project row — or, since
    // AMENDMENT 18 §1 (MOTIR-6050), a proposed `add` on this plan, which
    // `resolveRef` maps to its projected node like any other temp-ref.
    if (item.patch && 'parentRef' in item.patch) {
      const ref = item.patch.parentRef;
      // `!` rather than a guard: this loop already `continue`d on
      // `!nodes.has(item.workItemId)`, so a defensive arm here would be dead code
      // the per-file coverage gate would then ask for a test that cannot be written.
      nodes.get(item.workItemId)!.parentId = ref == null ? null : resolveRef(ref);
    }
    for (const ref of item.patch?.blockedByAdd ?? []) {
      const toId = resolveRef(ref);
      if (nodes.has(toId)) addEdge(blockedBy, item.workItemId, toId);
      noteReason(item.workItemId, toId, item.edgeReasons?.[ref]);
    }
    for (const ref of item.patch?.blockedByRemove ?? []) {
      removeEdge(blockedBy, item.workItemId, resolveRef(ref));
    }
  }

  // Pass 4 (LAST) — `remove` drops the target node AND every edge touching it, so
  // a removed item neither gates nor is gated even if an earlier pass added an edge.
  const removedIds = new Set<string>();
  for (const item of removes) {
    const target = item.workItemId;
    if (!target) continue;
    removedIds.add(target);
    nodes.delete(target);
    blockedBy.delete(target);
    for (const set of blockedBy.values()) set.delete(target);
  }

  // Derived parent→child adjacency over the final projected `parentId` edges.
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentId == null) continue;
    const arr = childrenByParent.get(node.parentId);
    if (arr) arr.push(node.id);
    else childrenByParent.set(node.parentId, [node.id]);
  }

  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    [...new Set([...nodes.values()].map((n) => n.projectId))],
    ctx.workspaceId,
  );

  return {
    projectId,
    nodes,
    blockedBy,
    edgeReasons,
    childrenByParent,
    terminalByProject,
    projectedDescription,
    projectedType,
    projectedExecutor,
    proposalByRef,
    patchByWorkItemId,
    removedIds,
  };
}

/** Is a node's raw status terminal (`category = 'done'`) in its OWN project? */
export function isDone(proj: Projection, node: ProjectedNode): boolean {
  return proj.terminalByProject.get(node.projectId)?.has(node.status) ?? false;
}

/**
 * Resolve the subtree-validation ROOT. A `planItem:<id>` temp-ref points at an
 * `add` THIS plan proposes — it lives in the projection (keyed by its temp-ref),
 * so resolve it there; an unknown temp-ref (no such proposed node) is a
 * `WorkItemNotFoundError`. Any other key is a REAL item resolved against the live
 * tree (the existing-anchor / extend case). Returns just `{ id, identifier }` —
 * the only fields the subtree walk + verdict need (MOTIR-1431).
 */
export async function resolveProjectedRoot(
  proj: Projection,
  targetKey: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  if (targetKey.startsWith(TEMP_REF_PREFIX)) {
    const node = proj.nodes.get(targetKey);
    if (!node) throw new WorkItemNotFoundError(targetKey);
    return { id: node.id, identifier: node.identifier };
  }
  const wi = await workItemsService.getWorkItemByIdentifier(proj.projectId, targetKey, ctx);
  return { id: wi.id, identifier: wi.identifier };
}

// ── The PROJECTED READS (Story MOTIR-3093 · Subtask MOTIR-3096) ──────────────
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3 Q6 admits exactly two
// reads to the projection — `get_work_item` and `search_work_items` — and Q7
// pins how a proposal is told apart from a work item in the answer: by a field,
// never by prose, and with NO key, because a proposal has none until approve.
//
// ⚠️ THE DISCRIMINATOR IS STRUCTURAL AS WELL AS PER-ROW, and the reason is worth
// stating because it STRENGTHENS Q7 rather than reinterpreting it. The MCP
// payload seam (ADR Amendment 7) requires `search_work_items`' `items` and
// `get_work_item`'s `children` to satisfy the shared v1 resource shapes, which a
// keyless proposal cannot — so proposals ride their own arrays (`proposals`,
// `proposedChildren`) rather than being mixed into those. Every existing reader
// of `items` / `children` is therefore untouched by construction, and a caller
// that flattens the arrays anyway STILL cannot lose the distinction, because
// each row also carries `proposal: true` and `key: null`.

/**
 * One row of a projected read — a committed work item or a proposal, in the SAME
 * shape, with `proposal` deciding which.
 *
 * Fields a proposal genuinely does not have (`status` history, an assignee, a
 * sprint) are `null` rather than defaulted to a plausible value: *no comment
 * thread* and *zero comments* are different facts, and only one of them is true
 * of something that does not exist yet.
 */
export interface ProjectedRowDto {
  /** TRUE ⟺ this is a plan proposal. Always present on BOTH kinds — never an
   *  absent-means-false optional, because a consumer that forgets the field must
   *  not silently read a proposal as a work item. */
  proposal: boolean;
  /** The `<KEY>-<n>` identifier — NULL for a proposal, which has none until
   *  approve. No key is ever synthesized: a `MOTIR-`-shaped string on a row that
   *  no `get_work_item` can fetch is the worst thing this read could return. */
  key: string | null;
  /** The `PlanItem` id behind a proposal (null for a committed row). */
  planItemId: string | null;
  /** The `planItem:<id>` temp-ref a proposal is ADDRESSED by — what you pass
   *  back as a `key` / `parentRef` / `blockedByRefs` entry (null for a committed
   *  row, which is addressed by `key`). */
  tempRef: string | null;
  title: string | null;
  kind: string | null;
  type: string | null;
  priority: string | null;
  /** A proposal's status is the workflow's INITIAL status — what it would be
   *  created in. It is not something the plan proposed. */
  status: string;
  storyPoints: number | null;
  estimateMinutes: number | null;
  targetRepo: string | null;
  /**
   * EVERY repository the row ships in, ordered (bug MOTIR-4904) — the SET beside
   * `targetRepo`'s primary, so the pre-close projection check can SEE a
   * two-repository card the plan proposes. A proposal that pinned only the
   * singular reports it as the one-element set it means.
   */
  targetRepos: string[];
  /**
   * The repository axis as `project_repository` ROW IDS, when a PROPOSAL authored
   * it that way (bug MOTIR-4904) — never resolved to names here, because
   * resolution is a read this projection deliberately does not make. Empty for a
   * committed row, whose names `targetRepos` above already carries.
   */
  targetRepositories: string[];
  /** The parent, as the projection sees it: a real key, or a temp-ref when the
   *  parent is itself a proposal in this plan. */
  parent: string | null;
  /** ⚠️ Present ONLY on a committed row the plan `modify`s — the patch, verbatim.
   *  The row's own fields are what it is TODAY; this is what would change. */
  pendingPatch: PlanItemPatch | null;
  /** Present ONLY on a `blockedBy` row whose edge THIS PLAN draws with a reason
   *  (MOTIR-9827): what the target consumes from this blocker. */
  edgeReason?: string;
}

/** The projected DETAIL of one target — the `get_work_item` projected answer. */
export interface ProjectedDetailDto {
  planId: string;
  /** The target itself, committed or proposed. */
  target: ProjectedRowDto;
  parent: ProjectedRowDto | null;
  /** Children the projection keeps — COMMITTED ones only, minus any the plan
   *  removes. Named `committedChildren` rather than `children` because the tool's
   *  payload already has a `children` (the committed aggregate's, deriving from
   *  the v1 child schema) and two arrays one word apart would be exactly the
   *  confusion this whole answer shape exists to prevent. */
  committedChildren: ProjectedRowDto[];
  /** Children this PLAN proposes under the target. */
  proposedChildren: ProjectedRowDto[];
  /** Projected `blocked_by` — mixed committed and proposed, each self-marked. */
  blockedBy: ProjectedRowDto[];
}

/** The projected additions a search answers with, plus what the plan removes. */
export interface ProjectedSearchDto {
  planId: string;
  /** The plan's `add`s, in append order. */
  proposals: ProjectedRowDto[];
  /** Committed work-item ids the plan `remove`s — the caller drops these from
   *  its own result page, so a projected search does not return a row the plan
   *  is deleting. */
  removedIds: string[];
  /** Committed ids the plan `modify`s, so a caller can mark them. */
  modifiedIds: string[];
}

/** The stored columns a projected row needs and the validity load deliberately
 *  does NOT carry. `findAllByProjectForValidity` selects six columns for the
 *  whole project on purpose — widening it would make every validity check pay
 *  for titles it never reads — so a READ batches these for exactly the ids its
 *  own answer contains, the same shape `projectedProseAdvisories` uses. */
interface StoredColumns {
  title: string | null;
  kind: string | null;
  type: string | null;
  priority: string | null;
  /** A plain number here, not the row's Prisma `Decimal` — the same conversion
   *  every work-item mapper makes, done once at the boundary. */
  storyPoints: number | null;
  estimateMinutes: number | null;
  targetRepo: string | null;
  targetRepos: string[];
}

/**
 * The null-object for a committed id whose stored row is somehow absent.
 *
 * ONE guard, not seven `?? null`s. `loadStoredRows` batches every committed id
 * an answer will name, so a miss is not reachable through either public entry —
 * and saying that once beats seven optional chains, each of which would be an
 * untaken branch pretending to be a case somebody handled.
 */
const NO_STORED_ROW: StoredColumns = {
  title: null,
  kind: null,
  type: null,
  priority: null,
  storyPoints: null,
  estimateMinutes: null,
  targetRepo: null,
  targetRepos: [],
};

function toStoredColumns(
  row: Pick<
    WorkItem,
    | 'title'
    | 'kind'
    | 'type'
    | 'priority'
    | 'storyPoints'
    | 'estimateMinutes'
    | 'targetRepo'
    | 'targetRepos'
  >,
): StoredColumns {
  return {
    title: row.title,
    kind: row.kind,
    type: row.type,
    priority: row.priority,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    estimateMinutes: row.estimateMinutes,
    targetRepo: row.targetRepo,
    targetRepos: row.targetRepos,
  };
}

/** The null-object twin of {@link NO_STORED_ROW}, for an `add` whose
 *  `proposedFields` is somehow absent. `addProposals` rejects one, so this is
 *  unreachable through the public entries and is stated once rather than
 *  re-guarded at every field. */
const NO_PROPOSED_FIELDS: PlanItemProposedFields = { title: '' };

/** Batched stored columns for the committed ids an answer will contain. */
async function loadStoredRows(
  ids: string[],
  ctx: ServiceContext,
): Promise<Map<string, StoredColumns>> {
  const real = ids.filter((id) => !id.startsWith(TEMP_REF_PREFIX));
  if (real.length === 0) return new Map();
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findByIdsInWorkspace(real, ctx.workspaceId, tx),
  );
  return new Map(rows.map((r) => [r.id, toStoredColumns(r)] as [string, StoredColumns]));
}

/** Read one node out of the projection as a row. Returns null for an id the
 *  projection does not hold (a `remove`d target, an unknown ref). */
function rowOf(
  proj: Projection,
  id: string,
  storedRows: Map<string, StoredColumns>,
): ProjectedRowDto | null {
  const node = proj.nodes.get(id);
  if (!node) return null;
  const proposal = proj.proposalByRef.get(id);
  const parentId = node.parentId;
  const parentNode = parentId === null ? null : proj.nodes.get(parentId);
  const parent = parentNode ? parentNode.identifier : parentId;
  if (proposal) {
    // Same null-object discipline as `NO_STORED_ROW`: an `add`'s `proposedFields`
    // is validated non-null at `addProposals`, so seven optional chains here
    // would be seven untaken branches dressed as handled cases.
    const f = proposal.proposedFields ?? NO_PROPOSED_FIELDS;
    return {
      proposal: true,
      key: null,
      planItemId: proposal.id,
      tempRef: id,
      title: f.title,
      kind: f.kind ?? null,
      type: f.type ?? null,
      priority: f.priority ?? null,
      status: node.status,
      storyPoints: f.storyPoints ?? null,
      estimateMinutes: f.estimateMinutes ?? null,
      targetRepo: f.targetRepo ?? null,
      // The proposed SET (bug MOTIR-4904). A proposal pinning only the singular
      // reports the one-element set it means, so a reader never sees "no
      // repositories" for a card that has one.
      targetRepos: f.targetRepos ?? (f.targetRepo ? [f.targetRepo] : []),
      targetRepositories: f.targetRepositories ?? [],
      parent,
      pendingPatch: null,
    };
  }
  // ONE guard, not eight `?? null`s. `loadStoredRows` batches every committed id
  // the answer will name, so a miss here is not reachable through either public
  // entry — and a null-object says that once, where eight optional chains would
  // each be an untaken branch pretending to be a case somebody handled.
  const stored = storedRows.get(id) ?? NO_STORED_ROW;
  return {
    proposal: false,
    key: node.identifier,
    planItemId: null,
    tempRef: null,
    title: stored.title,
    kind: stored.kind,
    type: proj.projectedType.has(id) ? (proj.projectedType.get(id) ?? null) : stored.type,
    priority: stored.priority,
    status: node.status,
    storyPoints: stored.storyPoints,
    estimateMinutes: stored.estimateMinutes,
    targetRepo: stored.targetRepo,
    targetRepos: stored.targetRepos,
    targetRepositories: [],
    parent,
    pendingPatch: proj.patchByWorkItemId.get(id) ?? null,
  };
}

/**
 * The projected DETAIL of one target — a committed key, or a `planItem:<id>`
 * temp-ref for a card THIS plan proposes.
 *
 * Read-only, like everything else here. Throws `WorkItemNotFoundError` for an
 * unknown key or an unknown temp-ref, and the plan-read errors
 * (`PlanNotFoundError` / `ProjectAccessDeniedError`) from the projection build.
 */
export async function projectedWorkItem(
  planId: string,
  targetKey: string,
  ctx: ServiceContext,
): Promise<ProjectedDetailDto> {
  const proj = await buildProjection(planId, ctx);
  const root = await resolveProjectedRoot(proj, targetKey, ctx);
  const childIds = proj.childrenByParent.get(root.id) ?? [];
  const blockerIds = [...(proj.blockedBy.get(root.id) ?? [])];
  const parentNodeId = proj.nodes.get(root.id)?.parentId ?? null;
  // ONE batched read for every committed id this answer will name — the target,
  // its parent, its children and its blockers — never one per row.
  const storedRows = await loadStoredRows(
    [root.id, ...(parentNodeId === null ? [] : [parentNodeId]), ...childIds, ...blockerIds],
    ctx,
  );
  const target = rowOf(proj, root.id, storedRows);
  // `resolveProjectedRoot` resolves a REAL key against the live tree, which the
  // plan may have `remove`d out of the projection — a real target with no
  // projected node. That is not a not-found: the card exists and the plan
  // proposes deleting it, which is exactly what a reader needs to be told.
  if (!target) {
    return {
      planId,
      target: {
        proposal: false,
        key: root.identifier,
        planItemId: null,
        tempRef: null,
        title: null,
        kind: null,
        type: null,
        priority: null,
        status: 'removed_by_plan',
        storyPoints: null,
        estimateMinutes: null,
        targetRepo: null,
        targetRepos: [],
        targetRepositories: [],
        parent: null,
        pendingPatch: null,
      },
      parent: null,
      committedChildren: [],
      proposedChildren: [],
      blockedBy: [],
    };
  }
  const childRows = childIds
    .map((id) => rowOf(proj, id, storedRows))
    .filter((r): r is ProjectedRowDto => r !== null);
  return {
    planId,
    target,
    parent: parentNodeId === null ? null : rowOf(proj, parentNodeId, storedRows),
    committedChildren: childRows.filter((r) => !r.proposal),
    proposedChildren: childRows.filter((r) => r.proposal),
    blockedBy: blockerIds
      .map((id) => {
        const row = rowOf(proj, id, storedRows);
        const reason = proj.edgeReasons.get(root.id)?.get(id);
        return row && reason ? { ...row, edgeReason: reason } : row;
      })
      .filter((r): r is ProjectedRowDto => r !== null),
  };
}

/**
 * The body, kind and type of one projected target — what `get_work_item` parses
 * when it is asked for the sections view of a card as the plan would leave it
 * (MOTIR-9033). A proposal's body is its own `proposedFields`; a committed card's
 * is the plan's patched text where the plan sets one, else the stored row, with
 * the same has-semantics every other projected read uses. `null` when the plan
 * removes the card — there is no body to parse.
 */
export async function projectedBodyOf(
  planId: string,
  targetKey: string,
  ctx: ServiceContext,
): Promise<{ descriptionMd: string | null; kind: string; type: string | null } | null> {
  const proj = await buildProjection(planId, ctx);
  const root = await resolveProjectedRoot(proj, targetKey, ctx);
  const node = proj.nodes.get(root.id);
  if (!node) return null;
  const proposal = proj.proposalByRef.get(root.id);
  if (proposal) {
    const f = proposal.proposedFields ?? NO_PROPOSED_FIELDS;
    return {
      descriptionMd: f.descriptionMd ?? null,
      kind: f.kind ?? DEFAULT_PROPOSED_KIND,
      type: f.type ?? null,
    };
  }
  const stored = (
    await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findDescriptionsByIds([root.id], ctx.workspaceId, tx),
    )
  )[0];
  return {
    descriptionMd: proj.projectedDescription.has(root.id)
      ? (proj.projectedDescription.get(root.id) ?? null)
      : (stored?.descriptionMd ?? null),
    kind: stored?.kind ?? node.kind,
    type: proj.projectedType.has(root.id)
      ? (proj.projectedType.get(root.id) ?? null)
      : (stored?.type ?? null),
  };
}

/**
 * The plan's own delta, as rows a search can publish beside its committed page.
 *
 * ⚠️ It does NOT apply the caller's filter. The FilterAST compiles to SQL over
 * `work_item` rows and a proposal is not one, so the honest options were to
 * reimplement the grammar in memory (a second compiler, drifting) or to say
 * plainly that the filter does not reach proposals. MOTIR-3096 takes the second:
 * a projected search returns the page the filter selected AND the plan's whole
 * `add` set, and the tool's own answer says so in as many words. That is the
 * SAME answer every time — the property the card asked for — rather than one
 * that depends on which fields a given proposal happens to carry.
 */
export async function projectedSearchDelta(
  planId: string,
  ctx: ServiceContext,
): Promise<ProjectedSearchDto> {
  const proj = await buildProjection(planId, ctx);
  // A proposal's PARENT may be a committed row, whose identifier the projection
  // already holds — so no stored read is needed for the proposal rows
  // themselves, and an empty map is the honest argument rather than a load
  // nothing would consume.
  const noStoredRows = new Map<string, StoredColumns>();
  const proposals: ProjectedRowDto[] = [];
  for (const ref of proj.proposalByRef.keys()) {
    // TOTAL, not optimistic: `proposalByRef`'s keys ARE the `add` nodes
    // `buildProjection` put in `proj.nodes`, so `rowOf` resolves every one.
    proposals.push(rowOf(proj, ref, noStoredRows)!);
  }
  return {
    planId,
    proposals,
    removedIds: [...proj.removedIds],
    modifiedIds: [...proj.patchByWorkItemId.keys()],
  };
}

/**
 * The DISPOSITION of one projected `blocked_by` edge (MOTIR-6362) — what the plan
 * review canvas draws for it once the plan materializes: `covered` when the
 * PROJECTED parents carry the edge, `uncovered` / `cross_level` when the validators
 * would call it invalid, `exempt` when an end has no parent. The same
 * `edgeDisposition` the committed roadmap read asks (MOTIR-6359), fed the
 * projection instead of the tree — so a proposal that also wires its parents'
 * edge previews clean, and one whose plan removes that edge previews flagged.
 * `undefined` when an end is not in the projection. Pure over `proj`.
 */
export function projectedEdgeDisposition(
  proj: Projection,
  blockedId: string,
  blockerId: string,
): EdgeDisposition | undefined {
  const chainOf = (id: string): string[] => {
    const up: string[] = [];
    const seen = new Set<string>([id]);
    let cur = proj.nodes.get(id)?.parentId ?? null;
    while (cur !== null && !seen.has(cur) && proj.nodes.has(cur)) {
      up.push(cur);
      seen.add(cur);
      cur = proj.nodes.get(cur)!.parentId;
    }
    return up;
  };
  return edgeDisposition(
    { blockedId, blockerId },
    (id) => {
      const n = proj.nodes.get(id);
      return n ? { parentId: n.parentId, ancestors: chainOf(id), kind: n.kind } : undefined;
    },
    (from, to) => proj.blockedBy.get(from)?.has(to) ?? false,
  );
}
