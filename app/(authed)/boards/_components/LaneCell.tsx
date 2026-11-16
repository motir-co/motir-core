'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { BoardCardDto } from '@/lib/dto/boards';
import { BoardCard } from './BoardCard';
import { SkeletonCard } from './BoardSkeleton';
import { CellLoadMore, type CellControl } from './CellLoadMore';
import { LaneCountBadge } from './LanePager';
import type { CellPage } from './boardCellPages';
import { cellId } from './boardSwimlanes';

// LaneCell (Subtask 3.3.5) — one `(column × lane)` cell of the swimlane grid per
// `design/boards/swimlanes-wip.mock.html` (`.lane-col`). It is the swimlane
// analogue of a flat column's card stack: a dnd-kit DROPPABLE keyed by
// `cellId(columnId, laneKey)` (so a drop resolves to BOTH the column → workflow
// transition AND the lane → field reassign, the cross-lane-drag contract) over a
// vertical `SortableContext` of this cell's bucketed cards.
//
// It REUSES the shipped `BoardCard` (3.2.3) unchanged and the SAME 2.5.15
// windowing primitive (`useRowWindow`) the flat column uses — NO second
// virtualization lib (the AC). Cells don't scroll internally (the board's
// page/horizontal scroll is the viewport), so the window measures against the
// nearest scroll parent; when the cell's cards fit (the common case — a lane
// holds a slice of a column) windowing is inert and every card mounts. The
// `SortableContext` items list stays the FULL cell order so dnd-kit knows every
// card's rank even when only a window mounts, and the dragged card (+ neighbours)
// is force-mounted so a drag never detaches. Empty cells render the dashed
// "No issues" placeholder from the mock.
//
// Paging (MOTIR-11450, design MOTIR-11443 panel 4 — "it pages itself"): handed a
// `page` slice from the per-cell state, the cell draws one of seven phases
// (`cellPhase`) — the not-yet-loaded skeleton, the same skeleton in flight, its
// cards with the cell foot (the count + Load more, or the retry), complete, empty,
// failed. Emptiness is read off the PAGE (a page arrived holding nothing), never
// off a bare empty list, which is also what a loading, failed or not-yet-viewed
// cell holds. The foot sits AFTER the windowed container in normal flow, so a
// window never positions the control away. With no slice the cell renders as it
// always has.

const CARD_ESTIMATE_PX = 116; // matches BoardColumn — pre-measure card height
const CARD_GAP_PX = 8;
const DRAG_KEEP = 2;

/** The slice of one cell's page the cell renders from. */
export type LaneCellPage = Pick<CellPage, 'totalCount' | 'cursor' | 'state'>;

/** What the cell draws, read off its page slice and how many cards it holds. */
export type CellPhase =
  | 'placeholder'
  | 'not-loaded'
  | 'first-load'
  | 'failed'
  | 'loaded'
  | 'complete'
  | 'empty';

export function cellPhase(page: LaneCellPage | undefined, cardCount: number): CellPhase {
  if (!page) return 'placeholder';
  if (page.state === 'error') return 'failed';
  if (cardCount === 0) {
    // No page has arrived yet: the skeleton, at rest or in flight.
    if (page.totalCount === null) return page.state === 'loading' ? 'first-load' : 'not-loaded';
    // A page arrived and this cell holds nothing.
    if (page.totalCount === 0 && page.cursor === null) return 'empty';
  }
  return page.cursor !== null ? 'loaded' : 'complete';
}

/**
 * The cell window's viewport: the nearest ancestor that scrolls vertically AND has
 * real vertical overflow. A lane row that scrolls sideways computes its other axis
 * to `auto` too, but its content always fits, so taking it (the primitive's
 * nearest-scrollable default) would silently turn windowing off; this walks past
 * it. Null — the primitive's render-all degrade — when nothing above overflows.
 */
