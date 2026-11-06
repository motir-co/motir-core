// Typed errors for the board domain (Story 3.1). Kept in their own file so
// callers — the service layer, and the 3.1.6 route handlers — can import them
// without pulling in the Prisma client. Each carries a stable string `code`
// the route layer maps to an HTTP status, matching the `readonly code`
// convention the workflows / projects / workspaces domains established.
//
// The board MOVE path (Subtask 3.1.5) is the first consumer:
//   - IllegalBoardMoveError    → 409 (the snapback signal the 3.2 UI branches on)
//   - UnmappedColumnTargetError → 422 (a column that maps no status)
//   - BoardNotFoundError / BoardColumnNotFoundError → 404
// A not-found WORK ITEM (the moved card or a rank neighbor) reuses the existing
// `WorkItemNotFoundError` from `lib/workItems/errors.ts` (already a 404), so the
// move path doesn't invent a parallel work-item-not-found error.

import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';

/**
 * A cross-column move resolved to an ILLEGAL workflow transition under the
 * project's `restricted` policy (no `workflow_transition` row connects the
 * pair). The board move is rejected and the issue's status + rank are left
 * unchanged — the contract the 3.2 UI relies on to **snap the card back**.
 * Re-raised from the underlying `IllegalTransitionError` so the board layer
 * exposes ONE board-shaped error (carrying the from/to status + the reason)
 * rather than leaking the work-item transition error. → 409.
 */
export class IllegalBoardMoveError extends Error {
  readonly code = 'ILLEGAL_BOARD_MOVE' as const;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string;
  constructor(fromStatus: string, toStatus: string, reason = 'Illegal board move.') {
    super(`Illegal board move: "${fromStatus}" → "${toStatus}" (${reason}).`);
    this.name = 'IllegalBoardMoveError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.reason = reason;
  }
}

/**
 * A cross-column move into the status an `awaiting` approval gate OWNS (Story
 * MOTIR-4887 · Subtask MOTIR-5526; ADR `approval-gates.md` §6d AMENDMENT). The
 * edge is legal, so this is NOT {@link IllegalBoardMoveError}: the board must
 * tell the two apart, because this refusal is rendered ON THE CARD with a door
 * into the approval rather than as the snap-back toast. → 409 carrying `code`
 * and the `gate` payload.
 *
 * Re-raised from `ApprovalGatePendingError` with the render payload attached
 * AFTER the move's transaction rolled back (`boardsService.moveCard`).
 */
export class ApprovalGatePendingBoardMoveError extends Error {
  readonly code = 'APPROVAL_GATE_PENDING' as const;
  readonly gate: ApprovalGatePendingPayloadDTO;
  constructor(message: string, gate: ApprovalGatePendingPayloadDTO) {
    super(message);
    this.name = 'ApprovalGatePendingBoardMoveError';
    this.gate = gate;
  }
}

/**
 * A cross-column move of a card an UNDECIDED plan holds at `planning` (Story
 * MOTIR-6017 · Subtask MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21). Like
 * {@link ApprovalGatePendingBoardMoveError} the edge is legal, so it is not the
 * snap-back toast's {@link IllegalBoardMoveError}: the board renders it ON THE CARD
 * with a Review plan door. → 409 carrying `code: 'PLAN_TARGET_HELD'` and `plan`.
 *
 * Re-raised from `PlanTargetHeldError`, whose payload is already complete — no
 * enrichment read follows.
 */
export class PlanTargetHeldBoardMoveError extends Error {
  readonly code = 'PLAN_TARGET_HELD' as const;
  readonly plan: PlanHoldDTO;
  constructor(message: string, plan: PlanHoldDTO) {
    super(message);
    this.name = 'PlanTargetHeldBoardMoveError';
    this.plan = plan;
  }
}

/**
 * A cross-column move of a card marked Outdated / Deprecated OUT of the done
 * category (Story MOTIR-6575 · MOTIR-6682; the guard is MOTIR-6672). Like the two
 * holds above, the edge is legal, so it is not the snap-back toast's
 * {@link IllegalBoardMoveError}: the board renders it ON THE CARD with an Open
 * item door. → 409 carrying `code: 'MARKED_CARD_CANNOT_REOPEN'`, the card's `key`
 * and its `mark`. Re-raised from `MarkedCardCannotReopenError`, which already
 * carries both — no read follows.
 */
export class MarkedCardBoardMoveError extends Error {
  readonly code = 'MARKED_CARD_CANNOT_REOPEN' as const;
  readonly key: string;
  readonly mark: 'outdated' | 'deprecated';
  constructor(message: string, key: string, mark: 'outdated' | 'deprecated') {
    super(message);
    this.name = 'MarkedCardBoardMoveError';
    this.key = key;
    this.mark = mark;
  }
}

/**
 * The drop target column maps NO workflow status (or maps only statuses that no
 * longer exist in the project's workflow), so the move has no status to resolve
 * to. Distinct from an illegal transition: there is simply nothing to move the
 * work item INTO. → 422.
 */
