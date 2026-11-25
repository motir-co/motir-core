import type { Prisma } from '@/generated/prisma/client';
import type { PlanWalkEndedByDto } from '@/lib/dto/plans';
import { toPlanItemDto } from '@/lib/mappers/planMappers';
import { committedWalkSet, type CommittedCard } from '@/lib/plans/authoringState';
import {
  judgeWalkCompleteness,
  walkListedOf,
  type WalkCompleteness,
} from '@/lib/plans/walkCompleteness';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// THE WALK-COMPLETENESS READ (Bug MOTIR-11701), inside the caller's transaction.
//
// The verdict is `lib/plans/walkCompleteness.ts`'s; this gathers the rows it reads —
// the plan's items, its live steps, every narration session it opened, the committed
// cards its lay listed, and those cards' keys and titles — in ONE bound transaction.
// Every caller already holds the plan's row lock (the close, the gate's raise, the
// approve's claim, a revision's give-back), so the answer is the plan as it stands
// under that lock: nothing can be written between the verdict and the write it
// decides. Both step tables JOIN to `plan` for their policy, which is why the read
// needs the caller's bound `tx` and is never made unbound.

/** The plan row fields the read needs. */
export interface WalkedPlanRow {
  id: string;
  workspaceId: string;
  projectId: string;
  plannerRecord: unknown;
  /** The plan's stored deliberate end (MOTIR-12207) — read by the verdict. */
  walkEndedBy?: PlanWalkEndedByDto | null;
}

export const planWalkCompletenessService = {
  /** The verdict for `plan`, read inside `tx` (which must be workspace-bound). */
  async readWithin(plan: WalkedPlanRow, tx: Prisma.TransactionClient): Promise<WalkCompleteness> {
    const [rows, steps, sessions] = await Promise.all([
      planItemRepository.findByPlan(plan.id, tx),
      planStepRepository.listByPlan(plan.id, tx),
      planNarrationRepository.listSessionsByPlan(plan.id, tx),
    ]);
    const items = rows.map(toPlanItemDto);
    const liveSteps = steps.map((s) => ({ kind: s.kind, targetRef: s.targetRef }));
    const sessionFacts = sessions.map((s) => ({ kind: s.stepKind, targetRef: s.targetRef }));
    const listed = walkListedOf(plan.plannerRecord);
    const { inWalk } = committedWalkSet(items, listed, sessionFacts);
    const found = await workItemRepository.findByIdsInWorkspace([...inWalk], plan.workspaceId, tx);
    // A listed id in another project is not a card of this plan's walk — the authoring
    // state drops it the same way, so the two answers agree.
    const committed: CommittedCard[] = found
      .filter((w) => w.projectId === plan.projectId)
      .map((w) => ({ id: w.id, key: w.identifier, title: w.title }));
    return judgeWalkCompleteness({
      items,
      liveSteps,
      sessions: sessionFacts,
      listed,
      committed,
      walkEndedBy: plan.walkEndedBy ?? null,
    });
  },

  /** {@link readWithin} for a caller holding only the plan's id — it reads the row too.
   *  A plan that no longer resolves has no walk, so it reads complete. */
  async readByIdWithin(
    planId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WalkCompleteness> {
    const plan = await planRepository.findById(planId, workspaceId, tx);
    if (!plan) return { walked: false, complete: true, unwritten: [], leftLaid: [] };
    return planWalkCompletenessService.readWithin(plan, tx);
  },
};
