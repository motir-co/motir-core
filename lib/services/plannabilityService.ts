import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { PlannabilityDto } from '@/lib/dto/plannability';
import { plannabilityOf } from '@/lib/planning/plannability';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE PLAN BUTTON'S PRE-CHECK (MOTIR-10544; design MOTIR-10543) — can this card
// be planned, and if not, why?
//
// Read at CLICK time, on the server, from the live edges and the live children:
// the canvas level's cached rows are not trusted, because a blocker may have been
// planned since the canvas loaded.
//
// The access check is the planning door's own: a key the actor cannot browse is
// the no-existence-leak 404 the planning-anchor read answers (`WorkItemNotFoundError`
// for a key that names nothing here, `ProjectNotFoundError` for a project the
// actor may not browse), and an actor who may browse but not plan is refused `ai:plan` with the
// `PermissionDeniedError` (403) every plan-change door raises
// (`planChangeSessionsService`'s `assertCanPlan`). So a caller who may not plan
// the item gets the same refusal as before this check existed.
export const plannabilityService = {
  async checkPlannable(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<PlannabilityDto> {
    const item = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(projectId, identifier, tx),
    );
    if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(identifier);
    // One resolve, both checks: a non-browser is `ProjectNotFoundError` (the
    // 404), a browser without the key is `PermissionDeniedError` (the 403).
    await projectAccessService.assertPermission(item.projectId, ctx, 'ai:plan');

    const blockers = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockersWithLiveChildCounts(item.id, tx),
    );
    // Each blocker is classified against ITS OWN project's workflow: a
    // cross-project blocker's statuses are its project's, not the card's.
    const meta =
      blockers.length === 0
        ? new Map<string, Map<string, { category: StatusCategoryDto }>>()
        : await workflowsService.getStatusMetaByProjects(
            blockers.map((b) => b.projectId),
            ctx.workspaceId,
          );

    return plannabilityOf(
      item,
      blockers.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        key: b.key,
        title: b.title,
        kind: b.kind,
        statusCategory: meta.get(b.projectId)?.get(b.status)?.category ?? null,
        archived: b.archivedAt !== null,
        liveChildCount: b.liveChildCount,
        sameProject: b.projectId === item.projectId,
      })),
    );
  },
};
