import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import { fetchPlanReview, PlanRequestError } from '@/lib/planning/planReviewClient';

// What every AI-planning surface does with a Plan ON TOP of the raw calls in
// `planReviewClient` (MOTIR-1746/1747). The conversational rail, the item-scoped
// expand/re-plan dock and the `/ready` expansion nudge all ask the same three
// questions — is there a proposal pending? what did the approve land? what does
// a failed decision mean? — so the answers live here once, and the invariant
// "ONE review shape, ONE confirm, whoever pulled the trigger" cannot drift into
// three slightly different versions of itself.

/**
 * The run's PROPOSALS, or `null` when there is nothing to decide.
 *
 * A plan is reviewable only while it is UNDECIDED and carries items:
 * `generating` is still filling, and `approved` / `declined` is already decided.
 * Every AI surface settles a finished run through this — never through the job
 * result, whose `planDelta` is empty by construction (MOTIR-1747).
 *
 * ⚠️ `stale` IS REVIEWABLE, AND THIS PREDICATE HAD TO WIDEN FOR IT
 * (MOTIR-3579). It read `=== 'planned'`, and the fifth status is neither
 * `planned` nor decided — so every surface that asks this question would have
 * answered *nothing to decide* for a plan the system had just flagged, hiding
 * the rail that states why it cannot be approved and the Decline that is one of
 * its only two exits. Whether the reviewer can still ACT is a separate question,
 * answered per control by `PlanReviewRail` (Approve is disabled, Decline is
 * not); this one is only *is a person still holding this?*.
 *
 * ⚠️ NOTE FOR THE READER OF AMENDMENT 9 D6: this file is NOT in that table's
 * list of surfaces a `PlanStatus` member obliges, and it should have been — it
 * was found by a test going red, not by the enumeration. It is the same shape as
 * `staleCountFor` and `computePlanStaleness`: a `planned` check standing in for
 * *undecided*, which a fifth status is exactly what pulls apart.
 */
export async function readPendingProposal(
  planId: string,
  signal?: AbortSignal,
): Promise<PlanReviewDto | null> {
  const review = await fetchPlanReview(planId, signal);
  return isProposedReview(review) && review.items.length > 0 ? review : null;
}

/**
 * Is this review PROPOSED — undecided, and therefore something a person is still
 * holding?
 *
 * Lifted out of `readPendingProposal` by Subtask MOTIR-6186, which needs the same
 * question answered SYNCHRONOUSLY about a review already in hand: the planning
 * surface shows the plan page's List | Canvas exactly while the plan is proposed,
 * and it has no plan id to re-read. Everything the docstring above says about
 * `stale` applies here — it is the predicate, not a copy of it.
 *
 * ⚠️ It deliberately does NOT ask about `items.length`. "Undecided" and "has
 * anything in it" are two questions, and only `readPendingProposal` wants both:
 * an EMPTY proposed plan is still a plan a reviewer is holding, and the surface
 * draws it (the shared component's own empty state) rather than falling back to
 * the roadmap as though no plan existed.
 */
export function isProposedReview(review: PlanReviewDto): boolean {
  return review.status === 'planned' || review.status === 'stale';
}

/**
 * A failed decision, as a stable copy key the surface can explain. Every typed
 * refusal is named — the ones below, and the rest through
 * {@link PLAN_DECISION_REFUSALS}; only an untyped failure or a 5xx falls to the
 * generic recoverable line, so a raw server code never reaches the screen.
 *  • `PLAN_TARGET_IMMUTABLE` — the persist gate refused: a target reached
 *    done/cancelled under the proposal (nothing was written).
 *  • `PLAN_NOT_IN_EXPECTED_STATUS` / a 404 — someone (or another tab) already
 *    decided this plan, so there is nothing left to confirm.
 *  • `PLAN_APPROVE_TIMED_OUT` — the approve transaction ran out of budget and rolled
 *    back, so nothing was written and approving again is safe (MOTIR-5249; design
 *    Part XXV §25.2). The one refusal with that promise, so it gets its own key.
 */
export function planDecisionErrorCode(err: unknown, fallback = 'APPROVE_ERROR'): string {
  if (!(err instanceof PlanRequestError)) return fallback;
  if (err.code === 'PLAN_TARGET_IMMUTABLE') return 'immutable';
  if (err.code === 'PLAN_APPROVE_TIMED_OUT') return 'timedOut';
  // A second press of a decided plan answers the same on every surface, whichever
  // refusal carried it: the door's (the plan's gate is decided or withdrawn) or the
  // plan's own status.
  if (
    err.code === 'PLAN_NOT_IN_EXPECTED_STATUS' ||
    err.code === 'APPROVAL_GATE_ALREADY_DECIDED' ||
    err.code === 'APPROVAL_GATE_SUPERSEDED' ||
    err.status === 404
  ) {
    return 'decided';
  }
  // The decide door's other refusals of a plan (MOTIR-6038): HELD while a revision is
  // in flight, STALE when the reader's stamp predates the proposals they are deciding
  // (or a question was raised under a plain press), and NOT DECIDABLE YET for a
  // `planned` plan nobody has been asked about.
  if (err.code === 'PLAN_REVISION_IN_FLIGHT') return 'held';
  if (err.code === 'APPROVAL_GATE_STALE_SUBJECT' || err.code === 'PLAN_GATE_AWAITING') {
    return 'stale';
  }
  if (err.code === 'PLAN_NOT_DECIDABLE_YET') return 'notDecidable';
  return planDecisionRefusalCode(err) ?? fallback;
}

