// @vitest-environment happy-dom
import { useRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { BoardColumnArrows } from '@/app/(authed)/boards/_components/BoardColumnArrows';
import {
  BOARD_SCROLL_NAV_CLASS,
  PAN_THRESHOLD_PX,
  columnEdges,
  nearestColumnEdge,
  nextColumnEdge,
} from '@/app/(authed)/boards/_components/boardHorizontalNav';
import { SwimlaneBoard } from '@/app/(authed)/boards/_components/SwimlaneBoard';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardProjectionDto,
} from '@/lib/dto/boards';

// The board's horizontal navigation (MOTIR-11323, design MOTIR-11326): drag-to-pan
// on empty background, the column arrows (one column per press, disabled at each
// end, absent when every column fits) and the hidden scrollbar, on the flat row
// and the swimlane container. happy-dom lays nothing out, so the row's geometry is
// supplied below: four 288px columns on a 304px pitch, in a 600px-wide row.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));
vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';

const PITCH = 304;
const ROW_SELECTOR = '[data-test-row], [data-board-scroll], [data-testid="swimlane-board"]';
const dims = { content: 1216, row: 600, nav: 680 };

/** Is `el` a board scroll row? */
function isRow(el: Element): boolean {
  return el.matches(ROW_SELECTOR);
}

const originals = {
  scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  rect: Element.prototype.getBoundingClientRect,
  scrollTo: Element.prototype.scrollTo,
};
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return isRow(this) ? dims.content : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      if (isRow(this)) return dims.row;
      if (this.matches('[data-board-nav]')) return dims.nav;
      return 0;
    },
  });
  // A column edge sits at its index × the pitch, after the row's own start inset
  // (24px, as the swimlane track's `px-6`), shifted by how far the row scrolled.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute('data-board-column-edge')) {
      const row = this.closest(ROW_SELECTOR) as HTMLElement;
      const all = Array.from(row.querySelectorAll('[data-board-column-edge]'));
      const left = 24 + all.indexOf(this) * PITCH - row.scrollLeft;
      return { left, right: left + 288, top: 0, bottom: 0, width: 288, height: 0 } as DOMRect;
    }
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  };
  scrollTo = vi.fn(function (this: HTMLElement, opts: ScrollToOptions) {
    this.scrollLeft = opts.left ?? this.scrollLeft;
    this.dispatchEvent(new Event('scroll'));
  });
  Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  dims.content = 1216;
  dims.row = 600;
  dims.nav = 680;
  if (originals.scrollWidth)
    Object.defineProperty(Element.prototype, 'scrollWidth', originals.scrollWidth);
  if (originals.clientWidth)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originals.clientWidth);
  Element.prototype.getBoundingClientRect = originals.rect;
  Element.prototype.scrollTo = originals.scrollTo;
  vi.unstubAllGlobals();
});

