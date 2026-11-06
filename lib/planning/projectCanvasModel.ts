// The PROJECT-ROADMAP canvas model (Subtask 7.20.2 / MOTIR-1194) — the pure data
// layer behind the reusable `ProjectRoadmapCanvas`. The canvas represents the
// WHOLE project as ONE roadmap: the pre-plan tier docs (discovery / vision /
// feasibility / validation), design, and plan AND the produced epic → story →
// subtask work-item tree are all nodes on the same surface. This module is
// CONTENT-AGNOSTIC — a node carries its pre-rendered `content` (a StationCard, a
// WorkItemNode, an IdeaCard) plus its STRUCTURE (parent, search text). The canvas
// turns that forest + the dependency edges into one navigable LEVEL at a time
// (the drill-down model), classifies each edge (within-parent vs the cross-parent
// bad-plan SIGNAL), and lays the level out deterministically.
//
// Kept free of DOM (only the React `ReactNode` content TYPE is referenced, never
// touched) so it is exhaustively unit-testable; `ProjectRoadmapCanvas` composes it
// over the shipped `PlanningCanvas` engine. The canvas owns no fetching — the
// forest + edges arrive as DATA (onboarding state / the roadmap read).

import type { ReactNode } from 'react';

/** One node on the project roadmap — a tier/design/plan station OR a work item. */
export interface ProjectCanvasNode {
  id: string;
  /** The PARENT node's id, or null for a roadmap root. Drives drill-down + the
   *  within-parent vs cross-parent edge classification. */
  parentId: string | null;
  /** Pre-rendered node content (StationCard / WorkItemNode / IdeaCard) — the canvas
   *  owns the box, position + drag; the consumer owns the look. */
  content: ReactNode;
  /** Matched by search-to-locate-and-focus (e.g. `MOTIR-12 Build the engine`). */
  searchText: string;
  /** Shown as this node's breadcrumb crumb when it is the drill focus (defaults to
   *  `searchText`). */
  crumbLabel?: string;
  /** The work item's `<PREFIX>-<n>` KEY, carried onto the crumb a drill pushes
   *  (MOTIR-3835). See {@link CanvasCrumb.crumbKey} for why the label cannot stand
   *  in for it. Optional: a node without it produces a crumb without it. */
  crumbKey?: string;
  /** Has children → activating it DRILLS into the next level (the canvas fetches
   *  it). A non-drillable node is a leaf → `onSelect`. */
  drillable?: boolean;
  /** The consumer offers a quick-view DETAIL surface for this node → the canvas
   *  renders a **View** button on the selected card (beside the "Open" drill pill;
   *  MOTIR-1352). Off-level ghost-anchor stubs (and, for onboarding, not-yet-produced
   *  tier stations) set this `false`/omit it, so they get no View action. The canvas
   *  only surfaces View when both this is true AND an `onView` handler is wired. */
  viewable?: boolean;
  /** This node is the in-progress "you are here" FRONTIER (MOTIR-1013) — the LOCATE
   *  control's first-priority target (MOTIR-1421). Set by the work-item consumer; the
   *  content-agnostic canvas only reads it to centre on the current position. */
  here?: boolean;
  /** This node is READY to start (MOTIR-1417) — the LOCATE control's fallback target
   *  when there is no frontier; multiple ready nodes are cycled. */
  ready?: boolean;
  /** This node is DECORATION, not a member of the level's work (MOTIR-1824) — a
   *  pinned annotation the consumer draws ALONGSIDE the level (today: the
   *  planning-origin cluster, which says where the tree came from). It renders,
   *  selects, drags and searches like any other node; the ONE thing it is excluded
   *  from is the question "does this level offer the user a CHOICE?", which
   *  `autoDescendSingleParent` asks. A ghost anchor for an off-level blocker is NOT
   *  decorative — it names a real, peekable work item and is a reason to stop. */
  decorative?: boolean;
  /** A GHOST ANCHOR standing in for an off-level blocker (`ghostAnchorNode`) — never
   *  a member of the level, whichever arrow joins it. Read by the plan-review merge,
   *  which must not mistake the builder's anchors for the level's own cards: a
   *  NEUTRAL anchor (MOTIR-6359) carries a firm/pending arrow, not a `cross` one. */
  anchor?: boolean;
  /** A signature of the node's CONTENT, read only by a canvas with `motion` on: a
   *  change while the id stays plays the DEEPEN cue (MOTIR-6297, Part XXIII §23.4).
   *  The consumer that opts into motion supplies it (MOTIR-6300). */
  changeKey?: string;
  /** Explicit world position (fixed stations own theirs); else the deterministic
   *  auto-layout places the node. */
  x?: number;
  y?: number;
  /** Size HINT (world px) for nodes that are NOT the standard card size — used by
   *  the once-only fit-to-view before the DOM is measured, so an oversized node (the
   *  wide "Your plan" preview) is fully framed rather than clipped. Defaults to the
   *  standard NODE_W/NODE_H. */
  width?: number;
  height?: number;
}

