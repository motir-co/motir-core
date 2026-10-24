// THE PLAN OFFER'S LIFECYCLE, the pure half (Story MOTIR-9219 · MOTIR-9290; ADR
// conversation-turn-intent AMENDMENT 5 · MOTIR-9215). An answer turn may end with ONE
// stored offer to plan (`PlanChangeTurnDto.offer`, MOTIR-9288). Which offer on a thread
// is live, and why one cannot start, is DERIVED here from the thread, so the settle,
// the Decline door, the ask submit and the rail all read ONE rule.
//
// ── STORED VERSUS DERIVED ───────────────────────────────────────────────────────
// Two dispositions are WRITTEN: `declined` (the Decline door) and `confirmed` (One
// start per offer). The other two are READ from the thread's shape and never written:
//
//   - `confirmed`  — `confirmedSessionId` (or `confirmedAt`) is set; it STAYS
//                    confirmed after a later answer;
//   - `declined`   — `declinedAt` is set;
//   - `superseded` — ANY later assistant turn exists, offer-bearing or not;
//   - `undecided`  — none of the above.
//
// The precedence is `lib/planning/guideReplanOffer.ts`'s, with one deliberate
// difference: the guide's offer is superseded only by a LATER OFFER, this one by any
// later answer. A newer answer that chose not to offer is the answering session's
// judgement that the offer no longer stands. Getting the split backwards (deriving a
// stored state, or storing a derived one) would let a replayed settle or a reload
// resurrect a declined offer, so nothing here writes.

/** The four states an offer can be in — the same four `GuideReplanOfferState` has. */
import type { SubmittedRequirement } from '@/lib/ai/types';

export type PlanOfferState = 'undecided' | 'superseded' | 'declined' | 'confirmed';

/** Why an offer cannot start. A CLOSED set, defined here, in its fixed order. */
export type PlanOfferCannotStart =
  | 'planning_unavailable'
  | 'target_closed'
  | 'target_held'
  | 'out_of_credits';

/**
 * The order the reasons are tried in. When two causes hold at once the first wins,
 * on every read, so the line a surface draws cannot flip between renders. A person
 * who may not plan is told that before anything about the target; a target that is
 * closed is told before one that is merely busy; credits come last because they are
 * only known from a refused start.
 */
export const PLAN_OFFER_CANNOT_START_ORDER: readonly PlanOfferCannotStart[] = [
  'planning_unavailable',
  'target_closed',
  'target_held',
  'out_of_credits',
];

/** The stored offer's fields this reads (a `PlanAnswerOfferDto` fits). */
export interface PlanOfferRecord {
  kind: string;
  requestMd: string;
  targetKey: string | null;
  /** The composed requirement a no-target `plan` offer carries (MOTIR-9432). */
  requirement?: SubmittedRequirement;
  declinedAt: string | null;
  confirmedAt: string | null;
  confirmedSessionId: string | null;
  /** A `log_bug` offer's write (MOTIR-9322): where it goes, read to state it. */
  bug?: { target: { kind: string; key: string | null } };
}

/** The slice of a thread turn this reads (a `PlanChangeTurnDto` fits). */
export interface PlanOfferTurn {
  id: string;
  seq: number;
  role: string;
  offer?: PlanOfferRecord | null;
}

function offerOf(turn: PlanOfferTurn): PlanOfferRecord | null {
  return turn.role === 'assistant' ? (turn.offer ?? null) : null;
}

function isConfirmed(offer: PlanOfferRecord): boolean {
  return offer.confirmedSessionId !== null || offer.confirmedAt !== null;
}

/** `turnId`'s offer state, or null when that turn holds no offer. `turns` is the
 *  thread in order, oldest first. */
export function planOfferStateOf(
  turns: readonly PlanOfferTurn[],
  turnId: string,
): PlanOfferState | null {
  const at = turns.findIndex((t) => t.id === turnId);
  const offer = at < 0 ? null : offerOf(turns[at]!);
  if (!offer) return null;
  // Precedence: confirmed > declined > superseded > undecided.
  if (isConfirmed(offer)) return 'confirmed';
  if (offer.declinedAt !== null) return 'declined';
  return turns.slice(at + 1).some((t) => t.role === 'assistant') ? 'superseded' : 'undecided';
}

/** The live offer: the LATEST assistant turn's, exactly when it carries one with no
 *  disposition. Agrees with {@link planOfferStateOf} reading `undecided` on that turn. */
export function pendingPlanOfferOf(
  turns: readonly PlanOfferTurn[],
): { turnId: string; seq: number; offer: PlanOfferRecord } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.role !== 'assistant') continue;
    // Only the latest assistant turn can hold the live offer: any later answer
    // supersedes an earlier one, so there is nothing further back to find.
    const offer = offerOf(turn);
    if (!offer || isConfirmed(offer) || offer.declinedAt !== null) return null;
    return { turnId: turn.id, seq: turn.seq, offer };
  }
  return null;
}

/** The facts the reasons are resolved from, each read live by the caller. */
export interface CannotStartInput {
  /** The caller holds `ai:plan` and `work_item:edit`, and Motir AI is configured. */
  planningAvailable: boolean;
  /** The offer's stored target sits at a done-category status (done or cancelled). */
  targetClosed: boolean;
  /** The target carries an unexpired lock held by another session or by a plan. */
  targetHeld: boolean;
  /** A start of this offer was refused for credits, and that was recorded. */
  outOfCredits: boolean;
}

/** The first reason that holds, in {@link PLAN_OFFER_CANNOT_START_ORDER}; null when
 *  none does. */
export function cannotStartOf(input: CannotStartInput): PlanOfferCannotStart | null {
  for (const reason of PLAN_OFFER_CANNOT_START_ORDER) {
    if (holds(reason, input)) return reason;
  }
  return null;
}

function holds(reason: PlanOfferCannotStart, input: CannotStartInput): boolean {
  switch (reason) {
    case 'planning_unavailable':
      return !input.planningAvailable;
    case 'target_closed':
      return input.targetClosed;
    case 'target_held':
      return input.targetHeld;
    case 'out_of_credits':
      return input.outOfCredits;
  }
}

/** A refused start recorded on the stored offer (`recordCannotStart`). It rides the
 *  offer's JSON beside the store card's eight keys and is not part of the DTO: it
 *  is read only to serve `cannotStart`. */
export interface RecordedStartRefusal {
  reason: 'out_of_credits';
  detail: string | null;
  at: string;
}

/** The recorded refusal on a stored offer's raw JSON, or null. Total over any value. */
export function recordedRefusalOf(raw: unknown): RecordedStartRefusal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const refusal = (raw as Record<string, unknown>)['startRefusal'];
  if (!refusal || typeof refusal !== 'object' || Array.isArray(refusal)) return null;
  const r = refusal as Record<string, unknown>;
  if (r['reason'] !== 'out_of_credits' || typeof r['at'] !== 'string') return null;
  return {
    reason: 'out_of_credits',
    detail: typeof r['detail'] === 'string' ? r['detail'] : null,
    at: r['at'],
  };
}
