// THE HOST'S MERGEABILITY, READ ONE WAY (MOTIR-5913, for bug MOTIR-5907).
//
// `GithubPullRequest.mergeableState` is GitHub's answer to *can this merge into its
// base right now?*, stored with the head it was read at. Three readers act on it — the
// merge-candidate predicate (`mergeCandidateHead`), CI promotion (`isPromotable`) and
// `motir fix`'s repair predicate — and they must agree, so the rule lives here once.
//
// ⚠️ A CONFLICT IS `dirty` AT THE MEMBER'S CURRENT HEAD, AND NOTHING ELSE. `null` is
// "not asked / not computed yet" and is never a conflict (the MOTIR-5699 rule for
// `draft`); a reading taken at another head says nothing about the current one.
//
// ⚠️ AND "NOT A CONFLICT" IS NOT "CLEAN" (MOTIR-7063). A reading OWED at the current head
// — a push marked it pending, or the one stored is about an older commit — is not yet
// known, and the CI promotion waits on it (`isMergeabilityOwedAt`). The conflict readers
// above are unchanged by it.
//
// ⚠️ AND THE CURRENT HEAD IS THE PULL REQUEST'S, NOT THE CHECK ROWS' (MOTIR-7005). This
// used to compare the reading against the newest check run's commit, on the assumption
// that a reading could only be OLDER than that (a `synchronize` replaces it). A push that
// produced no CI — every push to a conflicting pull request — made the reading NEWER,
// and the rule inverted: the conflict at the real head was discarded as stale. The head
// is `lib/github/pullRequestHead.ts`'s.

import { pullRequestHead, type PullRequestHeadSlice } from './pullRequestHead';

/** The stored reading, as the readers see it. */
export interface StoredMergeability {
  mergeableState: string | null;
  mergeableStateHeadSha: string | null;
}

/** The host's word for "conflicts with its base". */
export const CONFLICTED_MERGEABLE_STATE = 'dirty';

/**
 * Whether the stored reading says this pull request conflicts AT `headSha`.
 * `headSha` null means the caller does not know the current head; then the reading's
 * own head stands, because a `synchronize` replaces the reading when the head moves.
 */
export function isConflictedAt(pr: StoredMergeability, headSha: string | null): boolean {
  if (pr.mergeableState !== CONFLICTED_MERGEABLE_STATE) return false;
  if (pr.mergeableStateHeadSha === null) return false;
  return headSha === null || headSha === pr.mergeableStateHeadSha;
}

/** {@link isConflictedAt} at the pull request's head ({@link pullRequestHead}). */
export function isConflictedAtCurrentHead(pr: StoredMergeability & PullRequestHeadSlice): boolean {
  return isConflictedAt(pr, pullRequestHead(pr));
}

/**
 * The host's word for "behind a base branch that requires pull requests to be up to
 * date" (Bug MOTIR-10054). GitHub answers `behind` ONLY when the base requires it — a
 * base that does not reads `clean` — so the word itself says the merge is blocked.
 */
export const OUT_OF_DATE_MERGEABLE_STATE = 'behind';

/**
 * Whether the stored reading says this pull request is OUT OF DATE with its base AT
 * `headSha` — the same head rule as {@link isConflictedAt}.
 *
 * ⚠️ OUT OF DATE IS NOT A CONFLICT, and the conflict readers do not see it. The commits
 * combine with the base; they only have to be brought up to date with it — a merge of
 * the base (or GitHub's *Update branch*), after which CI runs again. So it is its own
 * reason wherever it is named (`out_of_date` on To fix), while the readers that decide
 * whether the set can land hold it exactly as they hold a conflict: it is refused when
 * pressed, so it is asked about nobody, and `motir fix` — which merges the base first —
 * is the repair.
 */
export function isOutOfDateAt(pr: StoredMergeability, headSha: string | null): boolean {
  if (pr.mergeableState !== OUT_OF_DATE_MERGEABLE_STATE) return false;
  if (pr.mergeableStateHeadSha === null) return false;
  return headSha === null || headSha === pr.mergeableStateHeadSha;
}

/** {@link isOutOfDateAt} at the pull request's head ({@link pullRequestHead}). */
export function isOutOfDateAtCurrentHead(pr: StoredMergeability & PullRequestHeadSlice): boolean {
  return isOutOfDateAt(pr, pullRequestHead(pr));
}

/**
 * The host's own word for "not computed yet" — what a `synchronize` stores at the new
 * head (MOTIR-7063). GitHub answers `mergeable_state: unknown` in exactly that window,
 * and a computed reading always overwrites it.
 */
export const PENDING_MERGEABLE_STATE = 'unknown';

/**
 * Whether the stored reading is STILL OWED at `headSha` — asked about, and not yet
 * answered there (MOTIR-7063).
 *
 * ⚠️ PENDING IS NOT CLEAN, AND IT IS NOT A CONFLICT EITHER. A push used to clear the
 * reading to `null`, and `null` read as "no conflict" — so a head pushed onto a base
 * that had already moved past it went green, was promoted to In Review and asked a
 * person to approve a merge the host would refuse, until the reconcile tick happened
 * to read it. A reading owed at the head is "not yet known": the promotion WAITS on it
 * (`ciPromotion`'s hold), while every reader of {@link isConflictedAt} keeps treating it
 * as no conflict — To fix, the repair claim and the merge candidate do not change.
 *
 * Owed means one of two things:
 *   * a reading was taken at ANOTHER head — the pull request has moved since, and a
 *     reading about the old commit says nothing about this one (a missed `synchronize`
 *     that a host read later corrected lands here);
 *   * the reading at this head is {@link PENDING_MERGEABLE_STATE} — a push marked it, and
 *     the `pull-request/head-moved` re-read has not answered yet.
 *
 * ⚠️ A ROW NOTHING HAS EVER ASKED ABOUT (both columns null) IS NOT OWED. That is a pull
 * request no push has reached since this rule existed, or one on a provider with no merge
 * path to ask (GitLab) — holding it would park the card until a read that, for the
 * second, never comes. The reconcile tick reads the first kind anyway.
 *
 * `headSha` null means the caller does not know the current head; then only the pending
 * marker is owed.
 */
export function isMergeabilityOwedAt(pr: StoredMergeability, headSha: string | null): boolean {
  if (pr.mergeableStateHeadSha === null) return false;
  if (pr.mergeableState === null || pr.mergeableState === PENDING_MERGEABLE_STATE) return true;
  return headSha !== null && headSha !== pr.mergeableStateHeadSha;
}

/** {@link isMergeabilityOwedAt} at the pull request's head ({@link pullRequestHead}). */
export function isMergeabilityOwedAtCurrentHead(
  pr: StoredMergeability & PullRequestHeadSlice,
): boolean {
  return isMergeabilityOwedAt(pr, pullRequestHead(pr));
}
