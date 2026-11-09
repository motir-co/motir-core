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
 * is running there, or none has reported there YET. The second is the window between a push
 * the host announces (`synchronize`) and the first check row at the new commit — on that
 * push the head has moved and nothing has decided, which is a pushed fix being checked, not
 * a card with nothing wrong.
 *
 * ⚠️ "YET" NEEDS A REASON TO EXPECT CI. A head with no rows counts only on a pull request CI
 * has reported on before, at another commit: a repository with no pull-request workflows
 * never writes a row, and reading its every push as "checks running" would hold a card on
 * To fix, tagged Fixing, with nothing ever coming to clear it. And rows at the head that
 * are all of a conclusion the fold does not rank (`skipped`, `neutral`) HAVE reported:
 * that head is decided, though it has no pill.
 */
export function isCiUndecidedAtHead(pr: PullRequestHeadSlice): boolean {
  const atHead = checkRowsAtHead(pr);
  if (atHead.length > 0) return foldHeadCheckRows(atHead) === 'running';
  return pr.checkRuns.length > 0;
}

/** A check row with the time its current run started or finished (`conclusionAt`, MOTIR-10456). */
export interface CheckRunWithStart extends PrCheckRunSlice {
  /** The provider's time for the row's conclusion: a pending row's START. Null when unknown. */
  conclusionAt?: Date | null;
}

/**
 * Whether CI at the pull request's head is a RE-RUN — the head had already DECIDED before the
 * checks running there now (review of MOTIR-10747). Two durable traces of it, either enough:
 *
 *  · a PENDING row whose run STARTED AFTER we first recorded the row (`conclusionAt` later
 *    than `createdAt`): the row existed before this run began, so an earlier run at this
 *    commit wrote it and this one reopened it (`reopenAsPending`). A fresh row is created by
 *    the delivery of a run that has already started, so its start is never after its creation;
 *  · a row a LATER run at the same commit REPLACED (`liveCheckRows` drops it) that had
 *    decided — `success` or `failure`: a whole run at this commit finished before this one.
 *
 * A row with no start recorded (`conclusionAt` null: a provider that gives none, or a row older
 * than the column) cannot be ordered and is no evidence either way.
 */
export function isReRunAtHead(pr: PullRequestHeadSlice<CheckRunWithStart>): boolean {
  const head = pullRequestHead(pr);
  const atHead = pr.checkRuns.filter((row) => row.commitSha === head);
  const reopened = atHead.some(
    (row) =>
      row.conclusion === 'pending' &&
      row.conclusionAt != null &&
      row.conclusionAt.getTime() > row.createdAt.getTime(),
  );
  if (reopened) return true;
  const live = new Set(liveCheckRows([...atHead]));
  return atHead.some(
    (row) => !live.has(row) && (row.conclusion === 'success' || row.conclusion === 'failure'),
  );
}

/**
 * Whether every check RUNNING at the pull request's head STARTED after every check that had
 * DECIDED there FINISHED — a check that began on a head CI had already decided (Bug
 * MOTIR-10791 review): a workflow on a later event (`labeled`, a review), a third-party suite,
 * a manual run. At the moment the last decided check finished nothing was running, so the head
 * had a verdict, and the check running now answers that verdict, not an older commit's.
 *
 * ⚠️ IT IS NOT THE OUT-OF-ORDER DELIVERY. A push's own checks start together and are delivered
 * one webhook at a time: a running check recorded after a quick green STARTED before that green
 * finished (`conclusionAt` is a pending row's start, a decided row's finish), so it is not late.
 *
 * Every live row at the head must carry its time (`conclusionAt`); a row without one cannot be
 * ordered and is no evidence either way, so the answer is false. False too when nothing is
 * running or nothing has decided there. A pipeline whose next stage starts only after the
 * first stage's checks have all finished reads as late — the head showed a green verdict in
 * between — and loses the tag for that stage, the conservative side.
 */
