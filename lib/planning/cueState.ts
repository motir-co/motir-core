import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { InFlightStep } from '@/lib/planning/livePane';
import { proposalLevelKey } from '@/lib/planning/planShape';

// WHAT THE PLANNER IS DOING TO A CARD (Task MOTIR-11254; design
// `design/ai-planning/design-notes.md` Part XXXI §31.1, §31.4).
//
// One derivation, every surface — the canvas node box, the bar, the list row and
// the quick view all read the state this module decides:
//
//   - **Checking** — the final check's step (`check`) targets the card;
//   - **Drafting** — an `author` step targets it AND the live read's
//     `inFlightDrafts` holds an entry for it with at least one of its three fields
//     not null (an empty string counts);
//   - **Thinking** — an `author` step targets it and there is no such draft.
//
// Checking wins over Drafting, Drafting over Thinking (the latest stage shows). A
// draft with no `author` step targeting its card draws nothing. A `check` step
// whose target holds other proposals on its own children level is the CONTAINER
// review (§31.5): the story's node and the bar read it, the list does not.
//
// THE ANTI-FLICKER HOLD (§31.4 T3): a card that showed Drafting keeps Drafting
// through ONE read that arrives without its draft, and falls back to Thinking on
// the second such read in a row. Reads are counted by the `read` token the host
// passes — a value that changes exactly when a read ARRIVES (the live poll's
// `reads` count; never the drafts array, whose reference `mergePlanReview` keeps
// while it is equal) — so a dropped read, a stall, or a re-render on the
// clock's tick never advances it. The hold never outlives the step: a card no
// step targets leaves at once (T5).
//
// PURE: no React, no I/O.

/** The three states of the planner's cue on a card. */
export type CardCueState = 'thinking' | 'drafting' | 'checking';

/** One read's derived cues, keyed by canvas node id (`PlanReviewItemDto.nodeId`). */
export interface CardCues {
  /** Every card a step marks, with its state. */
  states: ReadonlyMap<string, CardCueState>;
  /** The `checking` nodes that are a CONTAINER review (§31.5) — a subset of `states`. */
  containers: ReadonlySet<string>;
}

export const NO_CARD_CUES: CardCues = { states: new Map(), containers: new Set() };

/** A draft that carries text (§31.1: at least one field not null). */
function hasText(draft: PlanItemDraftDto): boolean {
  return draft.title !== null || draft.descriptionMd !== null || draft.explanationMd !== null;
}

const RANK: Record<CardCueState, number> = { thinking: 0, drafting: 1, checking: 2 };

/**
 * One read's cues, before the hold — from the live steps and the read's drafts.
 * A draft is matched to its card through the plan's items (`planItemId` →
 * `nodeId`), the same rule the canvas places the card by.
 */
export function deriveCardCues(
  items: readonly PlanReviewItemDto[],
  steps: readonly InFlightStep[] | null | undefined,
  drafts?: readonly PlanItemDraftDto[] | null,
): CardCues {
  if (!steps || steps.length === 0) return NO_CARD_CUES;
  const nodeOf = new Map(items.map((i) => [i.planItemId, i.nodeId]));
  const drafted = new Set<string>();
  for (const draft of drafts ?? []) {
    if (!hasText(draft)) continue;
    drafted.add(nodeOf.get(draft.planItemId) ?? draft.planItemId);
  }
  const states = new Map<string, CardCueState>();
  const containers = new Set<string>();
  for (const step of steps) {
    const nodeId = step.targetNodeId;
    if (nodeId === null) continue;
    let state: CardCueState;
    if (step.kind === 'check') state = 'checking';
    else if (step.kind === 'author') state = drafted.has(nodeId) ? 'drafting' : 'thinking';
    else continue;
    const prev = states.get(nodeId);
    if (prev === undefined || RANK[state] > RANK[prev]) states.set(nodeId, state);
    if (state === 'checking' && items.some((i) => proposalLevelKey(i) === nodeId)) {
      containers.add(nodeId);
    }
  }
  if (states.size === 0) return NO_CARD_CUES;
  return { states, containers };
}

/** The hold's memory across reads. */
export interface CardCueHold {
  /** The read token the last fold saw. */
  read: unknown;
  /** What each card shows. */
  cues: CardCues;
  /** Per card held at Drafting: how many arrived reads in a row carried no draft. */
  misses: ReadonlyMap<string, number>;
}

export const EMPTY_HOLD: CardCueHold = { read: undefined, cues: NO_CARD_CUES, misses: new Map() };

/**
 * Fold one derivation into the hold (§31.4 T3 / T4). Returns `prev` itself when
 * nothing a reader can see changed, so a host can compare by reference.
 */
export function holdCardCues(prev: CardCueHold, next: CardCues, read: unknown): CardCueHold {
  const arrived = read !== prev.read;
  const states = new Map<string, CardCueState>();
  const misses = new Map<string, number>();
  for (const [nodeId, state] of next.states) {
    const shown = prev.cues.states.get(nodeId);
    if (state === 'thinking' && shown === 'drafting') {
      // A missed read: the first is HELD; the second in a row falls back.
      const count = (prev.misses.get(nodeId) ?? 0) + (arrived ? 1 : 0);
      if (count < 2) {
        states.set(nodeId, 'drafting');
        misses.set(nodeId, Math.max(count, 1));
        continue;
      }
    }
    states.set(nodeId, state);
  }
  const cues: CardCues = states.size === 0 ? NO_CARD_CUES : { states, containers: next.containers };
  if (
    sameStates(prev.cues.states, cues.states) &&
    sameSet(prev.cues.containers, cues.containers) &&
    sameMisses(prev.misses, misses)
  ) {
    return prev.read === read ? prev : { ...prev, read };
  }
  return { read, cues, misses };
}

function sameStates(a: ReadonlyMap<string, CardCueState>, b: ReadonlyMap<string, CardCueState>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function sameMisses(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * The cues by PROPOSAL (`planItemId`) — what the list row and the quick view look
 * a card up by. `rows` leaves the container review out (§31.6: the story is not a
 * row of its own proposals list); `peek` keeps it (§31.7: the check targets it).
 */
export function cuesByProposal(
  items: readonly PlanReviewItemDto[],
  cues: CardCues,
): { rows: ReadonlyMap<string, CardCueState>; peek: ReadonlyMap<string, CardCueState> } {
  const rows = new Map<string, CardCueState>();
  const peek = new Map<string, CardCueState>();
  if (cues.states.size === 0) return { rows, peek };
  for (const item of items) {
    const state = cues.states.get(item.nodeId);
    if (!state) continue;
    peek.set(item.planItemId, state);
    if (!cues.containers.has(item.nodeId)) rows.set(item.planItemId, state);
  }
  return { rows, peek };
}
