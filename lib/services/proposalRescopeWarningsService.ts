import type { PlanItemPatch, ProposalRescopeWarningDto } from '@/lib/dto/plans';
import { isFolderRef, isTempRef } from '@/lib/plans/refs';
import { rescopeWarningOf } from '@/lib/plans/rescopeWarning';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// ── The `modify`s approve will send back from built work (MOTIR-10106) ────────
//
// The pure half (`lib/plans/rescopeWarning.ts`) decides one proposal through the
// review's own status read; this is the half that reads what that decision needs
// — each target's live row, the status a park took it from, the project's
// workflow — in one bound transaction, AFTER the write committed, as the link
// warnings are read (`proposalLinkWarningsService`).

/** The plan-item fields the warning reads: a persisted row and its DTO both carry them. */
export interface RescopeWarningItem {
  id: string;
  op: string;
  workItemId: string | null;
  patch: unknown;
  parentRef: string | null;
}

export const proposalRescopeWarningsService = {
  /**
   * The re-scope warnings of the `modify` proposals among `all` whose ids are in
   * `targetIds` — every `modify` when `targetIds` is omitted (`validate_plan`).
   * Empty when none of them re-scopes a card that claims built work.
   */
  async forProposals<I extends RescopeWarningItem>(
    all: readonly I[],
    targetIds: readonly string[] | undefined,
    labelOf: (item: I) => string,
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProposalRescopeWarningDto[]> {
    const wanted = targetIds ? new Set(targetIds) : null;
    const modifies = all.filter(
      (i): i is I & { workItemId: string } =>
        i.op === 'modify' && !!i.workItemId && !!i.patch && (!wanted || wanted.has(i.id)),
    );
    if (modifies.length === 0) return [];
    const targetIdsRead = [...new Set(modifies.map((i) => i.workItemId))];
    const { rows, parks, statuses } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => ({
        rows: await workItemRepository.findByIdsInWorkspace(targetIdsRead, ctx.workspaceId, tx),
        parks: await planTargetLockRepository.listParkPriorsByWorkItemIds(targetIdsRead, tx),
        statuses: await workflowsService.listStatusesByProject(projectId, ctx.workspaceId, tx),
      }),
    );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const parkById = new Map(parks.map((p) => [p.workItemId, p]));
    const statusByKey = new Map(statuses.map((s) => [s.key, s]));
    // The committed cards this plan lays NEW children under — the review's and
    // materialize's `gainsChildren`, read off the `add`s alone.
    const addParentIds = new Set(
      all
        .filter((i) => i.op === 'add')
        .map((i) => i.parentRef)
        .filter((ref): ref is string => !!ref && !isTempRef(ref) && !isFolderRef(ref)),
    );
    return modifies.flatMap((item) => {
      const target = rowById.get(item.workItemId);
      // An archived row is claimed by nothing and a marked card stays finished —
      // the two the approve's decision leaves where they are.
      if (!target || target.archivedAt !== null || target.obsolescence != null) return [];
      const warning = rescopeWarningOf(
        { planItemId: item.id, proposal: labelOf(item) },
        item.patch as PlanItemPatch,
        target,
        statusByKey,
        {
          park: parkById.get(item.workItemId),
          gainsChildren: addParentIds.has(item.workItemId),
        },
      );
      return warning ? [warning] : [];
    });
  },
};
