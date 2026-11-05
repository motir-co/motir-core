import {
  bindWorkspaceContext,
  withSystemContext,
  type SystemTransactionOptions,
} from '@/lib/workspaces/context';
import type { GitProviderId } from '@/lib/git/types';
import { changeRequestNoun } from '@/lib/git/labels';
import { changeRequestChecksUrl } from '@/lib/git/checksUrl';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { githubCiFeedbackCommentRepository } from '@/lib/repositories/githubCiFeedbackCommentRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { liveCheckRows } from '@/lib/github/checkSuites';
import { commentsService } from './commentsService';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';

// THE CI FEEDBACK COMMENT — how it is rendered, and the one door that renders it
// WITHOUT a delivery (Bug MOTIR-10425).
//
// The render used to live inside `changeRequestCiFeedback.ts`, the webhook
// consumer, and only a delivery ever ran it. So when a delivery was LOST — GitHub
// gave up on it at ten seconds — and the reconcile tick later settled the row from
// the host, the row was right and the comment was not: it went on reading
// "87 of 88 checks complete" on a card already promoted. `refreshFeedbackComments`
// is that missing door: it rebuilds what the render needs from the stored pull
// request rather than from a payload, and runs the very same render, so the
// comment a backstop leaves is the comment a delivery would have left.
//
// It is a module of its own because both sides call it: the consumer
// (`changeRequestCiFeedback.ts`), which imports `ciPromotion`, and `ciPromotion`'s
// reconcile, which could not import the consumer back without a cycle.

/**
 * The budget EVERY transaction in this consumer runs under (MOTIR-5865) — raised
 * from Prisma's 5000 ms default, because of what these transactions are for
 * rather than how much they do.
 *
 * None of them does much: the largest is the phase-1 resolve, nine single-row
 * indexed reads with no network call and no row lock. So the default is not
 * outgrown by WORK. It is outgrown by WAITING — for a lock another session holds
 * on a table a transaction reads (a migration's `ALTER TABLE` takes ACCESS
 * EXCLUSIVE and every reader queues behind it), for the change request's row lock
 * behind a burst of sibling deliveries, or for a stalled process. Production
 * recorded that 100 times: `P2028`, *5000 ms, however 19058 ms passed*, at the
 * phase-1 resolve.
 *
 * And a wait that expires a transaction HERE is not a retryable error. GitHub
 * does not redeliver a failed webhook and nothing enqueues this path, so the
 * delivery's conclusion is simply never recorded — and every derivation below is
 * a fold over the RECORDED rows, so a lost `failure` reads as green (MOTIR-4264).
 * A delivery that waits and then records is correct; one that gives up is a
 * silently wrong verdict. That is the whole argument for the number.
 *
 * 30 s is more than half again the worst wait observed. It widens nothing but the
 * ceiling: a transaction that is not waiting finishes exactly as fast as before.
 */
export const CI_FEEDBACK_TX_TIMEOUT_MS = 30_000;

/** {@link CI_FEEDBACK_TX_TIMEOUT_MS} in the shape `withSystemContext` takes. */
export const CI_FEEDBACK_SYSTEM_TX: SystemTransactionOptions = {
  timeout: CI_FEEDBACK_TX_TIMEOUT_MS,
};

/** What ONE delivery may do to the feedback comment before it gives up: render,
 *  and re-render at most twice more if the recorded check set MOVED while it was
 *  writing. See `renderFeedbackComments` for why a re-render can be owed at all. */
const MAX_RENDER_PASSES = 3;

export interface RenderFeedbackArgs {
  prId: string;
  workspaceId: string;
  commitSha: string;
  checksUrl: string;
  noun: string;
  deliveredWorkItemIds: readonly string[];
  actorCtx: { userId: string; workspaceId: string };
}

