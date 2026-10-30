import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { toInFlightDeliveryFact } from '@/lib/mappers/aiBoundaryMappers';
import { deriveInFlightCode } from '@/lib/services/inFlightCode';
import type { AiInFlightCodeFields } from '@/lib/dto/ai';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The IN-FLIGHT CODE READ of one card (MOTIR-6618) — the database half of
// `lib/services/inFlightCode.ts`'s pure derivation: its own open deliveries, else
// the nearest ancestor's, per repository. Shared by the hosted planner's item read
// (`aiBoundaryService.getItem`) and the MCP's `get_work_item` (MOTIR-10069), so the
// two planners are handed the SAME answer for the same card — a child riding its
// parent's pull request reads as `inherited` on both, never as "no code yet" on one.
//
// TWO queries however deep the tree: ONE recursive CTE for the ancestor chain and
// ONE batched delivery read for the card plus every ancestor — never a delivery
// query per level.
//
// ⚠️ BOTH READS RUN INSIDE `withWorkspaceServiceContext(ctx.workspaceId)`.
// `work_item_delivery` is policy-gated on `app.workspace_id`, and an unbound read
// returns an EMPTY LIST for a card that has deliveries — `inFlightCode: []`, the
// failure that looks like an answer. The ancestor walk is workspace-filtered at
// every step (the CTE's own tenant gate) and then CUT at the first ancestor outside
// the card's project, so an inherited entry can only ever name a card in it.
//
// The caller has already passed the browse gate on the card itself (both callers
// read it through `workItemsService` first); this read adds no gate of its own.
export const inFlightCodeService = {
  async readForItem(
    itemId: string,
    projectId: string,
    ctx: ServiceContext,
  ): Promise<AiInFlightCodeFields> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      // ROOT→parent order; walked from the parent up.
      const chain = await workItemRepository.findAncestors(itemId, ctx.workspaceId, tx);
      const ancestors: Array<{ id: string; key: string }> = [];
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const a = chain[i]!;
        if (a.projectId !== projectId) break;
        ancestors.push({ id: a.id, key: a.identifier });
      }
      const rows = await workItemDeliveryRepository.listByWorkItemsWithChecks(
        [itemId, ...ancestors.map((a) => a.id)],
        tx,
      );
      return deriveInFlightCode({
        itemId,
        ancestors,
        deliveries: rows.map(toInFlightDeliveryFact),
      });
    });
  },
};
