import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { projectedWorkItem, type ProjectedRowDto } from '@/lib/services/planProjectionService';
import { UNDECIDED_PLAN_STATUSES } from '@/lib/plans/planHold';
import {
  PLAN_OVERLAY_FIELDS,
  type AiPlanProposalOverlay,
  type AiPlanRowProposal,
  type PlanOverlayCommitted,
  type PlanTreeSkeletonItem,
} from '@/lib/dto/ai';
import type { PlanItemPatch, PlanStatusDto } from '@/lib/dto/plans';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE JOB'S OWN PLAN, OVER A PLANNING READ OF COMMITTED CARDS (MOTIR-11340).
//
// A planning session reads committed cards through `get-item` / `get-subtree`,
// and until now always got the STORED card — even when its own plan carried a
// `modify` rewriting it. The hosted final check had no other way to read a
// committed card, so it judged a plan against text that plan was replacing
// (MOTIR-11007's plan: the review quoted MOTIR-11009's old body, and the repair
// rewrote a leaf to match it).
//
// The plan is found from the JOB, by `sourceJobId` and workspace-scoped, exactly
// as `plan-proposals` finds it — so a job token cannot read another job's plan,
// and a job id from another tenant finds nothing and leaves the read as it was.
// Only an UNDECIDED plan overlays: an approved plan's text is already the card,
// and a declined plan's is no longer anyone's proposal.
//
// The overlay follows the projection's sparse-patch semantics
// (`planProjectionService.buildProjection`): a key ABSENT from the patch leaves the
// committed value; a key present with `null` is the plan clearing it.

type UndecidedPlan = { id: string; status: PlanStatusDto };

/** A plan row narrowed to an undecided plan of `projectId`, or `null`. */
function undecidedIn(
  plan: { id: string; projectId: string; status: string } | null,
  projectId: string,
): UndecidedPlan | null {
  if (!plan || plan.projectId !== projectId) return null;
  if (!(UNDECIDED_PLAN_STATUSES as readonly string[]).includes(plan.status)) return null;
  return { id: plan.id, status: plan.status as PlanStatusDto };
}

/** The job's undecided plan, or `null` when there is none in this project. */
async function undecidedPlanOfJob(
  jobId: string,
  projectId: string,
  ctx: ServiceContext,
): Promise<UndecidedPlan | null> {
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
  );
  return undecidedIn(plan, projectId);
}

/** A plan by id, when it is undecided and in this project; `null` otherwise. */
async function undecidedPlanById(
  planId: string,
  projectId: string,
  ctx: ServiceContext,
): Promise<UndecidedPlan | null> {
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  return undecidedIn(plan, projectId);
}

type TargetingRow = Awaited<ReturnType<typeof planItemRepository.findTargetingWorkItems>>[number];

async function targetingRows(
  planId: string,
  workItemIds: readonly string[],
  ctx: ServiceContext,
): Promise<Map<string, TargetingRow>> {
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planItemRepository.findTargetingWorkItems(planId, workItemIds, ctx.workspaceId, tx),
  );
  // `@@unique([planId, workItemId])` — one proposal per card per plan.
  return new Map(rows.map((r) => [r.workItemId as string, r]));
}

/**
 * Apply a `modify`'s sparse patch to the overlay fields of a card. Pure. Returns the
 * patched card and the committed value of every field it replaced.
 */
export function overlayPatch<T extends Pick<WorkItemDto, (typeof PLAN_OVERLAY_FIELDS)[number]>>(
  item: T,
  patch: PlanItemPatch | null,
): { item: T; committed: PlanOverlayCommitted } {
  const committed: Record<string, unknown> = {};
  const next: Record<string, unknown> = { ...item };
  if (patch) {
    for (const field of PLAN_OVERLAY_FIELDS) {
      if (!(field in patch)) continue;
      const value = (patch as Record<string, unknown>)[field];
      // `title`, `kind` and `priority` have no clearing form on a work item; a
      // stray `null` on one leaves the committed value rather than blanking it.
      if (value === null && (field === 'title' || field === 'kind' || field === 'priority')) {
        continue;
      }
      committed[field] = item[field];
      next[field] = value ?? null;
    }
  }
  return { item: next as T, committed: committed as PlanOverlayCommitted };
}

const refOf = (row: ProjectedRowDto): string => row.key ?? row.tempRef ?? '?';

function touchesEdges(patch: PlanItemPatch | null): boolean {
  return (patch?.blockedByAdd?.length ?? 0) > 0 || (patch?.blockedByRemove?.length ?? 0) > 0;
}

