// DTOs for the board domain (Story 3.1). The wire-safe shapes the board
// services return — no Prisma row (Date objects, Decimal instances, Prisma
// enums) crosses the API boundary; mappers in `lib/mappers/boardMappers.ts`
// produce these.
//
// `BoardCardDto` is the projection of a `work_item` AS A BOARD CARD. It is
// introduced here by the move path (Subtask 3.1.5) — the first board write —
// and is the SAME card shape the read projection (Subtask 3.1.4) returns for
// every column, so the 3.2 UI reconciles an optimistic move against an
// identically-shaped card. (3.1.4 may enrich it with a resolved assignee
// summary for the projection; the move path populates `assigneeId` — the id is
// what the optimistic-update reconcile needs, the UI already holds the avatar.)

import type { CardReviewDTO } from '@/lib/dto/reviewState';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemObsolescenceDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import type { SprintPointsDto } from '@/lib/dto/estimation';
import type { SprintStateDto } from '@/lib/dto/sprints';
import type { FilterAst, FilterEnvelope } from '@/lib/filters/ast';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';

/** Board kind — mirrors the Prisma `BoardType` enum (Story 3.1.1). */
export type BoardTypeDto = 'kanban' | 'scrum';

/**
 * Swimlane group-by — mirrors the Prisma `BoardSwimlaneGroupBy` enum (Subtask
 * 3.3.2). `none` is the flat 3.2 board (the default); the others slice the
 * board into horizontal lanes by that dimension (3.3.4 resolves each card's
 * lane server-side, `epic` by ANCESTOR epic).
 */
export type BoardSwimlaneGroupByDto =
  | 'none'
  | 'assignee'
  | 'epic'
  | 'priority'
  // MOTIR-11585 — single-value work-item fields (one lane per card).
  | 'reporter'
  | 'type'
  | 'difficulty'
  | 'executor'
  | 'kind'
  // MOTIR-11585 — MULTI-VALUE fields: a card sits in the lane of EACH of its
  // values (see {@link BOARD_MULTI_VALUE_GROUP_BYS}).
  | 'label'
  | 'component'
  | 'repository';

/**
 * The group-bys whose field holds SEVERAL values per card (MOTIR-11585): a card
 * with two labels is in both label lanes, each lane counts it once, and the
 * column total still counts it once. On these boards the same card renders in
 * more than one cell, so the client keys each rendering by its lane.
 */
export const BOARD_MULTI_VALUE_GROUP_BYS: ReadonlySet<BoardSwimlaneGroupByDto> = new Set([
  'label',
  'component',
  'repository',
]);

/**
 * The group-bys a card can be DRAGGED between lanes in (MOTIR-11585): the drop
 * writes the grouped field through the work-item update. Every other grouping
 * keeps a card in its lane — reporter is the author, kind has its own flow, and
 * a multi-value move is ambiguous — while moves between columns still work.
 */
export const BOARD_CROSS_LANE_GROUP_BYS: ReadonlySet<BoardSwimlaneGroupByDto> = new Set([
  'assignee',
  'epic',
  'priority',
  'type',
  'difficulty',
  'executor',
]);

/**
 * The swimlane dimensions that actually slice the board into lanes — the
 * group-by values MINUS `none` (which is the flat board, no lanes). It is the
 * `kind` a `BoardSwimlaneDto` carries so the 3.3.5 UI knows which lane-header
 * renderer to use (assignee summary / epic key+title / priority pill).
 */
export type BoardSwimlaneKindDto = Exclude<BoardSwimlaneGroupByDto, 'none'>;

/**
 * The reserved `swimlaneKey` for the **catch-all lane** — a card with no value
 * for the active group-by (unassigned, or no ancestor epic). Both the per-card
 * `swimlaneKey` and the catch-all `BoardSwimlaneDto.key` use this sentinel, so
 * the UI buckets catch-all cards into the catch-all lane by key equality. It is
 * NOT a real id (cuid) or priority value, so it can never collide with a live
 * lane key. Priority, reporter and kind have no catch-all (every card has
 * one), so this never appears under those group-bys.
 */
export const BOARD_SWIMLANE_NO_VALUE = '__no_value__';

