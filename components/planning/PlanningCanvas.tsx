'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { Brain, Flag, ListTree, Maximize2, Minus, PenLine, Plus, SearchCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type Rect,
  type View,
  arrivalView,
  centerOn,
  fitView,
  nodesBounds,
  routeEdges,
  screenDeltaToWorld,
  zoomToward,
} from '@/lib/planning/canvasGeometry';
import {
  DEEPEN_HOLD_MS,
  EXIT_FALLBACK_SLACK_MS,
  REDUCED_HOLD_MS,
  diffSnapshots,
  edgeKey,
  enterDelayMs,
  isQuietDiff,
  planStages,
  readDurations,
  stageMs,
  type MotionDiff,
  type MotionStage,
} from '@/lib/planning/canvasMotion';
import { CHANGED_HIGHLIGHT_MS } from '@/lib/planning/livePane';

// The reusable spatial planning CANVAS (Subtask 7.3.76 / MOTIR-1236) — a Miro-style
// pan / zoom / drag / fit viewport that renders caller-supplied nodes + READ-ONLY
// dependency edges (design `design/ai-chat/canvas-spatial.*`). It is a FOUNDATION:
// the onboarding hub (840), generation review (7.4) and the persistent roadmap
// (7.19) compose it. It owns only the SURFACE + the interaction; the consumer owns
// the node content (`renderNode`), the node positions (CONTROLLED via `onNodeMove`
// — auto-layout + persistence live in the consumer / 7.3.77), and the edge list.
//
// "Render the reality": this component draws exactly the nodes + edges it is given
// (the real work-item graph) — it never invents structure and never lets the user
// create / edit / delete a link. The interaction MATH is in `lib/planning/
// canvasGeometry` (unit-tested); here is the pointer / wheel / keyboard I/O + the
// measured node rects that anchor the edges. Tokens only (`--el-*` + shape).

export interface CanvasNode {
  id: string;
  /** WORLD position (the consumer owns it; auto-layout + persistence are external). */
  x: number;
  y: number;
  /** Optional hint used for edge anchoring until the node is measured. */
  width?: number;
  height?: number;
  /**
   * A caller-supplied signature of the node's CONTENT (MOTIR-6297). Read only with
   * `motion` on: when it changes while the id does not, the node plays the DEEPEN
   * cue (Part XXIII §23.4). Absent is a value like any other.
   */
  changeKey?: string;
  /**
   * The node wears a TAB on its top-left edge (the "You are here" tab, MOTIR-10630).
   * Its top side then fans its edges right of the tab (`routeEdges`' `tabbed`).
   * Absent → the shared band, so every other consumer routes exactly as before.
   */
  topTab?: boolean;
}

export interface CanvasEdge {
  from: string;
  to: string;
  /**
   * `firm` = a hard dependency (solid); `pending` = a not-yet-done edge (dashed);
   * `cross` = a dependency crossing a story/parent boundary — the bad-plan SIGNAL
   * the dependency-arrow audit forbids (warning-toned + a flag badge at the
   * midpoint, so a reviewer SEES the tangle). A correct plan is a TREE; a `cross`
   * edge means the plan is wrong (design `design/roadmap/*`, MOTIR-1009/1194).
   *
   * `running` = the dependency a RUN is currently travelling along: an edge FROM
   * a work item an agent is working TO one it blocks. It flows, because on a run
   * the edge is what says *what becomes reachable when this lands* — the question
   * a static arrow cannot answer (MOTIR-3972; `design/runs/design-notes.md`
   * § THE RUNNING EDGE).
   *
   * ⚠️ NAMED FOR THE STATE, NOT THE EFFECT, so a later surface with the same
   * meaning reuses it instead of adding a second animated variant. And it is
   * OPT-IN like every other capability here (`searchable`, `locatable`,
   * `fullScreenable`): a consumer that never sends it renders exactly as before,
   * which is what keeps the onboarding canvas from growing a flowing edge.
   */
  variant?: 'firm' | 'pending' | 'cross' | 'running';
}

