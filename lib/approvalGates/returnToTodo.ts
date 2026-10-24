import type { GateEffect, GateEffectArgs } from '@/lib/approvalGates/registry';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// A GATE-OWNED RETURN TO TO DO (Story MOTIR-6070 · MOTIR-6423;
// `docs/decisions/design-refusal-verdict.md` §1 and §2).
//
// A refusal that sends the work back writes the card to the project's To do and
// withdraws every OTHER question still waiting on it, inside the decide door's
// transaction. The design refusal is its caller (either verdict). An acceptance
// refusal does NOT use it: no acceptance refusal moves a status
// (`acceptance-refusal-verdict.md` §2 and §8), so its handler withdraws the merge gate
// without a return (MOTIR-6503).
//
// ⚠️ THE TARGET IS RESOLVED BY `isInitial` AND CATEGORY, NEVER THROUGH THE DOOR'S
// `resolvedStatusKey`, which the door resolves from the kind's `statusIntent` — `done`
// for a design. And it is read on `tx`, never through `workflowsService`, whose reads
// open a context of their own: a second pooled connection while the door holds the
// gate `FOR UPDATE` is the deadlock shape `applyStatusTransition` warns about.
//
// ⚠️ THE WRITE IS `{ system: true }`, because no legal edge leads from `in_review` /
// `implemented` / `approved` back to `todo` and none is added (`approval-gates.md`
// §10c) — and that same flag is why the funnel's pull-back rule (`pullsTheWorkBack =
// !opts.system && …`) withdraws nothing here. So the withdrawal is done below, by
// hand, with the pull-back rule's own cause, EXCLUDING the deciding gate, which is
// still `awaiting` until the door's final write.

/** Where a refusal that sends the work back lands: the project's initial status,
 *  and only if it sits in the `todo` category. */
const RETURN_CATEGORY = 'todo';

/**
 * Move the deciding gate's card to the project's initial To-do status and withdraw
 * the card's other `awaiting` gates as `pulled_back`. A project with no initial
 * todo-category status gets nothing written and nothing withdrawn — the refusal is
 * still recorded by the door — and says so with `no_status_in_target_category`.
 */
export async function returnCardToTodo(
  args: Pick<GateEffectArgs, 'gate' | 'item' | 'ctx' | 'tx' | 'appliedTransitions'>,
  where: string,
): Promise<GateEffect> {
  const { gate, item, tx } = args;
  const workItemId = requireGateCard(gate, where);
  const statuses = await workflowsRepository.findStatuses(gate.projectId, gate.workspaceId, tx);
  // A CLOSED CARD IS NEVER SENT BACK, and this asserts it rather than handling it: a
  // card in the `done` category has had its question closed (MOTIR-5552), so a refusal
  // reaching here over one is a defect upstream. Reopening it silently would undo a
  // finished card from a gate nobody should still have been able to press.
  const current = statuses.find((s) => s.key === item?.status);
  if (current?.category === 'done') {
    throw new Error(
      `${where}: gate ${gate.id} would send back work item ${workItemId}, which is ` +
        `${current.key} — a closed card has no open question to refuse (MOTIR-5552)`,
    );
  }
  const target = statuses.find((s) => s.isInitial && s.category === RETURN_CATEGORY);
  if (!target) {
    return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
  }

  // The funnel locks the card's awaiting gates (this one included — a no-op re-lock)
  // and then the card, in the door's lock order; the supersede below touches rows
  // those locks already hold.
  // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES: a person's refusal press. A
  // card marked under the rule is done-category and was refused above; only a LEGACY
  // card marked while open reaches here, and the person is told to clear the mark.
  await applyGateTransition(args, workItemId, target.key, {
    system: true,
    decidingGateId: gate.id,
  });
  await approvalGateRepository.supersedeOtherAwaitingByWorkItem(
    workItemId,
    gate.id,
    // The WORK is going back under the question — exactly what the pull-back rule
    // records for a hand move out of review (AMENDMENT 6 Q5).
    'pulled_back',
    tx,
  );
  return { statusWritten: target.key };
}
