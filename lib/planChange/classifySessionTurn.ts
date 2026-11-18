// WHAT A TURN ON AN OPEN CONVERSATION DOES (MOTIR-7945; origin bug MOTIR-7927).
//
// A conversation's submit used to open a NEW plan every time. The owner's rule is
// that further turns revise THE plan the conversation is waiting on, so the
// submit is now routed by the session's most recent UNDECIDED plan (newest by
// `createdAt`; `generating` / `planned` / `stale` — `planRepository.findLatestUndecidedBySession`):
//
//   - none, or `generating`  → `submit`: the shipped new-plan path, unchanged.
//   - `planned` / `stopped`  → `revise` that plan in place (`stopped`: Bug MOTIR-11701).
//   - `stale`                → `stale`: answered in words naming the finished
//                              card(s); nothing is revised and nothing is spent.
//
// An accept of the stale outcome ("Plan it again") arrives as `planAgainOf`, the
// stale plan's id, and opens ONE fresh plan in the same session — unless the
// world moved since the outcome was read: a restored plan is revised instead, a
// newer undecided plan supersedes the accept, and a decided one refuses it.
//
// PURE — no I/O. A `guide` or ENDED session classifies as `submit` because both
// are refused upstream (`GuideSessionNotPlannableError`, `PlanSessionEndedError`),
// so this never has to own those refusals.

export type SessionTurnPlanStatus = 'generating' | 'stopped' | 'planned' | 'stale';

export interface ClassifySessionTurnInput {
  origin: string;
  endedAt: Date | null;
  latestUndecided: { id: string; status: SessionTurnPlanStatus } | null;
  planAgainOf?: string | null;
}

export type SessionTurnClass =
  | { kind: 'submit' }
  | { kind: 'revise'; planId: string }
  | { kind: 'stale'; planId: string }
  | { kind: 'plan_again'; stalePlanId: string }
  | { kind: 'plan_again_refused'; reason: 'decided' | 'superseded' };

export function classifySessionTurn(input: ClassifySessionTurnInput): SessionTurnClass {
  if (input.origin !== 'conversation' || input.endedAt) return { kind: 'submit' };
  const latest = input.latestUndecided;
  const planAgainOf = input.planAgainOf ?? null;

  if (planAgainOf) {
    if (!latest) return { kind: 'plan_again_refused', reason: 'decided' };
    if (latest.id !== planAgainOf) return { kind: 'plan_again_refused', reason: 'superseded' };
    if (latest.status === 'stale') return { kind: 'plan_again', stalePlanId: latest.id };
    if (latest.status === 'planned') return { kind: 'revise', planId: latest.id };
    // The accepted plan is the latest undecided one and is `generating` — it was
    // never stale, so there is nothing to plan again; it is not decided either.
    return { kind: 'plan_again_refused', reason: 'superseded' };
  }

  if (latest?.status === 'planned') return { kind: 'revise', planId: latest.id };
  // A STOPPED plan (Bug MOTIR-11701) is revised in place too: a walk that RETURNED with
  // a question closes `stopped`, and the answer continues that plan — the revision
  // re-opens it and writes every card still owed. (A stop that left a failure record
  // never reaches here: Resume owns that session's next move.)
  if (latest?.status === 'stopped') return { kind: 'revise', planId: latest.id };
  if (latest?.status === 'stale') return { kind: 'stale', planId: latest.id };
  return { kind: 'submit' };
}
