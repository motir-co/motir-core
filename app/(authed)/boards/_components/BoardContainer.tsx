'use client';

import { personDisplayName } from '@/lib/people/personLabel';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Flag, LayoutGrid, User, Zap } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardColumnDto,
  BoardProjectionDto,
  BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import type { BoardColumnPageDto, MoveCardResultDto } from '@/lib/dto/boards';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { useCreateIssue } from '../../_components/CreateIssueProvider';
import { usePeekOpen } from '../../items/_components/IssueQuickView';
import { updateIssueAction } from '../../items/[key]/edit/actions';
import { BoardCardOverlay } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardColumnPager, useActiveColumnIndex } from './BoardColumnPager';
import { BoardEmptyState } from './BoardEmptyState';
import { BoardFilteredEmptyState } from './BoardFilteredEmptyState';
import { BoardSkeleton } from './BoardSkeleton';
import { NoActiveSprintState } from './NoActiveSprintState';
import { SprintHeader } from './SprintHeader';
import { SwimlaneBoard } from './SwimlaneBoard';
import { BoardHeldRefusalProvider, planHoldName, type BoardHeldRefusal } from './BoardHeldRefusal';
import { heldLineFromRefusal, readHeldRefusal } from '@/components/issues/heldRefusal';
import { heldSentence, sessionHolderSentence } from '@/components/issues/StatusHeldNotice';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';
import { planHoldKey, type PlanHoldDTO } from '@/lib/dto/plans';
import { UnmappedStatusesTray } from './UnmappedStatusesTray';
import type { LaneLoadState } from './LanePager';
import {
  appendColumnPage,
  cardIndex,
  columnOfOverId,
  findCard,
  findCardColumnId,
  neighborsOf,
  reconcileCard,
  relocateCard,
  transferCount,
} from './boardMove';
import {
  cellOfOverId,
  laneKeyOfCard,
  moveCardToColumn,
  reassignPatchForLane,
  resolveSwimlaneDrop,
  setCardSwimlaneKey,
} from './boardSwimlanes';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { Tooltip } from '@/components/ui/Tooltip';

// The board client container (Subtask 3.2.2 · drag-drop 3.2.4 · scale 3.2.5 ·
// swimlanes + WIP 3.3). A PURE CONSUMER of the Story-3.1/3.3 board API: it
// fetches `GET /api/board` (the active project's default board) on mount and
// renders the board-level states from `design/boards/board.mock.html` (panel 6).
//
// Story 3.3.5 adds the swimlane layer ON TOP, without forking the board: a
// board-header **group-by control** (the 3.2.1-reserved 3.3-controls slot) that
// PATCHes `board.swimlaneGroupBy` (3.3.3) and RE-LAYS from the projection (a
// loading transition, never a flash of the old layout); when the group-by is
// `none` the flat 3.2 column row renders unchanged, otherwise `SwimlaneBoard`
// renders the `(column × lane)` grid. There is NO data access here beyond the
// board fetch, the move POST, the group-by PATCH, the WIP-config PATCH, and the
// existing 2.5 field-update action the cross-lane drag reuses — no new route.
//
// State shape: the projection lives in component state as `board`, with its
// `columns[].cards` arrays held so the later subtasks can mutate ONE column's
// card list in place (3.2.4 optimistic moves, 3.2.5 appended pages) without
// refetching the whole board.
//
// Completeness (Subtask 3.2.6): an all-empty board renders the board EMPTY
// state (a "New work item" CTA, not six blank columns); `unmappedStatuses`
// renders the unmapped-statuses TRAY above the board; and the flat column row is
// a scroll-snap single-column pager on narrow viewports — see `BoardDnd`.
//
// `members` (the workspace member directory the board page already resolves) lets
// the cards map each `BoardCardDto.assigneeId` to a display name for the avatar —
// the projection card carries only the id (Story 3.1.4).
//
// `activeProjectId` is the currently-active project (resolved server-side from
// `WorkspaceMembership.activeProjectId`). The board is client-fetched, so when
// the user switches project/workspace — which persists the new active project and
// calls `router.refresh()` (Server Components only) — the board would otherwise
// stay on the OLD project's data. Passing the id as a prop and watching it lets
// the refresh re-render the page with the new id, which re-runs the fetch.

type BoardStatus = 'loading' | 'ready' | 'error' | 'no-board';