function Harness({ settle = false }: { settle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <BoardColumnArrows rowRef={ref} contentKey={4} settle={settle}>
      <div ref={ref} data-test-row="" data-testid="row" className={BOARD_SCROLL_NAV_CLASS}>
        {[0, 1, 2, 3].map((i) => (
          <section key={i} data-board-column-edge="" data-testid={`col-${i}`}>
            <button type="button" data-testid={`card-${i}`}>
              card
            </button>
            <a href="#door" data-testid={`link-${i}`}>
              door
            </a>
            <div role="button" tabIndex={0} data-testid={`lane-${i}`}>
              lane
            </div>
          </section>
        ))}
      </div>
    </BoardColumnArrows>
  );
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

/** A mouse press at `x` on `el`, then moves on the window, then a release. */
function drag(el: Element, from: number, to: number, { pointerType = 'mouse', button = 0 } = {}) {
  fireEvent.pointerDown(el, { clientX: from, pointerId: 1, pointerType, button });
  fireEvent.pointerMove(window, { clientX: from + (to - from) / 2, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: to, pointerId: 1 });
}
function release(x: number) {
  fireEvent.pointerUp(window, { clientX: x, pointerId: 1 });
}

describe('the column edges', () => {
  it('nextColumnEdge steps one column each way and is null at an end', () => {
    const edges = [0, 304, 608, 616];
    expect(nextColumnEdge(edges, 0, 'next')).toBe(304);
    expect(nextColumnEdge(edges, 304, 'next')).toBe(608);
    expect(nextColumnEdge(edges, 150, 'next')).toBe(304);
    expect(nextColumnEdge(edges, 616, 'next')).toBeNull();
    expect(nextColumnEdge(edges, 304, 'previous')).toBe(0);
    expect(nextColumnEdge(edges, 450, 'previous')).toBe(304);
    expect(nextColumnEdge(edges, 0, 'previous')).toBeNull();
  });

  it('nearestColumnEdge picks the closest edge, and null with none', () => {
    expect(nearestColumnEdge([0, 304, 608], 140)).toBe(0);
    expect(nearestColumnEdge([0, 304, 608], 170)).toBe(304);
    expect(nearestColumnEdge([], 170)).toBeNull();
  });

  it('columnEdges measures each column from the first and clamps to the scroll range', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    // max = 1216 − 600 = 616, so the last column's 912 clamps to it.
    expect(columnEdges(row)).toEqual([0, 304, 608, 616]);
    row.scrollLeft = 200;
    expect(columnEdges(row)).toEqual([0, 304, 608, 616]);
  });

  it('columnEdges is empty for a row with no columns', () => {
    const row = document.createElement('div');
    expect(columnEdges(row)).toEqual([]);
  });
});

