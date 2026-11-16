import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// Pure swimlane reducers + helpers (Subtask 3.3.5) — the bucketing + cross-lane
// move core the dnd-kit wiring in BoardContainer drives in swimlane mode. Kept
// side-effect-free (columns-in, columns-out; no React, no network) so the
// "lane render + bucketing + catch-all" and "cross-lane reassign reducer (incl.
// diagonal + independent revert)" acceptance checks are unit-testable in
// isolation — the same split `boardMove.ts` uses for the flat board.
//
// The lane a card sits in is DERIVED from its `swimlaneKey` (resolved
// server-side by the 3.3.4 projection), never re-derived here: a card with
// `swimlaneKey` X lives in the lane whose `BoardSwimlaneDto.key` is X. A card
// with no key (the flat `none` board) is not bucketed — swimlane mode only runs
// when the projection's `swimlaneGroupBy !== 'none'`. So a cross-lane move is
// just "set the card's `swimlaneKey` to the target lane's key" (+ a column move
// when the drop also crosses columns); render re-buckets from that.

/**
 * The delimiter joining a column id + a lane key into a single dnd-kit droppable
 * id for a `(column × lane)` CELL. A cell needs its own droppable (distinct from
 * the flat board's per-column droppable) so a drop resolves to BOTH a target
 * column (→ the workflow transition) and a target lane (→ the field reassign).
 * Column ids + epic/assignee lane keys are cuids and priority keys are short
 * lowercase words, so `::` never collides with either half.
 */
export const LANE_CELL_SEP = '::';

/** Build a `(column × lane)` cell droppable id. */
export function cellId(columnId: string, laneKey: string): string {
  return `${columnId}${LANE_CELL_SEP}${laneKey}`;
}

/** Parse a cell droppable id back into its column + lane, or null if it isn't one. */
export function parseCellId(id: string): { columnId: string; laneKey: string } | null {
  const i = id.indexOf(LANE_CELL_SEP);
  if (i === -1) return null;
  return { columnId: id.slice(0, i), laneKey: id.slice(i + LANE_CELL_SEP.length) };
}

/** The lane a card belongs to under the active group-by (its resolved key, or the catch-all). */
export function laneKeyOfCard(card: BoardCardDto): string {
  return card.swimlaneKey ?? BOARD_SWIMLANE_NO_VALUE;
}

/** The loaded cards of `columnId` that sit in `laneKey`, in their column order. */
export function cardsInCell(
  columns: BoardColumnDto[],
  columnId: string,
  laneKey: string,
): BoardCardDto[] {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return [];
  return col.cards.filter((c) => laneKeyOfCard(c) === laneKey);
}

/**
 * Resolve a dnd-kit `over` id (in swimlane mode) to its target cell. The id may
 * be a CELL droppable (`columnId::laneKey` — dropping on the cell body / an empty
 * cell) or a CARD sortable (dropping on a card — resolve to the card's current
 * column + lane). Returns null if it matches neither.
 */
export function cellOfOverId(
  columns: BoardColumnDto[],
  overId: string,
): { columnId: string; laneKey: string } | null {
  const parsed = parseCellId(overId);
  if (parsed) return parsed;
  for (const col of columns) {
    const card = col.cards.find((c) => c.id === overId);
    if (card) return { columnId: col.id, laneKey: laneKeyOfCard(card) };
  }
  return null;
}

/**
 * Move `cardId` into the `(toColumnId, toLaneKey)` cell — the swimlane analogue
 * of `relocateCard`. Stamps the card's `swimlaneKey` to the target lane (so it
 * re-buckets there) AND relocates it into the target column, inserting just
 * before `overCardId` when given (else appending to the column). Pure; the
 * `totalCount` denominator is untouched (see `transferCount` for the column
 * count). No-op shape if the card or target column can't be found.
 */
