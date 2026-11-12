import type { WorkItemDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { BacklogWrite } from './backlogDnd';

// Pure, React-free helpers for the Story-4.2 grooming ACTIONS (Subtask 4.2.5):
// multi-select range resolution, the atomic bulk-move / boundary-rank write
// builders (bound to the 4.2.2 endpoints + the 4.1.4 rank route), and the
// created-issue → row-summary projection. Kept side-effect-free so the selection
// + bulk + create logic is unit-testable in isolation, exactly as `backlogDnd.ts`
// isolates the drag-resolution core.

/**
 * The ids covered by a SHIFT-range selection: every id between `anchor` and
 * `target` (inclusive) in the flattened visual order `ordered` (the regions'
 * rows concatenated top-to-bottom). Order-independent in the arguments — a range
 * dragged upward selects the same set as one dragged down. An anchor/target not
 * in `ordered` (e.g. in a since-collapsed region) collapses to just `target`.
 */
export function rangeIds(ordered: string[], anchor: string, target: string): string[] {
  const a = ordered.indexOf(anchor);
  const b = ordered.indexOf(target);
  if (a === -1 || b === -1) return [target];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ordered.slice(lo, hi + 1);
}

/** The bulk "Move to sprint ▸" write (Subtask 4.2.2 — ONE atomic transaction). */
export function bulkAssignWrite(sprintId: string, itemIds: string[]): BacklogWrite {
  return { url: `/api/sprints/${sprintId}/issues/bulk`, body: { itemIds } };
}

/** The bulk "Move to backlog" write (Subtask 4.2.2 — ONE atomic transaction). */
export function bulkBacklogWrite(itemIds: string[]): BacklogWrite {
  return { url: `/api/backlog/bulk-move`, body: { itemIds } };
}

/**
 * The single-row rank write that lands an issue at the TOP or BOTTOM of its
 * current backlog region (the `⋯` menu's "Move to top / bottom of backlog" —
 * 4.1.4 `rankIssue` prepend/append). `neighbourId` is the current first row (top)
 * or last row (bottom), EXCLUDING the moved row; a `null` neighbour (an empty /
 * single-row region) mints the sole key. Top → rank BEFORE the first row
 * (`afterId`); bottom → rank AFTER the last row (`beforeId`), matching
 * `resolveInsertion`'s before=above / after=below convention.
 */
export function boundaryRankWrite(
  itemId: string,
  edge: 'top' | 'bottom',
  neighbourId: string | null,
): BacklogWrite {
  const body =
    edge === 'top' ? { afterId: neighbourId ?? undefined } : { beforeId: neighbourId ?? undefined };
  return { url: `/api/work-items/${itemId}/rank`, body };
}

/**
 * Project a freshly-created `WorkItemDto` (the POST /api/backlog 201 body) onto
 * the lighter `WorkItemSummaryDto` the backlog rows render, so an inline-created
 * issue appears in place WITHOUT a full reload (Subtask 4.2.5). Carries only the
 * fields the row reads — the create response is a superset.
 */
export function toRowSummary(dto: WorkItemDto): WorkItemSummaryDto {
  return {
    id: dto.id,
    parentId: dto.parentId,
    kind: dto.kind,
    key: dto.key,
    identifier: dto.identifier,
    title: dto.title,
    status: dto.status,
    priority: dto.priority,
    assigneeId: dto.assigneeId,
    position: dto.position,
    estimateMinutes: dto.estimateMinutes,
    storyPoints: dto.storyPoints,
    obsolescence: dto.obsolescence,
    obsolescenceNoteMd: dto.obsolescenceNoteMd,
    subject: dto.subject,
    archivedAt: dto.archivedAt,
  };
}
