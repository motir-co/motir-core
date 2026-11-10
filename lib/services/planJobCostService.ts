import { getJobCost, type RawJobCost } from '@/lib/ai/motirAiClient';
import {
  PLAN_JOB_SESSION_KINDS,
  UNKNOWN_PLAN_JOB_COST,
  type PlanJobCostDto,
} from '@/lib/dto/planJobCost';

// THE PLAN READ'S COST BLOCK (MOTIR-10815, task MOTIR-10789): what the plan's
// motir-ai job cost, for `GET /api/v1/plans/{planId}` and `get_plan`. The only
// caller of `getJobCost`. No database read, so no repository.
//
// The per-figure rule is `plannerFindingsService`'s: a finite number is kept, and
// anything else is `null`. The outage half follows `dispatchRunService`'s
// `readHostedRunCost` — a failed read degrades instead of failing the plan — but
// NOT its 404-to-zeros half: here a `not_found` (another project's job, or one
// motir-ai never saw) reads as every figure unknown.

const figure = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function mapJobCost(raw: RawJobCost): PlanJobCostDto {
  const kinds =
    raw.bySessionKind && typeof raw.bySessionKind === 'object'
      ? (raw.bySessionKind as Record<string, unknown>)
      : {};
  const bySessionKind = {} as PlanJobCostDto['bySessionKind'];
  for (const kind of PLAN_JOB_SESSION_KINDS) bySessionKind[kind] = figure(kinds[kind]);
  return {
    ledgerComplete: typeof raw.ledgerComplete === 'boolean' ? raw.ledgerComplete : null,
    totalCostMicroUsd: figure(raw.totalCostMicroUsd),
    credits: figure(raw.credits),
    bySessionKind,
  };
}

function unknownCost(): PlanJobCostDto {
  return { ...UNKNOWN_PLAN_JOB_COST, bySessionKind: { ...UNKNOWN_PLAN_JOB_COST.bySessionKind } };
}

/**
 * The cost block for a plan read: `undefined` for a plan no motir-ai job produced
 * (no call is made, and the read carries no `cost` key), otherwise motir-ai's
 * figures — or the all-null block when the read did not answer. It never throws:
 * a cost that could not be read never fails or hides the plan.
 */
export async function readPlanJobCost(plan: {
  sourceJobId: string | null;
  projectId: string;
}): Promise<PlanJobCostDto | undefined> {
  if (plan.sourceJobId === null) return undefined;
  try {
    return mapJobCost(await getJobCost(plan.sourceJobId, plan.projectId));
  } catch {
    // Not found, unreachable, refused or not configured: every figure unknown.
    return unknownCost();
  }
}
