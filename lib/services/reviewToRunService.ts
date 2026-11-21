import { reviewCommand } from '@/lib/agentReview/reviewState';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A REVIEW TO RUN IS NOTIFIED ONCE (Story MOTIR-10327 · MOTIR-10340; `approval-gates.md`
// §12.1's 2026-11-04 amendment, §12.10; Story MOTIR-11941 · MOTIR-11943). Nothing starts a
// review by itself, so the routed person is told — once per awaiting `agent_review` gate,
// whichever way they will run it — that a review is waiting on them.
//
// ⚠️ ONCE BY THE DEDUPE KEY, NOT BY A FLAG. The key is `review_to_run:<gateId>`, and the
// `(dedupeKey, recipientUserId)` unique absorbs every repeat: a redelivered raise, a retried
// job, a later reconcile. A head move supersedes the gate and raises a NEW one at the
// new version, whose id is a new key — so it notifies once for itself.
//
// ⚠️ ONE CALLER: the one gate creator (`gateSetFor.ts`'s `reconcileGatesFor`), after the
// transaction that raised the gate committed — so every raise path notifies. Best-effort,
// as every notification is: a row that could not be written never fails the raise.

/** What one notify call did. */
export type ReviewToRunNotifyOutcome = 'notified' | 'not_a_review_to_run' | 'no_recipient' | 'off';

export const reviewToRunService = {
  /** Notify the routed person that this awaiting `agent_review` gate is theirs to run. */
  async notifyRaised(workspaceId: string, gateId: string): Promise<ReviewToRunNotifyOutcome> {
    const read = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const gate = await approvalGateRepository.findById(gateId, tx);
      if (!gate || gate.kind !== 'agent_review' || gate.state !== 'awaiting' || !gate.workItemId) {
        return null;
      }
      const item = await workItemRepository.findById(gate.workItemId, tx);
      /* v8 ignore next -- the gate cascades with its card. */
      if (!item) return null;
      const settings = await projectRepository.findMergeSettings(item.projectId, tx);
      if (!settings?.reviewAgentEnabled) return null;
      return { item };
    });
    if (!read) return 'not_a_review_to_run';
    const recipientUserId = routingTargetId(read.item);
    /* v8 ignore next -- `reporterId` is NOT NULL, so §2's rule always names somebody. */
    if (!recipientUserId) return 'no_recipient';
    const written = await notificationFanInService.notifyProjectEvent({
      workspaceId,
      recipientUserId,
      type: NOTIFICATION_EVENT_TYPE.reviewToRun,
      // DIRECT: the review is routed to them, as a gate is.
      category: 'direct',
      dedupeKey: `${NOTIFICATION_EVENT_TYPE.reviewToRun}:${gateId}`,
      workItemId: read.item.id,
      data: {
        kind: 'review_to_run',
        issueKey: read.item.identifier,
        title: read.item.title,
        command: reviewCommand(read.item.identifier),
      },
    });
    return written ? 'notified' : 'off';
  },
};
