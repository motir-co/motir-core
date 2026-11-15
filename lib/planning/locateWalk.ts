import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// THE LOCATE WALK (MOTIR-1421 · MOTIR-4020 · MOTIR-11298) — the PURE half of the
// canvas's Locate control: which card the next click goes to, and what the
// `n / total` hint says. No React, so each rule is tested on plain lists.
//
// The walk has two parts, in this order:
// 1. the ACTIVE cards — the ones a live planner step targets right now. Each is
//    visited once per round, in the order given (the caller lists the cards on
//    the shown level in layout order, then the ones on other levels).
// 2. the REST — the walk the control had before: the emphasised set (or, with no
//    emphasis, the ready nodes) in layout order, less the active cards.
// After the last of the rest, the round starts again from the first active card.
//
// The active cards are remembered by node id, not by index, because visiting an
// active card on ANOTHER level changes the level, and so the order of every list
// here; an id list says "already been there" whatever level the reader is on.

/** One place Locate can go: a node, and the trail to its level when it is NOT on
 *  the level shown (`null` for a node drawn here). */
export interface LocateStop {
  nodeId: string;
  trail: readonly CanvasCrumb[] | null;
}

/** Where the walk stands: the active cards visited this round, and the index of
 *  the last REST stop located (`-1` = none this round). */
export interface LocateCursor {
  visited: readonly string[];
  index: number;
}

export const LOCATE_START: LocateCursor = { visited: [], index: -1 };

/**
 * The stop the NEXT click goes to, whether it is an active card, and the cursor
 * after it. `null` when there is nowhere to go.
 */
export function nextLocateStop(
  active: readonly LocateStop[],
  rest: readonly LocateStop[],
  cursor: LocateCursor,
): { stop: LocateStop; active: boolean; cursor: LocateCursor } | null {
  const unvisited = active.find((s) => !cursor.visited.includes(s.nodeId));
  if (unvisited) {
    return {
      stop: unvisited,
      active: true,
      cursor: { visited: [...cursor.visited, unvisited.nodeId], index: cursor.index },
    };
  }
  const next = cursor.index + 1;
  const restStop = rest[next];
  if (restStop) {
    return { stop: restStop, active: false, cursor: { visited: cursor.visited, index: next } };
  }
  // The round is over: start again from the first active card, else wrap the rest.
  const first = active[0];
  if (first) return { stop: first, active: true, cursor: { visited: [first.nodeId], index: -1 } };
  const head = rest[0];
  return head ? { stop: head, active: false, cursor: { visited: [], index: 0 } } : null;
}

/**
 * The `n / total` hint over the cards being cycled through: the active cards
 * while the walk is on them, the rest once it has moved on. Shown only after a
 * click, and only when there is more than one card to cycle.
 */
export function locateHint(
  active: readonly LocateStop[],
  rest: readonly LocateStop[],
  cursor: LocateCursor,
): string | null {
  if (cursor.index >= 0) return rest.length > 1 ? `${cursor.index + 1} / ${rest.length}` : null;
  if (cursor.visited.length === 0) return null;
  // An active card visited on another level may not be reachable from this one,
  // so the count never reads below the cards already visited.
  const total = Math.max(active.length, cursor.visited.length);
  return total > 1 ? `${cursor.visited.length} / ${total}` : null;
}
