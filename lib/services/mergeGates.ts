import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import type { GitProviderId } from '@/lib/git/types';
import { pullRequestHead, prCiStateAtHead } from '@/lib/github/pullRequestHead';
import { isConflictedAt } from '@/lib/github/mergeability';
import {
  githubPullRequestRepository,
  type GithubPullRequestWithInstallation,
} from '@/lib/repositories/githubPullRequestRepository';
import {
  acceptanceRefusalHoldsMerge,
  agentReviewStanding,
  designHoldsMerge,
  primaryApprovalStandsForMerge,
} from '@/lib/approvalGates/gateSet';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import { decisionHoldsMerge } from '@/lib/approvalGates/decisionApprovalHandler';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveRunTargetFor } from './runTarget';

// SETTLE a card's green verdict (Story MOTIR-4882 · MOTIR-5518; MOTIR-5603 · MOTIR-5611).
//
// ⚠️ THIS MODULE NO LONGER RAISES A GATE. A card has ONE approve-to-merge gate — the
// `pull_request_approval` gate over its delivery set, raised by `pullRequestApprovalGates`
// — and approving it merges every pull request the card delivers. The per-pull-request
// `pull_request_merge` gate is retired, with its raise and its three withdraw paths
// (`docs/decisions/approval-gates.md` §8's SECOND AMENDMENT, MOTIR-5609, decisions 1-5).
//
// What survives here is the half BOTH merge modes share: the one statement of whether a
// pull request is a merge candidate right now, and the `auto` arm that returns the merges
// the promotion owes after it commits. In `manual` the answer is now "nothing to do" —
// the gate that asks the question lives elsewhere.

/** One auto merge the promotion owes AFTER it commits (MOTIR-5518). */
export interface AutoMergeRequest {
  pullRequestId: string;
  headSha: string;
}

/**
 * The HEAD a merge candidate would be merged at, or `null` when the pull request is not
 * a merge candidate NOW — open, on a provider that can merge, and green at its latest
 * head. Asked by the `auto` arm below and by the approve-and-merge gate's own raise, so
 * both modes read one statement of it.
 *
 * ⚠️ A green pull request always HAS a head: `prCiStateAtHead` answers `passing` only
 * over a non-empty set of rows AT the pull request's head, so the head exists whenever
 * the verdict is green and is not checked for separately.
 *
 * ⚠️ AND A DRAFT IS NOT A CANDIDATE (MOTIR-5699). A draft is its author saying *not
 * ready*, and the host refuses to merge one — so a green draft that counted here put an
 * approve-and-merge question on somebody's To approve that could only fail when
 * pressed. The lifecycle seam has refused drafts since MOTIR-4968; this is the same
 * fact reaching the gate. Only `true` refuses: `null` is a row written before
 * MOTIR-5002 persisted the flag, and inventing draft-ness for it would strand a card
 * nobody drafted.
 *
 * ⚠️ AND NEITHER IS A MEMBER THE HOST REPORTS CONFLICTED AT THAT HEAD (MOTIR-5913, for
 * bug MOTIR-5907). A green pull request that no longer combines with its base can only
 * be refused when pressed, so it is asked about nobody — `lib/github/mergeability.ts`
 * holds the rule the three readers share. `null` stays a candidate, for the draft
 * arm's reason: an answer nobody has computed is not a conflict. *
 * ⚠️ AND "GREEN AT ITS HEAD" MEANS THE PULL REQUEST'S HEAD (MOTIR-7005). A push that
 * produced no check rows leaves the newest rows at the old commit; that commit is not
 * the pull request, so its green makes nothing a candidate — `prCiStateAtHead` answers
 * `null` for a head with no rows, and the head returned is the stored one.
 */
export function mergeCandidateHead(
  pr:
    | (Pick<
        GithubPullRequestWithInstallation,
        | 'state'
        | 'merged'
        | 'draft'
        | 'headSha'
        | 'checkRuns'
        | 'mergeableState'
        | 'mergeableStateHeadSha'
      > & {
        repo: { provider: string };
      })
    | null,
): string | null {
  if (
    pr === null ||
    pr.state !== 'open' ||
    pr.merged ||
    pr.draft === true ||
    !providerSupportsMerge(getGitProvider(pr.repo.provider as GitProviderId)) ||
    prCiStateAtHead(pr) !== 'passing'
  ) {
    return null;
  }
  const head = pullRequestHead(pr)!;
  return isConflictedAt(pr, head) ? null : head;
}

