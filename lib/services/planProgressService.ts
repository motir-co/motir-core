// Plan PROGRESS — the server half of the one progress derivation (Story
// MOTIR-7820 · Subtask MOTIR-7825). It gathers the rows the pure snapshot
// builder (`lib/plans/planProgress.ts`) needs and hands them over; it decides
// nothing itself — the phrase, the authored test, the drop rules and the clock
// all live in that module, so the plan surface and the Workbench tab cannot
// disagree.
//
// Two doors, one builder:
//   - `snapshotsForPlans` — a PAGE of plans (the reader's plans-being-written
//     read). SIX batched reads, never one per plan.
//   - `snapshotForReview` — the plan review read (`GET /api/plans/[id]`, polled
//     every 2.5 s while generating), built from the rows that read already holds;
//     it adds at most a titles read for committed step targets it does not name,
//     the session's automatic-resume record for a plan that has a session
//     (MOTIR-8309), and — while a step is reported — the proposals' last writes
//     and each session's newest narration the quiet drop measures from
//     (MOTIR-11184). "N authored" reads the stored `authorFinished` alone
//     (MOTIR-10496), so neither door reads the project's explanations setting.

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanItemDto, PlanStepDto } from '@/lib/dto/plans';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { toPlanStepDto } from '@/lib/mappers/planMappers';
import { isTempRef } from '@/lib/plans/refs';
import {
  buildPlanProgressSnapshot,
  progressRowOfAdd,
  type PlanProgressAddRow,
  type PlanProgressNarrationRow,
  type PlanProgressSnapshot,
  type PlanProgressWriteRow,
} from '@/lib/plans/planProgress';

/** What the progress read needs to know about a plan — any plan DTO or row
 *  carrying these fields will do. */
export interface PlanProgressPlanInput {
  id: string;
  status: string;
  createdAt: string | Date;
  lastActivityAt: string | Date;
  /** The plan's planning session, whose automatic resumes decide `resuming`. */
  sessionId: string | null;
}

type AutoResumeRow = { id: string; autoResumeCount: number; lastAutoResumedAt: Date | null };

function autoResumeOf(row: AutoResumeRow | undefined): { at: Date; count: number } | null {
  return row?.lastAutoResumedAt ? { at: row.lastAutoResumedAt, count: row.autoResumeCount } : null;
}

/** The committed (non-`planItem:`) targets the steps name. */
function committedTargetIds(steps: readonly { targetRef: string | null }[]): string[] {
  return Array.from(
    new Set(
      steps.map((s) => s.targetRef).filter((ref): ref is string => ref !== null && !isTempRef(ref)),
    ),
  );
}

/**
 * Whether a step can be kept alive by a write (`stepLastActivity`'s table): a
 * lay or amend step, or an author step with a target. Settle, the untargeted
 * author, the final check and the fix are kept alive by their narration alone, so
 * a snapshot of only those reads no writes.
 */
function stepCanWrite(step: { kind: string; targetRef: string | null }): boolean {
  return (
    step.kind === 'lay' ||
    step.kind === 'amend' ||
    (step.kind === 'author' && step.targetRef !== null)
  );
}

/** Group rows carrying a `planId` by it, dropping the key. */
function byPlan<T extends { planId: string }>(
  rows: readonly T[],
): Map<string, Omit<T, 'planId'>[]> {
  const out = new Map<string, Omit<T, 'planId'>[]>();
  for (const { planId, ...row } of rows) {
    const list = out.get(planId) ?? [];
    list.push(row);
    out.set(planId, list);
  }
  return out;
}

