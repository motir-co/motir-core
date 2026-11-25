// THE PULL REQUEST'S STATE AS A READER SEES IT, READ ONE WAY (Bug MOTIR-12232).
//
// A pull-request row has two writers of "did it merge":
//
//   * the `pull_request` closed delivery — the only writer of `merged` / `state`, through
//     the status sync (`changeRequestStatusSync`), which also moves the card;
//   * Motir's own merge — an approve-and-merge press (`pullRequestMergeService`) or an
//     auto-mode merge (`pullRequestAutoMergeService`) — which records the host's answer as
//     `mergeOutcomeRef`: the merge commit SHA when the host answered `merged: true`, or
//     `queue:<entry>` when it only enqueued.
//
// Between the press and the delivery the two disagree. Every presenter used to read
// `merged` alone, so a page re-read in that window drew the row **Open** right beside the
// frame's **Merged** outcome pill. A recorded merge commit is the HOST'S OWN ANSWER that
// the pull request merged — it is not a guess and it cannot be undone (a merged pull
// request is never reopened) — so a reader presents it as merged at once.
//
// ⚠️ ONLY THE PRESENTATION READS IT. `merged` / `state` keep their one writer on purpose:
// the status sync's `mergeAlreadyRecorded` (one note per merge) and the open-delivery
// reconcile's candidate set (`listReconcileCandidates`, which replays a lost merge
// delivery) both key on those columns. Writing them from the press would silence the
// merge's notes and hide a lost delivery from the replay — the card would never reach
// Done. The delivery, when it lands, flips `merged` and the presented state is unchanged.

/** What the presenters need of a pull-request row. */
export interface PullRequestStateSlice {
  state: string;
  merged: boolean;
  /** Motir's own merge record (MOTIR-5520): a merge commit SHA, `queue:<entry>`, or null. */
  mergeOutcomeRef: string | null;
}

export type PresentedPullRequestState = 'open' | 'merged' | 'closed';

/** The prefix a merge-queue entry is recorded under — an enqueue, not a merge. */
const QUEUED_PREFIX = 'queue:';

/**
 * Whether Motir's own merge of this pull request was answered `merged` by the host — a
 * recorded merge commit, never a queue entry (the pull request is still open there).
 */
export function hostConfirmedMotirMerge(mergeOutcomeRef: string | null): boolean {
  return mergeOutcomeRef !== null && !mergeOutcomeRef.startsWith(QUEUED_PREFIX);
}

/**
 * The state a reader is shown: `merged` once the host has said so — by its delivery or by
 * its answer to Motir's own merge — else `open` or `closed` as delivered.
 */
export function presentedPullRequestState(pr: PullRequestStateSlice): PresentedPullRequestState {
  if (pr.merged || hostConfirmedMotirMerge(pr.mergeOutcomeRef)) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}
