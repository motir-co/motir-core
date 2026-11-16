'use client';

import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useCollapsedLanes } from '@/lib/hooks/useCollapsedLanes';
import type { BoardColumnDto, BoardSwimlaneDto } from '@/lib/dto/boards';
import { ColumnActionsMenu } from './ColumnActionsMenu';
import { ColumnPointsBadge } from './ColumnPointsBadge';
import { ColumnWipBadge } from './ColumnWipBadge';
import { ArrowGutter, LaneRow } from './LaneRow';
import { LaneCountBadge } from './LanePager';
import { cardsInCell } from './boardSwimlanes';
import { createLaneScrollStore, type LaneScrollStore } from './laneScrollStore';
import type { BoardCellPagesApi } from './useBoardCellPages';

// SwimlaneBoard (Subtask 3.3.5; load model corrected by 3.8.5) — the board
// re-laid into a grid of `(column × lane)` cells per
// `design/boards/swimlanes-wip.mock.html` + `board-scale.mock.html`, mounted by
// BoardContainer when `swimlaneGroupBy !== 'none'` (group-by `none` stays the
// flat 3.2 board). A PINNED column-header row over one `LaneRow` per projection
// swimlane.
//
// Scroll model (MOTIR-11449, design MOTIR-11443 § *The scroll model*): the board
// itself does not scroll sideways — EACH LANE is its own horizontal scroller
// (`LaneRow`), with its own arrow pair and pan, so moving one lane moves no other.
// The column-header row is driven by the ACTIVE lane (the one last scrolled,
// arrowed, panned or focused, `laneScrollStore`): a clipping box whose track that
// lane's offset translates. A lane off the header's offset draws its own
// column-name strip, and every cell is named by its column for assistive tech.
//
// Load model (MOTIR-11448, replacing MOTIR-10535's per-column footer row): each
// (lane × column) CELL pages on its own. Its cards come from the per-cell page
// state (`useBoardCellPages`, handed in as `cells`): a lane's cells fill with one
// request when its cell row first comes into view (`cells.laneRef`), and each
// later page lands in exactly one cell. The pinned header's loaded count is the
// sum over that column's cells, over the column's full `totalCount`, so it can
// never disagree with the cells beneath it. Each cell still virtualizes via
// `useRowWindow` (LaneCell, kept) so the DOM stays bounded. Without `cells` (a
// render with no paging) a cell shows the column's loaded cards that sit in its
// lane (`cardsInCell`).
//
// Lanes come from the projection's `swimlanes` (already ordered: assignee alpha
// / priority rank / epic position, catch-all LAST); per-lane aggregate counts +
// lane order are the projection's. Collapse is per-lane and persists client-side (localStorage
// keyed by board + lane). Columns align across the header row and every lane
// because all share the same cell width + gutter + gap. Colour via `--el-*`,
// shape via element tokens.
//
// The pinned column header reuses the SAME 3.3.6 WIP affordances as the flat
// board — `ColumnWipBadge` (the `n/limit` chip + SOFT over-limit warning) and
// `ColumnActionsMenu` (the `[⋯]` "Set WIP limit" editor) — so WIP config + the
// over-limit treatment work identically in both layouts. The WIP limit is the
// per-column total across all lanes (the projection's `totalCount`).

