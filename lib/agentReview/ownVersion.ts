import type { Prisma } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { withoutAncestorDeliveries } from '@/lib/approvalGates/ownDeliveries';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';

/**
 * The item's OWN current delivery-set version — measured as the verdict door measures it
 * (`reviewVerdictService`: `withoutAncestorDeliveries`, then `deliverySetVersion`), so a
 * review run, its gate and its verdict name the same version. Null when the item has no
 * delivery of its own (Story MOTIR-11941; shared by both review doors since MOTIR-11945).
 */
export async function ownDeliverySetVersion(
  item: { id: string; parentId: string | null },
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const { own } = await withoutAncestorDeliveries(
    { id: item.id, parentId: item.parentId, workspaceId },
    await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    tx,
  );
  return own.length === 0 ? null : deliverySetVersion(own.map((d) => deliveryMemberVersion(d)));
}
