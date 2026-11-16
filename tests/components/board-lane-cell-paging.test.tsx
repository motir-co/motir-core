// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  LaneCell,
  cellPhase,
  resolveCellScrollViewport,
  type LaneCellPage,
} from '@/app/(authed)/boards/_components/LaneCell';
import type { BoardCardDto } from '@/lib/dto/boards';

// A grouped board's cell pages itself (MOTIR-11450, design MOTIR-11443 panel 4):
// rendered with the real `en` catalogue inside a DndContext (the cell registers a
// droppable, each card a sortable). happy-dom lays nothing out, so windowing
// degrades to render-all and the viewport resolver is driven by stubbed sizes.

function card(n: number): BoardCardDto {
  return {
    id: `w${n}`,
    key: n,
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${n}`,
    title: `Card ${n}`,
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
    swimlaneKey: 'u1',
  };
}
const cards = (n: number) => Array.from({ length: n }, (_, i) => card(i + 1));

function renderCell(
  page: LaneCellPage | undefined,
  list: BoardCardDto[],
  handlers: { onLoadMore?: () => void; onRetry?: () => void } = {},
) {
  return render(
    <DndContext>
      <LaneCell
        columnId="c1"
        laneKey="u1"
        cards={list}
        assigneeNameById={new Map()}
        onOpenQuickView={() => {}}
        activeCardId={null}
        page={page}
        laneLabel="Ana Ruiz"
        columnName="To Do"
        {...handlers}
      />
    </DndContext>,
  );
}

const cell = () => screen.getByTestId('lane-cell-c1-u1');

afterEach(cleanup);

describe('cellPhase', () => {
  it('reads one phase off the page slice, never off a bare empty list', () => {
    expect(cellPhase(undefined, 0)).toBe('placeholder');
    expect(cellPhase({ state: 'idle', totalCount: null, cursor: null }, 0)).toBe('not-loaded');
    expect(cellPhase({ state: 'loading', totalCount: null, cursor: null }, 0)).toBe('first-load');
    expect(cellPhase({ state: 'error', totalCount: null, cursor: null }, 0)).toBe('failed');
    expect(cellPhase({ state: 'error', totalCount: 40, cursor: 'C' }, 10)).toBe('failed');
    expect(cellPhase({ state: 'idle', totalCount: 40, cursor: 'C' }, 10)).toBe('loaded');
    expect(cellPhase({ state: 'loading', totalCount: 40, cursor: 'C' }, 10)).toBe('loaded');
    expect(cellPhase({ state: 'complete', totalCount: 3, cursor: null }, 3)).toBe('complete');
    expect(cellPhase({ state: 'complete', totalCount: 0, cursor: null }, 0)).toBe('empty');
  });
});

describe('LaneCell paging', () => {
  it('renders every card in the order given, the sortable list whole', () => {
    renderCell({ state: 'idle', totalCount: 40, cursor: 'C' }, cards(30));
    const ids = within(cell())
      .getAllByTestId(/^board-card-PROD-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toHaveLength(30);
    expect(ids.at(-2)).toBe('board-card-PROD-29');
    expect(ids.at(-1)).toBe('board-card-PROD-30');
  });

  it('reads {loaded} of {total} with Load more after the cards, outside the window', () => {
    const onLoadMore = vi.fn();
    renderCell({ state: 'idle', totalCount: 40, cursor: 'C' }, cards(10), { onLoadMore });
    expect(screen.getByTestId('cell-count-c1-u1').textContent).toBe('10 of 40');
    // The pinned header's id is never reused inside a cell.
    expect(within(cell()).queryByTestId('board-count-c1')).toBeNull();
    expect(cell().querySelector('[data-testid^="board-load-more-"]')).toBeNull();

    const more = screen.getByTestId('cell-load-more-c1-u1');
    expect(more.textContent).toContain('Load more');
    expect(more.getAttribute('aria-label')).toBe('Load more work items in To Do, Ana Ruiz lane');
    // After the windowed container, never inside it.
    const windowed = screen.getByTestId('cell-cards-c1-u1');
    expect(windowed.contains(more)).toBe(false);
    expect(windowed.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps Load more in place, disabled and busy, while its page is in flight', () => {
    const onLoadMore = vi.fn();
    renderCell({ state: 'loading', totalCount: 40, cursor: 'C' }, cards(10), { onLoadMore });
    const more = screen.getByTestId('cell-load-more-c1-u1') as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expect(more.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('cell-loading-c1-u1').textContent).toBe('Loading…');
    expect(screen.getByTestId('cell-loading-c1-u1').getAttribute('role')).toBe('status');
    fireEvent.click(more);
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(screen.getByTestId('cell-count-c1-u1').textContent).toBe('10 of 40');
  });

  it('shows the plain total and no control once complete', () => {
    renderCell({ state: 'complete', totalCount: 3, cursor: null }, cards(3));
    expect(screen.getByTestId('cell-count-c1-u1').textContent).toBe('3');
    expect(screen.queryByTestId('cell-load-more-c1-u1')).toBeNull();
    expect(screen.queryByTestId('cell-retry-c1-u1')).toBeNull();
  });

  it('keeps a failed page’s cards and count, with the retry in the control’s place', () => {
    const onRetry = vi.fn();
    renderCell({ state: 'error', totalCount: 40, cursor: 'C' }, cards(10), { onRetry });
    expect(within(cell()).getAllByTestId(/^board-card-PROD-/)).toHaveLength(10);
    expect(screen.getByTestId('cell-count-c1-u1').textContent).toBe('10 of 40');
    expect(screen.queryByTestId('cell-load-more-c1-u1')).toBeNull();
    const retry = screen.getByTestId('cell-retry-c1-u1');
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.className).toContain('focus-visible:ring-2');
    const name = retry.getAttribute('aria-label')!;
    expect(name).toBe('Couldn’t load more work items · Retry, in To Do, Ana Ruiz lane');
    expect(name).toContain(retry.textContent!);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a failed FIRST page with its retry, never the empty cell', () => {
    const onRetry = vi.fn();
    renderCell({ state: 'error', totalCount: null, cursor: null }, [], { onRetry });
    expect(cell().textContent).not.toContain('No work items');
    expect(screen.queryByTestId('cell-count-c1-u1')).toBeNull();
    fireEvent.click(screen.getByTestId('cell-retry-c1-u1'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('draws the skeleton before a page arrives — at rest, then in flight — with no count', () => {
    const { unmount } = renderCell({ state: 'idle', totalCount: null, cursor: null }, []);
    expect(cell().getAttribute('data-cell-phase')).toBe('not-loaded');
    expect(cell().getAttribute('role')).toBeNull();
    expect(cell().className).not.toContain('animate-pulse');
    expect(cell().textContent).not.toContain('No work items');
    expect(screen.queryByTestId('cell-count-c1-u1')).toBeNull();
    expect(screen.queryByTestId('cell-load-more-c1-u1')).toBeNull();
    unmount();

    renderCell({ state: 'loading', totalCount: null, cursor: null }, []);
    expect(cell().getAttribute('role')).toBe('status');
    expect(cell().getAttribute('aria-busy')).toBe('true');
    expect(cell().getAttribute('aria-label')).toBe('Loading work items in To Do, Ana Ruiz lane');
    expect(cell().className).toContain('animate-pulse');
    expect(screen.queryByTestId('cell-count-c1-u1')).toBeNull();
  });

  it('draws the empty cell only for a page that arrived holding nothing', () => {
    renderCell({ state: 'complete', totalCount: 0, cursor: null }, []);
    expect(cell().textContent).toBe('No work items');
    expect(cell().getAttribute('data-cell-phase')).toBe('empty');
  });

  it('renders as it always has with no page slice', () => {
    const { unmount } = renderCell(undefined, cards(2));
    expect(within(cell()).getAllByTestId(/^board-card-PROD-/)).toHaveLength(2);
    expect(screen.queryByTestId('cell-foot-c1-u1')).toBeNull();
    unmount();
    renderCell(undefined, []);
    expect(cell().textContent).toBe('No work items');
  });

  it('tolerates a press with no handler wired', () => {
    const { unmount } = renderCell({ state: 'idle', totalCount: 40, cursor: 'C' }, cards(1));
    fireEvent.click(screen.getByTestId('cell-load-more-c1-u1'));
    unmount();
    renderCell({ state: 'error', totalCount: null, cursor: null }, []);
    fireEvent.click(screen.getByTestId('cell-retry-c1-u1'));
    expect(screen.getByTestId('cell-retry-c1-u1')).toBeTruthy();
  });

  it('keeps its droppable root in every phase', () => {
    const pages: Array<[LaneCellPage, number]> = [
      [{ state: 'loading', totalCount: null, cursor: null }, 0],
      [{ state: 'error', totalCount: null, cursor: null }, 0],
      [{ state: 'idle', totalCount: 40, cursor: 'C' }, 5],
      [{ state: 'complete', totalCount: 5, cursor: null }, 5],
    ];
    for (const [page, n] of pages) {
      const { unmount } = renderCell(page, cards(n));
      expect(screen.getByTestId('lane-cell-c1-u1')).toBeTruthy();
      unmount();
    }
  });
});

describe('resolveCellScrollViewport', () => {
  function stub(el: HTMLElement, overflowY: string, scrollHeight: number, clientHeight: number) {
    el.style.overflowY = overflowY;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  }

  it('skips a sideways lane row that does not overflow, and takes the board scroller that does', () => {
    const board = document.createElement('div');
    const lane = document.createElement('div');
    const cellEl = document.createElement('div');
    board.appendChild(lane);
    lane.appendChild(cellEl);
    document.body.appendChild(board);
    stub(board, 'auto', 3000, 800);
    stub(lane, 'auto', 400, 400);
    expect(resolveCellScrollViewport(cellEl)).toBe(board);
    // Nothing overflows: the primitive's render-all degrade.
    stub(board, 'auto', 800, 800);
    expect(resolveCellScrollViewport(cellEl)).toBeNull();
    // An overflowing ancestor that does not scroll is not a viewport.
    stub(board, 'visible', 3000, 800);
    expect(resolveCellScrollViewport(cellEl)).toBeNull();
    expect(resolveCellScrollViewport(null)).toBeNull();
    board.remove();
  });
});