export function resolveCellScrollViewport(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    const scrolls = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** The foot's control for a phase that shows one. */
function controlOf(phase: CellPhase, page: LaneCellPage | undefined): CellControl {
  if (phase === 'failed') return 'failed';
  if (phase !== 'loaded') return 'none';
  return page?.state === 'loading' ? 'loading' : 'more';
}

export function LaneCell({
  columnId,
  laneKey,
  cards,
  assigneeNameById,
  onOpenQuickView,
  activeCardId,
  page,
  onLoadMore,
  onRetry,
  laneLabel = '',
  columnName = '',
}: {
  columnId: string;
  laneKey: string;
  cards: BoardCardDto[];
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  activeCardId: string | null;
  /** This cell's page (MOTIR-11448's per-cell state); absent = no paging. */
  page?: LaneCellPage;
  onLoadMore?: () => void;
  onRetry?: () => void;
  /** The lane and column the cell's controls name themselves by. */
  laneLabel?: string;
  columnName?: string;
}) {
  const t = useTranslations('boards');
  const id = cellId(columnId, laneKey);
  const { setNodeRef, isOver } = useDroppable({ id });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );
  const getScrollElement = useCallback(() => resolveCellScrollViewport(rootRef.current), []);

  const phase = cellPhase(page, cards.length);
  const testId = `lane-cell-${columnId}-${laneKey}`;
  const names = { column: columnName, lane: laneLabel };

  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: cards.length,
    estimateRowHeight: CARD_ESTIMATE_PX,
    gap: CARD_GAP_PX,
    getScrollElement,
  });

  // Window indices + the dragged card and its neighbours (so a drag never
  // detaches mid-flight) — the exact rule BoardColumn uses. Whole cell when not
  // windowing (the common small-cell case, and under happy-dom in tests).
  const indices: number[] = [];
  if (windowing) {
    const set = new Set<number>();
    for (let i = range.start; i < range.end; i++) set.add(i);
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

  // Over-highlight uses an INSET ring (not an `outline`): the board scrolls
  // (`overflow-x/y-auto`), and an outline is painted outside the box, so its edge
  // strip falls outside the scroll viewport and gets clipped (bug 7.24, same as
  // BoardColumn). An inset ring stays inside the box. Don't revert.
  const dashedOver = isOver
    ? 'border-(--el-board-column-accent) bg-(--el-droptarget-bg) text-(--el-text-strong) inset-ring-2 inset-ring-(--el-board-column-accent)'
    : 'border-(--el-border) text-(--el-text-muted)';

  // Nothing has arrived yet: the shipped board skeleton card, twice — static,
  // or pulsing as a status while the first page is in flight. No count, no control.
  if (phase === 'not-loaded' || phase === 'first-load') {
    const inFlight = phase === 'first-load';
    return (
      <div
        ref={setRoot}
        data-testid={testId}
        data-over={isOver ? 'true' : undefined}
        data-cell-phase={phase}
        role={inFlight ? 'status' : undefined}
        aria-busy={inFlight || undefined}
        aria-label={inFlight ? t('cellLoadingAria', names) : undefined}
        className={`flex w-72 shrink-0 flex-col gap-2 rounded-(--radius-card) ${inFlight ? 'animate-pulse' : ''} ${
          isOver ? 'bg-(--el-droptarget-bg) inset-ring-2 inset-ring-(--el-board-column-accent)' : ''
        }`}
      >
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  // The empty cell: a page arrived and holds nothing — or, with no paging, the
  // handed list is empty (today's render), or every card it held moved out.
  if (cards.length === 0 && phase !== 'failed') {
    return (
      <div
        ref={setRoot}
        data-testid={testId}
        data-over={isOver ? 'true' : undefined}
        data-cell-phase={phase}
        className={`flex min-h-[28px] w-72 shrink-0 items-center justify-center rounded-(--radius-card) border border-dashed px-(--spacing-card-padding-8) py-(--spacing-card-padding-16) text-center text-xs transition-colors ${dashedOver}`}
      >
        {t('emptyColumn')}
      </div>
    );
  }

  const control = controlOf(phase, page);
  const pageFoot =
    phase === 'placeholder' ? null : (
      <CellFoot
        columnId={columnId}
        laneKey={laneKey}
        loaded={cards.length}
        total={page?.totalCount ?? cards.length}
        hasMore={page?.cursor != null}
        control={control}
        names={names}
        onLoadMore={onLoadMore}
        onRetry={onRetry}
      />
    );

  // A failed FIRST page: no cards to keep, so the retry sits centred in a dashed
  // box rather than an empty cell that would claim there is no work here.
  if (cards.length === 0) {
    return (
      <div
        ref={setRoot}
        data-testid={testId}
        data-over={isOver ? 'true' : undefined}
        data-cell-phase={phase}
        className={`flex w-72 shrink-0 items-center justify-center rounded-(--radius-card) border border-dashed py-(--spacing-card-padding-12) ${dashedOver}`}
      >
        <CellLoadMore
          columnId={columnId}
          laneKey={laneKey}
          columnName={columnName}
          laneLabel={laneLabel}
          control={control}
          onLoadMore={onLoadMore ?? noop}
          onRetry={onRetry ?? noop}
        />
      </div>
    );
  }

  return (
    <div
      ref={setRoot}
      data-testid={testId}
      data-over={isOver ? 'true' : undefined}
      data-cell-phase={phase}
      className={`flex w-72 shrink-0 flex-col gap-2 rounded-(--radius-card) transition-colors ${
        isOver ? 'bg-(--el-droptarget-bg) inset-ring-2 inset-ring-(--el-board-column-accent)' : ''
      }`}
    >
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={containerRef}
          data-testid={`cell-cards-${columnId}-${laneKey}`}
          className={windowing ? 'relative' : 'flex flex-col gap-2'}
          style={windowing ? { height: totalSize } : undefined}
        >
          {indices.map((index) => {
            const card = cards[index]!;
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
      {pageFoot}
    </div>
  );
}

const noop = () => {};

/** The cell foot (design § *The cell foot*): the cell count at the start, the
 *  Load more control (or the retry) at the end — in normal flow, after the cards. */
function CellFoot({
  columnId,
  laneKey,
  loaded,
  total,
  hasMore,
  control,
  names,
  onLoadMore,
  onRetry,
}: {
  columnId: string;
  laneKey: string;
  loaded: number;
  total: number;
  hasMore: boolean;
  control: CellControl;
  names: { column: string; lane: string };
  onLoadMore?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex min-h-(--height-btn-sm) items-center justify-between gap-2"
      data-testid={`cell-foot-${columnId}-${laneKey}`}
    >
      <LaneCountBadge
        columnId={columnId}
        testId={`cell-count-${columnId}-${laneKey}`}
        loaded={loaded}
        total={total}
        hasMore={hasMore}
      />
      <CellLoadMore
        columnId={columnId}
        laneKey={laneKey}
        columnName={names.column}
        laneLabel={names.lane}
        control={control}
        onLoadMore={onLoadMore ?? noop}
        onRetry={onRetry ?? noop}
      />
    </div>
  );
}
