import type { PlanDecisionReasonDto, PlanStatusDto } from '@/lib/dto/plans';

// WHAT A PLAN LEFT THE PLANNING TAB AS (Story MOTIR-7820 · Subtask MOTIR-7831;
// design `design/workbench/design-notes.md` § 36.8, mock Panel 6) — the pure rule
// behind the held row's line, and the merge the live island applies to its rows.
//
// ⚠️ THE OUTCOME IS READ, NEVER GUESSED. The tab's read lists only `generating`
// plans, so a poll learns exactly one thing about a row that is gone: that it
// LEFT. Why it left is read once, per leaving row, through the existing
// `GET /api/plans/<id>` — the same review read every plan surface settles through.
// A read that has not landed, or that failed, is the fourth form below: *No longer
// being written*, which is true, rather than a reason nobody confirmed.

/** The held row's line: a neutral chip (or none) and one sentence, both `workbench.planning.left.*`. */
export interface PlanningRowOutcome {
  /** The chip's key, or `null` for the outcome-unknown form, which carries no chip. */
  chipKey: 'planned' | 'discarded' | 'abandoned' | null;
  /** The sentence's key. */
  lineKey: 'plannedLine' | 'discardedLine' | 'abandonedLine' | 'unknownLine';
  /**
   * The status the plan is NOW, as the row's door reads it (§ 36.6 / § 36.8): a
   * written plan is still reviewed on its planning surface, a decided one is a
   * record on its own page. `'generating'` for the unknown form — the door then
   * answers from what is known, which is where the row already pointed.
   */
  planStatus: PlanStatusDto;
}

/** The outcome-unknown form — the read has not landed, or it failed. */
export const UNKNOWN_OUTCOME: PlanningRowOutcome = {
  chipKey: null,
  lineKey: 'unknownLine',
  planStatus: 'generating',
};

/**
 * The outcome of a plan that has left, from the review read's own two fields.
 *
 * Why these words (§ 36.8): **Written** rather than *Proposed* or *Done*, because
 * *written* is the thing the reader was waiting for, and the sentence says what
 * happens next. **Stopped** rather than *Failed*, because `abandoned` means the
 * producer is provably gone, not that anything the reader did failed.
 *
 * A plan still `generating` on the read has not left after all — it is simply
 * absent from one window — so it gets no outcome and the list drops the row quietly
 * rather than claiming it is no longer being written. ⚠️ EXCEPT when nothing could have pushed it out of the window
 * (`failedIfGenerating`, the caller's "the ceiling did not bite"): the Planning read leaves
 * out exactly one kind of `generating` plan, the one whose attempt FAILED and now waits in
 * To resume (MOTIR-7914), so a `generating` plan that left an unclipped list is that one.
 */
export function planningOutcomeOf(plan: {
  status: PlanStatusDto;
  decisionReason: PlanDecisionReasonDto | null;
}): PlanningRowOutcome | null {
  switch (plan.status) {
    case 'generating':
      return null;
    case 'planned':
    case 'stale':
      return { chipKey: 'planned', lineKey: 'plannedLine', planStatus: plan.status };
    case 'approving':
    case 'approved':
      // Written AND already approved — or being approved right now (Bug MOTIR-9006),
      // which the row's door answers on the planning surface until it commits — the reader (or a teammate) decided it between
      // two polls. It is still the *written* outcome; what changed is only that the
      // review is over, and the row's door is the plan's record.
      return { chipKey: 'planned', lineKey: 'plannedLine', planStatus: plan.status };
    case 'declined':
      return plan.decisionReason === 'abandoned'
        ? { chipKey: 'abandoned', lineKey: 'abandonedLine', planStatus: 'declined' }
        : { chipKey: 'discarded', lineKey: 'discardedLine', planStatus: 'declined' };
  }
}

/**
 * THE MERGE a poll applies to the rows on screen (§ 36.7 / § 36.8).
 *
 * ⚠️ NOTHING IS REMOVED, and arrivals land at the TOP. A row the reader has is
 * kept — updated when the read still returns it, HELD where it is when it does
 * not — because the reader is watching this list and a row that vanishes under
 * the cursor teaches them that disappearance is ambiguous (§ 26, as To fix adopted
 * it). The read is `createdAt desc`, so a plan that started elsewhere is newer
 * than everything on screen and belongs above it.
 *
 * It is pure and it is here rather than inside the island's effect, because the
 * case it exists for — a row leaving while another arrives — is reachable in a
 * test by calling it twice, and needs no render to assert.
 */
export function mergePlanningRows<T>(
  previous: readonly T[],
  incoming: readonly T[],
  idOf: (row: T) => string,
): { rows: T[]; heldIds: Set<string>; arrivedIds: Set<string> } {
  const incomingById = new Map(incoming.map((row) => [idOf(row), row] as const));
  const had = new Set(previous.map(idOf));
  const heldIds = new Set<string>();

  const kept = previous.map((row) => {
    const id = idOf(row);
    const fresh = incomingById.get(id);
    if (fresh) return fresh;
    heldIds.add(id);
    return row;
  });
  const arrivals = incoming.filter((row) => !had.has(idOf(row)));
  return {
    rows: [...arrivals, ...kept],
    heldIds,
    arrivedIds: new Set(arrivals.map(idOf)),
  };
}