/**
 * One swimlane in the board projection (Subtask 3.3.4) — a horizontal row the
 * board is sliced into under a non-`none` group-by. Built from a BOUNDED
 * grouped/distinct aggregate over the board's cards (lanes-with-cards + the
 * catch-all), NEVER by loading every card (finding #57). `key` is the value the
 * cards' `swimlaneKey` matches (an assignee/epic id, a priority value, or
 * {@link BOARD_SWIMLANE_NO_VALUE} for the catch-all); `label` is the
 * display-ready header text (assignee name / `PROD-12 Epic title` / priority /
 * "No assignee" / "No epic"); `kind` is the active dimension; `count` is the
 * per-lane TOTAL across all columns (the aggregate, independent of how many
 * cards are loaded per column). Lanes arrive in the documented order (assignee
 * alpha / priority rank / epic position) with the catch-all always last.
 */
export interface BoardSwimlaneDto {
  key: string;
  label: string;
  kind: BoardSwimlaneKindDto;
  count: number;
}

/**
 * The board's config row (Subtask 3.3.3) — the wire shape `setSwimlaneGroupBy`
 * returns after a config write so the 3.3.5 UI reconciles. Deliberately the
 * board's identity + config only (NOT the heavy `BoardProjectionDto`, which the
 * 3.1.4 read path / 3.3.4 lane extension owns): `id`, `name`, `type`, and the
 * active `swimlaneGroupBy`.
 */
export interface BoardDto {
  id: string;
  name: string;
  type: BoardTypeDto;
  swimlaneGroupBy: BoardSwimlaneGroupByDto;
  /**
   * The board's OWN stored filter (MOTIR-10560), as the stored `FilterEnvelope`
   * (`{ v, c, f }`, `lib/filters/ast.ts`) it was validated and normalised into
   * on write; `null` when the board has none and shows its whole scope.
   */
  filter: FilterEnvelope | null;
}

/**
 * A board's switcher row (Subtask 3.7.3) — the wire shape the multi-board CRUD
 * surface returns: `GET /api/boards` lists these for the active project, and
 * `createBoard` / `setDefaultBoard` return the affected board as one. It is the
 * board's identity + the two fields the 3.7.4 switcher renders that `BoardDto`
 * omits: `isDefault` (badge the project default) and `position` (the
 * fractional-index key the switcher orders boards by). NOT the heavy
 * `BoardProjectionDto` (the read path owns that) — just enough to populate the
 * switcher without a projection fetch per board.
 */
export interface BoardSummaryDto {
  id: string;
  name: string;
  type: BoardTypeDto;
  /** True for the project's one default board (the one `/boards` opens absent `?board=`). */
  isDefault: boolean;
  /** Fractional-index sort key (opaque string) — the switcher's board order. */
  position: string;
}

/**
 * One column's config row (Subtask 3.3.3) — the wire shape `setColumnWipLimit`
 * returns so the 3.3.6 UI reconciles its optimistic WIP edit. The column's
 * identity + its `wipLimit` (null = no limit); NOT the projection's cards /
 * statusKeys / counts (those belong to the read projection, 3.1.4 / 3.3.4).
 */
export interface BoardColumnConfigDto {
  id: string;
  name: string;
  /** Fractional-index sort key (opaque string). */
  position: string;
  /** WIP limit, or null when no limit is set (Story 3.3). */
  wipLimit: number | null;
}

/**
 * One column↔status mapping edge (Subtask 3.6.2) — the wire shape
 * `mapStatusToColumn` returns after a status is mapped/moved into a column, so
 * the 3.6.3 UI reconciles its optimistic edit. It is the `board_column_status`
 * row's identity: which `statusId` now lives in which `columnId` on which
 * `boardId`. (Unmapping returns no DTO — the edge is gone — and `void` is the
 * end state.) A status maps to AT MOST ONE column per board
 * (`@@unique([boardId, statusId])`, Story 3.1.1), so this single edge fully
 * describes the status's placement.
 */
export interface BoardColumnStatusDto {
  boardId: string;
  columnId: string;
  statusId: string;
}

