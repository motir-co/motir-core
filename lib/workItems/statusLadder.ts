import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE STATUS LADDER — the one ordering of "how far along is this" that both
// halves of status derivation and the container-completeness gate read
// (`docs/decisions/status-derivation.md` §3; Bug MOTIR-3229).
//
// It lived as a private constant plus a private `rankOfStatus` inside
// `parentStatusRollupService`, which was correct while derivation was the only
// reader. MOTIR-3229 added a SECOND reader — the gate in
// `workItemsService.applyStatusTransition` that refuses a container's claim to
// be built while a child is not — and two copies of an ordering is exactly the
// shape that drifts: the rung set is a semantic decision recorded in an ADR, and
// a gate ranking statuses differently from the derivation it is protecting would
// refuse and derive on two different scales.
//
// ⚠️ FIVE RUNGS, NOT FOUR (MOTIR-3229). `implemented` (MOTIR-3003) ships in the
// default workflow between `in_progress` and `in_review`, and the ladder could
// not see it: its CATEGORY is `in_progress`, so a parent whose children were ALL
// implemented derived to `in_progress` and the ladder had no way to say
// "everything below me is built" — precisely the state a story run ends in.
// MOTIR-1343 reached `implemented`, then `in_review`, then `done` with two `todo`
// children, and the merge cascaded both closed.
//
// ⚠️ AND THE RUNGS ARE STILL A FIXED SET, WHICH IS THE NARROW ANSWER. The
// general one — rank a project's OWN configured statuses rather than a fixed
// five — is not merely bigger: it has no defined answer for the statuses that
// are not on a line. `blocked` and `planning` are both real default statuses that
// sit BESIDE the path rather than along it, and a total order over an arbitrary
// project's status set would have to invent a place for them. This ladder ranks
// by CATEGORY with the two named lifecycle keys pulled out, so a project that
// adds statuses gets them ranked by the category it chose and nothing has to
// guess. MOTIR-3229's card names the general answer as the eventual direction;
// it is a redesign of §3, not a bug fix.

// ⚠️ SIX RUNGS, NOT FIVE (MOTIR-5140). `approved` (MOTIR-5139) ships in the
// default workflow between `in_review` and `done`, and the five-rung ladder
// mis-ranked it in exactly the way the block above describes for `implemented`:
// its CATEGORY is `in_progress` and it was not one of the named keys, so
// `rankOfStatus('approved', …)` returned the IN PROGRESS rank. Two regressions
// followed from that one number, and neither goes red:
//
//   1. the upward recompute DOWNGRADED a parent — a story whose children all
//      reached `approved` derived to In Progress, where the same children at
//      `in_review` derived to In Review. The parent went backwards as its
//      children went forwards.
//   2. the container-claim gate REFUSED A TRUE CLAIM — an `approved` child
//      ranked below `CONTAINER_CLAIM_BAR_RANK`, so `childrenBelowClaimBar`
//      counted it as un-built and `applyStatusTransition` refused the parent's
//      move with `CONTAINER_HAS_OPEN_CHILDREN`, on a container every one of
//      whose children had been approved.
//
// Same defect, same file, same remedy as MOTIR-3229: a named key pulled out as
// its own rung. `docs/decisions/status-derivation.md` §3 carries the amendment.

// ⚠️ AND ONE KEY PULLED DOWN, NOT UP (MOTIR-12174). `to_plan` lives in the
// `in_progress` category — that is what takes it out of both claim doors — but
// it means PLANNED, NOT STARTED: its description went stale before anyone built
// it. Ranked by its category it would sit at the IN PROGRESS rung, and an epic
// over a story the mark moved would derive to In Progress, a false "started".
// So it is pulled out the other way, to the `todo` rung. No new rung: it shares
// To Do's, because for every reader of this scale (the upward recompute, the
// container-claim gate, the pending-question withdrawal) it is the same fact.

/** The rungs, in ascending order of "how far along". */
export type LadderRung = 'todo' | 'in_progress' | 'implemented' | 'in_review' | 'approved' | 'done';

/**
 * Where each rung sits on the scale. Comparable integers rather than an ordered
 * array lookup, because every reader compares two rungs rather than iterating.
 */
export const RUNG_RANK: Readonly<Record<LadderRung, number>> = Object.freeze({
  todo: 0,
  in_progress: 1,
  implemented: 2,
  in_review: 3,
  approved: 4,
  done: 5,
});

/**
 * The ladder as the UPWARD recompute reads it — highest rung FIRST, so "the
 * first matching rung wins" is a plain scan. Each entry names the INTENT it
 * wants; the concrete key is resolved against the project's own workflow by
 * `workflowsService.resolveStatusKey`, so a renamed workflow still derives.
 */
