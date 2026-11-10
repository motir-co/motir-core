import type { PlanStatusDto } from '@/lib/dto/plans';
import { PLANNING_STATUS_KEY, isExpired } from '@/lib/planChange/targetLock';

// WHETHER AN UNDECIDED PLAN HOLDS A CARD — the ONE statement of the rule the
// status funnel enforces and the status control reads up front (Story MOTIR-6017 ·
// MOTIR-6265; `docs/decisions/agent-authored-plans.md` AMENDMENT 21 §1).
//
// ⚠️ PURE, AND SHARED ON PURPOSE — the shape of `lib/approvalGates/heldMoves.ts`.
// `workItemsService.applyStatusTransition` refuses a hand move with it, inside the
// lock, and `planTargetLockService.readPlanHold` tells a surface the card is held
// BEFORE anyone tries. Two copies of this rule would disagree the first time either
// changed, so both callers read their own inputs and hand them to this function.
//
// A card is HELD when all three are true:
//   1. its status is `planning`;
//   2. a `plan_target_lock` row names it with a NON-NULL `planId`;
//   3. that plan is UNDECIDED — `generating`, `planned` or `stale`.
//
// A SESSION-held lock (`planId` null) holds too since AMENDMENT 23 §5 — while
// its session is OPEN, which is {@link sessionHoldFor}'s rule below. It replaced
// AMENDMENT 21 §1's "a SESSION-held lock never holds".
//
// One case looks held and is NOT, by name:
//   · an EXPIRED lease on a `generating` plan — the abandoned-plan sweep is about to
//     release it (D9), and a lock whose own service has declared its author dead
//     should not outrank a person. A `planned` / `stale` plan's lock never expires
//     (§4), so its `expiresAt` is not read.

/** The plan statuses that HOLD their parked cards — AMENDMENT 21 §1's third clause.
 *  Derived from {@link holdsWhile}, so it cannot disagree with the predicate. */
export const UNDECIDED_PLAN_STATUSES = (
  ['generating', 'planned', 'approving', 'stale'] as const
).filter((status) => holdsWhile(status) !== 'never');

/**
 * How a plan in `status` holds its parked cards. TOTAL over `PlanStatus` with no
 * `default`, in the style of `lib/planning/planDestination.ts`: a sixth plan
 * status is a compile error here rather than a silent answer.
 */
export function holdsWhile(status: PlanStatusDto): 'lease' | 'always' | 'never' {
  switch (status) {
    case 'generating':
      // The author is still writing; its lease is the dead-author detector.
      return 'lease';
    case 'planned':
    case 'stale':
      // Waiting for a PERSON. `stale` is NOT decided (the schema's own
      // `PlanStatus` comment), and a review queue has no deadline.
      return 'always';
    case 'approving':
      // Being materialized (Bug MOTIR-9006): the approve's own commit releases the
      // card, and a failed one gives the plan back to `planned`, which holds it.
      return 'always';
    case 'approved':
    case 'declined':
      // Decided: the decision itself released the card.
      return 'never';
  }
}

/** The lock row's columns the rule reads — a subset of `PlanTargetLock`. */
export interface PlanHoldLock {
  planId: string | null;
  expiresAt: Date;
}

export interface PlanHoldInput {
  /** The work item's current status key. */
  itemStatus: string;
  /** The item's `plan_target_lock` row, or null when it has none. */
  lock: PlanHoldLock | null;
  /** The status of the plan the lock names, or null when there is no such plan
   *  (no lock, a session lock, or a plan that no longer resolves). */
  planStatus: PlanStatusDto | null;
  now: Date;
}

/** HELD: the plan named here owns every hand move out of `planning`. */
export interface PlanHold {
  held: true;
  planId: string;
  planStatus: 'generating' | 'planned' | 'approving' | 'stale';
}

/** Whether the card is held by an undecided plan — AMENDMENT 21 §1, and nothing else. */
export function planHoldFor(input: PlanHoldInput): PlanHold | { held: false } {
  const { itemStatus, lock, planStatus, now } = input;
  if (itemStatus !== PLANNING_STATUS_KEY) return { held: false };
  if (!lock || lock.planId === null || planStatus === null) return { held: false };
  const holds = holdsWhile(planStatus);
  if (holds === 'never') return { held: false };
  if (holds === 'lease' && isExpired(lock.expiresAt, now)) return { held: false };
  return {
    held: true,
    planId: lock.planId,
    planStatus: planStatus as PlanHold['planStatus'],
  };
}

export interface SessionHoldInput {
  /** The work item's current status key. */
  itemStatus: string;
  /** The session the item's `plan_target_lock` names, or null when the lock is a
   *  plan's or there is none. */
  lockSessionId: string | null;
  /** That session's `endedAt`; `undefined` when the session no longer resolves. */
  sessionEndedAt: Date | null | undefined;
}

/**
 * Whether the card is held by an OPEN SESSION — AMENDMENT 23 §5's second arm. The
 * lease's expiry is NOT read: an expired session lease still holds until the idle
 * close ends the session, at most one sweep interval later, and ending is what
 * frees the card. No override, by decision.
 */
export function sessionHoldFor(
  input: SessionHoldInput,
): { held: true; sessionId: string } | { held: false } {
  const { itemStatus, lockSessionId, sessionEndedAt } = input;
  if (itemStatus !== PLANNING_STATUS_KEY) return { held: false };
  if (lockSessionId === null || sessionEndedAt === undefined || sessionEndedAt !== null) {
    return { held: false };
  }
  return { held: true, sessionId: lockSessionId };
}
