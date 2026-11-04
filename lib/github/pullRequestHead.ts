// THE PULL REQUEST'S HEAD, READ ONE WAY (MOTIR-7005).
//
// Before this module every reader derived "the current head" from the newest check
// run's commit, `liveRowsAtLatestSha(pr.checkRuns)[0].commitSha`. That holds until a
// push produces no CI, and GitHub guarantees exactly that for a pull request that
// conflicts with its base: it builds no merge ref, so no `pull_request` workflow runs.
// The rows then stay at the OLD green commit, and the readers disagreed inside one
// reconcile pass — the stored `dirty` reading, taken at the real head, withdrew the
// question; the promotion, reading the check rows' head, discarded that reading as
// "older", saw green and asked again. Every tick, over a commit nobody proposes to merge.
// Three earlier fixes (MOTIR-5663's `movedHead`, MOTIR-6116, MOTIR-6946) patched one
// reader each.
//
// So the head is the HOST's, stored on `GithubPullRequest.headSha` by every delivery
// and every host read, and every reader asks it here:
//
//   * `pullRequestHead`   — the commit the pull request is at;
//   * `checkRowsAtHead`   — the live check rows AT that commit, never an older one's;
//   * `prCiStateAtHead`   — the CI verdict over exactly those rows.
//
// ⚠️ A MEMBER WHOSE CHECK ROWS ARE NOT AT ITS HEAD IS NOT GREEN. It has no rows at its
// head, so its verdict is `null` — "nothing has reported", which the promotion
// withholds on and the card's fold reads as `running`. It is not a merge candidate,
// not promotable, and no approve-to-merge gate names it.
//
// ⚠️ A ROW WITH NO STORED HEAD (`headSha` null) is one no delivery has written since the
// column existed. It falls back to the check rows' head — exactly the behaviour before
// this module — so an unmigrated row keeps working until its next delivery or
// reconcile read fills the column in.

import { liveCheckRows } from './checkSuites';
import {
  foldHeadCheckRows,
  liveRowsAtLatestSha,
  type PrCheckRunSlice,
  type PrCiState,
} from './prCiState';

/** What the head readers need of a pull-request row. */
export interface PullRequestHeadSlice<T extends PrCheckRunSlice = PrCheckRunSlice> {
  /** The host's head as last delivered or read; null when no delivery has said. */
  headSha: string | null;
  checkRuns: readonly T[];
}

/**
 * The commit this pull request is AT — the stored host head, or (for a row no
 * delivery has written it on) the newest check run's commit. Null when neither names one.
 */
export function pullRequestHead(pr: PullRequestHeadSlice): string | null {
  return pr.headSha || (liveRowsAtLatestSha([...pr.checkRuns])[0]?.commitSha ?? null);
}

/**
 * The live check rows AT the pull request's head — empty when the head has none,
 * however many rows an older commit carries.
 */
export function checkRowsAtHead<T extends PrCheckRunSlice>(pr: PullRequestHeadSlice<T>): T[] {
  const head = pr.headSha;
  // Falsy, not `=== null`: a row read through a narrow select that never named the
  // column must fall back too, never filter every row away against `undefined`.
  if (!head) return liveRowsAtLatestSha([...pr.checkRuns]);
  return liveCheckRows(pr.checkRuns.filter((row) => row.commitSha === head));
}

/**
 * The CI verdict at the pull request's head: `derivePrCiState`'s precedence over
 * {@link checkRowsAtHead}. `null` when the head has no rows — including when an older
 * commit's rows are all green.
 */
export function prCiStateAtHead(pr: PullRequestHeadSlice): PrCiState {
  return foldHeadCheckRows(checkRowsAtHead(pr));
}

/**
 * Whether CI has NOT DECIDED at the pull request's head (MOTIR-10307 · MOTIR-10310): a check
 * is running there, or none has reported there yet. The second is the window between a push
 * the host announces (`synchronize`) and the first check row at the new commit — on that
 * push the head has moved and nothing has decided, which is a pushed fix being checked, not
 * a card with nothing wrong.
 */
export function isCiUndecidedAtHead(pr: PullRequestHeadSlice): boolean {
  const state = prCiStateAtHead(pr);
  return state === 'running' || state === null;
}
