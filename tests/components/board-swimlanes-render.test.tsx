// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { SwimlaneBoard } from '@/app/(authed)/boards/_components/SwimlaneBoard';
import { COLLAPSED_LANES_STORAGE_PREFIX } from '@/lib/hooks/useCollapsedLanes';
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

function renderBoard(boardId: string) {
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
  // (epics.ts, Epic 3). The lane wrapper MUST carry `min-w-max` so the lane
  // grows to the column-track width; otherwise the lane-header band collapses
  // to the scroller's clientWidth and stops at the viewport edge, leaving
  // scrolled-into-view columns (e.g. Cancelled) un-banded. The sticky-left
  // behaviour must live on the INNER chevron/label/count wrapper, NOT on the
  // band — sticky on the band itself re-introduces the bug because a
  // `sticky left-0 w-full` child of an overflow-x scroller pins to the
  // scroller's clientWidth, not its scrollWidth. We assert the structural
  // shape here because happy-dom does not compute layout
  // (`getBoundingClientRect()` returns zeros), so a width-measurement check
  // is a no-op in this test environment.
  it('the lane wrapper grows to the column track so the band spans all columns', () => {
    renderBoard('b-band-spans');
    for (const key of ['u1', 'u2', BOARD_SWIMLANE_NO_VALUE]) {
      const lane = screen.getByTestId(`swimlane-${key}`);
      expect(lane.className).toContain('min-w-max');
      // The band (lane head) itself must NOT be sticky — pinning the band
      // collapses it to clientWidth. Only its inner content sticks.
      const head = screen.getByTestId(`swimlane-head-${key}`);
      expect(head.className).not.toMatch(/(^|\s)sticky(\s|$)/);
      // Inner sticky element carries the chevron + label + count.
      // (Testid deliberately drops the hyphen between "head" and "content" so
      // the inner doesn't collide with `^swimlane-head-` queries used by other
      // tests in this file to enumerate lane heads 1:1.)
      const inner = screen.getByTestId(`swimlane-headcontent-${key}`);
      expect(inner.className).toContain('sticky');
      expect(inner.className).toMatch(/(^|\s)left-6(\s|$)/);
      // The count chip lives inside the sticky inner element (so the chip
      // travels with the label as the user scrolls horizontally).
      const count = within(inner).getByTestId(`swimlane-count-${key}`);
      expect(count).toBeTruthy();
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
