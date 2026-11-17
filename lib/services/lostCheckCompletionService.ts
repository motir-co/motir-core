import type { Prisma } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import {
  claimedCompleteSha,
  readReportedCheckSet,
  reReadCheckSetFromHost,
  stalePendingSha,
  type AgedCheckRunSlice,
  type CheckSetReReadTarget,
} from './checkSetReconcile';
import { refreshFeedbackComments } from './ciFeedbackComments';
import { promoteDeliveredCardsOnGreen, withdrawDeliveredCardsOnRed } from './ciPromotion';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';
import { recomputeWorkItemCiState } from './deliveryVerdict';
import { recomputeWorkItemFixReason } from './fixReasonService';
import { recomputeWorkItemResumeState } from './resumeStateService';

// A LOST CHECK COMPLETION IS SETTLED WHATEVER THE CARD'S STATUS (Bug MOTIR-11638).
//
// ── The defect ───────────────────────────────────────────────────────────────
// When GitHub's completion delivery for one check is lost, Motir's row for it stays
// `pending`, `derivePrCiState` folds the pull request to `running`, and nothing will ever
// refresh it. MOTIR-5838 taught Motir to re-ask the host about a pending row older than
// `STALE_PENDING_MINUTES` — but put the re-read inside the Implemented → In Review latch
// (`ciPromotion.reconcileClaimedCompleteDeliveries`), whose first step is *is this card at
// `implemented`?*. So a card already In Review — where every fix after a review send-back
// runs — was never re-read: its CI read `running` for ever, `fixReasonService` held its
// prior reason as Fixing at the moved head, and the card stayed on To fix with green CI and
// a passing review (MOTIR-11585 / motir-core#4306 @ 2cb7524b, 2026-11-17).
//
// ── The fix: the re-read is a fact about the PULL REQUEST, so it is asked per pull request ─
// The reconcile tick calls `settleLostCheckCompletions` for every open delivering pull
// request it reaches, before the latch. It is the MOTIR-5838 / MOTIR-4199 re-read — the
// same predicates and the same host read and write (`reReadCheckSetFromHost`) — with no
// status gate. When the read changed the recorded set, everything the lost delivery would
// have done after recording its row is done here, in the consumer's order
// (`changeRequestCiFeedback.applyOneCiDelivery`):
//
//   1. recompute each delivered card's `ciState`, fix reason and resume state;
//   2. re-render the CI feedback comment at the commit whose set changed;
//   3. the verdict latches — a red set withdraws the merge question
//      (`withdrawDeliveredCardsOnRed`), a green one promotes from `implemented` and
//      re-raises the question for a card already in review (`promoteDeliveredCardsOnGreen`).
//
// ⚠️ THE PROMOTION STAYS THE ONLY STATUS-GATED PART. It is the same latch every green
// verdict fires, which moves a card only out of `implemented`; nothing here moves a card of
// its own.
//
// ── What it costs ────────────────────────────────────────────────────────────
// The MOTIR-4199 property holds: a FRESH pending row is believed without a host call. And a
// set that claims to be complete is asked about ONCE per head: the read that confirms the
// host has decided records it (`ciDecidedSha`, MOTIR-10797), and a set the host has already
// decided at that head is not asked again — so a green pull request waiting days for review
// costs one read, not one every tick.

/** The settle's answer: whether a lost completion was written, and the cards the green
 *  latch then promoted. */
export interface LostCompletionSettle {
  settled: boolean;
  promoted: string[];
}

const NOTHING_SETTLED: LostCompletionSettle = { settled: false, promoted: [] };

/**
 * The commit this pull request's recorded set should be re-read at, or `null` (Bug
 * MOTIR-11638). `shaToReReadFromHost`'s two arms, with one refinement the status-independent
 * sweep owes: a set CLAIMING completeness at a head the host has ALREADY confirmed decided
 * is not asked again. The latch never needed it — a card leaves `implemented` once promoted
 * — but this sweep visits an open pull request every tick for as long as it stays open.
 */
export function shaToSettle(
  pr: { checkRuns: AgedCheckRunSlice[]; ciDecidedSha: string | null },
  now: Date,
): string | null {
  const stale = stalePendingSha(pr.checkRuns, now);
  if (stale !== null) return stale;
  const claimed = claimedCompleteSha(pr.checkRuns);
  return claimed !== null && claimed !== pr.ciDecidedSha ? claimed : null;
}

/**
 * Every answer a card holds that is folded from its pull requests' check rows — `ciState`
 * (MOTIR-5470), the To fix reason (MOTIR-6602) and whether a gated run still waits to
 * resume (MOTIR-10308) — recomputed in ONE place, so the CI-feedback consumer and this
 * settle cannot drift about which answers a changed check set owes.
 *
 * Runs inside the caller's transaction with the workspace bound (`work_item` has no system
 * arm). Each recompute takes the card's row lock first, so racing writers serialise.
 */
