'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCollapsedLanes } from '@/lib/hooks/useCollapsedLanes';
import type {
  BoardCellPageDto,
  BoardLanePageDto,
  BoardPlanHoldSummaryDto,
  BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import {
  appendCellPage,
  applyCells as applyCellsTo,
  applyLanePage,
  cellPageOf,
  cellReadKey,
  cellSummary as summarize,
  emptyCellPages,
  markCellsError,
  markCellsLoading,
  markLaneError,
  markLaneLoading,
  type CellPage,
  type CellPages,
  type CellSummary,
} from './boardCellPages';
import { cellId } from './boardSwimlanes';

// useBoardCellPages (MOTIR-11448) — the grouped board's per-cell paging policy
// around the pure `boardCellPages.ts` reducers. It renders nothing:
//
//   - A lane's cells fill with ONE request (`GET /api/board/lanes/[laneKey]/cells`)
//     when the lane is expanded and first comes into view. One board-wide
//     IntersectionObserver against the viewport (the grid has no vertical
//     scroller of its own — `useLaneSentinel` makes the same choice) watches each
//     lane's cell row through `laneRef(laneKey)`; only an entry reporting
//     `isIntersecting` asks, so a board of 200 lanes asks only for the lanes in
//     view. A lane is asked for once per read identity: scrolling it out and back
//     asks nothing, and a lane whose page failed is re-asked only by an explicit
//     call, never by scrolling past it.
//   - A cell's next page is an explicit `loadCell` and nothing else (no per-cell
//     sentinel, no auto-fill loop), read from the shipped column page door with
//     the `lane` param — and with no `cursor` it answers that cell's FIRST page,
//     so a retry on a cell that never loaded re-asks that cell alone.
//   - One page in flight per cell, keyed by `cellId` (a ref, read synchronously,
//     so two calls in one frame cannot double-fetch — the column pager's guard).
//   - The read identity (board, group-by, filter) lives inside the state, so a
//     changed identity reads empty at once and a late response is dropped at the
//     reducer instead of written into the new identity's cells.
//   - `applyCells(next)` is the one write door a reconciliation lands through: it
//     replaces the whole map and decides nothing about what moved.

/** The paging API a grouped board's grid reads its cells from. */
export interface BoardCellPagesApi {
  /** The read identity the current cells answer to (for `applyCells`). */
  readKey: string;
  /** The whole per-cell map — what a reconciliation builds its `next` from. */
  pages: CellPages;
  cellState: (columnId: string, laneKey: string) => CellPage;
  cellSummary: (columnId: string, laneKey: string) => CellSummary;
  /**
   * Ask for this cell's next page (its first, when it holds no cursor). With
   * `after`, the cell reads as loading and holds its one in-flight slot at once,
   * but the read is sent only once `after` settles — so a page asked for by a
   * drop is read after the drop's own writes, never racing them.
   */
  loadCell: (columnId: string, laneKey: string, after?: Promise<unknown>) => void;
  /** Re-ask a failed cell's page — that cell alone, never its whole lane. */
  retryCell: (columnId: string, laneKey: string) => void;
  /** Ask for an expanded lane's first pages (once; re-asks a failed lane). */
  loadedLane: (laneKey: string) => void;
  /** Callback ref for the element whose coming into view loads the lane. */
  laneRef: (laneKey: string) => (el: HTMLElement | null) => (() => void) | void;
  /**
   * Replace the whole per-cell map; dropped when built for another identity.
   * An updater is handed the LATEST map, so a reconciliation built from it never
   * discards a page that merged after the caller last rendered.
   */
  applyCells: (next: CellPages | ((current: CellPages) => CellPages)) => void;
}

type PlanHolds = Record<string, BoardPlanHoldSummaryDto>;

type LaneStatus = 'loading' | 'loaded' | 'error';

const SEP = '\u0000';

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`page ${res.status}`);
  return (await res.json()) as T;
}