/** A dependency edge. Direction is the consumer's (onboarding: journey order;
 *  work items: blocker → blocked). The canvas draws `from → to` and OVERRIDES the
 *  variant to `cross` when the two ends sit under different parents. */
export interface ProjectCanvasDep {
  from: string;
  to: string;
  /** `firm` = a settled dependency (solid); `pending` = not-yet-done (dashed);
   *  `cross` = a story/parent-boundary crossing (the bad-plan flag);
   *  `running` = the edge a RUN is travelling along, from a work item an agent is
   *  working to one it BLOCKS (MOTIR-3972 built it, MOTIR-3895 chooses it). It
   *  flows, because on a run the edge is what says *what becomes reachable when
   *  this lands*. ⚠️ `cross` still WINS over it below: an edge that leaves the
   *  level is a plan problem, and hiding that under an animation would trade a
   *  diagnosis for a decoration. */
  variant?: 'firm' | 'pending' | 'cross' | 'running';
  /** `dependency` (default) = a real blocked-by edge → counts toward the
   *  dependency LEGEND. `flow` = a sequence/journey edge (the onboarding station
   *  serpentine) that is drawn but is NOT a blocked-by relationship, so it must
   *  NOT surface the "Dependencies" legend. */
  kind?: 'dependency' | 'flow';
}

export type CanvasEdgeVariant = 'firm' | 'pending' | 'cross' | 'running';

export interface CanvasLevelNode {
  node: ProjectCanvasNode;
  /** Has children → clicking it DRILLS in. */
  drillable: boolean;
}

export interface CanvasLevelEdge {
  from: string;
  to: string;
  variant: CanvasEdgeVariant;
}

export interface CanvasLevel {
  nodes: CanvasLevelNode[];
  edges: CanvasLevelEdge[];
}

export interface CanvasCrumb {
  id: string;
  label: string;
  /** The work item's `<PREFIX>-<n>` KEY (MOTIR-3835), when the producer knows it.
   *  `label` is a DISPLAY string (`identifier · title`), so a consumer that wants to
   *  write a human-readable, shareable address cannot recover the identifier from it
   *  without splitting on a separator the label is free to change. Optional, so the
   *  consumers that do not set it are untouched and the field is simply absent on
   *  their crumbs. */
  crumbKey?: string;
}

// A FOLDER's node id on the canvas (Bug MOTIR-5710 · MOTIR-5741). A folder is a
// DOOR like the grouped node — the consumer's `loadLevel` intercepts the prefix
// and reads that folder's level — so both halves of the drill must spell the id
// the same way, which is why it is minted and parsed here and nowhere else — a
// pure module, because the server page resolving a `?folder=` arrival mints one
// too. A
// work-item id is a cuid and never carries a colon, so the namespace cannot
// collide with one.
export const FOLDER_NODE_PREFIX = 'folder:';

/** The canvas node id of a folder. */
export function folderNodeId(folderId: string): string {
  return `${FOLDER_NODE_PREFIX}${folderId}`;
}

/** The folder id behind a canvas node id, or `null` when the node is not a folder. */
export function folderIdFromNodeId(nodeId: string | null): string | null {
  return nodeId !== null && nodeId.startsWith(FOLDER_NODE_PREFIX)
    ? nodeId.slice(FOLDER_NODE_PREFIX.length)
    : null;
}

/**
 * A work item's BREADCRUMB label — `identifier · title` (MOTIR-1805 design
 * DECISION 2). Lives here, in the pure model, because two independent producers
 * write it and they must not drift: `buildWorkItemLevel` stamps it on every node
 * the canvas may drill INTO, and the planning host stamps it on the ancestor
 * trail it SEEDS the canvas with (MOTIR-2070). A seeded crumb has to read
 * identically to a hand-drilled one, or the breadcrumb tells the user they got
 * somewhere two different ways.
 */
export function workItemCrumbLabel(identifier: string, title: string): string {
  return `${identifier} · ${title}`;
}

// ── layout constants (exported so the canvas can hint node sizes for edge
//    anchoring + measure the deterministic grid). A node card is ~280×124 — a
//    COMPACT card (tight padding, a small top-left status chip, a two-line title)
//    with no wasted vertical space (MOTIR-1194 review). ──
export const NODE_W = 280;
export const NODE_H = 124;
const GAP_X = 80;
const GAP_Y = 72;
// How many cards a row of the LOOSE band holds (MOTIR-10537: 5, was 3). The
// plan-review canvas's arrival predicate is derived from this width —
// `ARRIVAL_LEVEL_MAX_NODES` in `planView.ts` — so a change here re-derives it.
export const LOOSE_BAND_COLS = 5;
const ORIGIN = 40;
// Clear vertical separation between the dependency FLOW and the loose-item band.
const BAND_GAP = 96;