/**
 * The decide door's refusals no key above names (MOTIR-10657). Each says what the
 * refusal is about — a proposal to correct, a dependency, a permission — because
 * the generic line it fell to before ("try again, or rephrase the change") points
 * at the conversation, and retrying cannot help any of them.
 */
export const PLAN_DECISION_REFUSALS = [
  'proposalRejected',
  'repoPinMoved',
  'linkRefused',
  'notAuthorised',
  'refused',
] as const;
export type PlanDecisionRefusalCode = (typeof PLAN_DECISION_REFUSALS)[number];

/** Is this rail error code one of {@link PLAN_DECISION_REFUSALS}? */
export function isPlanDecisionRefusal(code: string | null): code is PlanDecisionRefusalCode {
  return (PLAN_DECISION_REFUSALS as readonly string[]).includes(code ?? '');
}

/**
 * A PROPOSAL the approve route refused before or inside `materialize`
 * (`app/api/plans/[id]/approve/route.ts`): the reviewer's next move is to have
 * that card corrected in the plan, then approve again.
 */
const PROPOSAL_REFUSALS = new Set([
  'PLAN_ITEM_FIELD_REJECTED',
  'INVALID_PROPOSAL',
  'PLAN_ITEM_UNKNOWN_TARGET_REPO',
  'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE',
  'PLAN_GRAMMAR_VIOLATION',
  'INVALID_PLAN_REF_GRAPH',
  'UNRESOLVED_PLAN_REF',
  'PLAN_ITEM_TARGET_MISSING',
]);

/** The `work_item_link` triggers' refusals an approve's `blocked_by` wiring can meet. */
const LINK_REFUSALS = new Set(['WORK_ITEM_LINK_CYCLE', 'SELF_LINK', 'DUPLICATE_LINK']);

function planDecisionRefusalCode(err: PlanRequestError): PlanDecisionRefusalCode | null {
  if (err.code === 'PLAN_PROPOSAL_REPO_PIN_MOVED') return 'repoPinMoved';
  if (err.code !== null && PROPOSAL_REFUSALS.has(err.code)) return 'proposalRejected';
  if (err.code !== null && LINK_REFUSALS.has(err.code)) return 'linkRefused';
  if (err.code === 'APPROVAL_GATE_NOT_AUTHORISED' || err.status === 403) return 'notAuthorised';
  // Any other TYPED 4xx is a refusal the server explained. A 5xx, or a refusal with
  // no code, keeps the caller's recoverable fallback — retrying those is honest.
  if (err.code !== null && err.status >= 400 && err.status < 500) return 'refused';
  return null;
}

/** Which field a proposal refusal names, as the rail's copy selects on it. */
export type PlanRefusalFieldKind = 'repository' | 'repositoryRole' | 'named' | 'other';

/**
 * What a decision refusal says about itself, read off the response, so the rail can
 * name the proposal, the field and the server's own sentence (MOTIR-10657). `item`
 * is the refused proposal's label from the review in hand — null when the response
 * names none, or one the review does not hold.
 */
export interface PlanDecisionRefusal {
  item: string | null;
  fieldKind: PlanRefusalFieldKind;
  field: string | null;
  reason: string | null;
}

export function planDecisionRefusal(
  err: unknown,
  review: PlanReviewDto | null,
): PlanDecisionRefusal | null {
  if (!(err instanceof PlanRequestError) || !isPlanDecisionRefusal(planDecisionErrorCode(err))) {
    return null;
  }
  const proposal = err.detail.planItemId
    ? review?.items.find((i) => i.planItemId === err.detail.planItemId)
    : undefined;
  const field = err.detail.field ?? null;
  return {
    item: proposal ? [proposal.identifier, proposal.title].filter(Boolean).join(' ') : null,
    fieldKind: refusalFieldKind(err.code, field),
    field,
    reason: err.detail.message,
  };
}

function refusalFieldKind(code: string | null, field: string | null): PlanRefusalFieldKind {
  if (code === 'PLAN_ITEM_UNKNOWN_TARGET_REPO') return 'repository';
  if (code === 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE') return 'repositoryRole';
  return field ? 'named' : 'other';
}

/** What an approve landed, so a surface can say it back. */
export interface PlanApproveSummary {
  created: string[];
  updated: string[];
  removed: string[];
}

/** Read the outcome off the plan `materialize` returned: its `add` items became
 *  work items, its `modify` items changed existing ones, its `remove` items took
 *  them away. (It replaces the delta route's `ApproveDeltaResult`, which named the
 *  same facts about a delta that was always empty.) */
export function summarizePlanApproval(plan: PlanWithItemsDto): PlanApproveSummary {
  const ids = (op: 'add' | 'modify' | 'remove') =>
    plan.items.filter((item) => item.op === op).map((item) => item.workItemId ?? item.id);
  return { created: ids('add'), updated: ids('modify'), removed: ids('remove') };
}
