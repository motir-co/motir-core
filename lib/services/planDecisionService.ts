import type { PlanDto, PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  asPlanStatusRefusal,
  decideThroughDoor,
  planAndGate,
  refuseUngated,
  type DecidePlanInput,
  type DecidePlanOptions,
} from '@/lib/services/planGateDoor';
import { plansService } from '@/lib/services/plansService';
import { PlanWalkIncompleteError } from '@/lib/plans/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';

export type {
  DecidePlanInput,
  DecidePlanOptions,
  PlanDecisionVerb,
} from '@/lib/services/planGateDoor';

// EVERY DECISION OF A PLAN, AT ONE ENTRANCE (Story MOTIR-6012 · Subtask MOTIR-6038; ADR
// `docs/decisions/approval-gates.md` §11.4, §11.5, §11.8).
//
// The plan page, the planning rail (and its close guard's *Confirm & add*), the `/ready`
// expansion nudge, the onboarding approve and the v1 plan-approval route (`motir auto
// --auto-approve-replan`) all decide a plan HERE, and this decides it through the ONE
// decide door (`approvalGatesService.decide`) whenever the plan's question is asked — an
// `awaiting` `plan_approval` gate exists. So there is one record of every plan decision:
// who, under what authority, against which version.
//
// ⚠️ WHAT STAYS A PLAIN WRITE (§11.8 item 5), and it is the ONLY one here: declining a
// plan NOBODY IS BEING ASKED ABOUT — `generating` (a discard: it never finished) or
// `stale` (its question was superseded). There is no gate to lock or record, so it goes
// through `plansService.declineUnaskedPlan`, whose body still refuses under the plan lock
// if a gate was raised meanwhile. The other plain status writers (markPlanned, drift, the
// last-withdrawal discard, the abandoned sweep) never pass through an entrance at all.
//
// ⚠️ A `planned` PLAN WITH NO GATE IS NOT DECIDABLE YET (the pre-backfill state,
// MOTIR-6039). Deciding it around the door would write the one decision the record
// could not show, so every entrance refuses with `PlanNotDecidableYetError`.
//
// ⚠️ THE STAMP IS THE READER'S. A person's press hands back the `stamp` the review read
// returned (`PlanReviewDto.gate.stamp`); the door recomputes it under the lock and
// refuses a stale one. The ONE server-derived stamp is the v1 route's
// ({@link planDecisionService.approveForWorkItem}), whose caller is an unattended loop
// that never rendered the plan — the card says so (MOTIR-6038, "the route derives it
// server-side").

export const planDecisionService = {
  /**
   * APPROVE a plan — through the door, always. Returns the plan as it stands after the
   * commit (the materialized ids on its proposals), the shape every entrance already reads.
   */
  async approve(
    input: DecidePlanInput,
    ctx: ServiceContext,
    opts: DecidePlanOptions = {},
  ): Promise<PlanWithItemsDto> {
    const { plan, gate } = await planAndGate(input.planId, ctx);
    // ⚠️ AN UNFINISHED WALK IS REFUSED BY NAME (Bug MOTIR-11701), before the door: a
    // `stopped` plan always, and an ungated `planned` one whose walk is owed a card (a
    // legacy close — an awaiting gate on one is refused by the claim under the lock).
    if (plan.status === 'stopped' || (!gate && plan.status === 'planned')) {
      const walk = await plansService.readWalkCompleteness(plan, ctx);
      if (plan.status === 'stopped' || !walk.complete) {
        throw new PlanWalkIncompleteError(plan.id, plan.status, walk.unwritten);
      }
    }
    if (!gate) refuseUngated(plan, 'approve');
    await decideThroughDoor(gate, 'approve', input, ctx, opts);
    return plansService.getPlan(plan.id, ctx);
  },

  /**
   * DECLINE a plan — through the door when its question is asked; a PLAIN write when
   * nobody is being asked about it (`generating` / `stale`, §11.8 item 5), which records
   * no gate decision because there is none to record.
   */
  async decline(input: DecidePlanInput, ctx: ServiceContext): Promise<PlanDto> {
    const { plan, gate } = await planAndGate(input.planId, ctx);
    const asked = gate?.state === 'awaiting';
    if (
      !asked &&
      // `stopped` (Bug MOTIR-11701): its walk never finished, so nobody is asked about
      // it either — its Decline is the plain discard a `generating` plan's is.
      (plan.status === 'generating' || plan.status === 'stale' || plan.status === 'stopped')
    ) {
      return plansService.declineUnaskedPlan(plan.id, ctx);
    }
    if (!gate) refuseUngated(plan, 'decline');
    await decideThroughDoor(gate, 'decline', input, ctx, {});
    return plansService.getPlan(plan.id, ctx);
  },

  /**
   * APPROVE THE PLAN A CARD PRODUCED — the bounded entrance `POST
   * /api/v1/work-items/{key}/plan-approval` drives (MOTIR-3021 / MOTIR-3023; moved here
   * from `plansService.approvePlanForWorkItem` by MOTIR-6038). The anchoring walk and
   * its keys are unchanged: `ai:view_plan` to resolve, `ai:decide_plan` to decide.
   *
   * ⚠️ THE STAMP IS DERIVED SERVER-SIDE, and only here. The caller is an operator's loop
   * that read the plan through `GET …/plan-approval` (whose shape stays unchanged) and
   * never rendered a gate, so there is no reader's stamp to hand back. The stamp is the
   * render read's (`approvalGatesService.getForPlan`) — a real digest, so the door still
   * refuses a plan whose proposals moved between that read and its lock, and the record
   * carries the version approved. The decision is recorded `source: 'api'`.
   */
  async approveForWorkItem(
    projectId: string,
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:view_plan');
    const planId = await plansService.resolvePlanIdForWorkItem(projectId, workItemKey, ctx);
    const read = await approvalGatesService.getForPlan({ planId }, ctx);
    try {
      return await planDecisionService.approve({ planId, stamp: read.stamp, source: 'api' }, ctx);
    } catch (err) {
      // ⚠️ THE PUBLIC CONTRACT KEEPS ITS 409 SHAPE (MOTIR-3025). A loop branches on
      // `PLAN_NOT_IN_EXPECTED_STATUS` + `planStatus` — `generating` waits, a decided plan
      // stops — so a plan the door says is already decided or withdrawn is answered as
      // the status it is in, never as a gate code the CLI does not read.
      throw await planDecisionService.asPlanStatusRefusal(err, planId, ctx);
    }
  },

  /**
   * The door's two refusals of a question that is no longer asked, as the PLAN's status
   * refusal — see {@link asPlanStatusRefusal} (`planGateDoor`), which this delegates to.
   */
  async asPlanStatusRefusal(err: unknown, planId: string, ctx: ServiceContext): Promise<unknown> {
    return asPlanStatusRefusal(err, planId, ctx);
  },
};