export interface PlanningCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Render a node's CONTENT; the canvas owns its box, position + drag. */
  renderNode: (node: CanvasNode) => ReactNode;
  /** A node was dragged to (x, y) in world coords. Omit → nodes are not draggable. */
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** A node was clicked/tapped (a press that did NOT become a drag). */
  onNodeActivate?: (id: string) => void;
  /**
   * Search-to-focus: the node to PAN to the centre of the viewport. Centring fires
   * whenever `focusNonce` changes (so re-searching the SAME node re-centres it);
   * the scale is left untouched. Omit either and no centring happens.
   */
  focusNodeId?: string;
  focusNonce?: number;
  /**
   * Target ZOOM for the focus pan. When set, centring ALSO resets the scale to this
   * value (a zoom-to-fit-the-card, so a node found while zoomed far out/in lands at a
   * readable default size — the LOCATE control, MOTIR-1421). Omit → the scale is
   * preserved (the search-locate's pan-only behaviour).
   */
  focusScale?: number;
  /** The selected node — its edges (and their other ends) stay lit while every
   *  other connector dims, so the selection's dependencies/blockers stand out. */
  selectedId?: string | null;
  /**
   * A SECOND source for which edges stay lit, read only while nothing is
   * selected: an edge touching any id in the set stays lit and every other edge
   * takes the selection's dim. The consumer's Show-changes mode passes its
   * changed cards here, so the arrows between two faded cards fade with them
   * (MOTIR-5639). It dims only — the accent ink and the wider stroke stay the
   * selection's. Omit (or `null`) → no edge is dimmed without a selection.
   */
  litIds?: ReadonlySet<string> | null;
  /** A press on empty canvas that did not pan — used to clear the selection. */
  onBackgroundClick?: () => void;
  ariaLabel?: string;
  /**
   * The ARRIVAL configuration (MOTIR-3837) — the once-only fit, with a legibility
   * FLOOR and a focal node to centre on when the level cannot be shown whole.
   *
   * ABSENT (the default) is byte-for-byte today's `fitView`, which is what the
   * three canvas consumers that do not ask for this keep. It changes the ARRIVAL
   * only: the explicit fit-to-view control still frames the WHOLE level down to
   * `MIN_SCALE`, and `focalNodeId` naming nothing simply centres the bounds.
   */
  arrival?: { floor: number; focalNodeId?: string | null };
  /**
   * MOTION (MOTIR-6297, `design/ai-planning/design-notes.md` Part XXIII §23.3–§23.5)
   * — opt-in, OFF by default. On, the canvas diffs each new `nodes` / `edges`
   * snapshot against the one it drew and PLAYS the difference, staged: a leaving
   * card fades (and the arrows of every card about to move fade with it), the
   * re-laid cards GLIDE to their new cells, the new cards ENTER, then the arrows
   * draw in on their final routes. A card or arrow that leaves is retained for its
   * fade. A kept node whose `changeKey` changed plays the DEEPEN outline.
   *
   * Every interpolation lives in `app/globals.css` behind
   * `prefers-reduced-motion: no-preference`, beside `.canvas-edge-running`; under
   * `reduce` the new state is drawn at once, and an arrival or a deepen holds the
   * outline instead (§23.5). The first snapshot plays nothing, and neither does a
   * snapshot that changes nothing.
   *
   * ⚠️ OFF, the rendered DOM is exactly what it was before this prop existed —
   * `/roadmap`, runs, onboarding and the plan page redraw on navigation, where
   * motion would animate a level change nobody asked to see. Only the planning
   * surface's live pane opts in (MOTIR-6300).
   */
  motion?: boolean;
  /**
   * With `motion` on: this MOUNT's first snapshot is an ARRIVAL, not a baseline
   * (MOTIR-6300). Read once, at mount. The consumer sets it when the level it is
   * drawing was EMPTY a moment ago on the same level, in front of the reader, so
   * the cards that fill it enter (staggered, then their arrows) rather than
   * appearing settled. Anything else keeps "the first read plays nothing" (§23.4).
   */
  animateInitial?: boolean;
  /**
   * THE DRAFTING / LAYING CUES (Story MOTIR-7820 · MOTIR-7830; design
   * `design/ai-planning/design-notes.md` Part XXVI §26.6–26.8) — a node id → cue map
   * of the items the planner is writing RIGHT NOW. A cued node's BOX (the
   * `data-node-id` element, never the card `renderNode` returns) gains
   * `data-cue`, the class `canvas-node--drafting` / `canvas-node--laying`, a
   * dotted ring and a labelled chip, and an `aria-describedby` naming the chip.
   *
   * It is INDEPENDENT of `motion`: the plan page reads it with motion off. It
   * composes with every motion class (the deepen outline sits inside the ring)
   * and adds none of them; an exiting node carries no cue.
   *
   * ⚠️ Absent or `null`, the rendered DOM is byte for byte what it was before
   * this prop existed — `/roadmap`, runs, onboarding and work-item roadmaps.
   *
   * AT WORK (Story MOTIR-8413 · MOTIR-8416; design `design/ai-chat/design-notes.md`
   * § _Motir at work_). A drafting cue whose `moving` is set marks its box
   * `data-cue-motion="at-work"` — the card pops and breathes; such a MOVING cue the
   * map stops naming while its node is still drawn is RETAINED as
   * `data-cue-motion="leaving"` until its ring's fade ends, then dropped. Under
   * reduced motion nothing is retained. A laying cue never moves and never lingers.
   */
  nodeCues?: ReadonlyMap<string, NodeCue> | null;
  /**
   * THE CHANGED HIGHLIGHT (MOTIR-11185) — a node id → highlight map of the cards
   * the planner CHANGED just now. A lit node's box gains `data-changed`, the class
   * `canvas-node--changed`, a solid ring (`.canvas-changed-ring`, between the
   * deepen outline and the dotted cue ring, so it composes with both) and a
   * visually hidden name joined into `aria-describedby`. The ring is keyed on
   * `seq`, so a new change remounts it and restarts its fade instead of stacking.
   * Under reduced motion it is a static outline. The caller takes it off.
   *
   * ⚠️ Absent or `null`, the rendered DOM is what it was before this prop existed.
   */
  nodeHighlights?: ReadonlyMap<string, NodeHighlight> | null;
  className?: string;
}

/** One changed-card highlight: `seq` restarts it, `label` names it (*Just changed*). */
export interface NodeHighlight {
  seq: number;
  label: string;
}

/** One cue on a node box (§26.6 / §26.7; Part XXXI §31.1). `label` is its
 *  accessible name (*Being drafted now*); `text` is the chip's visible word
 *  (*Drafting*). THINKING (an author session with nothing written yet) and
 *  CHECKING (the final check reviewing the card) are static, like LAYING; only
 *  DRAFTING moves (MOTIR-11254). */
export interface NodeCue {
  kind: 'thinking' | 'drafting' | 'checking' | 'laying';
  label: string;
  text: string;
  /** Motir is writing this card RIGHT NOW (`readPlanAtWork(...).steps` names it).
   *  Absent ⇒ drawn but still. Ignored on a laying cue. */
  moving?: boolean;
}

/** The MOVING drafting cues a map no longer names, retained for their leaving fade (pure).
 *  `prev` is the map last rendered; `drawn` says whether a node is still on the canvas. */
export function leavingCuesOf(
  prev: ReadonlyMap<string, NodeCue> | null,
  next: ReadonlyMap<string, NodeCue> | null,
  held: Readonly<Record<string, NodeCue>>,
  drawn: (id: string) => boolean,
): Record<string, NodeCue> {
  const out: Record<string, NodeCue> = {};
  for (const [id, cue] of Object.entries(held)) {
    if (!next?.has(id) && drawn(id)) out[id] = cue;
  }
  for (const [id, cue] of prev ?? []) {
    if (cue.kind === 'drafting' && cue.moving && !next?.has(id) && drawn(id)) out[id] = cue;
  }
  return out;
}

/** The chip's glyph by state (§31.2) — the second non-colour channel. */
function CueGlyph({ kind }: { kind: NodeCue['kind'] }) {
  switch (kind) {
    case 'thinking':
      return <Brain aria-hidden="true" className="size-3" />;
    case 'drafting':
      return <PenLine aria-hidden="true" className="size-3" />;
    case 'checking':
      return <SearchCheck aria-hidden="true" className="size-3" />;
    default:
      return <ListTree aria-hidden="true" className="size-3" />;
  }
}

