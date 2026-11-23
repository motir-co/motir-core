import {
  PlanItemNode,
  ProposedBlockerAnchor,
  type PlanItemOutcome,
} from '@/components/planning/PlanItemNode';
import { GhostAnchor } from '@/components/planning/WorkItemNode';
import { ghostAnchorNode } from '@/components/planning/workItemLevel';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { proposalLevelKey, proposedParentNodeIds } from '@/lib/planning/planShape';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { EdgeDisposition } from '@/lib/workItems/edgeDisposition';

// One LEVEL of the plan-detail canvas (MOTIR-3083, redrawing 7.4.5 / MOTIR-847).
//
// ── What changed, and why ───────────────────────────────────────────────────
// This module used to build a forest from the plan's PlanItems ALONE, which the
// consumer then sliced per level. That made the canvas show the proposals and
// nothing else, with two consequences: a proposal parented under a COMMITTED
// item drew at the top level looking exactly like a genuine root (`isRoot` is
// true both for "no parent" and for "a parent outside the rendered set" — right
// for a partial subtree, wrong here), and a reviewer could not see what the new
// card would live beside.
//
// The plan detail is now the ROADMAP, drilled to the level a proposal lands in
// (`design/ai-planning/design-notes.md` Part V; the model is `design/roadmap`'s
// MULTI-LEVEL CHAINS — DRILL-DOWN). So a level is:
//
//     the focused parent's REAL children  ∪  this plan's proposals at that level
//
// and NOTHING else differs from the roadmap — same engine, same edge language,
// same breadcrumb. Only the proposed card's style differs.
//
// ⚠️ A committed sibling is on the canvas because it is a CHILD of the focused
// parent, never because something depends on it. Do not filter the level by
// dependency: seeing the company a proposed card will keep is most of what "is
// this the right place for it?" means.

/** A canvas level: the nodes at it and the edges between them. */
export interface PlanCanvasLevel {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
}

/**
 * The plan's proposals that belong at ONE level (`parentId` null = top level).
 *
 * ⚠️ KEYED ON THE LEVEL, not on `parentNodeId` (Bug MOTIR-5782; design Part XVIII
 * decision 2). A folder-filed proposal is a ROOT in the review model, and the
 * canvas now draws its folder as a level, so it sits on `folder:<id>` — beside the
 * committed work the server read files there — rather than loose at the root. One
 * rule for every op: a `modify` / `remove` keys by where its target WILL sit, so a
 * card moving into a folder is drawn on the folder's level (decision 4). A stale
 * folder has no level, and its proposal stays at the root (decision 6).
 */
export function proposalsAtLevel(
  items: PlanReviewItemDto[],
  parentId: string | null,
): PlanReviewItemDto[] {
  return items.filter((i) => proposalLevelKey(i) === parentId);
}

/**
 * Merge this plan's proposals into the COMMITTED level the roadmap read returned.
 *
 * `add` gets an extra node at the level. `modify` / `remove` reuse the SAME node
 * id as their target, so the op treatment lands on the committed sibling already
 * there rather than drawing a ghost copy beside it.
 */
