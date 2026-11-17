import type { SessionTurnPlanStatus } from '@/lib/planChange/classifySessionTurn';

// PLANNING SOMETHING ELSE MID-PLANNING, the pure half (Story MOTIR-9219 · MOTIR-9293;
// ADR conversation-turn-intent AMENDMENT 5 clause 7). A confirmed plan offer on a
// conversation that already holds an undecided plan must NOT go through `submit`:
// `submit` would revise a `planned` plan, answer a `stale` one in words, or queue onto a
// running revision — the wrong plan, and a second job on a session that already plans.
// So the confirm asks this which route a start takes, and a mid-planning confirm ends
// the session through the shipped restart lifecycle before starting the request on the
// session that follows it.

/** Which route a confirmed offer's start takes on its addressed session. */
export type PlanOfferStartPath = 'restart' | 'submit' | 'decided' | 'no-start';

/**
 * The route, from the facts that decide it. A session a plan DECISION ended (`approved`
 * or `declined`) takes `decided` (MOTIR-11521): the start opens a new conversation of its
 * scope and the decided one stays ended — the caller admits only an offer of a kept
 * too-far request there. Any other ENDED session starts nothing, whatever its plan (the
 * confirm already happened, or the session expired). An open one restarts when it holds
 * an undecided plan — `generating`, `planned` or `stale`, each of which `submit` routes
 * away from a new plan — and submits when it holds none.
 */
export function planOfferStartPath(input: {
  endedAt: Date | string | null;
  endReason?: string | null;
  latestUndecidedStatus: SessionTurnPlanStatus | null;
}): PlanOfferStartPath {
  if (input.endedAt !== null) {
    return input.endReason === 'approved' || input.endReason === 'declined'
      ? 'decided'
      : 'no-start';
  }
  return input.latestUndecidedStatus === null ? 'submit' : 'restart';
}

/** The idempotency key of the Stop a mid-planning restart records for the run it ends:
 *  one per offer, so a replayed confirm records no second stop. */
export function offerRestartStopKey(offerRef: string): string {
  return `plan-offer-restart:${offerRef}`;
}
