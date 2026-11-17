'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { BoardTypeDto, StoredBoardFilterDto } from '@/lib/dto/boards';

// The board's own stored filter, shared with the page's header filter
// (MOTIR-11565). The stored filter is known only from the board read, which the
// client `BoardContainer` makes; the header filter controls and the applied bar
// are separate client subtrees of the same page (the toolbar and the row under
// it). So the board PUBLISHES what it read here, and the header reads it to
// start as the board's filter, compare against it and save to it — the same
// page-scoped provider pattern as the advanced-popover and saved-filter session
// contexts, with no second read of the board.
//
// `requestedBoardId` is the `?board=` selection the read was made for, so a
// header reading under a different selection (a board switch whose read has
// not answered yet) gets `undefined` — not yet known — rather than the previous
// board's filter. `reloadBoard` asks the board to read again after a write that
// does not change the URL.

export interface PublishedBoardFilter {
  /** The `?board=` selection the board read was made for (null = default). */
  requestedBoardId: string | null;
  boardId: string;
  boardType: BoardTypeDto;
  storedFilter: StoredBoardFilterDto | null;
}

export interface BoardHeaderFilterState {
  published: PublishedBoardFilter | null;
  publish: (next: PublishedBoardFilter | null) => void;
  /** A monotonic tick the board watches to read itself again. */
  reloadTick: number;
  reloadBoard: () => void;
}

const BoardHeaderFilterContext = createContext<BoardHeaderFilterState | null>(null);

export function BoardHeaderFilterProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<PublishedBoardFilter | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reloadBoard = useCallback(() => setReloadTick((n) => n + 1), []);
  const value = useMemo(
    () => ({ published, publish: setPublished, reloadTick, reloadBoard }),
    [published, reloadTick, reloadBoard],
  );
  return (
    <BoardHeaderFilterContext.Provider value={value}>{children}</BoardHeaderFilterContext.Provider>
  );
}

/** The raw context — null outside a provider (an isolated component render). */
export function useBoardHeaderFilterContext(): BoardHeaderFilterState | null {
  return useContext(BoardHeaderFilterContext);
}

export interface BoardStoredFilterRead {
  /** `undefined` until the board read for this selection has answered; `null`
   * when the board has no stored filter. */
  storedFilter: StoredBoardFilterDto | null | undefined;
  /** The resolved board id (the default board's, when no `?board=`). */
  boardId: string | null;
  boardType: BoardTypeDto | null;
  reloadBoard: () => void;
}

/** The stored filter of the board the page's `?board=` selection shows. */
export function useBoardStoredFilter(selectedBoardId?: string): BoardStoredFilterRead {
  const ctx = useContext(BoardHeaderFilterContext);
  const published = ctx?.published ?? null;
  const matches = published !== null && published.requestedBoardId === (selectedBoardId ?? null);
  return {
    storedFilter: matches ? published.storedFilter : undefined,
    boardId: matches ? published.boardId : null,
    boardType: matches ? published.boardType : null,
    reloadBoard: ctx?.reloadBoard ?? noop,
  };
}

function noop() {}
