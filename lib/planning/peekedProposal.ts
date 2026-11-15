import type { PlanReviewItemDto } from '@/lib/dto/planReview';

/**
 * The proposal an OPEN peek shows: the newest copy of it in `items`, matched by
 * its `planItemId`, live or not (MOTIR-8595; bug MOTIR-11320).
 *
 * The peek captures the item when it opens. While the plan is written the walk
 * keeps replacing that item — an outline first, its written body later — and
 * the open peek has to follow it. It has to keep following once the plan leaves
 * `generating` too: the copy taken at open is OLDER than the body the walk wrote,
 * so falling back to it on that flip made a written card jump back to its
 * outline at the moment the reader was about to review it.
 *
 * The open-time copy is the answer only when the proposal is no longer in
 * `items` (withdrawn mid-view): closing the peek is the reader's act, never the
 * snapshot's.
 */
export function currentPeekedProposal(
  items: readonly PlanReviewItemDto[],
  opened: PlanReviewItemDto | null,
): PlanReviewItemDto | null {
  if (!opened) return null;
  return items.find((i) => i.planItemId === opened.planItemId) ?? opened;
}