export function useBoardCellPages({
  boardId,
  groupBy,
  filterParam = '',
  columnIds,
  onPlanHolds,
}: {
  boardId: string;
  groupBy: BoardSwimlaneGroupByDto;
  /** The toolbar filter the projection was read with; every page uses it too. */
  filterParam?: string;
  /** The board's columns, in order — the cells a lane page fills. */
  columnIds: readonly string[];
  /** Merges each response's plan holds into the board's. */
  onPlanHolds: (holds: PlanHolds) => void;
}): BoardCellPagesApi {
  const grouped = groupBy !== 'none';
  const readKey = useMemo(
    () => cellReadKey({ boardId, groupBy, filterParam }),
    [boardId, groupBy, filterParam],
  );
  const [pages, setPages] = useState<CellPages>(() => emptyCellPages(readKey));
  const { collapsed } = useCollapsedLanes(boardId);

  // Synchronous mirrors for the request guards — written at commit (a ref write
  // during render is forbidden), read by event handlers and observer callbacks.
  const pagesRef = useRef(pages);
  const collapsedRef = useRef(collapsed);
  const columnIdsRef = useRef(columnIds);
  const onPlanHoldsRef = useRef(onPlanHolds);
  useLayoutEffect(() => {
    pagesRef.current = pages;
    collapsedRef.current = collapsed;
    columnIdsRef.current = columnIds;
    onPlanHoldsRef.current = onPlanHolds;
  });

  // Keyed by read identity, so a new identity starts with nothing requested.
  const inFlightRef = useRef(new Set<string>());
  const laneStatusRef = useRef(new Map<string, LaneStatus>());

  const requestLane = useCallback(
    (laneKey: string, origin: 'view' | 'explicit') => {
      if (!grouped || collapsedRef.current.has(laneKey)) return;
      const laneId = readKey + SEP + laneKey;
      const status = laneStatusRef.current.get(laneId);
      if (status === 'loading' || status === 'loaded') return;
      // A failed lane is re-asked by a person's explicit call, never by a scroll.
      if (status === 'error' && origin === 'view') return;
      const cols = columnIdsRef.current;
      const flightIds = cols.map((c) => readKey + SEP + cellId(c, laneKey));
      if (flightIds.some((id) => inFlightRef.current.has(id))) return;

      for (const id of flightIds) inFlightRef.current.add(id);
      laneStatusRef.current.set(laneId, 'loading');
      setPages((prev) => markLaneLoading(prev, readKey, laneKey, cols));
      const params = new URLSearchParams({ boardId });
      if (filterParam) params.set('filter', filterParam);
      void readJson<BoardLanePageDto>(
        `/api/board/lanes/${encodeURIComponent(laneKey)}/cells?${params.toString()}`,
      )
        .then((page) => {
          laneStatusRef.current.set(laneId, 'loaded');
          setPages((prev) => applyLanePage(prev, readKey, page.cells));
          const holds: PlanHolds = {};
          for (const cell of page.cells) Object.assign(holds, cell.planHolds);
          onPlanHoldsRef.current(holds);
        })
        .catch(() => {
          laneStatusRef.current.set(laneId, 'error');
          setPages((prev) => markLaneError(prev, readKey, laneKey, cols));
        })
        .finally(() => {
          for (const id of flightIds) inFlightRef.current.delete(id);
        });
    },
    [grouped, readKey, boardId, filterParam],
  );

  const loadCell = useCallback(
    (columnId: string, laneKey: string, after?: Promise<unknown>) => {
      if (!grouped) return;
      const page = cellPageOf(pagesRef.current, readKey, columnId, laneKey);
      // Exhausted: a page landed and named no next one.
      if (page.state === 'complete' || (page.totalCount !== null && page.cursor === null)) return;
      const flightId = readKey + SEP + cellId(columnId, laneKey);
      if (inFlightRef.current.has(flightId)) return;

      inFlightRef.current.add(flightId);
      const cell = [{ columnId, laneKey }];
      setPages((prev) => markCellsLoading(prev, readKey, cell));
      const params = new URLSearchParams({ boardId, lane: laneKey });
      if (page.cursor) params.set('cursor', page.cursor);
      if (filterParam) params.set('filter', filterParam);
      const url = `/api/board/columns/${columnId}/cards?${params.toString()}`;
      // `after` only orders the read; its own outcome is its caller's to handle.
      // Without it the request starts now, in the same tick as the click.
      const read = after
        ? Promise.allSettled([after]).then(() => readJson<BoardCellPageDto>(url))
        : readJson<BoardCellPageDto>(url);
      void read
        .then((next) => {
          setPages((prev) => appendCellPage(prev, readKey, next));
          onPlanHoldsRef.current(next.planHolds);
        })
        .catch(() => setPages((prev) => markCellsError(prev, readKey, cell)))
        .finally(() => inFlightRef.current.delete(flightId));
    },
    [grouped, readKey, boardId, filterParam],
  );

  const loadedLane = useCallback(
    (laneKey: string) => requestLane(laneKey, 'explicit'),
    [requestLane],
  );

  // The observer's callback reads the latest `requestLane` (a new closure must
  // not rebuild the observer: a rebuild re-reports every lane in view).
  const requestLaneRef = useRef(requestLane);
  useLayoutEffect(() => {
    requestLaneRef.current = requestLane;
  }, [requestLane]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const laneOfElementRef = useRef(new Map<Element, string>());
  const observer = useCallback((): IntersectionObserver | null => {
    if (observerRef.current) return observerRef.current;
    if (typeof IntersectionObserver === 'undefined') return null;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const laneKey = laneOfElementRef.current.get(entry.target);
          if (laneKey !== undefined) requestLaneRef.current(laneKey, 'view');
        }
      },
      // A little ahead of the fold, so a lane's cards are usually in by the time
      // the reader reaches it.
      { root: null, rootMargin: '0px 0px 200px 0px' },
    );
    return observerRef.current;
  }, []);

  // One stable callback ref per lane, so a re-render does not re-observe.
  const laneRefs = useRef(new Map<string, (el: HTMLElement | null) => (() => void) | void>());
  const laneRef = useCallback(
    (laneKey: string) => {
      let ref = laneRefs.current.get(laneKey);
      if (!ref) {
        ref = (el: HTMLElement | null) => {
          const obs = el ? observer() : null;
          if (!el || !obs) return;
          laneOfElementRef.current.set(el, laneKey);
          obs.observe(el);
          return () => {
            obs.unobserve(el);
            laneOfElementRef.current.delete(el);
          };
        };
        laneRefs.current.set(laneKey, ref);
      }
      return ref;
    },
    [observer],
  );

  // A changed read identity starts with nothing requested, but an observer
  // reports CHANGES only: a lane already in view would never ask again. Observing
  // each element afresh makes the observer report it once more.
  const observedKeyRef = useRef(readKey);
  useEffect(() => {
    if (observedKeyRef.current === readKey) return;
    observedKeyRef.current = readKey;
    const obs = observerRef.current;
    if (!obs) return;
    for (const el of laneOfElementRef.current.keys()) {
      obs.unobserve(el);
      obs.observe(el);
    }
  }, [readKey]);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  const applyCells = useCallback(
    (next: CellPages | ((current: CellPages) => CellPages)) =>
      setPages((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        // Neither another identity's map, nor a map built against a stale one.
        return value.readKey === readKey ? applyCellsTo(prev, value) : prev;
      }),
    [readKey],
  );

  const cellState = useCallback(
    (columnId: string, laneKey: string) => cellPageOf(pages, readKey, columnId, laneKey),
    [pages, readKey],
  );
  const cellSummary = useCallback(
    (columnId: string, laneKey: string) => summarize(cellPageOf(pages, readKey, columnId, laneKey)),
    [pages, readKey],
  );

  return {
    readKey,
    pages,
    cellState,
    cellSummary,
    loadCell,
    retryCell: loadCell,
    loadedLane,
    laneRef,
    applyCells,
  };
}