export const planProgressService = {
  /**
   * One snapshot per `generating` plan in `plans` (none for any other status),
   * keyed by plan id. Six batched reads in one bound transaction — the steps,
   * the `add` flags, the committed step targets' titles and the sessions'
   * automatic resumes, plus every proposal's last write and each session's newest
   * narration (MOTIR-11184) — so the cost is the same for 1 plan and for 10.
   */
  async snapshotsForPlans(
    plans: readonly PlanProgressPlanInput[],
    ctx: ServiceContext,
  ): Promise<Map<string, PlanProgressSnapshot>> {
    const generating = plans.filter((p) => p.status === 'generating');
    const out = new Map<string, PlanProgressSnapshot>();
    if (generating.length === 0) return out;
    const planIds = generating.map((p) => p.id);
    const sessionIds = Array.from(
      new Set(generating.map((p) => p.sessionId).filter((id): id is string => id !== null)),
    );

    const { steps, rows, writes, narrations, titles, resumes } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => {
        // Bound: `plan_step`'s policy joins to `plan`, so an unbound read is an
        // empty set that would read as "nobody is working on it".
        const steps = await planStepRepository.listByPlanIds(planIds, tx);
        const rows = await planItemRepository.findProgressRowsByPlanIds(planIds, tx);
        const writes = await planItemRepository.findWriteRowsByPlanIds(planIds, tx);
        const narrations = await planNarrationRepository.findLatestBySessionForPlans(planIds, tx);
        const titles = await workItemRepository.findTitlesByIds(
          committedTargetIds(steps),
          ctx.workspaceId,
          tx,
        );
        const resumes = await planChangeSessionRepository.findAutoResumesByIds(sessionIds, tx);
        return {
          steps,
          rows,
          writes,
          narrations,
          titles,
          resumes: new Map(resumes.map((r) => [r.id, r])),
        };
      },
    );
    // The server instant the snapshots were built at — `serverNow`'s anchor.
    const observedAt = new Date();
    const committedTitles = new Map(titles.map((t) => [t.id, t.title]));

    const stepsByPlan = new Map<string, PlanStepDto[]>();
    for (const step of steps) {
      const list = stepsByPlan.get(step.planId) ?? [];
      list.push(toPlanStepDto(step));
      stepsByPlan.set(step.planId, list);
    }
    const rowsByPlan = new Map<string, PlanProgressAddRow[]>();
    for (const { planId, ...row } of rows) {
      const list = rowsByPlan.get(planId) ?? [];
      list.push(row);
      rowsByPlan.set(planId, list);
    }

    const writesByPlan: Map<string, PlanProgressWriteRow[]> = byPlan(writes);
    const narrationsByPlan: Map<string, PlanProgressNarrationRow[]> = byPlan(narrations);

    for (const plan of generating) {
      out.set(
        plan.id,
        buildPlanProgressSnapshot({
          plan,
          steps: stepsByPlan.get(plan.id) ?? [],
          addRows: rowsByPlan.get(plan.id) ?? [],
          committedTitles,
          observedAt,
          autoResume: plan.sessionId ? autoResumeOf(resumes.get(plan.sessionId)) : null,
          writes: writesByPlan.get(plan.id) ?? [],
          narrations: narrationsByPlan.get(plan.id) ?? [],
        }),
      );
    }
    return out;
  },

  /**
   * The review read's snapshot, built from the plan items and steps it already
   * loaded. `null` unless the plan is `generating`. `knownTitles` are committed
   * work-item titles the review read already holds (its target/ancestor rows);
   * only a committed step target missing from them is read.
   */
  async snapshotForReview(
    plan: PlanProgressPlanInput,
    items: readonly PlanItemDto[],
    steps: readonly PlanStepDto[],
    ctx: ServiceContext,
    knownTitles: ReadonlyMap<string, string> = new Map(),
  ): Promise<PlanProgressSnapshot | null> {
    if (plan.status !== 'generating') return null;
    const missing = committedTargetIds(steps).filter((id) => !knownTitles.has(id));
    const sessionId = plan.sessionId;
    const readWrites = steps.some(stepCanWrite);
    const readNarrations = steps.length > 0;
    const { extraTitles, autoResume, writes, narrations } =
      missing.length === 0 && sessionId === null && !readWrites && !readNarrations
        ? { extraTitles: [], autoResume: null, writes: [], narrations: [] }
        : await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
            const extraTitles = await workItemRepository.findTitlesByIds(
              missing,
              ctx.workspaceId,
              tx,
            );
            const resumes = sessionId
              ? await planChangeSessionRepository.findAutoResumesByIds([sessionId], tx)
              : [];
            const writes = readWrites
              ? await planItemRepository.findWriteRowsByPlanIds([plan.id], tx)
              : [];
            const narrations = readNarrations
              ? await planNarrationRepository.findLatestBySessionForPlans([plan.id], tx)
              : [];
            return { extraTitles, autoResume: autoResumeOf(resumes[0]), writes, narrations };
          });
    const committedTitles = new Map(knownTitles);
    for (const t of extraTitles) committedTitles.set(t.id, t.title);
    return buildPlanProgressSnapshot({
      plan,
      steps,
      addRows: items
        .filter((i) => i.op === 'add')
        .map((i) =>
          progressRowOfAdd({
            id: i.id,
            workItemId: i.workItemId,
            parentRef: i.parentRef,
            proposedFields: i.proposedFields as Record<string, unknown> | null,
          }),
        ),
      committedTitles,
      observedAt: new Date(),
      autoResume,
      writes,
      narrations,
    });
  },
};
