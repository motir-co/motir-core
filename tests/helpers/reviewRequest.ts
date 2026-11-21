import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { reviewRaiseKey } from '@/lib/agentReview/reviewRunKey';

/**
 * THE REVIEW REQUEST A PERSON'S PRESS SENDS for an awaiting `agent_review` gate (Story
 * MOTIR-11941 · MOTIR-11943). Nothing requests a review by itself any more — the raise
 * only notifies — so a suite that goes on to exercise a hosted review run builds the
 * request here and hands it to `agentReviewStartService.startRequested` (or the job)
 * itself. The key defaults to the gate's raise key, so one request per gate stays
 * idempotent exactly as the old automatic start was.
 */
export function reviewRequestFor(
  gate: {
    id: string;
    workspaceId: string;
    workItemId: string | null;
    subjectVersion: string | null;
  },
  idempotencyKey: string = reviewRaiseKey(gate.id),
): AgentReviewRequestedData {
  if (gate.workItemId === null || gate.subjectVersion === null) {
    throw new Error(`gate ${gate.id} is not a review gate on a card at a named version`);
  }
  return {
    workspaceId: gate.workspaceId,
    gateId: gate.id,
    workItemId: gate.workItemId,
    subjectVersion: gate.subjectVersion,
    idempotencyKey,
  };
}
