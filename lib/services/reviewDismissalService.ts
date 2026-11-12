import type { Prisma } from '@/generated/prisma/client';
import {
  ReviewDismissalForbiddenError,
  ReviewDismissalReasonRequiredError,
  ReviewDismissalStaleError,
  ReviewSendBackAlreadyDismissedError,
  ReviewSendBackNotStandingError,
} from '@/lib/agentReview/errors';
import {
  REVIEW_DISMISSED_CHANGE_KIND,
  type ReviewDismissalSnapshot,
} from '@/lib/agentReview/dismissalActivity';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { readStandingReviewRefusal } from '@/lib/approvalGates/reviewRefusal';
import {
  REVIEW_DISMISSAL_REASON_MAX_LENGTH,
  type DismissReviewInput,
  type ReviewDismissalResultDto,
} from '@/lib/dto/agentReview';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { resolveGateAuthority } from '@/lib/services/approvalGatesService';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// DISMISS THE REVIEW (Story MOTIR-10327 · MOTIR-10334; `docs/decisions/approval-gates.md`
// §12.15) — the routed person overrules the review agent's standing send-back at the
// card's current version, with a reason. One service behind
// `POST /api/v1/work-items/{key}/review-dismissal`.
//
// ⚠️ NOTHING IS UN-DONE. The send-back (a gate-off review verdict record, or a decided
// `agent_review` gate) is never edited, and the approve-and-merge gate withdrawn under
// `agent_changes_requested` stays superseded as history. The dismissal is its OWN row,
// and every reader that asks whether a send-back stands reads it:
//   · `readStandingReviewRefusal` — the To fix derivation and the repair claim;
//   · `resolveGateSet` / `agentReviewStanding` — the merge question, and the carried
//     merge (`mergeGates.agentReviewHoldsMerge`).
// So the card's gate set asks again, and the ONE raise path (`reconcileGatesFor`) raises a
// fresh approve-and-merge gate at the same version — no second raise path exists.
//
// ⚠️ THE TRAIL (bug MOTIR-10434). The same transaction appends ONE `review_dismissed`
// revision — the person, the version, the send-back and the reason — so the card's History
// and All feeds show the dismissal beside the agent's `agent_verdict` send-back entry. A
// rolled-back dismissal leaves no entry.
//
// ⚠️ LOCK ORDER — gate rows, then the card, the order every withdrawal takes. The card's
// lock serialises two dismissals, and the unique (card, version) index is the backstop.

/** The reason, trimmed, or a refusal. */
function reasonOf(input: DismissReviewInput): string {
  const reason = input.reasonMd.trim();
  if (!reason || reason.length > REVIEW_DISMISSAL_REASON_MAX_LENGTH) {
    throw new ReviewDismissalReasonRequiredError(REVIEW_DISMISSAL_REASON_MAX_LENGTH);
  }
  return reason;
}

/** The card's delivery set and its version — null when it delivers no pull request. */
async function readDeliverySet(workItemId: string, tx: Prisma.TransactionClient) {
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx);
  return {
    deliveries,
    version: deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d))),
  };
}

/**
 * The card's CURRENT delivery-set version, read exactly as {@link reviewDismissalService.dismiss}
 * computes the version it checks — every pull request as `owner/name#number@headSha`, sorted,
 * comma-joined — or null when it delivers no pull request. MOTIR-11092: the `dismiss_review`
 * MCP tool dismisses at this version when its caller names none. A read only: the dismissal
 * re-reads the version under its locks, so a push in between still answers
 * `REVIEW_DISMISSAL_STALE`.
 */
export async function currentDeliverySetVersion(
  workItemId: string,
  ctx: ServiceContext,
): Promise<string | null> {
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => (await readDeliverySet(workItemId, tx)).version,
  );
}

async function lockGatesThenCard(workItemId: string, tx: Prisma.TransactionClient): Promise<void> {
  const review = await approvalGateRepository.findLatestByWorkItem(workItemId, 'agent_review', tx);
  if (review) await approvalGateRepository.lockById(review.id, tx);
  await workItemRepository.lockById(workItemId, tx);
}

