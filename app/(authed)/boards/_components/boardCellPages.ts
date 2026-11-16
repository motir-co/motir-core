import type { BoardCardDto, BoardCellPageDto, BoardSwimlaneGroupByDto } from '@/lib/dto/boards';
import { cellId } from './boardSwimlanes';

// The grouped board's per-cell page state (MOTIR-11448) — pure values in, values
// out, no React and no network, in the same contract as `boardSwimlanes.ts`. A
// grouped board pages each (lane × column) CELL on its own: a lane's first pages
// land together when the lane comes into view (`applyLanePage`), and each later
// page lands in exactly one cell (`appendCellPage`). `useBoardCellPages` is the
// hook that drives these reducers; everything a reader sees is built from them.
//
// Two facts carry the merge rules:
//   - A cell is addressed by the shipped `cellId(columnId, laneKey)` — the same
//     string the cell's droppable uses — so a page, a drop and a retry all name
//     one cell the same way.
//   - Every reducer copies the map and replaces ONLY the cells it touches, so
//     "no other cell changed" is reference identity, not a claim.
//
// The state carries the READ IDENTITY it was built for (board, group-by, filter).
// A read against a different identity sees every cell empty, a "mark" reducer
// against a different identity starts a fresh map, and a RESPONSE against a
// different identity is dropped — so a response that resolves after the toolbar
// filter changed is never written into the new board's cells, and no effect has
// to reset anything.

/**
 * Where one cell's paging stands. `idle` reads two ways, told apart by
 * `totalCount`: null = not loaded yet; a number with a cursor = loaded, more
 * available. `complete` = nothing left to ask for (a null cursor).
 */
export type CellPageState = 'idle' | 'loading' | 'error' | 'complete';

/** One (lane × column) cell's loaded cards and where its paging stands. */
export interface CellPage {
  cards: BoardCardDto[];
  /** The cell's full total, from its last page; null until a page lands. */
  totalCount: number | null;
  /** The next page's cursor; null when exhausted or not loaded yet. */
  cursor: string | null;
  state: CellPageState;
}

/** What a grouped board's cells were read against. */
export interface CellReadIdentity {
  boardId: string;
  groupBy: BoardSwimlaneGroupByDto;
  filterParam: string;
}

/** Every cell's page, keyed by `cellId`, for one read identity. */
export interface CellPages {
  readKey: string;
  cells: Readonly<Record<string, CellPage>>;
}

/** A cell's loaded / total / whether it has a further page. */
export interface CellSummary {
  loaded: number;
  /** The cell's full total, or null before its first page. */
  total: number | null;
  hasMore: boolean;
}

/** The cell no page has reached yet. Frozen: every unloaded cell reads it. */
export const EMPTY_CELL_PAGE: CellPage = Object.freeze({
  cards: Object.freeze([]) as unknown as BoardCardDto[],
  totalCount: null,
  cursor: null,
  state: 'idle',
}) as CellPage;

/** The stable string a read identity is compared by. */
export function cellReadKey(identity: CellReadIdentity): string {
  return JSON.stringify([identity.boardId, identity.groupBy, identity.filterParam]);
}

/** A map with no cell loaded, for `readKey`. */
export function emptyCellPages(readKey: string): CellPages {
  return { readKey, cells: {} };
}

/** The cell's page under the CURRENT identity — empty when the map is another's. */
export function cellPageOf(
  pages: CellPages,
  readKey: string,
  columnId: string,
  laneKey: string,
): CellPage {
  if (pages.readKey !== readKey) return EMPTY_CELL_PAGE;
  return pages.cells[cellId(columnId, laneKey)] ?? EMPTY_CELL_PAGE;
}

/** What a cell holds, its total, and whether a further page exists. */
export function cellSummary(page: CellPage): CellSummary {
  return { loaded: page.cards.length, total: page.totalCount, hasMore: page.cursor !== null };
}

/** The map to write into for `readKey`: this one, or a fresh one for a new identity. */
function base(pages: CellPages, readKey: string): CellPages {
  return pages.readKey === readKey ? pages : emptyCellPages(readKey);
}

