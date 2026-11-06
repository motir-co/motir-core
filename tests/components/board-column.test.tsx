// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardColumn } from '@/app/(authed)/boards/_components/BoardColumn';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// BoardColumn (Subtask 3.2.3 · scale 3.2.5 · WIP 3.3.6 · load model 3.8.3): a column
// header (name + per-column total count + the WIP chip + the `[⋯]` actions menu)
// over a card stack, with the designed empty-column state. The 3.8.3 load-model
// CORRECTION (`notes.html` mistake #33) renders the WHOLE bounded 3.8.2 set with NO
// "Load more" affordance at all — no button, no scroll-to-load sentinel, no
// in-flight spinner, no inline retry — exactly as a Jira board behaves; the stack
// still virtualizes via `useRowWindow` so a tall column stays DOM-bounded. Rendered
// with the real `en` catalog. Under happy-dom there is no measurable scroll
// viewport, so the windowing degrades to render-all (no absolute positioning).

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

const noop = () => {};

function renderColumn(
  col: BoardColumnDto,
  extra: Partial<{
    onOpenQuickView: (id: string) => void;
    activeCardId: string | null;
    onSetWipLimit: (columnId: string, limit: number | null) => void;
  }> = {},
) {
  return render(
    <BoardColumn
      column={col}
      boardId="b1"
      assigneeNameById={new Map()}
      onOpenQuickView={extra.onOpenQuickView ?? noop}
      activeCardId={extra.activeCardId ?? null}
      onSetWipLimit={extra.onSetWipLimit ?? noop}
    />,
  );
}

afterEach(cleanup);

describe('BoardColumn', () => {
  it('renders the column name and the per-column total count', () => {
    renderColumn(
      column({ id: 'c1', name: 'To Do', totalCount: 8, cards: [card({ id: 'w1', key: 1 })] }),
    );
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeTruthy();
    // The count is the projection total, not the loaded card length.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('8');
    expect(screen.getByTestId('board-card-PROD-1')).toBeTruthy();
  });

  it('renders the empty-column placeholder when the column has no cards', () => {
    renderColumn(column({ id: 'c2', name: 'In Review', totalCount: 0 }));
    expect(screen.getByText('No work items')).toBeTruthy();
    expect(screen.queryByTestId(/^board-card-/)).toBeNull();
  });

  it('resolves a card assignee id to its display name via the lookup', () => {
    render(
      <BoardColumn
        column={column({
          id: 'c1',
          name: 'To Do',
          totalCount: 1,
          cards: [card({ id: 'w1', key: 1, assigneeId: 'u1' })],
        })}
        boardId="b1"
        assigneeNameById={new Map([['u1', 'Bea Lin']])}
        onOpenQuickView={noop}
        activeCardId={null}
        onSetWipLimit={noop}
      />,
    );
    expect(screen.getByTitle('Assigned to Bea Lin')).toBeTruthy();
  });

  // 3.8.3 — the load-model CORRECTION (`notes.html` mistake #33): the column loads
  // the WHOLE bounded 3.8.2 set, so EVERY "Load more" affordance is gone — no
  // button, no scroll-to-load sentinel, no in-flight spinner, no inline retry. Even
  // a (now-permanently-null) cursor + a big total surfaces none of them; the cards
  // render directly and the header count stays the full denominator.
  it('renders NO load-more affordance at all — no button, spinner, or retry (3.8.3)', () => {
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        // `cursor` is permanently null post-3.8.2; even a stray non-null value must
        // not resurrect a load-more affordance — the flat board no longer reads it.
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 }), card({ id: 'w2', key: 2 })],
      }),
    );
    // None of the retired affordances may render.
    expect(screen.queryByTestId('board-load-more-c1')).toBeNull();
    expect(screen.queryByTestId('board-load-more-retry-c1')).toBeNull();
    expect(screen.queryByTestId('board-loading-more-c1')).toBeNull();
    expect(screen.queryByText('Load more')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
    // The whole bounded set renders directly; the header count is the full total.
    expect(screen.getByTestId('board-card-PROD-1')).toBeTruthy();
    expect(screen.getByTestId('board-card-PROD-2')).toBeTruthy();
    expect(screen.getByTestId('board-count-c1').textContent).toBe('60');
  });

  it('keeps a tall column DOM-bounded by windowing once a scroll viewport is measurable (3.8.3)', () => {
    // happy-dom does no layout, so `useRowWindow` measures a 0-height viewport and
    // degrades to render-all. Give the column body a measurable `clientHeight` so
    // the hook windows: a 1000-card column must mount only a bounded slice — proving
    // virtualization (the 2.5.15 `useRowWindow`) is KEPT after the "Load more"
    // removal. getBoundingClientRect stays happy-dom's all-zeros (scroll-invariant
    // body offset 0), which is the geometry the hook expects.
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 600;
      },
    });
    try {
      const cards = Array.from({ length: 1000 }, (_, i) => card({ id: `w${i}`, key: i }));
      renderColumn(column({ id: 'c1', name: 'To Do', totalCount: 1000, cards }));
      const mounted = screen.queryAllByTestId(/^board-card-/);
      // Bounded: only a window of the 1000 cards is in the DOM, not the whole set.
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(1000);
      // The header still surfaces the FULL count (the denominator), not the window.
      expect(screen.getByTestId('board-count-c1').textContent).toBe('1000');
    } finally {
      if (prior) Object.defineProperty(HTMLElement.prototype, 'clientHeight', prior);
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it('renders every column at the same fixed height regardless of card count (3.2.8)', () => {
    renderColumn(
      column({ id: 'c1', name: 'To Do', totalCount: 1, cards: [card({ id: 'w1', key: 1 })] }),
    );
    const section = screen.getByTestId('board-column-c1');
    // A uniform viewport-relative height, not the old content-hugging max-height.
    //
    // Asserted by SHAPE rather than by the exact string (MOTIR-2763). This used
    // to pin the literal `h-[calc(100dvh-12rem)]`, which made it a referrer of a
    // number that legitimately moves: the constant encodes how much chrome sits
    // above and below the board, and the shell's bottom reservation changed. The
    // three clauses below are the contract this test actually exists to hold —
    // an explicit viewport-derived `h-`, never a `max-h-` (which would let a
    // short column hug its content again) — plus the MOTIR-2763 rule that the
    // BELOW-term is spent from the shell's variable rather than baked in, so a
    // future change to the orb clearance cannot silently push the board past the
    // fold. See `design/shell/design-notes.md`.
    expect(section.className).toMatch(/(?:^|\s)h-\[calc\(100dvh[^\]]*\)\]/);
    expect(section.className).toContain('var(--shell-bottom-clearance,1.5rem)');
    expect(section.className).not.toMatch(/max-h-\[calc\(100dvh/);
  });
});

