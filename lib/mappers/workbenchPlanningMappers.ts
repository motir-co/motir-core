import type { GeneratingPlanRow } from '@/lib/repositories/planRepository';
import type { ToResumePlanningSessionDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';
import type { ToResumeForm, ToResumeFormResult } from '@/lib/planChange/toResumeForm';
import type { PlanWalkPhaseDto } from '@/lib/dto/plans';

// The Workbench Planning tab's row mapper (Story MOTIR-7820 · MOTIR-7828) — a
// plan row from `planRepository.listGeneratingRequestedBy` plus the titles of its
// session's targets and its progress snapshot, to the wire DTO. Pure.

/**
 * One row. `targetTitles` is keyed by work-item identifier, within the plan's
 * project; a key absent from it no longer resolves and maps to a null title.
 * `progress` is carried through unmodified.
 */
export function toWorkbenchPlanningRowDto(
  row: GeneratingPlanRow,
  targetTitles: ReadonlyMap<string, string>,
  progress: PlanProgressSnapshot,
): WorkbenchPlanningRowDto {
  return {
    planId: row.id,
    sessionId: row.sessionId,
    title: row.title,
    projectName: row.project.name,
    targets: (row.session?.targetKeys ?? []).map((key) => ({
      key,
      title: targetTitles.get(key) ?? null,
    })),
    author: {
      source: row.authorSource,
      harness: row.authorHarness,
      model: row.authorModel,
      origin: row.origin,
    },
    createdAt: row.createdAt.toISOString(),
    progress,
  };
}

/**
 * One planning session of the reader's, as a To resume entry (MOTIR-7914; forms MOTIR-7939).
 * The naming is {@link toWorkbenchPlanningRowDto}'s — `targets` is composed the same way —
 * and `failure` is carried as stored: the reason stays the stable code (the render
 * translates it), the stop point stays the ref and title the walk reported. An ENDED session
 * carries no failure record (the end cleared it) and names when it ended instead.
 *
 * `plans` is the page's undecided plans by id, so the entry's plan and its waiting plan are
 * named from the one batched read.
 */
export function toToResumePlanningSessionDto(
  row: {
    id: string;
    targetKeys: readonly string[];
    failedAt?: Date | null;
    failureReason?: string | null;
    failureStopPhase?: PlanWalkPhaseDto | null;
    failureStopRef?: string | null;
    failureStopTitle?: string | null;
    failureNotPlannedYet?: readonly string[] | null;
    endedAt?: Date | null;
    latestPlan?: { id: string; title: string | null } | null;
  },
  resolved: ToResumeFormResult | null,
  plans: ReadonlyMap<string, { id: string; title: string | null; status: string }>,
  projectName: string,
  targetTitles: ReadonlyMap<string, string>,
  progress: PlanProgressSnapshot | null,
): ToResumePlanningSessionDto {
  // A failed-open session that holds nothing undecided is still listed as a failed walk on its
  // latest plan, as MOTIR-7914 does: it is never dropped silently, so `total` stays honest.
  const form: ToResumeForm = resolved?.form ?? 'failed_walk';
  const entryPlan = resolved ? (plans.get(resolved.entryPlanId) ?? null) : (row.latestPlan ?? null);
  const waiting = resolved?.waitingPlanId ? (plans.get(resolved.waitingPlanId) ?? null) : null;
  return {
    sessionId: row.id,
    form,
    planId: entryPlan?.id ?? null,
    title: entryPlan?.title ?? null,
    waitingPlan:
      waiting && (waiting.status === 'planned' || waiting.status === 'stale')
        ? { planId: waiting.id, title: waiting.title, status: waiting.status }
        : null,
    projectName,
    targets: row.targetKeys.map((key) => ({ key, title: targetTitles.get(key) ?? null })),
    failure:
      form === 'ended_with_waiting_plan'
        ? null
        : {
            failedAt: (row.failedAt ?? new Date(0)).toISOString(),
            reason: row.failureReason ?? 'internal',
            stopPhase: row.failureStopPhase ?? null,
            stopRef: row.failureStopRef ?? null,
            stopTitle: row.failureStopTitle ?? null,
            notPlannedYet: [...(row.failureNotPlannedYet ?? [])],
          },
    endedAt:
      form === 'ended_with_waiting_plan' ? ((row.endedAt ?? null)?.toISOString() ?? null) : null,
    progress: form === 'failed_walk' ? progress : null,
  };
}
