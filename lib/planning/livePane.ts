import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanStepKindDto } from '@/lib/dto/plans';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { levelTrail } from '@/lib/planning/planArrival';
import { proposalLevelKey } from '@/lib/planning/planShape';

// The planning surface's LIVE pane (MOTIR-6300; `design/ai-planning/design-notes.md`
// Part XXIII) — the PURE half: what a snapshot of a plan being written means for
// the pane that draws it. No React, no fetch, no clock, so each rule is tested
// against plain fixtures.
//
// ⚠️ EVERY RULE HERE IS A DIFF OF TWO SNAPSHOTS, never an event. The generating
// poll REPLACES the review on every read (MOTIR-6295), so the snapshot is the only
// unit there is — the same premise `canvasMotion.ts` is built on (§23.4).

// ── The DEEPEN signature ─────────────────────────────────────────────────────

/**
 * A proposal's CONTENT signature — `PlanningCanvas`'s `changeKey` (MOTIR-6297).
 * A change while the node id stays is a DEEPEN, which cues the card in place and
 * never re-enters it (§23.4: "a changed title / type / body / sizing on a kept id").
 *
 * Built from exactly the fields the design names, plus the field diffs a `modify`
 * carries (its proposed values live there, not on the item's own columns). The op
 * is left out on purpose: a card changing op is not something a deepen describes.
 */
export function proposalChangeKey(item: PlanReviewItemDto): string {
  return digest(
    JSON.stringify([
      item.title,
      item.kind,
      item.type,
      item.descriptionMd,
      item.explanationMd,
      item.storyPoints,
      item.estimateMinutes,
      item.difficulty,
      item.changes,
    ]),
  );
}

/** A short, stable string hash (FNV-1a, 32 bit) — the key is compared, never read. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── The ANNOUNCEMENT (§23.15) ────────────────────────────────────────────────

/** The plan's `add` proposals, by id — what an announcement counts. */
export function addedProposalIds(items: readonly PlanReviewItemDto[]): Set<string> {
  return new Set(items.filter((i) => i.op === 'add').map((i) => i.planItemId));
}

/** How many `add`s are in `next` and were not in `seen` — one batch's count. */
export function newlyAddedCount(seen: ReadonlySet<string>, next: ReadonlySet<string>): number {
  let n = 0;
  for (const id of next) if (!seen.has(id)) n += 1;
  return n;
}

// ── The ARRIVALS count (§23.7) ───────────────────────────────────────────────

/** One of the plan's cards as the arrivals count sees it. */
export interface LiveArrival {
  /** The proposal's own id — stable while the plan is written. */
  id: string;
  /** The LEVEL it sits on: a canvas focus id, or `null` for the top level. */
  levelId: string | null;
  /** The breadcrumb down to that level — where *Go there* drills. */
  trail: readonly CanvasCrumb[];
  /**
   * Whether FIRST SIGHT of it is an arrival. True for an `add`; a `modify` /
   * `remove` names a committed card, and "a committed card never arrives" — it
   * counts only when a later snapshot MOVES it to another level.
   */
  arrivesOnFirstSight: boolean;
}

/** The plan's cards, for the arrivals count. `proposedWord` is `planReview.proposedCrumb`. */
export function liveArrivals(
  items: readonly PlanReviewItemDto[],
  proposedWord: string,
): LiveArrival[] {
  const trails = new Map<string | null, readonly CanvasCrumb[]>();
  return items.map((item) => {
    const levelId = proposalLevelKey(item);
    let trail = trails.get(levelId);
    if (trail === undefined) {
      trail = levelTrail(items, levelId, proposedWord);
      trails.set(levelId, trail);
    }
    return { id: item.planItemId, levelId, trail, arrivesOnFirstSight: item.op === 'add' };
  });
}

/** An arrival the reader has not seen: on a level other than the one they stood on. */
export interface PendingArrival {
  id: string;
  levelId: string | null;
  trail: readonly CanvasCrumb[];
  /** Arrival order — the LATEST is what *Go there* goes to. */
  seq: number;
}

