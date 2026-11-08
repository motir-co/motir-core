import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE STATUS SLOT'S RULE, IN ONE PLACE (MOTIR-10534).
//
// The roadmap canvas card (design MOTIR-10508, built in MOTIR-10509) shows an
// item's state in ONE slot of its tag row: the status chip, or a pill that
// REPLACES it — Done › To plan › Ready › status chip. That drawing is now the one
// every surface uses (the /boards card, the quick view, the item page), so the
// precedence lives here, in a module with no `'use client'` directive: the board
// read, the item page and the client components all import the SAME rule, and a
// server module importing it does not turn it into a client reference.

/** The facts the slot is decided from — a subset of every surface's item shape. */
export interface StatusSlotItem {
  /** The work item KIND (`epic`, `story`, `task`, `bug`, `subtask`). */
  kind: string;
  /** The workflow status KEY, verbatim — statuses are project-defined. */
  status: string;
  /** The status's lifecycle category, when the surface knows it. */
  statusCategory?: StatusCategoryDto | null;
  /** Has live children. Must be KNOWN to be `false` for To plan. */
  hasChildren?: boolean;
}

/** What the slot draws. (The canvas's You are here is a tab on the card, not a
 *  slot pill — MOTIR-10630.) */
export type StatusSlotKind = 'done' | 'to-plan' | 'ready' | 'status';

/**
 * A TO PLAN story (design MOTIR-10508 § "The To plan story"): a story with no
 * children whose status category is `todo`. A childless story already In Progress
 * is not To plan (someone holds it), and a childless Done story is Done.
 *
 * `hasChildren` must be KNOWN to be false: a node built without it (an onboarding
 * preview, a run's canvas fed an older read) never claims the story is unplanned.
 */
export function isToPlanStory(item: StatusSlotItem): boolean {
  if (item.kind !== 'story' || item.hasChildren !== false) return false;
  // The category is the rule; an item built without it falls back to the default
  // workflow's own `todo` key rather than guessing from a custom one.
  const category = item.statusCategory ?? (item.status === 'todo' ? 'todo' : null);
  return category === 'todo';
}

/**
 * Which pill the status slot draws, in the canvas card's precedence
 * (MOTIR-10508): Done › To plan › Ready › the status chip — on every surface, the
 * canvas's "here" card included (MOTIR-10630 moved You are here onto a tab).
 *
 * - Done is the `done` KEY, and a BLOCKED item does not wear the Done stamp: its
 *   blocked flag is the louder signal, and the slot keeps the status chip.
 * - To plan never meets Done (a `todo` story is never done); it is checked after
 *   Done for the order's sake.
 * - Ready is "startable and fully unblocked" — the caller's `ready`, the rule the
 *   roadmap read writes into `RoadmapNodeDto.ready`.
 */
export function statusSlotOf(
  item: StatusSlotItem,
  state: { ready: boolean; blocked: boolean },
): StatusSlotKind {
  if (item.status === 'done' && !state.blocked) return 'done';
  if (isToPlanStory(item)) return 'to-plan';
  if (state.ready) return 'ready';
  return 'status';
}

/**
 * The canvas's READY: in a startable (`todo`-category) status AND fully unblocked
 * (the cascaded readiness — own blockers done and every ancestor ready). The rule
 * `workItemsService.getRoadmapLevel` applies to `RoadmapNodeDto.ready`; the board,
 * the quick view and the item page apply the same one to the readiness they hold.
 */
export function isReadyToStart(
  statusCategory: StatusCategoryDto | null | undefined,
  unblocked: boolean,
): boolean {
  return statusCategory === 'todo' && unblocked;
}