/**
 * One work item rendered as a board card. The row-render fields a column card
 * shows (kind icon, identifier, title, assignee, status, priority) plus the
 * board wiring (`position` for rank, `parentId`), the schedule fields a card
 * surfaces (`dueDate`, `estimateMinutes`), and the finding-#21 readiness
 * signal (`ready` is false when an open `is_blocked_by` blocker remains) so a
 * card can show a blocked indicator. `dueDate` is normalized to an ISO string;
 * `position` is already the opaque fractional-index string on the row.
 */
export interface BoardCardDto {
  /** A Visitor's PRIVATE epic (MOTIR-6648): the card wears "Not public". Absent
   *  on every member read. */
  childrenHidden?: true;
  id: string;
  projectId: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  /** The agile STORY-POINT estimate (Story 4.3.4). `BoardCardView` renders it as
   *  the static `.pts` chip (MOTIR-2618) — UNCONDITIONALLY, like the scrum
   *  `ColumnPointsBadge` total it has to explain, not gated on the project's
   *  `estimationStatistic`. `null` renders no chip. */
  storyPoints: number | null;
  position: string;
  /** False iff an `is_blocked_by` blocker remains in a non-terminal status (finding #21).
   *  The readiness CASCADE — own blockers done and every ancestor ready. The card
   *  draws the blocked flag off it (MOTIR-10534). */
  ready: boolean;
  /**
   * THE CANVAS'S READY (MOTIR-10534): in a startable (`todo`-category) status AND
   * {@link ready} — the rule the roadmap read writes into `RoadmapNodeDto.ready`
   * (`isReadyToStart`), so the card's status slot shows the Ready pill on exactly
   * the items the canvas does. `ready` alone says only that nothing blocks the
   * card, which is true of a card in progress too.
   */
  readyToStart: boolean;
  /** The status's DISPLAY LABEL from the project's workflow (MOTIR-10534), for the
   *  status chip of a project's custom status. Falls back to the raw key for a row
   *  whose status the workflow no longer holds. */
  statusLabel: string;
  /** Has at least one live (non-archived, non-triage) child — with the kind and
   *  the category it decides the To plan pill (MOTIR-10534). */
  hasChildren: boolean;
  /** HELD out of planning (MOTIR-11546): a story blocked by an unfinished story
   *  with no subtasks yet — `plannabilityService.heldStoryIds`, the Plan button's
   *  own rule — so its slot draws the status chip, not To plan, as the canvas
   *  does. Every board read sets it; absent (a hand-built card) reads not held. */
  planHeld?: boolean;
  /** The work TYPE — with `executor`, decides the Manual chip (MOTIR-10534). */
  type: WorkItemTypeDto | null;
  /** WHO executes the work — `human` (or `type: 'manual'`) is Manual. */
  executor: ExecutorDto | null;
  /**
   * Whether a decision is waiting on this card, and whether it is the READER's
   * (Story MOTIR-4908 · MOTIR-5876) — `approvalGatesService.pendingDecisionsFor`,
   * the same answer the `/items` rows and the item header draw. `null` when no
   * gate awaits. Per-reader, so it lives on the board's own DTO and never on the
   * shared list DTO `/api/v1` also serves.
   */
  pendingDecision: PendingDecisionDTO | null;
  /**
   * The agent review's marker, Reviewed state and container count (Story MOTIR-10327 ·
   * MOTIR-10341) — `reviewStateService.cardReviewsFor`, one batch for the board, beside
   * `pendingDecision` and per-reader like it. Absent or null: the card wears neither.
   */
  review?: CardReviewDTO | null;
  /**
   * The card's CI verdict over its whole delivery set (`WorkItem.ciState`,
   * MOTIR-5470) — `failing` / `running` / `passing` / `null`. The board draws
   * only `failing` and `running`, and only off the `done` category; the rule is
   * `ciBadgeState`, shared with the list, tree and Workbench rows (MOTIR-5474).
   *
   * The board already reads whole `WorkItem` rows, so this costs no extra query.
   */
  ciState: string | null;
  /**
   * Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   * MOTIR-6600), or `null`. The card draws the To fix tag off it, and only off the
   * `done` category — `toFixTagState`, shared with the list, tree and quick view
   * (MOTIR-6610). Raw, like `ciState`, so every surface applies ONE rule.
   */
  fixReason: WorkItemFixReasonDto | null;
  /**
   * The HEAD of the To fix entry this card is carried by (MOTIR-7589), when it is not
   * the head itself — the tag's name gains *· with {head}*. Absent otherwise.
   */
  fixHeadKey?: string;
  /**
   * FIXING (MOTIR-10309 · MOTIR-10506): a repair is live on the card, or a fix was pushed
   * and its checks are running, so the tag reads *Fixing* instead of the reason. `true`
   * only — absent otherwise.
   */
  fixing?: true;
  /**
   * The card's OBSOLESCENCE mark (Story MOTIR-6575 · MOTIR-6677) — `outdated` /
   * `deprecated`, or `null` while it is still true of the code. The card wears the
   * shared `ObsolescenceBadge`; nothing on the board hides, dims or re-sorts a
   * marked card. Off the whole `WorkItem` row the board already reads.
   */
  obsolescence: WorkItemObsolescenceDto | null;
  /**
   * The undecided PLAN holding this card at Planning (Story MOTIR-6017 ·
   * MOTIR-6268; AMENDMENT 21 §1), or `null` when none does — a session-held
   * lease, an expired `generating` lease and a decided plan are all `null`.
   * Read in ONE batch for the board's `planning` cards and passed through
   * `planHoldFor`, the rule the status funnel refuses with, so the board draws
   * the hold up front and the server's refusal cannot disagree with it.
   */
  planHold: PlanHoldDTO | null;
  /**
   * The card's status CATEGORY, resolved SERVER-SIDE from the workflow the board
   * projection already loads — the client never re-derives it, and the badge rule
   * is keyed on the CATEGORY rather than on the column because a board maps
   * statuses to columns many-to-one (a Done column can hold several statuses, and
   * a done status can sit in a column that is not the Done one).
   */
  statusCategory: StatusCategoryDto | null;
  /**
   * The lane this card belongs to under the board's active swimlane group-by
   * (Subtask 3.3.4), resolved SERVER-SIDE so the client never re-derives it:
   * the `assigneeId` / priority value / **ancestor-epic** id, or
   * {@link BOARD_SWIMLANE_NO_VALUE} for the catch-all (unassigned / no epic).
   * OMITTED entirely when the board is `none` (the flat 3.2 board) — so the
   * `none` projection is byte-for-byte the 3.1.4 card shape, no regression.
   */
  swimlaneKey?: string;
}