/**
 * Render THE feedback comment for `(change request, head commit)` onto every
 * delivered card, and answer the head commit's aggregate `ciState`.
 *
 * ⚠️ THE LOCK IS HELD OVER THE FOLD AND NOTHING ELSE (MOTIR-4264). The body is
 * derived from every check row at this commit, so deciding what to write is a
 * read-derived write and owes the row lock — that part is MOTIR-2946's rule and
 * is unchanged. What changed is what happens INSIDE it: `commentsService` opens
 * its OWN transaction on its OWN connection, so calling it under the lock held
 * the change request across N comment round trips, and every other check
 * finishing at that commit queued behind them on the same `FOR UPDATE`. A
 * motir-core pull request carries ~34 checks that finish in bursts, so the k-th
 * delivery waited on k−1 holders and blew Prisma's 5 s budget with a 500. The
 * fold is now three indexed statements and the comment writes happen after it has
 * committed.
 *
 * ⚠️ AND THAT COSTS THE ORDERING THE LOCK USED TO BUY, WHICH IS WHY THIS CONVERGES
 * RATHER THAN WRITING ONCE. Two deliveries that fold in order can still write out
 * of order, and the loser's older body would be the one that stands — permanently,
 * if it was the last check to land. So after writing, a delivery RE-READS the
 * recorded set: unchanged ⇒ what it wrote is current and it stops; changed ⇒
 * somebody landed a row while it was writing, and it renders again from the newer
 * set. Every delivery therefore leaves the comment agreeing with the rows recorded
 * at the moment it finished, which is exactly the property the long lock had.
 */
export async function renderFeedbackComments(
  args: RenderFeedbackArgs,
): Promise<'passing' | 'failing' | null> {
  const { prId, workspaceId, commitSha, checksUrl, noun, deliveredWorkItemIds, actorCtx } = args;
  let ciState: 'passing' | 'failing' | null = null;

  for (let pass = 0; pass < MAX_RENDER_PASSES; pass += 1) {
    // THE FOLD — under the change request's row lock, and DB-ONLY. Nothing in
    // this callback reaches another connection.
    const fold = await withSystemContext(async (tx) => {
      // The tenant is known (phase 1 resolved it): the lock reads
      // `github_pull_request` and the comment rows are a tenant table with no
      // system arm (MOTIR-2880).
      await bindWorkspaceContext(tx, workspaceId);
      await githubPullRequestRepository.lockById(prId, tx);

      // Every row at this commit — this delivery's own included, because it was
      // committed before the lock was taken — MINUS every run a later run has
      // replaced (MOTIR-3209). `liveCheckRows` stays the one place that decides
      // which rows still vote.
      const stored = await githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
      const rows = liveCheckRows(stored);

      // THE comments for this head commit, one per card that already has one
      // (MOTIR-3770). This is the source of truth; a new check joins the comment
      // its card already carries instead of opening a second one.
      const recordedComments = await githubCiFeedbackCommentRepository.listByPrAndSha(
        prId,
        commitSha,
        tx,
      );

      return {
        rows,
        fingerprint: checkSetFingerprint(stored),
        bodyMd: feedbackCommentBody(summarizeChecks(rows), checksUrl, noun),
        commentByWorkItem: new Map(
          recordedComments.map((row) => [row.workItemId, row.commentId] as const),
        ),
      };
    }, CI_FEEDBACK_SYSTEM_TX);

    ciState = deriveCiState(fold.rows.map((r) => r.conclusion));
    // (deriveCiState ignores non-terminal conclusions — pending rows at this sha,
    // recorded for the Development surface, never gate the verdict.)

    // ONE COMMENT PER DELIVERED CARD (MOTIR-3770), written with NO lock held. The
    // set is EMPTY on the session arm — a session pull request's cards are reached
    // by the promotion and by nothing here — so this loop runs zero times for one,
    // and once for an ordinary single-card pull request.
    for (const workItemId of deliveredWorkItemIds) {
      await writeCardComment({
        prId,
        workspaceId,
        commitSha,
        workItemId,
        bodyMd: fold.bodyMd,
        existingCommentId: fold.commentByWorkItem.get(workItemId) ?? null,
        actorCtx,
      });
    }

    // Nothing was written, so there is nothing to keep current.
    if (deliveredWorkItemIds.length === 0) return ciState;

    // DID THE SET MOVE WHILE WE WROTE? One indexed read, no lock: if it did not,
    // the body on every card is the current one and this delivery is done.
    const after = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
    }, CI_FEEDBACK_SYSTEM_TX);
    if (checkSetFingerprint(after) === fold.fingerprint) return ciState;
  }

  return ciState;
}

