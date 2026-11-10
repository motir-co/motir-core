import type { ApprovalGate, Plan } from '@/generated/prisma/client';
import type { ApprovalGateDecisionSourceDTO } from '@/lib/dto/approvalGate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { DecisionStamp } from '@/lib/approvalGates/stamp';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import {
  PlanApprovingError,
  PlanDecisionStampRequiredError,
  PlanNotDecidableYetError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A PLAN'S QUESTION, DECIDED THROUGH THE DOOR (Story MOTIR-6012 · MOTIR-6038; ADR
// `docs/decisions/approval-gates.md` §11.4, §11.8) — the steps `planDecisionService`
// composes and `plansService.approvePlan` / `declinePlan` reuse for a plan that is asked
// but was rendered to nobody.
//
// ⚠️ WHY IT IS ITS OWN MODULE: it imports NEITHER `plansService` NOR
// `planDecisionService`. `planDecisionService` imports `plansService` (to read the plan
// back and for the plain §11.8 decline), so `plansService` reaching back into it closed a
// cycle that could only be broken with a lazy `await import(...)` — and a lazy import is
// not loadable by the Playwright seed runtime (the E2E seeds call `plansService`
// directly). Both services import THIS instead; the cycle is gone rather than deferred.

const KIND = 'plan_approval' as const;

/**
 * A stamp that matches no digest. Handed to the door ONLY for a gate that is no longer
 * `awaiting`, which the door refuses on its STATE before it ever compares a stamp — so a
 * surface that rendered no stamp still hears *already decided* / *withdrawn* in the door's
 * own words. Were the gate somehow awaiting, this would be refused stale, never accepted.
 */
const NO_STAMP_RENDERED = 'plan-gate:no-stamp-rendered';

export type PlanDecisionVerb = 'approve' | 'decline';

export interface DecidePlanInput {
  planId: string;
  /** What the reader was shown (`PlanReviewDto.gate.stamp`); null when they were shown
   *  no question (a `generating` plan's discard, a plan with no gate). */
  stamp: DecisionStamp | null;
  /** Through which surface the decision arrived (ADR §6a) — required, no default. */
  source: Exclude<ApprovalGateDecisionSourceDTO, 'system'>;
  /** Optional on both verbs (§11.4 — a decline's reason is optional by design). */
  noteMd?: string | null;
}

export interface DecidePlanOptions {
  /**
   * The onboarding draft's placeholder project name (MOTIR-1486 / MOTIR-1551), resolved
   * by the route because i18n stays out of the service layer. The approve renames the
   * draft from the plan's `productName` only while the name is still this placeholder —
   * carried through the door as the effect's own option, never dropped.
   */
  provisionalProjectName?: string | null;
}

/** The plan and its latest `plan_approval` gate (the awaiting one when there is one). */
export async function planAndGate(
  planId: string,
  ctx: ServiceContext,
): Promise<{ plan: Plan; gate: ApprovalGate | null }> {
  const found = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const plan = await planRepository.findById(planId, ctx.workspaceId, tx);
    if (!plan) return null;
    return {
      plan,
      gate: await approvalGateRepository.findLatestCardlessBySubject(KIND, plan.id, tx),
    };
  });
  if (!found) throw new PlanNotFoundError(planId);
  // The decide key, BEFORE any refusal names the plan's state — exactly where
  // `approvePlan` / `declinePlan` always asserted it (a non-browser reads 404).
  await projectAccessService.assertPermission(found.plan.projectId, ctx, 'ai:decide_plan');
  return found;
}

/**
 * Decide a plan whose question is (or was) asked, through the door. Throws the door's
 * typed refusals unchanged — the same ones every other gate surface hears.
 */
export async function decideThroughDoor(
  gate: ApprovalGate,
  decision: PlanDecisionVerb,
  input: DecidePlanInput,
  ctx: ServiceContext,
  opts: DecidePlanOptions,
): Promise<void> {
  if (gate.state === 'awaiting' && input.stamp === null) {
    throw new PlanDecisionStampRequiredError(input.planId);
  }
  await approvalGatesService.decide(
    {
      gateId: gate.id,
      decision,
      noteMd: input.noteMd ?? null,
      source: input.source,
      stamp: input.stamp ?? NO_STAMP_RENDERED,
    },
    ctx,
    opts.provisionalProjectName
      ? { effectOptions: { provisionalProjectName: opts.provisionalProjectName } }
      : {},
  );
}

/** A plan with no gate at all: `planned` is not decidable yet; anything else is not in
 *  a status the verb acts on (`generating` for approve — the v1 loop's *not yet*). */
export function refuseUngated(plan: Plan, decision: PlanDecisionVerb): never {
  if (plan.status === 'planned') throw new PlanNotDecidableYetError(plan.id);
  throw new PlanNotInExpectedStatusError(
    plan.id,
    plan.status,
    decision === 'approve' ? 'planned' : 'planned, stale or generating',
  );
}

/**
 * The door's two refusals of a question that is no longer asked — already decided,
 * withdrawn — as the PLAN's status refusal, for the two callers whose contract is the
 * plan's status rather than the gate's: the v1 route (a loop reads `planStatus`) and
 * `plansService.approvePlan` / `declinePlan`'s documented one-shot guard. Any other
 * error is returned unchanged.
 */
export async function asPlanStatusRefusal(
  err: unknown,
  planId: string,
  ctx: ServiceContext,
): Promise<unknown> {
  // ANOTHER PRESS IS APPROVING IT (Bug MOTIR-9006): for these callers that is the plan's
  // status too — `approving`, which a loop reads as *not decidable by me* exactly as it
  // reads a decided one. No re-read: the refusal already says what the status is.
  if (err instanceof PlanApprovingError) {
    return new PlanNotInExpectedStatusError(planId, 'approving', 'planned');
  }
  if (
    !(err instanceof ApprovalGateAlreadyDecidedError) &&
    !(err instanceof ApprovalGateSupersededError)
  ) {
    return err;
  }
  const now = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  return new PlanNotInExpectedStatusError(planId, now?.status ?? 'unknown', 'planned');
}
