// THE START PROMPT (MOTIR-10624; design MOTIR-10623,
// `design/ai-chat/design-notes.md` § *The planner asks to start planning when the
// overlay opens from a card's Plan / Re-plan button*, with
// `design/ai-chat/planning-workspace--start-from-card.mock.html`).
//
// A launch from a card's Plan / Re-plan button (`WorkItemPlanEntrance`) opens the
// rail on a planner message that ASKS, with one Start button — instead of an
// empty conversation that waits for the person to type "plan it". This module is
// the prompt's PURE core: the one first turn both controls send, and the state the
// prompt is in, DERIVED FROM THE THREAD so a reload draws the same thing.
//
// It is framework-free on purpose, like `launcher.ts`: the rail and the tests
// read the same derivation.

import type { PlanningTarget } from '@/lib/planning/planningTargets';

/** Which of the button's two faces launched the overlay: the card has no plan
 *  yet (`plan`) or already has children (`replan`) — `WorkItemPlanEntrance`'s
 *  own split, carried on the address as the mode. */
export type PlanStartFace = 'plan' | 'replan';

/** What the overlay hands the rail once the anchor RESOLVED for this viewer. */
export interface PlanStartPromptSpec {
  /** The card the prompt names — the resolved anchor. */
  target: PlanningTarget;
  face: PlanStartFace;
  /** The page-level claim the start is held under (`claimPickAutoSend`), one per
   *  anchor, so a remount or a double press cannot send it twice. */
  claimKey: string;
}

/**
 * The state the prompt is drawn in (design panels 2–6):
 *
 * - `live` — no user turn yet: the question, Start, and the help line.
 * - `starting` — Start (or Send) was pressed and the turn is not accepted yet:
 *   the button's loading state, the composer held.
 * - `spent` — the thread's FIRST user turn is the start turn: the question stays
 *   as the record of what was asked, with the *Planning started* chip.
 */
export type PlanStartPhase = 'live' | 'starting' | 'spent';

/** The page-level claim key for an anchor's confirmed start. Distinct from the
 *  expansion nudge's `start:<KEY>` so the two doors never spend each other's. */
export function planStartClaimKey(identifier: string): string {
  return `confirm-start:${identifier}`;
}

/**
 * The ONE first turn Start and Send both send (design panel 4): the start line
 * alone, or — when the person typed conditions — the line, a blank line, then
 * their text verbatim. The shipped multi-line user bubble keeps the break.
 */
export function composeStartTurn(startLine: string, extra: string): string {
  const typed = extra.trim();
  return typed === '' ? startLine : `${startLine}\n\n${typed}`;
}

/** Whether a sent turn is this prompt's start turn — with or without conditions. */
export function isStartTurn(body: string, startLine: string): boolean {
  return body === startLine || body.startsWith(`${startLine}\n\n`);
}

/**
 * The prompt's phase, or `null` when the rail draws today's opener instead.
 *
 * `null` for a thread whose first user turn is NOT the start turn: that is a
 * conversation the person began some other way, and the prompt would be a
 * question nobody asked. A thread whose first turn IS the start turn is `spent`
 * whatever this page did, which is what makes a reload draw the same chip.
 */
export function planStartPhase(input: {
  userTurnBodies: readonly string[];
  startLine: string;
  starting: boolean;
}): PlanStartPhase | null {
  const [first] = input.userTurnBodies;
  if (first === undefined) return input.starting ? 'starting' : 'live';
  return isStartTurn(first, input.startLine) ? 'spent' : null;
}
