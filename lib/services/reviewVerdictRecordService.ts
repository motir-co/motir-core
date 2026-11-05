import type { Prisma, ReviewVerdictRecord } from '@/generated/prisma/client';
import { HOSTED_REVIEW_HARNESS } from '@/lib/agentReview/reviewState';
import {
  AGENT_VERDICT_CHANGE_KIND,
  findingsExcerptOf,
  isAnsweringSendBack,
  type AgentVerdictSnapshot,
} from '@/lib/agentReview/verdictActivity';
import {
  reviewVerdictRecordRepository,
  type ReviewVerdictRecordCreateRow,
} from '@/lib/repositories/reviewVerdictRecordRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { reviewSentBackService } from '@/lib/services/reviewSentBackService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';

// THE ONE WRITE OF A REVIEW VERDICT RECORD (Story MOTIR-10327 · MOTIR-10338).
//
// Every verdict — the user-token door's (`reviewVerdictService`) and the hosted run's
// (`agentReviewRunService`), at every version and every outcome — is written through
// {@link reviewVerdictRecordService.record}, so three things that must agree are written
// together, in the caller's transaction:
//
//   1. the record itself (`reviewVerdictRecordRepository.create`, whose partial unique
//      index still throws `ReviewVerdictAnswerExistsError` for a second answer);
//   2. ONE `agent_verdict` revision on the card's trail, a snapshot of what the activity
//      feed draws (`lib/agentReview/verdictActivity.ts`) — so the History and All views,
//      their cursor and their counts take verdicts through the trail they already page;
//   3. for an answering send-back, the assignee's notification, deferred until commit.
//
// ⚠️ IT DECIDES NOTHING. The outcome is the caller's; this only records it.

/** Whom an answering send-back notifies: the card's assignee — never the person whose own
 *  agent sent it back (they ran it and already know), and nobody on a card with none. */
function sendBackRecipient(
  assigneeId: string | null,
  row: Pick<ReviewVerdictRecordCreateRow, 'submittedById' | 'harness'>,
): string | null {
  if (!assigneeId) return null;
  const hosted = row.harness === HOSTED_REVIEW_HARNESS;
  if (!hosted && assigneeId === row.submittedById) return null;
  return assigneeId;
}

export const reviewVerdictRecordService = {
  /** Record one verdict, its history entry and (for an answering send-back) its notice. */
  async record(
    row: ReviewVerdictRecordCreateRow,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewVerdictRecord> {
    const record = await reviewVerdictRecordRepository.create(row, tx);
    const item = await workItemRepository.findById(row.workItemId, tx);
    const recipient =
      item && isAnsweringSendBack(record) ? sendBackRecipient(item.assigneeId, row) : null;

    // The trail needs an actor; a verdict always has one at the write (the token's user, or
    // the hosted run's), and only a deleted user leaves the column null afterwards.
    if (row.submittedById) {
      const snapshot: AgentVerdictSnapshot = {
        recordId: record.id,
        verdict: record.verdict === 'pass' ? 'pass' : 'changes_requested',
        outcome: record.outcome,
        hosted: record.harness === HOSTED_REVIEW_HARNESS,
        harness: record.harness,
        model: record.model,
        subjectVersion: record.subjectVersion,
        findingsExcerpt: findingsExcerptOf(record.findingsMd),
        notifiedUserId: recipient,
      };
      await workItemRevisionsService.recordRevision(
        {
          workItemId: row.workItemId,
          changedById: row.submittedById,
          changeKind: AGENT_VERDICT_CHANGE_KIND,
          // The key is `AGENT_VERDICT_DIFF_KEY`, spelled out so the activity registry's
          // static scan can resolve it.
          diff: { agentVerdict: { from: null, to: snapshot } },
        },
        tx,
      );
    }

    if (recipient) {
      deferUntilCommit(() =>
        reviewSentBackService
          .notify(row.workspaceId, record.id, row.workItemId, recipient)
          .then(() => undefined),
      );
    }
    return record;
  },
};