export class UnmappedColumnTargetError extends Error {
  readonly code = 'UNMAPPED_COLUMN_TARGET' as const;
  readonly columnId: string;
  constructor(columnId: string) {
    super(`Board column ${columnId} maps no workflow status — nothing to move the work item into.`);
    this.name = 'UnmappedColumnTargetError';
    this.columnId = columnId;
  }
}

/** No board matched the id in the active workspace. → 404. */
export class BoardNotFoundError extends Error {
  readonly code = 'BOARD_NOT_FOUND' as const;
  readonly boardId: string;
  constructor(boardId: string) {
    super(`Board ${boardId} not found.`);
    this.name = 'BoardNotFoundError';
    this.boardId = boardId;
  }
}

/**
 * No column matched the id on the target board in the active workspace (the
 * column doesn't exist, belongs to another board, or to another workspace).
 * → 404.
 */
export class BoardColumnNotFoundError extends Error {
  readonly code = 'BOARD_COLUMN_NOT_FOUND' as const;
  readonly columnId: string;
  constructor(columnId: string) {
    super(`Board column ${columnId} not found.`);
    this.name = 'BoardColumnNotFoundError';
    this.columnId = columnId;
  }
}

/**
 * A lane page was asked for with a `cursor` this board did not mint for that
 * lane (MOTIR-10535): malformed, or minted for the other lane order (a cursor
 * from an open lane sent to a done-category lane, or the reverse). The board
 * never guesses where a page starts, so the read is refused. → 400.
 */
export class InvalidBoardCursorError extends Error {
  readonly code = 'INVALID_BOARD_CURSOR' as const;
  constructor() {
    super('The board page cursor is not valid for this column.');
    this.name = 'InvalidBoardCursorError';
  }
}

// ── Board CONFIG writes (Subtask 3.3.3) — set swimlane group-by + per-column
// WIP limit. The validation + authorization errors the config write path
// raises, mapped to status codes by the PATCH routes.

/**
 * The caller is a workspace member but NOT the workspace owner, so they may not
 * change board configuration. v1 routes "board/project admin" to the workspace
 * OWNER (finding #36), exactly mirroring the Story-2.2.5 workflow editor's
 * `assertProjectAdmin` gate — full per-project RBAC is Epic 6.4. Distinct from
 * `NotProjectAdminError` (workflow domain) only so the board domain owns its
 * own errors file (no cross-domain import); the SHAPE + the v1 owner-tier are
 * identical. → 403.
 *
 * NOTE: the 3.3.3 card prose described this as "any workspace member can write,
 * RBAC later"; the SHIPPED 2.2.5 precedent the card names is owner-gated
 * (decision-ladder rung 2 > the card), and Jira gates board config to admins
 * (rung 1) — so the owner gate is the consistent build. See PRODECT_FINDINGS.
 */
// ⚠️ `NotBoardAdminError` / `NOT_BOARD_ADMIN` was RETIRED by MOTIR-2296. Board
// configuration is no longer gated by a workspace-OWNER check of its own — it
// asks `projectAccessService.assertPermission(…, 'board:configure')` like every
// other administrative domain, and refuses with `PermissionDeniedError` (403,
// carrying the key) or `ProjectNotFoundError` (404, for an actor who cannot
// browse). The old error's message — "You must be a workspace owner to change
// board configuration." — became false the moment a project admin could do it,
// and `git grep NOT_BOARD_ADMIN` found no reader outside the route files that
// raised it. `lib/boards/boardGateResponse.ts` maps the two replacements.

/**
 * The requested swimlane group-by is not a `BoardSwimlaneGroupBy` value (the
 * stub-specified `none` / `assignee` / `epic` / `priority`). → 400.
 */
export class InvalidSwimlaneGroupByError extends Error {
  readonly code = 'INVALID_SWIMLANE_GROUP_BY' as const;
  readonly value: string;
  constructor(value: string) {
    super(`"${value}" is not a valid swimlane group-by.`);
    this.name = 'InvalidSwimlaneGroupByError';
    this.value = value;
  }
}

/**
 * The requested WIP limit is neither `null` (clear the limit) nor a
 * non-negative integer. Negative, fractional, and non-numeric values are all
 * rejected here rather than written. → 400.
 */
export class InvalidWipLimitError extends Error {
  readonly code = 'INVALID_WIP_LIMIT' as const;
  constructor(message = 'A WIP limit must be a non-negative integer or null.') {
    super(message);
    this.name = 'InvalidWipLimitError';
  }
}

// ── Column / board ADMIN writes (Subtask 3.6.2) — add / rename / reorder /
// delete a column, map / unmap a status, rename the board. The validation,
// guard, and conflict errors the column-config write path raises, mapped to
// status codes by the 3.6.2 routes.

/**
 * A board column or board name is empty (or whitespace-only) after trimming.
 * Both `addColumn` / `renameColumn` reject it; a board / column needs a
 * non-empty display name. → 400.
 */