function indexNodes(nodes: ProjectCanvasNode[]): Map<string, ProjectCanvasNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** True when `node` is a roadmap ROOT — no parent, or a parent outside this set
 *  (so a partial subtree renders with its top nodes as roots). */
function isRoot(node: ProjectCanvasNode, byId: Map<string, ProjectCanvasNode>): boolean {
  return node.parentId === null || !byId.has(node.parentId);
}

/** The nodes visible at `focusId` (null → roadmap roots; else focus's children). */
export function childrenOf(
  nodes: ProjectCanvasNode[],
  focusId: string | null,
  byId: Map<string, ProjectCanvasNode> = indexNodes(nodes),
): ProjectCanvasNode[] {
  if (focusId === null) return nodes.filter((n) => isRoot(n, byId));
  return nodes.filter((n) => n.parentId === focusId);
}

export function hasChildren(nodes: ProjectCanvasNode[], id: string): boolean {
  return nodes.some((n) => n.parentId === id);
}

/**
 * THE FOCAL CARD of a level (MOTIR-3837) — the node an ARRIVAL centres on when the
 * level cannot be drawn legibly whole.
 *
 * The ladder is the LOCATE control's own (`ProjectRoadmapCanvas`'s
 * `locateActionable`): the in-progress **`here`** frontier first — a single
 * destination — else the first **`ready`** node, else the level's first node in
 * layout order. Sharing one ladder is the point: where the canvas OPENS and where
 * Locate TAKES you must not be able to drift apart.
 *
 * A `decorative` node is never the focal card, for the same reason it is not a
 * level's WORK (MOTIR-1824): the pinned planning-origin cluster is provenance drawn
 * beside the road, not a place to be taken to. A level of nothing but decoration
 * has no focal card, and an arrival then centres the level's bounds.
 */
export function focalNode(nodes: readonly ProjectCanvasNode[]): string | null {
  const work = nodes.filter((n) => n.decorative !== true);
  return work.find((n) => n.here)?.id ?? work.find((n) => n.ready)?.id ?? work[0]?.id ?? null;
}

/** The drill level a target node lives ON — the focus that makes it visible. */
export function levelOf(nodes: ProjectCanvasNode[], id: string): string | null {
  const byId = indexNodes(nodes);
  const n = byId.get(id);
  if (!n || isRoot(n, byId)) return null;
  return n.parentId;
}

