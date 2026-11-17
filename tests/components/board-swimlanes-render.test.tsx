// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { SwimlaneBoard } from '@/app/(authed)/boards/_components/SwimlaneBoard';
import { COLLAPSED_LANES_STORAGE_PREFIX } from '@/lib/hooks/useCollapsedLanes';
import {
  applyLanePage,
  cellPageOf,
  cellSummary,
  emptyCellPages,
} from '@/app/(authed)/boards/_components/boardCellPages';
import type { BoardCellPagesApi } from '@/app/(authed)/boards/_components/useBoardCellPages';
import { createLaneScrollStore } from '@/app/(authed)/boards/_components/laneScrollStore';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneDto,
} from '@/lib/dto/boards';

// SwimlaneBoard (Subtask 3.3.5; load model corrected by 3.8.5): the board
// re-laid into a (column × lane) grid. Rendered with the real `en` catalog inside
// a DndContext (LaneCell registers a dnd-kit droppable, BoardCard a sortable).
// Under happy-dom windowing degrades to render-all. Covers lane rendering +
// ordering (catch-all last), bucketing by swimlaneKey, the per-lane aggregate
// count, collapse persistence, that NO per-column "Load more" footer renders
// post-3.8.5 (the board loads the whole bounded set; mistake #33), and the
// lane-wrapper-grows-to-track regression for the
// `bug-swimlane-lane-header-not-spanning-scrolled-columns` Epic-3 bug.

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

const COLUMNS = [
  column({
    id: 'c1',
    name: 'To Do',
    totalCount: 3,
    cards: [
      card({ id: 'w1', key: 1, swimlaneKey: 'u1', assigneeId: 'u1' }),
      card({ id: 'w2', key: 2, swimlaneKey: 'u2', assigneeId: 'u2' }),
      card({ id: 'w3', key: 3 }), // no assignee → catch-all
    ],
  }),
  column({
    id: 'c2',
    name: 'Done',
    totalCount: 1,
    cards: [card({ id: 'w4', key: 4, swimlaneKey: 'u1', assigneeId: 'u1' })],
  }),
];

const SWIMLANES: BoardSwimlaneDto[] = [
  { key: 'u1', label: 'Ana Ruiz', kind: 'assignee', count: 2 },
  { key: 'u2', label: 'Bea Lin', kind: 'assignee', count: 1 },
  { key: BOARD_SWIMLANE_NO_VALUE, label: 'No assignee', kind: 'assignee', count: 1 },
];

const noop = () => {};

/** A per-cell API over a fixed map, as `useBoardCellPages` hands the grid one. */
function cellsApi(cells: Parameters<typeof applyLanePage>[2]): BoardCellPagesApi {
  const pages = applyLanePage(emptyCellPages('k'), 'k', cells);
  return {
    readKey: 'k',
    pages,
    cellState: (c, l) => cellPageOf(pages, 'k', c, l),
    cellSummary: (c, l) => cellSummary(cellPageOf(pages, 'k', c, l)),
    loadCell: noop,
    retryCell: noop,
    loadedLane: noop,
    laneRef: () => noop,
    applyCells: noop,
  };
}