export interface ArrivalsLog {
  /** The snapshot last folded in — `null` until the first, which is the baseline. */
  source: readonly LiveArrival[] | null;
  /** Every card seen so far, and the level it was last seen on. */
  known: ReadonlyMap<string, string | null>;
  pending: readonly PendingArrival[];
  seq: number;
  /** The level the reader stood on when this was last folded. */
  viewing: string | null;
}

export const EMPTY_ARRIVALS: ArrivalsLog = {
  source: null,
  known: new Map(),
  pending: [],
  seq: 0,
  viewing: null,
};

/**
 * Fold one snapshot into the log. The FIRST snapshot is the baseline and counts
 * nothing — nothing ARRIVED while the reader watched (§23.4's "the first read of a
 * pane plays nothing", for the count). After that, a card seen for the first time
 * (an `add`) or seen on a different level (a move) ARRIVED on its level, and it is
 * pending unless that level is the one being viewed. A card that leaves the plan,
 * or moves again, stops being pending where it was.
 */
export function foldArrivals(
  log: ArrivalsLog,
  next: readonly LiveArrival[],
  viewing: string | null,
): ArrivalsLog {
  const known = new Map(next.map((a) => [a.id, a.levelId] as const));
  if (log.source === null) return { ...log, source: next, known, viewing };
  let seq = log.seq;
  const pending = new Map(log.pending.map((p) => [p.id, p]));
  for (const a of next) {
    const before = log.known.get(a.id);
    const arrived = before === undefined ? a.arrivesOnFirstSight : before !== a.levelId;
    if (!arrived) continue;
    if (a.levelId === viewing) pending.delete(a.id);
    else pending.set(a.id, { id: a.id, levelId: a.levelId, trail: a.trail, seq: (seq += 1) });
  }
  const kept = [...pending.values()].filter(
    (p) => known.has(p.id) && known.get(p.id) === p.levelId,
  );
  return { source: next, known, pending: kept, seq, viewing };
}

/** The reader stood on `levelId`: its count clears (§23.7 "visiting a level clears its count"). */
export function visitLevel(log: ArrivalsLog, levelId: string | null): ArrivalsLog {
  return {
    ...log,
    viewing: levelId,
    pending: log.pending.filter((p) => p.levelId !== levelId),
  };
}

/** What the pill says: how many, across how many levels, and the latest one. */
export function arrivalsSummary(
  pending: readonly PendingArrival[],
): { count: number; levels: number; latest: PendingArrival } | null {
  if (pending.length === 0) return null;
  let latest = pending[0]!;
  for (const p of pending) if (p.seq > latest.seq) latest = p;
  return {
    count: pending.length,
    levels: new Set(pending.map((p) => p.levelId)).size,
    latest,
  };
}

// ── The CHANGED highlight (MOTIR-11185) ──────────────────────────────────────
//
// The planner often goes back to a card it already drew — rewords a body, adds a
// criterion, moves an edge — and every such write records an `edited` trail row
// naming the proposal. The live read carries the newest one per item
// (`PlanReviewItemDto.lastEditedAt`), so a CHANGE is the same thing an arrival is:
// a diff of two snapshots. A card whose edit time moved past the one last seen is
// HIGHLIGHTED where it is drawn, and COUNTED in the arrivals slot when it sits on a
// level the reader is not looking at, until they go there — where it highlights.
//
// ⚠️ NEWS, LIKE AN ARRIVAL — and so kept in its own log rather than the drafting
// cues' present state: a change stays counted until its level is visited.

/** One of the plan's cards as the change log sees it. */
export interface LiveEdit {
  /** The proposal's own id — stable while the plan is written. */
  id: string;
  /** The canvas node it is drawn as (a `modify`'s target, an `add`'s own id). */
  nodeId: string;
  /** The LEVEL it sits on: a canvas focus id, or `null` for the top level. */
  levelId: string | null;
  /** The breadcrumb down to that level — where *Go there* drills. */
  trail: readonly CanvasCrumb[];
  /** Its newest `edited` time, or `null` when it was never edited. */
  editedAt: string | null;
  /** A `remove` is never highlighted: it is going, not changing. */
  highlightable: boolean;
}

