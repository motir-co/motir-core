import type { WorkItem } from '@/generated/prisma/client';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { isManualReadyItem } from '@/lib/dto/ready';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { requireArgsCard, requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// THE `manual_work` HANDLER (Story MOTIR-7460 · Subtask MOTIR-7474;
// `docs/decisions/manual-work-gate.md` §1, §4, §5).
//
// A run reached a manual card and could not do it, so the card WAITS ON A PERSON. The
// subject is the work item itself — nothing about the work has a version — and the
// decision is the work being done: Mark done is `approve`, which writes the project's
// Done through `applyStatusTransition` with `decidingGateId`, exactly as
// `decision_choice`'s choose does (Workflow A). With an open linked pull request it
// writes no status, because the merge is the single writer of `done` (§6d rule 2b),
// as `design_result` does.
//
// It differs from every other card kind in two places:
//
//   · NO REQUEST CHANGES. Manual work is done or not done; a person who cannot do it
//     says so on the card or in the guide. The door refuses the verb by name before
//     dispatching, and this handler refuses it again so no other caller can reach it.
//   · NO RE-ASK ON REVIEW. `currentSubject` answers null always: a run is this kind's
//     one raiser (`manualWorkGateService.raise`), and entering review raises nothing.

/** Mark done is terminal: Workflow A, the project's `done` category. */
export const MANUAL_WORK_TARGET = { key: 'done', category: 'done' } as const;

/** Whether a card is manual work a person owes — the ONE predicate the raise and the
 *  withdrawal share with the CLI's `needs_human` (`isManualReadyItem`). */
export function isManualWork(item: Pick<WorkItem, 'executor' | 'type'>): boolean {
  return isManualReadyItem(item);
}

export const manualWorkGateHandler: GateHandler<WorkItem> = {
  // The subject IS the card, and it resolves while the card does and is still manual.
  // A card edited off manual has its gate withdrawn in the edit's transaction
  // (`no_longer_manual`), so a reader meeting one here is the race that lost.
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<WorkItem | null> {
    const item = await workItemRepository.findById(gate.subjectId, tx);
    return item && isManualWork(item) ? item : null;
  },

  /** Nothing about the work has a version: the decision is that it is done (§1). */
  async subjectVersion(): Promise<string | null> {
    return null;
  },

  /** A run is the one raiser (§2); entering review asks this kind nothing (§1). */
  async currentSubject(): Promise<string | null> {
    return null;
  },

  // §3: `assigneeId ?? reporterId`, unchanged. The run's starter is reached because
  // the raise ASSIGNS an unassigned card to them, never by routing around the card.
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'manual_work', 'manualWorkHandler'));
  },

  permission: 'work_item:edit',

  statusIntent: MANUAL_WORK_TARGET,

  /** MARK DONE — write the project's Done and decide the gate (§4). */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, tx, resolvedStatusKey } = args;
    const cardId = requireGateCard(gate, 'manualWorkHandler');
    const openPullRequests = await workItemDeliveryRepository.countOpenByWorkItem(cardId, tx);
    if (openPullRequests > 0) {
      return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
    }
    if (resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    // ⚠️ IMPORTED HERE, NOT AT THE TOP — the `workItemsService` → `approvalGatesService`
    // → registry → this module cycle `gateTransition` documents.
    const { hopsToStatus } = await import('@/lib/services/manualWorkGateService');
    // A run SKIPPED this card, so it usually stands in To do — and no workflow declares
    // To do → Done. Mark done walks the declared edges there, each one a real transition
    // with its own revision; a card with no road to Done refuses on the direct move, as
    // any other move would.
    const card = await workItemRepository.findById(cardId, tx);
    const hops = (card && (await hopsToStatus(card, resolvedStatusKey, tx))) ?? [resolvedStatusKey];
    // `decidingGateId`: this gate is still `awaiting` until the door's final write, so
    // without it the guard would refuse the very move Mark done exists to make — and on
    // a hop that leaves review, the pull-back rule withdraws only the OTHER questions.
    for (const key of hops) {
      await applyGateTransition(args, cardId, key, { decidingGateId: gate.id });
    }
    return { statusWritten: resolvedStatusKey };
  },

  /** NOT OFFERED (§4) — the door refuses it first; this is the second line. */
  async requestChanges({ gate }: GateEffectArgs): Promise<GateEffect> {
    throw new ApprovalGateVerbNotOfferedError(gate.id, 'request_changes_on_manual_work');
  },
};
