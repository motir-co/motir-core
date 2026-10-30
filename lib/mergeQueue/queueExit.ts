import type { MergeRefusalCode } from '@/lib/git/types';
// WHAT A MERGE-QUEUE REMOVAL MEANS (Story MOTIR-5461 · MOTIR-5632).
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 2 — the reason
// map, closed and total. PURE: no service, no database.
//
// ⚠️ THE SPELLING IS THE WEBHOOK'S, NOT THE GRAPHQL TIMELINE'S. MOTIR-5627 read 110
// real `pull_request` `dequeued` deliveries: `MERGE` 88, `CI_FAILURE` 15, `MANUAL` 4,
// `MERGE_CONFLICT` 3 — UPPER_SNAKE, the published webhook enum. The timeline's
// `failed_checks` / `merged` / `checks_timed_out` never appear in a delivery, so the
// match is EXACT and nothing is case-folded: a lowercase string is an unrecognised
// one, which is the safe direction (it moves no card).

/** What a removal does to the cards the pull request delivers. */
export type QueueExitDisposition = 'failure' | 'neutral' | 'landed';

/**
 * Every value the capture observed plus every value in the published webhook
 * enum (`@octokit/openapi-webhooks`, `webhook-pull-request-dequeued.reason`), each
 * with exactly one disposition. The table is the decision record's, row for row.
 */
export const QUEUE_EXIT_REASONS = {
  // The queue's checks failed on the merge group (seen in a delivery).
  CI_FAILURE: 'failure',
  // The checks did not finish in time (published; GitHub lists a timeout beside
  // failures as a removal cause).
  CI_TIMEOUT: 'failure',
  // It does not combine with what is ahead of it (seen in a delivery).
  MERGE_CONFLICT: 'failure',
  // The queue could not build a merge commit / a tree for it (published).
  INVALID_MERGE_COMMIT: 'failure',
  GIT_TREE_INVALID: 'failure',
  // "Branch protection failure that could not automatically be resolved".
  BRANCH_PROTECTIONS: 'failure',
  // Somebody took it out on purpose (seen in a delivery).
  MANUAL: 'neutral',
  // The queue was reset.
  QUEUE_CLEARED: 'neutral',
  // Removed for a roll-back, not for its own content.
  ROLL_BACK: 'neutral',
  // GitHub itself does not know; a card never moves on an unknown.
  UNKNOWN_REMOVAL_REASON: 'neutral',
  // It merged (seen in a delivery) / it was merged already.
  MERGE: 'landed',
  ALREADY_MERGED: 'landed',
} as const satisfies Record<string, QueueExitDisposition>;

export type KnownQueueExitReason = keyof typeof QUEUE_EXIT_REASONS;

export interface QueueExitClassification {
  disposition: QueueExitDisposition;
  /** False for a string the table does not name — the caller logs it raw, once. */
  recognised: boolean;
}

/**
 * Classify one raw removal reason. TOTAL: an unrecognised string (or none at all)
 * is `neutral` and reported as unrecognised, so a card never moves on a reason
 * nobody has seen and a new spelling stays visible.
 */
export function classifyQueueExit(rawReason: string | null | undefined): QueueExitClassification {
  if (rawReason && Object.hasOwn(QUEUE_EXIT_REASONS, rawReason)) {
    return {
      disposition: QUEUE_EXIT_REASONS[rawReason as KnownQueueExitReason],
      recognised: true,
    };
  }
  return { disposition: 'neutral', recognised: false };
}