export function SwimlaneBoard({
  boardId,
  columns,
  swimlanes,
  assigneeNameById,
  onOpenQuickView,
  onSetWipLimit,
  activeCardId,
  overLaneKey,
  columnPoints = null,
  cells,
}: {
  boardId: string;
  columns: BoardColumnDto[];
  swimlanes: BoardSwimlaneDto[];
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
  activeCardId: string | null;
  overLaneKey: string | null;
  /** Per-column sprint point totals (Subtask 4.5.3) keyed by column id, or `null`
   *  on a kanban board / unestimated sprint — the pinned column header renders the
   *  "N pts" pill when present (the same scrum chrome as the flat board). */
  columnPoints?: Record<string, number> | null;
  /** The per-cell page state the cells read from (MOTIR-11448). Absent = each
   *  cell shows the column's loaded cards in its lane, with no paging. */
  cells?: BoardCellPagesApi;
}) {
  const t = useTranslations('boards');
  const { collapsed, toggle } = useCollapsedLanes(boardId);
  const cardsOf = (columnId: string, laneKey: string) =>
    cells ? cells.cellState(columnId, laneKey).cards : cardsInCell(columns, columnId, laneKey);
  // The pinned header's loaded count: on a paged grid the sum over the column's
  // cells (its denominator is still the column's total); otherwise its page.
  const headerCount = (column: BoardColumnDto) => {
    if (!cells) {
      return { loaded: column.cards.length, hasMore: column.cursor !== null };
    }
    let loaded = 0;
    for (const lane of swimlanes) loaded += cells.cellSummary(column.id, lane.key).loaded;
    return { loaded, hasMore: loaded < column.totalCount };
  };

  // Shared track classes so the pinned header row and every lane's cell row line
  // up column-for-column (same 288px cells + 14px gutter). Each row supplies its
  // own `px-6` inset and arrow gutters around the track.
  const track = 'flex min-w-max gap-3.5';
  // The lane offsets and the lane the header follows — reset on a new board read
  // (a re-lay or a filter change is a new lane set), which also remounts every
  // lane so its own offset returns to 0.
  const readKey = cells?.readKey ?? '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `readKey` IS the reset: a new board read gets a new store.
  const store = useMemo(() => createLaneScrollStore(), [readKey]);

  return (
    <div
      data-testid="swimlane-board"
      className="min-w-0 pb-2"
      role="group"
      aria-label={t('boardLabel')}
    >
      {/* Pinned column-header row — counts are per-column TOTALS across all lanes.
          It is DRIVEN, not scrolling: a clipping box whose track the active lane's
          offset moves, so no input can scroll it out of step with that lane. It
          reserves the same two arrow gutters as a lane, so the tracks line up. */}
      <div
        className="sticky top-0 z-[3] flex items-stretch gap-2 border-b border-(--el-border) bg-(--el-page-bg) px-6"
        data-testid="swimlane-header-row"
      >
        <ArrowGutter direction="previous" />
        <div className="min-w-0 flex-1 overflow-x-hidden">
          <HeaderTrack store={store} className={`${track} py-2.5`}>
            {columns.map((column) => (
              <div key={column.id} className="flex w-72 shrink-0 items-center gap-2">
                <h2 className="text-[13px] font-semibold text-(--el-text-strong)">{column.name}</h2>
                <LaneCountBadge
                  columnId={column.id}
                  total={column.totalCount}
                  {...headerCount(column)}
                />
                {/* Per-column sprint point total (4.5.3) — coexists with the count on
                  the left; absent on a kanban board. */}
                <ColumnPointsBadge
                  columnId={column.id}
                  points={columnPoints?.[column.id] ?? null}
                />
                <span className="flex-1" />
                {/* WIP chip + over-limit warning — the per-column total across lanes (3.3.6). */}
                <ColumnWipBadge
                  columnId={column.id}
                  totalCount={column.totalCount}
                  wipLimit={column.wipLimit}
                />
                {/* The `[⋯]` menu hosting the WIP-limit editor (3.3.6). */}
                <ColumnActionsMenu
                  columnId={column.id}
                  boardId={boardId}
                  wipLimit={column.wipLimit}
                  onSetWipLimit={onSetWipLimit}
                />
              </div>
            ))}
          </HeaderTrack>
        </div>
        <ArrowGutter direction="next" />
      </div>

      {swimlanes.map((lane) => (
        <LaneRow
          key={`${readKey}::${lane.key}`}
          lane={lane}
          columns={columns}
          track={track}
          collapsed={collapsed.has(lane.key)}
          onToggle={toggle}
          isDropTarget={overLaneKey === lane.key}
          cardsOf={cardsOf}
          laneRef={cells?.laneRef}
          store={store}
          assigneeNameById={assigneeNameById}
          onOpenQuickView={onOpenQuickView}
          activeCardId={activeCardId}
        />
      ))}
    </div>
  );
}

/** The column-header row's track, translated to the active lane's offset. Only
 *  this element re-renders as a lane scrolls. */
function HeaderTrack({
  store,
  className,
  children,
}: {
  store: LaneScrollStore;
  className: string;
  children: ReactNode;
}) {
  const offset = useSyncExternalStore(store.subscribe, store.headerOffset, () => 0);
  return (
    <div
      className={className}
      data-testid="swimlane-header-track"
      style={offset ? { transform: `translateX(${-offset}px)` } : undefined}
    >
      {children}
    </div>
  );
}