/** The cues falling back from DRAFTING to THINKING (Part XXXI §31.4 T4) — the
 *  draft was cleared mid-step, so the card's wash lifts and the box settles on the
 *  shipped leaving keyframes while the ring and chip swap in one frame. Kept while
 *  the node still reads Thinking, until the lift ends (pure). */
export function settlingCuesOf(
  prev: ReadonlyMap<string, NodeCue> | null,
  next: ReadonlyMap<string, NodeCue> | null,
  held: Readonly<Record<string, NodeCue>>,
): Record<string, NodeCue> {
  const out: Record<string, NodeCue> = {};
  for (const [id, cue] of Object.entries(held)) {
    if (next?.get(id)?.kind === 'thinking') out[id] = cue;
  }
  for (const [id, cue] of next ?? []) {
    if (cue.kind === 'thinking' && prev?.get(id)?.kind === 'drafting') out[id] = cue;
  }
  return out;
}

// ── MOTION state (MOTIR-6297) ─────────────────────────────────────────────────
type Snapshot = { nodes: CanvasNode[]; edges: CanvasEdge[] };
/** One change being played, stage by stage. */
interface Play {
  id: number;
  diff: MotionDiff;
  stages: MotionStage[];
  index: number;
  /** The snapshot the change left, by id — where a re-laid card waits before its glide. */
  from: Map<string, CanvasNode>;
}
/** A node retained for its exit; `after` is the id it was drawn after, so it keeps its DOM place. */
interface ExitNode {
  node: CanvasNode;
  after: string | null;
}
/** An edge retained for its fade, with its ends where they STOOD (it fades on its old route). */
interface ExitEdge {
  key: string;
  edge: CanvasEdge;
  ends: CanvasNode[];
}
/** The outline cue — a DEEPEN, or (under reduced motion) an arrival's stand-in for its entrance. */
interface Mark {
  motion: 'enter' | 'cue';
  phase: 'hold' | 'fade';
  reduced: boolean;
}
interface MotionState {
  armed: boolean;
  seq: number;
  baseline: Snapshot;
  play: Play | null;
  exitNodes: ExitNode[];
  exitEdges: ExitEdge[];
  marks: Record<string, Mark>;
}
/** How one node or edge is drawn this frame. */
interface MotionMark {
  motion?: 'enter' | 'exit' | 'cue' | 'relay';
  cls: string[];
  delay?: number;
}

const idleMotion = (armed: boolean, baseline: Snapshot): MotionState => ({
  armed,
  seq: 0,
  baseline,
  play: null,
  exitNodes: [],
  exitEdges: [],
  marks: {},
});

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Fold one new snapshot into the motion state (pure). Called only between changes
 * — a snapshot that lands while a change plays waits for it, and is then diffed
 * against what was drawn, so an arrival is never replayed (§23.4).
 */
function advanceMotion(
  s: MotionState,
  next: Snapshot,
  ignoreMoves: ReadonlySet<string>,
  reduced: boolean,
): MotionState {
  const d = diffSnapshots(s.baseline, next, ignoreMoves);
  if (isQuietDiff(d)) return d.dirty ? { ...s, baseline: next } : s;

  const nextIds = new Set(next.nodes.map((n) => n.id));
  const nextEdges = new Set(next.edges.map(edgeKey));
  const gone = new Set(d.exits);
  const marks: Record<string, Mark> = {};
  for (const [id, m] of Object.entries(s.marks)) if (!gone.has(id)) marks[id] = m;
  // A retained exit whose id (or edge) came BACK stops being an exit: it is drawn live again.
  const keptExitNodes = s.exitNodes.filter((x) => !nextIds.has(x.node.id));
  const keptExitEdges = s.exitEdges.filter((x) => !nextEdges.has(x.key));

  if (reduced) {
    // §23.5 — no transition runs; the level is redrawn in its new state at once, and
    // an arrival or a deepen reads as a change through the held outline.
    for (const id of d.enters) marks[id] = { motion: 'enter', phase: 'hold', reduced: true };
    for (const id of d.cues) marks[id] = { motion: 'cue', phase: 'hold', reduced: true };
    return {
      ...s,
      baseline: next,
      marks,
      exitNodes: keptExitNodes,
      exitEdges: keptExitEdges,
    };
  }

  for (const id of d.cues) marks[id] = { motion: 'cue', phase: 'hold', reduced: false };
  const from = new Map(s.baseline.nodes.map((n) => [n.id, n]));
  const exitNodes = [...keptExitNodes];
  s.baseline.nodes.forEach((n, i) => {
    if (gone.has(n.id)) exitNodes.push({ node: n, after: s.baseline.nodes[i - 1]?.id ?? null });
  });
  const edgeGone = new Set(d.edgeExits);
  const exitEdges = [...keptExitEdges];
  for (const e of s.baseline.edges) {
    const key = edgeKey(e);
    if (!edgeGone.has(key)) continue;
    edgeGone.delete(key); // one retained path per key
    const ends = [from.get(e.from), from.get(e.to)].filter((n): n is CanvasNode => !!n);
    exitEdges.push({ key, edge: e, ends });
  }
  const stages = planStages(d);
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    baseline: next,
    marks,
    exitNodes,
    exitEdges,
    play: stages.length > 0 ? { id: seq, diff: d, stages, index: 0, from } : null,
  };
}

/** Draw the retained exits back in at the place they held, so none is re-ordered in the DOM. */
function withExits(live: CanvasNode[], exits: ExitNode[]): CanvasNode[] {
  if (exits.length === 0) return live;
  const out = [...live];
  const drawn = new Set(live.map((n) => n.id));
  for (const x of exits) {
    if (drawn.has(x.node.id)) continue;
    const at = x.after ? out.findIndex((n) => n.id === x.after) : -1;
    out.splice(at + 1, 0, x.node);
    drawn.add(x.node.id);
  }
  return out;
}

/**
 * Expire timed entries — each entry keyed and identified by OBJECT, so a render that
 * keeps an entry keeps its timer, and one that replaces it restarts the timer.
 */