describe('drag-to-pan', () => {
  it('a mouse drag on empty background scrolls the row by the drag distance', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId('col-1'), 400, 250);
    expect(row.scrollLeft).toBe(150);
    expect(row.hasAttribute('data-panning')).toBe(true);
    release(250);
    expect(row.hasAttribute('data-panning')).toBe(false);
  });

  it('the click that ends a pan is swallowed; the next one is not', async () => {
    const onClick = vi.fn();
    render(<Harness />);
    const row = screen.getByTestId('row');
    row.addEventListener('click', onClick);
    drag(screen.getByTestId('col-1'), 400, 300);
    release(300);
    fireEvent.click(screen.getByTestId('col-1'));
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('col-1'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a pan whose release brings no click does not eat the next deliberate click', async () => {
    const onClick = vi.fn();
    render(<Harness />);
    const row = screen.getByTestId('row');
    row.addEventListener('click', onClick);
    drag(screen.getByTestId('col-1'), 400, 300);
    release(300);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    fireEvent.click(screen.getByTestId('col-1'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a movement under the threshold is a click, not a pan', () => {
    const onClick = vi.fn();
    render(<Harness />);
    const row = screen.getByTestId('row');
    row.addEventListener('click', onClick);
    drag(screen.getByTestId('col-1'), 400, 400 - (PAN_THRESHOLD_PX - 1));
    expect(row.scrollLeft).toBe(0);
    expect(row.hasAttribute('data-panning')).toBe(false);
    release(400);
    fireEvent.click(screen.getByTestId('col-1'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each(['card', 'link', 'lane'])('a press on a %s never starts a pan', (what) => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId(`${what}-1`), 400, 200);
    expect(row.scrollLeft).toBe(0);
    expect(row.hasAttribute('data-panning')).toBe(false);
    release(200);
  });

  it('touch and a secondary button are left alone', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId('col-1'), 400, 200, { pointerType: 'touch' });
    release(200);
    drag(screen.getByTestId('col-1'), 400, 200, { button: 2 });
    release(200);
    expect(row.scrollLeft).toBe(0);
  });

  it('another pointer neither moves nor ends the pan', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId('col-1'), 400, 300);
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 2 });
    expect(row.scrollLeft).toBe(100);
    expect(row.hasAttribute('data-panning')).toBe(true);
    fireEvent.pointerCancel(window, { clientX: 300, pointerId: 1 });
    expect(row.hasAttribute('data-panning')).toBe(false);
  });

  it('with settle, the released row lands on the nearest column edge', () => {
    render(<Harness settle />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId('col-1'), 500, 280);
    expect(row.scrollLeft).toBe(220);
    scrollTo.mockClear();
    release(280);
    expect(scrollTo).toHaveBeenCalledWith({ left: 304, behavior: 'smooth' });
    expect(row.scrollLeft).toBe(304);
  });

  it('with settle, a row already on an edge is not scrolled again; reduced motion jumps', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList);
    render(<Harness settle />);
    const row = screen.getByTestId('row');
    drag(screen.getByTestId('col-1'), 400, 96);
    scrollTo.mockClear();
    release(96);
    expect(row.scrollLeft).toBe(304);
    expect(scrollTo).not.toHaveBeenCalled();
    drag(screen.getByTestId('col-1'), 400, 300);
    release(300);
    expect(scrollTo).toHaveBeenCalledWith({ left: 304, behavior: 'auto' });
  });

  it('a browser without matchMedia settles smoothly', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Harness settle />);
    drag(screen.getByTestId('col-1'), 400, 300);
    scrollTo.mockClear();
    release(300);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' });
  });

  it('binds nothing while the row is not mounted', () => {
    function Unattached() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <BoardColumnArrows rowRef={ref} contentKey={0} settle>
          <div data-testid="loose">no row</div>
        </BoardColumnArrows>
      );
    }
    render(<Unattached />);
    drag(screen.getByTestId('loose'), 400, 100);
    release(100);
    expect(screen.queryByRole('button', { name: 'Next column' })).toBeNull();
  });

  it('wears the scoped grab cursor and hides the native scrollbar', () => {
    render(<Harness />);
    const cls = screen.getByTestId('row').className;
    for (const c of [
      '[scrollbar-width:none]',
      '[&::-webkit-scrollbar]:hidden',
      'cursor-grab',
      'data-[panning]:cursor-grabbing',
      'data-[panning]:snap-none',
      'data-[panning]:select-none',
      '[:where(&)_button]:cursor-default',
    ]) {
      expect(cls).toContain(c);
    }
  });
});

