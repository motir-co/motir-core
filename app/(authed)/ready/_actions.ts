'use server';

import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// Server Actions backing the /ready page's cursor-driven "load more on scroll"
// (Subtask 7.0.6), one per ready LANE since Story MOTIR-6829 (MOTIR-6834). The
// page server-renders each lane's FIRST page; these fetch each subsequent page on
// demand as a lane's virtualized list nears its end, so both the initial payload
// AND the DOM stay bounded (finding #57). The cursor is the LANE cursor, which may
// end a page inside a container's group — the list merges the next page's first
// rows into that group rather than opening a second header.
//
// Transport-only (CLAUDE.md: a Server Action is a route-layer equivalent): each
// resolves the active-project context and calls ONE service method.

type Page = { items: ReadyItemDto[]; nextCursor: string | null; workItemRefs: WorkItemRefMap };

export async function loadMoreReadyLeavesAction(cursor: string): Promise<Page> {
  const ctx = await getActiveProject();
  // No active project (signed out mid-scroll, or the project vanished) → nothing
  // more to stream; the list simply stops paging.
  if (!ctx) return { items: [], nextCursor: null, workItemRefs: {} };
  return workItemsService.listReadyLanePage(
    ctx.projectId,
    'leaf',
    { cursor },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
}

export async function loadMoreReadyBugsAction(cursor: string): Promise<Page> {
  const ctx = await getActiveProject();
  if (!ctx) return { items: [], nextCursor: null, workItemRefs: {} };
  return workItemsService.listReadyLanePage(
    ctx.projectId,
    'bug',
    { cursor },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
}
