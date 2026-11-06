'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { BoardColumnDto } from '@/lib/dto/boards';
import { BoardCard } from './BoardCard';
import { ColumnActionsMenu } from './ColumnActionsMenu';
import { ColumnPointsBadge } from './ColumnPointsBadge';
import { ColumnWipBadge } from './ColumnWipBadge';
import { LaneCountBadge, LaneLoadFooter, useLaneSentinel, type LaneLoadState } from './LanePager';

// BoardColumn (Subtask 3.2.3 · drop 3.2.4 · scale 3.2.5 · load model 3.8.3) — one
// board column per `design/boards/board-scale.mock.html` (panel 0, the corrected
// scale UI): a header over a scrollable card stack, with a designed empty-column
// state. The header carries (in order):
//   - the column `name` + the per-column total count badge (the projection's
//     `totalCount` — the denominator, independent of how many cards are loaded)
//   - the WIP-limit chip (`ColumnWipBadge`, 3.3.6): `n/limit` with the SOFT
//     over-limit warning when `n > limit`
//   - the column-actions `[⋯]` menu (`ColumnActionsMenu`, 3.3.6) whose "Set WIP
//     limit" editor sets/clears the limit via `onSetWipLimit` (config only —
//     SOFT, so it never gates the droppable; the 3.2.4 move contract is intact)
//
// DROP TARGET (3.2.4): the whole column is a dnd-kit droppable and the cards are a
// vertical `SortableContext`; while a card is dragged over, the accent ring +
// lavender tint mark it (paired cues, finding #35).
//
// LOAD MODEL (paged per lane by MOTIR-10535, reversing 3.8.3): the column renders
// the cards LOADED so far — the projection's first page, then each page its
// scroll-to-bottom asks for — per `design/boards/board.mock.html` panel 4 (3.2.8):
// NO "Load more" button; an IntersectionObserver sentinel at the bottom of the
// column body calls `onLoadMore` while the lane has a `cursor`, a small Spinner +
// "Loading…" shows while a page is in flight, and a failed page leaves a
// focusable inline retry (`LanePager`). The header count reads "{loaded} of
// {total}" while more remain, and the full total once the lane is loaded. The
// stack still VIRTUALIZES — only the cards in (or near) the column's own scroll
// viewport mount, via `useRowWindow` (the 2.5.15 windowing generalized to
// variable-height cards; no second lib) — so a lane scrolled deep stays
// DOM-bounded. The `SortableContext` `items` list stays the FULL loaded set so
// dnd-kit knows every card's rank even when only a window is mounted, and the
// actively-dragged card (+ its neighbours) is force-mounted so a drag never
// detaches mid-flight. Colour strictly `--el-*`, shape via element tokens.

// Estimated card height (px) used before a card's real height is measured; the
// title clamps to 1–2 lines so true heights vary — `useRowWindow` measures each.
const CARD_ESTIMATE_PX = 116;
const CARD_GAP_PX = 8; // the `.col-body` inter-card gap from the design mock
// Cards on either side of the dragged card kept mounted alongside the window so a
// drag out of (or within) a virtualized column never loses its node.
const DRAG_KEEP = 2;

