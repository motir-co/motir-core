import type { Prisma, WorkItem } from '@/generated/prisma/client';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// A CARD'S OWN DELIVERY SET (Bugs MOTIR-11624 · MOTIR-11673 · MOTIR-11693).
//
// A pull request linked both to a card and to one of its ancestors is the ANCESTOR's: it is
// the parent run's branch, and only the parent's approval may ask to merge it — the merge
// cascades down and closes every child, built or not. So the review and approve-and-merge
// gates are raised over a card's OWN members only (`gateSetFor`), and every reader that
// measures a version AGAINST one of those gates has to measure the same set.
//
// ⚠️ ONE DEFINITION, BECAUSE TWO SPLIT (Bug MOTIR-11693). The verdict door, the dismissal and
// the To fix derivation used to measure the card's WHOLE linked set. For a child with one
// pull request of its own and one its story also delivers, the review gate named one pull
// request and every reader named two — so no verdict could ever decide that gate. Every
// reader of the version now goes through this module.

/** The card fields the ancestor walk needs. `parentId` omitted means "not known — walk". */
export type OwnDeliveriesCard = Pick<WorkItem, 'id' | 'workspaceId'> &
  Partial<Pick<WorkItem, 'parentId'>>;

/**
 * The card's delivery rows WITHOUT the ones an ANCESTOR also delivers, and how many it left
 * out. Two reads, and only for a card that delivers something and may have a parent: the
 * ancestor chain (one recursive CTE) and every delivery row of the card's pull requests (one
 * indexed read). A card known to be top-level (`parentId: null`) reads nothing.
 */
export async function withoutAncestorDeliveries<T extends { githubPullRequestId: string }>(
  item: OwnDeliveriesCard,
  deliveries: readonly T[],
  tx: Prisma.TransactionClient,
): Promise<{ own: T[]; ancestorOwned: number }> {
  if (item.parentId === null || deliveries.length === 0) {
    return { own: [...deliveries], ancestorOwned: 0 };
  }
  const [chains, rows] = await Promise.all([
    workItemRepository.findAncestorIdsForItems([item.id], item.workspaceId, tx),
    workItemDeliveryRepository.listByPullRequests(
      deliveries.map((delivery) => delivery.githubPullRequestId),
      tx,
    ),
  ]);
  // The batch walk seeds every id it is asked about, so the card's chain is always present.
  const ancestorIds = new Set(chains.get(item.id)!);
  const ancestorPullRequests = new Set(
    rows.filter((row) => ancestorIds.has(row.workItemId)).map((row) => row.githubPullRequestId),
  );
  const own = deliveries.filter(
    (delivery) => !ancestorPullRequests.has(delivery.githubPullRequestId),
  );
  return { own, ancestorOwned: deliveries.length - own.length };
}

/**
 * The card's OWN members out of its whole delivery set, for a reader that holds only the
 * card's id. The workspace is the rows' own — a delivery row is admitted on its card's
 * workspace — so a card that delivers nothing reads nothing.
 */
export async function ownDeliveriesOf(
  workItemId: string,
  deliveries: readonly WorkItemDeliveryWithChecks[],
  tx: Prisma.TransactionClient,
): Promise<WorkItemDeliveryWithChecks[]> {
  if (deliveries.length === 0) return [];
  const { own } = await withoutAncestorDeliveries(
    { id: workItemId, workspaceId: deliveries[0]!.workspaceId },
    deliveries,
    tx,
  );
  return own;
}

/**
 * The card's OWN delivery set WITH its check rows — `listByWorkItemWithChecks` less every
 * pull request an ancestor also delivers. The set the review and approve-and-merge gates are
 * raised over, and so the set any version compared with them is measured over.
 */
export async function listOwnDeliveriesWithChecks(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<WorkItemDeliveryWithChecks[]> {
  const linked = await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx);
  return ownDeliveriesOf(workItemId, linked, tx);
}
