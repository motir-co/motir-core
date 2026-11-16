'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

// The board's horizontal navigation (MOTIR-11323, design MOTIR-11326
// `design/boards/board--column-arrows.mock.html`): the drag-to-pan gesture and the
// column-arrow state, shared by the flat row (`BoardContainer`) and the swimlane
// container (`SwimlaneBoard`). Both are plain DOM behaviour on the board scroll
// row, so they live in hooks over its ref rather than in either board.

/** Marks each column's left edge inside a board scroll row — the arrows' landing points. */
export const COLUMN_EDGE_ATTR = 'data-board-column-edge';

/**
 * The classes every board scroll row wears for its horizontal navigation
 * (design-notes § *No visible horizontal scrollbar*, § *The pan cursor*):
 * - no native scrollbar at any width (`scrollbar-width: none` + the WebKit
 *   pseudo-element) — the row still scrolls by trackpad, wheel, keyboard, touch,
 *   the arrows and the pan;
 * - `grab` over empty background, `grabbing` over everything while a pan runs,
 *   snap off and no text selection mid-pan;
 * - the cursor is SCOPED so it does not flow into controls that set none: a
 *   button keeps the default arrow, a link the pointer, an input the text cursor.
 *   The scoping rules sit in `:where()` (no specificity), so a card's own shipped
 *   `cursor-grab` and a lane header's `cursor-pointer` still win.
 */
export const BOARD_SCROLL_NAV_CLASS =
  '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden cursor-grab data-[panning]:cursor-grabbing data-[panning]:**:cursor-grabbing data-[panning]:snap-none data-[panning]:select-none [:where(&)_button]:cursor-default [:where(&)_a]:cursor-pointer [:where(&)_input]:cursor-text [:where(&)_textarea]:cursor-text';

/** How far (px) the pointer must travel sideways before a press becomes a pan. */
export const PAN_THRESHOLD_PX = 5;

/**
 * Where a pan may NOT start: anything interactive the pointer would otherwise
 * operate. A card is a `<button>` (the dnd-kit drag handle), a held card's shell is
 * `[data-plan-shell]`, a column-header control is a button, a swimlane lane header
 * is `role="button"`, and a card's door is a link — so a card drag, a click and a
 * text cursor all behave exactly as before.
 */
const NO_PAN_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'label',
  '[role="button"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[data-plan-shell]',
  '[data-no-pan]',
].join(',');

/** The edges (scrollLeft values) the row's columns land on, ascending. */
export function columnEdges(row: HTMLElement): number[] {
  const cols = Array.from(row.querySelectorAll<HTMLElement>(`[${COLUMN_EDGE_ATTR}]`));
  const first = cols[0];
  if (!first) return [];
  const rowLeft = row.getBoundingClientRect().left;
  const offsetOf = (c: HTMLElement) => c.getBoundingClientRect().left - rowLeft + row.scrollLeft;
  // The first column's resting offset is the row's own start gutter (0 on the flat
  // row, the `px-6` track inset on the swimlane board), so each edge is measured
  // from it: landing on edge N puts column N where column 0 sits at rest.
  const base = offsetOf(first);
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  return cols.map((c) => Math.min(max, Math.max(0, Math.round(offsetOf(c) - base))));
}

/** The edge one column on from `scrollLeft` in `direction`, or null at that end. */
export function nextColumnEdge(
  edges: readonly number[],
  scrollLeft: number,
  direction: 'previous' | 'next',
): number | null {
  if (direction === 'next') return edges.find((e) => e > scrollLeft + 1) ?? null;
  return [...edges].reverse().find((e) => e < scrollLeft - 1) ?? null;
}

/** The edge nearest `scrollLeft` (a pan settles there), or null with no columns. */
export function nearestColumnEdge(edges: readonly number[], scrollLeft: number): number | null {
  let best: number | null = null;
  for (const e of edges) {
    if (best === null || Math.abs(e - scrollLeft) < Math.abs(best - scrollLeft)) best = e;
  }
  return best;
}

