import type { AppliedGateTransition, GateEffectArgs } from '@/lib/approvalGates/registry';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// A STATUS HOP A GATE DECISION APPLIES, AND THE EVENT IT OWES (Bug MOTIR-9415).
//
// A handler writes its status through `applyStatusTransition` inside the decide door's
// transaction, and that method leaves `work-item/transitioned` to its caller: the emit
// can never live inside the transaction, because a rollback must not have notified
// anyone. Every other mover sends it after its own commit (`updateStatus`, the board
// move, the rollup). The gate path sent nothing, so every consumer of the event — the
// parent rollup and downward cascade, the bell, automation rules, monitor-issue
// linking — missed every gate-decided move: a story whose last manual child was marked
// done stayed In Progress with every child built.
//
// So a handler never calls `applyStatusTransition` directly. It calls
// {@link applyGateTransition}, which applies the hop and RECORDS it on the door's list,
// and the door emits the recorded hops once its transaction has committed
// ({@link emitAppliedGateTransitions}). The door owns the list, so a handler cannot
// emit early and a decision that rolls back announces nothing.

type ApplyStatusTransitionOptions = NonNullable<
  Parameters<typeof workItemsService.applyStatusTransition>[4]
>;

/**
 * Apply ONE status hop for a gate decision, in the door's transaction, and record the
 * transition it applied on `args.appliedTransitions`. A no-op move applies no transition
 * and records nothing.
 */
export async function applyGateTransition(
  args: Pick<GateEffectArgs, 'ctx' | 'tx' | 'appliedTransitions'>,
  workItemId: string,
  toStatusKey: string,
  opts: ApplyStatusTransitionOptions,
): Promise<void> {
  // LAZY: the status funnel reaches back into the gate registry this module serves, and
  // a static import closes that cycle at module load (the handlers' own lazy imports).
  const { workItemsService } = await import('@/lib/services/workItemsService');
  const { transition } = await workItemsService.applyStatusTransition(
    workItemId,
    toStatusKey,
    args.ctx,
    args.tx,
    opts,
  );
  if (transition) args.appliedTransitions?.push({ workItemId, ...transition });
}

/**
 * Emit `work-item/transitioned` for every hop a decision applied — AFTER the decision's
 * transaction has committed, never inside it. The payload is `updateStatus`'s.
 */
export async function emitAppliedGateTransitions(
  transitions: readonly AppliedGateTransition[],
  ctx: ServiceContext,
): Promise<void> {
  for (const transition of transitions) {
    await sendEvent('work-item/transitioned', {
      workspaceId: ctx.workspaceId,
      workItemId: transition.workItemId,
      actorId: ctx.userId,
      fromStatusKey: transition.fromStatusKey,
      toStatusKey: transition.toStatusKey,
      revisionId: transition.revisionId,
    });
  }
}