/**
 * SETTLE A GREEN VERDICT on a card — the one hook the CI promotion calls, in its own
 * transaction, for both modes (MOTIR-5518 · MOTIR-5611):
 *
 *   - `manual` → raise NOTHING here. The card's single approve-to-merge gate is raised
 *     by `raisePullRequestApprovalGate`, in the same transaction, over the same set;
 *   - `auto` → raise nothing either, and return the merges to dispatch once the
 *     transaction has committed — a job enqueued before the commit could run against a
 *     promotion that then rolled back.
 *
 * Either way only the RUN TARGET's members count, and only merge candidates.
 */
/** {@link primaryApprovalStandsForMerge}, read from the card's own rows — a standing
 *  DESIGN or ACCEPTANCE approval (MOTIR-5789). The one-time clause is NOT here: it is
 *  {@link primaryApprovalCarries}'s, so all three primaries share one statement of it. */
async function primaryApprovalHolds(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const [currentDesign, latestDesignGate, currentReceipt, latestAcceptanceGate] = await Promise.all(
    [
      designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
      approvalGateRepository.findLatestByWorkItem(workItemId, 'design_result', tx),
      acceptanceEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
      approvalGateRepository.findLatestByWorkItem(workItemId, 'acceptance_result', tx),
    ],
  );
  return primaryApprovalStandsForMerge({
    currentDesign,
    latestDesignGate,
    currentReceipt,
    latestAcceptanceGate,
  });
}

/**
 * Does a standing DECISION approval authorise this card's merge — `false` for a card
 * that does not ask the decision question at all (Story MOTIR-4907 · MOTIR-5677;
 * `approval-gates.md` §8's FIFTH AMENDMENT, clause 5).
 */
async function decisionApprovalHolds(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  return asksTheDecisionQuestion(item) && !(await decisionHoldsMerge(item, tx));
}

/**
 * Does a PRIMARY approval — the design's, the acceptance's or the decision's — carry
 * this card's merge?
 * The same ONE-TIME clause the predicate applies: once a merge gate has existed, the
 * commits are the merge gate's question and a later green is not the primary's to carry
 * (MOTIR-5666).
 */
async function primaryApprovalCarries(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const latestMergeGate = await approvalGateRepository.findLatestByWorkItem(
    item.id,
    'pull_request_approval',
    tx,
  );
  if (latestMergeGate !== null) return false;
  return (await primaryApprovalHolds(item.id, tx)) || (await decisionApprovalHolds(item, tx));
}

/**
 * Does the REVIEW AGENT hold this card's merge (Story MOTIR-1626 · MOTIR-6819;
 * `approval-gates.md` §12.2)? True while the switch is on in a `manual` project and the
 * review at the delivery set's CURRENT version has not passed — owed, awaiting, or sent
 * back. {@link agentReviewStanding} is the one statement of it, shared with the gate set.
 *
 * ⚠️ WHAT IT HOLDS IS A PRIMARY'S CARRIED MERGE. The predicate stops asking the merge
 * question while the review is owed, but a design, decision or acceptance approved before
 * the set went green carries the merge with no merge gate at all (AMENDMENT 6 Q4) — and
 * that carry is settled HERE, by the green verdict or by `settleAfterPrimaryApproval`. So
 * the carry waits for the review, and a review's pass reaches this same settlement
 * (`agentReviewHandler`'s after-commit), the way a primary approved before green does.
 * No code merges unreviewed, whichever gate a person pressed.
 */
export async function agentReviewHoldsMerge(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const settings = await projectRepository.findMergeSettings(item.projectId, tx);
  if (settings?.prMergeMode !== 'manual') return false;
  // A GATE-OFF agent send-back at the current version holds the carried merge too
  // (MOTIR-10333; `approval-gates.md` §12.14): no code the review agent sent back merges
  // on a carry, whatever the switch says.
  // A person's DISMISSAL at the version (MOTIR-10334; §12.15) releases it again.
  const [deliveries, latestAgentReviewGate, latestMergeGate, latestSendBack, latestDismissal] =
    await Promise.all([
      workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
      approvalGateRepository.findLatestByWorkItem(item.id, 'agent_review', tx),
      approvalGateRepository.findLatestByWorkItem(item.id, 'pull_request_approval', tx),
      reviewVerdictRecordRepository.findLatestRecordedSendBack(item.id, tx),
      reviewDismissalRepository.findLatestByWorkItem(item.id, tx),
    ]);
  const version = deliverySetVersion(deliveries.map((delivery) => deliveryMemberVersion(delivery)));
  const dismissedVersion = latestDismissal?.subjectVersion ?? null;
  if (
    version !== null &&
    latestSendBack?.subjectVersion === version &&
    dismissedVersion !== version
  ) {
    return true;
  }
  if (!settings.reviewAgentEnabled) return false;
  const standing = agentReviewStanding({
    reviewAgentEnabled: settings.reviewAgentEnabled,
    prMergeMode: settings.prMergeMode,
    workItemId: item.id,
    version,
    latestAgentReviewGate,
    latestMergeGate,
    dismissedVersion,
  });
  return standing === 'owed' || standing === 'refused';
}