function useTimedEntries<T extends object>(
  entries: ReadonlyArray<readonly [string, T]>,
  msOf: (entry: T) => number,
  onExpire: (key: string, entry: T) => void,
) {
  const timers = useRef(new Map<string, { entry: T; t: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const live = new Set<string>();
    for (const [key, entry] of entries) {
      live.add(key);
      const cur = timers.current.get(key);
      if (cur?.entry === entry) continue;
      if (cur) clearTimeout(cur.t);
      timers.current.set(key, {
        entry,
        t: setTimeout(() => {
          timers.current.delete(key);
          onExpire(key, entry);
        }, msOf(entry)),
      });
    }
    for (const [key, cur] of timers.current) {
      if (live.has(key)) continue;
      clearTimeout(cur.t);
      timers.current.delete(key);
    }
  });
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const cur of map.values()) clearTimeout(cur.t);
      map.clear();
    };
  }, []);
}

const FALLBACK = { w: 300, h: 120 }; // edge anchoring before a node is measured
const ACTIVATE_SLOP = 4; // px of movement that turns a click into a drag
const ZOOM_STEP = 1.2; // the −/+ buttons (one decisive step)
// Per wheel/trackpad EVENT — kept gentle so a trackpad (which fires many events)
// doesn't zoom in jumps; the buttons stay the fast path.
const WHEEL_STEP = 1.04;
const PAN_KEY_STEP = 64;

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean }
  | {
      kind: 'node';
      id: string;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      scale: number;
      moved: boolean;
    };