export const LADDER: ReadonlyArray<{
  rung: LadderRung;
  target: { key: string; category: StatusCategoryDto };
}> = Object.freeze([
  { rung: 'done', target: { key: 'done', category: 'done' } },
  { rung: 'approved', target: { key: 'approved', category: 'in_progress' } },
  { rung: 'in_review', target: { key: 'in_review', category: 'in_progress' } },
  { rung: 'implemented', target: { key: 'implemented', category: 'in_progress' } },
  { rung: 'in_progress', target: { key: 'in_progress', category: 'in_progress' } },
  { rung: 'todo', target: { key: 'todo', category: 'todo' } },
]);

/** The FOUR lifecycle keys the ladder pulls OUT of the `in_progress` category,
 *  because all of them live in it and none means what the others do. A project
 *  may have renamed any, so every reader resolves them rather than assuming. */
export interface LadderKeys {
  /** The project's In Review status key, or null when it has none. */
  readonly reviewKey: string | null;
  /** The project's Implemented status key, or null when it has none. */
  readonly implementedKey: string | null;
  /** The project's Approved status key, or null when it has none — MOTIR-5140.
   *  A project that never got the `approved` backfill passes `null` here and
   *  ranks exactly as it did before this rung existed. */
  readonly approvedKey: string | null;
  /** The project's To plan status key, or null when it has none — MOTIR-12174.
   *  Pulled DOWN to the `todo` rung rather than up; a project without the
   *  backfill passes `null` and ranks exactly as before. */
  readonly toPlanKey: string | null;
}

/** A project's {@link LadderKeys}, resolved from its status list by literal key. */
export function ladderKeysFrom(statuses: ReadonlyArray<{ key: string }>): LadderKeys {
  const keyOf = (key: string) => statuses.find((s) => s.key === key)?.key ?? null;
  return {
    reviewKey: keyOf('in_review'),
    implementedKey: keyOf('implemented'),
    approvedKey: keyOf('approved'),
    toPlanKey: keyOf('to_plan'),
  };
}

/**
 * Where a status sits on the ladder's scale.
 *
 * Ranked by CATEGORY — so it follows a project's own workflow — with the two
 * named lifecycle keys pulled out of `in_progress` as their own, later rungs. An
 * unknown key ranks lowest, which is the conservative reading everywhere it is
 * used: a status nobody can classify is not evidence that anything is finished.
 *
 * PURE, deliberately. It used to be an async method issuing one `getStatusByKey`
 * per call from inside a locked transaction; its callers now read the project's
 * status list once and rank against it, which is the same answer with one query
 * instead of one per status compared.
 */
export function rankOfStatus(
  statusKey: string,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  keys: LadderKeys,
): number {
  // The named keys win over the category, and the HIGHER rung wins on the
  // (pathological) project that has aliased two of them onto one key: the higher
  // rung is the conservative answer for the derivation and the stricter one for
  // the gate. So the tests run in descending rung order — APPROVED, then REVIEW,
  // then IMPLEMENTED — and adding a rung means adding its test at its own
  // position rather than at the end.
  if (keys.approvedKey && statusKey === keys.approvedKey) return RUNG_RANK.approved;
  if (keys.reviewKey && statusKey === keys.reviewKey) return RUNG_RANK.in_review;
  if (keys.implementedKey && statusKey === keys.implementedKey) return RUNG_RANK.implemented;
  // MOTIR-12174 — planned, not started, whatever its category says.
  if (keys.toPlanKey && statusKey === keys.toPlanKey) return RUNG_RANK.todo;
  const status = statuses.find((s) => s.key === statusKey);
  if (!status) return RUNG_RANK.todo;
  if (status.category === 'done') return RUNG_RANK.done;
  if (status.category === 'in_progress') return RUNG_RANK.in_progress;
  return RUNG_RANK.todo;
}

/**
 * WHETHER A MOVE PULLS THE WORK BACK — and so WITHDRAWS the question an
 * `awaiting` approval gate is asking (Story MOTIR-4887 · Subtask MOTIR-5527; ADR
 * `docs/decisions/approval-gates.md` §6d AMENDMENT, rule 6).
 *
 * True when the move is not a system write and EITHER lands on the cancelled
 * status, OR leaves the review band — from a status ranked at or above In Review
 * to one ranked below it — for anything but the status keyed `blocked`.
 *
 * ⚠️ `blocked` IS THE ONE DOWNWARD MOVE THAT KEEPS THE QUESTION. Blocking pauses
 * the work; it does not abandon what was offered for review. Every other move out
 * of the band means the thing somebody was asked about is being reworked, so the
 * question in their queue no longer points at anything real.
 *
 * PURE, like {@link rankOfStatus}: the caller reads the statuses once, on its own
 * transaction.
 */