/**
 * WHAT A PERSON CAN DO ABOUT AN UN-LANDED MERGE (§4 FOURTH AMENDMENT, point 2;
 * MOTIR-5802 · MOTIR-5805). One question decides it: could re-running these SAME
 * commits land them?
 *
 *  · `retryable`  — yes (a cleared queue, a hand removal — nothing FAILED): ask again.
 *  · `cant_land`  — no, not as they stand (a conflict, and — since the FIFTH AMENDMENT
 *                   (MOTIR-6591) — every queue FAILURE: the checks failed or timed out,
 *                   the merge commit or tree could not be built): asking would offer a
 *                   button guaranteed to fail, so the card goes back to Implemented and
 *                   `motir fix` is the way forward. A new green head asks again.
 *  · `setting`    — yes, once a person changes a SETTING (branch protection): ask
 *                   again, and name the setting.
 *  · `landed`     — it merged; there is nothing to ask.
 *
 * ⚠️ THE CLASS IS NOT THE DISPOSITION, and both survive. The disposition says what the
 * removal did to the card the moment it arrived; the class says what may be done about
 * it now. `BRANCH_PROTECTIONS` is a `failure` and a `setting`; `MANUAL` is `neutral`
 * and `retryable`.
 */
export type LandingClass = 'retryable' | 'cant_land' | 'setting' | 'landed';

/**
 * Every reason the table above names, with its class. Total by construction.
 *
 * ⚠️ A QUEUE FAILURE IS CAN'T-LAND (`approval-gates.md` §4 FIFTH AMENDMENT; MOTIR-6594).
 * Yue, 2026-09-27: *"when a PR failed in the merge queue, we should not open a new
 * approval gate"*. A second yes to the same head re-queues the commits the queue just
 * refused, so the four failures join `MERGE_CONFLICT`. The NEUTRAL removals stay
 * `retryable` (nothing failed) and `BRANCH_PROTECTIONS` stays `setting` (changing a
 * setting is not a push, so only a gate brings the question back).
 */
const QUEUE_EXIT_CLASSES = {
  CI_FAILURE: 'cant_land',
  CI_TIMEOUT: 'cant_land',
  INVALID_MERGE_COMMIT: 'cant_land',
  GIT_TREE_INVALID: 'cant_land',
  MANUAL: 'retryable',
  QUEUE_CLEARED: 'retryable',
  ROLL_BACK: 'retryable',
  UNKNOWN_REMOVAL_REASON: 'retryable',
  MERGE_CONFLICT: 'cant_land',
  BRANCH_PROTECTIONS: 'setting',
  MERGE: 'landed',
  ALREADY_MERGED: 'landed',
} as const satisfies Record<KnownQueueExitReason, LandingClass>;

/**
 * The raw GitHub check conclusions that say a job was STOPPED rather than that it
 * FAILED (§4 SIXTH AMENDMENT, MOTIR-6844): cancelled by a person or by its own time
 * limit, before it could say anything about the commits. A `CI_FAILURE` /
 * `CI_TIMEOUT` exit whose recorded failing check concluded one of these is `neutral`
 * and `retryable` — the fixture is MOTIR-6765's `TypeScript` job, which hung for 19
 * minutes and was cancelled at its timeout.
 */
export const HUNG_CHECK_CONCLUSIONS: readonly string[] = ['cancelled', 'timed_out'];

/** The two queue-failure reasons whose meaning depends on HOW their check ended. */
const CHECK_JUDGED_REASONS: ReadonlySet<string> = new Set(['CI_FAILURE', 'CI_TIMEOUT']);

export interface QueueExitJudgement {
  disposition: QueueExitDisposition;
  landingClass: LandingClass;
}

/**
 * THE JUDGE (§4 SIXTH AMENDMENT's table). TOTAL over every key of
 * `QUEUE_EXIT_REASONS` and any other string. Only `CI_FAILURE` and `CI_TIMEOUT` read
 * the conclusion:
 *
 *  · `CI_FAILURE` — neutral + retryable when its check was `cancelled` / `timed_out`;
 *    a genuine failure, or no check recorded YET, stays failure + can't-land (a late
 *    conclusion re-judges it, `mergeQueueExitService.resettleStandingExit`).
 *  · `CI_TIMEOUT` — the timeout is itself the statement that the checks did not
 *    finish, so it is neutral + retryable unless a check that GENUINELY failed was
 *    recorded first.
 *
 * Every other reason answers exactly what the reason table does.
 */