export function mergePlanLevel(
  committed: PlanCanvasLevel,
  items: PlanReviewItemDto[],
  parentId: string | null,
  /**
   * The plan's DECISION, once it has one (MOTIR-3161) — drawn on every node the
   * plan contributes, and on none of the committed neighbours, which the plan
   * decided nothing about. `null` while the plan is still `planned`, which is
   * every level that rendered before this.
   */
  outcome: PlanItemOutcome | null = null,
): PlanCanvasLevel {
  const atLevel = proposalsAtLevel(items, parentId);
  const pending = new Map(atLevel.map((i) => [i.nodeId, i]));

  // ⚠️ A COMMITTED CARD THE PLAN PUTS WORK UNDER BECOMES DRILLABLE (bug
  // MOTIR-4266). `buildWorkItemLevel` takes `drillable` from the ROADMAP read,
  // which counts COMMITTED children only — so a story with nothing under it yet
  // arrived `drillable: false` however many subtasks this plan proposes beneath
  // it, the canvas drew View and no Open pill, and the expansion the plan is
  // ABOUT was unreachable from the level the story lives on. Expanding an
  // existing story is the commonest thing a planning pass does, and the
  // plan-change canvas has had this rule since MOTIR-1730; the review canvas —
  // the surface the plan is approved from — never got it.
  //
  // The whole plan is read, not `atLevel`: the question is what sits UNDER each
  // node here, which is a level DOWN. Every op counts, because `parentNodeId` is
  // where the proposal SITS, including a `modify` that re-parents a card onto
  // this node (MOTIR-3859).
  const gainsChildren = proposedParentNodeIds(items);

  // ⚠️ A CARD THE PLAN RE-PARENTS AWAY FROM THIS LEVEL IS NOT ON IT (bug
  // MOTIR-5006) — the FOURTH field taken off the level's committed read and never
  // re-asked about a card the plan is moving, and the only one that is not a
  // decoration: it is whether the card is there at all. `planReviewService`'s
  // `parentNodeIdOf` already reports a re-parented card at its DESTINATION, for
  // the stated reason that *"a re-parent that drew the card in its OLD level
  // would be the plan review showing the approver the opposite of what approving
  // does"*. That sentence is about the ORIGIN as much as the destination, and only
  // half of it was ever applied: at the origin the card fell out of `atLevel`, so
  // `pending` had no entry for it, the map below passed it through untouched, and
  // it sat among its siblings with its committed arrows intact.
  //
  // ── THE DISPOSITION, and why this one ──────────────────────────────────────
  // The card is taken OFF the level, and every committed edge between it and a
  // card that STAYS is drawn by the OFF-LEVEL rule — a `cross` arrow to a naming
  // anchor — rather than kept as a within-level arrow or dropped. Three claims,
  // and the third is the one that settles it:
  //
  //  - It is what this function is ALREADY decided by. MOTIR-4098 reversed the
  //    first fix for a REMOVED EDGE and the comment sixty lines down states the
  //    rule it left behind: *"the graph draws what approving would LEAVE
  //    BEHIND."* A node is a stronger claim than an arrow, not a weaker one — a
  //    card drawn on a level says *this container holds this card* — so a
  //    treatment saying *it is leaving* is the same marked-going-away shape that
  //    was tried and reverted, one field up.
  //  - It is what the level ACTUALLY looks like after approve. Re-read level `L`
  //    once the plan lands: the card is not among its children, and the
  //    dependency it left behind is a cross-container blocker with a ghost
  //    anchor. Dropping the card and its edges would under-draw that by one
  //    arrow; keeping the card would over-draw it by one node. Neither is the
  //    level the reviewer gets.
  //  - It answers the under-report the ALTERNATIVE was raised against. The cost
  //    of a bare DROP is MOTIR-4951's — the reviewer loses a card without being
  //    told. They are told: the card is named on its anchor, and the arrow flies
  //    the bad-plan flag, which is the honest verdict about a plan that moves a
  //    blocker out of its dependent's container. Under a *departing* skin that
  //    warning cannot be drawn at all, because the card is still on the level and
  //    the edge is still within it.
  //
  // ── WHERE THE MECHANISM LIVES ──────────────────────────────────────────────
  // NOT HERE, and for exactly MOTIR-4952's reason rather than a new one: two of
  // the three effects are unreachable downstream — the `crossBlocked` ring is
  // baked into the dependent's rendered `content`, and the anchor must be minted
  // before the merge runs. So the consumer answers *which rows is this plan
  // moving off?* (`PlanReviewCanvas`, one pass over the whole `items` array,
  // beside the `arrivingBlockers` map it is the mirror of) and
  // `buildWorkItemLevel`'s `departingIds` takes them off the level with a naming
  // stub. By the time this function runs, `committed` no longer contains the
  // card — which is why the map below needs no departure case, and why a
  // `modify` that does NOT re-parent still re-skins in place exactly as before.
  //
  // That is the shape MOTIR-4952 introduced and this card completes: everything
  // the merge inherits from the committed read is provisional with respect to the
  // cards the plan moves, in BOTH directions, and each direction is now answered
  // at the source rather than patched a field at a time.

  // ⚠️ A PROPOSAL BLOCKED BY A CARD OFF THIS LEVEL FLIES THE BAD-PLAN FLAG (bug
  // MOTIR-5387) — the fifth fact in this family, and the one the legend names.
  // `buildWorkItemLevel` draws an off-level blocker with three effects: a `cross`
  // arrow, a viewable GHOST ANCHOR naming the blocker, and the dependent's
  // "blocked elsewhere" tab. A COMMITTED edge reaches that branch; a proposal's
  // own edges never did, because both carrier loops below kept an edge only when
  // BOTH ends sat on this level and dropped the rest. So a plan adding a
  // cross-container dependency drew nothing, and approving it was the first time
  // the reviewer saw the flag the legend calls *"the blocker sits elsewhere in the
  // plan (a bad plan)"* — on the roadmap, with no decision left for it to inform.
  //
  // The disposition is the one this family is decided by: draw the level the
  // reviewer gets AFTER approve. Materialized, the same edge comes back from the
  // roadmap read and takes the off-level branch, so it takes the same treatment
  // here, in the same language — the anchor is minted by the same
  // `ghostAnchorNode` and the flag is the same `BlockedTab` (MOTIR-12158). The review
  // model supplies what an anchor needs (`blockerStubs`), because the two edge
  // carriers name ids only.
  //
  // ── WHAT "ON THE LEVEL" MEANS, and why it is not "has a node here" ─────────
  // `committed` already holds the anchors `buildWorkItemLevel` minted, and each
  // carries its blocker's own work-item id — the trap MOTIR-4952's builder
  // comment names from the other side. Answering from node ids alone drew a
  // `pending` arrow from a ghost anchor into a proposal, as if the blocker sat
  // beside it. An anchor is exactly the blocker end of a committed `cross` dep,
  // so those ids are subtracted; every proposal at this level is added, because
  // each one gets a node below.
  const anchorIds = new Set<string>();
  for (const dep of committed.deps) {
    if (dep.variant === 'cross') anchorIds.add(dep.from);
  }
  // …and every node the builder minted AS an anchor, which catches the NEUTRAL
  // anchor of an exempt edge (MOTIR-6359) — its arrow is firm / pending, so the
  // `cross` test above cannot see it.
  for (const node of committed.nodes) if (node.anchor) anchorIds.add(node.id);
  // The builder's anchors, before `drawOffLevel` adds the ones minted here —
  // the set the stranded-anchor sweep at the bottom is allowed to remove from.
  const committedAnchorIds = new Set(anchorIds);
  const onLevel = new Set<string>([
    ...committed.nodes.map((n) => n.id).filter((id) => !anchorIds.has(id)),
    ...atLevel.map((i) => i.nodeId),
  ]);

  // ⚠️ AN EDGE THE PLAN DELETES IS DROPPED, NOT DRAWN (bug MOTIR-4092, whose
  // first fix drew it, reversed by bug MOTIR-4098).
  //
  // `blockedByRemovedNodeIds` is the removal carrier the review model resolves
  // separately — separately, because an edge the plan deletes is not a blocker
  // the proposal declares and must never be drawn as one. Here is where the two
  // meet: a committed dep whose (from, to) pair a proposal at this level names
  // for removal does not reach the canvas at all.
  //
  // DROPPED, NOT RE-SKINNED — MOTIR-4098 REVERSES the first fix, which kept the
  // edge and marked it as going away. Whatever it is skinned like, a
  // drawn edge is still an ARROW between two cards, and the canvas is read for
  // its SHAPE: what blocks what, in what order. A shape carrying lines the reader
  // has to decode as *ignore me* is the confusing picture the marking was meant
  // to fix. The removal is not silenced by dropping it — `buildChanges`' `links`
  // row still reports `+N / −N blockers` in words, which is where a diff belongs.
  // The graph draws what approving would LEAVE BEHIND.
  const removedPairs = new Set<string>();
  for (const item of atLevel) {
    for (const blockerId of item.blockedByRemovedNodeIds) {
      removedPairs.add(`${blockerId} ${item.nodeId}`);
    }
  }
  const deps: ProjectCanvasDep[] = committed.deps.filter(
    (dep) => !removedPairs.has(`${dep.from} ${dep.to}`),
  );
  const seen = new Set(deps.map((d) => `${d.from} ${d.to}`));

  // Who already wears the chip: every dependent of a committed `cross` edge the
  // plan keeps. Read AFTER the removal filter, so a plan deleting that edge takes
  // the chip with it — and read at all because a `modify` RE-SKINS its committed
  // node below, replacing the `WorkItemNode` whose content the chip was baked
  // into. Without this the card a plan amends lost its flag for exactly as long
  // as the plan was pending.
  const crossBlocked = new Set(deps.filter((d) => d.variant === 'cross').map((d) => d.to));
  const anchors: ProjectCanvasNode[] = [];

  /**
   * A blocker of `item` that is NOT on this level — the roadmap's off-level
   * branch, stated against a proposal. `variant` is the arrow the edge takes if
   * the blocker turns out to be a MEMBER of the level the read did not carry.
   */
  const drawOffLevel = (
    item: PlanReviewItemDto,
    blockerId: string,
    variant: ProjectCanvasDep['variant'],
  ) => {
    // NO STUB ⇒ NOTHING TO NAME. The review model names every blocker it can
    // reach, so a missing one is archived, deleted or outside the workspace. An
    // anchor reading `—` would be a claim about a card this surface cannot show.
    const stub = item.blockerStubs.find((s) => s.nodeId === blockerId);
    if (!stub) return;
    const key = `${blockerId} ${item.nodeId}`;
    // A MEMBER THE CAPPED READ DROPPED IS NOT OFF THE LEVEL — bug MOTIR-5043's
    // exclusion, with its disposition: the arrow is pushed with no node behind
    // it, `computeLevel` drops it, and the level's truncation tile is what says
    // rows are missing. NOT AT THE ROOT, where a parentless blocker is far more
    // often a row the roadmap GROUPED off the road — and `buildWorkItemLevel`
    // sends a grouped row down the off-level path.
    if (parentId !== null && stub.parentNodeId === parentId) {
      if (seen.has(key)) return;
      seen.add(key);
      deps.push({ from: blockerId, to: item.nodeId, variant });
      return;
    }
    // THE EDGE'S DISPOSITION OVER THE PROJECTED TREE (MOTIR-6362) — the roadmap
    // rule (MOTIR-6359) asked of the level approve leaves behind. COVERED: the
    // plan's parents carry the edge, so their arrow one level up draws it and this
    // level draws nothing. EXEMPT: valid, with no parent to carry it, so an
    // ordinary arrow from a NEUTRAL anchor and no chip. Anything else — invalid, or
    // no disposition from an older server or a decided plan — keeps the flag.
    if (stub.coverage === 'covered') return;
    const neutral = stub.coverage === 'exempt';
    if (!neutral) crossBlocked.add(item.nodeId);
    if (!seen.has(key)) {
      seen.add(key);
      deps.push({ from: blockerId, to: item.nodeId, variant: neutral ? variant : 'cross' });
    }
    // ONE anchor per blocker on the level, whoever else it blocks — including a
    // committed sibling whose anchor the builder already minted.
    if (anchorIds.has(blockerId)) return;
    anchorIds.add(blockerId);
    anchors.push(
      ghostAnchorNode(
        blockerId,
        {
          searchText: `${stub.identifier ?? ''} ${stub.title}`.trim(),
          crumbLabel: stub.identifier ?? stub.title,
        },
        stub.identifier !== null ? (
          <GhostAnchor
            identifier={stub.identifier}
            title={stub.title}
            tone={neutral ? 'neutral' : 'danger'}
          />
        ) : (
          <ProposedBlockerAnchor title={stub.title} />
        ),
      ),
    );
  };

  // ⚠️ A CARD THE PLAN RE-PARENTS ONTO THIS LEVEL BRINGS ITS OWN COMMITTED EDGES
  // (bug MOTIR-4951) — and `committed` cannot supply them, because `committed` is
  // the level's CURRENT children and the moving card is precisely the one that is
  // not among them yet. It is the same COMMITTED-only trap the `drillable`
  // comment above names for a different field, from the same cause, in
  // this function: the level's committed read is the wrong basis for ANYTHING
  // about a card the plan is moving.
  //
  // So the endpoint half of the card arrives on the proposal, as
  // `committedBlockedBy`. It is not a proposed edge and must not be drawn like
  // one: approving creates nothing here, so each is drawn by the committed rule
  // `buildWorkItemLevel` uses — `firm` once the blocker is `done`, `pending`
  // while it is not — which is exactly how the same edge will be drawn on the
  // level the reviewer gets after approve.
  //
  // BEFORE the proposed loop, so a plan that ALSO proposes an existing edge does
  // not re-draw it `pending` (`seen` is what holds that), and AFTER the removal
  // filter, so `removedPairs` still subtracts one of these: widening the
  // committed set must not resurrect an edge the plan deletes (bugs MOTIR-4092 /
  // MOTIR-4098). A blocker that stays elsewhere takes the off-level path above,
  // as a proposed edge's does (bug MOTIR-5387) — it used to be dropped.
  for (const item of atLevel) {
    for (const blocker of item.committedBlockedBy) {
      if (blocker.nodeId === item.nodeId) continue;
      const key = `${blocker.nodeId} ${item.nodeId}`;
      if (removedPairs.has(key)) continue;
      const variant = blocker.isDone ? 'firm' : 'pending';
      if (!onLevel.has(blocker.nodeId)) {
        drawOffLevel(item, blocker.nodeId, variant);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({ from: blocker.nodeId, to: item.nodeId, variant });
    }
  }

  // A proposal's OWN edges — `pending`, because approving is what creates them.
  for (const item of atLevel) {
    for (const blockerId of item.blockedByNodeIds) {
      if (blockerId === item.nodeId) continue;
      if (!onLevel.has(blockerId)) {
        drawOffLevel(item, blockerId, 'pending');
        continue;
      }
      const key = `${blockerId} ${item.nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({ from: blockerId, to: item.nodeId, variant: 'pending' });
    }
  }

  // ⚠️ AN ANCHOR WHOSE EVERY EDGE THE PLAN DELETES IS DROPPED WITH THEM (bug
  // MOTIR-5389) — the node half of the removal filter above, which reached
  // `deps` and never `nodes`. A ghost anchor exists only to be the far end of a
  // `cross` arrow; with none left it draws the legend's bad-plan warning about an
  // edge that is going away, pointing at nothing, on the plan that repairs it.
  // After approve the roadmap read carries neither the edge nor the stub, so the
  // level approve leaves behind has no anchor. Read against the FINAL `deps`, so
  // an anchor another committed child still hangs off — or that a proposal's own
  // off-level edge reused above instead of minting a second — stays, once. Only
  // the builder's anchors are candidates: a committed CHILD is on the level
  // because it is a child, never because an edge points at it.
  const referenced = new Set(deps.map((d) => d.from));
  const stranded = (id: string) => committedAnchorIds.has(id) && !referenced.has(id);

  // The committed children, in the order the read gave them, with a `modify` /
  // `remove` re-skinned in place.
  const nodes: ProjectCanvasNode[] = committed.nodes
    .filter((n) => !stranded(n.id))
    .map((node) => {
      const drillable = node.drillable || gainsChildren.has(node.id);
      const proposal = pending.get(node.id);
      if (!proposal) return drillable === node.drillable ? node : { ...node, drillable };
      pending.delete(node.id);
      return {
        ...node,
        drillable,
        // The re-skinned card's tab is the proposal's: its outcome, else the
        // blocked tab (MOTIR-12158) — the committed card's own flag is replaced.
        topTab: outcome != null || crossBlocked.has(node.id),
        content: (
          <PlanItemNode
            item={proposal}
            outcome={outcome}
            crossBlocked={crossBlocked.has(node.id)}
          />
        ),
      };
    });

  // Whatever is left is proposed and has no committed node yet: every `add`, plus
  // a `modify` / `remove` whose target is not at this level (a drifted plan).
  //
  // ⚠️ `viewable` is what SURFACES the View button — `ProjectRoadmapCanvas`
  // renders the pill only for a node carrying the flag. MOTIR-3084 built the
  // proposal peek (`ProposalQuickView`) and wired `onView` for every op, but the
  // node it opens from was pushed without the flag, so the door existed and
  // nothing opened it: selecting a proposed card offered no affordance at all.
  // A committed node gets the same flag from `buildWorkItemLevel`; this is the
  // proposed half of the same contract, and it holds for every op — an `add`
  // peeks its proposal, a `modify` / `remove` peeks the live target it names.
  for (const item of atLevel) {
    if (!pending.has(item.nodeId)) continue;
    nodes.push({
      id: item.nodeId,
      parentId: proposalLevelKey(item),
      searchText: `${item.identifier ?? ''} ${item.title}`.trim(),
      crumbLabel: item.identifier ?? item.title,
      drillable: item.hasChildren,
      viewable: true,
      // The outcome tab or the blocked tab (MOTIR-12158) rides the card's top edge.
      ...(outcome != null || crossBlocked.has(item.nodeId) ? { topTab: true } : {}),
      content: (
        <PlanItemNode item={item} outcome={outcome} crossBlocked={crossBlocked.has(item.nodeId)} />
      ),
    });
  }

  return { nodes: [...nodes, ...anchors], deps };
}

/**
 * The committed level with each re-judged edge's `coverage` replaced by the
 * PROJECTED one (MOTIR-6362) — so the level is built as it will read after
 * approve. An edge the plan does not re-judge keeps the roadmap read's verdict.
 */
export function withProjectedCoverage(
  wi: RoadmapLevelData,
  override: ReadonlyMap<string, EdgeDisposition>,
): RoadmapLevelData {
  if (override.size === 0) return wi;
  return {
    ...wi,
    edges: wi.edges.map((e) => {
      const coverage = override.get(`${e.blockedId} ${e.blockerId}`);
      return coverage === undefined ? e : { ...e, coverage };
    }),
  };
}