/**
 * One PLAN that holds cards on the board (Story MOTIR-6017 · MOTIR-6268) — what
 * every held card's footer names it by, and how many items it holds. The label
 * order is `design/boards/design-notes.md`'s `{name}` rule: `anchorKey`, else
 * `title`, else the project's name (which the board already has). `heldCount` is
 * the plan's held items in the board's PROJECT, counted server-side — columns
 * load a bounded set, so a client count would be wrong for a long lane.
 */
export interface BoardPlanHoldSummaryDto {
  /** A PLAN's hold, or an OPEN SESSION's (AMENDMENT 23 §5; MOTIR-7640). */
  kind: 'plan' | 'session';
  /** The plan, or null for a session hold. */
  planId: string | null;
  /** The holding session — a session hold's subject; a plan's session otherwise. */
  sessionId: string | null;
  /** The plan's first anchor key (its session's `targetKeys[0]`), or null. */
  anchorKey: string | null;
  /** The plan's title, or null. */
  title: string | null;
  /** The live items of the board's project this plan holds, the card included. */
  heldCount: number;
}

/**
 * Where a card is dropped: the target column, and the rank neighbours that
 * bracket the drop slot. `beforeId` is the card immediately ABOVE the slot,
 * `afterId` the card immediately BELOW; the moved card's new `position` sorts
 * strictly between their positions. Either may be omitted — the slot at the
 * top of a column has no `beforeId`, the bottom has no `afterId`, and a drop
 * into an empty column has neither.
 */
export interface MoveCardTarget {
  toColumnId: string;
  beforeId?: string;
  afterId?: string;
}