// The WIP chip — under / at / over (strictly-greater) + the no-limit plain
// state. SOFT: the over state is a presentational warning ONLY (it never gates
// a drop). Per panel 6 of `design/boards/swimlanes-wip.mock.html`.
describe('BoardColumn — WIP chip (3.3.6)', () => {
  it('shows no WIP chip when the column has no limit (plain count only)', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 8, wipLimit: null }));
    expect(screen.queryByTestId('board-wip-c1')).toBeNull();
    expect(screen.getByTestId('board-count-c1').textContent).toBe('8');
  });

  it('renders the quiet `n/limit` chip UNDER the limit, no warning', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 3, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toBe('3/5');
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.getAttribute('data-over')).toBeNull();
  });

  it('does NOT warn AT the limit (n == limit is at-limit, not over)', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 5, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toBe('5/5');
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.getAttribute('data-over')).toBeNull();
  });

  it('warns OVER the limit (n > limit) with a status role + paired icon, not colour-alone', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 6, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toContain('6/5');
    expect(chip.getAttribute('data-over')).toBe('true');
    expect(chip.getAttribute('role')).toBe('status');
    expect(chip.getAttribute('aria-label')).toBe('6 of 5 work items — over the WIP limit');
    expect(chip.querySelector('svg')).toBeTruthy();
  });
});

// The column `[⋯]` menu's "Set WIP limit" editor (panel 5). Save parses the
// integer and hands it up; Clear hands up null; an invalid entry is blocked
// client-side and never reaches the handler.
describe('BoardColumn — WIP config menu (3.3.6)', () => {
  function openMenu(
    onSetWipLimit: (id: string, n: number | null) => void,
    wipLimit: number | null = null,
  ) {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 3, wipLimit }), {
      onSetWipLimit,
    });
    fireEvent.click(screen.getByTestId('board-column-actions-c1'));
    fireEvent.click(screen.getByText('Set WIP limit'));
  }

  it('saves a valid non-negative integer via onSetWipLimit', () => {
    const onSet = vi.fn();
    openMenu(onSet);
    fireEvent.change(screen.getByTestId('board-wip-input-c1'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSet).toHaveBeenCalledWith('c1', 4);
  });

  it('clears the limit (onSetWipLimit with null) via Clear', () => {
    const onSet = vi.fn();
    openMenu(onSet, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSet).toHaveBeenCalledWith('c1', null);
  });

  it('blocks an invalid (negative / non-integer) entry client-side and does not call onSetWipLimit', () => {
    const onSet = vi.fn();
    openMenu(onSet);
    fireEvent.change(screen.getByTestId('board-wip-input-c1'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-wip-error-c1').textContent).toBe(
      'Enter a non-negative whole number.',
    );
  });
});