export const reviewDismissalService = {
  /**
   * Dismiss the standing agent send-back at `input.subjectVersion`, the card's current
   * version. Returns the dismissal and the approve-and-merge gate asked again.
   *
   * Throws, writing nothing: `ProjectNotFoundError` / `WorkItemNotFoundError` (not
   * visible), `PermissionDeniedError` (no `work_item:edit`),
   * {@link ReviewDismissalForbiddenError} (not the routed person),
   * {@link ReviewDismissalReasonRequiredError}, {@link ReviewDismissalStaleError},
   * {@link ReviewSendBackNotStandingError}, `ReviewSendBackAlreadyDismissedError`.
   */
  async dismiss(
    projectId: string,
    identifier: string,
    input: DismissReviewInput,
    ctx: ServiceContext,
  ): Promise<ReviewDismissalResultDto> {
    const reasonMd = reasonOf(input);
    const subjectVersion = input.subjectVersion.trim();
    const visible = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    await projectAccessService.assertPermission(projectId, ctx, 'work_item:edit');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        await lockGatesThenCard(visible.id, tx);
        const item = await workItemRepository.findById(visible.id, tx);
        /* v8 ignore next -- the card was readable a moment ago and a lock was granted on it;
           a delete in between is the only way here, and it cascades the whole tree. */
        if (!item) throw new ReviewSendBackNotStandingError(identifier);
        if (!(await resolveGateAuthority(item, ctx, tx))) {
          throw new ReviewDismissalForbiddenError(item.identifier);
        }

        const { deliveries, version: current } = await readDeliverySet(item.id, tx);
        if (current === null || current !== subjectVersion) {
          throw new ReviewDismissalStaleError(subjectVersion, current);
        }
        const already = await reviewDismissalRepository.findAt(item.id, current, tx);
        if (already) throw new ReviewSendBackAlreadyDismissedError(current);
        const standing = await readStandingReviewRefusal(item.id, deliveries, tx);
        if (!standing || standing.kind !== 'agent_review') {
          throw new ReviewSendBackNotStandingError(item.identifier);
        }

        const created = await reviewDismissalRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId: item.projectId,
            workItemId: item.id,
            reviewVerdictRecordId: standing.recordId,
            approvalGateId: standing.recordId === null ? standing.id : null,
            subjectVersion: current,
            reasonMd,
            dismissedById: ctx.userId,
          },
          tx,
        );

        const dismissed: ReviewDismissalSnapshot['dismissed'] =
          created.reviewVerdictRecordId !== null
            ? { kind: 'record', id: created.reviewVerdictRecordId }
            : { kind: 'gate', id: created.approvalGateId as string };
        const snapshot: ReviewDismissalSnapshot = {
          dismissalId: created.id,
          dismissed,
          subjectVersion: current,
          reasonMd: created.reasonMd,
        };
        await workItemRevisionsService.recordRevision(
          {
            workItemId: item.id,
            changedById: ctx.userId,
            changeKind: REVIEW_DISMISSED_CHANGE_KIND,
            // The key is `REVIEW_DISMISSAL_DIFF_KEY`, spelled out so the activity
            // registry's static scan can resolve it.
            diff: { reviewDismissal: { from: null, to: snapshot } },
          },
          tx,
        );

        // The card asks again — the merge question at the same version, through the one
        // raise path — and its To fix answer is recomputed: gates first, then the card.
        await reconcileGatesFor(item, tx);
        await recomputeWorkItemFixReason(item.id, tx);
        const approval = (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)).find(
          (gate) => gate.kind === 'pull_request_approval' && gate.subjectVersion === current,
        );

        deferUntilCommit(() =>
          sendEvent('review/dismissed', {
            workspaceId: ctx.workspaceId,
            projectId: item.projectId,
            workItemId: item.id,
            subjectVersion: current,
            dismissalId: created.id,
          }),
        );

        const row = await reviewDismissalRepository.findAt(item.id, current, tx);
        return {
          key: item.identifier,
          dismissalId: created.id,
          subjectVersion: current,
          dismissed,
          reasonMd: created.reasonMd,
          dismissedBy: { id: ctx.userId, name: row?.dismissedBy?.name ?? null },
          dismissedAt: created.createdAt.toISOString(),
          approvalGateId: approval?.id ?? null,
        };
      },
    );
  },
};