export function judgeQueueExit(exit: {
  rawReason: string | null | undefined;
  failingCheckConclusion: string | null | undefined;
}): QueueExitJudgement {
  const { rawReason, failingCheckConclusion } = exit;
  if (rawReason && CHECK_JUDGED_REASONS.has(rawReason)) {
    const hung =
      failingCheckConclusion != null && HUNG_CHECK_CONCLUSIONS.includes(failingCheckConclusion);
    const unknown = failingCheckConclusion == null;
    if (hung || (rawReason === 'CI_TIMEOUT' && unknown)) {
      return { disposition: 'neutral', landingClass: 'retryable' };
    }
    return { disposition: 'failure', landingClass: 'cant_land' };
  }
  return {
    disposition: classifyQueueExit(rawReason).disposition,
    landingClass: baseClassOf(rawReason),
  };
}

function baseClassOf(rawReason: string | null | undefined): LandingClass {
  if (rawReason && Object.hasOwn(QUEUE_EXIT_CLASSES, rawReason)) {
    return QUEUE_EXIT_CLASSES[rawReason as KnownQueueExitReason];
  }
  return 'retryable';
}

/**
 * Classify one RECORDED exit by what can be DONE about it. It reads the exit, not the
 * reason, because since the SIXTH AMENDMENT the reason alone no longer answers: a
 * `CI_FAILURE` / `CI_TIMEOUT` exit is `retryable` exactly when its STORED disposition
 * is `neutral` (the judge wrote it so, from its check's conclusion), and `cant_land`
 * otherwise. One stored fact is what keeps the class, the promotion hold and the CI
 * state from disagreeing about one exit — and it is what leaves `auto` mode, whose
 * exits keep `failure` (§4 SIXTH AMENDMENT, point 2), exactly as it was.
 *
 * TOTAL: an unrecognised string is `retryable`, which is the safe default — a person
 * is asked and can still reach for `motir fix`, where `cant_land` would silently offer
 * them nothing.
 */
export function classOfQueueExit(exit: {
  rawReason: string | null | undefined;
  disposition: string;
}): LandingClass {
  if (exit.rawReason && CHECK_JUDGED_REASONS.has(exit.rawReason)) {
    return exit.disposition === 'neutral' ? 'retryable' : 'cant_land';
  }
  return baseClassOf(exit.rawReason);
}

/**
 * The HOST's own refusal codes, classed by the same question (§4 FOURTH AMENDMENT,
 * point 2; MOTIR-5833). ONE map answers for both sources, so the card cannot be
 * settled one way by the queue and another way by the press.
 *
 * ⚠️ `subject_changed` IS NOT AN OUTCOME and answers `null`. It means the head moved
 * under the press, so nothing was attempted and no approval was spent — the
 * stale-stamp path (MOTIR-5232), not a failed landing.
 *
 * ⚠️ `out_of_date` IS CAN'T-LAND (Bug MOTIR-10054). The base branch requires a pull
 * request to be up to date with it, so these commits cannot land as they stand: only a
 * push that brings the base in (an update from the base, or `motir fix`, which merges
 * the base first) can. A second yes to the same head is refused the same way.
 */
const MERGE_REFUSAL_CLASSES: Record<MergeRefusalCode, LandingClass | null> = {
  checks_not_green: 'cant_land',
  conflict: 'cant_land',
  out_of_date: 'cant_land',
  branch_protected: 'setting',
  app_permission_missing: 'setting',
  already_merged: 'landed',
  subject_changed: null,
};

/**
 * Classify one host refusal. TOTAL over `MergeRefusalCode`, and `retryable` for any
 * string outside it — a second host may name a refusal this deployment has never
 * seen, and the safe default is to ask a person rather than to offer them nothing.
 */
export function classOfMergeRefusal(code: string): LandingClass | null {
  if (Object.hasOwn(MERGE_REFUSAL_CLASSES, code)) {
    return MERGE_REFUSAL_CLASSES[code as MergeRefusalCode];
  }
  return 'retryable';
}
