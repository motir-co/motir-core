import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// Pure board-move reducers (Subtask 3.2.4) — the optimistic-update core the
// dnd-kit wiring in BoardContainer drives, kept side-effect-free so the
// confirm-on-200 / revert-on-409·422 logic is unit-testable in isolation
// (the AC's "reducer in isolation"). The DnD layer computes a move from the
// drag, applies it optimistically with these functions, fires
// `POST /api/board/move`, and then either reconciles the returned card (200) or
// restores the pre-drag snapshot (any rejection). Nothing here touches the
// network or React — it's columns-in, columns-out.
//
// State shape mirrors the projection: an ordered `BoardColumnDto[]`, each column
// holding its loaded `cards` (display order) and a `totalCount` denominator that
// is independent of how many cards are loaded (finding #57). A cross-column move
// transfers one unit of `totalCount`; an in-column move leaves counts untouched.

/** The column id that currently holds `cardId`, or null if no column does. */
export function findCardColumnId(columns: BoardColumnDto[], cardId: string): string | null {
  for (const col of columns) {
    if (col.cards.some((c) => c.id === cardId)) return col.id;
  }
  return null;
}

/** The card with `cardId` from wherever it sits, or null. */
export function findCard(columns: BoardColumnDto[], cardId: string): BoardCardDto | null {
  for (const col of columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

/**
 * Resolve a dnd-kit `over` id to a column id. The id may be a COLUMN droppable
 * (dropping on the column body / an empty column) or a CARD sortable (dropping
 * on a card) — return the owning column either way, or null if it matches
 * neither.
 */
export function columnOfOverId(columns: BoardColumnDto[], overId: string): string | null {
  if (columns.some((col) => col.id === overId)) return overId;
  return findCardColumnId(columns, overId);
}

/** Index of `cardId` within `columnId`'s loaded cards, or -1. */
export function cardIndex(columns: BoardColumnDto[], columnId: string, cardId: string): number {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return -1;
  return col.cards.findIndex((c) => c.id === cardId);
}

/**
 * Move `cardId` to `toColumnId`, inserting at `toIndex` (clamped to the target's
 * bounds). Removes the card from its current column first, so this handles both
 * a cross-column move and an in-column reorder. Pure — returns a new array;
 * `totalCount` is untouched (see `transferCount`). No-op shape if the card or
 * the target column can't be found.
 */
export function relocateCard(
  columns: BoardColumnDto[],
  cardId: string,
  toColumnId: string,
  toIndex: number,
): BoardColumnDto[] {
  const card = findCard(columns, cardId);
  if (!card) return columns;
  if (!columns.some((c) => c.id === toColumnId)) return columns;

  return columns.map((col) => {
    // Drop the card out of every column (its current home).
    const without = col.cards.filter((c) => c.id !== cardId);
    if (col.id !== toColumnId) {
      return without.length === col.cards.length ? col : { ...col, cards: without };
    }
    // Insert into the target at the clamped index.
    const index = Math.max(0, Math.min(toIndex, without.length));
    const next = [...without.slice(0, index), card, ...without.slice(index)];
    return { ...col, cards: next };
  });
}

/**
 * Transfer one unit of `totalCount` from `fromColumnId` to `toColumnId` (the
 * count side of a cross-column move). No-op when the ids are equal (an in-column
 * reorder changes no counts). `totalCount` floors at 0.
 */
export function transferCount(
  columns: BoardColumnDto[],
  fromColumnId: string,
  toColumnId: string,
): BoardColumnDto[] {
  if (fromColumnId === toColumnId) return columns;
  return columns.map((col) => {
    if (col.id === fromColumnId) return { ...col, totalCount: Math.max(0, col.totalCount - 1) };
    if (col.id === toColumnId) return { ...col, totalCount: col.totalCount + 1 };
    return col;
  });
}

/**
 * Reconcile the optimistic state against the server's authoritative card (the
 * 200 path): swap the card object wherever it sits in place — keeping its array
 * position, so the user-visible order is unchanged — picking up the confirmed
 * `status` / `position` / `ready`. Counts were already adjusted optimistically.
 * No-op if the card id isn't present.
 */
export function reconcileCard(columns: BoardColumnDto[], card: BoardCardDto): BoardColumnDto[] {
  if (!columns.some((col) => col.cards.some((c) => c.id === card.id))) return columns;
  return columns.map((col) => {
    if (!col.cards.some((c) => c.id === card.id)) return col;
    return { ...col, cards: col.cards.map((c) => (c.id === card.id ? card : c)) };
  });
}

/**
 * The rank neighbours bracketing `cardId`'s slot in `columnId` — `beforeId` is
 * the card immediately ABOVE, `afterId` the card immediately BELOW (the
 * `MoveCardTarget` contract the move API resolves the new `position` between).
 * Omits whichever side doesn't exist (top / bottom / only card).
 */
export function neighborsOf(
  columns: BoardColumnDto[],
  columnId: string,
  cardId: string,
): { beforeId?: string; afterId?: string } {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return {};
  const i = col.cards.findIndex((c) => c.id === cardId);
  if (i === -1) return {};
  const before = col.cards[i - 1];
  const after = col.cards[i + 1];
  return {
    beforeId: before?.id,
    afterId: after?.id,
  };
}

/**
 * Append a lane's NEXT PAGE (MOTIR-10535) to the column it belongs to: its cards
 * after the ones already loaded, its `cursor` replacing the spent one, and its
 * `totalCount` (the server's current count) replacing the old denominator. A
 * card already on the board in ANY column is skipped — one dragged into this
 * lane after its first page loaded is already shown where it was dropped, and
 * one the page names in this lane but the board shows elsewhere was moved there
 * locally, which stays authoritative until the next projection. Pure; a page
 * for a column no longer on the board changes nothing.
 */
export function appendColumnPage(
  columns: BoardColumnDto[],
  page: { columnId: string; cards: BoardCardDto[]; cursor: string | null; totalCount: number },
): BoardColumnDto[] {
  if (!columns.some((c) => c.id === page.columnId)) return columns;
  const onBoard = new Set(columns.flatMap((c) => c.cards.map((card) => card.id)));
  const fresh = page.cards.filter((card) => !onBoard.has(card.id));
  return columns.map((col) =>
    col.id === page.columnId
      ? {
          ...col,
          cards: [...col.cards, ...fresh],
          cursor: page.cursor,
          totalCount: page.totalCount,
        }
      : col,
  );
}