export class InvalidColumnNameError extends Error {
  readonly code = 'INVALID_COLUMN_NAME' as const;
  constructor(message = 'A column name must not be empty.') {
    super(message);
    this.name = 'InvalidColumnNameError';
  }
}

/**
 * A column reorder was given a missing / empty `position`. `position` is the
 * opaque fractional-index sort key the client mints between two neighbours
 * (the same scheme `work_item` / `workflow_status` use); an empty value would
 * corrupt the column order, so it is rejected rather than written. → 400.
 */
export class InvalidColumnPositionError extends Error {
  readonly code = 'INVALID_COLUMN_POSITION' as const;
  constructor(message = 'A column position must be a non-empty fractional-index string.') {
    super(message);
    this.name = 'InvalidColumnPositionError';
  }
}

/** A board name is empty (or whitespace-only) after trimming. → 400. */
export class InvalidBoardNameError extends Error {
  readonly code = 'INVALID_BOARD_NAME' as const;
  constructor(message = 'A board name must not be empty.') {
    super(message);
    this.name = 'InvalidBoardNameError';
  }
}

/**
 * `deleteColumn` was asked to remove a column whose mapped status(es) still
 * hold work items on the board. Mirrors Jira's "you can't delete a column with
 * issues" guard (decision-authority rung 1): the admin must remap those
 * statuses to another column first. No work item is ever deleted by a board-
 * config write (a card's column is DERIVED from its `work_item.status`), so the
 * guard protects the admin from accidentally hiding live cards. → 409.
 */
export class ColumnNotEmptyError extends Error {
  readonly code = 'COLUMN_NOT_EMPTY' as const;
  readonly columnId: string;
  readonly cardCount: number;
  constructor(columnId: string, cardCount: number) {
    super(
      `Board column ${columnId} still holds ${cardCount} work item(s) — remap its statuses before deleting it.`,
    );
    this.name = 'ColumnNotEmptyError';
    this.columnId = columnId;
    this.cardCount = cardCount;
  }
}

/**
 * `deleteColumn` was asked to remove the board's ONLY remaining column. A board
 * must keep at least one column (Jira's board-settings invariant — you cannot
 * delete down to zero columns, which would leave nowhere for any status to
 * map). The admin adds another column first, or renames this one instead.
 * → 409.
 */
export class LastColumnError extends Error {
  readonly code = 'LAST_COLUMN' as const;
  constructor(message = 'A board must keep at least one column.') {
    super(message);
    this.name = 'LastColumnError';
  }
}

/**
 * A concurrent map of the SAME status on the SAME board won the
 * `@@unique([boardId, statusId])` race between this map's in-transaction
 * delete-then-create. The backstop for the move-not-duplicate write (mirrors
 * `workflowsService.createStatus`'s P2002 guard) — not deterministically
 * reproducible, but turns the raw Prisma P2002 into a typed conflict. → 409.
 */
export class StatusMappingConflictError extends Error {
  readonly code = 'STATUS_MAPPING_CONFLICT' as const;
  readonly statusId: string;
  constructor(statusId: string) {
    super(`Status ${statusId} was concurrently mapped to another column on this board.`);
    this.name = 'StatusMappingConflictError';
    this.statusId = statusId;
  }
}

// ── Board LIFECYCLE writes (Subtask 3.7.3) — the multi-board CRUD path:
// create (seed columns) / rename / set-default / delete. The validation +
// guard errors the lifecycle write path raises, mapped to status codes by the
// `/api/boards` routes. `renameBoard` reuses `InvalidBoardNameError` (3.6.2);
// `createBoard` adds the board-type validation error, `deleteBoard` adds the
// last-board guard (the board analogue of `LastColumnError`).

/**
 * `createBoard` was given a `type` that is not a `BoardType` enum value
 * (`kanban` / `scrum`). The UI is Kanban-only for now (the Scrum board is
 * Story 4.5), but the service validates against the SHIPPED enum (rung 2) —
 * `scrum` is accepted at the service tier (it renders as a Kanban board until
 * 4.5 branches on `type`), so a lookup keyed off the enum stays total. → 400.
 */
export class InvalidBoardTypeError extends Error {
  readonly code = 'INVALID_BOARD_TYPE' as const;
  readonly value: string;
  constructor(value: string) {
    super(`"${value}" is not a valid board type.`);
    this.name = 'InvalidBoardTypeError';
    this.value = value;
  }
}

/**
 * `deleteBoard` was asked to remove a project's ONLY remaining board. A project
 * must keep at least one board (the board analogue of `LastColumnError`, and
 * Jira's own invariant — a project always has a board to open). The admin
 * creates another board first, or renames this one instead. → 409.
 */
export class LastBoardError extends Error {
  readonly code = 'LAST_BOARD' as const;
  constructor(message = 'A project must keep at least one board.') {
    super(message);
    this.name = 'LastBoardError';
  }
}
