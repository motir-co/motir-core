import type { AppliedGateTransition, GateEffectArgs } from '@/lib/approvalGates/registry';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { ApprovalGateTransitionRefusedError } from '@/lib/approvalGates/errors';
import { IllegalTransitionError } from '@/lib/workItems/errors';
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
  let applied: Awaited<ReturnType<typeof workItemsService.applyStatusTransition>>;
  try {
    applied = await workItemsService.applyStatusTransition(
      workItemId,
      toStatusKey,
      args.ctx,
      args.tx,
      opts,
    );
  } catch (err) {
    if (err instanceof IllegalTransitionError) throw await transitionRefused(args, workItemId, err);
    throw err;
  }
  if (applied.transition) args.appliedTransitions?.push({ workItemId, ...applied.transition });
}

/**
 * A HOP THE WORKFLOW REFUSES IS A NAMED REFUSAL (Bug MOTIR-11835). The status funnel's own
 * `IllegalTransitionError` is a work-item error the decide door has no arm for, so it
 * reached the frame as `UNEXPECTED` — *check your connection* — on a request that had
 * arrived and been refused. Translated here, the one place every handler's hop passes,
 * so no handler can let it through. The door's transaction rolls back on the throw, so
 * nothing is decided; the card's status category says whether it is already closed.
 */
async function transitionRefused(
  args: Pick<GateEffectArgs, 'ctx' | 'tx'>,
  workItemId: string,
  err: IllegalTransitionError,
): Promise<ApprovalGateTransitionRefusedError> {
  // LAZY for the same reason as the funnel above.
  const { workflowsService } = await import('@/lib/services/workflowsService');
  const { workItemRepository } = await import('@/lib/repositories/workItemRepository');
  // The funnel read this row under its lock before it judged the move, so it exists here.
  const item = (await workItemRepository.findById(workItemId, args.tx))!;
  const terminal = (
    await workflowsService.getTerminalStatusKeysByProjects(
      [item.projectId],
      args.ctx.workspaceId,
      args.tx,
    )
  ).get(item.projectId)!;
  return new ApprovalGateTransitionRefusedError(
    workItemId,
    err.fromKey,
    err.toKey,
    terminal.has(err.fromKey),
  );
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
