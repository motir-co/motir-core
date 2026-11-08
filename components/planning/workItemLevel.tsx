import type { ReactNode } from 'react';
import {
  PlanningOriginCluster,
  ORIGIN_H,
  ORIGIN_W,
} from '@/components/planning/PlanningOriginCluster';
import {
  GhostAnchor,
  FolderNode,
  LevelGroupNode,
  LevelTruncationTile,
  WorkItemNode,
  type CardNextActionsOption,
  type RunLegBadge,
} from '@/components/planning/WorkItemNode';
import {
  FOLDER_NODE_PREFIX,
  folderIdFromNodeId,
  folderNodeId,
  longestPathLayers,
  workItemCrumbLabel,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';

// Turn one fetched roadmap LEVEL (items + blocked_by edges + off-level blocker
// stubs) into the canvas's nodes + deps (Subtask 7.20.2 / MOTIR-1194 + the 1331
// design). Shared by every work-item consumer (the roadmap view + onboarding):
//  - each item → a `WorkItemNode` (drillable from `hasChildren`);
//  - a within-level blocked_by edge → a firm/pending arrow (blocker done → firm);
//  - a blocker on ANOTHER level → by the edge's DISPOSITION (MOTIR-6359): an
//    INVALID edge (uncovered, or cross-level) is the "blocked elsewhere" signal — a
//    `cross` edge to a GHOST ANCHOR naming the blocker, and the blocked node is
//    flagged (ring + pill); a COVERED edge draws nothing (its parents' arrow says
//    it one level up); an EXEMPT edge is an ordinary arrow from a NEUTRAL anchor.
//
// Subtask 7.20.6 / MOTIR-1013 adds (via `opts`, used by the persistent roadmap —
// NOT onboarding):
//  - `markActive` — the in-progress FRONTIER node (the active epic at the road's
//    start) is marked "you are here";
//  - `includeOrigin` — at the ROOT level, the collapsed planning-origin cluster is
//    pinned LEFT of the epics so the road reads from its completed-planning start.
//  - each container item carries its subtree `progress` meter.

// The id of the synthetic planning-origin node (no real work item backs it).
// EXPORTED (MOTIR-2205) because the node is now a DOOR: `WorkItemRoadmap.loadLevel`
// intercepts this id and serves the synthetic pre-plan station level for it, so both
// halves of the drill must name the same id — never two literals.
export const ORIGIN_ID = '__planning_origin__';

// The id of the synthetic GROUPED node holding a root level's non-epic rows
// (MOTIR-3490). EXPORTED for the same reason `ORIGIN_ID` is: the node is a DOOR,
// and `WorkItemRoadmap.loadLevel` intercepts this id to serve what is behind it —
// so both halves of the drill must name the same id, never two literals.
export const NOT_IN_EPIC_ID = '__not_in_an_epic__';

// A FOLDER's node id helpers live in the pure canvas model (they are read by the
// server page too) and are re-exported here beside the other door ids.
export { FOLDER_NODE_PREFIX, folderIdFromNodeId, folderNodeId };

// The id of the synthetic TRUNCATION tile (MOTIR-3490). Not a door — the consumer
// intercepts it on ACTIVATION, to re-read this level with the raised ceiling.
export const LEVEL_MORE_ID = '__level_more__';

/**
 * Does this row belong in the grouped node rather than on the road?
 *
 * BOTH conjuncts are load-bearing (design decision 6, `design/roadmap/design-notes.md`):
 *
 *  - `kind !== 'epic'` — the road IS the epics, and this is total over the four
 *    kinds a root may take (`prisma/sql/work_item_triggers.sql` refuses only
 *    `subtask` at the root). A `bug`-only test would leave a parentless `story` or
 *    `task` drawing on the road and re-open this defect the first time one is filed.
 *  - `parentId === null` — the one that stops it being destructive in SPRINT scope.
 *    There, `findProjectTreeLevel` re-roots the level at the topmost IN-SPRINT
 *    members, which are usually stories and subtasks: every one of them not an
 *    epic. Without this conjunct the sprint's actual work would collapse into a
 *    single node. A row that is a root of the sprint VIEW still has a parent, so
 *    it stays on the road; only a root of the TREE groups.
 */
export function isNotInEpicRow(item: { parentId: string | null; kind: string }): boolean {
  return item.parentId === null && item.kind !== 'epic';
}

export interface BuildWorkItemLevelOptions {
  /** Mark the in-progress frontier node "you are here" (the roadmap consumer). */
  markActive?: boolean;
  /** The cards' hover next-action button (MOTIR-10509) — the roadmap page's, and a
   *  member's only. Absent / `null` draws none: every other canvas that builds a
   *  level (onboarding, a run's pane, the plan review) keeps its cards as they were. */
  nextActions?: CardNextActionsOption | null;
  /** Pin the planning-origin cluster at the road's start (the ROOT level only). */
  includeOrigin?: boolean;
  /**
   * The roadmap SCOPE (MOTIR-1379). In `'project'` scope every off-level blocker is
   * the CROSS-STORY tangle (a bad plan). In `'sprint'` scope the same edges become a
   * SPRINT-VALIDITY signal: a blocker that is DONE or itself IN the active sprint is
   * satisfied (not drawn), and only an out-of-sprint, NOT-done blocker is flagged —
   * as "not in sprint", never "cross-story" (two items in the same story can still be
   * an out-of-sprint dependency). Defaults to `'project'`.
   *
   * In `'sprint'` scope it ALSO drives the per-NODE "not in sprint" signal: a
   * drilled-in node whose `inActiveSprint` is false (a child of a committed root
   * that the sprint did not itself commit to) is rendered differently, so the
   * committed unit stays visually distinct from the rest of its subtree.
   */
  scope?: 'project' | 'sprint';
  /**
   * The planning-origin node's BREADCRUMB label (MOTIR-2205) — the crumb the canvas
   * shows once the phase card is drilled ("Planning"). Supplied by the consumer
   * because it is localized copy (`roadmap.canvas.origin.crumb`) and this builder is
   * a pure function with no translator of its own.
   */
  originCrumbLabel?: string;
  /**
   * The direction tiers the project's pre-plan journey PRODUCED (MOTIR-2205), or
   * `null` while the consumer's read is still in flight / failed. Drives the phase
   * card's honest badge (`PlanningOriginCluster`); `null` renders it chip-less, so
   * the level can be built — and painted — before the read lands.
   */
  originProduced?: readonly DirectionDocKind[] | null;
  /**
   * Group this level's NON-EPIC ROOT rows into one node (MOTIR-3490). Passed by the
   * roadmap consumer for the ROOT level only — a drilled level's rows are somebody's
   * children and belong exactly where they are. See {@link isNotInEpicRow}.
   */
  groupNonEpicRoots?: boolean;
  /**
   * Rows this level must NOT group even though {@link isNotInEpicRow} holds — the
   * THIRD conjunct of the grouping predicate on the plan-change canvases
   * (`design/ai-planning/design-notes.md` Part XVI, DECISION 2:
   * `parentId === null && kind !== 'epic' && !touchedByThisProposal(id)`).
   *
   * The roadmap justifies its two conjuncts with *"the road IS the epics. This is
   * the level's whole subject."* On a canvas whose subject is a PROPOSED CHANGE
   * the level's subject is the epics AND what the change is about, so this is the
   * same rule applied to a different subject rather than a departure from it —
   * the second such conjunct, after decision 6's sprint scope.
   *
   * It is a SET rather than a predicate for the same reason `groupCrumbLabel` is a
   * string: this builder is a pure function that knows nothing about plans, and
   * WHICH rows are exempt is the consumer's own question. `PlanReviewCanvas`
   * answers it with the node ids its plan names (plus a pending add's target) —
   * membership in the proposal, never a row's own terminal status, which would
   * drag every `done` root back onto the road the moment any plan is pending.
   * Absent / empty ⇒ the two-conjunct roadmap predicate, unchanged.
   */
  groupExcludeIds?: ReadonlySet<string>;
  /** The grouped node's BREADCRUMB label — localized copy the consumer supplies,
   *  for the same reason `originCrumbLabel` is supplied rather than resolved here:
   *  this builder is a pure function with no translator of its own. */
  groupCrumbLabel?: string;
  /**
   * How many rows the level HAS, when the read reported it. Greater than the rows
   * actually returned ⇒ the level was truncated by the read's cap, and the
   * truncation tile is drawn (MOTIR-3490). Absent / equal ⇒ no tile, which is both
   * the ordinary case and the pre-MOTIR-3490 behaviour.
   */
  levelTotal?: number;
  /**
   * How many of a pending plan's proposals will sit beneath each folder, by
   * FOLDER id (Bug MOTIR-5782; design `design/ai-planning/design-notes.md` Part
   * XVIII decision 3) — the planning canvases' closed-folder badge. Absent, and
   * a folder missing from it, draw the shipped card unchanged.
   */
  folderChanges?: ReadonlyMap<string, number>;
  /**
   * Each work item's DISPOSITION in a dispatch run, by work-item id (MOTIR-3895)
   * — the run modal's canvas pane, and nothing else, supplies it.
   *
   * ⚠️ EXTENDING THIS ADAPTER IS THE REUSE. The alternative — casting a
   * `DispatchRunCardDto` into a `ProjectCanvasNode` — is bug MOTIR-3152: the two
   * shapes share no field name, the cast is from `unknown` so nothing type-checks
   * it, and every node arrives with an undefined `content` that `renderNode`
   * paints into a 0x0 box. The card was not blank, it was INVISIBLE, and the
   * tests were green. So a run's extra fact rides HERE, on the builder every
   * canvas consumer already goes through.
   *
   * The badge arrives already resolved to a tone and a localized label: this is a
   * pure function with no translator and no tone map, exactly as
   * `originCrumbLabel` and `groupCrumbLabel` are supplied rather than looked up.
   */
  runLegs?: ReadonlyMap<string, RunLegBadge>;
  /**
   * Blockers that are NOT among this level's committed rows but that a pending
   * proposal is putting ON it (bug MOTIR-4952), keyed by work-item id — the value
   * is whether that blocker is `done`. Supplied by the plan-review consumer;
   * absent / empty everywhere else, which is the pre-MOTIR-4952 behaviour.
   *
   * ⚠️ WITHOUT IT THE OFF-LEVEL TEST IS ASKED OF THE WRONG SET. The loop below
   * decides `on this level?` from the level's COMMITTED rows, which is the right
   * question for the roadmap and the wrong one for a canvas whose whole subject
   * is a plan MOVING a card here: the blocker is off-level at read time and on it
   * the moment the reviewer approves. Answering from the committed rows alone
   * produced all three halves of the cross-story treatment about a card the plan
   * draws right beside its dependent — the red `cross` arrow, the blocked node's
   * `crossBlocked` ring, and a GHOST ANCHOR standing in for a card that is fully
   * specified in the plan. It is the same COMMITTED-only trap `mergePlanLevel`'s
   * MOTIR-4266 and MOTIR-4951 comments name for `drillable` and for `deps`, and
   * the reason it is repaired HERE rather than there is that two of those three
   * are unreachable downstream: the ring is baked into a node's rendered
   * `content` and the anchor has already been minted.
   *
   * A MAP rather than a Set because the variant is status-derived and this
   * builder cannot look a status up — the blocker may be a card the plan is
   * relocating, so it is in the roadmap read for no level. The value must be the
   * SAME predicate the within-level rule uses (`status === 'done'`), not the
   * roadmap stub's `isDone`, which is TERMINAL and counts `cancelled` — using the
   * stub would draw `firm` before approve and `pending` after, which is the
   * disagreement this family of defects is about.
   *
   * It is a MAP rather than a predicate for the same reason `groupExcludeIds` is
   * a set: this builder is a pure function that knows nothing about plans, and
   * WHICH blockers are arriving is the consumer's own question.
   */
  arrivingBlockers?: ReadonlyMap<string, boolean>;
  /**
   * Committed rows of this level that a pending proposal is moving OFF it (bug
   * MOTIR-5006), by work-item id — the exact mirror of `arrivingBlockers`, and
   * supplied by the same consumer for the same reason. Absent / empty everywhere
   * else, which is the pre-MOTIR-5006 behaviour.
   *
   * ⚠️ WITHOUT IT THE LEVEL'S *MEMBERSHIP* IS ASKED OF THE WRONG SET. The read
   * answers `who are this level's children?` from the tree as it stands, which is
   * the right question for the roadmap and the wrong one for a canvas whose whole
   * subject is a plan moving a card OUT: the row is a child at read time and is
   * not one the moment the reviewer approves. Answering from the committed rows
   * alone draws the departing card among its siblings with its ordinary committed
   * arrows, indistinguishable from one nobody proposed to touch — and approving is
   * then the first time the reviewer learns it left.
   *
   * A departing row is treated exactly as a GROUPED one: off `onLevel`, with a
   * naming stub minted from its own row so an edge into it takes the off-level
   * path and names it rather than vanishing. That is what the level LOOKS LIKE
   * after approve — the card gone, and the dependency it leaves behind flying the
   * cross-container flag — which is the rule this whole family is decided by
   * (`mergePlanLevel`'s MOTIR-5006 comment carries the argument).
   *
   * A SET rather than a map, unlike `arrivingBlockers`: the arriving case needs a
   * status because it draws a WITHIN-level arrow whose variant is status-derived,
   * and every edge this one produces is `cross`, which has no variant to choose.
   * The stub's own `isDone` comes off the row, by the same `status === 'done'`
   * predicate the within-level rule uses.
   *
   * It is a SET rather than a predicate for the same reason `groupExcludeIds` is:
   * this builder is a pure function that knows nothing about plans, and WHICH rows
   * are departing is the consumer's own question.
   */
  departingIds?: ReadonlySet<string>;
}

/**
 * The GHOST ANCHOR node standing in for an off-level blocker (MOTIR-1331) — the
 * one node shape every canvas drawing the off-level treatment mints.
 *
 * EXPORTED (bug MOTIR-5387) because the plan-review merge mints anchors too, for
 * a PROPOSAL's own off-level blockers, and a second hand-built copy of this
 * object is how the review canvas and the roadmap came to disagree one field at
 * a time (MOTIR-4951, MOTIR-4952, MOTIR-5006, MOTIR-5272). The CONTENT stays the
 * caller's, because only the caller knows whether the blocker has a key to show.
 *
 * `label` is `null` when nothing names the blocker: the search text degrades to
 * the bare id and there is no crumb — the builder's own anonymous case.
 */
export function ghostAnchorNode(
  id: string,
  label: { searchText: string; crumbLabel: string } | null,
  content: ReactNode,
): ProjectCanvasNode {
  return {
    id,
    parentId: null,
    drillable: false,
    anchor: true,
    searchText: label?.searchText ?? id,
    crumbLabel: label?.crumbLabel,
    // The off-level blocker is a REAL work item with a valid identifier
    // (MOTIR-1586) — make its ghost anchor VIEWABLE so "blocked by something
    // elsewhere" is peekable, exactly like any other work-item node: selecting
    // it shows the View button, and View opens the shared `WorkItemQuickView`
    // (which resolves the anchor id → its identifier via `registerItems`). A
    // bare click only SELECTS — no click-to-open, consistent with every card.
    viewable: true,
    content,
  };
}

/**
 * The "you are here" row of a level (bug MOTIR-10454): among the rows whose
 * status sits in the `in_progress` CATEGORY, the one with the smallest
 * longest-path depth over `deps` — the depth `deterministicLayout` draws its
 * column by — ties broken by `rows`' own order, so cards in different
 * in-progress statuses are ranked together. `longestPathLayers` ignores every
 * dep with an end off `rows`, so an off-level blocker's anchor arrow does not
 * move the tag. No in-progress-category row → `null`.
 *
 * ⚠️ The candidate test reads the status CATEGORY, never a list of status keys
 * (MOTIR-10622). This deliberately reverses MOTIR-10599, which kept a key list
 * (`in_progress` + `planning`) so that `implemented`, `in_review` and `approved`
 * could not take the tag: a level whose only open work was in review then had no
 * "here" at all. Every not-done status in the in-progress category — including a
 * project's custom ones — is where the work is. The todo category (`todo`,
 * `blocked`) and the done category (`done`, `cancelled`) never qualify, and a row
 * whose category is unknown (`null`) is not a candidate.
 */
function pickHereId(
  rows: ReadonlyArray<{ id: string; statusCategory?: string | null }>,
  deps: ReadonlyArray<ProjectCanvasDep>,
): string | null {
  const active = rows.filter((r) => r.statusCategory === 'in_progress');
  if (active.length === 0) return null;
  const { layer } = longestPathLayers(
    rows.map((r) => r.id),
    deps,
  );
  let best = active[0]!;
  for (const r of active) {
    if ((layer.get(r.id) ?? 0) < (layer.get(best.id) ?? 0)) best = r;
  }
  return best.id;
}

export function buildWorkItemLevel(
  wi: RoadmapLevelData,
  opts: BuildWorkItemLevelOptions = {},
): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const scope = opts.scope ?? 'project';
  // THE PARTITION (MOTIR-3490), computed BEFORE anything else reads the level,
  // because everything downstream depends on which rows are actually ON it.
  // ⚠️ GROUPING MUST LEAVE SOMETHING ON THE ROAD. The point of the grouped node is
  // that the opening canvas reads as "the work, and one door beside it" — so a
  // partition that would take the WHOLE level is not tidying it, it is replacing
  // the reader's entire roadmap with a single grey box and putting an extra hop in
  // front of what used to be the first thing they saw.
  //
  // The design (`design/roadmap/design-notes.md`, decision 1) states the predicate
  // over a row and assumes the epics standing beside it; this is that assumption
  // made explicit. Two live cases need it, and the first is why the condition is
  // NOT "the level has an epic":
  //
  //  - SPRINT scope re-roots at the topmost in-sprint members, and an epic is
  //    almost never among them — so an epic-presence test would switch grouping
  //    off for the whole sprint view and make MOTIR-3490's AC 5 unsatisfiable.
  //    What matters there is that a committed MEMBER row remains on the road.
  //  - A project with no epics at all (a fresh tree, the migrate population) would
  //    otherwise collapse to one node. The shipped auto-drill suite already
  //    encoded this expectation — its fixtures are parentless non-epic roots that
  //    must still descend normally (MOTIR-1807).
  //
  // THE THIRD CONJUNCT (`groupExcludeIds`, Part XVI decision 2) narrows the
  // candidate set on the plan review canvas: a row the plan touches stays on the
  // road. It is applied HERE, with the other two, so the "leave something on the
  // road" guard below measures the set that is actually grouped — and so a
  // consumer can never group a proposal's target, which is what re-opens
  // MOTIR-3206 (`mergePlanLevel` lands a materialized add ON the committed node;
  // take that node off the level and the merge cannot land, so the accepted card
  // is appended a second time as a keyless ghost).
  const exclude = opts.groupExcludeIds;
  const candidates =
    opts.groupNonEpicRoots === true
      ? wi.items.filter((i) => isNotInEpicRow(i) && !(exclude?.has(i.id) ?? false))
      : [];
  const grouped = candidates.length < wi.items.length ? candidates : [];
  const groupedIds = new Set(grouped.map((i) => i.id));
  const afterGrouping =
    grouped.length > 0 ? wi.items.filter((i) => !groupedIds.has(i.id)) : wi.items;
  // THE ROWS THE PENDING PLAN MOVES OFF THIS LEVEL (bug MOTIR-5006) — the second
  // thing that takes a row off a level after the read, and it lands in the same
  // partition as the first for the same reason: everything downstream depends on
  // which rows are actually ON the level. Applied AFTER grouping so the two
  // compose rather than race; they never overlap in fact, because the only
  // consumer that supplies this one excludes every row the plan touches from
  // grouping (`groupExcludeIds`).
  const departing = opts.departingIds;
  const departed = departing?.size ? afterGrouping.filter((i) => departing.has(i.id)) : [];
  const departedIds = new Set(departed.map((i) => i.id));
  const onLevel =
    departed.length > 0 ? afterGrouping.filter((i) => !departedIds.has(i.id)) : afterGrouping;

  const itemIds = new Set(onLevel.map((i) => i.id));
  const statusById = new Map(onLevel.map((i) => [i.id, i.status]));
  // A GROUPED row is OFF this level now, so an edge to it takes the off-level path
  // — and we have its whole row in hand, so it gets a proper naming stub instead of
  // an anonymous anchor. Dropping such an edge instead would have been the quiet
  // option and the wrong one: an epic blocked by a grouped defect is still blocked,
  // and the flag is how the reader finds out.
  // A DEPARTING row is off this level for the same reason and gets the same
  // treatment (bug MOTIR-5006) — its whole row is in hand, so an edge into it
  // names it instead of drawing an anonymous anchor. Dropping such an edge
  // would be the quiet option here too, and worse: the dependency the plan is
  // about to stretch across containers is exactly what the reviewer is being
  // asked to approve.
  const offById = new Map(wi.offLevelBlockers.map((b) => [b.id, b]));
  for (const g of [...grouped, ...departed]) {
    if (offById.has(g.id)) continue;
    offById.set(g.id, {
      id: g.id,
      identifier: g.identifier,
      title: g.title,
      parentTitle: null,
      isDone: g.status === 'done',
      inActiveSprint: g.inActiveSprint ?? false,
    });
  }

  // The level's OWN rows that the capped read could not carry (bug MOTIR-5043) —
  // see the branch that consumes it in the edge loop below. Absent on a level the
  // client serves synthetically (the grouped node's, the pre-plan stations') and on
  // an older server's payload, both of which read as "nothing was dropped".
  const levelMemberBlockers = new Map((wi.levelMemberBlockers ?? []).map((b) => [b.id, b.isDone]));

  const crossBlocked = new Set<string>();
  const deps: ProjectCanvasDep[] = [];
  const anchorNodes: ProjectCanvasNode[] = [];
  // Insertion-ordered, so the anchors keep the order their first edge met them.
  const anchorByBlocker = new Map<
    string,
    { stub: (typeof wi.offLevelBlockers)[number] | undefined; neutral: boolean }
  >();

  for (const e of wi.edges) {
    // THIS LEVEL'S EDGES ARE THE ONES WHOSE BLOCKED END IS DRAWN HERE (bug
    // MOTIR-3557). The loop below asks only "is the BLOCKER on this level?",
    // and until the partition above existed that was sufficient BY
    // CONSTRUCTION: `findBlockedByEdges` selects `fromId IN (level rows)`
    // (`lib/repositories/workItemLinkRepository.ts`), so every edge in a level
    // payload already had its blocked end on that level. Grouping was the first
    // thing that ever moved a row off a level after the read — ⚠️ CORRECTED
    // (MOTIR-5043): the CAP did it first, on every level over 200 rows, since
    // before grouping existed; it was simply never noticed, because a dropped row
    // takes its own node away with it and only reappears when something else
    // POINTS at it. Read the sentence as being about the row that is still drawn.
    // Grouping broke the guarantee in both directions at once:
    //
    //  - at the ROOT, an edge into a row that was just grouped now points at a
    //    node nobody draws — and its blocker still minted a ghost anchor, so a
    //    grouped card reappeared outside the group as a red "blocked elsewhere"
    //    warning with no arrow attached to it;
    //  - on the GROUPED level, whose consumer hands over the root's whole edge
    //    list, EVERY root epic became an off-level blocker — 12 of them on
    //    Motir's own tree — and none is in `offLevelBlockers` (an epic is ON the
    //    root level), so each drew as an ANONYMOUS anchor: `—` over the
    //    "Blocked across stories" fallback, chained to the other epics by the
    //    epic roadmap's own dependency graph.
    //
    // Restoring the missing half of the test HERE, rather than at either call
    // site, is what makes the property the code's own again: the next feature
    // that re-partitions a level — a filter, a collapse, a kind lens — inherits
    // it instead of re-opening this defect in a third place.
    if (!itemIds.has(e.blockedId)) continue;
    if (itemIds.has(e.blockerId)) {
      // within-level: a normal arrow (firm once the blocker is done).
      deps.push({
        from: e.blockerId,
        to: e.blockedId,
        variant: statusById.get(e.blockerId) === 'done' ? 'firm' : 'pending',
      });
      continue;
    }
    // A BLOCKER THE PENDING PLAN IS MOVING ONTO THIS LEVEL IS NOT OFF IT (bug
    // MOTIR-4952). Checked BEFORE the stub lookup, so none of the three
    // off-level effects fires: no `cross` arrow, no `crossBlocked` ring on the
    // dependent, and no ghost anchor — the plan's own node is pushed by
    // `mergePlanLevel`, carrying the proposal's parent, drillability and search
    // text rather than an anchor's stand-ins. Before the SPRINT arm too: a card
    // arriving on the level is on it in either scope.
    const arrivingIsDone = opts.arrivingBlockers?.get(e.blockerId);
    if (arrivingIsDone !== undefined) {
      deps.push({
        from: e.blockerId,
        to: e.blockedId,
        variant: arrivingIsDone ? 'firm' : 'pending',
      });
      continue;
    }
    // A BLOCKER THE LEVEL READ'S CAP DROPPED IS NOT OFF THE LEVEL EITHER (bug
    // MOTIR-5043) — the fourth exclusion in this family, and the one nobody came
    // back for. `itemIds` is what the READ returned, and the read stops at
    // `TREE_LEVEL_MAX_TAKE` rows sorted key-ASCENDING, so on a level with more
    // children than that a plain SIBLING of `e.blockedId` arrives here. Firing the
    // off-level treatment about it puts the canvas's loudest verdict — the legend
    // reads *"the blocker sits elsewhere in the plan (a bad plan)"* — on a tree that
    // is correct, and invites the reader to go and move a card that is already where
    // it belongs.
    //
    // ⚠️ THE SERVICE ANSWERS THIS, NOT THE BUILDER, and that is the repair rather
    // than an implementation detail: membership is a property of the LEVEL, and the
    // only reader that can compare a blocker's parent against the level's own is the
    // one that issued the read. `wi.levelMemberBlockers` therefore rides on the level
    // DTO like `levelTotal` does — every consumer of this builder inherits the answer,
    // and the next thing that narrows a level inherits it too.
    //
    // NOTHING IS DRAWN FOR IT, deliberately. The dep is pushed so the within-level
    // rule stays stated in one place, and `computeLevel` then drops it because no
    // node carries that id — which is the correct picture: the row is not on screen,
    // so neither is its arrow, and the level's own "+ N more" truncation tile is what
    // tells the reader rows are missing. Minting an anchor instead would be the
    // opposite trade — a drawn card standing in for a member, wearing the flag that
    // means the plan is wrong.
    //
    // BEFORE the sprint arm, like the two checks above it: a member of the level is
    // on it in either scope. The service leaves this list EMPTY in sprint scope
    // (where the level is re-rooted and a parent comparison says nothing), so that
    // arm's behaviour is unchanged in fact as well as in principle.
    const memberIsDone = levelMemberBlockers.get(e.blockerId);
    if (memberIsDone !== undefined) {
      deps.push({
        from: e.blockerId,
        to: e.blockedId,
        variant: memberIsDone ? 'firm' : 'pending',
      });
      continue;
    }
    const stub = offById.get(e.blockerId);
    // SPRINT scope: the off-level signal is sprint VALIDITY, not "cross-story". A
    // blocker that is DONE or itself IN the active sprint is satisfied → no signal
    // (the dependency is not drawn). Only an out-of-sprint, NOT-done blocker is the
    // problem. PROJECT scope: every off-level blocker is the cross-story tangle.
    if (scope === 'sprint' && (!stub || stub.isDone || stub.inActiveSprint)) {
      continue;
    }
    // PROJECT scope: the edge's DISPOSITION decides (MOTIR-6359; design
    // `design/roadmap/design-notes.md` § "Covered cross-parent edges"), and the
    // service computed it with the validators' own predicates — so "blocked
    // elsewhere" appears exactly where `validate_work_item` calls the edge invalid.
    //  - COVERED: the parents carry the edge, and their arrow one level up draws
    //    it. Nothing here — no arrow, no ring, no anchor (sheet 2).
    //  - EXEMPT: valid, but an end has no parent to carry it, so no level above
    //    draws it. The ordinary firm/pending arrow from a NEUTRAL anchor, and no
    //    flag (sheet 7).
    //  - CROSS-LEVEL onto a DONE blocker (bug MOTIR-10627): SATISFIED, so drawn
    //    like an exempt edge — a firm arrow from a NEUTRAL anchor, no flag. Below.
    //  - UNCOVERED / CROSS-LEVEL, or no disposition at all (a sprint read, an older
    //    server): the shipped bad-plan treatment below.
    // After the sprint arm, which asks a different question and is unchanged.
    if (scope !== 'sprint' && e.coverage === 'covered') continue;
    // A CROSS-LEVEL EDGE WHOSE BLOCKER IS DONE HOLDS NOTHING (bug MOTIR-10627).
    // The flag's visible word is **blocked** — a READINESS word — and readiness
    // calls the card ready the moment its blocker is done (`openBlockers: []`), so
    // flagging it put the canvas's loudest verdict on a card that can be claimed.
    // `validate_work_item` leaves the same edge out of `crossLevelEdges`, so the
    // two still answer as one verdict. The arrow is KEPT, firm from a neutral
    // anchor, rather than dropped as the sprint arm drops a satisfied blocker: the
    // edge is still a fact about the work, and the roadmap is where a reader looks
    // for it. `stub.isDone` is TERMINAL (it counts `cancelled`), which is the same
    // predicate readiness and the validator judge a blocker by. A blocker the read
    // could not name (`!stub`) cannot be shown to be done, so it keeps the flag.
    const satisfiedCrossLevel =
      scope !== 'sprint' && e.coverage === 'cross_level' && stub?.isDone === true;
    const neutral = scope !== 'sprint' && (e.coverage === 'exempt' || satisfiedCrossLevel);
    if (neutral) {
      deps.push({
        from: e.blockerId,
        to: e.blockedId,
        variant: stub?.isDone ? 'firm' : 'pending',
      });
    } else {
      // a red edge to a ghost anchor naming the off-level blocker.
      crossBlocked.add(e.blockedId);
      deps.push({ from: e.blockerId, to: e.blockedId, variant: 'cross' });
    }
    // ONE anchor per blocker, and it is DANGER if any edge from it is flagged: a
    // blocker that holds one valid and one invalid edge on this level is still the
    // named end of a wrong edge.
    const anchor = anchorByBlocker.get(e.blockerId);
    if (anchor) {
      anchor.neutral = anchor.neutral && neutral;
    } else {
      anchorByBlocker.set(e.blockerId, { stub, neutral });
    }
  }
  for (const [blockerId, { stub, neutral }] of anchorByBlocker) {
    anchorNodes.push(
      ghostAnchorNode(
        blockerId,
        stub
          ? { searchText: `${stub.identifier} ${stub.title}`, crumbLabel: stub.identifier }
          : null,
        <GhostAnchor
          identifier={stub?.identifier ?? '—'}
          title={stub?.title}
          parentTitle={stub?.parentTitle ?? null}
          folderPath={stub?.folderPath ?? null}
          outOfSprint={scope === 'sprint'}
          tone={neutral ? 'neutral' : 'danger'}
        />,
      ),
    );
  }

  // The current-position ("you are here") node = the in-progress-CATEGORY item
  // (any of its statuses, MOTIR-10622) EARLIEST along the level's blocker order
  // (bug MOTIR-10454):
  // the one with the smallest
  // longest-path depth over the level's own edges — the same depth
  // `deterministicLayout` places its column by, read from the one helper, so the
  // tag can never sit a column right of an in-progress card that blocks it. Rows
  // at equal depth (and rows no edge reaches) keep the level's read order, key
  // ascending — at the root that's the active epic. Only edges with BOTH ends on
  // the level count: an off-level blocker is drawn as an anchor, not a card.
  // No row in the in-progress category → no marker.
  const activeId = opts.markActive ? pickHereId(onLevel, deps) : null;

  const kindById = new Map(onLevel.map((item) => [item.id, item.kind]));
  const itemNodes: ProjectCanvasNode[] = onLevel.map((item) => {
    // NOT IN SPRINT (MOTIR-1379 follow-up): only meaningful in sprint scope. The
    // root level shows only in-sprint members, but drilling into a committed root
    // reveals its WHOLE subtree — so a child that the sprint did not commit to
    // reads as a NON-member here. Flag it so the node is shown differently ("not in
    // sprint"), keeping the committed unit visually distinct from the rest of its
    // subtree. Project scope never flags (no sprint resolved → `inActiveSprint`
    // false for all; the flag is gated on scope so it stays inert).
    const notInSprint = scope === 'sprint' && item.inActiveSprint === false;
    return {
      id: item.id,
      parentId: item.parentId,
      searchText: `${item.identifier} ${item.title}`,
      // `identifier · title`, not the bare key (MOTIR-1805 design DECISION 2). On a
      // MANUAL drill the key alone sufficed — the user had just read the card they
      // clicked. On an AUTO-DESCENDED ARRIVAL nobody clicked (MOTIR-1807), and the
      // breadcrumb is the ONLY thing carrying the skipped level, so a bare key would
      // reference it without naming it. Applied to manual and auto crumbs identically,
      // so no special mode is introduced. Shared with the trail the planning host
      // SEEDS the canvas with (MOTIR-2070) via one helper, so the two can't drift.
      crumbLabel: workItemCrumbLabel(item.identifier, item.title),
      // The KEY, beside the display label (MOTIR-3835). `crumbLabel` is
      // `identifier · title` and is free to change; a consumer writing a shareable
      // address needs the identifier itself, and recovering it by splitting a display
      // string is the drift this field exists to avoid.
      crumbKey: item.identifier,
      drillable: item.hasChildren,
      // Every real work item offers the quick-view peek (MOTIR-1352). The ghost
      // anchors below are off-level blocker STUBS — they are ALSO viewable now
      // (MOTIR-1586), since each names a real, peekable work item; see the anchor
      // node above.
      viewable: true,
      // Surface the LOCATE targets (MOTIR-1421) onto the canvas node: the frontier
      // ("you are here") and the ready-to-start flag, so the canvas can centre on the
      // actionable node without knowing about work-item readiness itself.
      here: item.id === activeId,
      ready: item.ready ?? false,
      content: (
        <WorkItemNode
          item={{
            id: item.id,
            identifier: item.identifier,
            title: item.title,
            kind: item.kind,
            status: item.status,
            // The status's own LABEL + CATEGORY (bug MOTIR-3170) — without them
            // the chip can only name a default key out of the i18n catalog, and
            // every other status rendered as "To Do".
            statusLabel: item.statusLabel ?? null,
            statusCategory: item.statusCategory ?? null,
            type: item.type ?? null,
            executor: item.executor ?? null,
            // The To plan state (a childless story) and the `motir fix` action read
            // these two (MOTIR-10509).
            hasChildren: item.hasChildren,
            fixReason: item.fixReason ?? null,
          }}
          drillable={item.hasChildren}
          crossBlocked={crossBlocked.has(item.id)}
          crossBlockedSprint={scope === 'sprint'}
          notInSprint={notInSprint}
          progress={item.progress ?? null}
          notPublic={item.childrenHidden ?? false}
          here={item.id === activeId}
          ready={item.ready ?? false}
          runLeg={opts.runLegs?.get(item.id) ?? null}
          nextActions={opts.nextActions ?? null}
        />
      ),
    };
  });

  // The planning-origin cluster (Subtask 7.20.6 / MOTIR-1013) — a FIXED-position
  // node pinned to the LEFT of the auto-laid epics so the road reads from its
  // completed-planning start. It carries an explicit position (so it's excluded
  // from the auto-layout) and NO dependency edge (the work items are the user's
  // own tree, not output the planning stations produced — the same reasoning the
  // onboarding init screen uses for its plan preview), so it never distorts the
  // epics' layout. Only at the ROOT level, and only when there ARE epics to anchor.
  const originNodes: ProjectCanvasNode[] =
    opts.includeOrigin && onLevel.length > 0
      ? [
          {
            id: ORIGIN_ID,
            parentId: null,
            // A DOOR, not a picture (MOTIR-2205): selecting the card surfaces the
            // canvas's shipped "Open ›" pill and drilling it lands on the pre-plan
            // STATION level (`buildPreplanStationLevel`, served by the consumer's
            // `loadLevel`) — the same drill path every epic beside it already uses.
            // It is deliberately NOT `viewable`: the card has no detail peek of its
            // own, because its detail IS the level below it.
            drillable: true,
            crumbLabel: opts.originCrumbLabel,
            // DECORATION, not a member of the level's work (MOTIR-1824). No real
            // work item backs it, and it is the level's provenance rather than
            // one of its branches — so the canvas's "does this level offer a
            // choice?" test (`autoDescendSingleParent`) must not count it. Left
            // uncounted, an ONBOARDED project's root level was never the
            // single-drillable-node shape and the auto-descend never fired for it.
            //
            // ⚠️ This SURVIVES the `drillable: true` above (MOTIR-2205): drillable
            // and decorative are independent axes. Giving the card a drill path must
            // not make it a branch, or an onboarded single-epic project stops
            // auto-descending exactly as it did before MOTIR-1824 was fixed.
            decorative: true,
            searchText: 'Planning origin idea discover shape validate plan',
            content: <PlanningOriginCluster produced={opts.originProduced ?? null} />,
            // Left of the auto-layout origin (x=40, y=40 in `deterministicLayout`),
            // vertically aligned with the first epic row.
            x: -(ORIGIN_W + 80),
            y: 40,
            width: ORIGIN_W,
            height: ORIGIN_H,
          },
        ]
      : [];

  // THE GROUPED NODE (MOTIR-3490) — emitted only when the partition caught
  // something, so the level it opens can never be empty and there is no empty
  // state to draw. It carries NO explicit position: `deterministicLayout` already
  // drops a node that takes part in no dependency edge into its own band BELOW the
  // flow ("Loose nodes ... e.g. a standalone bug"), which is exactly where this
  // belongs — unlike the pinned origin cluster, which overrides its own x/y.
  const groupNodes: ProjectCanvasNode[] =
    grouped.length > 0
      ? [
          {
            id: NOT_IN_EPIC_ID,
            parentId: null,
            // A DOOR: the consumer's `loadLevel` intercepts this id and serves the
            // grouped rows from the level it has ALREADY fetched.
            drillable: true,
            crumbLabel: opts.groupCrumbLabel,
            // NOT `viewable` — like the planning-origin card, its detail IS the
            // level below it; there is no work item to peek at.
            viewable: false,
            // NOT `decorative`, and this is the decision rather than an oversight
            // (design decision 5). `decorative` means "not a member of the level's
            // WORK", which is true of the origin cluster and false of this node: it
            // holds real work items, so it IS a branch, and the canvas's "does this
            // level offer a CHOICE?" test must count it. Marking it decorative would
            // auto-descend the reader PAST it into a lone epic, hiding the
            // unparented work on arrival — the silence this card exists to end.
            searchText: grouped.map((g) => `${g.identifier} ${g.title}`).join(' '),
            content: <LevelGroupNode count={grouped.length} />,
          },
        ]
      : [];

  // THE LEVEL'S FOLDERS (Bug MOTIR-5710 · MOTIR-5741, design decisions 2–5). Each
  // is a DOOR to its own level, drawn with no position of its own: a folder takes
  // part in no edge, so `deterministicLayout` drops it into the loose band below the
  // flow — and because the band is laid out in node ORDER, where they are emitted
  // (below) decides where they sit: after the root's epics, ahead of the grouped
  // node and every other work item, in the position order the read returned. An
  // empty folder is still drawn: it is a real record, and its card says `Empty`.
  const folderNodes: ProjectCanvasNode[] = (wi.folders ?? []).map((f) => ({
    id: folderNodeId(f.id),
    parentId: null,
    // ALWAYS a door — even when empty — because the level behind it is a real
    // place with its own empty state (sheet 6), not a missing one.
    drillable: true,
    // NOT viewable: a folder has no peek; what it holds IS the level behind it.
    viewable: false,
    // NOT decorative (decision 5): a folder holds real work, so it counts toward
    // `autoDescendSingleParent`'s "does this level offer a CHOICE?" — a root with
    // one epic and one folder must not auto-descend into the epic.
    // A folder holding proposed changes is findable as one (decision 3).
    searchText: (opts.folderChanges?.get(f.id) ?? 0) > 0 ? `${f.name} changed` : f.name,
    crumbLabel: f.name,
    content: (
      <FolderNode
        name={f.name}
        childFolderCount={f.childFolderCount}
        itemCount={f.itemCount}
        changes={opts.folderChanges?.get(f.id) ?? 0}
      />
    ),
  }));

  // THE TRUNCATION TILE (MOTIR-3490) — the level read is capped, and this is the
  // only thing that says so. Compared against the rows the READ returned
  // (`wi.items`), never against the rows left after grouping: grouping moves rows,
  // the cap loses them, and reporting the one as the other would be a false claim.
  const total = opts.levelTotal;
  const moreNodes: ProjectCanvasNode[] =
    typeof total === 'number' && total > wi.items.length
      ? [
          {
            id: LEVEL_MORE_ID,
            parentId: null,
            // NOT a door — there is no level behind it, only more of this one.
            drillable: false,
            viewable: false,
            // DECORATIVE: it is an annotation ABOUT the level, not a branch in it,
            // so it must not turn a single-drillable-node level into a "choice" and
            // suppress the auto-descend.
            decorative: true,
            searchText: '',
            content: <LevelTruncationTile shown={wi.items.length} total={total} />,
          },
        ]
      : [];

  // THE ORDER IS THE LOOSE BAND'S ORDER (`deterministicLayout` lays unconnected
  // nodes out in node order). At the ROOT it is the `/items` root order — EPICS,
  // then FOLDERS, then the rest (MOTIR-5550; design decision 2 cites it): an epic
  // with no edge still sits in the band, and a folder drawn ahead of it would push
  // the project's own road aside for a drawer — every project carries a seeded
  // Bugs folder, so that would move every roadmap. INSIDE a folder (no grouping)
  // the folder's child folders lead, then its filed items (design sheet 4).
  const rootOrder = opts.groupNonEpicRoots === true;
  const epicNodes = rootOrder ? itemNodes.filter((n) => kindById.get(n.id) === 'epic') : [];
  const restNodes = rootOrder ? itemNodes.filter((n) => kindById.get(n.id) !== 'epic') : itemNodes;
  return {
    nodes: [
      ...originNodes,
      ...epicNodes,
      ...folderNodes,
      ...restNodes,
      ...groupNodes,
      ...anchorNodes,
      ...moreNodes,
    ],
    deps,
  };
}
