// WHICH FORM A TO-RESUME PLANNING-SESSION ENTRY IS (Story MOTIR-7905 · MOTIR-7939; decision
// MOTIR-7906, consequences 6–7).
//
// The form is DERIVED, never stored: a pure function of how the session ended (or did not)
// and which undecided plans it holds. So a list, its count and a drop-out all fall out of the
// same predicates and nothing writes a flag.
//
//   - `failed_walk`                → an OPEN failed session holding a `generating` (or, Bug
//                                    MOTIR-11701, `stopped`) plan. The
//                                    entry opens on that plan (Resume continues the walk) and
//                                    names the session's newest `planned` / `stale` plan, if
//                                    there is one, as its second line.
//   - `failed_beside_waiting_plan` → an OPEN failed session holding NO `generating` plan and a
//                                    `planned` / `stale` one (a failed revision, say). It opens
//                                    on the waiting plan; the next turn continues the session.
//   - `ended_with_waiting_plan`    → a session ENDED `failed` (before MOTIR-7905) that still
//                                    holds a `planned` / `stale` plan. It opens on that plan; the
//                                    first turn carries it into a new session. Keyed on the most
//                                    recent WAITING plan, never on the latest plan, which on such
//                                    a session is usually the declined failed attempt.
//
// `null` is a session that takes no form (an ended session holding only a `generating` plan:
// it cannot be approved and the abandoned-plan sweep declines it).

import { isUnfinishedWalkStatus } from '@/lib/planChange/sessionWaitingState';

export type ToResumeForm = 'failed_walk' | 'failed_beside_waiting_plan' | 'ended_with_waiting_plan';

export interface ToResumeFormPlan {
  id: string;
  status: 'generating' | 'stopped' | 'planned' | 'stale';
  createdAt: Date;
}

export interface ToResumeFormResult {
  form: ToResumeForm;
  /** The plan the entry opens on. */
  entryPlanId: string;
  /** The session's most recent `planned` / `stale` plan, or null. */
  waitingPlanId: string | null;
}

/** Newest first: `createdAt`, then `id` as the tie-break. */
function newest<T extends { id: string; createdAt: Date }>(plans: readonly T[]): T | null {
  let best: T | null = null;
  for (const p of plans) {
    if (
      !best ||
      p.createdAt.getTime() > best.createdAt.getTime() ||
      (p.createdAt.getTime() === best.createdAt.getTime() && p.id > best.id)
    ) {
      best = p;
    }
  }
  return best;
}

export function toResumeFormOf(
  session: { endedAt: Date | null; endReason: string | null },
  undecided: readonly ToResumeFormPlan[],
): ToResumeFormResult | null {
  const waiting = newest(undecided.filter((p) => p.status === 'planned' || p.status === 'stale'));
  if (session.endedAt) {
    if (session.endReason !== 'failed' || !waiting) return null;
    return { form: 'ended_with_waiting_plan', entryPlanId: waiting.id, waitingPlanId: waiting.id };
  }
  const walking = newest(undecided.filter((p) => isUnfinishedWalkStatus(p.status)));
  if (walking) {
    return { form: 'failed_walk', entryPlanId: walking.id, waitingPlanId: waiting?.id ?? null };
  }
  if (waiting) {
    return {
      form: 'failed_beside_waiting_plan',
      entryPlanId: waiting.id,
      waitingPlanId: waiting.id,
    };
  }
  return null;
}