export function BoardColumn({
  column,
  boardId,
  assigneeNameById,
  onOpenQuickView,
  activeCardId,
  onSetWipLimit,
  points = null,
  loadState = 'idle',
  onLoadMore,
}: {
  column: BoardColumnDto;
  /** The board being viewed — threaded to the `[⋯]` Board-settings link (3.7.8). */
  boardId: string;
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  activeCardId: string | null;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
  /** This column's sprint point total (Subtask 4.5.3), or `null` on a kanban
   *  board / unestimated sprint — renders the "N pts" pill after the count badge. */
  points?: number | null;
  /** Where this lane's paging stands (MOTIR-10535). */
  loadState?: LaneLoadState;
  /** Ask for the lane's next page — called when its sentinel scrolls into view
   *  (or its retry is pressed) while it has a `cursor`. Absent = no paging. */
  onLoadMore?: (columnId: string) => void;
}) {
  const t = useTranslations('boards');
  // The whole column is the droppable, so a drop anywhere in it (incl. the empty
  // body) resolves to this column; the card SortableContext handles the slot.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const cards = column.cards;
  const empty = cards.length === 0;

  // The column body is the scroll viewport the card stack windows against.
  const bodyRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => bodyRef.current, []);
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: cards.length,
    estimateRowHeight: CARD_ESTIMATE_PX,
    gap: CARD_GAP_PX,
    getScrollElement,
  });

  // Scroll-to-load (MOTIR-10535): the sentinel at the bottom of the body asks for
  // the next page while the lane has a cursor and no page is in flight. The
  // observer is rebuilt per loaded-card count, so a page too short to fill the
  // column asks for the one after it.
  const hasMore = column.cursor !== null && onLoadMore !== undefined;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(() => onLoadMore?.(column.id), [onLoadMore, column.id]);
  useLaneSentinel(sentinelRef, bodyRef, hasMore && loadState === 'idle', cards.length, loadMore);

  // The card indices to mount: the window, plus the dragged card and its
  // neighbours (so a drag never detaches). Whole list when not windowing.
  // `range` comes from `useRowWindow` and can lag the card count by a frame:
  // an optimistic cross-column move removes a card from this column, so `cards`
  // shrinks before the window re-measures — leaving `range.end` momentarily
  // PAST the new length. Clamp the upper bound to `cards.length` so a stale
  // window never indexes a card that no longer exists (the crash the at-scale
  // board move hit: `cards[index]` undefined → reading `.assigneeId` of
  // undefined). The `BoardCard` guard below is the same defence per row.
  const indices: number[] = [];
  if (windowing) {
    const set = new Set<number>();
    for (let i = range.start; i < Math.min(range.end, cards.length); i++) set.add(i);
    if (activeCardId) {
      const ai = cards.findIndex((c) => c.id === activeCardId);
      if (ai >= 0) {
        for (let j = ai - DRAG_KEEP; j <= ai + DRAG_KEEP; j++) {
          if (j >= 0 && j < cards.length) set.add(j);
        }
      }
    }
    indices.push(...[...set].sort((a, b) => a - b));
  } else {
    for (let i = 0; i < cards.length; i++) indices.push(i);
  }

  return (
    // The column takes a UNIFORM height — the available screen height (viewport
    // minus the top nav + page header + gutters ≈ 12rem) — so every column lines up
    // regardless of card count (3.2.8); a sparse column shows empty space below its
    // cards rather than shrinking to fit. This is a viewport-relative LAYOUT height,
    // not a shaped-control size, so a raw `calc` is correct (no `--height-*` token).
    // The card body scrolls internally. While a card is dragged over, the accent
    // ring + lavender tint mark it as the drop target. The ring is an INSET ring
    // (`inset-ring`, drawn inside the box), NOT an `outline`: the flat board is a
    // horizontally-scrolling row (`BoardContainer` `overflow-x-auto`), and an
    // `outline` is painted OUTSIDE the border box, so its top/bottom strip falls
    // outside the scroll viewport and gets clipped — the over-highlight's top edge
    // appeared cut off (bug 7.24). An inset ring stays within the box and follows
    // the card radius, so it can't be clipped. Do NOT revert to `outline`.
    <section
      ref={setNodeRef}
      aria-label={t('columnLabel', { name: column.name, count: column.totalCount })}
      data-testid={`board-column-${column.id}`}
      data-over={isOver ? 'true' : undefined}
      // `data-board-col-panel` floats the column as a DISTINCT card under the 3D /
      // Immersive style — a tighter, clip-safe shadow (not the wide --shadow-card,
      // which an `overflow-x-auto` scroll row clips at the bottom and adjacent
      // columns occlude on the sides, making the board read as one backing slab).
      // The cards INSIDE still tilt individually. Inert under every other style.
      data-board-col-panel=""
      // 10.5rem of chrome ABOVE (top nav + the shell's pt-6 + the board header),
      // then whatever the shell reserves BELOW. That second term used to be baked
      // into a flat 12rem, which silently encoded the shell's old 1.5rem bottom
      // padding — so the orb clearance (MOTIR-2763) would have pushed the column
      // past the fold by exactly the amount it added. Spending the variable keeps
      // the column exactly as tall as it is today when no orb mounts.
      className={`flex h-[calc(100dvh_-_10.5rem_-_var(--shell-bottom-clearance,1.5rem))] w-72 shrink-0 flex-col rounded-(--radius-card) border bg-(--el-surface) transition-colors ${
        isOver
          ? 'border-(--el-board-column-accent) bg-(--el-droptarget-bg) inset-ring-2 inset-ring-(--el-board-column-accent)'
          : 'border-(--el-border)'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-(--el-border) px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-(--el-text-strong)">{column.name}</h2>
        <LaneCountBadge
          columnId={column.id}
          loaded={cards.length}
          total={column.totalCount}
          hasMore={column.cursor !== null}
        />
        {/* Per-column sprint point total (4.5.3) — sits with the count on the left
            (both describe the column's contents); absent on a kanban board. */}
        <ColumnPointsBadge columnId={column.id} points={points} />
        <span className="flex-1" />
        {/* WIP-limit chip — `n/limit` + the SOFT over-limit warning (3.3.6). */}
        <ColumnWipBadge
          columnId={column.id}
          totalCount={column.totalCount}
          wipLimit={column.wipLimit}
        />
        {/* Column actions — the `[⋯]` menu hosting the WIP-limit editor (3.3.6). */}
        <ColumnActionsMenu
          columnId={column.id}
          boardId={boardId}
          wipLimit={column.wipLimit}
          onSetWipLimit={onSetWipLimit}
        />
      </header>

      {empty ? (
        // Empty column: the whole body is the drop region. It FILLS the column
        // (`flex-1`) and the dashed placeholder carries a `min-h` floor, so a
        // zero-card column is still a generously-sized, reliable drop target
        // rather than a short caption pinned to the top (bug-board-cannot-drag-
        // from-in-review-to-done — the empty-column backstop). The `<section>`
        // is the dnd-kit droppable, so a drop anywhere in this region resolves
        // to this column.
        // A lane whose LOADED cards were all dragged away can still hold unloaded
        // ones (MOTIR-10535): its footer keeps paging, so they arrive here too.
        <div className="min-h-0 flex-1 p-2.5">
          <p className="flex min-h-[120px] w-full items-center justify-center rounded-(--radius-card) border border-dashed border-(--el-border) px-(--spacing-card-padding-8) py-(--spacing-card-padding-16) text-center text-xs text-(--el-text-secondary)">
            {t('emptyColumn')}
          </p>
          <LaneLoadFooter
            columnId={column.id}
            hasMore={hasMore}
            state={loadState}
            sentinelRef={sentinelRef}
            onRetry={loadMore}
          />
        </div>
      ) : (
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div
              ref={containerRef}
              className={windowing ? 'relative' : 'flex flex-col gap-2'}
              style={windowing ? { height: totalSize } : undefined}
            >
              {indices.map((index) => {
                // Defensive: skip an index a stale window left past the (just-
                // shrunk) card list, so an optimistic move never crashes the
                // column mid-render (see the index-clamp note above).
                const card = cards[index];
                if (!card) return null;
                return (
                  <div
                    key={card.id}
                    ref={measureElement(index)}
                    style={
                      windowing
                        ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                        : undefined
                    }
                  >
                    <BoardCard
                      card={card}
                      assigneeName={
                        card.assigneeId ? (assigneeNameById.get(card.assigneeId) ?? null) : null
                      }
                      routedToName={
                        card.pendingDecision
                          ? (assigneeNameById.get(card.pendingDecision.routedToId ?? '') ?? null)
                          : null
                      }
                      onOpenQuickView={onOpenQuickView}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
          <LaneLoadFooter
            columnId={column.id}
            hasMore={hasMore}
            state={loadState}
            sentinelRef={sentinelRef}
            onRetry={loadMore}
          />
        </div>
      )}
    </section>
  );
}