export function withdrawsPendingQuestion(args: {
  fromKey: string;
  toKey: string;
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>;
  keys: LadderKeys;
  system: boolean;
}): boolean {
  if (args.system) return false;
  if (args.toKey === WITHDRAW_CANCELLED_KEY) return true;
  if (args.toKey === WITHDRAW_KEEPS_QUESTION_KEY) return false;
  return (
    rankOfStatus(args.fromKey, args.statuses, args.keys) >= RUNG_RANK.in_review &&
    rankOfStatus(args.toKey, args.statuses, args.keys) < RUNG_RANK.in_review
  );
}

/** The cancelled status's key — the same literal `applyStatusTransition` already
 *  exempts from its done-category gates as `ROADMAP_CANCELLED_KEY`. */
const WITHDRAW_CANCELLED_KEY = 'cancelled';
/** The status that pauses work without abandoning it (rule 6's one exception). */
const WITHDRAW_KEEPS_QUESTION_KEY = 'blocked';

/**
 * THE CONTAINER-COMPLETENESS BAR (MOTIR-3229) — the two status KEYS at which an
 * item CLAIMS its own work is built, and therefore the two a container may not
 * reach while a child of its own is not.
 *
 * `implemented` says the branch is pushed and the pull request is open;
 * `in_review` says a human should look at it. Both are claims about everything
 * under the item, and MOTIR-1343 made both while two children sat at `todo`.
 * `done` is deliberately NOT here: completing a parent is a decision that
 * completes its children, and §4's downward cascade is the shipped expression of
 * it — a gate there would break the feature rather than the defect.
 *
 * ⚠️ THIS IS THE KIND-AGNOSTIC CONTAINMENT, AND IT HAS COVERED `in_review` SINCE
 * IT SHIPPED (Bug MOTIR-3334, 2026-08-21). MOTIR-3334 asked, conditionally, why
 * the gate covered `implemented` and not `in_review` — *"if that guard already
 * exists for `implemented` … this card says why it did not cover `in_review`"*.
 * It did cover it: the set below has held BOTH keys since MOTIR-3229, and
 * `workItemsService.applyStatusTransition` tests membership in it for every
 * non-`system` move. The premise was false, and it is recorded here rather than
 * left for the next reader to re-derive from the same conditional.
 *
 * What is true is the OTHER half of that card's containment — a container may not
 * be moved here while a child is unimplemented, and it also may not have its pull
 * request opened by a scoped run in that state, which is `packages/cli`'s
 * close-out re-read (MOTIR-3268). Both are kind-agnostic. Neither reaches a child
 * FILED AFTER the parent finished, which is why the downward cascade dates its
 * own claim (`childStatusCascadeService`, same card) — a residue, not a
 * duplicate.
 *
 * ⚠️ BY KEY, NOT BY CATEGORY, AND NOT THROUGH `resolveStatusKey`. Both statuses
 * live in the `in_progress` category, so the prefer-key-then-category resolver
 * falls back to the FIRST `in_progress` status — `in_progress` itself — and the
 * gate would fire on a status that claims nothing at all. A project that renamed
 * these away has redefined what the claim means, and the honest answer there is
 * to let the move through rather than to refuse it on a status we cannot read.
 * The same literal-key choice `ciPromotion.ts` makes, for the same reason.
 */
export const CONTAINER_CLAIM_STATUS_KEYS: ReadonlySet<string> = new Set([
  'implemented',
  'in_review',
  // MOTIR-5140. A container at `approved` claims its work is built exactly as
  // one at `in_review` does — a person has said yes to it — so the same
  // containment applies: it may not be reached while a live child has not.
  // BY LITERAL KEY, for the reason this set's own note gives above: all three
  // live in the `in_progress` category, so `resolveStatusKey` would fall back to
  // `in_progress` itself and the gate would fire on a status that claims nothing.
  'approved',
]);

/**
 * The bar every live child must clear before a container may enter one of those
 * two statuses: `implemented`-or-better.
 *
 * ONE bar for BOTH claim rungs, rather than the target's own rank. The rule the
 * card states is *"a story must not be able to claim `implemented` while a child
 * is not implemented"*, and reading In Review's own rank as the bar would
 * additionally refuse a parent whose children are all built but whose individual
 * builds have not been promoted — which is the ordinary shape of a parent run,
 * where ONE pull request carries every child and the promotion is a single
 * verdict over the set. Refusing there would gate a true claim on an artifact of
 * how CI reports.
 */
export const CONTAINER_CLAIM_BAR_RANK = RUNG_RANK.implemented;

/**
 * The live children that have NOT reached the completeness bar — the ones whose
 * existence makes a container's claim false.
 *
 * Takes rows rather than ids so the caller can name them in the refusal: an
 * error that says WHICH cards are open is one the reader can act on, and this
 * gate fires at the moment somebody believes they are finished.
 */
export function childrenBelowClaimBar<T extends { status: string }>(
  children: ReadonlyArray<T>,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  keys: LadderKeys,
): T[] {
  return children.filter(
    (child) => rankOfStatus(child.status, statuses, keys) < CONTAINER_CLAIM_BAR_RANK,
  );
}