function renderBoard(boardId: string, cells?: BoardCellPagesApi) {
  return render(
    <DndContext>
      <SwimlaneBoard
        boardId={boardId}
        columns={COLUMNS}
        swimlanes={SWIMLANES}
        assigneeNameById={
          new Map([
            ['u1', 'Ana Ruiz'],
            ['u2', 'Bea Lin'],
          ])
        }
        onOpenQuickView={noop}
        onSetWipLimit={noop}
        activeCardId={null}
        overLaneKey={null}
        cells={cells}
      />
    </DndContext>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('SwimlaneBoard', () => {
  it('renders one lane per projection swimlane, catch-all sorted last', () => {
    renderBoard('b-order');
    const heads = screen.getAllByTestId(/^swimlane-head-/);
    expect(heads.map((h) => h.getAttribute('data-testid'))).toEqual([
      'swimlane-head-u1',
      'swimlane-head-u2',
      `swimlane-head-${BOARD_SWIMLANE_NO_VALUE}`,
    ]);
  });

  it('buckets each card into its (lane, column) cell by swimlaneKey', () => {
    renderBoard('b-bucket');
    // w1 (u1) and w4 (u1) sit in lane u1's c1 / c2 cells; w2 (u2) in lane u2's c1.
    expect(
      within(screen.getByTestId('lane-cell-c1-u1')).getByTestId('board-card-PROD-1'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lane-cell-c2-u1')).getByTestId('board-card-PROD-4'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lane-cell-c1-u2')).getByTestId('board-card-PROD-2'),
    ).toBeTruthy();
    // The keyless card lands in the catch-all lane's c1 cell.
    expect(
      within(screen.getByTestId(`lane-cell-c1-${BOARD_SWIMLANE_NO_VALUE}`)).getByTestId(
        'board-card-PROD-3',
      ),
    ).toBeTruthy();
  });

  it('with the per-cell API supplied, each cell shows its own page and the header sums them', () => {
    // The cell pages, not the column's page, decide what each cell holds: lane u1
    // holds w9 in c1 (a card the column's page does not carry), lane u2 nothing.
    const cell = (
      columnId: string,
      laneKey: string,
      cards: BoardCardDto[],
      totalCount: number,
    ) => ({
      columnId,
      laneKey,
      cards,
      totalCount,
      cursor: cards.length < totalCount ? 'CUR' : null,
      planHolds: {},
    });
    renderBoard(
      'b-cells',
      cellsApi([
        cell('c1', 'u1', [card({ id: 'w9', key: 9, swimlaneKey: 'u1' })], 2),
        cell('c2', 'u1', [card({ id: 'w4', key: 4, swimlaneKey: 'u1' })], 1),
        cell('c1', 'u2', [], 0),
      ]),
    );
    expect(
      within(screen.getByTestId('lane-cell-c1-u1')).getByTestId('board-card-PROD-9'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lane-cell-c1-u1')).queryByTestId('board-card-PROD-1'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('lane-cell-c2-u1')).getByTestId('board-card-PROD-4'),
    ).toBeTruthy();
    // A cell no page has reached is empty, whatever the column's page holds.
    expect(
      within(screen.getByTestId('lane-cell-c1-u2')).queryByTestId('board-card-PROD-2'),
    ).toBeNull();
    // The header: loaded = the distinct cards over the column's cells, over its total.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('1 of 3');
    expect(screen.getByTestId('board-count-c2').textContent).toBe('1');
  });

  it('shows the per-lane aggregate count from the projection', () => {
    renderBoard('b-count');
    expect(screen.getByTestId('swimlane-count-u1').textContent).toBe('2');
    expect(screen.getByTestId('swimlane-count-u2').textContent).toBe('1');
  });

  it('renders the per-column total count in the pinned header', () => {
    renderBoard('b-colcount');
    expect(screen.getByTestId('board-count-c1').textContent).toBe('3');
    expect(screen.getByTestId('board-count-c2').textContent).toBe('1');
  });

  it('reads persisted collapse state on mount (lane hidden, header kept)', () => {
    window.localStorage.setItem(
      COLLAPSED_LANES_STORAGE_PREFIX + 'b-persist',
      JSON.stringify(['u1']),
    );
    renderBoard('b-persist');
    // u1 collapsed → its cells are not rendered, but its header + count remain.
    expect(screen.queryByTestId('lane-cell-c1-u1')).toBeNull();
    expect(screen.getByTestId('swimlane-head-u1')).toBeTruthy();
    expect(screen.getByTestId('swimlane-count-u1').textContent).toBe('2');
    // u2 stays expanded.
    expect(screen.getByTestId('lane-cell-c1-u2')).toBeTruthy();
  });

  it('toggling a lane collapses it and persists the choice to localStorage', () => {
    renderBoard('b-toggle');
    expect(screen.getByTestId('lane-cell-c1-u1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('swimlane-head-u1'));
    expect(screen.queryByTestId('lane-cell-c1-u1')).toBeNull();
    const stored = window.localStorage.getItem(COLLAPSED_LANES_STORAGE_PREFIX + 'b-toggle');
    expect(JSON.parse(stored ?? '[]')).toContain('u1');
  });

  // Subtask 3.8.5 (mistake #33): the board loads the whole bounded set, so the
  // per-column "Load more" footer is gone — Jira never pages a board. The cells
  // bucket every loaded card directly (the lane/bucket assertions above prove the
  // full set still renders); there is no load-more affordance to fire.
  it('renders no per-column "Load more" footer (the bounded set loads whole)', () => {
    renderBoard('b-no-load-more');
    expect(screen.queryAllByTestId(/^board-load-more-/)).toHaveLength(0);
    expect(screen.queryByTestId('board-load-more-c1')).toBeNull();
    expect(screen.queryByTestId('board-load-more-c2')).toBeNull();
  });

  // Regression: `bug-swimlane-lane-header-not-spanning-scrolled-columns`
  // (epics.ts, Epic 3), re-scoped per lane by MOTIR-11449. The band once sat
  // inside the board's single scroller and stopped at the viewport edge; now each
  // lane is its own scroller and the band sits ABOVE it (design MOTIR-11443 § *The
  // lane header*: "spans the board and never scrolls"). So the guarantees are
  // structural: the band is never sticky and never inside the lane's scroller (it
  // cannot scroll away), its label rail + count live inside it (pinned at the left
  // at any lane offset), and the lane's own track inside the scroller grows to the
  // column track (`min-w-max`). happy-dom does not compute layout, so the
  // measurement itself is the browser's (the e2e suites).
  it('the band sits above the lane scroller, never sticky, its label rail pinned', () => {
    renderBoard('b-band-spans');
    for (const key of ['u1', 'u2', BOARD_SWIMLANE_NO_VALUE]) {
      const lane = screen.getByTestId(`swimlane-${key}`);
      const scroller = screen.getByTestId(`swimlane-scroller-${key}`);
      expect(lane.contains(scroller)).toBe(true);
      const head = screen.getByTestId(`swimlane-head-${key}`);
      expect(head.className).not.toMatch(/(^|\s)sticky(\s|$)/);
      expect(scroller.contains(head)).toBe(false);
      const inner = screen.getByTestId(`swimlane-headcontent-${key}`);
      expect(head.contains(inner)).toBe(true);
      expect(scroller.contains(inner)).toBe(false);
      // The count chip travels with the label, in the rail.
      expect(within(inner).getByTestId(`swimlane-count-${key}`)).toBeTruthy();
      // The lane's own track grows to the column track inside its scroller.
      expect(scroller.contains(screen.getByTestId(`swimlane-track-${key}`))).toBe(true);
      expect(screen.getByTestId(`swimlane-track-${key}`).className).toContain('min-w-max');
    }
  });

  // Regression: `bug-swimlane-collapsed-lane-header-not-full-width` (epics.ts,
  // Epic 3) — the SECOND occurrence of the prior bug's shape. The prior fix put
  // `min-w-max` on the lane wrapper, but its `max-content` was established by the
  // `!isCollapsed` cell-row; collapsing pulled that row out of layout, so the
  // wrapper (and its band) shrank to the header-only / scroller width and the
  // rightmost columns sat OUTSIDE the band. The fix renders a width-establishing
  // spacer track (one `w-72 shrink-0` cell per column, same `track` gutter)
  // OUTSIDE the ternary, so the wrapper keeps the full column-track `max-content`
  // in BOTH states. We assert that structural invariant here: the spacer track is
  // present with a cell per column whether the lane is collapsed or expanded.
  // (happy-dom doesn't compute layout — `getBoundingClientRect()` returns zeros —
  // so the real "band offsetWidth === track width" measurement is verified in a
  // real browser, not here; same posture as the prior sibling-bug test above.)
  it('renders the width-establishing spacer track in BOTH collapsed and expanded states', () => {
    // u1 starts collapsed (persisted); u2 stays expanded.
    window.localStorage.setItem(
      COLLAPSED_LANES_STORAGE_PREFIX + 'b-collapsed-band',
      JSON.stringify(['u1']),
    );
    renderBoard('b-collapsed-band');

    // Collapsed lane: real cell-row is gone, but the spacer track remains and
    // carries one spacer cell per column — this is what keeps the band full-width.
    expect(screen.queryByTestId('lane-cell-c1-u1')).toBeNull();
    const collapsedTrack = screen.getByTestId('swimlane-track-u1');
    expect(collapsedTrack.className).toContain('min-w-max');
    expect(collapsedTrack.children).toHaveLength(COLUMNS.length);
    // It must contribute width WITHOUT painting or taking vertical space.
    expect(collapsedTrack.className).toContain('invisible');
    expect(collapsedTrack.className).toMatch(/(^|\s)h-0(\s|$)/);

    // Expanded lane: the spacer track is present too (same width source in both
    // states → collapse/expand never changes the band's rendered width).
    expect(screen.getByTestId('lane-cell-c1-u2')).toBeTruthy();
    const expandedTrack = screen.getByTestId('swimlane-track-u2');
    expect(expandedTrack.className).toContain('min-w-max');
    expect(expandedTrack.children).toHaveLength(COLUMNS.length);
  });
});

describe('SwimlaneBoard lanes scroll on their own (MOTIR-11449)', () => {
  it('gives each lane its own scroller; the board root does not scroll sideways', () => {
    renderBoard('b-scrollers');
    const root = screen.getByTestId('swimlane-board');
    expect(root.className).not.toContain('overflow-x-auto');
    const s1 = screen.getByTestId('swimlane-scroller-u1');
    const s2 = screen.getByTestId('swimlane-scroller-u2');
    expect(s1.className).toContain('overflow-x-auto');
    expect(s1.className).toContain('[scrollbar-width:none]');
    s1.scrollLeft = 304;
    fireEvent.scroll(s1);
    expect(s1.scrollLeft).toBe(304);
    expect(s2.scrollLeft).toBe(0);
    expect(root.scrollLeft).toBe(0);
  });

  it('drives the column-header track from the active lane; others draw a column-name strip', () => {
    renderBoard('b-follow');
    const header = screen.getByTestId('swimlane-header-track');
    // Clipped, not scrollable; at 0 before any lane was acted on, no strips.
    expect(header.parentElement!.className).toContain('overflow-x-hidden');
    expect(header.style.transform).toBe('');
    expect(screen.queryByTestId(/^swimlane-strip-/)).toBeNull();

    const s1 = screen.getByTestId('swimlane-scroller-u1');
    act(() => {
      s1.scrollLeft = 304;
      fireEvent.scroll(s1);
    });
    expect(header.style.transform).toBe('translateX(-304px)');
    // The active lane draws no strip; the lanes still at 0 now differ and do.
    expect(screen.queryByTestId('swimlane-strip-u1')).toBeNull();
    const strip = screen.getByTestId('swimlane-strip-u2');
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.textContent).toContain('To Do');

    // Focusing another lane hands the header to it, and the first lane keeps its
    // offset and gains its strip.
    act(() => {
      fireEvent.focus(screen.getByTestId('swimlane-scroller-u2'));
    });
    expect(header.style.transform).toBe('');
    expect(screen.getByTestId('swimlane-strip-u1')).toBeTruthy();
    expect(screen.queryByTestId('swimlane-strip-u2')).toBeNull();
    expect(s1.scrollLeft).toBe(304);
  });

  it('names each cell by its column for assistive tech and marks its column edge', () => {
    renderBoard('b-names');
    const cell = screen.getByTestId('lane-cell-c2-u1');
    const wrapper = cell.parentElement!;
    expect(wrapper.getAttribute('role')).toBe('group');
    expect(wrapper.getAttribute('aria-label')).toBe('Done');
    expect(wrapper.hasAttribute('data-board-column-edge')).toBe(true);
  });

  it('observes only expanded lanes through the hook’s laneRef, once each', () => {
    window.localStorage.setItem(
      COLLAPSED_LANES_STORAGE_PREFIX + 'b-observe',
      JSON.stringify(['u1']),
    );
    const attached: string[] = [];
    const api: BoardCellPagesApi = {
      ...cellsApi([]),
      laneRef: (laneKey) => (el) => {
        if (el) attached.push(laneKey);
      },
    };
    renderBoard('b-observe', api);
    // u1 is collapsed: no cells and nothing observed. The others, once.
    expect(screen.queryByTestId('swimlane-cells-u1')).toBeNull();
    expect(attached.sort()).toEqual([BOARD_SWIMLANE_NO_VALUE, 'u2'].sort());
    // A collapsed lane draws no arrows (nor does any lane whose cells fit).
    expect(screen.queryByTestId('swimlane-arrow-left-u1')).toBeNull();
  });

  it('draws an empty lane as one line, with no cells and nothing observed', () => {
    const attached: string[] = [];
    render(
      <DndContext>
        <SwimlaneBoard
          boardId="b-empty"
          columns={COLUMNS}
          swimlanes={[{ key: 'u9', label: 'Cara Diaz', kind: 'assignee', count: 0 }]}
          assigneeNameById={new Map()}
          onOpenQuickView={noop}
          onSetWipLimit={noop}
          activeCardId={null}
          overLaneKey={null}
          cells={{
            ...cellsApi([]),
            laneRef: (laneKey) => (el) => {
              if (el) attached.push(laneKey);
            },
          }}
        />
      </DndContext>,
    );
    expect(screen.getByTestId('swimlane-empty-u9').textContent).toBe('No work items in this lane');
    expect(screen.queryByTestId('lane-cell-c1-u9')).toBeNull();
    expect(screen.getByTestId('swimlane-count-u9').textContent).toBe('0');
    expect(attached).toEqual([]);
  });

  it('labels each dimension’s lane and toggles collapse from the keyboard', () => {
    render(
      <DndContext>
        <SwimlaneBoard
          boardId="b-dims"
          columns={COLUMNS}
          swimlanes={[
            { key: 'high', label: 'High', kind: 'priority', count: 1 },
            { key: 'e1', label: 'PROD-7 Billing', kind: 'epic', count: 1 },
          ]}
          assigneeNameById={new Map()}
          onOpenQuickView={noop}
          onSetWipLimit={noop}
          activeCardId={null}
          overLaneKey={null}
        />
      </DndContext>,
    );
    expect(screen.getByTestId('swimlane-headcontent-high').textContent).toContain('High');
    expect(screen.getByTestId('swimlane-headcontent-e1').textContent).toContain('PROD-7 Billing');
    const head = screen.getByTestId('swimlane-head-e1');
    fireEvent.keyDown(head, { key: 'Enter' });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('swimlane-cells-e1')).toBeNull();
    fireEvent.keyDown(head, { key: ' ' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(head, { key: 'Tab' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('laneScrollStore', () => {
  it('follows the last lane acted on and tells each lane whether it is off the header', () => {
    const store = createLaneScrollStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    expect(store.activeLane()).toBeNull();
    expect(store.headerOffset()).toBe(0);
    store.follow('u1', 304);
    expect(store.activeLane()).toBe('u1');
    expect(store.headerOffset()).toBe(304);
    expect(store.offsetOf('u1')).toBe(304);
    expect(store.showsStrip('u1')).toBe(false);
    expect(store.showsStrip('u2')).toBe(true);
    // The same lane at the same offset notifies nobody.
    store.follow('u1', 304);
    expect(seen).toHaveBeenCalledTimes(1);
    // Within the tolerance a lane reads as aligned.
    store.follow('u2', 305);
    expect(store.showsStrip('u1')).toBe(false);
    off();
    store.follow('u1', 0);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

// MOTIR-11585 — the field lanes' headers: each wears the chip or glyph the item
// page shows, names its value in the reader's locale, and each new catch-all
// reads its own translated "No …".
describe('SwimlaneBoard field lane headers', () => {
  function renderLanes(swimlanes: BoardSwimlaneDto[]) {
    return render(
      <DndContext>
        <SwimlaneBoard
          boardId="b-fields"
          columns={COLUMNS}
          swimlanes={swimlanes}
          assigneeNameById={new Map()}
          onOpenQuickView={noop}
          onSetWipLimit={noop}
          activeCardId={null}
          overLaneKey={null}
        />
      </DndContext>,
    );
  }
  const head = (key: string) => screen.getByTestId(`swimlane-headcontent-${key}`);
  const lane = (kind: BoardSwimlaneDto['kind'], key: string, label = key): BoardSwimlaneDto => ({
    key,
    label,
    kind,
    count: 1,
  });

  it('enum lanes read their translated value, their catch-alls their own name', () => {
    renderLanes([
      lane('type', 'code'),
      lane('difficulty', 'high'),
      lane('executor', 'coding_agent'),
      lane('executor', 'human'),
      lane('type', BOARD_SWIMLANE_NO_VALUE, 'No type'),
    ]);
    expect(head('code').textContent).toContain('Code');
    expect(head('high').textContent).toMatch(/High/);
    expect(head('coding_agent').textContent).not.toContain('coding_agent');
    expect(head('coding_agent').querySelector('svg.lucide-bot')).not.toBeNull();
    expect(head('human').querySelector('svg.lucide-user')).not.toBeNull();
    expect(head(BOARD_SWIMLANE_NO_VALUE).textContent).toContain('No type');
    // The collapse control is named by the same words.
    expect(screen.getByRole('button', { name: /Collapse.*Code|Code.*collapse/i })).toBeTruthy();
  });

  it('kind lanes wear the kind’s icon; tag lanes their glyph and the server’s name', () => {
    renderLanes([
      lane('kind', 'story'),
      lane('label', 'l1', 'ui'),
      lane('component', 'k1', 'Billing'),
      lane('repository', 'r1', 'motir-core'),
      lane('reporter', 'p1', 'Ana Ruiz'),
      lane('label', BOARD_SWIMLANE_NO_VALUE, 'No label'),
    ]);
    expect(head('story').textContent).toContain('Story');
    expect(head('l1').querySelector('svg.lucide-tag')).not.toBeNull();
    expect(head('l1').textContent).toContain('ui');
    expect(head('k1').querySelector('svg.lucide-puzzle')).not.toBeNull();
    expect(
      head('r1').querySelector('svg.lucide-folder-git-2, svg.lucide-folder-git2'),
    ).not.toBeNull();
    expect(head('r1').textContent).toContain('motir-core');
    expect(head('p1').textContent).toContain('Ana Ruiz');
    expect(head(BOARD_SWIMLANE_NO_VALUE).textContent).toContain('No label');
  });

  it('the column header counts a card shown in two label lanes once (MOTIR-11585)', () => {
    // Column c1 holds 3 cards: w1 carries labels l1 AND l2, w2 only l1, w3 none.
    // Every cell is fully loaded, so the header reads the total with no "of".
    const both = (laneKey: string) => card({ id: 'w1', key: 1, swimlaneKey: laneKey });
    const page = (
      columnId: string,
      laneKey: string,
      cards: BoardCardDto[],
      totalCount: number,
    ) => ({
      columnId,
      laneKey,
      cards,
      totalCount,
      cursor: null,
      planHolds: {},
    });
    const api = cellsApi([
      page('c1', 'l1', [both('l1'), card({ id: 'w2', key: 2, swimlaneKey: 'l1' })], 2),
      page('c1', 'l2', [both('l2')], 1),
      page('c1', BOARD_SWIMLANE_NO_VALUE, [card({ id: 'w3', key: 3 })], 1),
    ]);
    render(
      <DndContext>
        <SwimlaneBoard
          boardId="b-multi"
          columns={[column({ id: 'c1', name: 'To Do', totalCount: 3 })]}
          swimlanes={[
            lane('label', 'l1', 'api'),
            lane('label', 'l2', 'ui'),
            lane('label', BOARD_SWIMLANE_NO_VALUE, 'No label'),
          ]}
          assigneeNameById={new Map()}
          onOpenQuickView={noop}
          onSetWipLimit={noop}
          activeCardId={null}
          overLaneKey={null}
          cells={api}
        />
      </DndContext>,
    );
    // Four renderings, three cards: the header says 3, not "4 of 3".
    expect(screen.getAllByTestId('board-card-PROD-1')).toHaveLength(2);
    expect(screen.getByTestId('board-count-c1').textContent).toBe('3');
  });

  it('a column header still shows more to load while a multi-value lane is unloaded', () => {
    const page = (
      columnId: string,
      laneKey: string,
      cards: BoardCardDto[],
      totalCount: number,
    ) => ({
      columnId,
      laneKey,
      cards,
      totalCount,
      cursor: null,
      planHolds: {},
    });
    // Column of 4: the loaded l1 and l2 cells hold w1 twice and w2 (2 distinct);
    // a sum would read 3 of 4. The no-label lane has not loaded yet.
    const api = cellsApi([
      page(
        'c1',
        'l1',
        [
          card({ id: 'w1', key: 1, swimlaneKey: 'l1' }),
          card({ id: 'w2', key: 2, swimlaneKey: 'l1' }),
        ],
        2,
      ),
      page('c1', 'l2', [card({ id: 'w1', key: 1, swimlaneKey: 'l2' })], 1),
    ]);
    render(
      <DndContext>
        <SwimlaneBoard
          boardId="b-multi-more"
          columns={[column({ id: 'c1', name: 'To Do', totalCount: 4 })]}
          swimlanes={[
            lane('label', 'l1', 'api'),
            lane('label', 'l2', 'ui'),
            lane('label', BOARD_SWIMLANE_NO_VALUE, 'No label'),
          ]}
          assigneeNameById={new Map()}
          onOpenQuickView={noop}
          onSetWipLimit={noop}
          activeCardId={null}
          overLaneKey={null}
          cells={api}
        />
      </DndContext>,
    );
    expect(screen.getByTestId('board-count-c1').textContent).toBe('2 of 4');
  });

  it('an enum value the glossary does not know falls back to the server label', () => {
    renderLanes([
      lane('kind', 'theme', 'Theme (new)'),
      lane('kind', BOARD_SWIMLANE_NO_VALUE, 'None'),
    ]);
    expect(head('theme').textContent).toContain('Theme (new)');
    // A catch-all with no translated name of its own keeps the server's label.
    expect(head(BOARD_SWIMLANE_NO_VALUE).textContent).toContain('None');
  });
});
