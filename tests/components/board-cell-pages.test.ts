// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  EMPTY_CELL_PAGE,
  appendCellPage,
  applyLanePage,
  cellPageOf,
  cellReadKey,
  cellSummary,
  emptyCellPages,
  markCellsError,
  markCellsLoading,
  markLaneError,
  markLaneLoading,
  type CellPages,
} from '@/app/(authed)/boards/_components/boardCellPages';
import { useBoardCellPages } from '@/app/(authed)/boards/_components/useBoardCellPages';
import { cellId } from '@/app/(authed)/boards/_components/boardSwimlanes';
import { COLLAPSED_LANES_STORAGE_PREFIX } from '@/lib/hooks/useCollapsedLanes';
import type {
  BoardCardDto,
  BoardCellPageDto,
  BoardLanePageDto,
  BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';

// The grouped board's per-cell paging (MOTIR-11448): the pure reducers in
// `boardCellPages.ts`, then the hook's request guards through `renderHook` —
// with a stubbed `fetch` whose answers the test releases by hand, and a fake
// IntersectionObserver (happy-dom has no layout) the test reports entries on.

function card(id: string): BoardCardDto {
  return {
    id,
    key: 1,
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${id}`,
    title: `Card ${id}`,
    status: 'todo',
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
  };
}

function cellPage(
  columnId: string,
  laneKey: string,
  ids: string[],
  totalCount: number,
  cursor: string | null,
  planHolds: BoardCellPageDto['planHolds'] = {},
): BoardCellPageDto {
  return { columnId, laneKey, cards: ids.map(card), totalCount, cursor, planHolds };
}

const ids = (cards: BoardCardDto[]) => cards.map((c) => c.id);
const K = 'read-1';

describe('boardCellPages reducers', () => {
  const loaded = (): CellPages =>
    applyLanePage(emptyCellPages(K), K, [
      cellPage('c1', 'u1', ['w1', 'w2'], 5, 'CUR-1'),
      cellPage('c2', 'u1', [], 0, null),
      cellPage('c1', 'u2', ['w9'], 1, null),
    ]);

  it('reads an unrequested cell as idle with a null total, unlike a loaded empty cell', () => {
    const pages = loaded();
    const never = cellPageOf(pages, K, 'c3', 'u1');
    expect(never).toBe(EMPTY_CELL_PAGE);
    expect(never).toMatchObject({ state: 'idle', totalCount: null, cursor: null, cards: [] });
    expect(cellPageOf(pages, K, 'c2', 'u1')).toMatchObject({ state: 'complete', totalCount: 0 });
  });

  it('lands a lane page: each cell holds its first page, total and cursor', () => {
    const pages = loaded();
    expect(cellPageOf(pages, K, 'c1', 'u1')).toMatchObject({
      state: 'idle',
      totalCount: 5,
      cursor: 'CUR-1',
    });
    expect(ids(cellPageOf(pages, K, 'c1', 'u1').cards)).toEqual(['w1', 'w2']);
    expect(cellSummary(cellPageOf(pages, K, 'c1', 'u1'))).toEqual({
      loaded: 2,
      total: 5,
      hasMore: true,
    });
    expect(cellSummary(cellPageOf(pages, K, 'c1', 'u2'))).toEqual({
      loaded: 1,
      total: 1,
      hasMore: false,
    });
    expect(cellSummary(EMPTY_CELL_PAGE)).toEqual({ loaded: 0, total: null, hasMore: false });
  });

  it('appends a page to ONE cell only — every other cell keeps its reference', () => {
    const pages = loaded();
    const next = appendCellPage(pages, K, cellPage('c1', 'u1', ['w3', 'w4'], 5, 'CUR-2'));
    expect(ids(cellPageOf(next, K, 'c1', 'u1').cards)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(cellPageOf(next, K, 'c1', 'u1').cursor).toBe('CUR-2');
    expect(next.cells[cellId('c2', 'u1')]).toBe(pages.cells[cellId('c2', 'u1')]);
    expect(next.cells[cellId('c1', 'u2')]).toBe(pages.cells[cellId('c1', 'u2')]);
  });

  it('dedupes by card id and never reorders what the cell holds', () => {
    const pages = loaded();
    const next = appendCellPage(pages, K, cellPage('c1', 'u1', ['w2', 'w5', 'w1'], 4, null));
    expect(ids(cellPageOf(next, K, 'c1', 'u1').cards)).toEqual(['w1', 'w2', 'w5']);
    expect(cellPageOf(next, K, 'c1', 'u1')).toMatchObject({ state: 'complete', totalCount: 4 });
    // A page holding only cards the cell already shows keeps its card list.
    const again = appendCellPage(next, K, cellPage('c1', 'u1', ['w5'], 4, null));
    expect(cellPageOf(again, K, 'c1', 'u1').cards).toBe(cellPageOf(next, K, 'c1', 'u1').cards);
  });

  it('marks a cell loading and then failed, keeping its cards and count', () => {
    const pages = loaded();
    const busy = markCellsLoading(pages, K, [{ columnId: 'c1', laneKey: 'u1' }]);
    expect(cellPageOf(busy, K, 'c1', 'u1').state).toBe('loading');
    expect(busy.cells[cellId('c2', 'u1')]).toBe(pages.cells[cellId('c2', 'u1')]);
    const failed = markCellsError(busy, K, [{ columnId: 'c1', laneKey: 'u1' }]);
    expect(cellPageOf(failed, K, 'c1', 'u1')).toMatchObject({
      state: 'error',
      totalCount: 5,
      cursor: 'CUR-1',
    });
    expect(ids(cellPageOf(failed, K, 'c1', 'u1').cards)).toEqual(['w1', 'w2']);
    expect(failed.cells[cellId('c1', 'u2')]).toBe(pages.cells[cellId('c1', 'u2')]);
    // Marking a state a cell already holds keeps that cell's reference.
    const same = markCellsError(failed, K, [{ columnId: 'c1', laneKey: 'u1' }]);
    expect(same.cells[cellId('c1', 'u1')]).toBe(failed.cells[cellId('c1', 'u1')]);
  });

  it('marks a whole lane loading or failed across the given columns', () => {
    const busy = markLaneLoading(emptyCellPages(K), K, 'u3', ['c1', 'c2']);
    expect(cellPageOf(busy, K, 'c1', 'u3').state).toBe('loading');
    expect(cellPageOf(busy, K, 'c2', 'u3').state).toBe('loading');
    const failed = markLaneError(busy, K, 'u3', ['c1', 'c2']);
    expect(cellPageOf(failed, K, 'c1', 'u3')).toMatchObject({ state: 'error', totalCount: null });
    expect(cellPageOf(failed, K, 'c2', 'u3').state).toBe('error');
  });

  it('resets on a changed read identity: reads empty, marks start fresh, responses drop', () => {
    const pages = loaded();
    const K2 = 'read-2';
    expect(cellPageOf(pages, K2, 'c1', 'u1')).toBe(EMPTY_CELL_PAGE);
    const fresh = markLaneLoading(pages, K2, 'u1', ['c1']);
    expect(fresh.readKey).toBe(K2);
    expect(Object.keys(fresh.cells)).toEqual([cellId('c1', 'u1')]);
    expect(cellPageOf(fresh, K2, 'c1', 'u1').cards).toEqual([]);
    // A response read under the OLD identity is never written into the new one.
    expect(appendCellPage(fresh, K, cellPage('c1', 'u1', ['w7'], 9, null))).toBe(fresh);
    expect(applyLanePage(fresh, K, [cellPage('c1', 'u1', ['w7'], 9, null)])).toBe(fresh);
    expect(markCellsError(fresh, K, [{ columnId: 'c1', laneKey: 'u1' }])).toBe(fresh);
  });

  it('keys a read identity by board, group-by and filter', () => {
    const a = cellReadKey({ boardId: 'b1', groupBy: 'assignee', filterParam: '' });
    expect(cellReadKey({ boardId: 'b1', groupBy: 'assignee', filterParam: '' })).toBe(a);
    expect(cellReadKey({ boardId: 'b2', groupBy: 'assignee', filterParam: '' })).not.toBe(a);
    expect(cellReadKey({ boardId: 'b1', groupBy: 'priority', filterParam: '' })).not.toBe(a);
    expect(cellReadKey({ boardId: 'b1', groupBy: 'assignee', filterParam: 'v1:x' })).not.toBe(a);
  });
});

// ── the hook ────────────────────────────────────────────────────────────────

interface FakeObserver {
  callback: IntersectionObserverCallback;
  targets: Element[];
  live: boolean;
  root: Element | Document | null;
}
const observers: FakeObserver[] = [];

class FakeIntersectionObserver {
  private readonly self: FakeObserver;
  constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    this.self = { callback, targets: [], live: true, root: init?.root ?? null };
    observers.push(this.self);
  }
  observe(el: Element) {
    this.self.targets.push(el);
  }
  unobserve(el: Element) {
    this.self.targets = this.self.targets.filter((t) => t !== el);
  }
  disconnect() {
    this.self.live = false;
  }
  takeRecords() {
    return [];
  }
}

/** Report `el` to the live observer watching it. */
function report(el: Element, isIntersecting = true) {
  const o = observers.find((x) => x.live && x.targets.includes(el));
  if (!o) throw new Error('no live observer watches this element');
  act(() => {
    o.callback(
      [{ isIntersecting, target: el } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

type Answer = { ok: true; body: unknown } | { ok: false };
interface Pending {
  url: string;
  resolve: (a: Answer) => void;
}
let pending: Pending[] = [];

function deferredFetch() {
  return vi.fn(
    (url: string) =>
      new Promise((done) => {
        pending.push({
          url: String(url),
          resolve: (a) =>
            done(
              a.ok
                ? { ok: true, status: 200, json: async () => a.body }
                : { ok: false, status: 500, json: async () => ({}) },
            ),
        });
      }),
  );
}

/** Release the oldest open request with `answer`, and let the hook settle. */
async function answer(a: Answer) {
  const next = pending.shift();
  if (!next) throw new Error('no request is open');
  await act(async () => {
    next.resolve(a);
    await Promise.resolve();
  });
  return next.url;
}

function lanePage(laneKey: string, cells: BoardCellPageDto[]): BoardLanePageDto {
  return { laneKey, cells };
}

type Props = {
  boardId: string;
  groupBy: BoardSwimlaneGroupByDto;
  filterParam: string;
};

function mount(over: Partial<Props> = {}) {
  const onPlanHolds = vi.fn();
  const view = renderHook(
    (props: Props) => useBoardCellPages({ ...props, columnIds: ['c1', 'c2'], onPlanHolds }),
    { initialProps: { boardId: 'b1', groupBy: 'assignee', filterParam: '', ...over } },
  );
  return { ...view, onPlanHolds };
}

let fetchMock: ReturnType<typeof deferredFetch>;

beforeEach(() => {
  pending = [];
  observers.length = 0;
  window.localStorage.clear();
  fetchMock = deferredFetch();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const U1_PAGE = lanePage('u1', [
  cellPage('c1', 'u1', ['w1', 'w2'], 12, 'CUR-1', { p1: { planId: 'p1' } as never }),
  cellPage('c2', 'u1', ['w5'], 1, null, { p2: { planId: 'p2' } as never }),
]);

describe('useBoardCellPages', () => {
  it('fills a lane with ONE request and merges its plan holds', async () => {
    const { result, onPlanHolds } = mount({ filterParam: 'v1:f' });
    act(() => result.current.loadedLane('u1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.cellState('c1', 'u1').state).toBe('loading');
    expect(result.current.cellState('c2', 'u1').state).toBe('loading');

    const url = await answer({ ok: true, body: U1_PAGE });
    expect(url).toBe('/api/board/lanes/u1/cells?boardId=b1&filter=v1%3Af');
    expect(ids(result.current.cellState('c1', 'u1').cards)).toEqual(['w1', 'w2']);
    expect(result.current.cellSummary('c1', 'u1')).toEqual({ loaded: 2, total: 12, hasMore: true });
    expect(result.current.cellState('c2', 'u1').state).toBe('complete');
    expect(onPlanHolds).toHaveBeenCalledWith({ p1: { planId: 'p1' }, p2: { planId: 'p2' } });
  });

  it('path-encodes the catch-all lane key into the lane route', async () => {
    const { result } = mount();
    act(() => result.current.loadedLane('__no_value__'));
    expect(pending[0]!.url).toBe('/api/board/lanes/__no_value__/cells?boardId=b1');
    act(() => result.current.loadedLane('a b'));
    expect(pending[1]!.url).toBe('/api/board/lanes/a%20b/cells?boardId=b1');
  });

  it('asks for a lane once: in flight, and after its page landed', async () => {
    const { result } = mount();
    act(() => result.current.loadedLane('u1'));
    act(() => result.current.loadedLane('u1'));
    act(() => result.current.loadCell('c1', 'u1'));
    act(() => result.current.retryCell('c1', 'u1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await answer({ ok: true, body: U1_PAGE });
    act(() => result.current.loadedLane('u1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads nothing for a collapsed lane, which stays idle', () => {
    window.localStorage.setItem(COLLAPSED_LANES_STORAGE_PREFIX + 'b-col', JSON.stringify(['u1']));
    const { result } = mount({ boardId: 'b-col' });
    act(() => result.current.loadedLane('u1'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.cellState('c1', 'u1')).toBe(EMPTY_CELL_PAGE);
  });

  it('is inert on a flat board', () => {
    const { result } = mount({ groupBy: 'none' });
    act(() => {
      result.current.loadedLane('u1');
      result.current.loadCell('c1', 'u1');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a lane only from an intersecting entry, and only once', async () => {
    const { result } = mount();
    const row = document.createElement('div');
    const other = document.createElement('div');
    act(() => {
      result.current.laneRef('u1')(row);
      result.current.laneRef('u2')(other);
    });
    // One observer for the board, rooted at the viewport; nothing asked at mount.
    expect(observers.filter((o) => o.live)).toHaveLength(1);
    expect(observers[0]!.root).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The same callback ref is handed back for the same lane.
    expect(result.current.laneRef('u1')).toBe(result.current.laneRef('u1'));

    report(row, false);
    expect(fetchMock).not.toHaveBeenCalled();
    report(row);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await answer({ ok: true, body: U1_PAGE });
    // Out of view and back: no further request.
    report(row, false);
    report(row);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed lane on scroll — only on an explicit call', async () => {
    const { result } = mount();
    const row = document.createElement('div');
    act(() => {
      result.current.laneRef('u1')(row);
    });
    report(row);
    await answer({ ok: false });
    expect(result.current.cellState('c1', 'u1').state).toBe('error');
    expect(result.current.cellState('c2', 'u1').state).toBe('error');
    report(row, false);
    report(row);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.loadedLane('u1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await answer({ ok: true, body: U1_PAGE });
    expect(result.current.cellState('c1', 'u1').state).toBe('idle');
  });

  it('appends a cell’s next page to that cell alone, one page in flight', async () => {
    const { result } = mount();
    act(() => result.current.loadedLane('u1'));
    await answer({ ok: true, body: U1_PAGE });
    const before = result.current.pages;

    act(() => result.current.loadCell('c1', 'u1'));
    act(() => result.current.loadCell('c1', 'u1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.cellState('c1', 'u1').state).toBe('loading');
    const url = await answer({
      ok: true,
      body: cellPage('c1', 'u1', ['w2', 'w3'], 12, null),
    });
    expect(url).toBe('/api/board/columns/c1/cards?boardId=b1&lane=u1&cursor=CUR-1');
    expect(ids(result.current.cellState('c1', 'u1').cards)).toEqual(['w1', 'w2', 'w3']);
    expect(result.current.cellState('c1', 'u1').state).toBe('complete');
    expect(result.current.pages.cells[cellId('c2', 'u1')]).toBe(before.cells[cellId('c2', 'u1')]);

    // Exhausted: no further request.
    act(() => result.current.loadCell('c1', 'u1'));
    act(() => result.current.loadCell('c2', 'u1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves only the failed cell in error, and retry re-asks that cell alone', async () => {
    const { result, onPlanHolds } = mount();
    act(() => result.current.loadedLane('u1'));
    await answer({ ok: true, body: U1_PAGE });

    act(() => result.current.loadCell('c1', 'u1'));
    await answer({ ok: false });
    expect(result.current.cellState('c1', 'u1')).toMatchObject({
      state: 'error',
      totalCount: 12,
      cursor: 'CUR-1',
    });
    expect(ids(result.current.cellState('c1', 'u1').cards)).toEqual(['w1', 'w2']);
    expect(result.current.cellState('c2', 'u1').state).toBe('complete');

    act(() => result.current.retryCell('c1', 'u1'));
    const url = await answer({ ok: true, body: cellPage('c1', 'u1', ['w3'], 12, 'CUR-2') });
    expect(url).toContain('/api/board/columns/c1/cards?');
    expect(url).toContain('cursor=CUR-1');
    expect(result.current.cellState('c1', 'u1').state).toBe('idle');
    expect(onPlanHolds).toHaveBeenLastCalledWith({});
  });

  it('retries a cell that never loaded with its own first page, not its lane', async () => {
    const { result } = mount({ filterParam: 'v1:f' });
    act(() => result.current.retryCell('c1', 'u7'));
    const url = await answer({ ok: true, body: cellPage('c1', 'u7', ['w8'], 1, null) });
    expect(url).toBe('/api/board/columns/c1/cards?boardId=b1&lane=u7&filter=v1%3Af');
    expect(result.current.cellState('c1', 'u7').state).toBe('complete');
  });

  it('empties every cell on a changed identity and drops a late response', async () => {
    const { result, rerender } = mount();
    const row = document.createElement('div');
    act(() => {
      result.current.laneRef('u1')(row);
    });
    act(() => result.current.loadedLane('u1'));
    await answer({ ok: true, body: U1_PAGE });
    act(() => result.current.loadCell('c1', 'u1'));

    rerender({ boardId: 'b1', groupBy: 'assignee', filterParam: 'v1:new' });
    expect(result.current.cellState('c1', 'u1')).toBe(EMPTY_CELL_PAGE);
    // The open page, read under the old filter, resolves now and is dropped.
    await answer({ ok: true, body: cellPage('c1', 'u1', ['w3'], 12, null) });
    expect(result.current.cellState('c1', 'u1')).toBe(EMPTY_CELL_PAGE);
    // The lane still in view is observed afresh, so it asks under the new filter.
    report(row);
    expect(pending.at(-1)!.url).toBe('/api/board/lanes/u1/cells?boardId=b1&filter=v1%3Anew');
  });

  it('applyCells replaces the whole map; a stale map is dropped; an idle cell loads its first page', async () => {
    const { result } = mount();
    act(() => result.current.loadedLane('u1'));
    await answer({ ok: true, body: U1_PAGE });

    const next = applyLanePage(emptyCellPages(result.current.readKey), result.current.readKey, [
      cellPage('c2', 'u1', ['w1', 'w5'], 2, null),
    ]);
    act(() => result.current.applyCells(next));
    expect(result.current.pages).toBe(next);
    expect(ids(result.current.cellState('c2', 'u1').cards)).toEqual(['w1', 'w5']);
    // c1 is not named, so it is idle and loads its own first page — no lane read.
    expect(result.current.cellState('c1', 'u1')).toBe(EMPTY_CELL_PAGE);
    act(() => result.current.loadCell('c1', 'u1'));
    expect(pending.at(-1)!.url).toBe('/api/board/columns/c1/cards?boardId=b1&lane=u1');

    const stale = applyLanePage(emptyCellPages('elsewhere'), 'elsewhere', [
      cellPage('c2', 'u1', [], 0, null),
    ]);
    const held = result.current.pages;
    act(() => result.current.applyCells(stale));
    expect(result.current.pages).toBe(held);
  });

  it('disconnects its observer on unmount, and needs none to exist', () => {
    const { result, unmount } = mount();
    act(() => {
      result.current.laneRef('u1')(document.createElement('div'));
    });
    unmount();
    expect(observers[0]!.live).toBe(false);

    vi.stubGlobal('IntersectionObserver', undefined);
    const second = mount();
    expect(second.result.current.laneRef('u1')(document.createElement('div'))).toBeUndefined();
    expect(second.result.current.laneRef('u1')(null)).toBeUndefined();
  });

  it('stops watching an element its ref lets go of', () => {
    const { result } = mount();
    const row = document.createElement('div');
    let release: (() => void) | void;
    act(() => {
      release = result.current.laneRef('u1')(row);
    });
    expect(observers[0]!.targets).toContain(row);
    act(() => release?.());
    expect(observers[0]!.targets).not.toContain(row);
  });
});