/**
 * The result of `boardsService.moveCard`: the moved card in its post-move
 * state, the status it ended up in (`appliedStatus` — unchanged for an
 * in-column reorder, the resolved target status for a cross-column move), and
 * the resolved target column, so the UI can reconcile its optimistic update.
 */
export interface MoveCardResultDto {
  card: BoardCardDto;
  appliedStatus: string;
  column: { id: string; name: string };
}

/**
 * One column (lane) of the board projection (Subtask 3.1.4, paged per lane by
 * MOTIR-10535): the column meta, its mapped status keys, the LOADED cards
 * (ordered by rank, or by recency for a done-category lane), the FULL count of
 * cards in the lane (`totalCount` — the denominator the header shows against the
 * loaded count), and the cursor of the next page. The projection carries each
 * lane's first page; the client appends further pages as the lane is scrolled
 * (finding #57: a page is the bound, never "load every row") and virtualizes a
 * tall lane.
 */
export interface BoardColumnDto {
  id: string;
  name: string;
  /** Fractional-index sort key (opaque string). */
  position: string;
  /** WIP limit (Story 3.3 enforces; 3.1.4 only surfaces it). */
  wipLimit: number | null;
  /** The workflow status keys this column maps (the statuses its cards hold). */
  statusKeys: string[];
  /**
   * The column's first page of cards — on a FLAT board (`swimlaneGroupBy`
   * `none`) only. On a GROUPED board this is always EMPTY (MOTIR-11445): a
   * grouped board's cards arrive from its lane-scoped cell pages
   * (`BoardLanePageDto` / `BoardCellPageDto`), so a reader must not take an
   * empty array here for an empty column — `totalCount` says that.
   */
  cards: BoardCardDto[];
  /** The column's FULL card count across every lane — the header's denominator,
   *  independent of how many of its cards are loaded (finding #57). Meaningful
   *  on a flat AND a grouped board. */
  totalCount: number;
  /**
   * The lane's next-page cursor (MOTIR-10535): opaque, naming the last loaded
   * card, or `null` when every card of the lane is loaded. The board passes it to
   * `GET /api/board/columns/{id}/cards?cursor=` when the lane is scrolled to its
   * bottom, and replaces it with the page's own cursor. Always `null` on a
   * GROUPED board, whose cells page through their own cursors (MOTIR-11445).
   */
  cursor: string | null;
}

/**
 * The NEXT PAGE of one board lane (MOTIR-10535) — what
 * `GET /api/board/columns/{columnId}/cards?cursor=` answers. `cards` follow the
 * lane's order strictly after the cursor that was sent; `cursor` is the page's
 * own (null when the lane is exhausted); `totalCount` is the lane's CURRENT full
 * count; `planHolds` holds the label fields of every plan that holds one of
 * these cards (merged into the board's `planHolds` by the client).
 */
export interface BoardColumnPageDto {
  columnId: string;
  cards: BoardCardDto[];
  totalCount: number;
  cursor: string | null;
  planHolds: Record<string, BoardPlanHoldSummaryDto>;
}

/**
 * One page of ONE swimlane in ONE column — a board CELL (MOTIR-11444). The
 * grouped board pages each `(lane × column)` cell on its own, so a lane whose
 * header counts 40 never shows an empty cell because other lanes filled the
 * column's page. `cards` are up to `BOARD_PAGE_SIZE` of the lane's cards in that
 * column, in the column's own order (the shipped `BoardCardDto`, its
 * `swimlaneKey` the requested lane); `totalCount` is the cell's CURRENT full
 * count over the same set; `cursor` names the page's last card when more remain
 * (null when the cell is exhausted); `planHolds` holds the label fields of every
 * plan holding one of the response's cards.
 */
export interface BoardCellPageDto {
  columnId: string;
  laneKey: string;
  cards: BoardCardDto[];
  totalCount: number;
  cursor: string | null;
  planHolds: Record<string, BoardPlanHoldSummaryDto>;
}

/**
 * One lane's FIRST page in every column of the board (MOTIR-11444) — what a lane
 * coming into view loads in one request. One cell per column, in the board's
 * column order; every cell carries the response's single merged `planHolds`.
 */
export interface BoardLanePageDto {
  laneKey: string;
  cells: BoardCellPageDto[];
}