export function isLateCheckAtHead(pr: PullRequestHeadSlice<CheckRunWithStart>): boolean {
  const live = checkRowsAtHead(pr);
  if (live.some((row) => row.conclusionAt == null)) return false;
  const running = live.filter((row) => row.conclusion === 'pending');
  const decided = live.filter((row) => row.conclusion !== 'pending');
  if (running.length === 0 || decided.length === 0) return false;
  const lastFinished = Math.max(...decided.map((row) => row.conclusionAt!.getTime()));
  return running.every((row) => row.conclusionAt!.getTime() > lastFinished);
}

/**
 * Whether CI at the pull request's head had ALREADY DECIDED before the checks running there now
 * — a re-run ({@link isReRunAtHead}) or a check that began after the head's verdict
 * ({@link isLateCheckAtHead}). Such a head answers its own verdict, so nothing a push to it
 * answered (an older red build, a queue exit, a conflict) is rebuilt as Fixing (MOTIR-10791).
 */
export function hasHeadDecidedBeforeRunningChecks(
  pr: PullRequestHeadSlice<CheckRunWithStart>,
): boolean {
  return isReRunAtHead(pr) || isLateCheckAtHead(pr);
}

/** What CI last DECIDED on a commit before the pull request's head — see {@link lastDecidedBeforeHead}. */
export interface DecidedBeforeHead {
  commitSha: string;
  /** Whether CI decided RED there. */
  red: boolean;
  /** The failing checks' names there, unique and sorted — empty when it was not red. */
  failingChecks: string[];
}

/**
 * The newest commit BEFORE the pull request's head on which CI decided, and what it decided —
 * or null when no earlier commit has a decided verdict (Bug MOTIR-10747).
 *
 * Commits are ordered by FIRST SIGHTING (their earliest check row), the order
 * `liveRowsAtLatestSha` reads a head by, and each is folded over its live rows only, so a
 * replaced run decides nothing. A commit whose CI never decided — still running, or replaced
 * by a push before it reported — is skipped: it says nothing about whether the build the
 * head is answering was red. Rows that all carry a conclusion the fold does not rank
 * (`skipped`, `neutral`) HAVE decided, as `isCiUndecidedAtHead` reads them: not red. The head itself is never read; that is `prCiStateAtHead`'s.
 *
 * ⚠️ WHY. Check rows of older commits are kept, so "the build a push answered was red" is a
 * durable fact of these rows, unlike the card's stored To fix answer, which one recompute
 * can wipe: a quick success at the new head recorded before anything running there reads the
 * head green and stores nothing to fix.
 *
 * ⚠️ NULL WHEN THE HEAD IS A RE-RUN (review of MOTIR-10747). A check re-run at the head
 * answers the head's OWN earlier verdict, not an older commit's, and that verdict is gone: the
 * re-run reopened its row in place. Walking past the head to an older red commit would read a
 * re-run of a failed fix as a push answering the build before it, and tag it Fixing (the
 * MOTIR-10307 rule says a re-run at the recorded head never is). {@link isReRunAtHead} is the
 * test.
 */
export function lastDecidedBeforeHead(
  pr: PullRequestHeadSlice<CheckRunWithStart>,
): DecidedBeforeHead | null {
  if (isReRunAtHead(pr)) return null;
  const head = pullRequestHead(pr);
  const byCommit = new Map<string, PrCheckRunSlice[]>();
  for (const row of pr.checkRuns) {
    if (row.commitSha === head) continue;
    const rows = byCommit.get(row.commitSha);
    if (rows) rows.push(row);
    else byCommit.set(row.commitSha, [row]);
  }
  const newestFirst = [...byCommit.entries()]
    .map(([commitSha, rows]) => ({
      commitSha,
      rows,
      firstSeen: Math.min(...rows.map((r) => r.createdAt.getTime())),
    }))
    .sort((a, b) => b.firstSeen - a.firstSeen);
  for (const { commitSha, rows } of newestFirst) {
    const live = liveCheckRows(rows);
    const state = foldHeadCheckRows(live);
    if (state === 'running') continue;
    const failingChecks = [
      ...new Set(live.filter((r) => r.conclusion === 'failure').map((r) => r.checkName)),
    ].sort();
    return { commitSha, red: state === 'failing', failingChecks };
  }
  return null;
}