/** Overlay one committed card with `plan`'s proposal for it; `null` when there is none. */
async function overlayOnto<T extends WorkItemDto & { identifier: string }>(
  plan: UndecidedPlan | null,
  item: T,
  ctx: ServiceContext,
): Promise<{ item: T; planProposal: AiPlanProposalOverlay } | null> {
  if (!plan) return null;
  const row = (await targetingRows(plan.id, [item.id], ctx)).get(item.id);
  if (!row) return null;
  const committedRevision =
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRevisionRepository.findLatestIdsByWorkItemIds([item.id], tx),
      )
    ).get(item.id) ?? null;
  const base = {
    planId: plan.id,
    planStatus: plan.status,
    planItemId: row.id,
    approved: false as const,
    committedRevision,
  };
  if (row.op === 'remove') {
    return {
      item,
      planProposal: { ...base, op: 'remove', patch: null, committed: {} },
    };
  }
  const patch = (row.patch as PlanItemPatch | null) ?? null;
  const overlaid = overlayPatch(item, patch);
  const planProposal: AiPlanProposalOverlay = {
    ...base,
    op: 'modify',
    patch,
    committed: overlaid.committed,
  };
  // Edges and the parent come from the PROJECTION itself, so a temp-ref edge and a
  // re-parent under a proposal resolve exactly as every other projected read
  // resolves them. Only built when the patch moves one: a body-only modify — the
  // common case — costs no projection.
  const reparents = patch !== null && 'parentRef' in patch;
  if (touchesEdges(patch) || reparents) {
    const projected = await projectedWorkItem(plan.id, item.identifier, ctx);
    if (touchesEdges(patch)) planProposal.projectedBlockedBy = projected.blockedBy.map(refOf);
    if (reparents) planProposal.projectedParent = projected.parent ? refOf(projected.parent) : null;
  }
  return { item: overlaid.item, planProposal };
}

export const aiPlanOverlayService = {
  /**
   * One committed card as the job's plan leaves it. `null` when there is no jobId,
   * no undecided plan for the job in this project, or no `modify` / `remove` of the
   * card on it — and the caller then answers the committed card unchanged.
   */
  async overlayItem<T extends WorkItemDto & { identifier: string }>(
    jobId: string | undefined,
    projectId: string,
    item: T,
    ctx: ServiceContext,
  ): Promise<{ item: T; planProposal: AiPlanProposalOverlay } | null> {
    if (!jobId) return null;
    return overlayOnto(await undecidedPlanOfJob(jobId, projectId, ctx), item, ctx);
  },

  /**
   * The same overlay for a plan named by ID: the MCP `get_work_item { planId }` read
   * of a committed card (MOTIR-11340), so a `prompts/plan.py` session reading a card
   * its walk's plan modifies is handed the plan's text with the full card around it.
   * `null` when the plan is not an undecided plan of this project, or does not
   * target the card.
   */
  async overlayItemForPlan<T extends WorkItemDto & { identifier: string }>(
    planId: string,
    projectId: string,
    item: T,
    ctx: ServiceContext,
  ): Promise<{ item: T; planProposal: AiPlanProposalOverlay } | null> {
    return overlayOnto(await undecidedPlanById(planId, projectId, ctx), item, ctx);
  },

  /**
   * A subtree's committed rows as the job's plan leaves them — the row's `title`,
   * `kind` and `obsolescence` take the patch's value, and every targeted row carries
   * a {@link AiPlanRowProposal}. Rows the plan does not target, and every row when
   * there is no jobId or no undecided plan, come back unchanged.
   */
  async overlayRows(
    jobId: string | undefined,
    projectId: string,
    rows: PlanTreeSkeletonItem[],
    ctx: ServiceContext,
  ): Promise<PlanTreeSkeletonItem[]> {
    if (!jobId || rows.length === 0) return rows;
    const plan = await undecidedPlanOfJob(jobId, projectId, ctx);
    if (!plan) return rows;
    const byId = await targetingRows(
      plan.id,
      rows.map((r) => r.id),
      ctx,
    );
    return rows.map((row) => {
      const target = byId.get(row.id);
      if (!target) return row;
      const marker: AiPlanRowProposal = {
        planItemId: target.id,
        op: target.op === 'remove' ? 'remove' : 'modify',
        approved: false,
      };
      if (target.op === 'remove') return { ...row, planProposal: marker };
      const patch = (target.patch as PlanItemPatch | null) ?? null;
      const next = { ...row };
      if (typeof patch?.title === 'string' && patch.title !== row.title) {
        marker.committedTitle = row.title;
        next.title = patch.title;
      }
      if (patch?.kind) next.kind = patch.kind;
      if (patch && 'obsolescence' in patch) next.obsolescence = patch.obsolescence ?? null;
      return { ...next, planProposal: marker };
    });
  },
};
