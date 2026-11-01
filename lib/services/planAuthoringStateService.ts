import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  committedWalkSet,
  deriveAuthoringStates,
  deriveCommittedStates,
  type CommittedAuthoringStateRow,
  type CommittedCard,
  type PlanAuthoringStateRow,
} from '@/lib/plans/authoringState';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The AUTHORING-STATE read (MOTIR-9821) — which of a plan's proposals are being
// written right now, which are written, and which no author session has started.
// The rule it serves and the three states are `lib/plans/authoringState.ts`'s; this
// service only gathers the rows that derivation reads.
//
// COMMITTED CARDS (MOTIR-10001) ride beside the proposals: every card the walk
// re-authors, and every card the caller names in `workItems`, answered by id. The
// walk's list is read from three places — the plan's `modify`s, the author steps,
// and `plannerRecord.walkListed`, where a driver records the committed cards its
// lay listed before their sessions open (the step rows only know a card once its
// session has started). A named card in another project, or one that does not
// exist, is answered in `unresolved` rather than refused: the rest of the read
// still holds.
//
// Read-only and reader-gated exactly as `get_plan` is (`getPlanForReader`): an
// author session reading its own plan is a reader of it. The step and session rows
// are read in ONE bound transaction — both tables JOIN to `plan` for their policy,
// so an unbound read would match nothing and every card would read `not_started`.

export interface PlanAuthoringStateDto {
  planId: string;
  status: string;
  proposals: PlanAuthoringStateRow[];
  committed: CommittedAuthoringStateRow[];
  /** The `workItems` entries that name no work item of this plan's project. */
  unresolved: string[];
}

/** The plan record's `walkListed` ids — anything else in the record is not this read's. */
function walkListedOf(record: Record<string, unknown> | null): string[] {
  const listed = record?.walkListed;
  return Array.isArray(listed)
    ? listed.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export const planAuthoringStateService = {
  async getAuthoringState(
    planId: string,
    ctx: ServiceContext,
    workItems: readonly string[] = [],
  ): Promise<PlanAuthoringStateDto> {
    const plan = await plansService.getPlanForReader(planId, ctx);
    const [{ steps, sessions }, findings, record] = await Promise.all([
      withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
        steps: await planStepRepository.listByPlan(planId, tx),
        sessions: await planNarrationRepository.listSessionsByPlan(planId, tx),
      })),
      planValidityService.projectedPlanSectionFindings(planId, ctx, plan),
      plansService.getPlannerRecord(planId, ctx),
    ]);
    const sessionFacts = sessions.map((s) => ({ kind: s.stepKind, targetRef: s.targetRef }));
    const listed = walkListedOf(record);

    // Resolve every committed card the answer names: the walk's set first, then the asked ones.
    const asked = [...new Set(workItems.map((w) => w.trim()).filter((w) => w.length > 0))];
    const { inWalk } = committedWalkSet(plan.items, listed, sessionFacts);
    const askedKeys = asked.filter((w) => IDENTIFIER.test(w));
    const askedIds = asked.filter((w) => !IDENTIFIER.test(w));
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => [
      ...(await workItemRepository.findByIdsInWorkspace(
        [...new Set([...inWalk, ...askedIds])],
        ctx.workspaceId,
        tx,
      )),
      ...(await workItemRepository.findByIdentifiers(
        plan.projectId,
        askedKeys.map((k) => k.toUpperCase()),
        tx,
      )),
    ]);
    const byId = new Map<string, CommittedCard>();
    const idOf = new Map<string, string>();
    for (const r of rows) {
      if (r.projectId !== plan.projectId) continue;
      byId.set(r.id, { id: r.id, key: r.identifier, title: r.title });
      idOf.set(r.id, r.id);
      idOf.set(r.identifier.toUpperCase(), r.id);
    }
    const cards: CommittedCard[] = [];
    for (const id of inWalk) {
      const card = byId.get(id);
      if (card) cards.push(card);
    }
    const unresolved: string[] = [];
    for (const w of asked) {
      const id = idOf.get(IDENTIFIER.test(w) ? w.toUpperCase() : w);
      if (id === undefined) unresolved.push(w);
      else cards.push(byId.get(id)!);
    }

    return {
      planId,
      status: plan.status,
      proposals: deriveAuthoringStates(plan.items, steps, sessionFacts, findings),
      committed: deriveCommittedStates(plan.items, steps, sessionFacts, listed, cards),
      unresolved,
    };
  },
};