describe('the column arrows', () => {
  it('render both arrows with translated names; the left one is disabled at the start', () => {
    render(<Harness />);
    const prev = screen.getByRole('button', { name: 'Previous column' });
    const next = screen.getByRole('button', { name: 'Next column' });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);
    // Reading order: the left arrow before the row, the right one after it.
    const row = screen.getByTestId('row');
    expect(prev.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('each press moves the row by one column and lands on its edge', async () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    fireEvent.click(screen.getByRole('button', { name: 'Next column' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 304, behavior: 'smooth' });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Previous column' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next column' }));
    expect(row.scrollLeft).toBe(608);
    fireEvent.click(screen.getByRole('button', { name: 'Previous column' }));
    expect(row.scrollLeft).toBe(304);
  });

  it('the right arrow is disabled at the end', async () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    act(() => {
      row.scrollLeft = 616;
      fireEvent.scroll(row);
    });
    const next = screen.getByRole('button', { name: 'Next column' }) as HTMLButtonElement;
    await waitFor(() => expect(next.disabled).toBe(true));
    expect(
      (screen.getByRole('button', { name: 'Previous column' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('measures once without ResizeObserver, and again on scroll', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Harness />);
    const row = screen.getByTestId('row');
    const next = screen.getByRole('button', { name: 'Next column' }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    act(() => {
      row.scrollLeft = 616;
      fireEvent.scroll(row);
    });
    await waitFor(() => expect(next.disabled).toBe(true));
  });

  it('both are absent when every column fits', () => {
    dims.content = 600;
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Previous column' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next column' })).toBeNull();
    expect(document.querySelector('[data-column-arrow-gutter]')).toBeNull();
  });

  it('a row only as wide as the gutters would free stays without arrows', () => {
    // 640px of content in a 600px row whose wrapper is 680px: shown, the arrows
    // would cost exactly the room that makes it fit — it is measured against the
    // wrapper, so it does not overflow.
    dims.content = 640;
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Next column' })).toBeNull();
  });

  it('a step with no edge left does nothing', () => {
    render(<Harness />);
    scrollTo.mockClear();
    // The left arrow is disabled at the start; press its handler through the DOM
    // anyway by enabling it, as an assistive tool could.
    const prev = screen.getByRole('button', { name: 'Previous column' }) as HTMLButtonElement;
    prev.disabled = false;
    fireEvent.click(prev);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ── the shipped boards ─────────────────────────────────────────────────────────

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
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
    ...over,
  };
}

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

const COLUMNS: BoardColumnDto[] = [
  column({ id: 'c1', name: 'To Do', totalCount: 1, cards: [card({ id: 'w1', key: 1 })] }),
  column({ id: 'c2', name: 'In Progress' }),
  column({ id: 'c3', name: 'In Review' }),
  column({ id: 'c4', name: 'Done' }),
];

describe('the flat board', () => {
  const projection: BoardProjectionDto = {
    boardId: 'b1',
    name: 'Default',
    type: 'kanban',
    swimlaneGroupBy: 'none',
    swimlanes: [],
    unmappedStatuses: [],
    sprint: null,
    planHolds: {},
    storedFilter: null,
    columns: COLUMNS,
  };

  it('pans on a background drag, never from a card, and carries the arrows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => projection }),
    );
    render(<BoardContainer />);
    const row = await screen.findByTestId('board');
    expect(row.className).toContain('[scrollbar-width:none]');
    expect(row.querySelectorAll('[data-board-column-edge]')).toHaveLength(4);
    // The board area cancels the shell's bottom band at sm+ (the /ready pattern).
    expect(row.closest('[data-board-nav]')?.parentElement?.className).toContain(
      'sm:-mb-(--shell-bottom-clearance)',
    );

    drag(screen.getByTestId('board-column-c2'), 400, 300);
    expect(row.scrollLeft).toBe(100);
    release(300);

    const before = row.scrollLeft;
    drag(screen.getByTestId('board-card-PROD-1'), 400, 100);
    expect(row.scrollLeft).toBe(before);
    release(100);

    expect(screen.getByRole('button', { name: 'Next column' })).toBeTruthy();
  });
});

describe('the swimlane board', () => {
  it('pans on a background drag, never from a card, and carries the arrows', () => {
    renderWithIntl(
      <DndContext>
        <SwimlaneBoard
          boardId="b-pan"
          columns={COLUMNS}
          swimlanes={[
            { key: BOARD_SWIMLANE_NO_VALUE, label: 'No assignee', kind: 'assignee', count: 1 },
          ]}
          assigneeNameById={new Map()}
          onOpenQuickView={() => {}}
          onSetWipLimit={() => {}}
          activeCardId={null}
          overLaneKey={null}
        />
      </DndContext>,
    );
    const row = screen.getByTestId('swimlane-board');
    expect(row.className).toContain('[scrollbar-width:none]');
    expect(row.querySelectorAll('[data-board-column-edge]')).toHaveLength(4);

    // The pinned header's empty space is background.
    const header = row.querySelector('[data-board-column-edge]')!;
    drag(header, 400, 330);
    expect(row.scrollLeft).toBe(70);
    release(330);
    // No snap here: the pan stays where it was released.
    expect(row.scrollLeft).toBe(70);

    drag(screen.getByTestId('board-card-PROD-1'), 400, 100);
    expect(row.scrollLeft).toBe(70);
    release(100);

    fireEvent.click(screen.getByRole('button', { name: 'Next column' }));
    expect(row.scrollLeft).toBe(304);
  });
});
