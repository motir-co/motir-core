'use client';

import { useCallback, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneDto,
} from '@/lib/dto/boards';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { Avatar, PriorityValue } from '../../items/_components/issueCellPrimitives';
import { LaneCell } from './LaneCell';
import { BOARD_SCROLL_NAV_CLASS, useColumnArrows, useDragToPan } from './boardHorizontalNav';
import type { LaneScrollStore } from './laneScrollStore';

// LaneRow (MOTIR-11449) — one swimlane of the grouped board, built to design
// MOTIR-11443 (`design/boards/swimlanes--lane-paging.mock.html` panels 3 and 5–9,
// design-notes § *The lane header*, § *The scroll model*):
//
//   [ lane header band — spans the board, never scrolls                      ]
//   [ ‹ gutter ] [ the lane's own cell scroller                ] [ gutter › ]
//                  · the width-establishing spacer track (both states)
//                  · the column-name strip (only off the header's offset)
//                  · the row of cells, each named by its column
//
// Each lane is its own horizontal scroller — the base navigation design's hidden
// scrollbar, pan and column arrow pair (`boardHorizontalNav`, MOTIR-11323) applied
// to the lane instead of the board — so scrolling one lane moves no other lane
// and not the board. The band sits ABOVE that scroller, so the lane label rail is
// pinned at the left at any lane offset with no sticky positioning at all, and
// the band spans the board whether the lane is collapsed or expanded. The spacer
// track stays in the scroller in both states (the shipped
// `bug-swimlane-collapsed-lane-header-not-full-width` fix), so a collapsed lane
// keeps its offset and its track width.
//
// Loading follows the lane: the client hook's `laneRef(laneKey)` is attached to
// the lane's cell area, which mounts only while the lane is expanded — so a
// collapsed lane is never observed and never asks, and expanding a lane that is
// already in view mounts a fresh element the hook's observer reports at once.
// The observer, its viewport root and the once-per-lane guard are the hook's.