/** The plan's cards, for the change log. `proposedWord` is `planReview.proposedCrumb`. */
export function liveEdits(items: readonly PlanReviewItemDto[], proposedWord: string): LiveEdit[] {
  const trails = new Map<string | null, readonly CanvasCrumb[]>();
  return items.map((item) => {
    const levelId = proposalLevelKey(item);
    let trail = trails.get(levelId);
    if (trail === undefined) {
      trail = levelTrail(items, levelId, proposedWord);
      trails.set(levelId, trail);
    }
    return {
      id: item.planItemId,
      nodeId: item.nodeId,
      levelId,
      trail,
      editedAt: item.lastEditedAt ?? null,
      highlightable: item.op !== 'remove',
    };
  });
}

/** A change the reader has not seen: on a level other than the one they stood on. */
export interface PendingChange {
  id: string;
  nodeId: string;
  levelId: string | null;
  trail: readonly CanvasCrumb[];
  /** Change order — the LATEST is what *Go there* goes to. */
  seq: number;
}

export interface ChangesLog {
  /** The snapshot last folded in — `null` until the first, which is the baseline. */
  source: readonly LiveEdit[] | null;
  /** Every card seen so far, and the newest edit time seen for it. */
  known: ReadonlyMap<string, string | null>;
  /** Changes on levels the reader is not on. */
  pending: readonly PendingChange[];
  /**
   * The nodes highlighted RIGHT NOW, each with the `seq` of the change that lit
   * it. A second change gives a node a new `seq`, which restarts its highlight
   * rather than stacking a second one; {@link expireHighlight} takes it off.
   */
  highlights: ReadonlyMap<string, number>;
  seq: number;
  /** The level the reader stood on when this was last folded. */
  viewing: string | null;
}

export const EMPTY_CHANGES: ChangesLog = {
  source: null,
  known: new Map(),
  pending: [],
  highlights: new Map(),
  seq: 0,
  viewing: null,
};

/**
 * How long a changed card stays lit, in ms — long enough to be seen across a poll
 * (the review read polls every few seconds), short enough to read as "just now".
 * The canvas sets the ring's animation to it and clears the highlight after it.
 */
export const CHANGED_HIGHLIGHT_MS = 3000;

/** Whether `next` is a strictly newer instant than `seen` (either may be null). */
function isNewerEdit(seen: string | null, next: string | null): boolean {
  if (next === null) return false;
  if (seen === null) return true;
  return Date.parse(next) > Date.parse(seen);
}

/**
 * Fold one snapshot into the change log. The FIRST snapshot is the baseline and
 * changes nothing: edits that already exist when the canvas mounts are history,
 * not news. After that, a KNOWN card whose edit time moved forward CHANGED — it is
 * highlighted when it sits on the level being viewed, else pending there. A card
 * seen for the first time is an ARRIVAL (the arrivals log's), never a change,
 * whatever edits it already carries. A pending change whose card left the plan is
 * dropped; one whose card moved follows it to its new level.
 */