export function BoardContainer({
  members = [],
  activeProjectId,
  selectedBoardId,
  canEdit = true,
  projectName = '',
  workflow,
  filterParam = '',
  filterActive = false,
}: {
  members?: WorkspaceMemberDTO[];
  activeProjectId?: string;
  selectedBoardId?: string;
  /**
   * The compiled board filter (Story 6.15.3) — the merged toolbar facets +
   * advanced AST, encoded as the `?filter=v1:` codec param (empty string when no
   * filter narrows the board). Rides the projection fetch so the server read
   * (6.15.2) re-projects every column (its count and every page) to the
   * matching set; a change refetches (it's in the fetch query → the effect dep).
   */
  filterParam?: string;
  /**
   * Whether a filter is active (Story 6.15.3) — selects the FILTERED-empty state
   * ("no card matches", Clear CTA) over the brand-new-board empty state ("New
   * work item") when every column is empty.
   */
  filterActive?: boolean;
  /**
   * Whether the actor may edit this board (Story 6.4.6). `false` for a viewer /
   * a member on a `limited` project: the board renders read-only — drag is
   * disabled and a banner explains why (the server rejects the move regardless).
   */
  canEdit?: boolean;
  /**
   * Active project name + workflow — resolved once by the page (Subtask 4.5.3),
   * threaded to the scrum `SprintHeader` so its Complete-sprint entry can mount
   * the Story-4.4 flow (`projectName` = the dialog subtitle; `workflow` =
   * `statusByKey` for the report). Only consumed on a scrum board with an active
   * sprint; harmless (and unused) on a kanban board.
   */
  projectName?: string;
  workflow?: WorkflowDto;
}) {
  const t = useTranslations('boards');
  // MOTIR-6174 — the permission-gated UI rule on the board. The read-only banner's
  // copy lives in `projectAccess` (it read `boards.readOnlyBoardBanner`, which is
  // not a key, so a Viewer saw the raw key). The group-by is a `board:configure`
  // write; Complete sprint a `sprint:manage` one.
  const tpa = useTranslations('projectAccess');
  const { can } = useProjectAccess();
  const canConfigure = can('board:configure');
  // The board's projection-fetch query. `?boardId=` (Subtask 3.7.5) carries the
  // page's `?board=<id>` selection so the picked board (not just the default)
  // loads; absent → the server resolves the project's default. `?filter=`
  // (Subtask 6.15.3) carries the compiled filter AST so the server re-projects
  // to the matching set. Threaded into the mount fetch AND the group-by re-lay
  // refetch so a re-lay stays on the SAME board + filter. As a single derived
  // string it's a stable effect dep — changing EITHER the selection or the
  // filter refetches.
  const boardQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedBoardId) params.set('boardId', selectedBoardId);
    if (filterParam) params.set('filter', filterParam);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [selectedBoardId, filterParam]);
  const { toast } = useToast();
  // The group-by control lives in the PAGE HEADER toolbar row (beside the board
  // switcher), per design/boards/multi-board.mock.html — but its value + change
  // handler live HERE (in the projection state). page.tsx renders an empty
  // `display:contents` slot in that row; we portal the GroupByControl into it so
  // the control sits in the header while its state stays with the board. (In an
  // isolated unit render with no page header, the slot is absent → the portal
  // renders nothing, which is fine — the E2E covers the real header.)
  // Capture the header group-by slot AFTER mount (an effect, NOT a lazy useState
  // initializer): on a CLIENT navigation to /boards the slot is rendered in the
  // SAME commit as this component, so it isn't in the DOM yet during the first
  // render — a render-time lookup returns null and the portal never mounts (the
  // group-by control vanishes). The effect runs post-commit, when the sibling
  // slot exists, on both first load and client nav.
  const [groupBySlot, setGroupBySlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- capturing a portal target that commits in the same render pass; it must be read post-commit, which is exactly what an effect is for (DOM sync)
    setGroupBySlot(document.getElementById('board-toolbar-groupby-slot'));
  }, []);
  const [board, setBoard] = useState<BoardProjectionDto | null>(null);
  const [status, setStatus] = useState<BoardStatus>('loading');
  // 'relaying' = a group-by change is fetching the new projection; the toolbar
  // stays mounted (so the control is still visible) while the grid shows the
  // skeleton — the re-lay loading transition, not a flash of the old layout.
  const [relaying, setRelaying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Bumped on every successful fetch so the interactive `BoardDnd` (whose column
  // state seeds from the projection only on mount) RE-SEEDS — keying it by this
  // remounts it with the fresh projection after a refetch (e.g. a create), so a
  // new card actually appears instead of the stale local state lingering.
  const [boardVersion, setBoardVersion] = useState(0);

  // A create (the empty-state CTA, or any "+ New" while the board is open) goes
  // through the shell's CreateIssueProvider. The board is client-fetched, so
  // `router.refresh()` (which only re-runs Server Components) does NOT refresh
  // it — instead we watch the provider's `issuesChangedAt` tick and refetch.
  // Fixes: creating from the empty state left the board stuck on "No work items".
  const { issuesChangedAt } = useCreateIssue();

  useEffect(() => {
    let active = true;
    fetch(`/api/board${boardQuery}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as BoardProjectionDto;
          if (!active) return;
          setBoard(data);
          setBoardVersion((v) => v + 1);
          setStatus('ready');
          return;
        }
        let code: string | undefined;
        try {
          code = ((await res.json()) as { code?: string }).code;
        } catch {
          code = undefined;
        }
        if (!active) return;
        setStatus(res.status === 404 && code === 'BOARD_NOT_FOUND' ? 'no-board' : 'error');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
    // `activeProjectId` is in the deps so switching project/workspace (→ a new
    // active project + router.refresh()) re-runs the fetch for the new project's
    // board instead of leaving the previous project's board on screen.
    // `boardQuery` is in the deps so changing the `?board=` selection (the 3.7.4
    // switcher) refetches the newly-selected board's projection.
  }, [reloadKey, issuesChangedAt, activeProjectId, boardQuery]);

  const retry = useCallback(() => {
    setStatus('loading');
    setReloadKey((k) => k + 1);
  }, []);

  // Change the swimlane group-by: persist it (PATCH, 3.3.3) so every viewer
  // shares it, then refetch the projection and re-lay. The grid drops to the
  // skeleton during the round-trip; on failure the old board stays and a toast
  // explains. The active value is always read from the projection (never local).
  const changeGroupBy = useCallback(
    async (next: BoardSwimlaneGroupByDto) => {
      if (!board || next === board.swimlaneGroupBy) return;
      setRelaying(true);
      try {
        const patch = await fetch('/api/board', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ boardId: board.boardId, swimlaneGroupBy: next }),
        });
        if (!patch.ok) throw new Error(`group-by ${patch.status}`);
        const res = await fetch(`/api/board${boardQuery}`, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`reload ${res.status}`);
        setBoard((await res.json()) as BoardProjectionDto);
      } catch {
        toast({
          variant: 'error',
          title: t('groupByErrorTitle'),
          description: t('groupByErrorDescription'),
        });
      } finally {
        setRelaying(false);
      }
    },
    [board, boardQuery, t, toast],
  );

  const assigneeNameById = useMemo(
    () => new Map(members.map((m) => [m.userId, personDisplayName(m)])),
    [members],
  );

  if (status === 'loading') return <BoardSkeleton />;
  if (status === 'no-board') {
    return (
      <ErrorState title={t('noBoardTitle')} description={t('noBoardDescription')} retry={retry} />
    );
  }
  if (status === 'error' || !board) {
    return <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={retry} />;
  }

  // Completeness states (Subtask 3.2.6) are derived from the freshly-FETCHED
  // projection (not BoardDnd's local drag state), so a refetch updates them
  // immediately:
  //   - unmapped-statuses TRAY above the board (absent when all are mapped);
  //   - the board EMPTY state when every column is empty AND nothing is unmapped
  //     (when statuses are unmapped, work items may be hidden in them — present,
  //     not absent — so we keep the columns + tray rather than claim "no work
  //     items"; rung-2 guard). An empty board has nothing to group, so the
  //     group-by control is omitted there (the CTA is the focus).
  const hasUnmapped = board.unmappedStatuses.length > 0;
  const isEmpty = !hasUnmapped && board.columns.every((c) => c.totalCount === 0);

  // SCRUM resolution (Subtask 4.5.3) — keyed purely off the resolved board's
  // `type` (which board is resolved when a project has several is a board-nav
  // concern, Story 3.7). A scrum board with NO active sprint (`sprint: null` — the
  // common pre-start / post-complete state) REPLACES the board with the
  // no-active-sprint state (never an empty six-column board, never the unscoped
  // backlog). A kanban board has `sprint: null` too, so the empty state is gated
  // on `type === 'scrum'`. With an active sprint, the `SprintHeader` renders above
  // the REUSED board, and the per-column point totals thread down to the columns.
  const isScrum = board.type === 'scrum';
  const noActiveSprint = isScrum && board.sprint === null;
  // Per-column point pills only when the active sprint is ESTIMATED (committed >
  // 0); an unestimated sprint would otherwise paint "0 pts" on every column. A
  // kanban board passes `null` (no pills) — the same column header serves both.
  const columnPoints =
    board.sprint && board.sprint.points.committed > 0 ? board.sprint.columnPoints : null;

  if (noActiveSprint) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {!canEdit ? (
          <div
            role="status"
            className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding) py-(--spacing-control-y) text-sm text-(--el-text-secondary)"
          >
            {tpa('readOnlyBoardBanner')}
          </div>
        ) : null}
        <NoActiveSprintState />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* SCRUM sprint header (Subtask 4.5.3) — the one net-new surface, above the
          REUSED 3.2/3.3 board, drawn from the 4.5.2 `SprintSummaryDto`. Present
          only on a scrum board with an active sprint (the no-active-sprint case
          returned early above; a kanban board has `sprint === null`). */}
      {isScrum && board.sprint ? (
        <SprintHeader
          sprint={board.sprint}
          projectName={projectName}
          workflow={workflow}
          canCompleteSprint={can('sprint:manage')}
          onSprintCompleted={retry}
        />
      ) : null}
      {/* The group-by control is portaled into the header toolbar slot (beside the
          switcher) — the design row, not a separate body row. Shown only for a
          non-empty board (an empty board has nothing to group); stays visible
          while a group-by change re-lays (`disabled={relaying}`). */}
      {!isEmpty && groupBySlot
        ? createPortal(
            <GroupByControl
              value={board.swimlaneGroupBy}
              onChange={changeGroupBy}
              disabled={relaying}
              readOnlyReason={canConfigure ? undefined : tpa('readOnlyHint')}
            />,
            groupBySlot,
          )
        : null}
      {!canEdit ? (
        <div
          role="status"
          className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding) py-(--spacing-control-y) text-sm text-(--el-text-secondary)"
        >
          {tpa('readOnlyBoardBanner')}
        </div>
      ) : null}
      {hasUnmapped ? (
        <UnmappedStatusesTray statuses={board.unmappedStatuses} boardId={board.boardId} />
      ) : null}
      {isEmpty ? (
        // FILTERED-empty (Subtask 6.15.3): an active filter that matches no card
        // shows the distinct "no match" state with a Clear CTA, NOT the
        // brand-new-board "New work item" empty state (the board has items; the
        // filter is over-narrow). The toolbar + applied summary stay (page-level)
        // so the user can edit what they filtered on.
        filterActive ? (
          <BoardFilteredEmptyState selectedBoardId={selectedBoardId} />
        ) : (
          <BoardEmptyState />
        )
      ) : relaying ? (
        <BoardSkeleton />
      ) : (
        // Key by `boardVersion` (re-seed BoardDnd's mount-seeded column state
        // after a refetch — e.g. a create shows the new card) AND by the
        // group-by (a group-by change remounts with the fresh lane layout
        // rather than reconciling across layouts).
        <BoardDnd
          key={`${boardVersion}:${board.swimlaneGroupBy}`}
          board={board}
          assigneeNameById={assigneeNameById}
          canEdit={canEdit}
          columnPoints={columnPoints}
          projectName={projectName}
          filterParam={filterParam}
        />
      )}
    </div>
  );
}

// The board-header group-by control (3.3.5) — the shipped Segmented primitive in
// the 3.2.1-reserved 3.3-controls slot. None = the flat 3.2 board.
function GroupByControl({
  value,
  onChange,
  disabled,
  readOnlyReason,
}: {
  value: BoardSwimlaneGroupByDto;
  onChange: (v: BoardSwimlaneGroupByDto) => void;
  disabled: boolean;
  /** MOTIR-6174 — the group-by is stored on the BOARD (`setSwimlaneGroupBy`
   *  asserts `board:configure`). An actor without the key sees the grouping,
   *  DISABLED, with this reason — it is an in-place control on a surface they can
   *  see (the permission-gated UI rule, row 7's grammar). */
  readOnlyReason?: string;
}) {
  const t = useTranslations('boards');
  const control = (
    <div className="flex items-center gap-2" data-read-only={readOnlyReason ? '' : undefined}>
      <span className="text-xs font-medium whitespace-nowrap text-(--el-text-muted)">
        {t('groupByLabel')}
      </span>
      <Segmented<BoardSwimlaneGroupByDto>
        label={t('groupByAria')}
        value={value}
        onChange={onChange}
        disabled={disabled || readOnlyReason !== undefined}
        options={[
          { value: 'none', label: t('groupByNone'), icon: <LayoutGrid /> },
          { value: 'assignee', label: t('groupByAssignee'), icon: <User /> },
          { value: 'epic', label: t('groupByEpic'), icon: <Zap /> },
          { value: 'priority', label: t('groupByPriority'), icon: <Flag /> },
        ]}
      />
    </div>
  );
  // A disabled button swallows the pointer, so the reason hangs off the wrapper.
  return readOnlyReason ? <Tooltip content={readOnlyReason}>{control}</Tooltip> : control;
}

// The interactive board (Subtask 3.2.4 · swimlanes 3.3.5) — a dnd-kit
// `DndContext` over EITHER the flat 3.2 column row (group-by `none`) or the
// `SwimlaneBoard` grid (group-by ≠ `none`). It owns the mutable `columns` state
// (seeded from the projection); each card carries its resolved `swimlaneKey`
// (3.3.4), so the lane a card sits in is derived, never re-computed.
//
// FLAT drop (3.2.4, unchanged): a cross-column drop is a workflow TRANSITION
// (`POST /api/board/move`); 200 reconciles, 409/422/error snaps back + toasts.
//
// SWIMLANE drop (3.3.5): a drop resolves a target COLUMN and a target LANE.
//   - column change → the SAME 3.2 transition (`/board/move`).
//   - lane change   → reassign the grouped field via the EXISTING 2.5
//     `updateIssueAction` (assignee / priority / epic-reparent; the catch-all
//     clears it) — NOT the move endpoint, NO new backend.
//   - a diagonal drop applies BOTH writes, each optimistic with INDEPENDENT
//     snap-back: a rejected transition reverts only the column axis, a rejected
//     reassign reverts only the lane axis — the card never rests in a lying
//     position.
function BoardDnd({
  board,
  assigneeNameById,
  canEdit,
  columnPoints,
  projectName = '',
  filterParam = '',
}: {
  board: BoardProjectionDto;
  assigneeNameById: Map<string, string>;
  canEdit: boolean;
  /**
   * Per-column sprint point totals (Subtask 4.5.3) keyed by column id, or `null`
   * on a kanban board / an unestimated sprint — the column header renders the
   * "N pts" pill when its entry is present.
   */
  columnPoints: Record<string, number> | null;
  /** The plan footer's last naming fallback (MOTIR-6268's `{name}` rule). */
  projectName?: string;
  /** The compiled board filter the projection was read with (Story 6.15.3) — a
   *  lane's next page is read with the same one (MOTIR-10535). */
  filterParam?: string;
}) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  const openPeek = usePeekOpen();
  const groupBy = board.swimlaneGroupBy;
  const swimlaned = groupBy !== 'none';

  const [columns, setColumns] = useState<BoardColumnDto[]>(board.columns);
  // Every plan that holds a loaded card (MOTIR-6268): the projection's, plus each
  // lane page's as it arrives (MOTIR-10535).
  const [planHolds, setPlanHolds] = useState(board.planHolds);
  // Each lane's paging state (MOTIR-10535) — `loading` while its next page is in
  // flight, `error` when the last one failed (the lane then offers a retry).
  const [loadStates, setLoadStates] = useState<Record<string, LaneLoadState>>({});
  const [activeCard, setActiveCard] = useState<BoardCardDto | null>(null);
  // The lane currently under the drag (swimlane mode) — drives the target-lane
  // ring/tint (paired with the cell `isOver` outline; never colour-alone, #35).
  const [overLaneKey, setOverLaneKey] = useState<string | null>(null);
  // A move an approval or a merge HOLDS (MOTIR-5529, design panel 2b): the card
  // returns, and the held line renders ON it — never a toast. One at a time; the
  // next drag, `Esc` or a click outside closes it.
  const tHeld = useTranslations('approvalGate.statusHeld');
  const [held, setHeld] = useState<BoardHeldRefusal | null>(null);
  const [heldAnnouncement, setHeldAnnouncement] = useState('');
  const closeHeld = useCallback(() => setHeld(null), []);
  // THE PLAN HOLD's sibling highlight (MOTIR-6268): the plan whose items are
  // outlined — a hovered / focused footer's, else an open plan refusal's. The
  // card body's own hover never sets it, so a pointer crossing a lane never flashes.
  const [hoverPlanId, setHoverPlanId] = useState<string | null>(null);
  const highlightedPlanId = hoverPlanId ?? (held?.kind === 'plan' ? planHoldKey(held.plan) : null);
  const showHeld = useCallback(
    (card: BoardCardDto, statusLabel: string, gate: ApprovalGatePendingPayloadDTO) => {
      const line = heldLineFromRefusal(statusLabel, statusLabel, gate);
      setHeld({ kind: 'gate', workItemId: card.id, itemKey: gate.itemKey, line });
      const { key, values } = heldSentence(line, tHeld(`decisionNoun.${line.kind}`));
      const sentence = tHeld.markup(key, { ...values, strong: (chunks: string) => chunks });
      setHeldAnnouncement(t('announcementHeld', { key: card.identifier, line: sentence }));
    },
    [t, tHeld],
  );
  // A MARK refusal (MOTIR-6682): a marked card dragged out of the done category
  // returns, and the mark's one line opens under it with its Open item door.
  const tMark = useTranslations('workItems.obsolescence');
  const showMarkHeld = useCallback(
    (card: BoardCardDto, mark: WorkItemObsolescenceDto) => {
      setHeld({ kind: 'mark', workItemId: card.id, itemKey: card.identifier, mark });
      const line = tMark.markup('heldLine', {
        mark: tMark(`value.${mark}`),
        strong: (chunks: string) => chunks,
      });
      setHeldAnnouncement(t('announcementHeld', { key: card.identifier, line }));
    },
    [t, tMark],
  );
  // A PLAN refusal (MOTIR-6268): the item returns and the refusal opens in its own
  // plan footer, naming the plan and how many OTHER items it holds. The count is
  // the projection's server-side one; a plan the projection did not name (the
  // board was read before the hold) falls back to the loaded cards.
  const showPlanHeld = useCallback(
    (card: BoardCardDto, plan: PlanHoldDTO, loaded: BoardColumnDto[]) => {
      const key = planHoldKey(plan);
      const summary = planHolds[key];
      const siblings = summary
        ? Math.max(summary.heldCount - 1, 0)
        : loaded
            .flatMap((col) => col.cards)
            .filter((c) => c.id !== card.id && c.planHold && planHoldKey(c.planHold) === key)
            .length;
      setHeld({ kind: 'plan', workItemId: card.id, itemKey: plan.itemKey, plan, siblings });
      const { name } = planHoldName(plan, planHolds, projectName);
      // An open SESSION's hold (MOTIR-7640) reads its own sentences.
      if (plan.kind === 'session') {
        const line = [
          tHeld('sessionHeld'),
          sessionHolderSentence(plan, tHeld),
          t('planHold.sessionSiblings', { count: siblings }),
        ].join(' ');
        setHeldAnnouncement(
          t('announcementSessionHeld', {
            key: card.identifier,
            session: t('planHold.sessionMarker', { name }),
            line,
          }),
        );
        return;
      }
      const line = [
        tHeld('planHeld'),
        tHeld(`planState.${plan.planStatus}`),
        t('planHold.siblings', { count: siblings }),
      ].join(' ');
      setHeldAnnouncement(
        t('announcementPlanHeld', {
          key: card.identifier,
          plan: t('planHold.marker', { name }),
          line,
        }),
      );
    },
    [planHolds, projectName, t, tHeld],
  );
  // Focus lands on Review & approve when the line carries one, else stays on the
  // returned card (design panel 2b, keyboard).
  useEffect(() => {
    if (!held) return;
    const door = document.querySelector<HTMLElement>('[data-board-held] a');
    const card = document.querySelector<HTMLElement>(`[data-testid="board-card-${held.itemKey}"]`);
    (door ?? card)?.focus();
  }, [held]);

  // The horizontal scroll region (the flat column row) + which column is centred
  // in it — drives the mobile pager (Subtask 3.2.6, design panel 7). On a narrow
  // viewport the flat board reads as a single-column scroll; the pager shows
  // "{name} · {i} of {n}". (Swimlane mode has its own scroll container.)
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeColumn = useActiveColumnIndex(scrollRef, columns.length);

  // A mirror ref so the drag handlers read the LATEST columns synchronously
  // (a dnd lifecycle event can fire before a state update has re-rendered),
  // and a snapshot of the columns at pick-up for the snap-back on rejection.
  // The mirror is kept in sync via a LAYOUT effect (writing a ref during render
  // is forbidden) — a layout effect flushes synchronously at commit, before the
  // next pointer/keyboard drag event, so each handler reads the prior event's
  // committed columns (a passive effect could lag a fast move→drop). BoardDnd
  // only mounts client-side (the ready branch), so there is no SSR warning.
  const columnsRef = useRef(columns);
  useLayoutEffect(() => {
    columnsRef.current = columns;
  }, [columns]);
  const snapshotRef = useRef<BoardColumnDto[] | null>(null);

  // A lane's NEXT PAGE (MOTIR-10535) — asked for by the lane's scroll-to-load
  // sentinel. One page in flight per lane (the ref, read synchronously, so a
  // second sentinel report in the same frame cannot double-fetch). The page is
  // read with the board's own filter, so it holds only cards the filtered lane
  // shows. A card already on the board — one dragged into this lane after its
  // first page loaded, or one already shown in another lane — is skipped: the
  // local position of a moved card is authoritative until the next projection.
  const inFlightRef = useRef(new Set<string>());
  const loadMore = useCallback(
    async (columnId: string) => {
      const col = columnsRef.current.find((c) => c.id === columnId);
      if (!col?.cursor || inFlightRef.current.has(columnId)) return;
      inFlightRef.current.add(columnId);
      setLoadStates((prev) => ({ ...prev, [columnId]: 'loading' }));
      const params = new URLSearchParams({ boardId: board.boardId, cursor: col.cursor });
      if (filterParam) params.set('filter', filterParam);
      try {
        const res = await fetch(`/api/board/columns/${columnId}/cards?${params.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`page ${res.status}`);
        const page = (await res.json()) as BoardColumnPageDto;
        setColumns((prev) => appendColumnPage(prev, page));
        setPlanHolds((prev) => ({ ...prev, ...page.planHolds }));
        setLoadStates((prev) => ({ ...prev, [columnId]: 'idle' }));
      } catch {
        setLoadStates((prev) => ({ ...prev, [columnId]: 'error' }));
      } finally {
        inFlightRef.current.delete(columnId);
      }
    },
    [board.boardId, filterParam],
  );

  // Horizontal edge auto-scroll for the flat board (bug-board-cannot-drag-from-
  // in-review-to-done). The flat board is a horizontally-scrolling column row
  // (`scrollRef`, `overflow-x-auto`): on a laptop-width viewport the trailing
  // columns (Done, Cancelled) sit PAST the fold, so dragging a card toward them
  // requires the row to scroll. dnd-kit's built-in auto-scroll handles this
  // container too aggressively — its default ~20% edge threshold slams the row
  // straight to its scroll boundary the instant the dragged card enters the
  // zone, overshooting the intended column (Done) to the LAST one (Cancelled),
  // so the card can never be landed on Done (it commits to Cancelled or snaps
  // back). So we take this row off dnd-kit's auto-scroll (the `autoScroll.
  // canScroll` gate on the DndContext below) and drive it ourselves with a
  // CONTROLLED scroll: only a NARROW edge band activates it, off the REAL
  // pointer, at a gentle speed. As a hidden column scrolls under the pointer
  // dnd-kit re-measures droppables (`measuring` re-runs on scroll) and `over`
  // resolves to it, so the existing `onDragOver` relocation + drop commit fire
  // normally. Only the flat row uses `scrollRef`; in swimlane mode it is null,
  // so this is a no-op there (swimlane keeps dnd-kit's auto-scroll — out of
  // scope for this bug).
  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollSpeedRef = useRef(0);
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    autoScrollSpeedRef.current = 0;
  }, []);
  // Start the rAF loop that advances `scrollLeft` by the current speed each
  // frame until the speed is cleared or a scroll boundary is reached. `step` is
  // a local named function so it can schedule itself without a forward
  // self-reference to a `useCallback`.
  const startAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) return; // already running
    const step = () => {
      const el = scrollRef.current;
      const speed = autoScrollSpeedRef.current;
      if (!el || speed === 0) {
        autoScrollRafRef.current = null;
        return;
      }
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.max(0, Math.min(max, el.scrollLeft + speed));
      if (next === el.scrollLeft) {
        // Hit a scroll boundary — idle the loop until the speed changes.
        autoScrollSpeedRef.current = 0;
        autoScrollRafRef.current = null;
        return;
      }
      el.scrollLeft = next;
      autoScrollRafRef.current = requestAnimationFrame(step);
    };
    autoScrollRafRef.current = requestAnimationFrame(step);
  }, []);
  // Recompute the auto-scroll speed from the real pointer's X. `EDGE` is the
  // activation band at each side; speed ramps 0→MAX across it.
  const updateAutoScroll = useCallback(
    (pointerX: number | null) => {
      const el = scrollRef.current;
      if (!el || pointerX == null) {
        stopAutoScroll();
        return;
      }
      // A NARROW activation band at each side. It must be smaller than half a
      // column so resting the pointer on the last on-screen column (whose right
      // edge hugs the row's right edge) does NOT trigger a scroll — only a
      // pointer pushed into the thin strip past that column's body scrolls.
      const EDGE = 48;
      const MAX = 18;
      const rect = el.getBoundingClientRect();
      const canScrollRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
      const canScrollLeft = el.scrollLeft > 1;
      let speed = 0;
      if (pointerX > rect.right - EDGE && canScrollRight) {
        speed = MAX * Math.min(1, (pointerX - (rect.right - EDGE)) / EDGE);
      } else if (pointerX < rect.left + EDGE && canScrollLeft) {
        speed = -MAX * Math.min(1, (rect.left + EDGE - pointerX) / EDGE);
      }
      autoScrollSpeedRef.current = speed;
      if (speed !== 0) {
        startAutoScroll();
      } else {
        stopAutoScroll();
      }
    },
    [stopAutoScroll, startAutoScroll],
  );
  // Stop any in-flight loop if the board unmounts mid-drag.
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const colName = useCallback(
    (cols: BoardColumnDto[], colId: string | null) => cols.find((c) => c.id === colId)?.name ?? '',
    [],
  );
  const laneLabel = useCallback(
    (key: string) => board.swimlanes.find((l) => l.key === key)?.label ?? key,
    [board.swimlanes],
  );

  const snapBack = useCallback(
    (snapshot: BoardColumnDto[], description: string) => {
      setColumns(snapshot);
      toast({ variant: 'error', title: t('moveRejectedTitle'), description });
    },
    [t, toast],
  );

  // FLAT-mode move (3.2.4) — full-snapshot revert (no lane axis to isolate).
  const runMove = useCallback(
    async (args: {
      workItemId: string;
      toColumnId: string;
      beforeId?: string;
      afterId?: string;
      snapshot: BoardColumnDto[];
      card: BoardCardDto;
      fromColName: string;
      toColName: string;
    }) => {
      try {
        const res = await fetch('/api/board/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            boardId: board.boardId,
            workItemId: args.workItemId,
            toColumnId: args.toColumnId,
            beforeId: args.beforeId,
            afterId: args.afterId,
          }),
        });
        if (res.ok) {
          const result = (await res.json()) as MoveCardResultDto;
          setColumns((prev) => reconcileCard(prev, result.card));
          return;
        }
        const key = args.card.identifier;
        const heldRefusal = await readHeldRefusal(res);
        if (heldRefusal) {
          setColumns(args.snapshot);
          if (heldRefusal.code === 'PLAN_TARGET_HELD')
            showPlanHeld(args.card, heldRefusal.plan, columnsRef.current);
          else if (heldRefusal.code === 'MARKED_CARD_CANNOT_REOPEN')
            showMarkHeld(args.card, heldRefusal.mark);
          else showHeld(args.card, args.toColName, heldRefusal.gate);
          return;
        }
        if (res.status === 409) {
          snapBack(
            args.snapshot,
            t('moveIllegalDescription', { from: args.fromColName, to: args.toColName, key }),
          );
        } else if (res.status === 422) {
          snapBack(args.snapshot, t('moveUnmappedDescription', { to: args.toColName, key }));
        } else {
          snapBack(args.snapshot, t('moveErrorDescription', { key }));
        }
      } catch {
        snapBack(args.snapshot, t('moveErrorDescription', { key: args.card.identifier }));
      }
    },
    [board.boardId, snapBack, showHeld, showMarkHeld, showPlanHeld, t],
  );

  // SWIMLANE transition (column axis) — INDEPENDENT revert: on rejection, move
  // the card back to its origin column (keeping any accepted lane reassign) and
  // undo the optimistic count, rather than restoring the whole snapshot.
  const runTransition = useCallback(
    async (args: {
      workItemId: string;
      originColId: string;
      targetColId: string;
      beforeId?: string;
      afterId?: string;
      card: BoardCardDto;
      fromColName: string;
      toColName: string;
    }) => {
      const revert = () => {
        setColumns((prev) =>
          transferCount(
            moveCardToColumn(prev, args.workItemId, args.originColId),
            args.targetColId,
            args.originColId,
          ),
        );
      };
      try {
        const res = await fetch('/api/board/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            boardId: board.boardId,
            workItemId: args.workItemId,
            toColumnId: args.targetColId,
            beforeId: args.beforeId,
            afterId: args.afterId,
          }),
        });
        if (res.ok) {
          const result = (await res.json()) as MoveCardResultDto;
          // Keep the optimistic swimlaneKey (the reassign axis owns it); take the
          // server's confirmed status / position / ready.
          setColumns((prev) =>
            reconcileCard(prev, { ...result.card, swimlaneKey: laneKeyOfCard(args.card) }),
          );
          return;
        }
        const key = args.card.identifier;
        revert();
        const heldRefusal = await readHeldRefusal(res);
        if (heldRefusal) {
          if (heldRefusal.code === 'PLAN_TARGET_HELD')
            showPlanHeld(args.card, heldRefusal.plan, columnsRef.current);
          else if (heldRefusal.code === 'MARKED_CARD_CANNOT_REOPEN')
            showMarkHeld(args.card, heldRefusal.mark);
          else showHeld(args.card, args.toColName, heldRefusal.gate);
          return;
        }
        const description =
          res.status === 409
            ? t('moveIllegalDescription', { from: args.fromColName, to: args.toColName, key })
            : res.status === 422
              ? t('moveUnmappedDescription', { to: args.toColName, key })
              : t('moveErrorDescription', { key });
        toast({ variant: 'error', title: t('moveRejectedTitle'), description });
      } catch {
        revert();
        toast({
          variant: 'error',
          title: t('moveRejectedTitle'),
          description: t('moveErrorDescription', { key: args.card.identifier }),
        });
      }
    },
    [board.boardId, showHeld, showMarkHeld, showPlanHeld, t, toast],
  );

  // SWIMLANE reassign (lane axis) — reuses the EXISTING 2.5 field-update action.
  // INDEPENDENT revert: on rejection, restore only the card's `swimlaneKey` to
  // its origin lane (any accepted transition stays).
  const runReassign = useCallback(
    async (args: {
      workItemId: string;
      originLaneKey: string;
      targetLaneKey: string;
      card: BoardCardDto;
    }) => {
      const result = await updateIssueAction({
        id: args.workItemId,
        ...reassignPatchForLane(groupBy, args.targetLaneKey),
      });
      if (!result.ok) {
        setColumns((prev) => setCardSwimlaneKey(prev, args.workItemId, args.originLaneKey));
        toast({
          variant: 'error',
          title: t('reassignRejectedTitle'),
          description: result.error || t('reassignErrorDescription', { key: args.card.identifier }),
        });
      }
    },
    [groupBy, t, toast],
  );

  // Set or clear a column's WIP limit (Subtask 3.3.6) — the optimistic config
  // write the `[⋯]` menu's "Set WIP limit" editor triggers. Apply the new
  // `wipLimit` to the column immediately, PATCH `…/board/columns/[id]` (3.3.3),
  // then reconcile to the returned column DTO; on any failure revert to the
  // pre-edit snapshot and toast. Config only — it never touches a card's
  // column/position, so the 3.2.4 move contract is unaffected (WIP is a SOFT,
  // advisory warning that does not gate drops).
  const setColumnWip = useCallback(
    async (columnId: string, limit: number | null) => {
      const snapshot = columnsRef.current;
      const name = colName(snapshot, columnId);
      setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, wipLimit: limit } : c)));
      try {
        const res = await fetch(`/api/board/columns/${columnId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ wipLimit: limit }),
        });
        if (res.ok) {
          const dto = (await res.json()) as BoardColumnConfigDto;
          setColumns((prev) =>
            prev.map((c) => (c.id === columnId ? { ...c, wipLimit: dto.wipLimit } : c)),
          );
          return;
        }
        setColumns(snapshot);
        toast({
          variant: 'error',
          title: t('wipSaveErrorTitle'),
          description: t('wipSaveErrorDescription', { column: name }),
        });
      } catch {
        setColumns(snapshot);
        toast({
          variant: 'error',
          title: t('wipSaveErrorTitle'),
          description: t('wipSaveErrorDescription', { column: name }),
        });
      }
    },
    [colName, t, toast],
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    // The start of the next drag closes a held line (design panel 2b).
    setHeld(null);
    snapshotRef.current = columnsRef.current;
    setActiveCard(findCard(columnsRef.current, String(e.active.id)));
  }, []);

  // Drive the flat board's horizontal edge auto-scroll from the live pointer, so
  // trailing off-screen columns become reachable mid-drag (see the auto-scroll
  // refs above).
  const handleDragMove = useCallback(
    (e: DragMoveEvent) => {
      // Key auto-scroll off the ACTUAL pointer (activator + accumulated delta),
      // not the wide dragged card's centre — the card can overlap the edge band
      // while the user's cursor is still resting on a column's body. Keyboard
      // drags have no pointer coordinate (and move column-by-column), so they
      // pass null and never edge-scroll.
      const act = e.activatorEvent;
      const clientX = act && 'clientX' in act ? (act as PointerEvent).clientX : null;
      updateAutoScroll(clientX == null ? null : clientX + e.delta.x);
    },
    [updateAutoScroll],
  );

  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e;
      if (!over) return;
      const cols = columnsRef.current;
      const activeId = String(active.id);
      const overId = String(over.id);

      if (!swimlaned) {
        // FLAT (3.2.4) — relocate within / across columns.
        const fromColId = findCardColumnId(cols, activeId);
        const overColId = columnOfOverId(cols, overId);
        if (!fromColId || !overColId) return;
        const overCol = cols.find((c) => c.id === overColId);
        const overIsColumn = overId === overColId;
        const len = overCol?.cards.length ?? 0;
        if (fromColId === overColId) {
          if (overIsColumn || overId === activeId) return;
          const fromIndex = cardIndex(cols, fromColId, activeId);
          const overIndex = cardIndex(cols, overColId, overId);
          if (fromIndex === -1 || overIndex === -1 || fromIndex === overIndex) return;
          setColumns(relocateCard(cols, activeId, overColId, overIndex));
          return;
        }
        const toIndex = overIsColumn ? len : Math.max(0, cardIndex(cols, overColId, overId));
        setColumns(relocateCard(cols, activeId, overColId, toIndex));
        return;
      }

      // SWIMLANE (3.3.5 + 3.3.8) — DO NOT relocate the card across cells during
      // the drag. A `(column × lane)` cell has no fixed height, so moving the card
      // in/out resizes the source + target cells; dnd-kit then re-measures, the
      // closest-corners `over` flips to the resized neighbour, `onDragOver` fires
      // again, and the relocate → resize → re-measure cycle loops synchronously
      // until React throws "Maximum update depth exceeded" mid-drag
      // (PRODECT_FINDINGS #61; the flat board above is immune because its columns
      // are fixed-height internal scrollers). So here we only track the hovered
      // lane for the drop highlight; the actual move is resolved ONCE on drop
      // (handleDragEnd → resolveSwimlaneDrop), and the DragOverlay provides the
      // in-flight visual feedback.
      const targetCell = cellOfOverId(cols, overId);
      if (!targetCell) return;
      setOverLaneKey(targetCell.laneKey);
    },
    [swimlaned],
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      setActiveCard(null);
      setOverLaneKey(null);
      stopAutoScroll();
      const snapshot = snapshotRef.current ?? columnsRef.current;
      snapshotRef.current = null;
      const cols = columnsRef.current;
      const activeId = String(active.id);

      if (!over) {
        setColumns(snapshot);
        return;
      }

      if (!swimlaned) {
        // FLAT (3.2.4) — unchanged.
        const targetColId = findCardColumnId(cols, activeId);
        const originColId = findCardColumnId(snapshot, activeId);
        if (!targetColId || !originColId) {
          setColumns(snapshot);
          return;
        }
        const originIndex = cardIndex(snapshot, originColId, activeId);
        const finalIndex = cardIndex(cols, targetColId, activeId);
        if (originColId === targetColId && originIndex === finalIndex) {
          setColumns(snapshot);
          return;
        }
        const optimistic = transferCount(cols, originColId, targetColId);
        setColumns(optimistic);
        const card = findCard(optimistic, activeId);
        if (!card) {
          setColumns(snapshot);
          return;
        }
        const { beforeId, afterId } = neighborsOf(optimistic, targetColId, activeId);
        void runMove({
          workItemId: activeId,
          toColumnId: targetColId,
          beforeId,
          afterId,
          snapshot,
          card,
          fromColName: colName(snapshot, originColId),
          toColName: colName(optimistic, targetColId),
        });
        return;
      }

      // SWIMLANE (3.3.5 + 3.3.8) — resolve the move from the drop's `over` target.
      // The card was NOT relocated live on dragOver (it looped — see
      // handleDragOver), so move it into the target cell ONCE here and derive the
      // structured move from snapshot → relocated.
      const resolved = resolveSwimlaneDrop(snapshot, String(over.id), activeId);
      if (!resolved) {
        setColumns(snapshot);
        return;
      }
      const { move, relocated } = resolved;
      const { columnChanged, laneChanged } = move;
      const rankChanged =
        !columnChanged && !laneChanged && move.originIndexInCell !== move.finalIndexInCell;
      if (!columnChanged && !laneChanged && !rankChanged) {
        // Dropped back where it started — restore the canonical snapshot.
        setColumns(snapshot);
        return;
      }

      // Apply the optimistic move (+ count transfer for a column change), then
      // read the settled card.
      const optimistic = columnChanged
        ? transferCount(relocated, move.originColId, move.targetColId)
        : relocated;
      setColumns(optimistic);
      const card = findCard(optimistic, activeId);
      if (!card) {
        setColumns(snapshot);
        return;
      }

      if (columnChanged || rankChanged) {
        void runTransition({
          workItemId: activeId,
          originColId: move.originColId,
          targetColId: move.targetColId,
          beforeId: move.beforeId,
          afterId: move.afterId,
          card,
          fromColName: colName(snapshot, move.originColId),
          toColName: colName(optimistic, move.targetColId),
        });
      }
      if (laneChanged) {
        void runReassign({
          workItemId: activeId,
          originLaneKey: move.originLaneKey,
          targetLaneKey: move.targetLaneKey,
          card,
        });
      }
    },
    [swimlaned, colName, runMove, runTransition, runReassign, stopAutoScroll],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
    setOverLaneKey(null);
    stopAutoScroll();
    if (snapshotRef.current) {
      setColumns(snapshotRef.current);
      snapshotRef.current = null;
    }
  }, [stopAutoScroll]);

  // aria-live narration. In swimlane mode the DROP announcement distinguishes a
  // reassign (lane only) / transition (column only) / diagonal (both) per the
  // 3.3.1 copy; pick-up + move reuse the flat copy.
  const announcements = useMemo<Announcements>(() => {
    const keyOf = (id: string) => findCard(columnsRef.current, id)?.identifier ?? id;
    const at = (overId: string) => {
      const cols = columnsRef.current;
      const colId = swimlaned ? cellOfOverId(cols, overId)?.columnId : columnOfOverId(cols, overId);
      const col = cols.find((c) => c.id === colId);
      if (!col) return null;
      const idx = overId === colId ? col.cards.length : cardIndex(cols, col.id, overId);
      return {
        col: col.name,
        index: (idx < 0 ? col.cards.length : idx) + 1,
        count: col.cards.length,
      };
    };
    return {
      onDragStart({ active }) {
        const info = at(String(active.id));
        return info
          ? t('announcementPickedUp', { key: keyOf(String(active.id)), ...info })
          : undefined;
      },
      onDragOver({ active, over }) {
        if (!over) return undefined;
        const info = at(String(over.id));
        return info
          ? t('announcementMoved', { key: keyOf(String(active.id)), ...info })
          : undefined;
      },
      onDragEnd({ active, over }) {
        if (!over) return undefined;
        const key = keyOf(String(active.id));
        const cols = columnsRef.current;
        if (!swimlaned) {
          const colId = columnOfOverId(cols, String(over.id));
          return t('announcementDropped', { key, col: colName(cols, colId) });
        }
        // Resolve from the drop's `over` (the card isn't relocated live in
        // swimlane mode anymore — 3.3.8), against the pre-drag snapshot.
        const move = snapshotRef.current
          ? (resolveSwimlaneDrop(snapshotRef.current, String(over.id), String(active.id))?.move ??
            null)
          : null;
        if (!move) return undefined;
        const col = colName(cols, move.targetColId);
        const group = laneLabel(move.targetLaneKey);
        if (move.columnChanged && move.laneChanged)
          return t('announcementDiagonal', { key, col, group });
        if (move.laneChanged) return t('announcementReassigned', { key, group });
        return t('announcementDropped', { key, col });
      },
      onDragCancel({ active }) {
        const snap = snapshotRef.current ?? columnsRef.current;
        const colId = findCardColumnId(snap, String(active.id));
        return t('announcementCancelled', {
          key: keyOf(String(active.id)),
          col: colName(snap, colId),
        });
      },
    };
  }, [swimlaned, colName, laneLabel, t]);

  // Read-only: hand DndContext an EMPTY sensor list so no pointer/keyboard drag
  // can ever activate (the cards stay rendered + peekable, just not movable).
  const activeSensors = canEdit ? sensors : [];

  // FLAT board: resolve the drop to the droppable the POINTER is literally
  // inside (`pointerWithin`), not the nearest corners (`closestCorners`).
  // closestCorners measures corner distance, so a drop on a TALL EMPTY column
  // (e.g. an In Review with no cards) loses to a nearby POPULATED column's
  // small card — the card silently lands in the wrong column (often an illegal
  // transition → "Move not allowed"), and an empty column becomes un-droppable.
  // pointerWithin fixes that; fall back to closestCorners only when the pointer
  // is outside every droppable (a gutter / past the last column) so a drop is
  // never lost. SWIMLANE mode keeps closestCorners — its (column×lane) grid was
  // tuned around it (handleDragOver) and is out of scope for this bug.
  const collisionDetectionStrategy: CollisionDetection = useCallback(
    (args) => {
      if (swimlaned) return closestCorners(args);
      const pointer = pointerWithin(args);
      return pointer.length > 0 ? pointer : closestCorners(args);
    },
    [swimlaned],
  );

  return (
    <BoardHeldRefusalProvider
      value={{
        held,
        close: closeHeld,
        planHolds,
        projectName,
        highlightedPlanId,
        onPlanFooterHover: setHoverPlanId,
      }}
    >
      {/* The held refusal's announcement (design panel 2b) — beside dnd-kit's own
        live region, which narrates the drag itself. */}
      <div aria-live="polite" className="sr-only" data-testid="board-held-announcement">
        {held ? heldAnnouncement : ''}
      </div>
      <DndContext
        sensors={activeSensors}
        collisionDetection={collisionDetectionStrategy}
        // dnd-kit's built-in auto-scroll handles VERTICAL scrolling inside a tall
        // column (drag a card to a column's top/bottom edge), but its default
        // HORIZONTAL behaviour on the flat column row is too aggressive: its 20%
        // edge threshold slams the row to its scroll boundary the instant the card
        // enters it, overshooting past the intended column (Done) to the last one
        // (Cancelled) — the bug-board-cannot-drag-from-in-review-to-done failure.
        // So we take the flat row (`scrollRef`) off dnd-kit's auto-scroll and drive
        // it ourselves (handleDragMove → updateAutoScroll: a narrow edge band, the
        // real pointer, a gentle speed), while leaving every OTHER scrollable
        // (column bodies, the swimlane grid) on dnd-kit's auto-scroll.
        autoScroll={{ canScroll: (el) => el !== scrollRef.current }}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('dndInstructions') },
        }}
      >
        {swimlaned ? (
          <SwimlaneBoard
            boardId={board.boardId}
            columns={columns}
            swimlanes={board.swimlanes}
            assigneeNameById={assigneeNameById}
            onOpenQuickView={openPeek}
            onSetWipLimit={setColumnWip}
            activeCardId={activeCard?.id ?? null}
            overLaneKey={overLaneKey}
            columnPoints={columnPoints}
            loadStates={loadStates}
            onLoadMore={loadMore}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {/* The horizontally-scrolling column row. Scroll-snap (proximity, so it
              never fights a deliberate scroll) makes narrow viewports read as a
              single-column pager (3.2.6, panel 7); each column is wrapped with
              `data-board-column` so the pager hook can locate it. The wrapper is
              the snap target — BoardColumn keeps its own droppable ref + width. */}
            <div
              ref={scrollRef}
              role="group"
              aria-label={t('boardLabel')}
              tabIndex={0}
              // `data-board-scroll`: under the 3D / Immersive style this row widens
              // its gap and adds bottom room so each column's float shadow shows
              // (the `overflow-x-auto` here forces overflow-y to clip — see
              // globals.css). Inert under every other style.
              data-board-scroll=""
              className="flex snap-x snap-proximity gap-4 overflow-x-auto pb-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              data-testid="board"
            >
              {columns.map((column) => (
                <div key={column.id} data-board-column className="flex shrink-0 snap-start">
                  <BoardColumn
                    column={column}
                    boardId={board.boardId}
                    assigneeNameById={assigneeNameById}
                    onOpenQuickView={openPeek}
                    activeCardId={activeCard?.id ?? null}
                    onSetWipLimit={setColumnWip}
                    points={columnPoints?.[column.id] ?? null}
                    loadState={loadStates[column.id] ?? 'idle'}
                    onLoadMore={loadMore}
                  />
                </div>
              ))}
            </div>
            <BoardColumnPager columns={columns} activeIndex={activeColumn} />
          </div>
        )}
        <DragOverlay>
          {activeCard ? (
            <BoardCardOverlay
              card={activeCard}
              assigneeName={
                activeCard.assigneeId ? (assigneeNameById.get(activeCard.assigneeId) ?? null) : null
              }
              routedToName={
                activeCard.pendingDecision
                  ? (assigneeNameById.get(activeCard.pendingDecision.routedToId ?? '') ?? null)
                  : null
              }
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </BoardHeldRefusalProvider>
  );
}
