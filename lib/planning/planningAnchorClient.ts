import type { PlanningTarget } from '@/lib/planning/planningTargets';

// Client read of the planning workspace's ANCHOR (MOTIR-4727) from
// `GET /api/work-items/planning-anchor?key=` — the work item a work-item launch
// is scoped to, plus its ancestor chain.
//
// The overlay (MOTIR-4725) is a client island, so the lineage read the retiring
// `app/(planning)/planning/page.tsx` made on the server has to happen over the
// wire. This is the CLIENT half — the reusable asset, beside `roadmapClient.ts`'s
// `fetchRoadmapLevel`; a consumer calls this, never the route path.
//
// Deliberately NOT best-effort in the way `fetchRoadmapLevel` is. That read
// degrades every failure to an empty level because a canvas with no rows is a
// usable canvas. Here the two outcomes are different findings and the consumer
// treats them differently: a `404` is the no-existence-leak contract answering
// "there is no anchor you may see" and the workspace opens the project
// conversation at the root with no error surface, while a 500 or a dropped
// connection is a real failure the caller may want to retry or report. Folding
// them together would make an outage look like a missing work item.

/** One ancestor of the anchor — root→parent order, raw, so the consumer builds
 *  the crumbs it wants (`workItemCrumbLabel` in `lib/planning/projectCanvasModel.ts`). */
export interface PlanningAnchorAncestor {
  id: string;
  identifier: string;
  title: string;
}

/** What the route returns: the anchor in the `PlanningTarget` shape the composer's
 *  target set already speaks, and its ancestors root→parent (`[]` at the root). */
export interface PlanningAnchor {
  anchor: PlanningTarget;
  ancestors: PlanningAnchorAncestor[];
  /** Does the anchor have live children (MOTIR-7621)? The arrival rule opens
   *  INSIDE the anchor only when it does; a leaf arrives on its own level. */
  hasChildren: boolean;
  /** The anchor's effective placement folder chain, ROOT FIRST (`[]` when
   *  unfiled) — the folder crumbs the arrival trail walks through first. */
  folders: PlanningAnchorFolder[];
}

/** One folder of the anchor's placement chain. */
export interface PlanningAnchorFolder {
  id: string;
  name: string;
}

/**
 * Fetch the anchor work item and its ancestor trail.
 *
 * Resolves `null` on `404` — an unknown, archived, other-project or
 * non-browsable key, all one answer by the no-existence-leak contract. THROWS on
 * any other non-`2xx`, and lets an abort propagate as the `AbortError` the
 * caller's `AbortSignal` raised, so a superseded fetch is distinguishable from a
 * failed one.
 */
export async function fetchPlanningAnchor(
  key: string,
  signal?: AbortSignal,
): Promise<PlanningAnchor | null> {
  const res = await fetch(`/api/work-items/planning-anchor?key=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Planning anchor read failed (${res.status})`);
  }
  const body = (await res.json()) as PlanningAnchor;
  return {
    anchor: body.anchor,
    ancestors: body.ancestors ?? [],
    // Absent reads as a leaf: arriving BESIDE an item always shows it, while
    // arriving inside a childless one shows an empty level.
    hasChildren: body.hasChildren === true,
    // Absent reads as unfiled — the trail the read carried before folders did.
    folders: body.folders ?? [],
  };
}