function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

/**
 * Drag-to-pan: a mouse or pen press on empty board background, moved sideways past
 * {@link PAN_THRESHOLD_PX}, scrolls the row by the pointer's travel. While it runs
 * the row wears `data-panning` (the `grabbing` cursor, snap off, no text
 * selection); on release the attribute goes, the click that ends the pan is
 * swallowed, and — when `settle` — the row settles on the nearest column edge, as
 * its proximity snap would. Touch is left to native scrolling.
 */
export function useDragToPan(
  rowRef: RefObject<HTMLElement | null>,
  { settle = false }: { settle?: boolean } = {},
): void {
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let press: { id: number; x: number; left: number; panning: boolean } | null = null;
    let swallowClick = false;

    const end = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const wasPanning = press.panning;
      press = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!wasPanning) return;
      delete row.dataset.panning;
      swallowClick = true;
      // A click only follows a pointerup on the same element; when none comes,
      // the guard must not eat the NEXT deliberate click.
      window.setTimeout(() => {
        swallowClick = false;
      }, 0);
      if (settle) {
        const edge = nearestColumnEdge(columnEdges(row), row.scrollLeft);
        if (edge !== null && edge !== row.scrollLeft) {
          row.scrollTo({ left: edge, behavior: scrollBehavior() });
        }
      }
    };

    const move = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const dx = e.clientX - press.x;
      if (!press.panning) {
        if (Math.abs(dx) < PAN_THRESHOLD_PX) return;
        press.panning = true;
        row.dataset.panning = '';
        window.getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      row.scrollLeft = press.left - dx;
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if ((e.target as Element).closest(NO_PAN_SELECTOR)) return;
      press = { id: e.pointerId, x: e.clientX, left: row.scrollLeft, panning: false };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    };

    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    row.addEventListener('pointerdown', down);
    row.addEventListener('click', click, true);
    return () => {
      row.removeEventListener('pointerdown', down);
      row.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      delete row.dataset.panning;
    };
  }, [rowRef, settle]);
}

export interface ColumnArrowsState {
  /** The row is wider than the space the board has — the arrows render. */
  overflowing: boolean;
  atStart: boolean;
  atEnd: boolean;
  /** Move the row one column towards its start or end, landing on a column edge. */
  step: (direction: 'previous' | 'next') => void;
}

/**
 * The column arrows' state over a board scroll row. `navRef` is the wrapper that
 * holds the row AND its arrow gutters: the row overflows when its content is wider
 * than that wrapper, so showing the gutters (which narrow the row) never flips the
 * answer and the arrows cannot flicker on and off at the boundary. `contentKey`
 * re-measures when the columns change.
 */
export function useColumnArrows(
  rowRef: RefObject<HTMLElement | null>,
  navRef: RefObject<HTMLElement | null>,
  contentKey: unknown,
): ColumnArrowsState {
  const [state, setState] = useState({ overflowing: false, atStart: true, atEnd: true });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const available = navRef.current?.clientWidth ?? row.clientWidth;
      const max = row.scrollWidth - row.clientWidth;
      const next = {
        overflowing: row.scrollWidth > available + 1,
        atStart: row.scrollLeft <= 1,
        atEnd: row.scrollLeft >= max - 1,
      };
      setState((cur) =>
        cur.overflowing === next.overflowing &&
        cur.atStart === next.atStart &&
        cur.atEnd === next.atEnd
          ? cur
          : next,
      );
    };
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(row);
    if (navRef.current) observer?.observe(navRef.current);
    return () => {
      row.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [rowRef, navRef, contentKey]);

  const step = useCallback(
    (direction: 'previous' | 'next') => {
      const row = rowRef.current;
      if (!row) return;
      const edge = nextColumnEdge(columnEdges(row), row.scrollLeft, direction);
      if (edge === null) return;
      row.scrollTo({ left: edge, behavior: scrollBehavior() });
    },
    [rowRef],
  );

  return { ...state, step };
}