export function LaneRow({
  lane,
  columns,
  track,
  collapsed,
  onToggle,
  isDropTarget,
  cardsOf,
  laneRef,
  store,
  assigneeNameById,
  onOpenQuickView,
  activeCardId,
}: {
  lane: BoardSwimlaneDto;
  columns: BoardColumnDto[];
  /** The grid's shared column-track classes, so every row lines up. */
  track: string;
  collapsed: boolean;
  onToggle: (laneKey: string) => void;
  /** This lane is under a drag — the lane's drop-target ring. */
  isDropTarget: boolean;
  /** The cards one cell of this lane shows. */
  cardsOf: (columnId: string, laneKey: string) => BoardCardDto[];
  /** The client hook's lane observer ref; absent = this row loads nothing. */
  laneRef?: (laneKey: string) => (el: HTMLElement | null) => (() => void) | void;
  /** The board's lane-offset store (the header follows the active lane). */
  store: LaneScrollStore;
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  activeCardId: string | null;
}) {
  const t = useTranslations('boards');
  const isCatchAll = lane.key === BOARD_SWIMLANE_NO_VALUE;
  // An empty lane (the dimension holds it, no card is in it — e.g. under a
  // filter) draws one line instead of a row of empty cells, and loads nothing.
  const empty = lane.count === 0;
  const expanded = !collapsed && !empty;

  const navRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { overflowing, atStart, atEnd, step } = useColumnArrows(
    scrollerRef,
    navRef,
    `${columns.length}:${expanded}`,
  );
  useDragToPan(scrollerRef);

  // The header follows whichever lane the reader acts on: a scroll (wheel,
  // trackpad, keyboard, an arrow, a pan, dnd-kit's auto-scroll) or focus inside.
  const follow = useCallback(() => {
    const el = scrollerRef.current;
    if (el) store.follow(lane.key, el.scrollLeft);
  }, [store, lane.key]);
  const showsStrip = useSyncExternalStore(
    store.subscribe,
    () => store.showsStrip(lane.key),
    () => false,
  );

  const laneLabel = lane.label;
  return (
    <div
      data-testid={`swimlane-${lane.key}`}
      className="border-b border-(--el-border) last:border-b-0"
      onFocus={follow}
    >
      {/* The lane header band — the whole band toggles collapse (Jira/Linear). */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? 'laneExpand' : 'laneCollapse', {
          label: lane.label,
          count: lane.count,
        })}
        data-testid={`swimlane-head-${lane.key}`}
        onClick={() => onToggle(lane.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(lane.key);
          }
        }}
        className={`cursor-pointer px-6 py-2.5 select-none ${
          isCatchAll
            ? 'bg-(--el-muted) hover:bg-(--el-surface)'
            : 'bg-(--el-surface-soft) hover:bg-(--el-surface)'
        }`}
      >
        <div
          className="inline-flex items-center gap-2.5"
          data-testid={`swimlane-headcontent-${lane.key}`}
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-(--el-text-secondary) transition-transform ${
              collapsed ? '-rotate-90' : ''
            }`}
            aria-hidden
          />
          <LaneLabel lane={lane} isCatchAll={isCatchAll} />
          <span
            className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-count-text)"
            data-testid={`swimlane-count-${lane.key}`}
          >
            {lane.count}
          </span>
        </div>
      </div>

      <div ref={navRef} data-board-nav="" className="flex items-stretch gap-2 px-6">
        <ArrowGutter direction="previous">
          {expanded && overflowing ? (
            <LaneArrow
              direction="previous"
              laneKey={lane.key}
              label={t('laneScrollLeftAria', { lane: laneLabel })}
              disabled={atStart}
              onPress={() => step('previous')}
            />
          ) : null}
        </ArrowGutter>
        <div
          ref={scrollerRef}
          role="group"
          aria-label={laneLabel}
          tabIndex={expanded ? 0 : undefined}
          data-lane-scroller=""
          data-testid={`swimlane-scroller-${lane.key}`}
          onScroll={follow}
          className={`min-w-0 flex-1 overflow-x-auto focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${BOARD_SCROLL_NAV_CLASS}`}
        >
          {/*
           * Width-establishing spacer track — rendered in BOTH states, one `w-72`
           * spacer per column, zero-height and invisible: it keeps the scroller's
           * track (and so the lane's offset) whether or not cells are present
           * (`bug-swimlane-collapsed-lane-header-not-full-width`).
           */}
          <div
            className={`${track} invisible h-0 overflow-hidden`}
            data-testid={`swimlane-track-${lane.key}`}
            aria-hidden
          >
            {columns.map((column) => (
              <div key={column.id} className="w-72 shrink-0" />
            ))}
          </div>

          {empty && !collapsed ? (
            <p
              className="py-(--spacing-card-padding-12) text-xs text-(--el-text-secondary)"
              data-testid={`swimlane-empty-${lane.key}`}
            >
              {t('laneEmpty')}
            </p>
          ) : null}

          {expanded ? (
            <div
              ref={laneRef?.(lane.key)}
              data-testid={`swimlane-cells-${lane.key}`}
              className="py-(--spacing-card-padding-8)"
            >
              {/* The column-name strip — only while this lane sits at a different
                  offset from the header; it translates with the lane. Each cell's
                  own name carries the column for assistive tech. */}
              {showsStrip ? (
                <div
                  className={`${track} pb-1.5`}
                  data-testid={`swimlane-strip-${lane.key}`}
                  aria-hidden
                >
                  {columns.map((column) => (
                    <div
                      key={column.id}
                      className="flex w-72 shrink-0 items-center border-b border-(--el-border-soft) pb-1"
                    >
                      <span className="text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                        {column.name}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div
                // Lane drop-target ring is INSET (not an `outline`): the lane
                // scrolls, and an outline outside the box gets clipped by the
                // scroll viewport (bug 7.24, same as BoardColumn).
                className={`${track} ${
                  isDropTarget
                    ? 'rounded-(--radius-card) bg-(--el-droptarget-bg) inset-ring-2 inset-ring-(--el-board-column-accent)'
                    : ''
                }`}
              >
                {columns.map((column) => (
                  <div
                    key={column.id}
                    role="group"
                    aria-label={column.name}
                    data-board-column-edge=""
                    className="w-72 shrink-0"
                  >
                    <LaneCell
                      columnId={column.id}
                      laneKey={lane.key}
                      cards={cardsOf(column.id, lane.key)}
                      assigneeNameById={assigneeNameById}
                      onOpenQuickView={onOpenQuickView}
                      activeCardId={activeCardId}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <ArrowGutter direction="next">
          {expanded && overflowing ? (
            <LaneArrow
              direction="next"
              laneKey={lane.key}
              label={t('laneScrollRightAria', { lane: laneLabel })}
              disabled={atEnd}
              onPress={() => step('next')}
            />
          ) : null}
        </ArrowGutter>
      </div>
    </div>
  );
}

/** One arrow gutter beside a lane (or the column-header row): the 32px arrow,
 *  kept EMPTY when the arrow is absent so every row's track starts at the same x.
 *  Below `sm` no lane arrows are drawn, as the base navigation design draws none. */
export function ArrowGutter({
  direction,
  children,
}: {
  direction: 'previous' | 'next';
  children?: ReactNode;
}) {
  return (
    <div className="hidden w-8 shrink-0 sm:block" data-lane-arrow-gutter={direction}>
      {children ? <div className="sticky top-0 pt-[2px]">{children}</div> : null}
    </div>
  );
}

function LaneArrow({
  direction,
  laneKey,
  label,
  disabled,
  onPress,
}: {
  direction: 'previous' | 'next';
  laneKey: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const Icon = direction === 'previous' ? ChevronLeft : ChevronRight;
  return (
    <Tooltip content={label} side="top">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-(--height-btn-sm) px-0"
        aria-label={label}
        data-testid={`swimlane-arrow-${direction === 'previous' ? 'left' : 'right'}-${laneKey}`}
        disabled={disabled}
        onClick={onPress}
      >
        <Icon className="size-4" aria-hidden />
      </Button>
    </Tooltip>
  );
}

/** The lane header's group label, rendered by dimension (mock: `.lane-label`). */
function LaneLabel({ lane, isCatchAll }: { lane: BoardSwimlaneDto; isCatchAll: boolean }) {
  if (isCatchAll) {
    return (
      <span className="inline-flex items-center gap-2 text-[13px] font-medium text-(--el-text-secondary)">
        <span
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted) text-[10px] text-(--el-text-faint)"
          aria-hidden
        >
          –
        </span>
        {lane.label}
      </span>
    );
  }
  if (lane.kind === 'priority') {
    return (
      <span className="inline-flex items-center text-[13px] font-semibold text-(--el-text-strong)">
        <PriorityValue priority={lane.key as WorkItemPriorityDto} />
      </span>
    );
  }
  if (lane.kind === 'epic') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-(--el-text-strong)">
        <IssueTypeIcon type="epic" className="h-4 w-4 shrink-0" />
        {lane.label}
      </span>
    );
  }
  // assignee
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-(--el-text-strong)">
      <Avatar name={lane.label} />
      {lane.label}
    </span>
  );
}
