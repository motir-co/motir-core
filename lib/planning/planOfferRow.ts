// THE PLAN OFFER ROW's pure decisions (Story MOTIR-9219 · MOTIR-9294; design
// `design/ai-chat/plan-offer.mock.html`). No React: what the rail may press, and
// which catalogue line a served code resolves to.
//
// ⚠️ TOTAL MAPS. The `cannotStart` code and a door's refusal code cross the wire
// from services this row does not own, so an unrecognised value resolves to the
// generic line — never to a plausible real reason (`MidRunTurn`'s `refusalKey`
// idiom).

import { pendingPlanOfferOf, type PlanOfferTurn } from '@/lib/planChange/planOffer';
import type { PlanChangePhase } from '@/lib/hooks/usePlanChangeConversation';

/** What the row needs besides the thread to know whether its offer is pressable. */
export interface OfferAnswerableContext {
  /** The viewer may continue this conversation (not read-only, not ended). */
  canContinue: boolean;
  /** The host passed both answers. */
  hasActions: boolean;
}

/**
 * The offer on `turns[index]` may be pressed: its served state is `undecided`,
 * it IS the thread's live offer (`pendingPlanOfferOf` — a lagging stored write
 * cannot leave two live Confirms on one thread), and the viewer and host can
 * answer it. The served state alone decides what the row SAYS; this only decides
 * whether its controls exist.
 */
export function offerAnswerable(
  turns: readonly (PlanOfferTurn & { offer?: { state?: string } | null })[],
  index: number,
  ctx: OfferAnswerableContext,
): boolean {
  const turn = turns[index];
  if (!turn || turn.role !== 'assistant' || turn.offer?.state !== 'undecided') return false;
  if (!ctx.canContinue || !ctx.hasActions) return false;
  return pendingPlanOfferOf(turns)?.turnId === turn.id;
}

/** How an offer that cannot start is drawn — the design's three outcomes. */
export type CannotStartLine =
  | { kind: 'reason'; key: 'planningUnavailable' | 'outOfCredits' | 'generic' }
  | { kind: 'beingPlanned' };

const CANNOT_START_LINE: Record<string, CannotStartLine> = {
  planning_unavailable: { kind: 'reason', key: 'planningUnavailable' },
  out_of_credits: { kind: 'reason', key: 'outOfCredits' },
  // A target being planned right now is not a reason line: Motir AI says it is
  // being planned (design sheet 4).
  target_held: { kind: 'beingPlanned' },
  // `target_closed` is deliberately absent: a closed target is a conversation and
  // never an offer (design, second review), so a served one draws the generic line.
};

/** The line a served `cannotStart` code draws; generic for anything unrecognised. */
export function cannotStartKey(code: string): CannotStartLine {
  return Object.hasOwn(CANNOT_START_LINE, code)
    ? CANNOT_START_LINE[code]!
    : { kind: 'reason', key: 'generic' };
}

/** The refused-press line keys under `planningWorkspace.planOffer.cannotStart`. */
export type AnswerRefusalKey = 'outOfCredits' | 'targetUnavailable' | 'generic';

const ANSWER_REFUSAL_KEY: Record<string, AnswerRefusalKey> = {
  MOTIR_AI_OUT_OF_CREDITS: 'outOfCredits',
  out_of_credits: 'outOfCredits',
  target_not_available: 'targetUnavailable',
};

/** The line a refused Confirm or Decline draws in place of the actions. `code` is
 *  the door's refusal reason (or its error code); generic for anything else. */
export function answerRefusalKey(code: string): AnswerRefusalKey {
  return Object.hasOwn(ANSWER_REFUSAL_KEY, code) ? ANSWER_REFUSAL_KEY[code]! : 'generic';
}

/** The conversation already plans something — a run in flight, a plan Motir is
 *  still writing, or a plan still waiting for its decision — so the offer draws
 *  its mid-planning variant. A reopened conversation whose plan is still being
 *  written holds it as the live review with an idle phase, so `writingPlan` is
 *  what says so there. */
export function alreadyPlanning({
  phase,
  hasUndecidedPlan,
  writingPlan = false,
}: {
  phase: PlanChangePhase;
  hasUndecidedPlan: boolean;
  writingPlan?: boolean;
}): boolean {
  return phase === 'streaming' || phase === 'deciding' || hasUndecidedPlan || writingPlan;
}

/** The refused-press line keys under `planningWorkspace.logBugOffer.cannotStart`. */
export type LogBugRefusalKey =
  | 'planningUnavailable'
  | 'targetChanged'
  | 'targetUnavailable'
  | 'anchorNotTriage'
  | 'generic';

const LOG_BUG_REFUSAL_KEY: Record<string, LogBugRefusalKey> = {
  // The landing's own refusals (MOTIR-9323), each written before anything was.
  DEBUG_TARGET_CHANGED: 'targetChanged',
  NOT_FOUND: 'targetUnavailable',
  DEBUG_ANCHOR_NOT_TRIAGE_BUG: 'anchorNotTriage',
  PERMISSION_DENIED: 'planningUnavailable',
  planning_unavailable: 'planningUnavailable',
};

/** The line a refused Confirm of a `log_bug` offer draws (MOTIR-9324), or a served
 *  `cannotStart`; generic for anything else. */
export function logBugRefusalKey(code: string): LogBugRefusalKey {
  return Object.hasOwn(LOG_BUG_REFUSAL_KEY, code) ? LOG_BUG_REFUSAL_KEY[code]! : 'generic';
}
