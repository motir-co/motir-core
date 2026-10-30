import type { PlanItemPatch } from '@/lib/dto/plans';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { isMarkOnlyPatch } from '@/lib/plans/markOnlyPatch';
import { patchRescopes } from '@/lib/plans/rescopeReset';
import {
  RESCOPE_OUTCOME_KEYS,
  modifyTargetStatusFor,
  priorStatusOf,
} from '@/lib/plans/rescopeStatus';
import { RESTING_BLOCKED_KEY, RESTING_TODO_KEY } from '@/lib/plans/restingStatus';

// The plan review's STATUS row (bug MOTIR-10102), PURE and its own module for the
// reason `rescopeStatus.ts` is one: it must say exactly what the approve does, and
// a pure function is the shape a unit test pins without a database.

type RescopeTarget = Parameters<typeof patchRescopes>[1];

/** The `status` change row — the shape `PlanItemChangeDto` carries for it. */
export interface PlanStatusChangeRow {
  field: 'status';
  from: string;
  to: string;
}

/** "A or B", "A, B, or C" — the reviewer's list of possible outcomes. */
const OR_LIST = new Intl.ListFormat('en', { style: 'long', type: 'disjunction' });

/**
 * THE STATUS ROW — the one row no patch key produces, because the approve DERIVES
 * it: the target's status once this plan is approved, shown BEFORE the press.
 * Through the SAME `modifyTargetStatusFor` the approve decides with
 * (`plansService.restPlanTargets` / `settleUnparkedModifyTargets`), so the surface
 * cannot promise a move the approve does not make, or make one it never showed.
 *
 * ⚠️ IT NAMES THE OUTCOMES RATHER THAN PREDICTING ONE wherever the approve reads
 * live state. The resting status and the re-scope move are decided AT APPROVE from
 * the card's open blockers — including the edges the plan itself wires — and from
 * whether a run is working it, so a row promising `To Do` could be falsified
 * between this read and the press: the review-shows-what-approve-does drift
 * MOTIR-3868 and MOTIR-3070 were filed about. Naming them all cannot drift.
 *
 * | the target | the row |
 * | --- | --- |
 * | claims built work, and the patch re-scopes it (bug MOTIR-10102) | `To Do, Blocked, or In Progress (re-scoped while <prior>; decided when this plan is approved)` |
 * | claims built work, parked, the patch does not re-scope it | `<prior> (returned when this plan is approved)` |
 * | parked by a SESSION from a status it will restore | `<prior> (returned when this plan is approved)` |
 * | parked by this PLAN, or parked by hand | `To Do or Blocked (returned when this plan is approved)` (MOTIR-5646) |
 * | anything else | no row: the status does not move |
 */
export function planStatusChangeOf(
  patch: PlanItemPatch,
  target: RescopeTarget & { status: string },
  statusByKey: ReadonlyMap<string, Pick<WorkflowStatusDto, 'key' | 'label' | 'category'>>,
  context: {
    park?: { priorStatus: string; statusHeld: boolean; planId: string | null } | undefined;
    gainsChildren: boolean;
  },
): PlanStatusChangeRow | null {
  const from = statusByKey.get(target.status);
  if (!from) return null;
  const priorStatus = priorStatusOf(target.status, context.park);
  const prior = statusByKey.get(priorStatus);
  const markOnly = isMarkOnlyPatch(patch);
  const decision = modifyTargetStatusFor({
    priorStatus,
    priorCategory: prior?.category ?? null,
    rescopes: !markOnly && patchRescopes(patch, target),
    markOnly,
    gainsChildren: context.gainsChildren,
    // The outcome is named, not predicted, so neither live read is made here.
    hasOpenBlocker: false,
    hasLiveRun: false,
  });
  const labelsOf = (keys: readonly string[]) =>
    keys.map((k) => statusByKey.get(k)?.label).filter((l): l is string => Boolean(l));
  const oneOf = (labels: string[]) => OR_LIST.format(labels);

  // A re-scope implies the prior status is the workflow's own: its category was read off it.
  if (decision.kind === 'rescope') {
    const outcomes = labelsOf(RESCOPE_OUTCOME_KEYS);
    if (outcomes.length === 0) return null;
    return {
      field: 'status',
      from: from.label,
      to: `${oneOf(outcomes)} (re-scoped while ${prior!.label}; decided when this plan is approved)`,
    };
  }
  if (target.status !== PLANNING_STATUS_KEY) return null;
  // A SESSION's park that moved the card gives back the status it took it from;
  // so does the re-scope move's `keep`.
  const restores =
    decision.kind === 'keep' || (context.park?.statusHeld === true && context.park.planId === null);
  if (restores && prior && priorStatus !== PLANNING_STATUS_KEY) {
    return {
      field: 'status',
      from: from.label,
      to: `${prior.label} (returned when this plan is approved)`,
    };
  }
  const resting = labelsOf([RESTING_TODO_KEY, RESTING_BLOCKED_KEY]);
  if (resting.length === 0) return null;
  return {
    field: 'status',
    from: from.label,
    to: `${oneOf(resting)} (returned when this plan is approved)`,
  };
}
