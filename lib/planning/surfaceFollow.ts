import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { arrivalLevel } from '@/lib/planning/planArrival';
import { surfaceArrivalTrail } from '@/lib/planning/surfaceArrival';
import type { PlanningAnchor } from '@/lib/planning/planningAnchorClient';

// THE FOLLOW-MOVE's TRIGGERS (MOTIR-6161, Story MOTIR-6154) — the pure half.
//
// The canvas opens INSIDE whatever target the entrance carried (MOTIR-6160). A
// conversation that started with NO target — a project launch, ⌘K — opens at the
// root, and this is what decides when it should move, and to where.
//
// ── Core can see exactly TWO such moments ──────────────────────────────────
//
//   1. a target becomes KNOWN — the person ADDED it to the surface's own target
//      set, or, with none there, Motir AI SETTLED it: the run's `target_settled`
//      frame names the card at index 0 (MOTIR-10739; the story first shipped with
//      no such signal, and the frame has carried `key` since), and
//   2. where the plan's proposals LAND, once there are any,
//
// and the second answers the same question a moment later. Both are already in
// the host's hands; the first resolves its key through the anchor read.
//
// ── Why a pure module ──────────────────────────────────────────────────────
// The host wires the effects; the DECISION is here, so it can be ruled on
// directly rather than through a component render, and so the two triggers'
// precedence is one statement rather than an ordering that emerges from two
// `useEffect`s.

/** A follow REQUEST for `ProjectRoadmapCanvas.followTo` — keyed, one-shot. */
export interface FollowRequest {
  key: string;
  trail: CanvasCrumb[];
}

/**
 * TRIGGER 1 — a target became known: the person ADDED it, or the planner settled
 * it while the set was still empty (MOTIR-10739).
 *
 * Only when the set was EMPTY at open: a surface that already had a target
 * arrived inside it, and a second target must not move the canvas off the first
 * (the story's rule — with several targets the canvas is inside the FIRST one).
 *
 * An UNFILED LEAF target at the root yields an empty trail and so no request (MOTIR-7621):
 * the canvas is already on the level that shows it, and `followRequest` then
 * falls through to `followFromPlan`, which moves inside the leaf once the plan
 * proposes children under it.
 */
export function followFromTarget(anchor: PlanningAnchor | null): FollowRequest | null {
  if (anchor === null) return null;
  const trail = surfaceArrivalTrail({
    anchor: anchor.anchor,
    ancestors: anchor.ancestors,
    hasChildren: anchor.hasChildren,
    folders: anchor.folders,
  });
  if (trail.length === 0) return null;
  return { key: `target:${anchor.anchor.id}`, trail };
}

/**
 * TRIGGER 2 — the plan's proposals first show where the plan lands.
 *
 * `arrivalLevel` is the plan page's own rule, now in `lib/` so both surfaces ask
 * it rather than each deciding (MOTIR-6161's move). The story's words: the plan
 * page's rule is "reused, not re-cut".
 *
 * `null` when the plan names no container — a plan proposing only roots lands at
 * the top level, which is where the canvas already is, so there is nothing to
 * move to and no move to announce.
 */
export function followFromPlan(
  review: PlanReviewDto | null,
  proposedWord: string,
): FollowRequest | null {
  if (review === null) return null;
  const arrival = arrivalLevel(review.items, proposedWord);
  if (arrival === null || arrival.trail.length === 0) return null;
  return { key: `plan:${arrival.id}`, trail: arrival.trail };
}

/**
 * WHICH request the surface makes, given both.
 *
 * ⚠️ THE FIRST TO FIRE WINS, AND THE OTHER IS IGNORED — the card's rule, stated
 * once here rather than emerging from the order two effects happen to run in.
 * The canvas itself also honours at most one request per mount, so this is belt
 * and braces on purpose: the two answers can disagree (a person adds a target
 * while a plan is being written about another), and a surface that sent both
 * would be asking the canvas to move twice for one conversation.
 *
 * `fromTarget` is preferred when both are present because it is the person's own
 * act, and the plan's landing place is an inference about it.
 */
export function followRequest(
  fromTarget: FollowRequest | null,
  fromPlan: FollowRequest | null,
): FollowRequest | null {
  return fromTarget ?? fromPlan ?? null;
}
