'use server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The card links in an agent chat's text (bug MOTIR-10023). The transcript streams from
// the reader's own agent and is never stored, so there is no server read to resolve its
// `[KEY](motir:<id>)` tokens with — the transcript asks here for the ids it has parsed,
// once per id. The answer is the reader's: the same view gate every chip rides, so a
// card the reader cannot browse is the no-access chip and a deleted one is absent.
//
// Transport-only (a Server Action is the route-layer equivalent): resolve the reader,
// call the ONE resolver.

/** At most this many ids per call — a transcript asks for the ids it has not seen. */
const MAX_IDS = 100;

export async function resolveChatWorkItemRefsAction(ids: string[]): Promise<WorkItemRefMap> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return {};
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  // Token ids are resolved across the reader's workspace, so no project scopes them.
  return resolveWorkItemRefSummaries({ ids: wanted.slice(0, MAX_IDS), keys: [] }, '', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
}