/**
 * The active-sprint summary a SCRUM board's projection carries (Subtask 4.5.2)
 * — the data the 4.5.3 sprint header renders. Present only on a `scrum` board
 * that has an active sprint; a kanban board, or a scrum board with no active
 * sprint, carries `sprint: null` on the projection below.
 *
 * `goal` / `startDate` / `endDate` come straight off the resolved active
 * sprint (dates ISO-8601 or null — an active sprint whose window was never
 * stamped, e.g. in a test fixture, has null dates). `state` is always `active`
 * here (the projection only resolves the active sprint), typed as the full
 * `SprintStateDto` for shape-consistency with `SprintDto`. `daysRemaining` is
 * the calendar days from today to `endDate`, FLOORED at 0 (an overdue sprint →
 * 0, surfaced by the UI as "Ended"); `null` when `endDate` is unset.
 *
 * `points` is the bounded `{ committed, completed, remaining }` roll-up over
 * the project's configured estimation statistic (the SAME aggregate Story 4.3
 * exposes via `estimationService.rollupForSprint` — the SUM lives in one
 * place). `columnPoints` is the per-column point total (the Jira scrum "sprint
 * health" number), keyed by `BoardColumnDto.id`: the configured statistic
 * summed over the active sprint's issues whose status maps to that column.
 * Both are aggregate SUMs scoped to the sprint, NEVER a sum over the bounded
 * loaded card page (finding #57). A wholly-unestimated sprint yields all-0
 * figures (the DTO stays total; the UI owns the "—" presentation).
 */
export interface SprintSummaryDto {
  id: string;
  name: string;
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  state: SprintStateDto;
  daysRemaining: number | null;
  points: SprintPointsDto;
  columnPoints: Record<string, number>;
}

/**
 * The board read projection (Subtask 3.1.4, paged per lane by MOTIR-10535): the
 * board's columns (in `position` order), each with its FIRST PAGE of cards, its
 * full `totalCount` and a next-page `cursor`, plus `unmappedStatuses` — every
 * project workflow status mapped to NO column (Jira's behaviour: surfaced, never
 * silently dropped, so the 3.2 UI can offer to map them). The board itself
 * stores no card placement; a card's column is derived from its
 * `work_item.status`.
 */
export interface BoardProjectionDto {
  boardId: string;
  name: string;
  type: BoardTypeDto;
  /**
   * The board's active swimlane group-by (Subtask 3.3.4). `none` is the flat
   * 3.2 board; under a non-`none` value the board slices into `swimlanes` and
   * each card carries a `swimlaneKey`.
   */
  swimlaneGroupBy: BoardSwimlaneGroupByDto;
  columns: BoardColumnDto[];
  /**
   * The ordered lane list when `swimlaneGroupBy` is non-`none` (lanes-with-cards
   * + the catch-all, in the documented order); an EMPTY array when the board is
   * `none` (the flat board has no lanes). Built from a bounded aggregate, never
   * a load-all (finding #57). On a grouped board `columns[]` carries column
   * meta only (empty `cards`, null `cursor`, the full `totalCount`); each
   * (lane, column) cell loads its own cards from the lane-scoped cell pages
   * (MOTIR-11445).
   */
  swimlanes: BoardSwimlaneDto[];
  /**
   * EVERY project status mapped to no column, whatever the board's filter —
   * what Board settings lists, because that is where columns are mapped.
   */
  unmappedStatuses: WorkflowStatusDto[];
  /**
   * The subset of `unmappedStatuses` the board's EFFECTIVE filter could still
   * match (MOTIR-11658) — what the unmapped-statuses tray above the board
   * names. A status leaves it only when the effective filter is an AND whose
   * `status` row provably excludes it (`is_any_of` without it, `is_none_of`
   * with it); with no filter, an OR filter or no status row it equals
   * `unmappedStatuses`. Empty ⇒ no work item is hidden by a missing mapping.
   */
  unmappedStatusesInScope: WorkflowStatusDto[];
  /**
   * The active-sprint summary for a SCRUM board (Subtask 4.5.2) — drives the
   * 4.5.3 sprint header. `null` on a `kanban` board (no sprint scope) AND on a
   * `scrum` board with no active sprint (the 4.5.3 UI then shows the
   * "No active sprint" empty state in place of the board). A scrum board with
   * an active sprint scopes `columns` to that sprint's issues and carries the
   * summary here.
   */
  sprint: SprintSummaryDto | null;
  /**
   * Every plan — or open session — that holds a loaded card, keyed by
   * `planHoldKey` (MOTIR-6268; MOTIR-7640) — the
   * label fields and held count each card's plan footer and refusal read. Empty
   * when no loaded card is held — and ALWAYS empty on a grouped board, which
   * loads no card here: each cell page brings its own `planHolds` (MOTIR-11445).
   */
  planHolds: Record<string, BoardPlanHoldSummaryDto>;
  /**
   * The board's OWN stored filter (MOTIR-10560). It is applied to every column,
   * count, lane page, swimlane and sprint point above when the request carries
   * no header filter; a header filter REPLACES it, and `boardFilter=off` lifts
   * it (MOTIR-11564). Reported either way — stale conditions included — so the
   * client can show and compare the board's own filter. `null` when the board
   * has none, so it shows its whole scope (the project, or the active sprint on
   * a scrum board).
   */
  storedFilter: StoredBoardFilterDto | null;
}

