import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { CellPage, CellPages } from './boardCellPages';

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

/**
 * The delimiter of a PLACEMENT id (MOTIR-11585) — one rendering of a card in one
 * lane, `<cardId>@@<laneKey>`. Under a multi-value grouping (label, component,
 * repository) the same card renders in each of its values' lanes, and dnd-kit
 * needs every sortable's id to be unique, so each rendering's drag id carries
 * its lane. It is distinct from {@link LANE_CELL_SEP}, so a placement id is never
 * read as a cell id. Under every other grouping the drag id is the card's id.
 */
export const PLACEMENT_SEP = '@@';

/** One card's rendering in one lane, as a drag id. */
export function placementId(cardId: string, laneKey: string): string {
  return `${cardId}${PLACEMENT_SEP}${laneKey}`;
}

/** A drag id's card, and its lane when it is a placement id (else null). */
export function splitDragId(id: string): { cardId: string; laneKey: string | null } {
  const i = id.indexOf(PLACEMENT_SEP);
  if (i === -1) return { cardId: id, laneKey: null };
  return { cardId: id.slice(0, i), laneKey: id.slice(i + PLACEMENT_SEP.length) };
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

/** A `(column × lane)` cell's address. */
export interface CellAddress {
  columnId: string;
  laneKey: string;
}

/** The cell whose loaded cards hold the card a drag id names, or null when no
 *  cell does. A PLACEMENT id (MOTIR-11585) names its lane, so only that lane's
 *  cells answer; a plain card id answers the first cell holding the card. */
export function findCardCell(pages: CellPages, dragId: string): CellAddress | null {
  const { cardId, laneKey } = splitDragId(dragId);
  for (const [id, page] of Object.entries(pages.cells)) {
    if (!page.cards.some((c) => c.id === cardId)) continue;
    const at = parseCellId(id);
    if (laneKey === null || at?.laneKey === laneKey) return at;
  }
  return null;
}

/** Every cell holding the card `cardId` — one per lane it renders in. */
export function findCardCells(pages: CellPages, cardId: string): CellAddress[] {
  const out: CellAddress[] = [];
  for (const [id, page] of Object.entries(pages.cells)) {
    if (!page.cards.some((c) => c.id === cardId)) continue;
    const at = parseCellId(id);
    if (at) out.push(at);
  }
  return out;
}

/** The loaded card a drag id names, from whichever cell holds it. */
export function findCardInCells(pages: CellPages, dragId: string): BoardCardDto | null {
  const { cardId } = splitDragId(dragId);
  for (const page of Object.values(pages.cells)) {
    const card = page.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

/** Every loaded card of a grouped board, cell by cell. */
export function cardsInCells(pages: CellPages): BoardCardDto[] {
  return Object.values(pages.cells).flatMap((page) => page.cards);
}

/**
 * Resolve a dnd-kit `over` id (in swimlane mode) to its target cell, from the
 * per-cell state (MOTIR-11452 — a grouped projection's columns hold no cards).
 * The id may be a CELL droppable (`columnId::laneKey` — the cell body or an empty
 * cell) or a CARD sortable (resolve to the cell whose loaded cards hold it).
 * Returns null if it matches neither.
 */
export function cellOfOverId(pages: CellPages, overId: string): CellAddress | null {
  return parseCellId(overId) ?? findCardCell(pages, overId);
}

const NO_CARDS: BoardCardDto[] = [];

function pageAt(pages: CellPages, id: string): CellPage {
  return pages.cells[id] ?? { cards: NO_CARDS, totalCount: null, cursor: null, state: 'idle' };
}

function insertBefore(
  cards: BoardCardDto[],
  card: BoardCardDto,
  overCardId: string | null,
): BoardCardDto[] {
  const at = overCardId ? cards.findIndex((c) => c.id === overCardId) : -1;
  const index = at === -1 ? cards.length : at;
  return [...cards.slice(0, index), card, ...cards.slice(index)];
}

/**
 * Move `cardId` out of the `from` cell into the `to` cell — the whole of a
 * swimlane move on the per-cell state, and (with the cells swapped) each axis'
 * revert. Inserts it just before `overCardId` when that card is in the target
 * (a drop on a card), else appends (a drop on the cell body); a drop on itself
 * changes nothing. Each cell's
 * `totalCount` moves by one in each direction (a total no page has named yet
 * stays null); the card is stamped with the target lane's key; every CURSOR is
 * left as the read put it — a keyset cursor is a value, not a row, so a card
 * leaving from behind it skips nothing. A same-cell call reorders with no count
 * change. Only the two cells change; a missing card returns `pages` itself.
 */
export function moveCardBetweenCells(
  pages: CellPages,
  move: { cardId: string; from: CellAddress; to: CellAddress; overCardId: string | null },
): CellPages {
  const fromId = cellId(move.from.columnId, move.from.laneKey);
  const toId = cellId(move.to.columnId, move.to.laneKey);
  const source = pageAt(pages, fromId);
  const card = source.cards.find((c) => c.id === move.cardId);
  if (!card) return pages;
  // Dropped on itself: it stays exactly where it is.
  if (fromId === toId && move.overCardId === move.cardId) return pages;
  const without = source.cards.filter((c) => c.id !== move.cardId);
  const overCardId = move.overCardId === move.cardId ? null : move.overCardId;

  if (fromId === toId) {
    const cards = insertBefore(without, card, overCardId);
    if (cards.every((c, i) => c === source.cards[i])) return pages;
    return { readKey: pages.readKey, cells: { ...pages.cells, [fromId]: { ...source, cards } } };
  }

  const target = pageAt(pages, toId);
  const stamped: BoardCardDto =
    card.swimlaneKey === move.to.laneKey ? card : { ...card, swimlaneKey: move.to.laneKey };
  return {
    readKey: pages.readKey,
    cells: {
      ...pages.cells,
      [fromId]: {
        ...source,
        cards: without,
        totalCount: source.totalCount === null ? null : Math.max(0, source.totalCount - 1),
      },
      [toId]: {
        ...target,
        cards: insertBefore(
          target.cards.filter((c) => c.id !== move.cardId),
          stamped,
          overCardId,
        ),
        totalCount: target.totalCount === null ? null : target.totalCount + 1,
      },
    },
  };
}

/**
 * Take the server's confirmed card (status, position, ready …) into every cell
 * that holds it — one, or one per lane under a multi-value grouping — keeping
 * each cell's lane key, which the reassign axis owns. No-op when no cell holds it.
 */
export function reconcileCellCard(pages: CellPages, card: BoardCardDto): CellPages {
  const at = findCardCells(pages, card.id);
  if (at.length === 0) return pages;
  const cells = { ...pages.cells };
  for (const { columnId, laneKey } of at) {
    const id = cellId(columnId, laneKey);
    const page = pageAt(pages, id);
    cells[id] = {
      ...page,
      cards: page.cards.map((c) => (c.id === card.id ? { ...card, swimlaneKey: laneKey } : c)),
    };
  }
  return { readKey: pages.readKey, cells };
}

/**
 * Move the card's OTHER renderings to the column its dragged rendering moved to
 * (MOTIR-11585). Under a multi-value grouping one card sits in several lanes;
 * a column move is one transition, so every lane's copy follows it — each
 * appended to its lane's target cell, since only the dragged lane has a drop
 * position. `exceptLaneKey` is the lane the drag itself moved. Renderings not in
 * `fromColumnId` are left alone. Also each axis' revert, with the columns swapped.
 */
export function moveCardColumnInOtherLanes(
  pages: CellPages,
  move: { cardId: string; fromColumnId: string; toColumnId: string; exceptLaneKey: string },
): CellPages {
  let next = pages;
  for (const at of findCardCells(pages, move.cardId)) {
    if (at.laneKey === move.exceptLaneKey || at.columnId !== move.fromColumnId) continue;
    next = moveCardBetweenCells(next, {
      cardId: move.cardId,
      from: at,
      to: { columnId: move.toColumnId, laneKey: at.laneKey },
      overCardId: null,
    });
  }
  return next;
}

/**
 * The issue-field patch a cross-lane drop into `laneKey` produces, under the
 * active group-by — fed to the EXISTING Story-2.5 `updateIssueAction` (NOT a new
 * backend, NOT the board/move endpoint):
 *   - `assignee` → `{ assigneeId }` (the catch-all lane clears it → unassign)
 *   - `priority` → `{ priority }` (priority has no catch-all — every card has one)
 *   - `epic`     → `{ parentId }` (reparent to that epic; the catch-all clears it)
 *   - `type` / `difficulty` / `executor` → that field (the catch-all clears it)
 * The legality of an epic reparent is enforced by the existing endpoint (the
 * kind-parent matrix); an illegal one rejects and the lane axis snaps back.
 */
export function reassignPatchForLane(
  groupBy: BoardSwimlaneGroupByDto,
  laneKey: string,
): LaneReassignPatch {
  const isCatchAll = laneKey === BOARD_SWIMLANE_NO_VALUE;
  switch (groupBy) {
    case 'assignee':
      return { assigneeId: isCatchAll ? null : laneKey };
    case 'priority':
      return { priority: laneKey as WorkItemPriorityDto };
    case 'epic':
      return { parentId: isCatchAll ? null : laneKey };
    // MOTIR-11585 — the leaf-only fields. The catch-all clears the field; the
    // update's own leaf-only rule refuses a value on an epic or a story, and the
    // lane axis snaps back with the reassign toast.
    case 'type':
      return { type: isCatchAll ? null : (laneKey as WorkItemTypeDto) };
    case 'difficulty':
      return { difficulty: isCatchAll ? null : (laneKey as WorkItemDifficultyDto) };
    case 'executor':
      return { executor: isCatchAll ? null : (laneKey as ExecutorDto) };
    default:
      return {};
  }
}

/** The field write a cross-lane drop makes, through the work-item update. */
export interface LaneReassignPatch {
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  parentId?: string | null;
  type?: WorkItemTypeDto | null;
  difficulty?: WorkItemDifficultyDto | null;
  executor?: ExecutorDto | null;
}

/**
 * The (column, lane) axes a finished swimlane drag changed — resolved from the
 * pre-drag cell state (origin) and the reconciled one (target). Drives
 * BoardContainer's drop handling: a `columnChanged` fires the workflow
 * transition (`/board/move`), a `laneChanged` fires the field reassign
 * (`updateIssueAction`), a diagonal fires BOTH, and each reverts INDEPENDENTLY.
 * `beforeId`/`afterId` are the rank neighbours WITHIN the target cell so a
 * transition / in-cell reorder ranks against what the user sees, not across
 * lanes; `originNextId` is the card that followed it in the origin cell, which a
 * revert re-inserts it before. Returns null if the card is missing from either side.
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
  originNextId: string | null;
  originIndexInCell: number;
  finalIndexInCell: number;
}

export function resolveCellMove(
  snapshot: CellPages,
  current: CellPages,
  dragId: string,
  // Where to look for the card AFTER the move — a placement id names a lane, so
  // a cross-lane move's rendering is found under the target lane's id.
  targetDragId: string = dragId,
): CellMove | null {
  const origin = findCardCell(snapshot, dragId);
  const target = findCardCell(current, targetDragId);
  if (!origin || !target) return null;
  const { cardId } = splitDragId(dragId);
  const originCell = pageAt(snapshot, cellId(origin.columnId, origin.laneKey)).cards;
  const targetCell = pageAt(current, cellId(target.columnId, target.laneKey)).cards;
  const originIndexInCell = originCell.findIndex((c) => c.id === cardId);
  const finalIndexInCell = targetCell.findIndex((c) => c.id === cardId);
  return {
    originColId: origin.columnId,
    originLaneKey: origin.laneKey,
    targetColId: target.columnId,
    targetLaneKey: target.laneKey,
    columnChanged: origin.columnId !== target.columnId,
    laneChanged: origin.laneKey !== target.laneKey,
    beforeId: targetCell[finalIndexInCell - 1]?.id,
    afterId: targetCell[finalIndexInCell + 1]?.id,
    originNextId: originCell[originIndexInCell + 1]?.id ?? null,
    originIndexInCell,
    finalIndexInCell,
  };
}

/** The card a drop on `overId` inserts before: the card it hovered, else null —
 *  an append on the cell body. The dragged card itself is returned as itself,
 *  which `moveCardBetweenCells` reads as "stays where it is". */
export function overCardIdOf(overId: string): string | null {
  return parseCellId(overId) !== null ? null : splitDragId(overId).cardId;
}

/**
 * Resolve a swimlane drag from the dnd-kit `over` id at DROP time (Subtask 3.3.8,
 * re-pointed at the per-cell state by MOTIR-11452).
 *
 * The swimlane board does NOT relocate the card live on `onDragOver` — doing so
 * looped: a `(column × lane)` cell has no fixed height, so moving the card in/out
 * resizes the source + target cells, dnd-kit re-measures, the closest-corners
 * `over` flips to the resized neighbour, `onDragOver` fires again, and the
 * relocate → resize → re-measure cycle never settles, throwing React's "Maximum
 * update depth exceeded" mid-drag (PRODECT_FINDINGS #61). Instead the move is
 * resolved ONCE here, on drop: move the card into the `over`'s target cell
 * against the pre-drag `snapshot`, then derive the structured `CellMove` from
 * `snapshot → cells`. Returns `{ move, cells }` (the move descriptor + the
 * reconciled cell state to apply), or null when `over` resolves to neither a cell
 * nor a loaded card, or the dragged card is in no cell.
 */
export function resolveSwimlaneDrop(
  snapshot: CellPages,
  overId: string,
  dragId: string,
): { move: CellMove; cells: CellPages } | null {
  const from = findCardCell(snapshot, dragId);
  const to = cellOfOverId(snapshot, overId);
  if (!from || !to) return null;
  const cells = moveCardBetweenCells(snapshot, {
    cardId: splitDragId(dragId).cardId,
    from,
    to,
    overCardId: overCardIdOf(overId),
  });
  // A placement id names its ORIGIN lane; after a cross-lane drop the card's
  // rendering is in the target lane, so the move is resolved by that lane.
  const { cardId, laneKey } = splitDragId(dragId);
  const placed = laneKey === null ? dragId : placementId(cardId, to.laneKey);
  const move = resolveCellMove(snapshot, cells, dragId, placed);
  return move ? { move, cells } : null;
}
