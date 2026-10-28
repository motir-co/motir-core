// Prisma → DTO converters for the Plan substrate (Story 7.21 · MOTIR-1336).
// Services call these just before returning, so no Prisma row (Date objects,
// the enum types, the raw Json columns) ever crosses the API boundary.

import type {
  Plan,
  PlanItem,
  PlanNarration,
  PlanNarrationSession,
  PlanStep,
} from '@/generated/prisma/client';
import type { PlanHistoryItemRow } from '@/lib/repositories/planItemRepository';
import type {
  PlanDto,
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanNarrationDto,
  PlanNarrationSessionDto,
  PlanStepDto,
  PlanWithItemsDto,
  SharpenedRequirementDto,
  WorkItemPlanHistoryEntryDto,
} from '@/lib/dto/plans';
import { redactNativeActor, redactNativeProvenance } from '@/lib/plans/redactNativeModel';
import { readEdgeReasons } from '@/lib/plans/edgeReasons';

/**
 * The stored proposed fields as a tenant may read them: a native `add`'s
 * `planningProvenance.model` is nulled (MOTIR-7225). The ROW keeps it, and
 * `materialize` reads the row, so the work item still records it internally.
 */
function readableProposedFields(row: PlanItem): PlanItemProposedFields | null {
  const fields = (row.proposedFields as PlanItemProposedFields | null) ?? null;
  if (!fields?.planningProvenance) return fields;
  return { ...fields, planningProvenance: redactNativeProvenance(fields.planningProvenance) };
}

export function toPlanItemDto(row: PlanItem): PlanItemDto {
  return {
    id: row.id,
    op: row.op,
    workItemId: row.workItemId,
    // The Json columns are written through the typed service inputs, so the
    // cast restores the shape the writer stored (null when the column is null).
    proposedFields: readableProposedFields(row),
    patch: (row.patch as PlanItemPatch | null) ?? null,
    parentRef: row.parentRef,
    blockedByRefs: row.blockedByRefs,
    // A row read through a narrow select may lack the column (MOTIR-9827).
    edgeReasons: readEdgeReasons(row.edgeReasons),
    // A row read through a narrow select may lack the column (MOTIR-6630).
    supersedesRefs: row.supersedesRefs ?? [],
    baseRevision: row.baseRevision,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A plan list-row DTO. `itemCount` is supplied by the caller (a COUNT or the
 *  length of an already-loaded items array). */
export function toPlanDto(row: Plan, itemCount: number): PlanDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    title: row.title,
    summary: row.summary,
    sourceJobId: row.sourceJobId,
    sessionId: row.sessionId,
    origin: row.origin,
    // WHO ASKED for it (MOTIR-2986) — null on a cadence plan, deliberately: the
    // watcher's context carries the project owner only so the job has a
    // credential, and nobody asked.
    createdById: row.createdById,
    // WHO authored the plan (MOTIR-2986) — read back on every path that returns
    // a plan: `getPlan`, the plans LIST page, and the `get_plan` MCP tool. Null
    // on every plan no `create_plan` call produced, which is the *unattributed*
    // state the Plans surface draws.
    authorSource: row.authorSource,
    authorHarness: row.authorHarness,
    // Null for a NATIVE author (MOTIR-7225): Motir never names its own model.
    authorModel: redactNativeActor(row.authorSource, row.authorModel),
    itemCount,
    createdAt: row.createdAt.toISOString(),
    plannedAt: row.plannedAt ? row.plannedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedById: row.decidedById,
    // WHY it ended (MOTIR-3189). Carried on every read that returns a plan, so
    // the review surface can tell a DISCARDED plan from one somebody reviewed
    // and rejected without re-deriving it from which timestamps are null.
    decisionReason: row.decisionReason,
    // What a Sharpen session settled (Task MOTIR-1101 · MOTIR-8183). The column
    // is written only by `planSharpeningService` in the DTO's own shape, so it is
    // read back as that shape; null on every plan nobody sharpened.
    sharpenedRequirement: (row.sharpenedRequirement as SharpenedRequirementDto | null) ?? null,
  };
}

/** One stored planner step as it crosses the boundary (MOTIR-7822). */
export function toPlanStepDto(row: PlanStep): PlanStepDto {
  return {
    sessionKey: row.sessionKey,
    kind: row.kind,
    targetRef: row.targetRef,
    startedAt: row.startedAt.toISOString(),
    providerWait:
      row.providerWaitSince !== null &&
      row.providerWaitUntil !== null &&
      row.providerWaitAttempt !== null &&
      row.providerWaitMaxAttempts !== null
        ? {
            attempt: row.providerWaitAttempt,
            maxAttempts: row.providerWaitMaxAttempts,
            since: row.providerWaitSince.toISOString(),
            retryAt: row.providerWaitUntil.toISOString(),
          }
        : null,
  };
}

/** One stored narration sentence as it crosses the boundary (MOTIR-8062). */
export function toPlanNarrationDto(row: PlanNarration): PlanNarrationDto {
  return {
    id: row.id,
    sessionKey: row.sessionKey,
    seq: row.seq,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One session's stored step words as they cross the boundary (MOTIR-8062). */
export function toPlanNarrationSessionDto(row: PlanNarrationSession): PlanNarrationSessionDto {
  return {
    sessionKey: row.sessionKey,
    stepKind: row.stepKind,
    targetRef: row.targetRef,
    targetTitle: row.targetTitle,
    firstReportedAt: row.firstReportedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPlanWithItemsDto(row: Plan, items: PlanItem[]): PlanWithItemsDto {
  return {
    ...toPlanDto(row, items.length),
    items: items.map(toPlanItemDto),
  };
}

/**
 * A plan-history entry for the plan a history row belongs to, with an EMPTY
 * relation — `plansService.listPlanHistoryForWorkItem` folds the plan's rows
 * into `relation` / `proposalIds` (Story MOTIR-5542 · MOTIR-5546).
 */
export function toWorkItemPlanHistoryEntryDto(
  plan: PlanHistoryItemRow['plan'],
): WorkItemPlanHistoryEntryDto {
  return {
    planId: plan.id,
    planTitle: plan.title,
    planStatus: plan.status,
    createdAt: plan.createdAt.toISOString(),
    plannedAt: plan.plannedAt ? plan.plannedAt.toISOString() : null,
    decidedAt: plan.decidedAt ? plan.decidedAt.toISOString() : null,
    decidedById: plan.decidedById,
    decidedByName: plan.decidedBy?.name ?? null,
    author: {
      source: plan.authorSource,
      harness: plan.authorHarness,
      model: redactNativeActor(plan.authorSource, plan.authorModel),
    },
    relation: { op: null, childCount: 0 },
    proposalIds: { self: null, children: [] },
  };
}