/**
 * Why a stored-filter condition matches nothing (MOTIR-10560): its custom
 * field is gone (`unknown-field`), a label / component / folder / option it
 * names is gone (`unknown-value`), or the condition — or, with `index: null`,
 * the whole stored envelope — no longer reads or validates (`invalid`).
 */
export type StoredFilterStaleReason = 'unknown-field' | 'unknown-value' | 'invalid';

/** One stored-filter condition that matches nothing (MOTIR-10560). */
export interface StoredFilterStaleConditionDto {
  /** The condition's 0-based position in `envelope.f`; `null` only when the
   * stored envelope itself cannot be read. */
  index: number | null;
  /** The condition's field id (`lbl`, `cmp`, `cf:<id>`, …); `null` with `index`. */
  field: string | null;
  reason: StoredFilterStaleReason;
}

/**
 * A board's stored filter as the board read reports it (MOTIR-10560): the
 * stored v1 envelope, plus every condition that matches nothing. A stale
 * condition never fails the read — the board loads, and that condition
 * matches no card. An envelope that no longer reads narrows the board to
 * nothing (never to everything) and is reported as one `invalid` entry.
 */
export interface StoredBoardFilterDto {
  /** The stored `{ v, c, f }` envelope as read; `null` when it cannot be read. */
  envelope: FilterEnvelope | null;
  staleConditions: StoredFilterStaleConditionDto[];
  /**
   * The labels the envelope names that still exist, by id and name
   * (MOTIR-11335) — read with the referents the filter is resolved against, so
   * every reader of the board (a Visitor included) can name a Label condition's
   * values without a second read. A deleted label is absent (and its condition
   * is in `staleConditions`).
   */
  labels: Array<{ id: string; name: string }>;
}

/**
 * The optional board FILTER input (Story 6.15.2) — what the 6.15.3 board
 * toolbar passes to `boardsService.getBoard` to narrow the board. Either an
 * **inline** `ast` (the quick-filter builder's compiled `FilterAst`, the same
 * one the `/items` navigator threads) OR a **`savedFilterId`** (a row id or a
 * `builtin:<slug>`) resolved through the 6.2 saved-filter access gate — never
 * both (the service prefers `savedFilterId` when both are present). Absent (or
 * an empty AST) is NO header filter. The board read applies the predicate per
 * column (its count and every page), to the swimlane lane aggregates and to the
 * sprint points, and composes it with the 4.5 Scrum sprint scope (it narrows
 * WITHIN the sprint, never widening it).
 *
 * A header filter REPLACES the board's own stored filter (MOTIR-11564) rather
 * than narrowing it; with no header filter the stored filter applies, unless
 * `storedFilterOff` — the `boardFilter=off` query param — asks for the board's
 * whole scope. `storedFilterOff` is ignored when a header filter is present and
 * on a board with no stored filter.
 */
export interface BoardFilterInput {
  ast?: FilterAst;
  savedFilterId?: string;
  storedFilterOff?: boolean;
}