export function relocateCardToCell(
  columns: BoardColumnDto[],
  cardId: string,
  toColumnId: string,
  toLaneKey: string,
  overCardId: string | null,
): BoardColumnDto[] {
  let moving: BoardCardDto | null = null;
  for (const col of columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) {
      moving = found;
      break;
    }
  }
  if (!moving) return columns;
  if (!columns.some((c) => c.id === toColumnId)) return columns;

  const stamped: BoardCardDto = { ...moving, swimlaneKey: toLaneKey };

  return columns.map((col) => {
    const without = col.cards.filter((c) => c.id !== cardId);
    if (col.id !== toColumnId) {
      return without.length === col.cards.length ? col : { ...col, cards: without };
    }
    const overIndex = overCardId ? without.findIndex((c) => c.id === overCardId) : -1;
    const index = overIndex === -1 ? without.length : overIndex;
    return { ...col, cards: [...without.slice(0, index), stamped, ...without.slice(index)] };
  });
}

/**
 * Re-stamp `cardId`'s `swimlaneKey` to `laneKey` in place (no column move) — the
 * independent LANE-axis revert: after a rejected reassign, the card's column
 * stays where the (separately-confirmed) transition left it, only its lane
 * snaps back. No-op if the card isn't present.
 */
export function setCardSwimlaneKey(
  columns: BoardColumnDto[],
  cardId: string,
  laneKey: string,
): BoardColumnDto[] {
  return columns.map((col) => {
    if (!col.cards.some((c) => c.id === cardId)) return col;
    return {
      ...col,
      cards: col.cards.map((c) => (c.id === cardId ? { ...c, swimlaneKey: laneKey } : c)),
    };
  });
}

/**
 * Move `cardId` back into `toColumnId` (appending) — the independent COLUMN-axis
 * revert: after a rejected transition, the card returns to its origin column
 * while its (separately-confirmed) lane reassign stays. Leaves the
 * `swimlaneKey` untouched. No-op shape if the card / column is missing.
 */
export function moveCardToColumn(
  columns: BoardColumnDto[],
  cardId: string,
  toColumnId: string,
): BoardColumnDto[] {
  let moving: BoardCardDto | null = null;
  for (const col of columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) {
      moving = found;
      break;
    }
  }
  if (!moving) return columns;
  if (findCardColumnIdLocal(columns, cardId) === toColumnId) return columns;
  if (!columns.some((c) => c.id === toColumnId)) return columns;
  return columns.map((col) => {
    const without = col.cards.filter((c) => c.id !== cardId);
    if (col.id !== toColumnId) {
      return without.length === col.cards.length ? col : { ...col, cards: without };
    }
    return { ...col, cards: [...without, moving!] };
  });
}

function findCardColumnIdLocal(columns: BoardColumnDto[], cardId: string): string | null {
  for (const col of columns) if (col.cards.some((c) => c.id === cardId)) return col.id;
  return null;
}

/**
 * The issue-field patch a cross-lane drop into `laneKey` produces, under the
 * active group-by — fed to the EXISTING Story-2.5 `updateIssueAction` (NOT a new
 * backend, NOT the board/move endpoint):
 *   - `assignee` → `{ assigneeId }` (the catch-all lane clears it → unassign)
 *   - `priority` → `{ priority }` (priority has no catch-all — every card has one)
 *   - `epic`     → `{ parentId }` (reparent to that epic; the catch-all clears it)
 * The legality of an epic reparent is enforced by the existing endpoint (the
 * kind-parent matrix); an illegal one rejects and the lane axis snaps back.
 */
export function reassignPatchForLane(
  groupBy: BoardSwimlaneGroupByDto,
  laneKey: string,
): { assigneeId?: string | null; priority?: WorkItemPriorityDto; parentId?: string | null } {
  const isCatchAll = laneKey === BOARD_SWIMLANE_NO_VALUE;
  switch (groupBy) {
    case 'assignee':
      return { assigneeId: isCatchAll ? null : laneKey };
    case 'priority':
      return { priority: laneKey as WorkItemPriorityDto };
    case 'epic':
      return { parentId: isCatchAll ? null : laneKey };
    default:
      return {};
  }
}

/**
 * The (column, lane) axes a finished swimlane drag changed — resolved from the
 * pre-drag `snapshot` (origin) and the post-over-move `current` columns (the
 * dragged card already sits in its target cell after `handleDragOver`). Drives
 * BoardContainer's drop handling: a `columnChanged` fires the workflow
 * transition (`/board/move`), a `laneChanged` fires the field reassign
 * (`updateIssueAction`), a diagonal fires BOTH, and each reverts INDEPENDENTLY.
 * `beforeId`/`afterId` are the rank neighbours WITHIN the target cell (same lane)
 * so a transition / in-cell reorder ranks against what the user sees, not across
 * lanes. Returns null if the card is missing from either side.
 */
