import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE DECISION GATES' `afterCommit` (Subtask MOTIR-12175, story MOTIR-10139).
//
// Approving a `decision_approval` gate (page arm and file arm) or confirming a
// `decision_confirmation` gate returns this as its effect's `afterCommit`. The decide
// door awaits it ONCE, after the decision's transaction has committed
// (`approvalGatesService.decide`), so it runs on every path that decides a decision
// gate — the press, REST, MCP and a GitHub-synced review all go through that door.
//
// What it runs is `decisionCorrectionMarkService.markForDecidedGate`, which marks
// nothing unless the decision was CORRECTED at its gate. It never throws: a mark
// that fails is logged with the gate id, and the decision stays approved.
//
// The service is imported LAZILY: it reaches `workItemsService`, whose import graph
// already includes the gate registry these handlers belong to.

/** The `afterCommit` a decision gate's approve effect returns. */
export function decisionCorrectionAfterCommit(
  gateId: string,
  ctx: ServiceContext,
): () => Promise<void> {
  return async () => {
    const { runDecisionCorrectionMark } =
      await import('@/lib/services/decisionCorrectionMarkService');
    await runDecisionCorrectionMark(gateId, ctx);
  };
}