function withCells(pages: CellPages, changes: Record<string, CellPage>): CellPages {
  return { readKey: pages.readKey, cells: { ...pages.cells, ...changes } };
}

function setState(page: CellPage, state: CellPageState): CellPage {
  return page.state === state ? page : { ...page, state };
}

/** The settled state a page's cursor implies. */
function settled(cursor: string | null): CellPageState {
  return cursor === null ? 'complete' : 'idle';
}

/** Mark the named cells `loading`, keeping the cards they already hold. */
export function markCellsLoading(
  pages: CellPages,
  readKey: string,
  cells: ReadonlyArray<{ columnId: string; laneKey: string }>,
): CellPages {
  const into = base(pages, readKey);
  const changes: Record<string, CellPage> = {};
  for (const { columnId, laneKey } of cells) {
    const id = cellId(columnId, laneKey);
    changes[id] = setState(into.cells[id] ?? EMPTY_CELL_PAGE, 'loading');
  }
  return withCells(into, changes);
}

/** Mark every cell of `laneKey` across `columnIds` loading. */
export function markLaneLoading(
  pages: CellPages,
  readKey: string,
  laneKey: string,
  columnIds: readonly string[],
): CellPages {
  return markCellsLoading(
    pages,
    readKey,
    columnIds.map((columnId) => ({ columnId, laneKey })),
  );
}

/**
 * Mark the named cells `error`, leaving their cards, total and cursor standing so
 * a failed page never takes back what a cell already showed. A response for an
 * identity the map no longer holds is dropped.
 */
export function markCellsError(
  pages: CellPages,
  readKey: string,
  cells: ReadonlyArray<{ columnId: string; laneKey: string }>,
): CellPages {
  if (pages.readKey !== readKey) return pages;
  const changes: Record<string, CellPage> = {};
  for (const { columnId, laneKey } of cells) {
    const id = cellId(columnId, laneKey);
    changes[id] = setState(pages.cells[id] ?? EMPTY_CELL_PAGE, 'error');
  }
  return withCells(pages, changes);
}

/** Mark every cell of `laneKey` across `columnIds` failed. */
export function markLaneError(
  pages: CellPages,
  readKey: string,
  laneKey: string,
  columnIds: readonly string[],
): CellPages {
  return markCellsError(
    pages,
    readKey,
    columnIds.map((columnId) => ({ columnId, laneKey })),
  );
}

/**
 * Land a lane's FIRST pages: each named cell holds exactly that page's cards,
 * total and cursor. A response for an identity the map no longer holds is
 * dropped.
 */
export function applyLanePage(
  pages: CellPages,
  readKey: string,
  cells: readonly BoardCellPageDto[],
): CellPages {
  if (pages.readKey !== readKey) return pages;
  const changes: Record<string, CellPage> = {};
  for (const cell of cells) {
    changes[cellId(cell.columnId, cell.laneKey)] = {
      cards: cell.cards,
      totalCount: cell.totalCount,
      cursor: cell.cursor,
      state: settled(cell.cursor),
    };
  }
  return withCells(pages, changes);
}

/**
 * Append ONE cell's page to that cell: its cards after the ones it holds, in the
 * order it already shows, with any card it already holds skipped (a card can
 * appear in two consecutive pages when it moved between the two reads). The
 * total and cursor become the page's. A response for an identity the map no
 * longer holds is dropped.
 */
export function appendCellPage(
  pages: CellPages,
  readKey: string,
  page: BoardCellPageDto,
): CellPages {
  if (pages.readKey !== readKey) return pages;
  const id = cellId(page.columnId, page.laneKey);
  const prev = pages.cells[id] ?? EMPTY_CELL_PAGE;
  const held = new Set(prev.cards.map((c) => c.id));
  const fresh = page.cards.filter((c) => !held.has(c.id));
  return withCells(pages, {
    [id]: {
      cards: fresh.length === 0 ? prev.cards : [...prev.cards, ...fresh],
      totalCount: page.totalCount,
      cursor: page.cursor,
      state: settled(page.cursor),
    },
  });
}
