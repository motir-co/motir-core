import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { RESTING_BLOCKED_KEY, RESTING_TODO_KEY } from '@/lib/plans/restingStatus';

/** The status a re-scoped card takes while a run is live on it. */
export const RESCOPE_LIVE_RUN_KEY = 'in_progress';

/** Every status a re-scope can land on, in the order a reader is told them. */
export const RESCOPE_OUTCOME_KEYS = [
  RESTING_TODO_KEY,
  RESTING_BLOCKED_KEY,
  RESCOPE_LIVE_RUN_KEY,
] as const;

export type RescopeOutcomeKey = (typeof RESCOPE_OUTCOME_KEYS)[number];

/**
 * What an approved `modify` does to its target's STATUS (bug MOTIR-10102).
 *
 * - `not_ours` — this rule says nothing; the path's own behaviour stands (a plan
 *   park rests at `todo` / `blocked`, a session park restores, an unparked card
 *   keeps its status).
 * - `keep` — the card goes back to, or stays at, `toKey`: the status it held
 *   before any park.
 * - `rescope` — the card leaves the status it held for `toKey`.
 */
export type ModifyTargetDecision =
  | { readonly kind: 'not_ours' }
  | { readonly kind: 'keep'; readonly toKey: string }
  | { readonly kind: 'rescope'; readonly toKey: RescopeOutcomeKey };

/**
 * The status a card held BEFORE a plan or a session parked it — the base the
 * approve decides from. A card at `planning` whose lock moved it there holds its
 * real status on the lock; one parked by hand (`statusHeld: false`) has no
 * observed prior, so `planning` is the honest answer and the resting rule takes it.
 */
export function priorStatusOf(
  currentStatus: string,
  lock: { priorStatus: string; statusHeld: boolean } | null | undefined,
): string {
  if (currentStatus === PLANNING_STATUS_KEY && lock?.statusHeld) return lock.priorStatus;
  return currentStatus;
}

/**
 * Whether a card at `status` CLAIMS ITS WORK IS BUILT — past `in_progress` in the
 * in-progress category: `implemented`, `in_review`, `approved`, and any custom
 * status a project put beside them. These are the statuses that go on asserting
 * the old body is on the remote once a plan rewrites the body.
 *
 * `in_progress` itself is not one: it claims only that work has started, and a
 * card worked by a person carries it with no run behind it. `planning` is not
 * one either: it is a park, and the resting rule decides it.
 */
export function claimsBuiltWork(status: string, category: StatusCategoryDto | null): boolean {
  return (
    category === 'in_progress' && status !== PLANNING_STATUS_KEY && status !== RESCOPE_LIVE_RUN_KEY
  );
}

/**
 * THE RE-SCOPE MOVE (bug MOTIR-10102; Yue, 2026-10-30) — where an approved
 * `modify`'s target goes, decided ONCE for the approve
 * (`plansService.materialize`) and the review diff
 * (`planReviewService.buildChanges`), so the surface cannot promise a move the
 * approve does not make.
 *
 * ⚠️ WHY IT EXISTS AGAIN. MOTIR-5646 retired MOTIR-5359's re-scope reset on the
 * premise that every `modify` target is parked and then rested. A plan a
 * CONVERSATION produces parks nothing — its session holds only its anchors — so a
 * re-scoped card that was not an anchor stayed at `implemented`, still claiming
 * its old body was built. This rule is asked of every `modify` target, parked or
 * not, anchor or not.
 *
 * The rule, for a card whose prior status claims built work ({@link claimsBuiltWork}):
 *
 * | the patch | the card goes to |
 * | --- | --- |
 * | changes the title, the description or the repository (`patchRescopes`) | `blocked` with an open blocker after materialize, else `in_progress` while a run is live on it, else `todo` |
 * | changes only the type, size, priority, explanation, parent or edges | the status it held — a park gives it back |
 *
 * A MARK-ONLY `modify` and a card whose prior status does not claim built work
 * are `not_ours`. The first reaches only `done` / `cancelled` cards and is never
 * parked; the second keeps whatever its path already did.
 *
 * A container the plan also lays children under is `not_ours` on the `keep` arm,
 * because new unbuilt children make its old status false whatever its own patch
 * says, and the resting rule's `todo` / `blocked` is the answer that already holds
 * for such a target (AMENDMENT 16 D7).
 */
export function modifyTargetStatusFor(args: {
  priorStatus: string;
  priorCategory: StatusCategoryDto | null;
  rescopes: boolean;
  markOnly: boolean;
  gainsChildren: boolean;
  hasOpenBlocker: boolean;
  hasLiveRun: boolean;
}): ModifyTargetDecision {
  if (args.markOnly || !claimsBuiltWork(args.priorStatus, args.priorCategory)) {
    return { kind: 'not_ours' };
  }
  if (!args.rescopes) {
    return args.gainsChildren ? { kind: 'not_ours' } : { kind: 'keep', toKey: args.priorStatus };
  }
  if (args.hasOpenBlocker) return { kind: 'rescope', toKey: RESTING_BLOCKED_KEY };
  if (args.hasLiveRun) return { kind: 'rescope', toKey: RESCOPE_LIVE_RUN_KEY };
  return { kind: 'rescope', toKey: RESTING_TODO_KEY };
}
