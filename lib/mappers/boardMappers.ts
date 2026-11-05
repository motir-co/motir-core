import type {
  Board,
  BoardColumn,
  BoardColumnStatus,
  Sprint,
  WorkItem,
} from '@/generated/prisma/client';
import type { CardReviewDTO } from '@/lib/dto/reviewState';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardColumnStatusDto,
  BoardDto,
  BoardSummaryDto,
  BoardSwimlaneGroupByDto,
  BoardTypeDto,
  SprintSummaryDto,
} from '@/lib/dto/boards';
import type { SprintStateDto } from '@/lib/dto/sprints';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import type { SprintPointsDto } from '@/lib/dto/estimation';

// Prisma → DTO converters for the board domain. The service calls these just
// before returning so no Prisma row shape (Date objects, Prisma enums) leaks
// across the API boundary. Mirrors `lib/mappers/workItemMappers.ts`.

/**
 * Map a `board` row to a `BoardDto` (the config shape, Subtask 3.3.3). The
 * Prisma `BoardType` / `BoardSwimlaneGroupBy` enums are string-compatible with
 * their DTO unions, so the cast is the same one `getBoard` uses for `type`.
 */
export function toBoardDto(row: Board): BoardDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as BoardTypeDto,
    swimlaneGroupBy: row.swimlaneGroupBy as BoardSwimlaneGroupByDto,
  };
}

/**
 * Map a `board` row to a `BoardSummaryDto` (the switcher shape, Subtask 3.7.3).
 * Like `toBoardDto` but carries `isDefault` + `position` (the switcher's badge +
 * order) instead of `swimlaneGroupBy` (a projection concern). `position` is
 * already the opaque fractional-index string on the row.
 */
export function toBoardSummaryDto(row: Board): BoardSummaryDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as BoardTypeDto,
    isDefault: row.isDefault,
    position: row.position,
  };
}

/**
 * Map a `board_column` row to a `BoardColumnConfigDto` (Subtask 3.3.3 — the WIP
 * config write return). `position` is already the opaque fractional-index
 * string on the row; `wipLimit` is the nullable Int.
 */
export function toBoardColumnConfigDto(row: BoardColumn): BoardColumnConfigDto {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    wipLimit: row.wipLimit,
  };
}

/**
 * Map a `board_column_status` row to a `BoardColumnStatusDto` (Subtask 3.6.2 —
 * the map-status write return). Just the mapping edge's identity (board /
 * column / status ids) — the rows carry timestamps + a workspace/project FK the
 * wire shape omits.
 */
export function toBoardColumnStatusDto(row: BoardColumnStatus): BoardColumnStatusDto {
  return {
    boardId: row.boardId,
    columnId: row.columnId,
    statusId: row.statusId,
  };
}

/**
 * Map a `work_item` row + its readiness flag to a `BoardCardDto`. `dueDate` is
 * normalized to a wire-safe ISO string; `position` is already a fractional-
 * index string on the row. `ready` is computed by the caller (the service,
 * via `workItemsService.getReadiness`) — the mapper stays a pure shape
 * converter and does not read the link graph itself. `swimlaneKey` (Subtask
 * 3.3.4) is the caller-resolved lane key under the board's group-by; it is
 * OMITTED from the DTO when `undefined` (the `none`/flat board), so the flat
 * projection is byte-for-byte the 3.1.4 card shape.
 */
export function toBoardCardDto(
  row: WorkItem,
  opts: {
    ready: boolean;
    /** The card's decision-waiting marker (MOTIR-5876); `null` when omitted. */
    pendingDecision?: PendingDecisionDTO | null;
    swimlaneKey?: string;
    /**
     * The row's status CATEGORY (MOTIR-5474). Resolved by the CALLER, which holds
     * the project's workflow already — the mapper takes whole `WorkItem` rows and
     * a status row's category is not on them, so deriving it here would mean a
     * read per card. `null` when the row's status maps to no live status.
     */
    statusCategory?: StatusCategoryDto | null;
    /** The undecided plan holding the card (MOTIR-6268); `null` when omitted. */
    planHold?: PlanHoldDTO | null;
    /** The agent review the card wears (MOTIR-10341); omitted, none. */
    review?: CardReviewDTO | null;
  },
): BoardCardDto {
  const dto: BoardCardDto = {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    position: row.position,
    ready: opts.ready,
    pendingDecision: opts.pendingDecision ?? null,
    ciState: row.ciState,
    fixReason: row.fixReason,
    obsolescence: row.obsolescence,
    planHold: opts.planHold ?? null,
    statusCategory: opts.statusCategory ?? null,
  };
  if (opts.review) dto.review = opts.review;
  if (opts.swimlaneKey !== undefined) dto.swimlaneKey = opts.swimlaneKey;
  return dto;
}

/** Whole calendar days from `now` to `endDate`, FLOORED at 0 (Subtask 4.5.2).
 *  Date-only (UTC midnight) on both sides so the gap is an exact day multiple
 *  (no DST/partial-day drift); an overdue sprint → 0 (the UI renders "Ended"),
 *  never a negative number. `null` when the sprint has no `endDate`. */
function sprintDaysRemaining(endDate: Date | null, now: Date): number | null {
  if (!endDate) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const endDay = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((endDay - nowDay) / DAY_MS));
}

/**
 * Map a resolved active `sprint` row + its computed point figures to a
 * `SprintSummaryDto` (Subtask 4.5.2 — the scrum board's sprint-header data).
 * `points` / `columnPoints` are the bounded aggregates the service computed via
 * `estimationService.sprintBoardPoints` (the SUM lives in the estimation
 * domain; this mapper only shapes them). Dates normalize to ISO-8601 (or null);
 * the Prisma `SprintState` enum is string-compatible with `SprintStateDto` (the
 * same cast `toSprintDto` / `toBoardDto` use). `daysRemaining` is derived from
 * `endDate` against `now` (the service injects the clock so the value is
 * testable + the mapper stays pure).
 */
export function toSprintSummaryDto(
  row: Sprint,
  points: SprintPointsDto,
  columnPoints: Record<string, number>,
  now: Date,
): SprintSummaryDto {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    startDate: row.startDate ? row.startDate.toISOString() : null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    state: row.state as SprintStateDto,
    daysRemaining: sprintDaysRemaining(row.endDate, now),
    points,
    columnPoints,
  };
}