export function PlanningCanvas({
  nodes,
  edges,
  renderNode,
  onNodeMove,
  onNodeActivate,
  focusNodeId,
  focusNonce,
  focusScale,
  selectedId,
  litIds,
  onBackgroundClick,
  ariaLabel,
  arrival,
  motion = false,
  animateInitial = false,
  nodeCues = null,
  nodeHighlights = null,
  className,
}: PlanningCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});

  const vpRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<Map<string, HTMLElement>>(new Map());
  const gesture = useRef<Gesture | null>(null);
  const didFit = useRef(false);
  // Unique marker ids (a doc-global `<marker>` id collides across canvas instances).
  const mId = useId().replace(/:/g, '');

  // ── MOTION (MOTIR-6297) — a presence layer over the snapshots, opt-in ──
  // Adjusted DURING render when a new snapshot arrives (React's "state from a prop
  // change" idiom), so a new node's very first render already carries its
  // `data-motion`, and a leaving node is never unmounted before it is retained.
  // An `animateInitial` mount starts from the EMPTY level it watched, so its first
  // snapshot diffs as arrivals through the ordinary path below.
  const [mo, setMo] = useState<MotionState>(() =>
    idleMotion(motion, motion && animateInitial ? { nodes: [], edges: [] } : { nodes, edges }),
  );
  if (motion) {
    if (!mo.armed) {
      // Switched on under a mounted canvas: what is drawn now is the FIRST read.
      setMo(idleMotion(true, { nodes, edges }));
    } else if (!mo.play && (nodes !== mo.baseline.nodes || edges !== mo.baseline.edges)) {
      const next = advanceMotion(
        mo,
        { nodes, edges },
        new Set(Object.keys(dragPos)), // the reader's own drag is not a re-lay
        prefersReducedMotion(),
      );
      if (next !== mo) setMo(next);
    }
  } else if (mo.armed) {
    setMo(idleMotion(false, { nodes, edges }));
  }
  // While a change plays, the canvas draws the snapshot it is playing TO; a newer
  // one waits for it (§23.4 "a read that lands while a change is still playing").
  const play = motion ? mo.play : null;
  const liveNodes = play ? mo.baseline.nodes : nodes;
  const liveEdges = play ? mo.baseline.edges : edges;
  const stage = play ? play.stages[play.index] : null;
  const reached = (st: MotionStage) => !!play && play.stages.indexOf(st) <= play.index;
  const movers = new Set(play?.diff.movers);
  const enterOrder = new Map(play?.diff.enters.map((id, i) => [id, i]));
  const edgeEnters = new Set(play?.diff.edgeEnters);
  const hiddenEdges = new Set(play?.diff.hiddenEdges);
  // A re-laid card WAITS in its old cell while the leaving card fades (§23.3).
  const heldAt = (id: string) =>
    stage === 'out' && movers.has(id) ? play?.from.get(id) : undefined;

  const nodeById = new Map(liveNodes.map((n) => [n.id, n]));

  // ── THE CUE LEAVING (MOTIR-8416) — a drafting cue the map stops naming keeps
  // its ring and chip through the design's leaving fade, then is dropped on that
  // fade's end. Adjusted during render, like the motion layer above, so the first
  // render without the cue already draws it leaving. Reduced motion retains nothing.
  // …and a DRAFTING cue that falls back to THINKING (MOTIR-11254, §31.4 T4) is
  // marked SETTLING until its wash has lifted, by the same render-time fold.
  const [cueTrack, setCueTrack] = useState<{
    seen: ReadonlyMap<string, NodeCue> | null;
    leaving: Record<string, NodeCue>;
    settling: Record<string, NodeCue>;
  }>({ seen: nodeCues, leaving: {}, settling: {} });
  if (cueTrack.seen !== nodeCues) {
    const reduced = prefersReducedMotion();
    const leaving = reduced
      ? {}
      : leavingCuesOf(cueTrack.seen, nodeCues, cueTrack.leaving, (id) => nodeById.has(id));
    const settling = reduced ? {} : settlingCuesOf(cueTrack.seen, nodeCues, cueTrack.settling);
    setCueTrack({ seen: nodeCues, leaving, settling });
  }
  const dropSettlingCue = (id: string) =>
    setCueTrack((t) => {
      if (!(id in t.settling)) return t;
      const settling = { ...t.settling };
      delete settling[id];
      return { ...t, settling };
    });
  const dropLeavingCue = (id: string) =>
    setCueTrack((t) => {
      if (!(id in t.leaving)) return t;
      const leaving = { ...t.leaving };
      delete leaving[id];
      return { ...t, leaving };
    });
  const rectOf = (n: CanvasNode): Rect => {
    const p = dragPos[n.id] ?? heldAt(n.id);
    const s = sizes[n.id];
    return {
      x: p ? p.x : n.x,
      y: p ? p.y : n.y,
      w: s?.w ?? n.width ?? FALLBACK.w,
      h: s?.h ?? n.height ?? FALLBACK.h,
    };
  };
  // The explicit fit-to-view control's view: the WHOLE level, framed, down to
  // `MIN_SCALE`. Unchanged by MOTIR-3837 — that is what the control is for.
  const computeFit = (vw: number, vh: number): View =>
    fitView(nodesBounds(nodes.map(rectOf)), { w: vw, h: vh });
  // The ARRIVAL view: the same fit unless the consumer asked for a legibility floor
  // (MOTIR-3837), in which case a level that cannot be shown legibly arrives AT the
  // floor, centred per axis on the focal card rather than shrunk to frame.
  const computeArrival = (vw: number, vh: number): View => {
    if (!arrival) return computeFit(vw, vh);
    const focal = arrival.focalNodeId ? nodeById.get(arrival.focalNodeId) : undefined;
    return arrivalView(
      nodesBounds(nodes.map(rectOf)),
      { w: vw, h: vh },
      arrival.floor,
      focal ? rectOf(focal) : undefined,
    );
  };

  // Route ALL edges together so the global lane pass keeps every connector on its
  // own track (one entry per edge, aligned to `edges`; null where a node is gone).
  const routes = routeEdges(
    liveEdges,
    (id) => {
      const n = nodeById.get(id);
      return n ? rectOf(n) : undefined;
    },
    (id) => nodeById.get(id)?.topTab === true,
  );
  // A retained edge fades on the route it HAD — its ends where they stood.
  const exitEdges = motion ? mo.exitEdges : [];
  const exitEnds = new Map(exitEdges.flatMap((x) => x.ends.map((n) => [n.id, n] as const)));
  const exitRoutes = routeEdges(
    exitEdges.map((x) => x.edge),
    (id) => {
      const n = exitEnds.get(id);
      return n ? rectOf(n) : undefined;
    },
    (id) => exitEnds.get(id)?.topTab === true,
  );
  const drawnNodes = motion ? withExits(liveNodes, mo.exitNodes) : liveNodes;

  const nodeMotion = (id: string): MotionMark | null => {
    if (!motion) return null;
    if (!nodeById.has(id)) return { motion: 'exit', cls: ['canvas-node--exit'] };
    const m: MotionMark = { cls: [] };
    if (movers.has(id) && (stage === 'out' || stage === 'glide')) {
      m.motion = 'relay';
      if (stage === 'glide') m.cls.push('canvas-node--relay');
    }
    const mark = mo.marks[id];
    if (mark) {
      m.motion = mark.motion;
      m.cls.push(mark.phase === 'hold' ? 'canvas-node--deepened' : 'canvas-node--deepened-out');
    }
    const i = enterOrder.get(id);
    if (i !== undefined) {
      m.motion = 'enter';
      if (reached('enter')) {
        m.cls.push('canvas-node--enter');
        m.delay = enterDelayMs(i);
      } else {
        m.cls.push('canvas-motion-held'); // its cell is still being vacated
      }
    }
    return m.motion ? m : null;
  };
  const edgeMotion = (e: CanvasEdge): MotionMark | null => {
    if (!play) return null;
    const k = edgeKey(e);
    const arrows = reached('arrows');
    if (edgeEnters.has(k)) {
      return { motion: 'enter', cls: [arrows ? 'canvas-edge--enter' : 'canvas-motion-held'] };
    }
    if (hiddenEdges.has(k)) {
      // Hidden for the glide (its route is already at the end), back on the final route.
      return arrows
        ? { motion: 'enter', cls: ['canvas-edge--enter'] }
        : { motion: 'relay', cls: ['canvas-edge--hide'] };
    }
    return null;
  };
  const withMotion = (base: string, mv: MotionMark | null) =>
    mv && mv.cls.length > 0 ? `${base} ${mv.cls.join(' ')}` : base;

  // The durations are the theme's tokens, read off the canvas so a `[data-style]`
  // pace applies; the stylesheet animates with the same tokens.
  const durations = () =>
    readDurations(
      vpRef.current && typeof getComputedStyle === 'function'
        ? getComputedStyle(vpRef.current)
        : null,
    );
  // Advance the change stage by stage.
  useEffect(() => {
    const current = play?.stages[play.index];
    if (!play || !current) return;
    const t = setTimeout(
      () =>
        setMo((s) => {
          if (s.play?.id !== play.id || s.play.index !== play.index) return s;
          const index = play.index + 1;
          return { ...s, play: index < play.stages.length ? { ...play, index } : null };
        }),
      stageMs(current, play.diff, durations()),
    );
    return () => clearTimeout(t);
  }, [play]);
  // A retained exit goes on its animation's end, or its duration + 50ms if that
  // never fires (§23.4). A focused card that leaves hands focus to the canvas.
  const dropExitNode = (id: string) => {
    const el = nodeEls.current.get(id);
    if (el?.dataset.motion === 'exit' && el.contains(document.activeElement)) {
      vpRef.current?.focus();
    }
    setMo((s) => ({ ...s, exitNodes: s.exitNodes.filter((x) => x.node.id !== id) }));
  };
  const dropExitEdge = (key: string) =>
    setMo((s) => ({ ...s, exitEdges: s.exitEdges.filter((x) => x.key !== key) }));
  const exitMs = () => durations().base + EXIT_FALLBACK_SLACK_MS;
  useTimedEntries(
    motion ? mo.exitNodes.map((x) => [x.node.id, x] as const) : [],
    exitMs,
    dropExitNode,
  );
  useTimedEntries(motion ? exitEdges.map((x) => [x.key, x] as const) : [], exitMs, dropExitEdge);
  // A LEAVING cue (MOTIR-8416) goes on its ring's fade end, or after the same
  // duration + slack if that never fires — independent of `motion`, like the cue.
  useTimedEntries(Object.entries(cueTrack.leaving), exitMs, dropLeavingCue);
  // A SETTLING cue (MOTIR-11254) is released on the same clock.
  useTimedEntries(Object.entries(cueTrack.settling), exitMs, dropSettlingCue);
  // The outline: held, then faded (motion) or simply removed (reduced motion, §23.5).
  useTimedEntries(
    motion ? Object.entries(mo.marks) : [],
    (m) => (m.phase === 'fade' ? durations().slow : m.reduced ? REDUCED_HOLD_MS : DEEPEN_HOLD_MS),
    (id, m) =>
      setMo((s) => {
        if (s.marks[id] !== m) return s;
        const marks = { ...s.marks };
        if (m.phase === 'hold' && !m.reduced) marks[id] = { ...m, phase: 'fade' };
        else delete marks[id];
        return { ...s, marks };
      }),
  );

  // ── measure node sizes so edges anchor accurately (RO callback setState) ──
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setSizes((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.nodeId;
          if (!id) continue;
          const { width: w, height: h } = e.contentRect;
          if (!prev[id] || prev[id].w !== w || prev[id].h !== h) {
            next[id] = { w, h };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    nodeEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [nodes]);

  // ── fit-to-view ONCE, when the viewport first has a size (RO callback) ──
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (didFit.current || nodes.length === 0) return;
      const r = vp.getBoundingClientRect();
      if (r.width === 0) return;
      didFit.current = true;
      setView(computeArrival(r.width, r.height));
    });
    ro.observe(vp);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  // ── search-to-focus: pan the requested node to the viewport centre ──
  // Keyed on `focusNonce` so a repeat focus of the same node re-centres it. The scale
  // is preserved (a pan) UNLESS `focusScale` is set, in which case the node is also
  // zoomed to that readable default (the locate control, MOTIR-1421). Reads the live
  // node/rect each fire.
  useEffect(() => {
    if (focusNonce === undefined || !focusNodeId) return;
    const vp = vpRef.current;
    const n = nodeById.get(focusNodeId);
    if (!vp || !n) return;
    const r = vp.getBoundingClientRect();
    if (r.width === 0) return;
    setView((v) => centerOn(rectOf(n), { w: r.width, h: r.height }, focusScale ?? v.scale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, focusNodeId]);

  // ── wheel zoom via a NON-passive native listener (so preventDefault holds) ──
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      setView((v) => zoomToward(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  // ── pointer: drag a node (if movable) or pan the surface ──
  function onPointerDown(e: RPointerEvent<HTMLDivElement>) {
    const vp = vpRef.current;
    if (!vp) return;
    const nodeEl = (e.target as HTMLElement).closest('[data-node-id]') as HTMLElement | null;
    const id = nodeEl?.dataset.nodeId;
    const n = id ? nodeById.get(id) : undefined;
    vp.setPointerCapture(e.pointerId);
    // A press on a node starts a node gesture when it can drag OR activate; the
    // pointerup decides which (a press that didn't move is a click → activate).
    if (n && (onNodeMove || onNodeActivate)) {
      gesture.current = {
        kind: 'node',
        id: n.id,
        sx: e.clientX,
        sy: e.clientY,
        ox: n.x,
        oy: n.y,
        scale: view.scale,
        moved: false,
      };
    } else {
      gesture.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        tx: view.tx,
        ty: view.ty,
        moved: false,
      };
    }
  }
  function onPointerMove(e: RPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      if (
        Math.abs(e.clientX - g.sx) > ACTIVATE_SLOP ||
        Math.abs(e.clientY - g.sy) > ACTIVATE_SLOP
      ) {
        g.moved = true;
      }
      setView((v) => ({ ...v, tx: g.tx + (e.clientX - g.sx), ty: g.ty + (e.clientY - g.sy) }));
    } else {
      if (
        Math.abs(e.clientX - g.sx) > ACTIVATE_SLOP ||
        Math.abs(e.clientY - g.sy) > ACTIVATE_SLOP
      ) {
        g.moved = true;
      }
      if (!onNodeMove) return; // activate-only node: don't move it
      const d = screenDeltaToWorld(e.clientX - g.sx, e.clientY - g.sy, g.scale);
      const nx = g.ox + d.dx;
      const ny = g.oy + d.dy;
      setDragPos((p) => ({ ...p, [g.id]: { x: nx, y: ny } }));
      onNodeMove(g.id, nx, ny);
    }
  }
  function endGesture(e: RPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    gesture.current = null;
    vpRef.current?.releasePointerCapture(e.pointerId);
    if (g?.kind === 'node') {
      setDragPos((p) => {
        const next = { ...p };
        delete next[g.id];
        return next;
      });
      // A press that never moved is a click → activate the node.
      if (!g.moved) onNodeActivate?.(g.id);
    } else if (g?.kind === 'pan' && !g.moved) {
      // A press on empty canvas that did not pan → clear the selection.
      onBackgroundClick?.();
    }
  }

  function zoomCentred(factor: number) {
    const r = vpRef.current?.getBoundingClientRect();
    if (!r) return;
    setView((v) => zoomToward(v, factor, r.width / 2, r.height / 2));
  }
  function doFit() {
    const r = vpRef.current?.getBoundingClientRect();
    if (!r) return;
    setView(computeFit(r.width, r.height));
  }
  function onKeyDown(e: RKeyboardEvent<HTMLDivElement>) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomCentred(ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomCentred(1 / ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      doFit();
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? PAN_KEY_STEP : e.key === 'ArrowRight' ? -PAN_KEY_STEP : 0;
      const dy = e.key === 'ArrowUp' ? PAN_KEY_STEP : e.key === 'ArrowDown' ? -PAN_KEY_STEP : 0;
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    }
  }

  // One dependency connector. Shared by the live edge layer and (motion only) the
  // layer that holds a removed edge for its fade.
  const drawEdge = (
    edge: CanvasEdge,
    route: NonNullable<(typeof routes)[number]>,
    key: string,
    mv: MotionMark | null,
    onEnd?: () => void,
  ) => {
    const pending = edge.variant === 'pending';
    const cross = edge.variant === 'cross';
    const running = edge.variant === 'running';
    // When a node is selected, only its own edges stay lit; a lit non-cross
    // edge is EMPHASISED in the accent INK (so even a faint dashed `pending`
    // connector clearly pops, matching the selected card's accent ring).
    // ⚠️ `--el-accent-on-surface`, NEVER `--el-accent`. The fill token's
    // contrast is guaranteed against `--el-accent-text` sitting ON it, not
    // against a board it is painted on: on Candy light it measured 1.26:1
    // on `--el-canvas` and 1.01:1 against a plain edge dimmed to 12%, so
    // selecting a card painted its own edges the shade of the ones it was
    // de-emphasising. `tests/theme/canvasEmphasisInkContrast.test.ts` reads
    // the token back out of this file and measures it. MOTIR-4474.
    // A live selection WINS; `litIds` decides only without one, the same
    // precedence the consumer's cards follow (MOTIR-5639).
    const lit =
      selectedId != null
        ? edge.from === selectedId || edge.to === selectedId
        : litIds == null || litIds.has(edge.from) || litIds.has(edge.to);
    // ⚠️ `running` outranks the selection emphasis and yields only to
    // `cross`. A run's live edge must stay the live one while a reader
    // clicks around the graph; `cross` stays loudest because a plan that
    // is WRONG outranks a plan that is in motion.
    const emph = lit && selectedId != null && !cross && !running;
    const marker = cross
      ? 'warning'
      : running
        ? 'running'
        : emph
          ? 'emphasis'
          : pending
            ? 'pending'
            : 'committed';
    return (
      <path
        key={key}
        d={route.d}
        fill="none"
        className={withMotion(
          cross
            ? 'stroke-(--el-warning)'
            : running
              ? // The dash + its travel are in `globals.css`, gated behind
                // `prefers-reduced-motion: no-preference` — so the STATIC
                // form is the default and reduced motion keeps this hue
                // and weight without moving (MOTIR-3972).
                'canvas-edge-running stroke-(--el-status-in-progress)'
              : emph
                ? 'stroke-(--el-accent-on-surface)'
                : pending
                  ? 'stroke-(--el-canvas-edge-pending)'
                  : 'stroke-(--el-canvas-edge-committed)',
          mv,
        )}
        data-motion={mv?.motion}
        onAnimationEnd={onEnd}
        strokeWidth={running ? 3 : lit && selectedId != null ? (cross ? 3.5 : 3) : cross ? 2.5 : 2}
        strokeLinecap="round"
        // a denser dash when emphasised keeps the dashed line legible at the
        // accent colour without losing the "pending" cue.
        strokeDasharray={pending ? (emph ? '5 6' : '2 7') : undefined}
        markerEnd={`url(#${mId}-${marker})`}
        vectorEffect="non-scaling-stroke"
        style={{ opacity: lit ? 1 : 0.12 }}
      />
    );
  };

  const worldTransform = {
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
    transformOrigin: '0 0' as const,
  };

  return (
    <div
      className={['relative h-full w-full overflow-hidden', className].filter(Boolean).join(' ')}
    >
      <div
        ref={vpRef}
        role="application"
        aria-label={ariaLabel ?? 'Planning canvas'}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={onKeyDown}
        className="absolute inset-0 cursor-grab touch-none bg-(--el-canvas) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        data-testid="planning-canvas"
      >
        {/* Arrowhead markers — in their OWN <svg> (marker refs are doc-global), so
            the canvas-edges <path> count stays = the edge count. One per variant,
            coloured to match its edge → a reader can tell DIRECTION (the arrow
            points blocker → blocked). MOTIR-1331. */}
        <svg className="absolute h-0 w-0" aria-hidden="true">
          <defs>
            {(['committed', 'pending', 'warning', 'emphasis', 'running'] as const).map((kind) => (
              <marker
                key={kind}
                id={`${mId}-${kind}`}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M0 0L10 5L0 10z"
                  className={
                    kind === 'warning'
                      ? 'fill-(--el-warning)'
                      : kind === 'running'
                        ? 'fill-(--el-status-in-progress)'
                        : kind === 'emphasis'
                          ? // the ACCENT INK, not `--el-accent` (the FILL). A marker
                            // painted on the board is a mark ON a surface, so it owes
                            // 3:1 against `--el-canvas` — which the fill misses in four
                            // light palettes (1.24–2.77:1). MOTIR-4474.
                            'fill-(--el-accent-on-surface)'
                          : kind === 'pending'
                            ? 'fill-(--el-canvas-edge-pending)'
                            : 'fill-(--el-canvas-edge-committed)'
                  }
                />
              </marker>
            ))}
          </defs>
        </svg>

        {/* MOTION only (MOTIR-6297): an edge that LEFT the snapshot, held on its old
            route for its fade — in its OWN layer, beneath the live edges, so the
            canvas-edges <path> count stays = the edge count it was given. */}
        {exitEdges.length > 0 && (
          <svg
            className="pointer-events-none absolute top-0 left-0 h-full w-full"
            style={{ ...worldTransform, overflow: 'visible' }}
            aria-hidden="true"
            data-testid="canvas-edges-exit"
          >
            {exitEdges.map((x, i) => {
              const route = exitRoutes[i];
              if (!route) return null;
              return drawEdge(
                x.edge,
                route,
                `exit~${x.key}`,
                { motion: 'exit', cls: ['canvas-edge--exit'] },
                () => dropExitEdge(x.key),
              );
            })}
          </svg>
        )}

        {/* edges — read-only dependency connectors (non-scaling stroke) */}
        <svg
          className="pointer-events-none absolute top-0 left-0 h-full w-full"
          style={{ ...worldTransform, overflow: 'visible' }}
          aria-hidden="true"
          data-testid="canvas-edges"
        >
          {liveEdges.map((edge, i) => {
            const route = routes[i];
            if (!route) return null;
            return drawEdge(edge, route, `${edge.from}~${edge.to}~${i}`, edgeMotion(edge));
          })}
        </svg>

        {/* nodes — caller content; the canvas owns the box + drag */}
        <div className="absolute top-0 left-0" style={worldTransform} data-testid="canvas-world">
          {drawnNodes.map((n) => {
            const r = rectOf(n);
            const mv = nodeMotion(n.id);
            // THE CUE (MOTIR-7830) — never on a node that is leaving.
            const liveCue =
              nodeCues && mv?.motion !== 'exit' && nodeById.has(n.id)
                ? (nodeCues.get(n.id) ?? null)
                : null;
            const leftCue =
              !liveCue && mv?.motion !== 'exit' && nodeById.has(n.id)
                ? (cueTrack.leaving[n.id] ?? null)
                : null;
            const cue = liveCue ?? leftCue;
            // AT WORK (MOTIR-8416): the one switch the design's motion binds to.
            const cueMotion = leftCue
              ? 'leaving'
              : liveCue?.kind === 'drafting' && liveCue.moving
                ? 'at-work'
                : liveCue?.kind === 'thinking' && n.id in cueTrack.settling
                  ? 'settling'
                  : undefined;
            const cueId = cue ? `${mId}-cue-${n.id}` : undefined;
            // THE CHANGED HIGHLIGHT (MOTIR-11185) — never on a node that is leaving.
            const lit =
              nodeHighlights && mv?.motion !== 'exit' && nodeById.has(n.id)
                ? (nodeHighlights.get(n.id) ?? null)
                : null;
            const litId = lit ? `${mId}-changed-${n.id}` : undefined;
            const describedBy = [cueId, litId].filter(Boolean).join(' ') || undefined;
            const boxClass = withMotion(
              `absolute rounded-(--radius-card) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent) ${
                onNodeMove ? 'cursor-grab active:cursor-grabbing' : ''
              }`,
              mv,
            );
            return (
              <div
                key={n.id}
                data-node-id={n.id}
                data-motion={mv?.motion}
                data-cue={cue?.kind}
                data-cue-motion={cueMotion}
                data-changed={lit ? '' : undefined}
                aria-describedby={describedBy}
                tabIndex={0}
                onKeyDown={
                  onNodeActivate
                    ? (e) => {
                        // The card's OWN key only (MOTIR-8648): a renderNode may put
                        // buttons inside the card (View, Open, the target toggle), and
                        // their Enter/Space bubbles here. preventDefault() on it would
                        // cancel the button's click and re-activate the card instead.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onNodeActivate(n.id);
                        }
                      }
                    : undefined
                }
                ref={(el) => {
                  if (el) nodeEls.current.set(n.id, el);
                  else nodeEls.current.delete(n.id);
                }}
                onAnimationEnd={
                  mv?.motion === 'exit'
                    ? (e) => {
                        // the card's OWN exit, not an animation bubbling up from inside it
                        if (e.target === e.currentTarget) dropExitNode(n.id);
                      }
                    : undefined
                }
                className={`${boxClass}${cue ? ` canvas-node--${cue.kind}` : ''}${
                  lit ? ' canvas-node--changed' : ''
                }`}
                style={
                  mv?.delay !== undefined
                    ? { left: r.x, top: r.y, animationDelay: `${mv.delay}ms` }
                    : { left: r.x, top: r.y }
                }
              >
                {renderNode(n)}
                {lit ? (
                  <>
                    <span
                      key={`changed-${lit.seq}`}
                      aria-hidden="true"
                      data-testid="canvas-changed-ring"
                      className="canvas-changed-ring"
                      style={{ animationDuration: `${CHANGED_HIGHLIGHT_MS}ms` }}
                    />
                    <span id={litId} className="sr-only">
                      {lit.label}
                    </span>
                  </>
                ) : null}
                {cue ? (
                  <>
                    {/* The dotted RING — outside the deepen outline (7px vs 2px),
                        never `outline`, so a drafted card that deepens shows both. */}
                    <span
                      aria-hidden="true"
                      className="canvas-cue-ring"
                      onAnimationEnd={
                        leftCue
                          ? (e) => {
                              if (e.animationName === 'canvas-fade-out') dropLeavingCue(n.id);
                            }
                          : undefined
                      }
                    />
                    {/* The labelled CHIP — the cue's name; thinking, drafting and
                        checking on the top edge, laying on the bottom, where the
                        children will hang. Each state has its own glyph (§31.2). */}
                    <span
                      id={cueId}
                      role="img"
                      aria-label={cue.label}
                      data-testid={`canvas-cue-${cue.kind}`}
                      className="canvas-cue-chip"
                    >
                      <CueGlyph kind={cue.kind} />
                      {cue.text}
                    </span>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* "blocked elsewhere" flag badges — the bad-plan SIGNAL, in their OWN layer (NOT
            the edge <svg>, whose <path> count is asserted): a warning chip + flag
            glyph + label at each cross edge's midpoint, so the tangle never rests
            on edge colour alone. Decorative — the dependency facts live in the
            node list. Rendered AFTER the node layer (MOTIR-1583) so the chip paints
            ABOVE the cards: both layers are position:absolute with no z-index, so a
            chip sitting at an edge's midpoint over a card would otherwise be occluded.
            The layer is pointer-events-none, so stacking it on top intercepts nothing. */}
        <div
          className="pointer-events-none absolute top-0 left-0"
          style={worldTransform}
          aria-hidden="true"
          data-testid="canvas-cross-flags"
        >
          {liveEdges.map((edge, i) => {
            if (edge.variant !== 'cross') return null;
            const route = routes[i];
            if (!route) return null;
            const m = route.mid;
            return (
              <span
                key={`flag~${edge.from}~${edge.to}~${i}`}
                // the chip rides its edge's motion (MOTIR-6297), so it never lands before the arrow
                className={withMotion(
                  'absolute inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-(--radius-badge) bg-(--el-warning-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium whitespace-nowrap text-(--el-warning-text) shadow-(--shadow-subtle)',
                  edgeMotion(edge),
                )}
                style={{ left: m.x, top: m.y }}
                data-testid="cross-flag"
              >
                <Flag className="size-3.5" />
                {t('node.blockedElsewhere')}
              </span>
            );
          })}
        </div>
      </div>

      {/* zoom controls (fixed — do not pan/zoom) */}
      <div
        className="absolute bottom-[calc(--spacing(4)+var(--canvas-foot-inset,0px))] left-4 flex overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-card)"
        role="group"
        aria-label={t('zoom')}
      >
        <ZoomButton label={t('zoomOut')} onClick={() => zoomCentred(1 / ZOOM_STEP)}>
          <Minus className="size-4" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={t('zoomIn')} onClick={() => zoomCentred(ZOOM_STEP)} bordered>
          <Plus className="size-4" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={t('fitToView')} onClick={doFit} bordered>
          <Maximize2 className="size-4" aria-hidden="true" />
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  bordered,
  children,
}: {
  label: string;
  onClick: () => void;
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex size-9 items-center justify-center text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) ${
        bordered ? 'border-l border-(--el-border-soft)' : ''
      }`}
    >
      {children}
    </button>
  );
}