/**
 * {@link designHoldsMerge}, read from the card's own rows — whether an unanswered design
 * holds this card's merge (Bug MOTIR-5762). Exported for the review sync, the other merge
 * path that does not go through the design's own press.
 */
export async function designResultHoldsMerge(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const [currentDesign, latestDesignGate] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'design_result', tx),
  ]);
  return designHoldsMerge(currentDesign, latestDesignGate);
}

/**
 * {@link acceptanceRefusalHoldsMerge}, read from the story's own rows — whether a story
 * run's refused acceptance holds its merge (Story MOTIR-6071 · MOTIR-6503). Read by the
 * two manual-mode merge paths that do not go through the acceptance's own press: the
 * approve-to-merge gate's `approve` and the GitHub review sync.
 */
export async function acceptanceResultHoldsMerge(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const [currentReceipt, latestAcceptanceGate] = await Promise.all([
    acceptanceEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'acceptance_result', tx),
  ]);
  return acceptanceRefusalHoldsMerge(currentReceipt, latestAcceptanceGate);
}

export async function settleGreenVerdict(
  args: { item: WorkItem; pullRequestIds: readonly string[] },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<AutoMergeRequest[]> {
  void ctx;
  if (args.pullRequestIds.length === 0) return [];
  const mode = await projectRepository.findPrMergeMode(args.item.projectId, tx);
  if (mode?.prMergeMode === 'manual') {
    // ⚠️ THE MERGE A DESIGN APPROVAL IS ALREADY HOLDING (Story MOTIR-5652 ·
    // Subtask MOTIR-5664; `design-result.md` AMENDMENT 6 Q4). The design gate
    // rises on PUBLISH and the merge gate on GREEN, so the primary can be
    // pressed before CI has spoken — and Q4 settles that the press is not
    // refused: *"the decision stands and the merge follows on the next green
    // verdict, with no second press."* This IS that next green.
    //
    // The predicate has already answered *no merge gate is owed* for the same
    // reason, so without this arm the card would go green holding an approval
    // nobody carried out. Both readers ask the one question, in
    // `primaryApprovalStandsForMerge` — which covers the design's approval and the
    // ACCEPTANCE's (MOTIR-5789) — and, for a DECISION card, in
    // `decisionApprovalStandsForMerge` (MOTIR-5677, clause 5).
    if (!(await primaryApprovalCarries(args.item, tx))) return [];
    // ⚠️ …AND THE CARRY WAITS FOR THE REVIEW AGENT (MOTIR-6819; `approval-gates.md` §12.2):
    // a primary approved while the review has not passed records its decision and carries
    // nothing yet. The review's pass settles the card again and lands here.
    if (await agentReviewHoldsMerge(args.item, tx)) return [];
  } else if (mode?.prMergeMode !== 'auto') {
    return [];
  } else if ((await resolveRunTargetFor(args.item, tx)).kind === 'ancestor') {
    return [];
  } else if (await designResultHoldsMerge(args.item.id, tx)) {
    // ⚠️ AN UNANSWERED DESIGN HOLDS AN AUTOMATIC MERGE (Bug MOTIR-5762; `design-result.md`
    // AMENDMENT 6 Q1). §7a's *"`auto` means no gate"* is about the MERGE gate — the design
    // gate is raised at publish in both modes, and it is the PRIMARY question the merge
    // follows. Awaiting, sent back, or approved for a result since superseded all hold.
    // The merge follows the approval: on the next green verdict, or at once when the press
    // lands on a set that is already green (`pullRequestMergeService`).
    return [];
  } else if (await decisionHoldsMerge(args.item, tx)) {
    // ⚠️ …AND SO DOES AN UNANSWERED DECISION (MOTIR-5677; `approval-gates.md` §8's FIFTH
    // AMENDMENT, clause 6). `auto` means no MERGE gate (§7a) — never that a decision nobody
    // accepted may ship. Awaiting, unresolvable and not-yet-captured all hold: the safe
    // reading of *"not known yet"* is *"not accepted"*. The merge follows the approval the
    // same way the design's does.
    return [];
  }

  const requests: AutoMergeRequest[] = [];
  for (const pullRequestId of args.pullRequestIds) {
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    const headSha = mergeCandidateHead(pr);
    if (pr && headSha) requests.push({ pullRequestId: pr.id, headSha });
  }
  return requests;
}
