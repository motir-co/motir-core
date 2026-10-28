import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { deriveAuthoringStates, type PlanAuthoringStateRow } from '@/lib/plans/authoringState';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The AUTHORING-STATE read (MOTIR-9821) — which of a plan's proposals are being
// written right now, which are written, and which no author session has started.
// The rule it serves and the three states are `lib/plans/authoringState.ts`'s; this
// service only gathers the rows that derivation reads.
//
// Read-only and reader-gated exactly as `get_plan` is (`getPlanForReader`): an
// author session reading its own plan is a reader of it. The step and session rows
// are read in ONE bound transaction — both tables JOIN to `plan` for their policy,
// so an unbound read would match nothing and every card would read `not_started`.

export interface PlanAuthoringStateDto {
  planId: string;
  status: string;
  proposals: PlanAuthoringStateRow[];
}

export const planAuthoringStateService = {
  async getAuthoringState(planId: string, ctx: ServiceContext): Promise<PlanAuthoringStateDto> {
    const plan = await plansService.getPlanForReader(planId, ctx);
    const [{ steps, sessions }, findings] = await Promise.all([
      withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
        steps: await planStepRepository.listByPlan(planId, tx),
        sessions: await planNarrationRepository.listSessionsByPlan(planId, tx),
      })),
      planValidityService.projectedPlanSectionFindings(planId, ctx, plan),
    ]);
    return {
      planId,
      status: plan.status,
      proposals: deriveAuthoringStates(
        plan.items,
        steps,
        sessions.map((s) => ({ kind: s.stepKind, targetRef: s.targetRef })),
        findings,
      ),
    };
  },
};