export function foldChanges(
  log: ChangesLog,
  next: readonly LiveEdit[],
  viewing: string | null,
): ChangesLog {
  const known = new Map(next.map((e) => [e.id, e.editedAt] as const));
  if (log.source === null) return { ...log, source: next, known, viewing };
  let seq = log.seq;
  const byId = new Map(next.map((e) => [e.id, e] as const));
  const pending = new Map(log.pending.map((p) => [p.id, p]));
  const highlights = new Map(log.highlights);
  for (const e of next) {
    if (!log.known.has(e.id)) continue;
    if (!e.highlightable || !isNewerEdit(log.known.get(e.id) ?? null, e.editedAt)) continue;
    seq += 1;
    if (e.levelId === viewing) {
      pending.delete(e.id);
      highlights.set(e.nodeId, seq);
    } else {
      pending.set(e.id, { id: e.id, nodeId: e.nodeId, levelId: e.levelId, trail: e.trail, seq });
    }
  }
  const kept: PendingChange[] = [];
  for (const p of pending.values()) {
    const now = byId.get(p.id);
    if (!now || !now.highlightable) continue;
    kept.push(
      now.levelId === p.levelId && now.nodeId === p.nodeId
        ? p
        : { ...p, nodeId: now.nodeId, levelId: now.levelId, trail: now.trail },
    );
  }
  // A highlight whose card has left the plan has nothing left to light.
  const liveNodes = new Set(next.map((e) => e.nodeId));
  for (const nodeId of [...highlights.keys()]) {
    if (!liveNodes.has(nodeId)) highlights.delete(nodeId);
  }
  return { source: next, known, pending: kept, highlights, seq, viewing };
}

/**
 * The reader stood on `levelId`: the changes pending there are no longer news
 * elsewhere — they HIGHLIGHT here, so *Go there* lands on the card lit.
 */
export function visitChangesLevel(log: ChangesLog, levelId: string | null): ChangesLog {
  const here = log.pending.filter((p) => p.levelId === levelId);
  if (here.length === 0) return { ...log, viewing: levelId };
  const highlights = new Map(log.highlights);
  let seq = log.seq;
  for (const p of [...here].sort((a, b) => a.seq - b.seq)) highlights.set(p.nodeId, (seq += 1));
  return {
    ...log,
    viewing: levelId,
    seq,
    highlights,
    pending: log.pending.filter((p) => p.levelId !== levelId),
  };
}

/**
 * A highlight ran its course: drop it — unless a later change re-lit the node
 * (a different `seq`), in which case that newer highlight stands.
 */
export function expireHighlight(log: ChangesLog, nodeId: string, seq: number): ChangesLog {
  if (log.highlights.get(nodeId) !== seq) return log;
  const highlights = new Map(log.highlights);
  highlights.delete(nodeId);
  return { ...log, highlights };
}

/**
 * What the slot says of the changes: how many, across how many levels, and the
 * latest one. A card ALSO pending as an arrival (`arrived`) is counted there only
 * — it is new to the reader, which outranks having changed since.
 */
export function changesSummary(
  pending: readonly PendingChange[],
  arrived: ReadonlySet<string> = new Set(),
): { count: number; levels: number; latest: PendingChange } | null {
  const counted = pending.filter((p) => !arrived.has(p.id));
  if (counted.length === 0) return null;
  let latest = counted[0]!;
  for (const p of counted) if (p.seq > latest.seq) latest = p;
  return {
    count: counted.length,
    levels: new Set(counted.map((p) => p.levelId)).size,
    latest,
  };
}

// ── The IN-FLIGHT cues (Story MOTIR-7820 · MOTIR-7830; Part XXVI §26.6–26.7) ──
//
// ⚠️ A PRESENT STATE, NOT AN EVENT — and so kept OUT of the arrivals log above.
// An arrival is news that stays counted until the reader visits its level; a cue
// is "the planner is writing this now", counted from the CURRENT live steps on
// every render. A cue that leaves stops being counted at once, with nothing to
// clear. The steps themselves are the derivation's (`readPlanProgress`'s
// `liveSteps`): withdrawn targets and quiet sessions are already gone, so nothing
// here filters, ages or compares a time.

/** What a step marks. `author` → the item being DRAFTED; `lay` → the parent whose
 *  children are being LAID. */
export type InFlightCueKind = 'drafting' | 'laying';

/** One cue as the canvas's arrivals slot sees it: the node it marks, and the
 *  trail *Go there* drills to see it — the item's own level for `drafting`, the
 *  parent's own level (where its children land) for `laying`. */
