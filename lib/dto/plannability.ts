// THE PLAN BUTTON'S PRE-CHECK (MOTIR-10544; design MOTIR-10543) — the answer
// `GET /api/work-items/plannability?key=` gives the roadmap canvas card's Plan
// button before it opens the planning overlay.
//
// `reasons` is a LIST of typed values so a later rule is one more `kind`, drawn
// as one more line in the same alert (design § "Reason lines are a list").
// `plannable` is exactly `reasons.length === 0`; it travels anyway so a caller
// never has to know that rule to read the answer.

/** One blocking story the planner would stop at. */
export interface PlanBlockerDto {
  /** The blocker's id — what the title-translation kit keys its title by. */
  id: string;
  /** The blocker's key, e.g. `MOTIR-10550` — the link goes to `/items/{identifier}`. */
  identifier: string;
  title: string;
  /**
   * Is the blocker itself TO PLAN (MOTIR-10508's rule: a childless story in a
   * `todo`-category status) AND plannable from where the reader stands — the same
   * project as the card they clicked, because the planning overlay is the active
   * project's? The alert draws a per-line Plan for it only then (design
   * § "Alert action").
   */
  toPlan: boolean;
}

/** A story the card waits on has no live children, so the planner would hold on it. */
export interface BlockerHasNoSubtasksReasonDto {
  kind: 'blocker_has_no_subtasks';
  /** In key order — the same card shows the same list every time. Never empty. */
  blockers: PlanBlockerDto[];
}

/** Why a card can't be planned. A union of one today; a later rule is one more arm. */
export type PlanBlockReasonDto = BlockerHasNoSubtasksReasonDto;

export interface PlannabilityDto {
  plannable: boolean;
  reasons: PlanBlockReasonDto[];
}