/** The breadcrumb path (root ancestor → focus, inclusive). Empty at the top. */
export function breadcrumb(nodes: ProjectCanvasNode[], focusId: string | null): CanvasCrumb[] {
  if (focusId === null) return [];
  const byId = indexNodes(nodes);
  const path: CanvasCrumb[] = [];
  let cur: ProjectCanvasNode | undefined = byId.get(focusId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    // The KEY rides along when the node carries one (MOTIR-3835), for the same
    // reason `crumbLabel` is produced by a shared helper: this function and
    // `applyDrill` are two producers of the same crumb, and a trail seeded here
    // has to be interchangeable with one a hand-drill pushed.
    path.unshift({
      id: cur.id,
      label: cur.crumbLabel ?? cur.searchText,
      ...(cur.crumbKey === undefined ? {} : { crumbKey: cur.crumbKey }),
    });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/**
 * The visible LEVEL at `focusId`: the focus's children (or the roots) as nodes,
 * plus the edges BETWEEN two visible nodes, each classified:
 *  - **cross** — the two ends sit under DIFFERENT parents (a story/parent-boundary
 *    crossing): the bad-plan signal (a correct plan is a tree).
 *  - else the consumer's **firm** / **pending** variant (default `firm`).
 * An edge with an end outside the level is dropped (drill-down shows one level).
 */
export function computeLevel(
  nodes: ProjectCanvasNode[],
  deps: ProjectCanvasDep[],
  focusId: string | null,
): CanvasLevel {
  const byId = indexNodes(nodes);
  const parents = new Set<string>();
  for (const n of nodes) if (n.parentId !== null) parents.add(n.parentId);

  const visible = childrenOf(nodes, focusId, byId);
  const visIds = new Set(visible.map((n) => n.id));

  const levelNodes: CanvasLevelNode[] = visible.map((node) => ({
    node,
    drillable: parents.has(node.id),
  }));

  const edges: CanvasLevelEdge[] = [];
  for (const d of deps) {
    if (!visIds.has(d.from) || !visIds.has(d.to) || d.from === d.to) continue;
    const a = byId.get(d.from)!;
    const b = byId.get(d.to)!;
    const cross = a.parentId !== b.parentId;
    edges.push({ from: d.from, to: d.to, variant: cross ? 'cross' : (d.variant ?? 'firm') });
  }
  return { nodes: levelNodes, edges };
}

/**
 * A DETERMINISTIC auto-layout for a level's nodes — a LAYERED left→right
 * dependency flow:
 *  - **Connected** nodes (an end of ≥1 edge) are placed in LAYERS by longest-path
 *    depth (a blocker sits one column left of everything it blocks), stacking nodes
 *    that share a layer into rows. So every dependency edge travels left→right and
 *    no edge has to thread between siblings — the chain reads as a flowing road.
 *  - **Loose** nodes (in no edge — e.g. a standalone bug) drop into their OWN grid
 *    band BELOW the flow, so a dependency line never crosses an unrelated card. The
 *    band is {@link LOOSE_BAND_COLS} cards wide and fills row by row in node order.
 * Same input → same positions (no `Math.random`, no `Date.now`); a node's explicit
 * position (fixed stations / a saved drag) overrides this per node.
 */
export function deterministicLayout(
  nodeIds: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): Record<string, { x: number; y: number }> {
  const idSet = new Set(nodeIds);
  const real = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);
  const touched = new Set<string>();
  for (const e of real) {
    touched.add(e.from);
    touched.add(e.to);
  }
  const connected = nodeIds.filter((id) => touched.has(id));
  const loose = nodeIds.filter((id) => !touched.has(id));

  // longest-path layering over the connected subgraph — the one helper the
  // roadmap's "you are here" pick reads too (bug MOTIR-10454).
  const { order, layer } = longestPathLayers(connected, real);
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const L = layer.get(id) ?? 0;
    const col = byLayer.get(L);
    if (col) col.push(id);
    else byLayer.set(L, [id]);
  }

  const pos: Record<string, { x: number; y: number }> = {};
  let maxRows = 0;
  for (const [L, ids] of byLayer) {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, r) => {
      pos[id] = { x: ORIGIN + L * (NODE_W + GAP_X), y: ORIGIN + r * (NODE_H + GAP_Y) };
    });
  }

  // the loose band: a simple grid (rows of LOOSE_BAND_COLS) below the flow.
  const flowBottom = ORIGIN + Math.max(0, maxRows - 1) * (NODE_H + GAP_Y) + NODE_H;
  const bandY = connected.length > 0 ? flowBottom + BAND_GAP : ORIGIN;
  loose.forEach((id, i) => {
    const row = Math.floor(i / LOOSE_BAND_COLS);
    const col = i % LOOSE_BAND_COLS;
    pos[id] = { x: ORIGIN + col * (NODE_W + GAP_X), y: bandY + row * (NODE_H + GAP_Y) };
  });
  return pos;
}

/**
 * LONGEST-PATH DEPTH of each node over the blocker → blocked `edges` — the layer
 * `deterministicLayout` draws a connected node in, so a node sits one column past
 * its DEEPEST predecessor: a card reached both by a direct edge and by a longer
 * chain takes its depth from the chain.
 *
 * Exported so a reader that must agree with the columns asks THIS function rather
 * than re-deriving an order of its own (bug MOTIR-10454: the roadmap's "you are
 * here" tag picked by key order and could land a column right of a blocker that
 * was still in progress).
 *
 * `order` is the stable topological order the depths were computed in. Edges with
 * an end outside `nodeIds`, and self-edges, are ignored. A CYCLE never throws: its
 * members are appended in input order by `topologicalOrder`, and a predecessor
 * not yet reached counts as depth 0. Same input → same output.
 */
export function longestPathLayers(
  nodeIds: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): { order: string[]; layer: Map<string, number> } {
  const idSet = new Set(nodeIds);
  const preds = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    preds.get(e.to)!.push(e.from);
  }
  const order = topologicalOrder(nodeIds, edges);
  const layer = new Map<string, number>();
  for (const id of order) {
    let L = 0;
    for (const p of preds.get(id) ?? []) L = Math.max(L, (layer.get(p) ?? 0) + 1);
    layer.set(id, L);
  }
  return { order, layer };
}

/** Stable Kahn topological order; cycles/leftovers appended in input order. */
export function topologicalOrder(
  nodeIds: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  const idSet = new Set(nodeIds);
  const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) <= 0 && !seen.has(next)) queue.push(next);
    }
  }
  for (const id of nodeIds) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * Ids of nodes matching a free-text `query` (case-insensitive substring on the
 * node's `searchText`), in input order. A blank query matches nothing (search is a
 * locate action, not a filter that empties the canvas).
 */
export function searchMatches(nodes: ProjectCanvasNode[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  return nodes.filter((n) => n.searchText.toLowerCase().includes(q)).map((n) => n.id);
}
