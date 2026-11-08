'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  Folder,
  LocateFixed,
  Maximize,
  Minimize,
  RotateCcw,
  Search,
  Target,
  X,
} from 'lucide-react';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';
import { Input } from '@/components/ui/Input';
import { useDependencyLegendCollapsed } from '@/lib/hooks/useDependencyLegendCollapsed';
import { Spinner } from '@/components/ui/Spinner';
import { ARRIVAL_MIN_SCALE } from '@/lib/planning/canvasGeometry';
import {
  arrivalsSummary,
  EMPTY_ARRIVALS,
  foldArrivals,
  liveSlot,
  offLevelInFlight,
  visitLevel,
  type ArrivalsLog,
  type InFlightCue,
  type LiveArrival,
} from '@/lib/planning/livePane';
import type { NodeCue } from '@/components/planning/PlanningCanvas';
import {
  NODE_H,
  NODE_W,
  deterministicLayout,
  focalNode,
  searchMatches,
  type CanvasCrumb,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';

// The reusable PROJECT-ROADMAP CANVAS (Subtask 7.20.2 / MOTIR-1194) — the
// FOUNDATION every planning surface composes. It shows the project roadmap ONE
// LEVEL AT A TIME (drill-down): the roots, then a node's children on drill. It
// owns the drill / breadcrumb / search / zoom UX over the shipped `PlanningCanvas`
// engine (MOTIR-1236) and pulls each level through a consumer-supplied
// `loadLevel(parentId)` — so the FETCH lives in the consumer (the canvas stays
// presentational) and the whole forest is never loaded up front (the per-level
// read, MOTIR-1010; mistake #91).
//
// CONTENT-AGNOSTIC: each node arrives with its own pre-rendered `content` (a
// `StationCard`, a `WorkItemNode`, an `IdeaCard`) + a `drillable` flag — so the
// onboarding canvas (stations + roots) and the roadmap (work items) are the SAME
// component. Drilling a node fetches its children; one level fills the screen, so
// a chain stays legible at any tree size.
//
// It normally ARRIVES AT THE ROOT and drills from there. A consumer that already
// knows where the user is headed passes `initialTrail` (MOTIR-2070) and the canvas
// opens on that level with that breadcrumb — an ordinary drilled view, held in the
// same state a manual drill sets, so Back / the crumbs / search / locate need no
// special case.

/** The selected card's planning-target action (MOTIR-6898) — see `targetAction`. */
export interface CanvasTargetAction {
  /** May this node be a target at all — a committed work item on this level? */
  isEligible: (id: string) => boolean;
  /** The node's work-item KEY, for the button's accessible name. */
  keyFor: (id: string) => string;
  /** Is it one already? The button then reads **Remove target**. */
  isTarget: (id: string) => boolean;
  /** False at the target cap — **Set as target** is disabled, Remove never is. */
  canAdd: boolean;
  /** The reason Set is disabled, shown as its tooltip (the cap sentence). */
  disabledReason: string;
  /** Add it, or remove it when it already is one. */
  onToggle: (id: string) => void;
}

export interface RoadmapLevel {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
}

interface ProjectRoadmapCanvasBaseProps {
  /** Fetch one level's nodes + edges (roots when `parentId` is null; else the
   *  parent's children). The consumer owns the I/O; memoize it. */
  loadLevel: (parentId: string | null) => Promise<RoadmapLevel>;
  /** Bump to refetch the CURRENT level when the consumer's source data changes
   *  (e.g. onboarding stations update as tiers complete). */
  reloadKey?: string | number;
  /** Saved per-node world positions (consumer-owned persistence). */
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** Drop the saved positions for these nodes (a layout RESET) — the consumer
   *  clears them from its store so the nodes fall back to the auto-layout. Fired by
   *  the "Reset layout" button and automatically when a level's auto-laid node set
   *  CHANGES (a re-plan), so stale positions never linger. */
  onResetPositions?: (nodeIds: string[]) => void;
  /** A LEAF node (not drillable) was activated. */
  onSelect?: (id: string) => void;
  /** Open the quick-view DETAIL surface for a node (MOTIR-1352). When wired, the
   *  canvas renders a **View** button on the SELECTED card (beside the "Open" drill
   *  pill) for every node flagged `viewable` — the work-item consumer opens the
   *  quick-view peek, the onboarding consumer opens the tier doc. View (open detail)
   *  is DISTINCT from select (highlight) and from "Open" (drill into children). */
  onView?: (id: string) => void;
  /**
   * The PLANNING TARGET action on the selected card (Story MOTIR-6894 · MOTIR-6898;
   * design `target-picker--search-and-canvas.mock.html` panel 6) — **Set as
   * target** / **Remove target**, between View and Open.
   *
   * ⚠️ OPT-IN, and absent everywhere but the planning surface. The canvas is one
   * component on several pages, and a target means nothing outside a planning
   * session — the Roadmap page, the item page's roadmap, onboarding and the plan
   * review pane pass nothing, and their selected card is exactly what it was.
   * `isEligible` narrows it further to committed WORK ITEMS: a folder tile, a
   * group node or a proposal never gets it.
   */
  targetAction?: CanvasTargetAction;

  /** Show the EXPAND-to-full-screen control (MOTIR-1420). The roadmap consumer opts
   *  in so a viewer can use the whole display for a large tree; onboarding does not.
   *  Takes the canvas full-viewport (via the Fullscreen API, with a fixed overlay as
   *  the always-deterministic base); ESC exits. */
  fullScreenable?: boolean;
  /** Show the LOCATE control (MOTIR-1421) — recentres the canvas on the actionable
   *  node: the "you are here" frontier first, else the ready-to-start nodes (cycling
   *  with wrap). The work-item roadmap opts in (its nodes carry `here` / `ready`);
   *  onboarding does not. */
  locatable?: boolean;
  /**
   * SHOW CHANGES — an OPT-IN emphasis mode (MOTIR-3261,
   * `design/ai-planning/design-notes.md` Part IX §L).
   *
   * A plan proposing several cards onto one busy committed level draws them
   * correctly and gives the reader nothing to pick them out with. One control
   * fixes it: pressed, every id in `ids` takes the canvas's SHIPPED
   * selected/search-matched ring and every other node takes the SHIPPED
   * `opacity-35` dim. It is the same pair the wrapper already applies to ONE
   * node, applied to a SET — no second highlight vocabulary, no second dim value.
   * The EDGES follow the same rule: an edge touching none of `ids` takes the
   * selection's shipped edge dim, so the arrows between two faded cards fade too
   * (MOTIR-5639). A live selection still wins, for edges as for cards.
   *
   * ⚠️ OPT-IN, and absent by default, exactly as `searchable` / `fullScreenable`
   * / `locatable` are — an onboarding canvas that grew a Show-changes toggle
   * would be a regression. The consumer supplies BOTH the ids and the COPY,
   * because the foundation has no idea it is showing a plan and cannot name what
   * "the plan's changes" are.
   *
   * `total` is the plan's whole size, so the control can say `3 of 11` when the
   * level holds fewer than all of them (Part IX §L5). It offers no way to reach
   * the rest, deliberately: that is the list view's job.
   */
  emphasis?: {
    ids: string[];
    total: number;
    label: string;
    /** Shown as `title` + accessible description when there is nothing to
     *  emphasise on this level. */
    emptyLabel: string;
    /**
     * The other degenerate level (MOTIR-4020, Part XIII §3d): one made ENTIRELY of
     * the emphasised set, where an ON state rings every card and dims none.
     *
     * ⚠️ Part IX §L6 called that state *"correct and harmless"* and left the
     * control ENABLED, and it was right — of a state the reader CHOSE. Armed on
     * ARRIVAL the same screen arrives unasked, and a ring that is on everything
     * teaches the reader, at the moment they land, that the ring means nothing.
     * So both degenerate levels disable the control, and each says its own why.
     */
    allLabel: string;
    /**
     * What the LOCATE control walks, in the consumer's words (Part XIII §4).
     *
     * When `emphasis` is supplied the locate targets become the emphasised set on
     * this level — the same cards, ringed and walked, so the two controls cannot
     * drift into two answers about which are the plan's. The label is the
     * consumer's for the same reason `searchLabel` is (MOTIR-4021): the shipped
     * `here` / `ready` wording names a frontier a proposal never is.
     */
    locateLabel: string;
  };
  /** The breadcrumb root label. */
  rootLabel?: string;
  ariaLabel?: string;
  /** Override the WARNING (red) edge legend row. Defaults to the "blocked
   *  elsewhere" meaning (MOTIR-1568); the sprint-scoped roadmap passes the "not in
   *  sprint" meaning so the legend matches the node flag + anchor (MOTIR-1379). */
  warningLegend?: { label: string; meaning: string };
  /**
   * SKIP A LEVEL THAT OFFERS NO CHOICE (MOTIR-1807). When a resolved level holds
   * EXACTLY ONE node and that node is `drillable`, descend into it instead of
   * rendering it — repeating while each newly-resolved level is again a single
   * drillable node, so an `epic → story → subtasks` chain compacts in ONE arrival.
   * The sprint-scoped read (MOTIR-1381) re-roots at the topmost in-sprint members, so
   * a sprint committed to one story's subtree hides the whole sprint behind one drill.
   *
   * "Exactly one node" counts the level's WORK — a node flagged `decorative` (the
   * pinned planning-origin cluster) is not a choice and does not hold the descent
   * back (MOTIR-1824).
   *
   * **Defaults to `false`, and that default is load-bearing.** This canvas is the
   * reusable FOUNDATION (MOTIR-1194) behind five consumers; an onboarding canvas that
   * silently walked past its single station would be a regression. Only the work-item
   * roadmap adapter opts in.
   *
   * The descent reuses the manual-drill transition EXACTLY, so an arrival is an
   * ordinary drilled view and nothing downstream can tell the two apart — the design
   * position drawn side by side in `design/roadmap/auto-drill.*` panel C.
   */
  autoDescendSingleParent?: boolean;
  /**
   * Replace what fills the canvas while the FIRST level is still being read
   * (MOTIR-2069). Defaults to the shipped centred spinner, which every other
   * consumer keeps. The planning workspace passes a level-shaped SKELETON
   * instead, because there the canvas is the surface the user is waiting on —
   * a skeleton says "your plan is arriving", a spinner says "something is
   * happening". Rendered in the same full-size box as the level it stands in
   * for, so filling it shifts nothing.
   */
  loadingFallback?: ReactNode;
  /**
   * Replace the ROOT level's empty state (MOTIR-2069) — what shows when the
   * project genuinely has nothing to draw. Defaults to the canvas's own copy.
   * The planning workspace passes its own, so an established-but-emptied
   * project gets the workspace's honest "nothing on the canvas yet" invitation
   * rather than the bare panel. Does NOT affect a DRILLED empty level, which is
   * a different statement ("this parent has no children").
   */
  emptyRoot?: ReactNode;
  /**
   * Replace a DRILLED empty level's statement, per focus (Bug MOTIR-5710 ·
   * MOTIR-5741). Given the crumb of the level the canvas is standing on, return what
   * to say when it is empty, or `null` for the canvas's own `emptyDrilled` copy.
   * The roadmap passes one for a FOLDER's level: "this node has no children" is
   * wrong for a place a person files work into. Content-agnostic — the canvas
   * never learns what a folder is. Absent ⇒ every drilled empty level reads as it
   * always has.
   */
  emptyDrilledFor?: (focus: { id: string; label: string }) => ReactNode | null;
  /**
   * Which crumbs are FOLDERS (Bug MOTIR-5710 · MOTIR-5742). A folder crumb is the
   * shipped `Crumb`, led by the folder glyph and named `Folder: <name>` to a
   * screen reader, and a run of more than three collapses from the middle with a
   * navigable `…`. The consumer answers, because only it knows what a crumb id
   * means — the canvas never learns what a folder is. Absent ⇒ no crumb is one.
   */
  isFolderCrumb?: (crumb: CanvasCrumb) => boolean;
  /**
   * Which crumb is the PLANNING TARGET (MOTIR-6160, Story MOTIR-6154).
   *
   * The planning surface opens INSIDE the node being planned, so the target is
   * no longer a node on the level — it is the level. MOTIR-2070 objected to
   * exactly this ("Opening on the anchor's CHILDREN would hide the item the
   * conversation is about"), and this is the answer: the target keeps a mark,
   * moved from the node ring to the crumb it became.
   *
   * Answered by the CONSUMER, for the same reason `isFolderCrumb` is — only the
   * consumer knows what a crumb id means. `PlanChangeCanvas` answers it from the
   * `targetIds` it already has, so a target that becomes known LATER marks its
   * crumb with no further wiring. Absent ⇒ no crumb is one, which is every other
   * consumer.
   */
  isTargetCrumb?: (crumb: CanvasCrumb) => boolean;
  /**
   * FOLLOW a target that became known AFTER the canvas opened (MOTIR-6161,
   * Story MOTIR-6154) — a keyed, one-shot REQUEST the canvas may DECLINE.
   *
   * `initialTrail` is a mount-time seed and is right about that: where the canvas
   * SITS is the user's. This is the narrow exception — a planning conversation
   * that started with no target and then settled one, where leaving the reader at
   * the root means the plan lands somewhere they are not looking.
   *
   * ⚠️ A REQUEST, NOT A CONTROLLED LEVEL, AND THE DIFFERENCE IS THE WHOLE DESIGN.
   * `controlledTrail` makes the CONSUMER the owner of every move: while it is
   * supplied the canvas adopts any value differing from where it is, so a
   * consumer that holds it at one level UNDOES the reader's own drill on the next
   * render. Measured while designing this (MOTIR-6159 § "What was RENDERED
   * first"): with a held `controlledTrail`, a drill was reverted within 150ms and
   * the breadcrumb disappeared. A request the canvas may decline keeps the
   * reader's navigation authoritative, which is the rule the story states.
   *
   * ⚠️ AND IT IS WHY THIS IS NOT `controlledTrail` HERE SPECIFICALLY.
   * `PlanChangeCanvas` — the one consumer that needs to follow — already passes
   * `resolveHeldNode`, because approving a plan re-keys every proposal. Those two
   * props are documented as not combinable, and the measured failure is not a
   * subtle one: with an id the resolver remaps, they fight over `focusId` until
   * React throws `Too many re-renders`. `followTo` writes once and then stops, so
   * it cannot enter that loop.
   *
   * THE CONTRACT of the default `followMode: 'once'`, and all three clauses are
   * load-bearing (`'whileOn'` drops the last two — see `followMode`):
   * - **Keyed.** A given `key` is honoured AT MOST ONCE, so a re-render with the
   *   same request is a no-op rather than a second move.
   * - **At most one move per mount.** A second target settling later does not
   *   move the canvas again — the reader has now seen where the plan is.
   * - **Never after the reader has navigated.** A crumb click, a drill, Back or a
   *   search jump makes every later request a decline. A deliberate navigation is
   *   not overridden, and the consumer is told so through `onFollowDeclined` so it
   *   can offer its own way there.
   */
  followTo?: {
    key: string;
    trail: readonly CanvasCrumb[];
    /**
     * `'whileOn'` only (MOTIR-8594; design Part XXVIII §28.7): what to say through
     * the canvas's own live region when this grant MOVES NOTHING — a host turning
     * following back on, while the canvas already stands where the planner is,
     * still owes the reader a word. A grant that moves announces where it went.
     */
    announce?: string;
    /**
     * `'whileOn'` only (MOTIR-8594; §28.7): a grant made for a PRESS hands focus to
     * the canvas once the requested level is the one drawn — after the move's
     * remount, never to the level it is leaving.
     */
    focus?: boolean;
  } | null;
  /**
   * HOW `followTo` IS HONOURED (MOTIR-8593, Story MOTIR-8590; design Part XXVIII).
   *
   * - **`'once'`** (the default, and every mount before this): the three clauses
   *   above, unchanged.
   * - **`'whileOn'`**: the CONSUMER owns whether following is on — it sends a
   *   request while on and `null` while off — so the canvas honours EVERY NEW KEY.
   *   Neither an earlier grant, nor the reader's own navigation, nor a seeded
   *   `readerHasNavigated` declines it, so nothing is ever declined and
   *   `onFollowDeclined` never fires. The same key on a re-render is still a no-op,
   *   and a new key naming the level already in view moves nothing — no fade, no
   *   announcement — so a driven step that stays on one level is silent. A grant
   *   that moves REPORTS the level through `onLevelChange` (in this mode only), so
   *   a host holding the trail stays true after a driven move; that is why a host
   *   must turn following off on `onReaderNavigated`, never on `onLevelChange`.
   */
  followMode?: 'once' | 'whileOn';
  /**
   * THE PERSON MOVED THE CANVAS (MOTIR-8593) — fired in both follow modes, once per
   * act, and ONLY for a move the person made: `'crumb'` (a crumb, the root crumb or
   * the ellipsis crumb), `'back'`, `'drill'` (an explicit Open — never the
   * auto-descend that follows it), `'search'` (a search-to-locate submit that finds
   * a card) and `'pick'` (taking the follow offer, or the arrivals / in-flight
   * *Go there*). Never for the canvas's own moves — a `followTo` grant, an
   * auto-descend, a `controlledTrail` adoption, a `resolveHeldNode` re-key — and
   * never for an act that leaves the level as it is: selecting a card, View, the
   * Locate control, pan, zoom, full screen, dragging or Reset layout.
   */
  onReaderNavigated?: (via: 'crumb' | 'back' | 'drill' | 'search' | 'pick') => void;
  /**
   * The canvas DECLINED a `followTo` because the reader had already navigated.
   *
   * The consumer needs this to draw the design's quiet affordance — *"Plan is in
   * {identifier} · Go there"* — because silence would strand the reader: the plan
   * is landing somewhere they are not looking and nothing says so. Fired once per
   * declined key, with that key.
   */
  onFollowDeclined?: (key: string) => void;
  /**
   * THE READER HAD ALREADY NAVIGATED — BEFORE THIS MOUNT (MOTIR-6155).
   *
   * `navigated` is per-mount state, and that is right for a canvas that lives as
   * long as its surface. The planning surface SWAPS the pane when a plan becomes
   * proposed (`PlanChangeCanvas` → the plan page's component), so a reader who had
   * drilled somewhere met a FRESH canvas with `navigated: false`, which granted the
   * follow and moved them off the level they chose — the one thing MOTIR-6161 ruled
   * must not happen. Seeding the flag carries that fact across the swap, so the new
   * canvas declines exactly as the old one would have and the bar offers the trip.
   *
   * It seeds MOUNT state only: the reader's own navigation still sets the flag, and
   * a later change of this prop does not clear it. A surface that never swaps its
   * canvas has no reason to pass it.
   */
  readerHasNavigated?: boolean;
  /**
   * ARRIVE ALREADY DRILLED (MOTIR-2070). The breadcrumb trail the canvas OPENS on,
   * root-ancestor first: the LAST crumb is the level it loads, and the whole array
   * becomes the breadcrumb. `[]` (the default) is the shipped behaviour — open at
   * the root — so every existing mount is untouched.
   *
   * The consumer supplies it because only the consumer knows the tree: the
   * planning workspace resolves its `?item=` anchor server-side and hands over
   * that anchor's ancestor chain, so the workspace opens on the level CONTAINING
   * the item it was summoned about instead of the project root, where the target
   * ring is drawn on a level nobody is looking at.
   *
   * Read ONCE, at mount — this is a seed, not a controlled level. Navigating the
   * canvas afterwards (drill / Back / a crumb click) is the user's, and a later
   * prop change must not yank them somewhere else. A caller that needs to re-seed
   * remounts on a `key`.
   */
  initialTrail?: readonly CanvasCrumb[];
  /**
   * REPORT the level (MOTIR-3835) — the other half of `initialTrail`.
   *
   * Fired whenever the canvas's OWN level moves, with the full trail root-first
   * (`[]` at the root level). There are exactly three movers and they funnel
   * through two functions: `applyDrill` — shared by the explicit "Open"
   * affordance AND the auto-descend, deliberately kept single — and `navigate`,
   * shared by a crumb click and `goBack`. So an AUTO-DESCENDED arrival
   * (MOTIR-1807) reports exactly like a hand-drilled one, which is the shipped
   * design position that an arrival must be indistinguishable from a drill.
   *
   * ⚠️ NOT fired for the mount-time `initialTrail` seed, and not fired when a
   * level LOAD resolves. The consumer supplied that trail; telling it what it
   * just said is a write loop waiting to happen.
   *
   * Absent by default. The two plan canvases forward it (MOTIR-6155), and of their
   * hosts only the planning surface supplies it; the rest leave it `undefined`.
   */
  onLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  /**
   * A CONTROLLED level (MOTIR-3835) — the consumer moving the canvas IN PLACE.
   *
   * `initialTrail` above is a SEED, read once, and it is right about that: where
   * the canvas SITS is the user's. This prop is the other half, and the two
   * COMPOSE — the seed decides where the canvas opens, this decides where it is
   * moved to afterwards. While it is supplied the level is the CONSUMER's, and
   * the canvas adopts any value that differs from where it currently is.
   * `undefined` (the default) leaves the canvas uncontrolled; `[]` names the
   * root level. Passing both, agreeing at mount, is the ordinary case: the
   * arrival costs no adoption, and every later move is one.
   *
   * Adoption happens DURING RENDER — React's adjust-state-when-an-input-changes
   * pattern, the same one `remappedFocus` and `prevTargetSig` use — never a
   * `useEffect` + `setState`, which the CI lint rule
   * (`react-hooks/set-state-in-effect`) forbids and which would render one frame
   * of the old level first. It clears exactly what a drill clears
   * (`localPositions` / `selectedId` / `highlightId` / `showChanges`) and lets
   * the existing load effect read the new level: **no remount**, so the
   * consumer's level cache, the canvas chrome and the breadcrumb machinery all
   * survive, which is the whole reason this is not a `key`.
   *
   * An adopted level SUPPRESSES auto-descend for that level, exactly as
   * `navigate` does: a consumer asking for a level is asking to SEE it, not to
   * be carried past it. Suppression is per ADOPTION, not per controlled-ness —
   * a controlled canvas arriving at a root it was not moved to still
   * auto-descends normally.
   *
   * ⚠️ Not combinable with `resolveHeldNode`: that follows an id the canvas
   * HOLDS, and this replaces it, so a consumer using both would have the two
   * fight over `focusId`. No shipped consumer passes both.
   */
  controlledTrail?: readonly CanvasCrumb[];
  /**
   * ARRIVE AT A READABLE SCALE (MOTIR-3837) — opt-in, OFF by default.
   *
   * The engine already resets the scale on every level change (this component
   * remounts it per level, so it auto-fits to the new level's overview); what is
   * wrong without this is WHAT it resets to. `fitView` is clamped only by the
   * absolute `MIN_SCALE = 0.3`, so a level that cannot fit legibly is drawn at
   * 0.3× rather than not fitted — and the project root, with every epic on it, is
   * the surface most people open first.
   *
   * Opted in, a level whose fit lands below `ARRIVAL_MIN_SCALE` arrives AT that
   * floor, centred on this level's FOCAL card. The focal ladder is the LOCATE
   * control's own — the `here` frontier, then the first `ready` node, then the
   * level's first non-`decorative` node — so where the canvas OPENS and where
   * LOCATE takes you cannot drift apart.
   *
   * OFF by default because this canvas is the foundation behind four consumers and
   * only the work-item roadmap asks for it.
   */
  arriveAtReadableScale?: boolean;
  /**
   * FOLLOW a node the consumer RE-KEYS under a mounted canvas (bug MOTIR-3439).
   *
   * The canvas HOLDS two things by node id — its drilled `focusId` and every
   * crumb — and holds them in mount-time state, which `initialTrail` above
   * explains and is right about: where the canvas SITS is the user's, and a
   * later prop must not move them. That contract is about NAVIGATION. This prop
   * is about IDENTITY, which is a different thing and was not covered.
   *
   * A consumer whose node ids change under a mounted canvas — the plan detail is
   * the one that does, because approving a plan re-keys every proposal to the
   * work item it became (`planReviewService`, MOTIR-3160) — otherwise leaves the
   * focus and the crumbs pointing at ids that name nothing: `loadLevel` resolves
   * an empty level and the reader gets `emptyDrilled` on the level they were
   * standing on. Given an id the canvas holds, return what that id is NOW
   * (`{ id, label }`), or `null` for "not mine — leave it alone".
   *
   * It RE-ADDRESSES the level the canvas is already on and never MOVES it, so a
   * user who navigated elsewhere before the re-keying stays exactly where they
   * are. That is what makes this the right shape rather than a remount on a
   * `key`, which would re-seed and yank them.
   *
   * ⚠️ MUST BE IDEMPOTENT: applied to the id it just returned, it must return
   * that same id (or `null`). The canvas re-runs it after adopting a new id, and
   * a resolver that keeps renaming would not settle.
   */
  resolveHeldNode?: (id: string) => CanvasCrumb | null;
  /**
   * A one-line CAPTION for the level in view — `design/ai-planning` Part IX §1.4,
   * the `lvlcap` slot its mock draws (bug MOTIR-3453).
   *
   * The consumer supplies it because only the consumer knows what is worth saying
   * about a level; the canvas knows it has nodes, not what KIND of nodes they
   * are. Absent by default, so the foundation's other consumers are unchanged.
   *
   * It is NOT an empty state. `emptyDrilled` speaks for a level with nothing on
   * it; this speaks ABOUT a level that has something on it — the case it was
   * drawn for is a level made entirely of proposals, which is correct, looks like
   * nothing else on this surface, and must not be read as a failed load.
   */
  levelCaption?: ReactNode;
  /**
   * MOTION — threaded to `PlanningCanvas`'s opt-in (MOTIR-6297, Part XXIII
   * §23.3–§23.5): a level whose nodes / edges change under a mounted canvas plays
   * the change instead of snapping to it, and a node's `changeKey` drives the
   * deepen cue. OFF by default and deliberately so: the roadmap, runs, work-item
   * roadmaps, onboarding and the plan page redraw on navigation, where motion
   * would animate a level change nobody asked to see. Only the planning surface's
   * live pane opts in (MOTIR-6300). A drill still remounts the canvas per level,
   * so arriving on a level plays nothing.
   */
  motion?: boolean;
  /**
   * THE ARRIVALS COUNT (MOTIR-6300; design Part XXIII §23.7) — the plan's cards as
   * the snapshot being drawn has them, while the plan is WRITTEN. A card that
   * arrives on a level other than the one being viewed is COUNTED in the
   * breadcrumb row, as a pill in the follow offer's own markup, and never jumped
   * to: taking the pill is the reader's own act. Visiting a level clears its
   * count. The first snapshot is the baseline and counts nothing.
   *
   * Absent (the default) on every other surface, which then renders exactly as
   * before. When it goes absent mid-mount (the plan stopped being written) the
   * count stops growing and what it already holds stays, because the hand-over
   * changes nothing but the bar (§23.13).
   */
  arrivals?: readonly LiveArrival[] | null;
  /**
   * THE LEVEL CHANGE BAND (bug MOTIR-6223; design MOTIR-6241) — what a pending
   * plan does to the LEVEL in view, drawn as a SECOND ROW inside the breadcrumb
   * bar. Asked of the drilled level only (the root has no bar, and the project is
   * not a work item a plan can change); `null` draws nothing, and then the bar is
   * byte for byte the one that shipped before.
   *
   * The foundation owns the SLOT, the consumer the words: only the consumer knows
   * there is a plan, exactly as with `levelCaption`. Absent by default.
   */
  levelBand?: (focus: { id: string; label: string }) => ReactNode;
  /**
   * THE DRAFTING / LAYING CUES (MOTIR-7830; design Part XXVI §26.6) — threaded to
   * `PlanningCanvas` as given. Read whether or not `motion` is on (the plan page
   * draws them with motion off). Absent by default.
   */
  nodeCues?: ReadonlyMap<string, NodeCue> | null;
  /**
   * THE FOLLOW CONTROL (MOTIR-8594; design Part XXVIII §28.3, Table A) — drawn as
   * the RIGHTMOST member of the bar's trips group (`canvas-bar-trips`), after the
   * shipped offer / pill, so it never jumps when the pill comes and goes. Supplying
   * it also shows the bar at the root. Absent, the bar is byte for byte as shipped.
   */
  followControl?: ReactNode;
  /**
   * THE TRIP RULE's follow destination (§28.3): the level *Follow the planner*
   * goes to — a focus id, or `null` for the top level. The arrivals / in-flight
   * pill is HIDDEN while its *Go there* would land there (its count keeps counting
   * underneath), so no row offers two controls to one place. `undefined` (the
   * default) applies no rule.
   */
  followLevelId?: string | null;
  /**
   * The cues IN FLIGHT, with where each one is (MOTIR-7830; §26.7). An entry is
   * OFF-LEVEL when its node is not on the drawn level and it is not a `laying`
   * cue on the level the reader stands in; off-level entries are counted in the
   * arrivals pill's ONE slot, in the design's in-flight wording, and *Go there*
   * drills by the earliest one's `trail` when there are no arrivals. The canvas
   * never moves on its own. A PRESENT STATE: counted from this prop each render,
   * never folded into the arrivals log. Unlike `arrivals`, read whether or not
   * `motion` is on. Absent → the pill renders exactly as before.
   */
  inFlight?: readonly InFlightCue[] | null;
  /**
   * The plan is SOMEWHERE ELSE (bug MOTIR-6223, second half; design MOTIR-6241 §
   * *BESIDE the anchor*) — a second ARMING of the declined-follow offer, whose
   * copy, markup, placement and behaviour are unchanged: *"Plan is in
   * {identifier} · Go there"* is already true when the plan places nothing on the
   * reader's level and something on another. Asked with the current trail; a
   * DECLINED follow wins the slot when both are up. Absent by default.
   */
  elsewhereOffer?: (
    trail: readonly CanvasCrumb[],
  ) => { key: string; trail: readonly CanvasCrumb[] } | null;
}

/**
 * SEARCH — opt-in, and turning it on REQUIRES saying what it SEARCHES
 * (MOTIR-4021, design Part XIII §5).
 *
 * The label is the CONSUMER's word, on both the `aria-label` and the
 * placeholder. It is a REQUIRING PAIR rather than an optional prop with a
 * default, and the difference is the whole card: this canvas has four searchable
 * mounts and exactly ONE of them is the roadmap, so a default of
 * `roadmap.canvas.search` is how *"Search the roadmap"* came to greet a reader on
 * `/plans/[id]`, on the plan-change canvas and in onboarding. A default cannot be
 * wrong loudly; a required field cannot be forgotten.
 *
 * The non-searchable arm forbids the label outright, so a mount that turns search
 * OFF cannot carry a dead string (the item page's Children panel is that mount,
 * deliberately — a `/` overlay inside an embedded panel is a page-level key grab).
 */
type ProjectRoadmapCanvasSearchProps =
  | { searchable: true; searchLabel: string }
  | { searchable?: false | undefined; searchLabel?: undefined };

export type ProjectRoadmapCanvasProps = ProjectRoadmapCanvasBaseProps &
  ProjectRoadmapCanvasSearchProps;

// The suppression ref (below) is keyed by LEVEL; the root level has no id.
const ROOT_LEVEL_KEY = '__root__';
const levelKey = (id: string | null) => id ?? ROOT_LEVEL_KEY;

interface Crumb {
  id: string;
  label: string;
  /** The work item's `<PREFIX>-<n>` key, when the node carried one (MOTIR-3835).
   *  Keeps this local shape assignable to the model's `CanvasCrumb`. */
  crumbKey?: string;
}

// The readable default zoom the LOCATE control snaps to (MOTIR-1421) — 1× shows a
// node at its natural authored card size, comfortably legible regardless of how far
// the user had zoomed out/in.
const LOCATE_ZOOM = 1;

// THE LIVE SLOT'S PILL — the follow offer and the arrivals count share one markup
// (§23.7). Below a 32rem BAR it yields first (MOTIR-8646): the label goes
// `sr-only` and the pill becomes a `--height-control` square showing only its
// dot, named by `aria-label` + `title` — the compact form Part XXVIII gives the
// follow control, so the crumbs keep the room to name the level. Unshrunk, the
// pill kept its full width at the narrowest split (384px pane) and crushed the
// crumb trail to one letter. The bar `nav` is the `canvas-bar` container;
// `tripPush` adds the `ml-auto` when the pill stands alone.
const SLOT_PILL_CLASS =
  'inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) @max-[32rem]/canvas-bar:size-(--height-control) @max-[32rem]/canvas-bar:justify-center @max-[32rem]/canvas-bar:p-0';
const SLOT_PILL_LABEL_CLASS = '@max-[32rem]/canvas-bar:sr-only';

export function ProjectRoadmapCanvas({
  loadLevel,
  reloadKey,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  onView,
  targetAction,
  searchable = false,
  searchLabel,
  fullScreenable = false,
  emphasis,
  locatable = false,
  rootLabel,
  ariaLabel,
  warningLegend,
  autoDescendSingleParent = false,
  loadingFallback,
  emptyRoot,
  emptyDrilledFor,
  isFolderCrumb,
  isTargetCrumb,
  followTo = null,
  followMode = 'once',
  onFollowDeclined,
  onReaderNavigated,
  readerHasNavigated = false,
  initialTrail,
  onLevelChange,
  controlledTrail,
  arriveAtReadableScale = false,
  resolveHeldNode,
  levelCaption,
  motion = false,
  arrivals = null,
  levelBand,
  nodeCues = null,
  followControl,
  followLevelId,
  inFlight = null,
  elsewhereOffer,
}: ProjectRoadmapCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const tTargets = useTranslations('planningWorkspace.targets');
  const tFolders = useTranslations('folders');
  const tTarget = useTranslations('planningWorkspace.arrival');
  // The breadcrumb root, the canvas aria label, and the WARNING legend row default
  // to the localized project-scope copy; a caller (e.g. the sprint-scoped roadmap)
  // overrides the warning row with its own "blocker not in sprint" copy (MOTIR-1379,
  // reworded MOTIR-1582 to name the blocker, not the card).
  const resolvedRootLabel = rootLabel ?? t('breadcrumbRoot');
  const resolvedAriaLabel = ariaLabel ?? t('ariaDefault');
  const resolvedWarningLegend = warningLegend ?? {
    label: t('legend.blockedElsewhere'),
    meaning: t('legend.blockedElsewhereMeaning'),
  };
  // The ARRIVAL level (MOTIR-2070). A seeded trail's LAST crumb is the level the
  // canvas opens on; an absent / empty trail is the shipped root arrival. Both are
  // lazy initial state — read once at mount, never re-synced from the prop, so the
  // seed cannot fight the navigation the user does afterwards.
  const [focusId, setFocusId] = useState<string | null>(
    () => initialTrail?.[initialTrail.length - 1]?.id ?? null,
  );
  const [crumbs, setCrumbs] = useState<Crumb[]>(() => [...(initialTrail ?? [])]);
  // The level, TOGETHER WITH the focus it was loaded for (MOTIR-3837).
  //
  // ⚠️ THE TWO CANNOT BE SEPARATE, and separating them is a real bug rather than
  // untidiness. `focusId` moves the INSTANT a drill happens, while the level's
  // data arrives one round trip later — deliberately, so the prior level stays
  // visible instead of flashing. The engine below is remounted per level, and it
  // FITS ONCE on mount: keyed on `focusId`, the new instance mounts during that
  // window, sees the PREVIOUS level's nodes, fits THOSE, and marks itself
  // fitted — so the level the reader actually lands on is drawn at the scale of
  // the one they left. Keying on the focus the LEVEL belongs to closes the
  // window: the engine remounts exactly when the data it will fit has arrived,
  // and the prior level stays on screen until then, unchanged.
  const [level, setLevel] = useState<{ focusId: string | null; data: RoadmapLevel } | null>(null);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // SHOW CHANGES (MOTIR-3261) — a MODE, opt-in. It RESETS on every level change
  // alongside `selectedId` / `highlightId`, so a stale emphasis never survives a
  // drill or a Back.
  //
  // ⚠️ ARMED ON ARRIVAL (MOTIR-4020, Part XIII §3). What changed is the reset's
  // TARGET, not the reset: this is now an OVERRIDE over a per-level default
  // rather than a flag, so clearing it on a level change re-arms rather than
  // disarms. A reader who turns the emphasis off and then drills arrives armed
  // again, because the reset is per LEVEL and a drill is a new question about a
  // new set of cards — the same argument §L4 makes one tier down, where a
  // momentary SELECTION does not end the mode.
  const [showChangesOverride, setShowChangesOverride] = useState<boolean | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  // The ZOOM the next focus pan should land at: `undefined` preserves the current
  // scale (the search-locate's pan-only behaviour); `LOCATE_ZOOM` resets to a readable
  // default so a node found while zoomed far out/in lands at a comfortable card size
  // (the locate control, MOTIR-1421).
  const [focusScale, setFocusScale] = useState<number | undefined>(undefined);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(
    {},
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // FULL-SCREEN (MOTIR-1420). `expanded` is the authoritative state and drives a
  // fixed full-viewport overlay — deterministic everywhere (and what the E2E
  // asserts). On top of that we BEST-EFFORT call the browser Fullscreen API so the
  // OS chrome hides too; if it rejects (e.g. headless / no user-gesture trust) the
  // overlay still fills the viewport, so the feature degrades cleanly.
  const [expanded, setExpanded] = useState(false);
  // The dependency-legend collapse (MOTIR-3838) — a per-VIEWER preference, shared
  // by every canvas that draws the legend and persisted on the shell's own
  // localStorage recipe. Not opt-in: the legend is this canvas's own chrome, and
  // giving two consumers a legend you can dismiss and two you cannot is a
  // distinction no reader could infer.
  const [legendCollapsed, toggleLegendCollapsed] = useDependencyLegendCollapsed();
  // A per-instance id, so `aria-controls` is unique when two canvases coexist.
  const legendRowsId = `${useId().replace(/:/g, '')}-legend-rows`;
  const reqSeq = useRef(0);
  // AUTO-DESCEND suppression (MOTIR-1807; design `auto-drill.*` panel F). `navigate()`
  // and `goBack()` are the user EXPLICITLY asking to see a level — if auto-descend then
  // fired again they'd be thrown straight back down and the breadcrumb root would be
  // unclickable. So remember WHICH level they climbed to and never descend out of it.
  // Keyed by level rather than a bare boolean so it SURVIVES A MANUAL REFRESH: the
  // refresh signal (MOTIR-1542) re-runs the load for that same level, and re-descending
  // would make Refresh feel like it lost the user's place. An explicit `handleDrill`
  // clears it (a deliberate drill RE-ARMS the behaviour, so a chain below still
  // compacts). A SCOPE switch re-arms by construction — `RoadmapView` remounts this
  // canvas on `key={scope}`, a fresh arrival with fresh refs.
  // A SEEDED arrival (`initialTrail`, MOTIR-2070) counts as that explicit ask: the
  // consumer aimed the canvas at this level because the thing the user is here for
  // lives ON it, so auto-descend must not immediately carry them past it.
  const suppressedLevelRef = useRef<string | null>(
    initialTrail && initialTrail.length > 0
      ? levelKey(initialTrail[initialTrail.length - 1]?.id ?? null)
      : null,
  );
  // The ids already on the crumb stack — the auto-descend's CYCLE GUARD. `loadLevel`
  // is consumer-supplied I/O, so a level that (wrongly) resolves to a node already in
  // our own descent path would otherwise descend forever, hanging the canvas rather
  // than failing visibly. Never descend into an ancestor; render the level instead.
  const crumbIdsRef = useRef<Set<string>>(new Set());
  // The crumbs themselves, for the level REPORTERS (MOTIR-3835) — see the sync
  // effect below for why a ref rather than a dependency.
  const crumbsRef = useRef<Crumb[]>(crumbs);

  // ── FOLLOW a RE-KEYED node (bug MOTIR-3439) ─────────────────────────────────
  //
  // The `resolveHeldNode` contract, applied. It runs DURING RENDER — React's
  // adjust-state-when-an-input-changes pattern, the same one `prevTargetSig`
  // below uses — rather than in a `useEffect`, which the CI lint rule
  // (`react-hooks/set-state-in-effect`) forbids and which would render one frame
  // of the dead level first anyway.
  //
  // Only the ADDRESS changes: the level the canvas is on, the depth of the
  // crumb stack and the user's place in it are all untouched, so this cannot
  // move anybody. The load effect fires on the new `focusId` and reads the level
  // the node became.
  const remappedFocus = focusId !== null ? (resolveHeldNode?.(focusId) ?? null) : null;
  if (remappedFocus !== null && remappedFocus.id !== focusId) setFocusId(remappedFocus.id);
  const remappedCrumbs = resolveHeldNode
    ? crumbs.map((crumb) => {
        const next = resolveHeldNode(crumb.id);
        return next && (next.id !== crumb.id || next.label !== crumb.label) ? next : crumb;
      })
    : crumbs;
  if (remappedCrumbs.some((crumb, i) => crumb !== crumbs[i])) setCrumbs(remappedCrumbs);

  // ── ADOPT a CONTROLLED level (MOTIR-3835) ───────────────────────────────────
  //
  // The mirror of `remappedFocus` directly above, and the same mechanism: an
  // adjust-state-during-render, never a `useEffect` + `setState`. The difference is
  // what each one is FOR — the remap changes a level's ADDRESS, this MOVES the
  // canvas — and this one is idempotent by construction: once the state settles,
  // `controlledFocusId === focusId` and the branch stops firing, so a re-render with
  // an unchanged value is a true no-op and cannot loop.
  const controlledFocusId =
    controlledTrail === undefined
      ? undefined
      : (controlledTrail[controlledTrail.length - 1]?.id ?? null);
  // The adoption EVENT, as state rather than a ref, because a ref may not be written
  // during render. Its object identity is what re-arms the suppression effect below,
  // so adopting the same level twice (drilled away, then restored) suppresses twice.
  const [adoption, setAdoption] = useState<{ level: string | null } | null>(null);

  const onFollowDeclinedRef = useRef(onFollowDeclined);
  useEffect(() => {
    onFollowDeclinedRef.current = onFollowDeclined;
  }, [onFollowDeclined]);
  // Same pattern for the person-navigation report (MOTIR-8593): the movers are
  // `useCallback`s that must stay stable, and each calls this from the mover
  // itself, outside any state updater, so StrictMode cannot double it.
  const onReaderNavigatedRef = useRef(onReaderNavigated);
  useEffect(() => {
    onReaderNavigatedRef.current = onReaderNavigated;
  }, [onReaderNavigated]);
  // For `onLevelChange` (MOTIR-3835): the reporters are `useCallback`s with empty
  // deps, and a consumer's handler is commonly recreated every render. Declared
  // here, above the follow block, because a `'whileOn'` grant reports through it.
  const onLevelChangeRef = useRef(onLevelChange);
  useEffect(() => {
    onLevelChangeRef.current = onLevelChange;
  }, [onLevelChange]);

  // ── FOLLOW a newly settled target (MOTIR-6161) ──────────────────────────────
  //
  // ⚠️ EVERY DECISION HERE IS MADE DURING RENDER, and none of it in an effect.
  // That is the same adjust-state-when-an-input-changes shape `remappedFocus` and
  // the adoption above use, and for the same two reasons the CI lint rules state
  // outright: `react-hooks/set-state-in-effect` forbids a synchronous `setState`
  // in an effect body, and `react-hooks/refs` forbids reading a ref during render.
  // So what the grant has to KNOW — has the reader navigated, have we already
  // moved — is STATE, and what it has to WRITE afterwards is the only thing left
  // to an effect.
  //
  // The reader's own navigation is recorded by the two movers themselves
  // (`applyDrill` and `navigate`, which the crumbs and `goBack` funnel through)
  // rather than inferred from the level, because an auto-descend moves the level
  // too and it is not the reader.
  // ⚠️ SEEDED, not merely initialised false (MOTIR-6155). A surface that swaps its
  // canvas mid-session — the planning surface, when a plan becomes proposed — hands
  // the fact forward through `readerHasNavigated`, so a reader who had drilled is
  // not moved by the fresh mount's first `followTo`. Mount-only by construction:
  // `useState`'s argument is read once, which is exactly the semantics wanted.
  const [navigated, setNavigated] = useState(readerHasNavigated);
  // The request last SEEN. It is held for a DECLINED key as well, which is what
  // makes "honoured at most once" true of a decline too — a re-render cannot
  // retry a request the reader already outran. `everGranted` is the separate
  // "at most one move per mount" clause: a SECOND target settling later does not
  // move the canvas again.
  //
  // ⚠️ It carries the LEVEL it granted, not just the key. Reading `crumbsRef` in
  // the effect below looked equivalent and is not: that ref is synced by its own
  // `useEffect`, which has not necessarily run when this one fires, so the
  // announcement named the ROOT instead of the level it had just moved to.
  const [followEvent, setFollowEvent] = useState<{
    key: string;
    granted: boolean;
    everGranted: boolean;
    levelId: string | null;
    /** `'whileOn'` only: the trail a grant MOVED to, reported through
     *  `onLevelChange`; `null` when the grant moved nothing. */
    reportTrail?: CanvasCrumb[] | null;
  } | null>(null);
  // The request the canvas DECLINED, kept so the breadcrumb bar can offer it.
  // Held HERE rather than by the consumer because the design puts the affordance
  // inside the bar, and because taking it is an explicit reader act — the one
  // thing that may move a reader who has navigated.
  const [declined, setDeclined] = useState<{ key: string; trail: readonly CanvasCrumb[] } | null>(
    null,
  );
  const [followFade, setFollowFade] = useState(false);
  // A DRIVEN arrival withholds the cue's pop until the crossfade has ended
  // (MOTIR-8594; design Part XXVIII §28.4): the move animates the level's opacity,
  // the pop the node box, and the two never overlap.
  const [cueHeld, setCueHeld] = useState(false);
  const [followAnnouncement, setFollowAnnouncement] = useState<string | null>(null);
  const [followFocus, setFollowFocus] = useState<{ key: string; levelId: string | null } | null>(
    null,
  );
  if (followTo !== null && followTo.key !== followEvent?.key && followMode === 'whileOn') {
    // THE WHILE-ON ARM (MOTIR-8593) — every new key is granted. A request naming
    // the level already in view is granted and moves nothing, so a driven step
    // that stays on one level neither fades nor announces.
    const last = followTo.trail[followTo.trail.length - 1] ?? null;
    const levelId = last?.id ?? null;
    const moves = levelId !== focusId;
    if (followTo.focus) setFollowFocus({ key: followTo.key, levelId });
    setFollowEvent({
      key: followTo.key,
      granted: true,
      everGranted: true,
      levelId,
      reportTrail: moves ? [...followTo.trail] : null,
    });
    if (moves) {
      setCueHeld(true);
      setFocusId(levelId);
      setCrumbs([...followTo.trail]);
      setLocalPositions({});
      setSelectedId(null);
      setHighlightId(null);
      setShowChangesOverride(null);
      setFollowFade(true);
      setFollowAnnouncement(
        tTarget('movedAnnouncement', { target: last?.label ?? resolvedRootLabel }),
      );
    } else if (followTo.announce) {
      setFollowAnnouncement(followTo.announce);
    }
  } else if (followTo !== null && followTo.key !== followEvent?.key) {
    const everGranted = followEvent?.everGranted ?? false;
    const grant = !navigated && !everGranted;
    const last = followTo.trail[followTo.trail.length - 1] ?? null;
    setFollowEvent({
      key: followTo.key,
      granted: grant,
      everGranted: everGranted || grant,
      levelId: last?.id ?? null,
    });
    if (grant) {
      setFocusId(last?.id ?? null);
      setCrumbs([...followTo.trail]);
      // Exactly what a drill / a `navigate` clears — a followed level is a level
      // change, so nothing per-level may survive it.
      setLocalPositions({});
      setSelectedId(null);
      setHighlightId(null);
      setShowChangesOverride(null);
      // THE MOVE'S TWO VISIBLE HALVES (the design's arrival section). The
      // TRANSITION is a 180ms opacity fade on the level, in the canvas's own
      // vocabulary — `transition-opacity motion-reduce:transition-none`, the same
      // idiom the emphasis layer uses — so reduced motion makes the move INSTANT
      // declaratively, with no media query to keep in step with it.
      setFollowFade(true);
      // …and the ANNOUNCEMENT, because a canvas that moves under a reader who was
      // not watching it has told them nothing. Polite, once, naming where it went.
      setFollowAnnouncement(
        tTarget('movedAnnouncement', { target: last?.label ?? resolvedRootLabel }),
      );
    } else {
      setDeclined(followTo);
    }
  }
  // What is LEFT to an effect: a ref write and a consumer callback, neither of
  // which may happen during render.
  useEffect(() => {
    if (followEvent === null) return;
    if (followEvent.granted) {
      // A followed level is one the consumer asked the reader to SEE, so it must
      // not be auto-descended past — the same rule `navigate` applies.
      suppressedLevelRef.current = levelKey(followEvent.levelId);
      if (followEvent.reportTrail) onLevelChangeRef.current?.(followEvent.reportTrail);
    } else {
      onFollowDeclinedRef.current?.(followEvent.key);
    }
  }, [followEvent]);

  // ── THE ARRIVALS COUNT (MOTIR-6300; design Part XXIII §23.7) ──────────────
  // Folded DURING render, the same adjust-state-when-an-input-changes shape the
  // follow above uses: each new snapshot is diffed against the last one by card id,
  // and a change of the level the reader stands on clears that level's count. The
  // canvas never moves for an arrival — the pill below is the only way there.
  const [arrivalLog, setArrivalLog] = useState<ArrivalsLog>(() => ({
    ...EMPTY_ARRIVALS,
    viewing: focusId,
  }));
  {
    let nextLog = arrivalLog;
    if (arrivals !== null && arrivals !== nextLog.source) {
      nextLog = foldArrivals(nextLog, arrivals, focusId);
    }
    if (nextLog.viewing !== focusId) nextLog = visitLevel(nextLog, focusId);
    if (nextLog !== arrivalLog) setArrivalLog(nextLog);
  }
  const arrivalsPill = arrivalsSummary(arrivalLog.pending);

  // Release the fade once the followed level has painted, so it transitions IN
  // rather than appearing already faded. A frame, not a timer: the class does the
  // easing and this only flips the endpoint.
  // The release's BACKSTOP: under reduced motion (or with no transition at all)
  // no `transitionend` arrives, so the hold also ends after the crossfade's own
  // duration plus a margin. A timer callback, not a synchronous effect setState.
  useEffect(() => {
    if (!cueHeld) return;
    const id = setTimeout(() => setCueHeld(false), 300);
    return () => clearTimeout(id);
  }, [cueHeld]);
  // A press's focus lands once the requested level is the one DRAWN: the level
  // remounts per focus (`key={level:…}`), so focusing earlier would hand focus to
  // an element about to unmount.
  const focusedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (followFocus === null || focusedForRef.current === followFocus.key) return;
    if ((level?.focusId ?? null) !== followFocus.levelId) return;
    const canvas = rootRef.current?.querySelector<HTMLElement>('[role="application"]');
    if (!canvas) return;
    focusedForRef.current = followFocus.key;
    canvas.focus();
  }, [followFocus, level]);
  const shownCues = useMemo(() => {
    if (!cueHeld || !nodeCues) return nodeCues;
    const still = new Map<string, NodeCue>();
    for (const [id, cue] of nodeCues) still.set(id, { ...cue, moving: false });
    return still;
  }, [cueHeld, nodeCues]);
  useEffect(() => {
    if (!followFade) return;
    const id = requestAnimationFrame(() => setFollowFade(false));
    return () => cancelAnimationFrame(id);
  }, [followFade]);
  if (controlledFocusId !== undefined && controlledFocusId !== focusId) {
    setFocusId(controlledFocusId);
    setCrumbs([...(controlledTrail ?? [])]);
    // Exactly what a drill / a `navigate` clears — an adopted level is a level
    // change, so nothing per-level may survive it.
    setLocalPositions({});
    setSelectedId(null);
    setHighlightId(null);
    setShowChangesOverride(null);
    setAdoption({ level: controlledFocusId });
  }
  // Record the suppression OUTSIDE render. Auto-descend must not carry the reader
  // out of a level the consumer explicitly asked for — the same rule `navigate`
  // applies for a crumb click, and the same `suppressedLevelRef` it writes.
  useEffect(() => {
    if (adoption !== null) suppressedLevelRef.current = levelKey(adoption.level);
  }, [adoption]);

  // The opt-in flag, held in a ref so the load effect stays keyed strictly on level
  // identity (`focusId` / `reloadKey`) — toggling the prop must not refetch a level.
  const autoDescendRef = useRef(autoDescendSingleParent);
  useEffect(() => {
    autoDescendRef.current = autoDescendSingleParent;
  }, [autoDescendSingleParent]);

  const enterFullScreen = useCallback(() => {
    setExpanded(true);
    const el = rootRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
  }, []);
  const exitFullScreen = useCallback(() => {
    setExpanded(false);
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // ESC exits. Native fullscreen also handles ESC itself (caught by the
  // `fullscreenchange` sync below), but this covers the overlay-only path where the
  // Fullscreen API isn't active, so ESC always exits regardless.
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // An overlay open over the canvas (the quick view, a menu) already took this
      // Esc to close itself — Radix marks it handled — so it must not ALSO leave
      // full screen (MOTIR-7658).
      if (e.defaultPrevented) return;
      e.preventDefault();
      exitFullScreen();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, exitFullScreen]);

  // Sync state when the user leaves native fullscreen by any route (the OS ESC, the
  // browser's own exit affordance) so the button + overlay collapse with it.
  useEffect(() => {
    function onFsChange() {
      if (typeof document !== 'undefined' && !document.fullscreenElement) {
        setExpanded(false);
      }
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  // Hold the latest loadLevel so the load effect refetches on focus / reloadKey —
  // NOT on the fetcher's identity (a consumer's loadLevel may be recreated each
  // render; `reloadKey` is the explicit "the data changed" signal).
  const loadLevelRef = useRef(loadLevel);
  useEffect(() => {
    loadLevelRef.current = loadLevel;
  }, [loadLevel]);
  // Same reason, for the auto-descend suppression's level comparison below.
  const resolveHeldNodeRef = useRef(resolveHeldNode);
  useEffect(() => {
    resolveHeldNodeRef.current = resolveHeldNode;
  }, [resolveHeldNode]);
  // Mirror the crumb ids for the auto-descend's cycle guard (a ref, so the load
  // effect can read the current path without re-running on every crumb change).
  // `crumbsRef` mirrors the crumbs THEMSELVES for the same reason (MOTIR-3835):
  // `applyDrill` and `navigate` must report the trail they are producing, and they
  // hold no `crumbs` dependency by design — the functional `setCrumbs` updater is
  // what keeps them stable, and calling a consumer's callback from inside an updater
  // would fire it twice under StrictMode.
  useEffect(() => {
    crumbIdsRef.current = new Set(crumbs.map((c) => c.id));
    crumbsRef.current = crumbs;
  }, [crumbs]);

  // `/` focuses the search field (unless already typing into one).
  useEffect(() => {
    if (!searchable) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchable]);

  // THE drill transition — the ONE place a descent happens, shared by the explicit
  // "Open" affordance (`handleDrill`) and the auto-descend below. Keeping it single is
  // the point: a second drill path that drifts from the first is exactly how the
  // breadcrumb and the saved positions get out of sync, and it is what makes an
  // auto-arrival indistinguishable from a hand-drilled view (design panel C) — Back,
  // the breadcrumb, search, locate, zoom and full-screen all keep working with no
  // special case.
  const applyDrill = useCallback((node: ProjectCanvasNode) => {
    // The reader moved (MOTIR-6161) — every later `followTo` is declined. An
    // AUTO-DESCEND funnels through here too and is deliberately counted: it moves
    // the reader somewhere they did not ask for, so following them afterwards
    // would compound a move they never made.
    setNavigated(true);
    const crumb: Crumb = {
      id: node.id,
      label: node.crumbLabel ?? node.searchText,
      ...(node.crumbKey === undefined ? {} : { crumbKey: node.crumbKey }),
    };
    setCrumbs((c) => [...c, crumb]);
    setLocalPositions({});
    setSelectedId(null);
    setFocusId(node.id);
    setHighlightId(null);
    setShowChangesOverride(null);
    // REPORT the new level (MOTIR-3835). Computed from the crumbs ref rather than
    // inside the updater above: an updater may run twice (StrictMode), and a
    // consumer's callback is not something to fire twice. Because this is the ONE
    // drill transition, an auto-descended arrival reports identically to a
    // hand-drilled one — including each hop of a chained descent, which is what
    // makes the final report name the level actually landed on.
    onLevelChangeRef.current?.([...crumbsRef.current, crumb]);
  }, []);

  // Fetch the current level. The PRIOR level stays visible during a refetch (no
  // flicker); a stale response (an out-of-order resolve) is discarded by sequence.
  useEffect(() => {
    const seq = ++reqSeq.current;
    let alive = true;
    void (async () => {
      try {
        const lvl = await loadLevelRef.current(focusId);
        // The out-of-order guard stays authoritative: a superseded response neither
        // renders NOR descends.
        if (!alive || seq !== reqSeq.current) return;
        // AUTO-DESCEND (MOTIR-1807) — a level of exactly ONE drillable node offers no
        // choice, so descend into it instead of rendering it. Deliberately does NOT
        // publish the skipped level first: `setLevel(lvl)` here would flash a card the
        // user never gets to act on. Leaving `level` untouched keeps the spinner (first
        // paint) or the previous level (a refetch) up until the level we actually LAND
        // on resolves — which is what makes a chained epic → story → subtasks descent
        // read as ONE arrival. The state change happens in this async CONTINUATION,
        // never as a synchronous setState in the effect body (the CI lint rule).
        //
        // The count is over the level's WORK, not its node array (MOTIR-1824): a
        // `decorative` node — the planning-origin cluster an ONBOARDED project pins
        // at its root level — is provenance drawn beside the road, not a branch in
        // it. Counting it made every onboarded project's root level two nodes, so
        // this feature silently never fired for them; the design's own rule for the
        // negative case is "there is a real branch; the choice is the user's"
        // (`auto-drill.mock.html` panel E), and a pinned annotation is neither.
        const choices = lvl.nodes.filter((n) => n.decorative !== true);
        const only = choices.length === 1 ? choices[0] : undefined;
        // The suppressed level is compared through `resolveHeldNode` as well: it
        // is keyed by LEVEL, and a re-keyed level is the SAME level under a new
        // address (bug MOTIR-3439), so a canvas that was told to stay put must
        // not descend out of it just because its id moved. Resolved HERE, at read
        // time, rather than rewritten when the focus is adopted — a ref may not
        // be touched during render.
        const suppressed = suppressedLevelRef.current;
        const suppressedNow =
          suppressed === null ? null : (resolveHeldNodeRef.current?.(suppressed)?.id ?? suppressed);
        if (
          autoDescendRef.current &&
          only?.drillable === true &&
          suppressedNow !== levelKey(focusId) &&
          !crumbIdsRef.current.has(only.id) // never descend back into an ancestor
        ) {
          applyDrill(only);
          return;
        }
        setLevel({ focusId, data: lvl });
      } catch {
        if (alive && seq === reqSeq.current) setLevel({ focusId, data: { nodes: [], deps: [] } });
      }
    })();
    return () => {
      alive = false;
    };
  }, [focusId, reloadKey, applyDrill]);

  const nodes = useMemo(() => level?.data.nodes ?? [], [level]);
  // ── AN EMPTY LEVEL FILLING IN FRONT OF THE READER (MOTIR-6300) ─────────────
  // With `motion` on, an empty level renders the empty statement, not the engine,
  // so the first cards to land would MOUNT the engine and draw settled — the one
  // case a live plan most often starts from (a brand-new story's children). So the
  // level that was seen EMPTY is remembered, and when that same level fills, the
  // engine mounts with `animateInitial`: its first snapshot plays as arrivals.
  // Opening on a populated level, or arriving on one by navigation, still plays
  // nothing — the mark is cleared the moment a different, populated level draws.
  const shownLevelKey = level === null ? null : levelKey(level.focusId);
  const [emptySeenAt, setEmptySeenAt] = useState<string | null>(null);
  if (motion && shownLevelKey !== null) {
    if (nodes.length === 0) {
      if (emptySeenAt !== shownLevelKey) setEmptySeenAt(shownLevelKey);
    } else if (emptySeenAt !== null && emptySeenAt !== shownLevelKey) {
      setEmptySeenAt(null);
    }
  }
  const animateInitial = motion && shownLevelKey !== null && emptySeenAt === shownLevelKey;
  const deps = useMemo(() => level?.data.deps ?? [], [level]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // ⚠️ AN EXITING NODE STILL NEEDS ITS CARD (bug MOTIR-6345). With `motion` on, the
  // engine RETAINS a node that has left the level for its exit animation and still
  // asks `renderNode` to draw it — but the id is no longer in `byId`, so the box
  // faded out EMPTY and the card simply vanished (Part XXIII §23.3 says the CARD
  // leaves). So the last card drawn for each id is kept here and read only for an
  // id the current level no longer holds. It is written in an effect, so on the
  // render where a node leaves it still holds that node. With `motion` off nothing
  // reads it, and the output is unchanged.
  const lastDrawnRef = useRef(new Map<string, (typeof nodes)[number]>());
  useEffect(() => {
    if (!motion) return;
    for (const n of nodes) lastDrawnRef.current.set(n.id, n);
  }, [motion, nodes]);
  const matchIds = useMemo(() => new Set(searchMatches(nodes, query)), [nodes, query]);

  // The emphasised ids that are actually ON this level. The consumer hands over
  // the whole plan's ids; the canvas is per-level, so the intersection is what it
  // can light — and its SIZE against `emphasis.total` is what the control says.
  const emphasisedIds = useMemo(() => {
    if (!emphasis) return new Set<string>();
    const onLevel = new Set(nodes.map((n) => n.id));
    return new Set(emphasis.ids.filter((id) => onLevel.has(id)));
  }, [emphasis, nodes]);

  // ⚠️ WHETHER THE EMPHASIS CAN SAY ANYTHING ON THIS LEVEL (MOTIR-4020, Part XIII
  // §3d). The ring means *this one and not that one*, so it needs both halves: at
  // least one of the plan's cards, AND at least one that is not. A level with
  // neither is a screen that says nothing — and, armed on arrival, one that says
  // nothing WITHOUT anybody having asked it to.
  const emphasisArmable = emphasisedIds.size > 0 && emphasisedIds.size < nodes.length;
  // The override is per level (it clears on every level change), so absent means
  // "as this level arrives" and present means "as the reader last set it here".
  const showChanges = showChangesOverride ?? emphasisArmable;
  const emphasisDisabledReason = emphasis
    ? emphasisedIds.size === 0
      ? emphasis.emptyLabel
      : emphasis.allLabel
    : undefined;

  // The selected node + everything it is connected to (its dependencies/blockers) —
  // these stay lit while the rest of the level dims, so the selection reads clearly.
  const connectedIds = useMemo(() => {
    if (selectedId === null) return null;
    const s = new Set<string>([selectedId]);
    for (const d of deps) {
      if (d.from === selectedId) s.add(d.to);
      if (d.to === selectedId) s.add(d.from);
    }
    return s;
  }, [selectedId, deps]);
  const layout = useMemo(
    () =>
      deterministicLayout(
        nodes.map((n) => n.id),
        deps.map((d) => ({ from: d.from, to: d.to })),
      ),
    [nodes, deps],
  );

  const positionOf = useCallback(
    (n: ProjectCanvasNode) => {
      const saved = localPositions[n.id] ?? positions?.[n.id];
      if (saved) return saved;
      if (n.x !== undefined && n.y !== undefined) return { x: n.x, y: n.y };
      return layout[n.id] ?? { x: 0, y: 0 };
    },
    [localPositions, positions, layout],
  );

  // The AUTO-LAID nodes (work items) — the ones the AUTO-RESET tracks (fixed-position
  // nodes — stations / the plan preview carry an explicit x/y — are excluded: a
  // re-plan never invalidates their arrangement).
  const autoLaidIds = useMemo(
    () => nodes.filter((n) => n.x === undefined || n.y === undefined).map((n) => n.id),
    [nodes],
  );
  // The ARRANGED nodes — anything the user has hand-moved on THIS level (a saved or
  // local override), whether a work item or a station. The "Reset layout" button
  // acts on these, so it works on the root "Your project" canvas (stations) too.
  const arrangedIds = useMemo(
    () => nodes.map((n) => n.id).filter((id) => localPositions[id] ?? positions?.[id]),
    [nodes, localPositions, positions],
  );
  const hasArrangement = arrangedIds.length > 0;

  // Reset this level's hand-moved nodes to their default layout (local + persisted).
  const resetLayout = useCallback(() => {
    if (arrangedIds.length === 0) return;
    setLocalPositions((prev) => {
      const next = { ...prev };
      for (const id of arrangedIds) delete next[id];
      return next;
    });
    onResetPositions?.(arrangedIds);
  }, [arrangedIds, onResetPositions]);

  // AUTO-RESET on a layer change: if a level's auto-laid node SET differs from the
  // last time we rendered that level (a re-plan added/removed/reordered items), its
  // saved positions are stale → drop them so the layout recomputes cleanly. Keyed
  // by focus so each drill level tracks its own signature.
  const layoutSigRef = useRef<Map<string, string>>(new Map());
  const resetRef = useRef(onResetPositions);
  useEffect(() => {
    resetRef.current = onResetPositions;
  }, [onResetPositions]);
  useEffect(() => {
    // Don't track until the level has auto-laid nodes — otherwise the empty
    // pre-load render would register a signature and make the first load look
    // like a change.
    if (autoLaidIds.length === 0) return;
    const sig = [...autoLaidIds].sort().join('|');
    const key = focusId ?? '__root__';
    const prev = layoutSigRef.current.get(key);
    layoutSigRef.current.set(key, sig);
    if (prev !== undefined && prev !== sig) {
      resetRef.current?.(autoLaidIds);
      setLocalPositions((p) => {
        const next = { ...p };
        for (const id of autoLaidIds) delete next[id];
        return next;
      });
    }
  }, [autoLaidIds, focusId]);

  const canvasNodes: CanvasNode[] = nodes.map((n) => ({
    id: n.id,
    ...positionOf(n),
    width: n.width ?? NODE_W,
    height: n.height ?? NODE_H,
    ...(n.changeKey !== undefined ? { changeKey: n.changeKey } : {}),
    // The "here" card wears the You are here tab on its top-left edge
    // (MOTIR-10630), so its top-side edges fan right of it.
    ...(n.here ? { topTab: true } : {}),
  }));
  const canvasEdges: CanvasEdge[] = deps.map((d) => ({
    from: d.from,
    to: d.to,
    variant: d.variant,
  }));

  const handleMove = useCallback(
    (id: string, x: number, y: number) => {
      setLocalPositions((prev) => ({ ...prev, [id]: { x, y } }));
      onNodeMove?.(id, x, y);
    },
    [onNodeMove],
  );

  // Clicking a card SELECTS it (focus + highlight its connections) — it does NOT
  // drill. Drilling is the explicit "Open" affordance on the selected card. The
  // consumer's onSelect still fires (e.g. an onboarding station opens its doc).
  const handleActivate = useCallback(
    (id: string) => {
      setSelectedId(id);
      onSelect?.(id);
    },
    [onSelect],
  );

  const handleDrill = useCallback(
    (id: string) => {
      const n = byId.get(id);
      if (!n?.drillable) return;
      // An explicit drill RE-ARMS auto-descend (design panel F): the user asked to go
      // down, so a single-parent chain below this node compacts again.
      suppressedLevelRef.current = null;
      // Drill: fetch the node's children (the load effect fires on focusId change).
      applyDrill(n);
      // The PERSON drilled (MOTIR-8593) — reported here, not in `applyDrill`, which
      // the auto-descend shares.
      onReaderNavigatedRef.current?.('drill');
    },
    [byId, applyDrill],
  );

  const navigate = useCallback((crumbId: string | null, via: 'crumb' | 'back' = 'crumb') => {
    // The reader moved (MOTIR-6161) — a crumb click or Back disarms the follow.
    setNavigated(true);
    onReaderNavigatedRef.current?.(via);
    // The user EXPLICITLY climbed to this level (a crumb click, or Back via `goBack`) —
    // never auto-descend out of it again, or the breadcrumb root becomes a trap.
    suppressedLevelRef.current = levelKey(crumbId);
    setLocalPositions({});
    setHighlightId(null);
    setSelectedId(null);
    setShowChangesOverride(null);
    if (crumbId === null) {
      setCrumbs([]);
      setFocusId(null);
      onLevelChangeRef.current?.([]);
      return;
    }
    const cur = crumbsRef.current;
    const i = cur.findIndex((x) => x.id === crumbId);
    const next = i >= 0 ? cur.slice(0, i + 1) : cur;
    setCrumbs(next);
    setFocusId(crumbId);
    onLevelChangeRef.current?.(next);
  }, []);

  const goBack = useCallback(() => {
    navigate(crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.id ?? null) : null, 'back');
  }, [crumbs, navigate]);

  // *Go there* on the ARRIVALS pill (MOTIR-6300; §23.7) — a navigation the reader
  // CHOSE, so it is the one thing an arrival may move the canvas by. It drills by
  // the arriving card's own trail, and it is the reader's act: every later
  // `followTo` is declined, and the level is reported like any other move.
  const goToArrivals = useCallback((trail: readonly CanvasCrumb[]) => {
    const next = [...trail];
    const levelId = next[next.length - 1]?.id ?? null;
    setNavigated(true);
    onReaderNavigatedRef.current?.('pick');
    suppressedLevelRef.current = levelKey(levelId);
    setCrumbs(next);
    setFocusId(levelId);
    setLocalPositions({});
    setSelectedId(null);
    setHighlightId(null);
    setShowChangesOverride(null);
    onLevelChangeRef.current?.(next);
  }, []);

  const locate = useCallback(() => {
    const ms = searchMatches(nodes, query);
    const target = ms[0];
    if (target === undefined) return;
    // A search jump is the person taking over (MOTIR-8593), though it stays on the level.
    onReaderNavigatedRef.current?.('search');
    setFocusScale(undefined); // search-locate pans only — keep the user's zoom
    setHighlightId(target);
    setFocusNonce((n) => n + 1);
  }, [nodes, query]);

  // LOCATE control (MOTIR-1421) — centre the canvas on the ACTIONABLE node. The
  // targets come from the level's nodes: the "you are here" frontier first (a single
  // destination), else the READY nodes (cycled, wrapping). Centring reuses the same
  // pan-to-node machinery the search-locate above uses (highlight + focusNonce bump),
  // so the located node lights up AND is assertable on `data-highlighted`.
  //
  // ⚠️ WHEN `emphasis` IS SUPPLIED THE CONTROL WALKS THAT SET INSTEAD (MOTIR-4020,
  // Part XIII §4). A proposal is never `here` and never `ready`, so the shipped
  // ladder finds nothing on a plan canvas — the control was mounted on a surface
  // it could not serve. One prop, not two: the emphasis and the locate control are
  // the same set of cards seen twice, ringed and walked, and a second `locate` set
  // could drift from the first. In LAYOUT order, because the reader is walking a
  // picture and the walk should move the way the eye does — not in `op` order,
  // which jumps between three groups, nor in the plan's append order, which is
  // invisible on screen. `nodes` IS that order.
  const emphasisWalk = useMemo(
    () => (emphasis ? nodes.filter((n) => emphasisedIds.has(n.id)).map((n) => n.id) : null),
    [emphasis, nodes, emphasisedIds],
  );
  const hereId = useMemo(
    () => (emphasisWalk ? null : (nodes.find((n) => n.here)?.id ?? null)),
    [emphasisWalk, nodes],
  );
  const readyIds = useMemo(
    () => emphasisWalk ?? nodes.filter((n) => n.ready).map((n) => n.id),
    [emphasisWalk, nodes],
  );
  const readySig = readyIds.join('|');
  const canLocate = hereId !== null || readyIds.length > 0;
  // THE FOCAL CARD of this level (MOTIR-3837) — the node an arrival centres on when
  // the level cannot be shown legibly whole. The ladder is LOCATE's own, one line
  // up, so "where the canvas opens" and "where Locate takes you" cannot disagree:
  // the `here` frontier, else the first `ready` node, else the level's first node in
  // layout order. A `decorative` node — the pinned planning-origin cluster — is
  // never it, for the same reason it is not a level's WORK (MOTIR-1824).
  const focalNodeId = useMemo(() => focalNode(nodes), [nodes]);
  // The index of the ready node centred by the LAST locate click (-1 = none yet).
  const [locateIndex, setLocateIndex] = useState(-1);
  // Reset the cycle cursor when the level's targets change (a drill / re-plan) so the
  // cycle restarts cleanly — the React-sanctioned "adjust state during render when an
  // input changes" pattern (NOT a setState-in-effect, which the lint rule forbids).
  const targetSig = `${hereId ?? ''}|${readySig}`;
  const [prevTargetSig, setPrevTargetSig] = useState(targetSig);
  if (targetSig !== prevTargetSig) {
    setPrevTargetSig(targetSig);
    setLocateIndex(-1);
  }

  const locateActionable = useCallback(() => {
    // Locate snaps to a readable default zoom (so a node found while zoomed far
    // out/in lands at a comfortable size), then centres AND SELECTS the node — so its
    // actions (View / Open) surface and its connections light up, ready to act on.
    setFocusScale(LOCATE_ZOOM);
    // Frontier wins: a single destination, no cycling.
    if (hereId !== null) {
      setHighlightId(hereId);
      setSelectedId(hereId);
      setFocusNonce((n) => n + 1);
      return;
    }
    if (readyIds.length === 0) return;
    // Advance to the next ready node, wrapping after the last.
    const next = (locateIndex + 1) % readyIds.length;
    setLocateIndex(next);
    const targetId = readyIds[next] ?? null;
    setHighlightId(targetId);
    setSelectedId(targetId);
    setFocusNonce((n) => n + 1);
  }, [hereId, readyIds, locateIndex]);

  // The "n of m" cycling hint — shown only while cycling MULTIPLE ready nodes (no
  // frontier) and after the first locate, so it reflects the current position.
  const cyclingHint =
    hereId === null && readyIds.length > 1 && locateIndex >= 0
      ? `${locateIndex + 1} / ${readyIds.length}`
      : null;
  // The consumer's word when it supplied the set, for the same reason
  // `searchLabel` is (MOTIR-4021): the shipped strings name a READY frontier, and
  // a proposal is not one. The disabled reason is the emphasis control's own
  // (`emptyLabel`) — one sentence per situation, said once, rather than a second
  // wording for "the plan does not reach this level".
  const locateLabel = emphasis
    ? emphasis.locateLabel
    : hereId !== null
      ? t('locateCurrent')
      : readyIds.length > 1
        ? t('locateNextReady')
        : t('locateReady');
  const locateDisabledReason = emphasis ? emphasis.emptyLabel : t('locateNothing');

  /** Does the selected card offer the planning-target action (MOTIR-6898)? */
  function targetActionFor(id: string): boolean {
    return targetAction !== undefined && targetAction.isEligible(id);
  }

  /**
   * SET AS TARGET / REMOVE TARGET — View's secondary treatment verbatim, so Open
   * stays the one accent action on the card (design panel 6). It adds nothing to
   * navigation: the canvas stays on this level, and the card keeps its selection,
   * so the same button now reads Remove.
   */
  function renderTargetButton(id: string) {
    const action = targetAction!;
    const label = action.keyFor(id);
    const isTarget = action.isTarget(id);
    const disabled = !isTarget && !action.canAdd;
    return (
      <button
        type="button"
        data-testid="target-toggle-button"
        aria-label={
          isTarget
            ? tTargets('removeTargetAria', { key: label })
            : tTargets('setTargetAria', { key: label })
        }
        aria-pressed={isTarget}
        disabled={disabled}
        title={disabled ? action.disabledReason : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          action.onToggle(id);
        }}
        className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold whitespace-nowrap text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55"
      >
        {isTarget ? (
          <X className="size-3.5" aria-hidden="true" />
        ) : (
          <Target className="size-3.5" aria-hidden="true" />
        )}
        {isTarget ? tTargets('removeTarget') : tTargets('setTarget')}
      </button>
    );
  }

  function renderNode(cn: CanvasNode) {
    const node = byId.get(cn.id) ?? (motion ? lastDrawnRef.current.get(cn.id) : undefined);
    if (!node) return null;
    const matched = highlightId === cn.id || matchIds.has(cn.id);
    const selected = cn.id === selectedId;
    // ⚠️ A LIVE SELECTION WINS while it lasts (Part IX §L4). Both mechanisms
    // write the same `connectedIds`-shaped state, and layering them gives three
    // opacity tiers and no legible meaning. The toggle stays pressed, so clearing
    // the selection restores the emphasis rather than making the reader re-arm
    // it: a selection is a momentary act, the toggle is a mode.
    const emphasised = showChanges && connectedIds === null && emphasisedIds.has(cn.id);
    const dimmed =
      connectedIds !== null
        ? !connectedIds.has(cn.id)
        : showChanges && emphasisedIds.size > 0 && !emphasisedIds.has(cn.id);
    return (
      <div
        data-highlighted={matched || undefined}
        data-selected={selected || undefined}
        data-emphasised={emphasised || undefined}
        className={[
          // `motion-reduce:transition-none` — turning the emphasis on changes the
          // opacity of most of the screen at once (Part IX §L8).
          'relative rounded-(--radius-card) transition-opacity motion-reduce:transition-none',
          // ⚠️ The ACCENT INK, never `--el-accent` (the FILL). A ring is a mark ON
          // `--el-surface-soft`, so it owes 3:1 against that offset — which the
          // fill missed in citrine (1.37), candy (1.51) and amber (1.74) light and
          // garnet dark (2.88). MOTIR-4474; measured in
          // `tests/theme/canvasEmphasisInkContrast.test.ts`, which reads the token
          // back out of this line.
          selected || matched || emphasised
            ? 'ring-2 ring-(--el-accent-on-surface) ring-offset-2 ring-offset-(--el-surface-soft)'
            : '',
          dimmed ? 'opacity-35' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {node.content}
        {/* The selected card's ACTION SLOT — surfaced on the bottom edge so the
            detail / drill actions are obvious without hijacking a plain click
            (which now just selects). VIEW (open the quick-view detail, MOTIR-1352)
            and OPEN (drill into children) are DISTINCT and sit side by side; a leaf
            shows View alone. Each stops the press from starting a canvas drag. */}
        {selected && ((onView && node.viewable) || node.drillable || targetActionFor(cn.id)) && (
          <div className="absolute -bottom-3.5 left-1/2 flex -translate-x-1/2 items-center gap-2">
            {onView && node.viewable && (
              <button
                type="button"
                data-testid="view-button"
                aria-label={`View ${node.crumbLabel ?? node.searchText}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onView(cn.id);
                }}
                className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold whitespace-nowrap text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Eye className="size-3.5" aria-hidden="true" />
                View
              </button>
            )}
            {targetActionFor(cn.id) && renderTargetButton(cn.id)}
            {node.drillable && (
              <button
                type="button"
                data-testid="drill-button"
                aria-label={t('openChildren')}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDrill(cn.id);
                }}
                className="inline-flex items-center gap-1 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold whitespace-nowrap text-(--el-accent-text) shadow-(--shadow-card) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                Open
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const drilled = crumbs.length > 0;
  const lastCrumb = crumbs[crumbs.length - 1];
  const drilledEmpty =
    drilled && emptyDrilledFor && lastCrumb
      ? emptyDrilledFor({ id: lastCrumb.id, label: lastCrumb.label })
      : null;
  // The LEVEL CHANGE BAND (MOTIR-6223) — the bar's second row, drilled only.
  const band =
    drilled && levelBand && lastCrumb
      ? levelBand({ id: lastCrumb.id, label: lastCrumb.label })
      : null;
  // ONE offer slot, two armings (MOTIR-6223): a DECLINED follow, else the plan
  // being somewhere the reader is not. The declined one wins — it is the older
  // sentence, and it names where the plan lands just the same.
  const offer = declined ?? elsewhereOffer?.(crumbs) ?? null;
  // THE ONE SLOT'S WORDS (§23.7, re-worded by Part XXVI §26.7): the arrivals
  // count, joined by the cues the reader cannot see. With no `inFlight` it is the
  // arrivals pill exactly as shipped.
  const drawnIds = new Set(nodes.map((n) => n.id));
  const liveSlotNow = liveSlot(
    arrivalsPill,
    inFlight ? offLevelInFlight(inFlight, drawnIds, focusId) : [],
  );
  // THE TRIP RULE (MOTIR-8594; §28.3): hidden while its trip IS the follow trip.
  const slot =
    liveSlotNow !== null &&
    followLevelId !== undefined &&
    (liveSlotNow.trail[liveSlotNow.trail.length - 1]?.id ?? null) === followLevelId
      ? null
      : liveSlotNow;
  // Inside the trips group the group carries the `ml-auto`, not each trip.
  const tripPush = followControl ? '' : 'ml-auto ';
  const slotIdentifier = (trail: readonly CanvasCrumb[]) =>
    trail[trail.length - 1]?.crumbKey ?? trail[trail.length - 1]?.label ?? resolvedRootLabel;
  // The slot's words, computed once: the pill's visible label AND its accessible
  // name, because below a 32rem bar the label goes `sr-only` (MOTIR-8646).
  const offerLabel =
    offer !== null
      ? tTarget('goToTarget', {
          identifier:
            offer.trail[offer.trail.length - 1]?.crumbKey ??
            offer.trail[offer.trail.length - 1]?.label ??
            resolvedRootLabel,
        })
      : null;
  const slotLabel =
    slot === null
      ? null
      : slot.key === 'newAndDraftingIn'
        ? tTarget(slot.key, {
            arrived: slot.arrived,
            drafting: slot.drafting,
            identifier: slotIdentifier(slot.trail),
          })
        : slot.key === 'layingIn'
          ? tTarget(slot.key, { identifier: slotIdentifier(slot.trail) })
          : tTarget(slot.key, {
              count: slot.count,
              identifier: slotIdentifier(slot.trail),
            });

  // The bar's TRIPS — the offer, else the pill (one slot).
  const trips = (
    <>
      {/* ⚠️ THE READER NAVIGATED, SO THE CANVAS DID NOT MOVE (MOTIR-6161) —
                  and saying nothing would strand them: the plan is landing somewhere
                  they are not looking. A quiet affordance in the bar's own row, never
                  a toast and never a modal, and it never moves anything by itself.
                  Taking it IS an explicit reader act, which is the one thing allowed
                  to move a reader who has navigated. */}
      {offer !== null && (
        <button
          type="button"
          data-testid="canvas-follow-offer"
          aria-label={offerLabel ?? undefined}
          title={offerLabel ?? undefined}
          onClick={() => {
            const next = offer.trail;
            // An elsewhere offer needs no clearing: once the reader stands
            // where the plan is, it stops arming by itself.
            if (offer === declined) setDeclined(null);
            onReaderNavigatedRef.current?.('pick');
            setCrumbs([...next]);
            setFocusId(next[next.length - 1]?.id ?? null);
            setLocalPositions({});
            setSelectedId(null);
            setHighlightId(null);
            setShowChangesOverride(null);
            suppressedLevelRef.current = levelKey(next[next.length - 1]?.id ?? null);
            setFollowFade(true);
            setFollowAnnouncement(
              tTarget('movedAnnouncement', {
                target: next[next.length - 1]?.label ?? resolvedRootLabel,
              }),
            );
          }}
          className={`${tripPush}${SLOT_PILL_CLASS}`}
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-(--radius-badge) bg-(--el-accent)"
          />
          <span className={SLOT_PILL_LABEL_CLASS}>{offerLabel}</span>
        </button>
      )}
      {/* THE ARRIVALS COUNT (MOTIR-6300; design Part XXIII §23.7) — ONE slot,
                  in the follow offer's own markup. The offer WINS it when it is up: it
                  already names where the plan lands. */}
      {offer === null && slot !== null && (
        <button
          type="button"
          data-testid="canvas-arrivals-offer"
          aria-label={slotLabel ?? undefined}
          title={slotLabel ?? undefined}
          onClick={() => goToArrivals(slot.trail)}
          className={`${tripPush}${SLOT_PILL_CLASS}`}
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-(--radius-badge) bg-(--el-accent)"
          />
          <span className={SLOT_PILL_LABEL_CLASS}>{slotLabel}</span>
        </button>
      )}
    </>
  );

  // The bar's crumb row — the whole bar without a band, row one with one.
  const breadcrumbRow = (
    <>
      {(drilled || offer !== null) && (
        <button
          type="button"
          onClick={goBack}
          aria-label={t('back')}
          className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
      )}
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        <li className="shrink-0">
          <Crumb label={resolvedRootLabel} active={false} onClick={() => navigate(null)} />
        </li>
        {breadcrumbSegments(crumbs, isFolderCrumb ?? (() => false)).map((seg) => {
          if (seg.kind === 'ellipsis') {
            const target = crumbs[seg.targetIndex]!;
            const full = seg.path.join(' ▸ ');
            return (
              <li key={`ellipsis:${target.id}`} className="flex min-w-0 items-center gap-1">
                <ChevronRight
                  className="size-3.5 shrink-0 text-(--el-text-faint)"
                  aria-hidden="true"
                />
                <Crumb
                  label="…"
                  title={full}
                  ariaLabel={full}
                  active={false}
                  onClick={() => navigate(target.id)}
                />
              </li>
            );
          }
          const c = crumbs[seg.index]!;
          return (
            <li key={c.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight
                className="size-3.5 shrink-0 text-(--el-text-faint)"
                aria-hidden="true"
              />
              <Crumb
                label={c.label}
                active={seg.index === crumbs.length - 1}
                onClick={() => navigate(c.id)}
                folder={seg.folder}
                // THE TARGET CRUMB (MOTIR-6160) — the planning surface's
                // answer to MOTIR-2070. Standing INSIDE the target removes
                // the node its ring was drawn on, so the mark moves to the
                // crumb: this level IS the thing being planned. A folder
                // crumb wins the glyph slot if both ever applied, which
                // they cannot — a folder is not a work item.
                planningTarget={!seg.folder && (isTargetCrumb?.(c) ?? false)}
                srPrefix={
                  seg.folder
                    ? tFolders('breadcrumbFolderLabel')
                    : (isTargetCrumb?.(c) ?? false)
                      ? tTarget('crumbTargetPrefix')
                      : undefined
                }
              />
            </li>
          );
        })}
      </ol>
      {followControl ? (
        <div data-testid="canvas-bar-trips" className="ml-auto flex shrink-0 items-center gap-1.5">
          {trips}
          {followControl}
        </div>
      ) : (
        trips
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      // The crossfade's end releases a driven arrival's cue (§28.4).
      onTransitionEnd={(e) => {
        if (cueHeld && e.propertyName === 'opacity') setCueHeld(false);
      }}
      data-testid="roadmap-canvas"
      data-fullscreen={expanded || undefined}
      className={expanded ? 'fixed inset-0 z-50 bg-(--el-canvas)' : 'relative h-full w-full'}
    >
      {/* One top band owns BOTH sides of the chrome (MOTIR-5816). The breadcrumb
          used to size itself against the whole canvas while the controls were
          independently positioned from the right, so the two regions painted
          over each other. A shared wrapping flex band keeps them side by side when
          both fit and gives each its own row on a narrow canvas. The wrapper is
          pointer-transparent so its empty band never masks the canvas; the two
          pieces opt back in. */}
      {/* WHERE THE CANVAS WENT (MOTIR-6161) — a polite live region, the idiom
          this surface already uses (`PlanChangeRail`, `PlanningHandOff`). It is
          visually hidden because the move itself is the visible half; this is for
          a reader who was not watching the canvas. Empty until a follow is
          granted, so it announces nothing on an ordinary drill. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="canvas-follow-live">
        {followAnnouncement}
      </div>
      <div className="pointer-events-none absolute top-3 right-3 left-3 z-10 flex min-w-0 flex-wrap items-start gap-2">
        {/* breadcrumb + Back overlay — only while drilled. At the ROOT it renders
            for the arrivals pill too (§23.7): the root crumb and the pill, and no
            Back, because there is nowhere to go back to. */}
        {(drilled || offer !== null || slot !== null || Boolean(followControl)) && (
          <nav
            aria-label={t('breadcrumb')}
            // Widened from 36rem with the `identifier · title` crumb label (MOTIR-1805
            // design DECISION 2) so a two-crumb chain reads without immediate ellipsis.
            // The 44rem basis is also the collision budget: when that and the fixed
            // control cluster do not fit together, flex-wrap moves the controls to
            // their own right-aligned row instead of crushing the crumb targets.
            //
            // With a LEVEL CHANGE BAND (MOTIR-6223) the bar STACKS: `breadcrumbRow`
            // becomes its first row, unchanged, and the band the second, inside the
            // same card. Without one it is the single-row bar, byte for byte.
            className={`@container/canvas-bar pointer-events-auto flex min-w-0 max-w-[44rem] basis-[44rem] flex-1 ${band ? 'flex-col items-stretch' : 'items-center gap-1'} rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding-8) py-(--spacing-card-padding-4) shadow-(--shadow-card)`}
          >
            {band ? (
              <>
                <div className="flex min-w-0 items-center gap-1">{breadcrumbRow}</div>
                {band}
              </>
            ) : (
              breadcrumbRow
            )}
          </nav>
        )}

        {/* TOP-RIGHT cluster: search-to-locate (within the current level), the
          SHOW-CHANGES toggle (MOTIR-3261) and the EXPAND-to-full-screen control,
          side by side (MOTIR-1420).

          ⚠️ Show changes lives HERE and not in the plan detail's own pane header,
          which Part VIII had reserved for it. Part IX §L1 released that slot: the
          control acts on the canvas's NODES and belongs adjacent to what it
          changes; it must not exist in the list view, which this cluster gets for
          free; and the emphasis state lives in this component, so a control in
          another one would have to lift it out. */}
        {(searchable || fullScreenable || emphasis) && (
          <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">
            {searchable && (
              <form
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  locate();
                }}
                className="w-60"
              >
                <Input
                  ref={searchRef}
                  type="search"
                  // The CONSUMER's word, on both axes (MOTIR-4021). The foundation
                  // has four searchable mounts and knows which surface it is on for
                  // exactly none of them.
                  aria-label={searchLabel}
                  placeholder={searchLabel}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  addonStart={
                    <Search className="size-4 text-(--el-text-muted)" aria-hidden="true" />
                  }
                />
              </form>
            )}
            {emphasis && (
              <button
                type="button"
                data-testid="show-changes-toggle"
                aria-pressed={showChanges}
                // A level the plan does not reach: DISABLED with its reason, rather
                // than an ON state that dims every card and rings none — a screen
                // that says nothing is worse than a control that says why it cannot
                // help (Part IX §L6).
                // BOTH degenerate levels, each with its OWN reason (Part XIII §3d):
                // a level the plan does not reach, where ON would dim every card and
                // ring none; and a level made entirely OF the plan, where ON rings
                // every card and dims none. Same disposition, opposite emptiness.
                disabled={!emphasisArmable}
                title={emphasisArmable ? undefined : emphasisDisabledReason}
                aria-description={emphasisArmable ? undefined : emphasisDisabledReason}
                onClick={() => setShowChangesOverride(!showChanges)}
                className={[
                  'inline-flex h-(--height-control) shrink-0 items-center gap-1.5 rounded-(--radius-btn)',
                  'border px-(--spacing-control-x) text-xs font-semibold shadow-(--shadow-card)',
                  'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  showChanges
                    ? // ⚠️ `--el-tint-lavender`, NOT `--el-accent-soft` (MOTIR-4020, Part
                      // XIII §3e). The latter is defined NOWHERE — it began as a LOCAL
                      // variable in Part IX's own mock (`#f4f2fd`, a hex in neither
                      // `theme.css` nor `globals.css`) that the note transcribed into the
                      // `--el-*` namespace, and this class built faithfully. An unresolved
                      // custom property is invalid at computed-value time, so the
                      // declaration was dropped and the PRESSED control rendered with no
                      // background at all — measured `rgba(0, 0, 0, 0)`. This pair is the
                      // shipped active-destination treatment (`components/ui/Sidebar.tsx`)
                      // and its contrast against `--el-accent-on-surface` is already
                      // asserted by `inkContrastLint` over every palette x theme.
                      'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-accent-on-surface)'
                    : 'border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)',
                ].join(' ')}
              >
                <Eye className="size-4" aria-hidden="true" />
                {emphasis.label}
                {/* `n of m` only when the level holds fewer than the whole plan —
                  the canvas is per-level and most of a spread plan is off-screen.
                  It offers no way to reach the rest, deliberately: that is the
                  list view's job (Part IX §L5).

                  ⚠️ Through the CATALOGUE, not composed here (bug MOTIR-3453).
                  This shipped as `{n}/{total}` built in JSX — a string no
                  catalogue could reach, so `zh` could never differ from `en` and
                  the parity gate could not see it, because there was no key for
                  it to find missing. Part IX §5 names the key and its wording:
                  `{n} of {total}`, which is also what a screen reader should
                  say. */}
                {emphasisedIds.size < emphasis.total ? (
                  <span className="font-mono text-[11px] font-semibold tabular-nums">
                    {t('showChangesCount', { n: emphasisedIds.size, total: emphasis.total })}
                  </span>
                ) : null}
              </button>
            )}
            {fullScreenable && (
              <button
                type="button"
                data-testid="fullscreen-toggle"
                aria-label={expanded ? t('exitFullScreen') : t('enterFullScreen')}
                aria-pressed={expanded}
                onClick={expanded ? exitFullScreen : enterFullScreen}
                className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
              >
                {expanded ? (
                  <Minimize className="size-4" aria-hidden="true" />
                ) : (
                  <Maximize className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ESC hint — only while full screen; the other overlay controls stay reachable. */}
      {expanded && (
        <div
          data-testid="fullscreen-hint"
          className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2"
        >
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-kbd) bg-(--el-muted) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs text-(--el-text-secondary) shadow-(--shadow-subtle)">
            Press
            <kbd className="rounded-(--radius-kbd) border border-(--el-border) bg-(--el-surface) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px] text-(--el-text)">
              Esc
            </kbd>
            to exit full screen
          </span>
        </div>
      )}

      {/* LOCATE control (MOTIR-1421) — recentres on the actionable node. Sits at the
          bottom-left, just RIGHT of the engine's zoom + fit cluster (bottom-4 left-4,
          ~7rem wide), so it reads as part of the viewport-navigation controls. */}
      {locatable && (
        <div className="absolute bottom-[calc(--spacing(4)+var(--canvas-foot-inset,0px))] left-[8.25rem] z-10 flex items-center gap-2">
          <button
            type="button"
            data-testid="locate-button"
            aria-label={locateLabel}
            disabled={!canLocate}
            title={canLocate ? locateLabel : locateDisabledReason}
            onClick={locateActionable}
            // size-9 to match the engine's bottom-left zoom +/- buttons (also size-9)
            // exactly, so the locate control reads as part of that cluster.
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:bg-(--el-surface-soft) disabled:text-(--el-text-faint) disabled:shadow-(--shadow-subtle) disabled:hover:bg-(--el-surface-soft)"
          >
            <LocateFixed className="size-4" aria-hidden="true" />
          </button>
          {cyclingHint && (
            <span
              data-testid="locate-hint"
              className="inline-flex h-(--height-control) items-center rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs font-semibold text-(--el-text-secondary) shadow-(--shadow-card)"
            >
              {cyclingHint}
            </span>
          )}
        </div>
      )}

      {/* RESET LAYOUT — only when the user has hand-arranged an auto-laid node on
          this level; clears those positions back to the dependency layout. Sits at
          the bottom-right, clear of the engine's bottom-left zoom controls. */}
      {hasArrangement && onResetPositions && (
        <button
          type="button"
          onClick={resetLayout}
          // THE ONE control the fold can collide with (MOTIR-3839). Every other
          // bottom-anchored overlay on this canvas is anchored LEFT; the floating
          // Plan-with-AI orb is `fixed right-5 bottom-5`, 56px square — a 76px
          // reach from both edges — so only a bottom-RIGHT control can meet it.
          // `--canvas-fold-inset` is declared by a consumer whose box SPENDS the
          // shell's clearance band (today: the roadmap page); it defaults to `0px`,
          // so every other mount — the item page's Children panel, the two plan
          // canvases — is exactly where it is now.
          //
          // ⚠️ TWO INSETS, AND THEY ARE NOT THE SAME SHAPE (MOTIR-6186). This
          // control adds BOTH; the left-anchored overlays add only the second.
          //   • `--canvas-fold-inset` — a bottom-RIGHT obstruction (the orb). It
          //     reaches one corner, which is why the left overlays ignore it and
          //     `ProjectRoadmapCanvas.test.tsx` asserts they do.
          //   • `--canvas-foot-inset` — an obstruction spanning the canvas's FULL
          //     WIDTH: the planning surface's confirm bar, which since MOTIR-6186
          //     floats over this box's bottom edge rather than sitting below it.
          //     A full-width bar reaches every bottom-anchored overlay, so all
          //     four add it.
          // Both default to `0px`, so a mount that declares neither is untouched.
          className="absolute right-3 bottom-[calc(1rem+var(--canvas-fold-inset,0px)+var(--canvas-foot-inset,0px))] z-10 inline-flex items-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t('resetLayout')}
        </button>
      )}

      {/* LEVEL CAPTION (bug MOTIR-3453) — Part IX §1.4's `lvlcap` slot, which the
          design's mock draws and the canvas never had. Composed as the edge
          LEGEND below already composes a canvas overlay: the same `--el-surface`
          chip with the canvas's border and shadow, and the same 10.5px tracked
          uppercase ramp, so a second overlay language is not invented for one
          line of text.

          ⚠️ The ink is `--el-text-secondary`, where the mock's `.lvlcap` rule
          says `var(--accent)`. That is the one deliberate deviation, and it is
          `CLAUDE.md`'s contrast rule doing its job — *"a design mock is NOT
          authority here"*. `--el-accent-on-surface` is specified as the accent
          used as text on a SURFACE, and this caption rides `--el-canvas`, a
          RECESSED board that every `data-palette` redefines; nothing measures
          that pairing, and there are eight palettes to be wrong in.
          `--el-text-secondary` is the token whose own definition carries the
          guarantee ("AA on EVERY surface"), and it is what the legend beside it
          already uses over the same canvas. Nothing is lost: the distinction
          this caption draws lives in its WORDS, which is what Part IX §1.3 asks
          for one decision earlier — text first, never colour alone.

          Sits UNDER the breadcrumb while drilled and takes its place when not,
          so it never collides with the overlay above it. Suppressed while the
          first level is still loading: a caption over a spinner describes a
          level nobody can see.

          ⚠️ The offset is DERIVED, and it is measured against the whole TOP
          BAND, not just the breadcrumb. Two overlays live at `top-3`: the
          breadcrumb on the left (while drilled) and the search / full-screen /
          Show-changes cluster on the right. Both are `--height-control` tall
          plus their own padding, and that token is 34–40px across the shipped
          styles — so the mock's literal 56px clears them under some styles and
          lands INSIDE them under others, and a caption wide enough to reach the
          right edge would run under the cluster at any offset. The mock's crumb
          is smaller than the shipped one; what it specifies is the RELATIONSHIP
          (the caption sits just below the chrome), and a `calc` off the same
          token is how that survives a style swap. */}
      {levelCaption && level !== null && (
        <div
          data-testid="level-caption"
          data-below-chrome={drilled || searchable || fullScreenable || !!emphasis || undefined}
          className={[
            'absolute left-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))]',
            // 12px band top + the overlay's own height (`--height-control` plus
            // 8px of padding) + an 8px gap. Only a canvas with an EMPTY top band
            // — no breadcrumb and no cluster — can take the band itself.
            drilled || searchable || fullScreenable || emphasis
              ? 'top-[calc(var(--height-control)+1.75rem)]'
              : 'top-3',
            'rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) shadow-(--shadow-card)',
          ].join(' ')}
        >
          <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
            {levelCaption}
          </span>
        </div>
      )}

      {/* edge LEGEND — shown when the level has real blocked-by DEPENDENCY edges,
          so the canvas is self-documenting (MOTIR-1331). Sequence/`flow` edges (the
          onboarding station serpentine) are excluded — they are drawn, but they are
          not dependencies. Sits above the engine's bottom-left zoom. */}
      {deps.some((d) => d.kind !== 'flow') && (
        <div
          data-testid="edge-legend"
          data-collapsed={legendCollapsed || undefined}
          className="absolute bottom-[calc(4.25rem+var(--canvas-foot-inset,0px))] left-3 z-10 flex flex-col gap-1.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) shadow-(--shadow-card)"
        >
          {/* COLLAPSE (MOTIR-3838). The chevron rides the panel's OWN heading row
              rather than being a bare pill beside it: the heading is the one thing
              that must survive the collapse — a legend that vanishes entirely
              cannot be brought back — so the control belongs next to it. The panel
              collapses IN PLACE: the slot is unchanged, so the control does not
              move under the reader's cursor and can never land on the engine's
              zoom cluster at `bottom-4 left-4`. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
              {t('legend.heading')}
            </span>
            <button
              type="button"
              data-testid="edge-legend-toggle"
              onClick={toggleLegendCollapsed}
              aria-expanded={!legendCollapsed}
              aria-controls={legendRowsId}
              aria-label={t(legendCollapsed ? 'legend.expand' : 'legend.collapse')}
              title={t(legendCollapsed ? 'legend.expand' : 'legend.collapse')}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {legendCollapsed ? (
                <ChevronUp className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          <div
            id={legendRowsId}
            hidden={legendCollapsed}
            className={legendCollapsed ? undefined : 'flex flex-col gap-1.5'}
          >
            {(
              [
                ['committed', t('legend.blocks'), t('legend.blocksMeaning')],
                ['pending', t('legend.pending'), t('legend.pendingMeaning')],
                ['warning', resolvedWarningLegend.label, resolvedWarningLegend.meaning],
              ] as const
            ).map(([kind, label, meaning]) => (
              <span key={kind} className="flex items-center gap-2 text-xs text-(--el-text-strong)">
                <svg viewBox="0 0 40 12" className="h-3 w-10 shrink-0" aria-hidden="true">
                  <path
                    d="M2 6H31"
                    fill="none"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeDasharray={kind === 'pending' ? '2 5' : undefined}
                    className={
                      kind === 'warning'
                        ? 'stroke-(--el-warning)'
                        : kind === 'pending'
                          ? 'stroke-(--el-canvas-edge-pending)'
                          : 'stroke-(--el-canvas-edge-committed)'
                    }
                  />
                  <path
                    d="M30 2 36 6 30 10z"
                    className={
                      kind === 'warning'
                        ? 'fill-(--el-warning)'
                        : kind === 'pending'
                          ? 'fill-(--el-canvas-edge-pending)'
                          : 'fill-(--el-canvas-edge-committed)'
                    }
                  />
                </svg>
                {label}
                <span className="text-(--el-text-secondary)">· {meaning}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {level === null ? (
        <div
          aria-busy="true"
          className="flex h-full w-full items-center justify-center bg-(--el-canvas)"
        >
          {loadingFallback ?? <Spinner aria-label={t('loading')} />}
        </div>
      ) : nodes.length === 0 ? (
        !drilled && emptyRoot ? (
          // The consumer's own root-empty statement (MOTIR-2069), in the same
          // full-size box — a DRILLED empty level keeps the canvas's copy, since
          // "this parent has no children" is a different thing to say.
          <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
            {emptyRoot}
          </div>
        ) : drilled && drilledEmpty ? (
          // The consumer's own statement for THIS drilled level (MOTIR-5741) —
          // today a folder's, in the same full-size box.
          <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
            {drilledEmpty}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
            <div className="max-w-[24rem] text-center">
              <p className="text-sm font-semibold text-(--el-text)">
                {drilled ? t('emptyDrilled') : t('emptyRootTitle')}
              </p>
              <p className="mt-1 text-sm text-(--el-text-muted)">
                {drilled ? t('emptyDrilledDescription') : t('emptyRootDescription')}
              </p>
            </div>
          </div>
        )
      ) : (
        <PlanningCanvas
          // Remount per drill level so the new level auto-fits to its own overview.
          // Keyed on the focus the LEVEL belongs to, NOT on `focusId` — see the
          // note on the `level` state above. The two differ for exactly one round
          // trip, and that window is where the arrival scale was being lost.
          key={`level:${level.focusId ?? 'root'}`}
          className={`transition-opacity duration-[180ms] motion-reduce:transition-none ${
            followFade ? 'opacity-0' : 'opacity-100'
          }`}
          nodes={canvasNodes}
          edges={canvasEdges}
          renderNode={renderNode}
          onNodeMove={onNodeMove ? handleMove : undefined}
          onNodeActivate={handleActivate}
          selectedId={selectedId}
          litIds={
            showChanges && connectedIds === null && emphasisedIds.size > 0 ? emphasisedIds : null
          }
          arrival={arriveAtReadableScale ? { floor: ARRIVAL_MIN_SCALE, focalNodeId } : undefined}
          onBackgroundClick={() => setSelectedId(null)}
          focusNodeId={highlightId ?? undefined}
          focusNonce={focusNonce}
          focusScale={focusScale}
          ariaLabel={resolvedAriaLabel}
          motion={motion}
          animateInitial={animateInitial}
          nodeCues={shownCues}
        />
      )}
    </div>
  );
}

function Crumb({
  label,
  active,
  onClick,
  folder = false,
  planningTarget = false,
  srPrefix,
  title,
  ariaLabel,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  /** A FOLDER crumb (Bug MOTIR-5710 · MOTIR-5742): led by the 14px lucide `folder`
   *  glyph, so it reads as a folder without the reader reading it. */
  folder?: boolean;
  /** The PLANNING-TARGET crumb (MOTIR-6160): led by the 14px lucide `target`
   *  glyph — the same mark `PlanningTargetFrame`'s node pill carries, so "target"
   *  means one thing on this surface whether it is a node or the level — plus a
   *  2px accent underline at the node ring's own weight. NOT COLOUR ALONE: the
   *  `srPrefix` carries the state in words, exactly as the folder crumb does. */
  planningTarget?: boolean;
  /** A visually-hidden word ahead of the label — the folder crumb's `Folder:`. */
  srPrefix?: string;
  /** The native tooltip, when it should say more than the label (the `…` crumb's
   *  full path). Defaults to the label. */
  title?: string;
  /** The accessible name, when it is not the label (the `…` crumb's full path). */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      // 18rem (was 12rem) for the `identifier · title` label (MOTIR-1805 DECISION 2).
      // Overflow stays the shipped answer: `truncate` + the native `title` tooltip — a
      // long chain ellipsises the last crumb BY DESIGN (not a second line, not a
      // smaller font).
      className={`min-w-0 max-w-[18rem] truncate rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        active
          ? 'font-semibold text-(--el-text)'
          : 'text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
      }${folder || planningTarget ? ' inline-flex items-center gap-1' : ''}`}
    >
      {folder ? <Folder className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {planningTarget ? (
        <Target className="size-3.5 shrink-0 text-(--el-accent-on-surface)" aria-hidden="true" />
      ) : null}
      {srPrefix ? <span className="sr-only">{`${srPrefix} `}</span> : null}
      {folder ? (
        <span className="truncate">{label}</span>
      ) : planningTarget ? (
        // The 2px accent underline, at the node ring's own weight — it marks
        // without tinting the label, so the crumb keeps the shipped active-crumb
        // ink and its AA contrast.
        <span className="truncate shadow-[inset_0_-2px_0_0_var(--el-accent)]">{label}</span>
      ) : (
        label
      )}
    </button>
  );
}

/**
 * The breadcrumb's crumbs, with every RUN of consecutive FOLDER crumbs longer
 * than three collapsed FROM THE MIDDLE (Bug MOTIR-5710 · MOTIR-5742; design sheet
 * 5): `first ▸ … ▸ last`, by the same count rule `collapseFolderPath` states for
 * every folder path. The `…` is a crumb of its own: it names the folder just
 * above the last one shown and carries the collapsed path for its tooltip and its
 * accessible name. Work-item crumbs are never collapsed. Pure, so the rule is
 * asserted without a render.
 */
export type BreadcrumbSegment =
  | { kind: 'crumb'; index: number; folder: boolean }
  | { kind: 'ellipsis'; targetIndex: number; path: string[] };

export function breadcrumbSegments(
  crumbs: readonly { id: string; label: string }[],
  isFolderCrumb: (crumb: { id: string; label: string }) => boolean,
): BreadcrumbSegment[] {
  const out: BreadcrumbSegment[] = [];
  let i = 0;
  while (i < crumbs.length) {
    if (!isFolderCrumb(crumbs[i]!)) {
      out.push({ kind: 'crumb', index: i, folder: false });
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < crumbs.length && isFolderCrumb(crumbs[end + 1]!)) end += 1;
    const run = end - i + 1;
    if (run <= 3) {
      for (let k = i; k <= end; k += 1) out.push({ kind: 'crumb', index: k, folder: true });
    } else {
      out.push({ kind: 'crumb', index: i, folder: true });
      out.push({
        kind: 'ellipsis',
        targetIndex: end - 1,
        path: crumbs.slice(i, end + 1).map((c) => c.label),
      });
      out.push({ kind: 'crumb', index: end, folder: true });
    }
    i = end + 1;
  }
  return out;
}
