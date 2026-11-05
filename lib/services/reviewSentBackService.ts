import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A SEND-BACK NOTIFIES THE ASSIGNEE ONCE (Story MOTIR-10327 · MOTIR-10338;
// `approval-gates.md` §12.16). An agent's `changes_requested` verdict that ANSWERED its
// version (`decided` or `recorded`) moves the card to To fix and asks nobody to approve it,
// so the card's assignee is told, with a link to the findings.
//
// ⚠️ ONCE BY THE DEDUPE KEY, NOT BY A FLAG. The key is `review_sent_back:<recordId>`, and
// the `(dedupeKey, recipientUserId)` unique absorbs every repeat: a retried job, a reload,
// a redelivered event. A second verdict at the same version is a NEW record whose outcome
// is `second`, which never reaches this service — so a version notifies once.
//
// ⚠️ THE RECIPIENT IS CHOSEN AT THE WRITE, inside the record's transaction
// (`reviewVerdictRecordService`), so the activity entry's "{name} was notified" names the
// same person this writes to. Called after that transaction commits. Best-effort, as every
// notification is: a row that could not be written never fails the verdict.

export type ReviewSentBackNotifyOutcome = 'notified' | 'off' | 'gone';

export const reviewSentBackService = {
  /** Tell `recipientUserId` that the record's card was sent back by an agent. */
  async notify(
    workspaceId: string,
    recordId: string,
    workItemId: string,
    recipientUserId: string,
  ): Promise<ReviewSentBackNotifyOutcome> {
    const item = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    /* v8 ignore next -- the record cascades with its card; only a delete between the
       commit and this read gets here. */
    if (!item) return 'gone';
    const written = await notificationFanInService.notifyProjectEvent({
      workspaceId,
      recipientUserId,
      type: NOTIFICATION_EVENT_TYPE.reviewSentBack,
      // DIRECT: it is their card, and it is now theirs to repair.
      category: 'direct',
      dedupeKey: `${NOTIFICATION_EVENT_TYPE.reviewSentBack}:${recordId}`,
      workItemId: item.id,
      data: {
        kind: 'review_sent_back',
        issueKey: item.identifier,
        title: item.title,
        recordId,
      },
    });
    return written ? 'notified' : 'off';
  },
};
