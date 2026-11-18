import type { Prisma } from '@/generated/prisma/client';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// THE OWN DELIVERY SET OF MANY CARDS AT ONCE (Bug MOTIR-11695).
//
// `ownDeliveries.ts` answers it for ONE card: its delivery rows less every pull request an
// ANCESTOR also delivers — the set the review and approve-and-merge gates are raised over
// (`gateSetFor`, Bug MOTIR-11624). A batch read model (the review state, one board page at a
// time) cannot afford one ancestor walk per card, so this asks the same question of a whole
// page in the same TWO reads: every card's ancestor chain (one recursive CTE) and every
// delivery row of every pull request the page delivers (one indexed read).

/**
 * `deliveries` — the delivery rows of any number of cards, each carrying its `workItemId` —
 * WITHOUT the rows whose pull request an ancestor of that row's card also delivers. Order is
 * kept. Nothing is read when there is nothing to filter.
 */
export async function withoutAncestorDeliveriesForCards<
  T extends { workItemId: string; githubPullRequestId: string },
>(workspaceId: string, deliveries: readonly T[], tx: Prisma.TransactionClient): Promise<T[]> {
  if (deliveries.length === 0) return [];
  const cardIds = [...new Set(deliveries.map((delivery) => delivery.workItemId))];
  const pullRequestIds = [...new Set(deliveries.map((delivery) => delivery.githubPullRequestId))];
  const [chains, rows] = await Promise.all([
    workItemRepository.findAncestorIdsForItems(cardIds, workspaceId, tx),
    workItemDeliveryRepository.listByPullRequests(pullRequestIds, tx),
  ]);
  const deliverersByPullRequest = new Map<string, Set<string>>();
  for (const row of rows) {
    const deliverers = deliverersByPullRequest.get(row.githubPullRequestId) ?? new Set();
    deliverers.add(row.workItemId);
    deliverersByPullRequest.set(row.githubPullRequestId, deliverers);
  }
  return deliveries.filter((delivery) => {
    // The batch walk seeds every id it is asked about, so every card's chain is present.
    const ancestors = chains.get(delivery.workItemId)!;
    // Every delivery's own row is among its pull request's rows, so the set is never absent.
    const deliverers = deliverersByPullRequest.get(delivery.githubPullRequestId)!;
    return !ancestors.some((ancestorId) => deliverers.has(ancestorId));
  });
}