export interface CellMove {
  originColId: string;
  originLaneKey: string;
  targetColId: string;
  targetLaneKey: string;
  columnChanged: boolean;
  laneChanged: boolean;
  beforeId?: string;
  afterId?: string;
  originIndexInCell: number;
  finalIndexInCell: number;
}

export function resolveCellMove(
  snapshot: BoardColumnDto[],
  current: BoardColumnDto[],
  cardId: string,
): CellMove | null {
  let originColId: string | null = null;
  let originCard: BoardCardDto | null = null;
  for (const col of snapshot) {
    const c = col.cards.find((x) => x.id === cardId);
    if (c) {
      originColId = col.id;
      originCard = c;
      break;
    }
  }
  let targetColId: string | null = null;
  let targetCard: BoardCardDto | null = null;
  for (const col of current) {
    const c = col.cards.find((x) => x.id === cardId);
    if (c) {
      targetColId = col.id;
      targetCard = c;
      break;
    }
  }
  if (!originColId || !originCard || !targetColId || !targetCard) return null;

  const originLaneKey = laneKeyOfCard(originCard);
  const targetLaneKey = laneKeyOfCard(targetCard);

  const originCell = (snapshot.find((c) => c.id === originColId)?.cards ?? []).filter(
    (c) => laneKeyOfCard(c) === originLaneKey,
  );
  const targetCell = (current.find((c) => c.id === targetColId)?.cards ?? []).filter(
    (c) => laneKeyOfCard(c) === targetLaneKey,
  );
  const finalIndexInCell = targetCell.findIndex((c) => c.id === cardId);

  return {
    originColId,
    originLaneKey,
    targetColId,
    targetLaneKey,
    columnChanged: originColId !== targetColId,
    laneChanged: originLaneKey !== targetLaneKey,
    beforeId: targetCell[finalIndexInCell - 1]?.id,
    afterId: targetCell[finalIndexInCell + 1]?.id,
    originIndexInCell: originCell.findIndex((c) => c.id === cardId),
    finalIndexInCell,
  };
}

/**
 * Resolve a swimlane drag from the dnd-kit `over` id at DROP time (Subtask 3.3.8).
 *
 * The swimlane board does NOT relocate the card live on `onDragOver` — doing so
 * looped: a `(column × lane)` cell has no fixed height, so moving the card in/out
 * resizes the source + target cells, dnd-kit re-measures, the closest-corners
 * `over` flips to the resized neighbour, `onDragOver` fires again, and the
 * relocate → resize → re-measure cycle never settles, throwing React's "Maximum
 * update depth exceeded" mid-drag (PRODECT_FINDINGS #61; the flat board escapes
 * this only because its columns are fixed-height internal scrollers with stable
 * rects). Instead the move is resolved ONCE here, on drop: move the card into the
 * `over`'s target cell against the pre-drag `snapshot`, then derive the structured
 * `CellMove` from `snapshot → relocated`. Returns `{ move, relocated }` (the move
 * descriptor + the optimistic board state to apply), or null when `over` resolves
 * to neither a cell nor a card.
 */
export function resolveSwimlaneDrop(
  snapshot: BoardColumnDto[],
  overId: string,
  cardId: string,
): { move: CellMove; relocated: BoardColumnDto[] } | null {
  const targetCell = cellOfOverId(snapshot, overId);
  if (!targetCell) return null;
  // Hovering a CARD (not the cell body / itself) inserts before it; a cell
  // droppable id resolves to an append.
  const overCardId = parseCellId(overId) !== null || overId === cardId ? null : overId;
  const relocated = relocateCardToCell(
    snapshot,
    cardId,
    targetCell.columnId,
    targetCell.laneKey,
    overCardId,
  );
  const move = resolveCellMove(snapshot, relocated, cardId);
  return move ? { move, relocated } : null;
}