/** Put `bodyMd` on ONE card's feedback comment for this `(change request, head
 *  commit)` — editing the comment the card already carries, or opening the one it
 *  does not.
 *
 *  ⚠️ THE CREATE IS ARBITRATED BY THE UNIQUE INDEX, NOT BY THE LOCK (MOTIR-4264).
 *  Two deliveries that both folded before either wrote can both find no comment
 *  row for a card, and the lock no longer spans the create that would have
 *  serialized them. `github_ci_feedback_comment` is unique on
 *  `(pull_request_id, commit_sha, work_item_id)`, so the row — not the comment —
 *  decides: the delivery whose insert lands owns the card's comment, and the other
 *  one DELETES the comment it just posted and edits the winner's instead. The
 *  duplicate MOTIR-2946 removed is a comment that STAYS; this one exists for the
 *  length of one round trip and never survives the request that made it. */
async function writeCardComment(args: {
  prId: string;
  workspaceId: string;
  commitSha: string;
  workItemId: string;
  bodyMd: string;
  existingCommentId: string | null;
  actorCtx: { userId: string; workspaceId: string };
}): Promise<void> {
  const { prId, workspaceId, commitSha, workItemId, bodyMd, existingCommentId, actorCtx } = args;

  if (existingCommentId) {
    // An edit whose body is unchanged is a no-op in `commentsService` — no
    // "Edited" tag, no event — so a delivery that moves nothing stays silent.
    await commentsService.editComment(existingCommentId, { bodyMd }, actorCtx);
    return;
  }

  const created = await commentsService.addComment(workItemId, { bodyMd }, actorCtx);
  const winner = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    return githubCiFeedbackCommentRepository.claim(
      { pullRequestId: prId, commitSha, workItemId, commentId: created.id },
      tx,
    );
  }, CI_FEEDBACK_SYSTEM_TX);

  if (winner.commentId === created.id) return;

  // We lost the race. Take our comment back out — a person must never be left
  // holding two verdicts about one commit — and make sure the surviving one
  // carries the body we folded.
  await commentsService.deleteComment(created.id, actorCtx);
  await commentsService.editComment(winner.commentId, { bodyMd }, actorCtx);
}

/** The recorded check set at one commit, as a value two reads can be compared on:
 *  which rows exist and what each one concluded. A row ARRIVING, a conclusion
 *  CHANGING and a run being superseded all change it, which is exactly the set of
 *  events that makes an already-written comment stale. */
function checkSetFingerprint(rows: { id: string; conclusion: string }[]): string {
  return rows
    .map((row) => `${row.id}:${row.conclusion}`)
    .sort()
    .join('|');
}

/** The head commit's aggregate verdict read straight from the store — the answer
 *  when rendering the comment failed. The verdict is about the RECORDED rows, so
 *  it is knowable whether or not anybody managed to write a sentence about them. */
export async function deriveRecordedCiState(
  prId: string,
  workspaceId: string,
  commitSha: string,
): Promise<'passing' | 'failing' | null> {
  const rows = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    return githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
  }, CI_FEEDBACK_SYSTEM_TX);
  return deriveCiState(liveCheckRows(rows).map((r) => r.conclusion));
}

/** The work item's aggregate CI signal from its TERMINAL check conclusions at one
 *  commit: any failure → 'failing'; else at least one success → 'passing'; else
 *  null. Non-terminal rows ('pending', recorded for the Development surface since
 *  MOTIR-1579) match neither predicate, so they never gate the verdict. */
export function deriveCiState(conclusions: string[]): 'passing' | 'failing' | null {
  if (conclusions.some((c) => c === 'failure')) return 'failing';
  if (conclusions.some((c) => c === 'success')) return 'passing';
  return null;
}

/** The check set at one head commit, folded to what the ONE feedback comment says
 *  about it: how many checks there are, which ones FAILED (by name — the roll-up
 *  must lose nothing a per-check comment carried), and how many are still
 *  RUNNING, which is what makes the verdict interim rather than terminal. */
export interface CheckSetSummary {
  total: number;
  failed: string[];
  pending: number;
}

/** Fold the head commit's check rows into the summary the comment renders. */
export function summarizeChecks(
  rows: { checkName: string; conclusion: string }[],
): CheckSetSummary {
  return {
    total: rows.length,
    failed: rows.filter((r) => r.conclusion === 'failure').map((r) => r.checkName),
    pending: rows.filter((r) => r.conclusion === 'pending').length,
  };
}

/**
 * THE feedback comment's body for a change request at one head commit — the
 * aggregate over its whole check set, never one check's conclusion generalized to
 * "this work" (MOTIR-2946).
 *
 * Three readings, and the first is the one the per-check body could not express:
 * while ANY check is still running the comment reads as INTERIM and asserts no
 * verdict — a red-then-green pair of contradicting comments minutes apart is what
 * a system of record must not do. Once the set is terminal it says passing or
 * failing ONCE, naming every failed check so nothing a reader had before is lost.
 */