export interface InFlightCue {
  nodeId: string;
  kind: InFlightCueKind;
  trail: readonly CanvasCrumb[];
}

/** The fields of a live step the mapping reads (`PlanProgressStep`'s). */
export interface InFlightStep {
  kind: PlanStepKindDto;
  targetNodeId: string | null;
}

/**
 * THE LEVEL A STEP NAMES (MOTIR-8592) — the one rule the cues, *Go there* and the
 * planner-driven canvas share, so "where is this step?" has a single answer.
 *
 * - `author`, and a final-check session's `check` (MOTIR-11256) → the level the
 *   target item SITS on: its parent's children, or the top level (`levelId: null`,
 *   `trail: []`) for a root item.
 * - `lay`, and a level's `amend` (MOTIR-11256) → the target's OWN children level,
 *   and only when the plan's items can place it: some item sits on that level and
 *   the trail ends at the node.
 * - `settle`, `repair` (the fix names no level of its own), a step with no target,
 *   or a target the items do not hold → `null`.
 */
export function stepLevel(
  items: readonly PlanReviewItemDto[],
  step: InFlightStep,
  proposedWord: string,
): { levelId: string | null; trail: CanvasCrumb[] } | null {
  if (step.kind === 'settle' || step.kind === 'repair' || step.targetNodeId === null) {
    return null;
  }
  const nodeId = step.targetNodeId;
  if (step.kind === 'author' || step.kind === 'check') {
    const item = items.find((i) => i.nodeId === nodeId);
    if (!item) return null;
    const levelId = proposalLevelKey(item);
    return { levelId, trail: levelTrail(items, levelId, proposedWord) };
  }
  if (!items.some((i) => proposalLevelKey(i) === nodeId)) return null;
  const trail = levelTrail(items, nodeId, proposedWord);
  if (trail[trail.length - 1]?.id !== nodeId) return null;
  return { levelId: nodeId, trail };
}

/**
 * Map the live steps to cues. A `settle` step, and any step with no target node
 * (the untargeted lay and author), mark nothing (§26.6: an item not yet on the
 * plan has no cell). Only a `lay` draws the laying cue and only an `author` the
 * drafting one: an `amend` reconciles a level already laid, a `check` reviews a
 * card already written and a `repair` names no card, so none of them says a level
 * is being laid (MOTIR-11256; the final check's own Checking cue is MOTIR-11254's).
 * Several steps → several cues; one node named by both kinds is `drafting`. `inFlight` holds one entry per cue whose level the plan's items
 * can place ({@link stepLevel}) — a committed target the walk has not written a
 * `modify` for, or a parent with no child proposed yet, keeps its node cue
 * wherever it is drawn and adds no entry, because *Go there* would have nowhere to
 * go. Order: the steps' (earliest first).
 */
export function inFlightCues(
  items: readonly PlanReviewItemDto[],
  steps: readonly InFlightStep[],
  proposedWord: string,
): { cues: Map<string, InFlightCueKind>; inFlight: InFlightCue[] } {
  const cues = new Map<string, InFlightCueKind>();
  for (const step of steps) {
    if (step.targetNodeId === null) continue;
    if (step.kind !== 'author' && step.kind !== 'lay') continue;
    const kind: InFlightCueKind = step.kind === 'author' ? 'drafting' : 'laying';
    if (cues.get(step.targetNodeId) !== 'drafting') cues.set(step.targetNodeId, kind);
  }
  const inFlight: InFlightCue[] = [];
  for (const [nodeId, kind] of cues) {
    const level = stepLevel(
      items,
      { kind: kind === 'drafting' ? 'author' : 'lay', targetNodeId: nodeId },
      proposedWord,
    );
    if (level) inFlight.push({ nodeId, kind, trail: level.trail });
  }
  return { cues, inFlight };
}

/**
 * The cues the reader CANNOT see: the node is not on the drawn level, and it is
 * not a `laying` cue on the level the reader stands in (that one is the bar's
 * marker, §26.7 row 2).
 */