export async function recomputeCardCiAnswers(
  workItemIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  for (const workItemId of workItemIds) {
    await recomputeWorkItemCiState(workItemId, tx);
    await recomputeWorkItemFixReason(workItemId, tx);
    await recomputeWorkItemResumeState(workItemId, tx);
  }
}

/** Phase 1 — which commit to ask about, read in one transaction under the pull request's
 *  workspace. `null` for a pull request that is gone, closed, or makes no claim. */
async function settleTarget(
  pullRequestId: string,
  workspaceId: string,
  now: Date,
): Promise<CheckSetReReadTarget | null> {
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    if (!pr || pr.state !== 'open' || pr.merged) return null;
    const commitSha = shaToSettle(pr, now);
    if (commitSha === null) return null;
    return {
      pullRequestId,
      commitSha,
      installationId: pr.repo.installation.installationId,
      owner: pr.repo.owner,
      name: pr.repo.name,
    };
  });
}

/** Recompute every delivered card's answers, and resolve the actor the verdict latches run
 *  as — the workspace's stand-in Manager, as the CI-feedback consumer resolves it. */
async function recomputeDeliveredCards(
  pullRequestId: string,
  workspaceId: string,
): Promise<string | null> {
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    /* v8 ignore next -- the row was read moments ago under the same workspace; a pull
       request row is never deleted while it delivers a card, and the guard is the type's. */
    if (!pr) return null;
    const delivery = await resolveChangeRequestWorkItemSet({
      workspaceId,
      headRef: pr.headRef,
      githubPullRequestId: pr.id,
      tx,
    });
    await recomputeCardCiAnswers(
      delivery.items.map((item) => item.id),
      tx,
    );
    const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
      workspaceId,
      tx,
    );
    return owner?.userId ?? null;
  });
}

/** Log a best-effort tail's failure; the settled rows are committed and are the record. */
function logTailFailure(step: string, pullRequestId: string) {
  return (err: unknown): void => {
    console.error(`[lostCheckCompletion] ${step} failed; the settled rows still stand`, {
      pullRequestId,
      error: err instanceof Error ? err.message : String(err),
    });
  };
}

/**
 * SETTLE ONE OPEN PULL REQUEST'S LOST CHECK COMPLETIONS, whatever its cards' status (Bug
 * MOTIR-11638) — and, when the recorded set changed, do what the lost delivery would have
 * done after it (the module header gives the order).
 *
 * `readCheckSet` and `now` are injectable for the reason `promoteIfCiAlreadyGreen` gives:
 * a test must place a row either side of the threshold without sleeping, and supply the
 * host's answer without a network.
 */
export async function settleLostCheckCompletions(args: {
  pullRequestId: string;
  workspaceId: string;
  now: Date;
  readCheckSet?: typeof readReportedCheckSet;
}): Promise<LostCompletionSettle> {
  const { pullRequestId, workspaceId } = args;
  const target = await settleTarget(pullRequestId, workspaceId, args.now);
  if (target === null) return NOTHING_SETTLED;
  const changed = await reReadCheckSetFromHost(
    target,
    workspaceId,
    args.readCheckSet ?? readReportedCheckSet,
  );
  if (!changed) return NOTHING_SETTLED;

  // A WARNING, like the reconcile's replay line: every settle means a delivery was lost,
  // and a steady trickle of them is an ingestion defect worth finding in the logs.
  console.warn('[lostCheckCompletion] settled a check set no delivery completed', {
    pullRequestId,
    commitSha: target.commitSha,
  });

  const actorUserId = await recomputeDeliveredCards(pullRequestId, workspaceId);
  await refreshFeedbackComments({ pullRequestId, commitSha: target.commitSha, workspaceId }).catch(
    logTailFailure('the CI feedback re-render', pullRequestId),
  );
  if (actorUserId === null) return { settled: true, promoted: [] };

  const latch = { changeRequestId: pullRequestId, workspaceId, actorUserId };
  // Each latch re-derives the pull request's verdict at its head and acts only on its own
  // answer, so at most one of the two does anything.
  await withdrawDeliveredCardsOnRed(latch).catch(
    logTailFailure('the red withdrawal', pullRequestId),
  );
  const promoted = await promoteDeliveredCardsOnGreen(latch).catch((err: unknown) => {
    logTailFailure('the green promotion', pullRequestId)(err);
    return [] as string[];
  });
  return { settled: true, promoted };
}
