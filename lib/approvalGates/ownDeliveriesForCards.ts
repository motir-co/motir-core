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
//
// ⚠️ THE SAME RULE ON INHERITANCE (Bug MOTIR-12091): a card's own `inherited` row is not its
// question, and an ancestor's `inherited` row takes nothing from the card below it — only an
// EXPLICIT ancestor row is the parent run's branch. See `ownDeliveries.ts`.

/**
 * `deliveries` — the delivery rows of any number of cards, each carrying its `workItemId` —
 * WITHOUT the inherited rows and the rows whose pull request an ancestor of that row's card
 * also delivers explicitly. Order is kept. Nothing is read when there is nothing to filter.
 */
export async function withoutAncestorDeliveriesForCards<
  T extends { workItemId: string; githubPullRequestId: string; inherited: boolean },
>(workspaceId: string, deliveries: readonly T[], tx: Prisma.TransactionClient): Promise<T[]> {
  const explicit = deliveries.filter((delivery) => !delivery.inherited);
  if (explicit.length === 0) return [];
  const cardIds = [...new Set(explicit.map((delivery) => delivery.workItemId))];
  const pullRequestIds = [...new Set(explicit.map((delivery) => delivery.githubPullRequestId))];
  const [chains, rows] = await Promise.all([
    workItemRepository.findAncestorIdsForItems(cardIds, workspaceId, tx),
    workItemDeliveryRepository.listByPullRequests(pullRequestIds, tx),
  ]);
  const deliverersByPullRequest = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.inherited) continue;
    const deliverers = deliverersByPullRequest.get(row.githubPullRequestId) ?? new Set();
    deliverers.add(row.workItemId);
    deliverersByPullRequest.set(row.githubPullRequestId, deliverers);
  }
  return explicit.filter((delivery) => {
    // The batch walk seeds every id it is asked about, so every card's chain is present.
    const ancestors = chains.get(delivery.workItemId)!;
    // Every delivery's own (explicit) row is among its pull request's rows, so the set is
    // never absent.
    const deliverers = deliverersByPullRequest.get(delivery.githubPullRequestId)!;
    return !ancestors.some((ancestorId) => deliverers.has(ancestorId));
  });
}