export function offLevelInFlight(
  inFlight: readonly InFlightCue[],
  drawnIds: ReadonlySet<string>,
  focusId: string | null,
): InFlightCue[] {
  return inFlight.filter(
    (c) => !drawnIds.has(c.nodeId) && !(c.kind === 'laying' && c.nodeId === focusId),
  );
}

/** What the ONE arrivals slot says (§26.7's table) — a copy key under
 *  `planningWorkspace.arrival`, its counts, and the trail *Go there* drills. */
export type LiveSlot =
  | { key: 'arrivedIn' | 'arrivedAcross'; count: number; trail: readonly CanvasCrumb[] }
  | { key: 'changedIn' | 'changedAcross'; count: number; trail: readonly CanvasCrumb[] }
  | { key: 'newAndChangedIn'; arrived: number; changed: number; trail: readonly CanvasCrumb[] }
  | { key: 'draftingIn' | 'draftingAcross'; count: number; trail: readonly CanvasCrumb[] }
  | { key: 'layingIn'; trail: readonly CanvasCrumb[] }
  | { key: 'newAndDraftingIn'; arrived: number; drafting: number; trail: readonly CanvasCrumb[] };

const levelOfTrail = (trail: readonly CanvasCrumb[]): string | null =>
  trail[trail.length - 1]?.id ?? null;

/**
 * The slot's wording, by §26.7's precedence. Arrivals are NEWS and in-flight
 * steps are STATE, so arrivals win the slot — except when arrivals and drafting
 * steps are on the SAME one level, which reads as one combined sentence. With no
 * arrivals: drafting on one level, drafting across several (named by the
 * earliest), then a lay. *Go there* goes to the latest arrival's level, else the
 * earliest in-flight step's. (The follow offer outranks all of it — the caller's.)
 *
 * CHANGES (MOTIR-11185) are news too, counted SEPARATELY from arrivals: arrivals
 * and changes all on ONE level read as one sentence (*N new · M changed in X*);
 * otherwise arrivals keep the slot, and with none the changes take it — on one
 * level, or across several named by the latest — ahead of the in-flight state.
 */
export function liveSlot(
  arrivals: { count: number; levels: number; latest: PendingArrival } | null,
  offLevel: readonly InFlightCue[],
  changes: { count: number; levels: number; latest: PendingChange } | null = null,
): LiveSlot | null {
  const drafting = offLevel.filter((c) => c.kind === 'drafting');
  const draftLevels = new Set(drafting.map((c) => levelOfTrail(c.trail)));
  if (
    arrivals &&
    changes &&
    arrivals.levels === 1 &&
    changes.levels === 1 &&
    arrivals.latest.levelId === changes.latest.levelId
  ) {
    return {
      key: 'newAndChangedIn',
      arrived: arrivals.count,
      changed: changes.count,
      trail: arrivals.latest.trail,
    };
  }
  if (arrivals) {
    if (
      arrivals.levels === 1 &&
      drafting.length > 0 &&
      draftLevels.size === 1 &&
      draftLevels.has(arrivals.latest.levelId)
    ) {
      return {
        key: 'newAndDraftingIn',
        arrived: arrivals.count,
        drafting: drafting.length,
        trail: arrivals.latest.trail,
      };
    }
    return {
      key: arrivals.levels > 1 ? 'arrivedAcross' : 'arrivedIn',
      count: arrivals.count,
      trail: arrivals.latest.trail,
    };
  }
  if (changes) {
    return {
      key: changes.levels > 1 ? 'changedAcross' : 'changedIn',
      count: changes.count,
      trail: changes.latest.trail,
    };
  }
  const first = drafting[0];
  if (first) {
    return {
      key: draftLevels.size > 1 ? 'draftingAcross' : 'draftingIn',
      count: drafting.length,
      trail: first.trail,
    };
  }
  const lay = offLevel.find((c) => c.kind === 'laying');
  return lay ? { key: 'layingIn', trail: lay.trail } : null;
}
