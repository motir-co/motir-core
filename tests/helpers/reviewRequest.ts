import type { ReviewStartResult } from '@/lib/services/agentReviewStartService';
import type { HostedRunStartOptions } from '@/lib/services/hostedRunService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from './adminDb';

/**
 * A PERSON'S PRESS of *Review with Motir agent* (Story MOTIR-11941 · MOTIR-11944,
 * `approval-gates.md` §12.18) for the item a review gate (or any `{ workItemId }`) names.
 * Nothing starts a review by itself, so a suite that goes on to exercise a hosted review run
 * presses for it here, through the real `agentReviewStartService.startRequested`.
 *
 * The presser defaults to the person the review is routed to — the assignee, else the
 * reporter — who holds the authority the press asks for; pass `ctx` to press as someone
 * else. The service is imported lazily, so a suite's `vi.mock`s apply to it.
 */
export async function pressReview(
  target: { workItemId: string | null; workspaceId: string },
  opts: { ctx?: ServiceContext; model?: string; options?: HostedRunStartOptions } = {},
): Promise<ReviewStartResult> {
  if (target.workItemId === null) throw new Error('a review press needs the item it reviews');
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.workItemId } });
  const ctx = opts.ctx ?? {
    userId: item.assigneeId ?? item.reporterId,
    workspaceId: target.workspaceId,
  };
  const { agentReviewStartService } = await import('@/lib/services/agentReviewStartService');
  return agentReviewStartService.startRequested(
    { workItemKey: item.identifier, ...(opts.model ? { model: opts.model } : {}) },
    ctx,
    opts.options ?? {},
  );
}