export function feedbackCommentBody(
  summary: CheckSetSummary,
  checksUrl: string,
  noun: string,
): string {
  const { total, failed, pending } = summary;
  const failedList = failed.map((name) => `\`${name}\``).join(', ');

  if (pending > 0) {
    const done = total - pending;
    const soFar = failed.length > 0 ? ` **${failed.length} failed so far:** ${failedList}.` : '';
    return `⏳ **CI running** — ${done} of ${total} ${plural(total, 'check')} complete on the linked ${noun} ([view checks](${checksUrl})).${soFar} No verdict yet.`;
  }

  if (failed.length > 0) {
    return `❌ **CI failed** — ${failed.length} of ${total} ${plural(total, 'check')} did not pass on the linked ${noun} ([view checks](${checksUrl})): ${failedList}. This work item is marked **not-ready**; it needs another pass.`;
  }

  return `✅ **CI passing** — all ${total} ${plural(total, 'check')} succeeded on the linked ${noun}. This work is verified.`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
/** What one refresh did. */
export type FeedbackRefreshOutcome =
  /** Re-rendered onto every card the change request delivers. */
  | { outcome: 'rendered'; ciState: 'passing' | 'failing' | null; cards: number }
  /** Nothing to render onto: the pull request is gone, it delivers no card of its
   *  own (a session pull request — the comment never reached those), or the
   *  workspace has nobody the comment could be attributed to. */
  | { outcome: 'skipped'; reason: 'no_pull_request' | 'no_linked_card' | 'no_actor' };

/**
 * Re-render THE feedback comment for `(pull request, commit)` from the recorded
 * check set — the render a delivery runs, for a caller that has none (Bug
 * MOTIR-10425).
 *
 * Called by the reconcile backstop once it has written rows a delivery never
 * reported or settled rows a delivery left pending, and after it promotes a card:
 * without it the rows are corrected and the sentence about them is not. Everything
 * a delivery's payload supplied is read from the store instead — the provider (for
 * the noun and the checks link), the cards the pull request delivers, and the
 * workspace's stand-in manager the comment is attributed to, exactly as a
 * delivery attributes it.
 *
 * Idempotent: the render edits each card's comment in place, and an edit whose
 * body is unchanged is a no-op, so a refresh with nothing new to say says nothing.
 */
export async function refreshFeedbackComments(args: {
  pullRequestId: string;
  commitSha: string;
  workspaceId: string;
}): Promise<FeedbackRefreshOutcome> {
  const { pullRequestId, commitSha, workspaceId } = args;

  const target = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    if (!pr) return { kind: 'no_pull_request' as const };
    const delivery = await resolveChangeRequestWorkItemSet({
      workspaceId,
      headRef: pr.headRef,
      githubPullRequestId: pr.id,
      tx,
    });
    // The comment reaches LINKED cards only, as it does from a delivery: a session
    // pull request's cards are reached by the promotion and by nothing here.
    const deliveredWorkItemIds =
      delivery.kind === 'linked' ? delivery.items.map((item) => item.id) : [];
    if (deliveredWorkItemIds.length === 0) return { kind: 'no_linked_card' as const };
    const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
      workspaceId,
      tx,
    );
    if (!owner) return { kind: 'no_actor' as const };
    const provider = pr.repo.installation.provider as GitProviderId;
    return {
      kind: 'resolved' as const,
      deliveredWorkItemIds,
      actorUserId: owner.userId,
      noun: changeRequestNoun(provider),
      checksUrl: changeRequestChecksUrl(provider, pr.repo, pr.number),
    };
  }, CI_FEEDBACK_SYSTEM_TX);

  if (target.kind !== 'resolved') return { outcome: 'skipped', reason: target.kind };

  const ciState = await renderFeedbackComments({
    prId: pullRequestId,
    workspaceId,
    commitSha,
    checksUrl: target.checksUrl,
    noun: target.noun,
    deliveredWorkItemIds: target.deliveredWorkItemIds,
    actorCtx: { userId: target.actorUserId, workspaceId },
  });
  return { outcome: 'rendered', ciState, cards: target.deliveredWorkItemIds.length };
}
