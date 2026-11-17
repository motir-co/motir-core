import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { PlannabilityDto } from '@/lib/dto/plannability';
import {
  isPlanHeld,
  plannabilityOf,
  type PlannabilityBlockerFacts,
} from '@/lib/planning/plannability';
import {
  workItemLinkRepository,
  type PlannabilityBlockerRow,
} from '@/lib/repositories/workItemLinkRepository';
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
    const meta = await statusMetaFor(blockers, ctx.workspaceId);
    return plannabilityOf(
      item,
      blockers.map((b) => toFacts(b, meta, item.projectId)),
    );
  },

  /**
   * WHICH of these items are HELD out of planning (MOTIR-11546) — the stories the
   * Plan button's check would refuse, by the SAME rule (`isPlanHeld` over
   * `planBlockReasons`), so the To plan state a surface draws and the check can
   * never disagree. One batched blocker read and one workflow read for the whole
   * set, and none at all when the set holds no story: only a story is ever held.
   *
   * No access check of its own: every caller is a read that has already gated
   * the items it passes. `excludeBlockerIds` drops blockers the reader may not
   * see (a Visitor's withheld private-epic descendants), so the answer says
   * nothing about a card that read does not show.
   */
  async heldStoryIds(
    items: readonly { id: string; kind: string; projectId: string }[],
    workspaceId: string,
    opts: { excludeBlockerIds?: readonly string[] } = {},
  ): Promise<Set<string>> {
    const stories = items.filter((i) => i.kind === 'story');
    if (stories.length === 0) return new Set();
    const hidden = new Set(opts.excludeBlockerIds ?? []);
    const rows = (
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        workItemLinkRepository.findBlockersWithLiveChildCountsForItems(
          stories.map((s) => s.id),
          tx,
        ),
      )
    ).filter((r) => !hidden.has(r.id));
    if (rows.length === 0) return new Set();
    const meta = await statusMetaFor(rows, workspaceId);
    const byDependent = new Map<string, PlannabilityBlockerRow[]>();
    for (const row of rows) {
      const list = byDependent.get(row.dependentId);
      if (list) list.push(row);
      else byDependent.set(row.dependentId, [row]);
    }
    const held = new Set<string>();
    for (const story of stories) {
      const blockers = byDependent.get(story.id);
      if (!blockers) continue;
      if (
        isPlanHeld(
          story,
          blockers.map((b) => toFacts(b, meta, story.projectId)),
        )
      ) {
        held.add(story.id);
      }
    }
    return held;
  },

  /** {@link heldStoryIds} for ONE item: is it held out of planning? */
  async isHeld(
    item: { id: string; kind: string; projectId: string },
    workspaceId: string,
  ): Promise<boolean> {
    return (await plannabilityService.heldStoryIds([item], workspaceId)).has(item.id);
  },
};

type StatusMetaByProject = Map<string, Map<string, { category: StatusCategoryDto }>>;

/** Each blocker's statuses, from ITS OWN project's workflow: a cross-project
 *  blocker's statuses are its project's, not the card's. No read for no blocker. */
async function statusMetaFor(
  blockers: readonly PlannabilityBlockerRow[],
  workspaceId: string,
): Promise<StatusMetaByProject> {
  if (blockers.length === 0) return new Map();
  return workflowsService.getStatusMetaByProjects(
    blockers.map((b) => b.projectId),
    workspaceId,
  );
}

/** One blocker row as the rule's facts, classified against its own workflow. */
function toFacts(
  b: PlannabilityBlockerRow,
  meta: StatusMetaByProject,
  cardProjectId: string,
): PlannabilityBlockerFacts {
  return {
    id: b.id,
    identifier: b.identifier,
    key: b.key,
    title: b.title,
    kind: b.kind,
    statusCategory: meta.get(b.projectId)?.get(b.status)?.category ?? null,
    archived: b.archivedAt !== null,
    liveChildCount: b.liveChildCount,
    sameProject: b.projectId === cardProjectId,
  };
}
