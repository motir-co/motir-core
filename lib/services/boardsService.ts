import { Prisma, BoardSwimlaneGroupBy, BoardType } from '@/generated/prisma/client';
import { reviewStateService } from '@/lib/services/reviewStateService';
import type { CardReviewMap } from '@/lib/dto/reviewState';
import type { Board, BoardColumn, Sprint, WorkItem } from '@/generated/prisma/client';
import {
  cursorAfter,
  decodeColumnCursor,
  type ColumnCursor,
  type ColumnOrder,
} from '@/lib/boards/columnCursor';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemsService, loadFilterReferents } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { estimationService } from '@/lib/services/estimationService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { resolveFilterAst, type ProjectFilterReferents } from '@/lib/filters/registry';
import type { FilterAst } from '@/lib/filters/ast';
import { keyBetweenSafe, keyForAppend } from '@/lib/workItems/positioning';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import {
  toBoardCardDto,
  toBoardColumnConfigDto,
  toBoardColumnStatusDto,
  toBoardDto,
  toBoardSummaryDto,
  toSprintSummaryDto,
} from '@/lib/mappers/boardMappers';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { buildDefaultBoard, DEFAULT_BOARD_NAME } from '@/lib/boards/defaultBoard';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardColumnDto,
  BoardColumnPageDto,
  BoardColumnStatusDto,
  BoardDto,
  BoardFilterInput,
  BoardPlanHoldSummaryDto,
  BoardProjectionDto,
  BoardSummaryDto,
  BoardSwimlaneDto,
  BoardSwimlaneGroupByDto,
  BoardTypeDto,
  MoveCardResultDto,
  MoveCardTarget,
  SprintSummaryDto,
} from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext, openVisitorRead } from '@/lib/visitor/readScope';
import { personName } from '@/lib/people/personLabel';
import {
  ApprovalGatePendingBoardMoveError,
  MarkedCardBoardMoveError,
  PlanTargetHeldBoardMoveError,
  BoardColumnNotFoundError,
  BoardNotFoundError,
  ColumnNotEmptyError,
  IllegalBoardMoveError,
  InvalidBoardCursorError,
  InvalidBoardNameError,
  InvalidBoardTypeError,
  InvalidColumnNameError,
  InvalidColumnPositionError,
  InvalidSwimlaneGroupByError,
  InvalidWipLimitError,
  LastBoardError,
  LastColumnError,
  StatusMappingConflictError,
  UnmappedColumnTargetError,
} from '@/lib/boards/errors';
import {
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  ContainerHasOpenChildrenError,
  ApprovalGatePendingError,
  MarkedCardCannotReopenError,
  PlanTargetHeldError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { WorkflowStatusNotFoundError } from '@/lib/workflows/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { readProject } from '@/lib/workspaces/tenantRead';
import { fixTagFactsFor, fixTagFieldsOf, NO_FIX_TAG_FACTS } from '@/lib/services/fixGroupService';

// Boards service (Story 3.1) — business logic for the board entity. It hosts
// two surfaces:
//   * the default-board SEED (Subtask 3.1.2) — `seedDefaultBoard` /
//     `backfillDefaultBoard` below;
//   * the board WRITE side (Subtask 3.1.5) — `moveCard`.
// (The read projection is Subtask 3.1.4; the drag-drop UI is Story 3.2.)
//
// Like workflowsService, every write runs under the active workspace context so
// the FORCE-RLS WITH CHECK on the board tables passes under the non-bypass
// motir_app role (the scalar-FK `Unchecked` creates avoid a relation
// connect's parent SELECT — finding #33). TENANCY (finding #26): every repo
// read/write carries an explicit `workspaceId`; RLS is the structural backstop,
// inert under the dev/CI BYPASSRLS superuser.
//
// The load-bearing principle for the write side: **moving a card = a workflow
// transition, never a board-local write.** A cross-column drop resolves to the
// validated status-transition path (`workItemsService.applyStatusTransition`,
// the 2.2.4 core that runs `workflowsService.canTransition` under the project's
// policy mode); an in-column drop is a pure rank change on `work_item.position`.
// The board stores NOTHING about a card's placement — its column is derived from
// its `status`, its rank is the global `work_item.position`.
//
// One service method = one transaction (CLAUDE.md). For `moveCard` we do NOT
// call the public `workItemsService.updateStatus` (it opens its OWN
// `db.$transaction`, which would deadlock against the row this method already
// `FOR UPDATE`-locks); instead we call its transaction-aware core within OUR
// `tx`, so the validation is reused, not re-implemented (the 3.1.5 contract).

export const boardsService = {
  /**
   * Seed a project's default Kanban board (Subtask 3.1.2) — the column-from-
   * workflow projection: one column per workflow status (in `status.position`
   * order), each mapped to its single status. A seeded default OVER the durable
   * many-to-one mapping (3.1.1), not a hardcoded 1:1.
   *
   * NEVER opens its own transaction: `tx` is REQUIRED and supplied by the
   * caller (createProject), so the project insert, its workflow seed (2.2.2),
   * and its board are atomic — a rollback of any rolls back all. It reads the
   * statuses through the SAME `tx` because they were just created in this
   * transaction and aren't visible outside it yet, then resolves each column's
   * status `key → id` against those rows. Rows carry the SCALAR workspaceId
   * (not a relation connect) so the writes pass the board RLS WITH CHECK under
   * the active workspace context (finding #33).
   */
  async seedDefaultBoard(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // The seeded board is the project's DEFAULT (Story 3.7.2 — the one
    // `/boards` opens when no `?board=` is given) and takes the first
    // fractional-index position. `keyForAppend(null)` mints the same `a0` the
    // migration backfills onto pre-3.7 boards, so a seeded board and a migrated
    // board carry identical initial state. The partial unique index guarantees
    // this stays the project's only default until 3.7.3's `setDefaultBoard`.
    // Name/type are the constant default (`DEFAULT_BOARD_NAME` / kanban), so no
    // status read is needed for the board row itself.
    const board = await boardRepository.create(
      {
        workspaceId,
        projectId,
        name: DEFAULT_BOARD_NAME,
        type: BoardType.kanban,
        isDefault: true,
        position: keyForAppend(null),
      },
      tx,
    );
    await seedColumnsForBoard(board.id, projectId, workspaceId, tx);
  },

  /**
   * The projects `pnpm db:backfill:boards` walks (MOTIR-10465), in creation order.
   *
   * ⚠️ EVERY project, not only the board-less ones, and under `withSystemContext`.
   * The sweep spans workspaces, and `project` carries a `system_admin` read arm,
   * so the system context is what reads it under the non-bypass application role
   * the script runs as in production (a core worker task). `board` carries NO
   * such arm, so a `boards: { none: {} }` filter evaluated here would see no
   * board anywhere and name every project — the filter is
   * {@link backfillDefaultBoard}'s own probe instead, run under the project's
   * workspace. Before this, the script read `project` unbound and found nothing
   * as the application role; it worked only as Neon's owner.
   */
  async listBoardBackfillCandidates(): Promise<
    Array<{ id: string; name: string; workspaceId: string }>
  > {
    return withSystemContext((tx) => projectRepository.listAllForSweep(tx));
  },

  /**
   * The user the board backfill acts as in `workspaceId` (MOTIR-10465): the
   * workspace's oldest Manager, else its oldest member, else null. Read under the
   * workspace's service context — `workspace_membership` admits a read only for
   * the bound workspace (or the caller's own rows), so an unbound read answers
   * nothing under the application role.
   */
  async resolveBoardBackfillActor(workspaceId: string): Promise<string | null> {
    return withWorkspaceServiceContext(workspaceId, async (tx) => {
      const manager = await workspaceMembershipRepository.findStandInManagerByWorkspace(
        workspaceId,
        tx,
      );
      if (manager) return manager.userId;
      const [first] = await workspaceMembershipRepository.findMembersByWorkspace(workspaceId, tx);
      return first?.userId ?? null;
    });
  },

  /**
   * One-off backfill of the default board onto a project that predates this
   * Story (a project with a workflow but no board). Admin/CLI-only —
   * `actorUserId` is required because the seed must run under
   * withWorkspaceContext (binding the workspace GUC the FORCE-RLS writes need;
   * rung-2 shipped-context shape, mirroring `workflowsService.backfillDefault-
   * Workflow`). Idempotent: a no-op (returns false) when the project already
   * has a board; seeds and returns true otherwise. Throws ProjectNotFoundError
   * if the project is absent. Drives the `scripts/backfill-default-boards.ts`
   * fleet sweep, one project at a time.
   */
  async backfillDefaultBoard(projectId: string, actorUserId: string): Promise<boolean> {
    // MOTIR-2569: the OPENING read is the one context nothing can supply — the
    // sweep hands this a bare projectId and the workspace it would bind is what
    // the read RESOLVES. That is precisely the case
    // `project_workspace_or_system_read`'s `app.system_admin` arm was added for
    // (the 20260727 migration: "operator tooling that must … span workspaces"),
    // so the resolution runs under `withSystemContext` and everything after it
    // runs tenant-scoped under the workspace it resolved. The probe moves inside
    // that tenant transaction too — `board` is workspace-keyed as well, so an
    // unbound probe would read "no board" for a project that has one and seed a
    // second.
    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    return withWorkspaceContext(
      { userId: actorUserId, workspaceId: project.workspaceId },
      async (tx) => {
        const existing = await boardRepository.findDefaultForProject(
          projectId,
          project.workspaceId,
          tx,
        );
        if (existing) return false;
        await boardsService.seedDefaultBoard(projectId, project.workspaceId, tx);
        return true;
      },
    );
  },

  /**
   * The board READ projection (Subtask 3.1.4; load model PAGED PER LANE by
   * MOTIR-10535) — turn a board + its workflow + its issues into the
   * column-of-cards shape the 3.2 UI renders.
   *
   * **Each lane (column) loads its FIRST PAGE** of {@link BOARD_PAGE_SIZE} cards
   * in its own order — `position`, or recency for a done-category lane — plus a
   * keyset `cursor` when it has more, and its FULL `totalCount` from a count
   * query (the header's denominator: "10 of 2,830"). The next page is
   * {@link boardsService.getColumnPage}, called as the user scrolls a lane to its
   * bottom. Done and Cancelled lanes page exactly like the others — no lane is
   * windowed, skipped or emptied.
   *
   * Every per-card batch — readiness, the pending decision marker, the review
   * state, the plan hold, the swimlane key and the To fix tag — runs over the
   * LOADED cards only, so the board's cost is bounded by lanes × page size and
   * not by how many cards the project holds. This REVERSES 3.8.2's
   * "whole bounded set" model (`notes.html` mistake #33): a 2,830-card board
   * ran its review-state read over every card in one transaction and overran
   * Prisma's 5 s budget (P2028), so the board answered 500. The cap
   * (`BOARD_ISSUE_CAP`), its `truncated` banner and the Done-age window went
   * with that model — paging is the bound now.
   *
   * Plus a top-level `unmappedStatuses` — every project status mapped to NO
   * column (Jira's behaviour: surfaced, never dropped) — and the swimlane lanes,
   * which stay a bounded aggregate over the whole (filtered) set, so a lane's
   * count and order do not depend on which pages are loaded.
   *
   * Board SELECTION (Subtask 3.7.5): `boardId` picks WHICH of the project's
   * boards to project. Absent → the project's DEFAULT board (`isDefault`, the
   * board `/boards` opens with no `?board=`). Present → that board, but ONLY if
   * it belongs to the active project AND workspace — `findById` scopes by
   * `workspaceId` (a cross-WORKSPACE id returns null), and we additionally
   * reject a cross-PROJECT id (right workspace, wrong project). Either miss is a
   * `BoardNotFoundError` (404), so a stale / forged `?board=` is tenant-safe,
   * never a cross-project leak.
   *
   * Throws `BoardNotFoundError` (404) when the project has no default board yet
   * (a project predating the 3.1.2 seed/backfill — the 3.2 UI shows its no-board
   * state) or when a named `boardId` is not a board of the active project.
   */
  async getBoard(
    projectId: string,
    ctx: ServiceContext | VisitorReadContext,
    boardId?: string,
    filter?: BoardFilterInput,
  ): Promise<BoardProjectionDto> {
    const frame = await loadBoardFrame(projectId, ctx, boardId, filter);
    const { board, columns, liveByColumn, mappedStatusIds, statuses, readCtx } = frame;
    const groupBy = board.swimlaneGroupBy as BoardSwimlaneGroupByDto;

    // A scrum board with NO active sprint: empty columns + `sprint: null`, so the
    // 4.5.3 UI shows the "No active sprint" empty state in place of the board. We
    // NEVER fall back to the unscoped board (that would masquerade the backlog as
    // a sprint). The column meta (name / statusKeys / wipLimit) is still returned
    // so the shape is honest, but every column is empty and nothing is counted.
    if (board.type === BoardType.scrum && !frame.activeSprint) {
      const emptyColumns: BoardColumnDto[] = columns.map((col) => ({
        id: col.id,
        name: col.name,
        position: col.position.toString(),
        wipLimit: col.wipLimit,
        statusKeys: columnStatusKeys(liveByColumn, col.id),
        cards: [],
        totalCount: 0,
        cursor: null,
      }));
      return {
        boardId: board.id,
        name: board.name,
        type: board.type as BoardTypeDto,
        swimlaneGroupBy: groupBy,
        columns: emptyColumns,
        swimlanes: [],
        unmappedStatuses: statuses.filter((s) => !mappedStatusIds.has(s.id)),
        sprint: null,
        planHolds: {},
      };
    }

    // Each lane's first page + its full count (one bound transaction per lane —
    // see `buildColumnPage`). The query count is per LANE, never per card.
    const built = await Promise.all(
      columns.map((col) => buildColumnPage(projectId, col, frame, undefined)),
    );

    // Every per-card batch, over the loaded pages only (MOTIR-10535).
    const decorated = await decorateBoardRows(
      projectId,
      built.flatMap((b) => b.rows),
      frame,
    );

    // Swimlanes (Subtask 3.3.4). The union of the board's mapped column statuses
    // IS the board's card population, so the lane list is resolved over that set
    // — a bounded aggregate, never a load-all (finding #57) — and so a lane's
    // count does not move as pages load. For the flat `none` board it is a no-op:
    // an empty `swimlanes`. The sprint scope (4.5.2) composes with the lanes
    // exactly as it does with the columns.
    const boardStatusKeys = [...new Set(built.flatMap((b) => b.statusKeys))];
    const swimlanes = await buildSwimlanes(
      groupBy,
      projectId,
      boardStatusKeys,
      readCtx,
      frame.activeSprint?.id,
      frame.boardFilter,
      frame.excludeIds,
      !frame.member,
    );

    // The active-sprint summary that drives the 4.5.3 sprint header (Subtask
    // 4.5.2) — present only on a scrum board with an active sprint. The points
    // come from the estimation domain (the SUM lives in ONE place — 4.3.3); this
    // service folds in the per-column breakdown via the column→status layout.
    // An aggregate over the sprint, never a sum over the loaded pages.
    let sprint: SprintSummaryDto | null = null;
    if (frame.activeSprint) {
      const { points, columnPoints } = await estimationService.sprintBoardPoints(
        frame.activeSprint.id,
        built.map((b) => ({ id: b.col.id, statusKeys: b.statusKeys })),
        readCtx,
        frame.excludeIds,
      );
      sprint = toSprintSummaryDto(frame.activeSprint, points, columnPoints, new Date());
    }

    return {
      boardId: board.id,
      name: board.name,
      type: board.type as BoardTypeDto,
      swimlaneGroupBy: groupBy,
      columns: built.map((b) => ({
        id: b.col.id,
        name: b.col.name,
        position: b.col.position.toString(),
        wipLimit: b.col.wipLimit,
        statusKeys: b.statusKeys,
        cards: b.rows.map(decorated.toCard),
        totalCount: b.totalCount,
        cursor: b.cursor,
      })),
      swimlanes,
      unmappedStatuses: statuses.filter((s) => !mappedStatusIds.has(s.id)),
      sprint,
      planHolds: decorated.planHolds,
    };
  },

  /**
   * The NEXT PAGE of one board lane (MOTIR-10535) — the read the board makes when
   * the user scrolls a lane to its bottom. `cursor` is the lane's own cursor from
   * the projection (or from the previous page); the page is the
   * {@link BOARD_PAGE_SIZE} cards strictly after it, in the lane's order, with a
   * cursor of its own when more remain. Every gate of {@link getBoard} applies
   * unchanged — the project-access check, the board's tenancy, the Visitor's
   * private-epic exclusion, the board filter and the scrum sprint scope — so a
   * page can only ever hold cards the full board would show.
   *
   * The page carries the lane's CURRENT `totalCount` (cards may have moved since
   * the first page) and the `planHolds` its cards name, both decorated by the
   * same per-card batches as the first page — over this page's cards only.
   *
   * Throws `BoardNotFoundError` / `BoardColumnNotFoundError` (404) for a board or
   * lane the caller cannot see, and `InvalidBoardCursorError` (400) for a cursor
   * this lane did not mint.
   */
  async getColumnPage(
    projectId: string,
    ctx: ServiceContext | VisitorReadContext,
    boardId: string,
    columnId: string,
    cursor: string,
    filter?: BoardFilterInput,
  ): Promise<BoardColumnPageDto> {
    const frame = await loadBoardFrame(projectId, ctx, boardId, filter);
    const col = frame.columns.find((c) => c.id === columnId);
    if (!col) throw new BoardColumnNotFoundError(columnId);
    const order = columnOrder(columnStatusKeys(frame.liveByColumn, col.id), frame.terminalKeys);
    const after = decodeColumnCursor(cursor, order);
    if (!after) throw new InvalidBoardCursorError();

    // A scrum board with no active sprint shows no cards at all, so it has no
    // next page either — the same rule as the projection's early return.
    if (frame.board.type === BoardType.scrum && !frame.activeSprint) {
      return { columnId, cards: [], totalCount: 0, cursor: null, planHolds: {} };
    }

    const page = await buildColumnPage(projectId, col, frame, after);
    const decorated = await decorateBoardRows(projectId, page.rows, frame);
    return {
      columnId,
      cards: page.rows.map(decorated.toCard),
      totalCount: page.totalCount,
      cursor: page.cursor,
      planHolds: decorated.planHolds,
    };
  },

  /**
   * Move a card on a board: resolve the target column's status, run a workflow
   * transition for a cross-column move (validated; illegal → snapback), and
   * re-rank the card within the column — all in one transaction.
   *
   * `target.toColumnId` is the drop column; `beforeId` / `afterId` bracket the
   * drop slot (the card's new `position` sorts strictly between them).
   *
   * Throws (all typed; the 3.1.6 route maps them to status codes):
   *  - `WorkItemNotFoundError` (404) — unknown / cross-workspace card or neighbour;
   *  - `BoardNotFoundError` / `BoardColumnNotFoundError` (404) — unknown board / column;
   *  - `UnmappedColumnTargetError` (422) — the column maps no live status;
   *  - `IllegalBoardMoveError` (409) — the resolved cross-column transition is
   *    illegal under `restricted` policy, OR a `deploy` card was dragged into a
   *    done column with no artifact evidence recorded on it (MOTIR-2709). Both
   *    leave status + rank unchanged — the snapback contract the 3.2 UI branches
   *    on — and the error's `reason` says which.
   *
   * ⚠️ THE BOARD IS RESOLVED BEFORE THE CARD IS LOCKED, AND THE ORDER IS THE
   * DECISION (2026-08-17, MOTIR-2952). A move whose CALLER can see neither the
   * board nor the card owes `BoardNotFoundError`, in every connection mode. The
   * rejected alternative was `WorkItemNotFoundError` — what the lock-first order
   * happened to produce under `motir_app`, and cheap to adopt by editing the
   * expectation. It was rejected because the board is the resource this
   * operation addresses and the board resolve is its only workspace-filtered
   * gate, so making the card's answer win would put the boundary's error under
   * the control of a lock that takes no tenant argument. See the body comment
   * at the resolve, and docs/decisions/public-api-conventions.md §4.
   */
  async moveCard(
    boardId: string,
    workItemId: string,
    target: MoveCardTarget,
    ctx: ServiceContext,
  ): Promise<MoveCardResultDto> {
    let moved;
    try {
      moved = await withWorkspaceContext(ctx, async (tx) => {
        // Resolve + tenant-gate the board FIRST — before the card lock, and
        // deliberately (MOTIR-2952; the rule is docs/decisions/public-api-
        // conventions.md §4, the error-identity clause MOTIR-2919 added).
        //
        // A move addresses a BOARD, and `findById` is the tenant gate for it:
        // it filters on `ctx.workspaceId`, so it answers not-found in EVERY
        // connection mode. `lockById` is not a tenant gate and was never meant
        // to be one — it takes no workspace and relies on RLS under `motir_app`
        // and on the explicit `item.workspaceId` check below under a bypassing
        // role. With the lock first, a foreign-tenant move answered
        // `BoardNotFoundError` as the owner (RLS inert → the lock succeeded →
        // the board gate fired) and `WorkItemNotFoundError` as `motir_app` (the
        // card is hidden → the lock 404s a line earlier). Same request, same
        // caller, two different errors decided by which role the query ran as —
        // exactly what "the mode a query happens to run in must never change
        // which error a boundary owes" forbids. Resolving the board first makes
        // the board gate the first thing either mode can fail.
        //
        // The lost-update guard is untouched: the lock is still taken inside
        // this same transaction and still precedes every write, and nothing
        // above it takes a row lock (the board resolve is a plain SELECT), so no
        // lock ORDER is introduced that another path could invert.
        const board = await boardRepository.findById(boardId, ctx.workspaceId, tx);
        if (!board) throw new BoardNotFoundError(boardId);

        // Lock the card — serialize the status + rank writes against a
        // concurrent move of the same card (lost-update guard, like updateStatus).
        const locked = await workItemRepository.lockById(workItemId, tx);
        if (!locked) throw new WorkItemNotFoundError(workItemId);

        // Project access gate (6.4.3): moving a card is an edit of the board's
        // project. (The cross-column status change routes through
        // applyStatusTransition, which gates too; this covers the same-column
        // re-rank that doesn't.) Inside the tx so it shares the card lock's snapshot.
        await projectAccessService.assertCanEdit(board.projectId, ctx, tx);

        const column = await boardColumnRepository.findById(target.toColumnId, ctx.workspaceId, tx);
        if (!column || column.boardId !== boardId) {
          throw new BoardColumnNotFoundError(target.toColumnId);
        }

        // Tenant-gate the card and confirm it lives on this board's project.
        const item = await workItemRepository.findById(workItemId, tx);
        if (!item || item.workspaceId !== ctx.workspaceId || item.projectId !== board.projectId) {
          throw new WorkItemNotFoundError(workItemId);
        }

        // Resolve the target column's mapped statuses → keys (the status of a card
        // in the column) + positions (the multi-status pick order). A column that
        // maps no LIVE status (none, or only deleted statuses) is an unmapped
        // target — there is nothing to move the card into.
        const mappings = await boardColumnStatusRepository.findByColumn(
          target.toColumnId,
          ctx.workspaceId,
          tx,
        );
        const statuses = await workflowsService.listStatusesByProject(
          board.projectId,
          ctx.workspaceId,
        );
        const statusById = new Map(statuses.map((s) => [s.id, s]));
        const mappedStatuses = mappings
          .map((m) => statusById.get(m.statusId))
          .filter((s): s is WorkflowStatusDto => s != null);
        if (mappedStatuses.length === 0) throw new UnmappedColumnTargetError(target.toColumnId);
        const mappedKeys = new Set(mappedStatuses.map((s) => s.key));

        // STATUS. If the card's current status is already in the target column's
        // mapped set (a within-column drop, OR a drop into a multi-status column
        // that already contains the card's status) → NO transition. Otherwise the
        // target status is the column's mapped status ordered FIRST by
        // `status.position` (Jira's multi-status rule).
        let appliedStatus = item.status;
        let transition: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null =
          null;
        if (!mappedKeys.has(item.status)) {
          const targetStatus = [...mappedStatuses].sort((a, b) =>
            a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
          )[0]!;
          try {
            const applied = await workItemsService.applyStatusTransition(
              workItemId,
              targetStatus.key,
              ctx,
              tx,
            );
            transition = applied.transition;
          } catch (err) {
            // Re-raise an illegal transition as the board-shaped 409 (snapback).
            if (err instanceof IllegalTransitionError) {
              throw new IllegalBoardMoveError(
                err.fromKey,
                err.toKey,
                'no such workflow transition',
              );
            }
            // Same treatment for the close-out artifact-evidence refusal
            // (MOTIR-2709): dragging a `deploy` card into a done column with
            // nothing recorded is a move the board must SNAP BACK, not a 500.
            // The reason carries the whole refusal message, so the card returns
            // to its column with the three accepted forms named rather than a
            // bare "something went wrong".
            if (err instanceof MissingArtifactEvidenceError) {
              throw new IllegalBoardMoveError(item.status, targetStatus.key, err.message);
            }
            // And for the container-completeness refusal (MOTIR-3229): dragging a
            // story into Implemented or In Review while a child of its own is
            // still open is a move the board must SNAP BACK. The reason carries
            // the whole refusal, so the card returns to its column NAMING the
            // children that are not landed — the one fact that turns "why won't
            // this move?" into a one-second answer.
            if (err instanceof ContainerHasOpenChildrenError) {
              throw new IllegalBoardMoveError(item.status, targetStatus.key, err.message);
            }
            throw err;
          }
          appliedStatus = targetStatus.key;
        }

        // RANK. The new position sorts between the bracketing neighbours (a
        // missing neighbour = the open end of the column). A pure within-column
        // reorder reaches here having attempted NO transition. Use the TOLERANT
        // bracketer: a drop in a recency-ranked terminal column (Done/Cancelled)
        // can hand the neighbours over position-inverted, and a board still
        // carrying legacy/invalid `position` keys (a tenant not yet reseeded —
        // PR #1020) would otherwise make `keyBetween` throw and 500 the move.
        // `keyBetweenSafe` always returns a valid key for both cases.
        const prev = await resolveNeighbour(target.beforeId, board.projectId, ctx, tx);
        let next = (await resolveNeighbour(target.afterId, board.projectId, ctx, tx))?.position;
        // A PAGED lane's bottom is not the lane's end (MOTIR-10535). A drop under
        // the last LOADED card arrives with no `afterId` while the lane may hold
        // unloaded cards below it; bracketing with the open end would rank the
        // card after ALL of them, so it would jump to the lane's very end on the
        // next read. The real lower neighbour is the card that follows `prev` in
        // the lane's rank, which this transaction can read. (A done-category lane
        // is ordered by recency, not rank, so it needs no such neighbour.)
        if (prev && !target.afterId && !mappedStatuses.every((s) => s.category === 'done')) {
          const [successor] = await workItemRepository.findColumnCards(
            board.projectId,
            ctx.workspaceId,
            [...mappedKeys],
            'position',
            {
              limit: 1,
              after: { order: 'position', position: prev.position, key: prev.key },
              excludeIds: [workItemId],
            },
            tx,
          );
          next = successor?.position;
        }
        const position = keyBetweenSafe(prev?.position ?? null, next ?? null);
        const row = await workItemRepository.update(workItemId, { position }, tx);

        return {
          row,
          appliedStatus,
          // The CATEGORY of the status actually applied (MOTIR-5474). Resolved
          // HERE because the workflow is in scope inside this transaction and the
          // caller holds only a status key; the moved card's DTO needs it for the
          // CI badge's done-category rule.
          appliedStatusCategory: statuses.find((st) => st.key === appliedStatus)?.category ?? null,
          transition,
          columnName: column.name,
          swimlaneGroupBy: board.swimlaneGroupBy,
        };
      });
    } catch (err) {
      // A move onto the column a pending approval owns (MOTIR-5526). Translated
      // OUTSIDE the transaction, unlike the three translations inside it, because
      // the board renders this refusal ON THE CARD with a door into the approval —
      // so it needs the render payload, and that read must not run under the
      // card's `FOR UPDATE` lock. The move itself has already rolled back.
      if (err instanceof ApprovalGatePendingError) {
        throw new ApprovalGatePendingBoardMoveError(
          err.message,
          await approvalGatesService.describePendingRefusal(err, ctx),
        );
      }
      // A drag of a card an undecided plan holds (MOTIR-6265). Its payload is
      // already complete, so nothing is read here.
      if (err instanceof PlanTargetHeldError) {
        throw new PlanTargetHeldBoardMoveError(err.message, err.payload);
      }
      // A drag of a MARKED card out of the done category (MOTIR-6682). The error
      // already names the card and its mark, so nothing is read here either.
      if (err instanceof MarkedCardCannotReopenError) {
        throw new MarkedCardBoardMoveError(err.message, err.key, err.obsolescence);
      }
      throw err;
    }
    const { row, appliedStatus, appliedStatusCategory, transition, columnName, swimlaneGroupBy } =
      moved;

    // A cross-column move IS a status transition — emit the same
    // `work-item/transitioned` event the direct updateStatus path emits
    // (Subtask 5.4.5: the board drag is how most transitions actually happen;
    // watchers are notified regardless of which surface moved the card).
    // Post-commit, never inside the tx (a rollback must not have notified);
    // a within-column re-rank attempted no transition and emits nothing.
    if (transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId,
        actorId: ctx.userId,
        fromStatusKey: transition.fromStatusKey,
        toStatusKey: transition.toStatusKey,
        revisionId: transition.revisionId,
      });
    }

    // Readiness (finding #21) is independent of THIS card's own move (it depends
    // on the card's blockers, which the move doesn't touch) — compute it after
    // the commit, via the read-only path, to complete the returned card.
    const { ready } = await workItemsService.getReadiness(workItemId, ctx);
    // Stamp the moved card with its lane key (Subtask 3.3.4) so the UI
    // reconciles it back into the right lane (a status-only move never changes
    // the card's lane, but the card shape must stay consistent under a grouped
    // board).
    const swimlaneKeyByCard = await resolveSwimlaneKeys(
      swimlaneGroupBy as BoardSwimlaneGroupByDto,
      [row],
      ctx,
    );
    // The dropped card keeps its decision-waiting marker (MOTIR-5876): the board
    // reconciles the moved card from this DTO, so a card that returned without the
    // field would lose its marker until the next reload.
    const pendingById = await approvalGatesService.pendingDecisionsFor(
      { projectId: row.projectId, workItemIds: [row.id] },
      ctx,
    );
    // …and its review marker and badge (MOTIR-10341), for the same reason.
    const reviewById = await reviewStateService.cardReviewsFor(row.projectId, [row.id], ctx);
    // …and its plan hold (MOTIR-6268): a rank change inside Planning is never
    // refused, and the card must come back still wearing its plan footer.
    const { byItemId: planHoldById } = await planTargetLockService.readBoardPlanHolds(
      row.projectId,
      [row],
      ctx,
    );
    return {
      card: toBoardCardDto(row, {
        ready,
        pendingDecision: pendingById.get(row.id) ?? null,
        review: reviewById[row.id] ?? null,
        planHold: planHoldById.get(row.id) ?? null,
        swimlaneKey: swimlaneKeyByCard.get(row.id),
        statusCategory: appliedStatusCategory,
      }),
      appliedStatus,
      column: { id: target.toColumnId, name: columnName },
    };
  },

  /**
   * Set a board's swimlane group-by (Subtask 3.3.3) — the write half of the
   * board flow-management config. `groupBy` must be a `BoardSwimlaneGroupBy`
   * (`none` / `assignee` / `epic` / `priority`); `none` is the flat 3.2 board.
   * Returns the updated board config DTO so the 3.3.5 UI reconciles.
   *
   * Order mirrors the 2.2.5 workflow mutations: resolve + tenant-gate (404) →
   * authorize (403) → validate input (400) → write. Tenant gate (finding #26):
   * a board id from another workspace resolves to `null` → `BoardNotFoundError`
   * (no cross-tenant existence leak). Config writes are workspace-OWNER-gated
   * (finding #36), mirroring the workflow editor — see `assertBoardConfigAdmin`.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidSwimlaneGroupByError` (400).
   */
  async setSwimlaneGroupBy(
    boardId: string,
    groupBy: string,
    ctx: ServiceContext,
  ): Promise<BoardDto> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);
    if (!isSwimlaneGroupBy(groupBy)) throw new InvalidSwimlaneGroupByError(groupBy);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardRepository.update(boardId, { swimlaneGroupBy: groupBy }, tx),
    );
    return toBoardDto(row);
  },

  /**
   * Set (or clear) a board column's WIP limit (Subtask 3.3.3). `limit` is a
   * non-negative integer, or `null` to remove the limit; a negative, fractional,
   * or non-numeric value is rejected with `InvalidWipLimitError`. The limit is
   * advisory only — the over-limit warning is a UI treatment (3.3.6), never a
   * blocked drop (the 3.2.4 move contract is untouched). Returns the updated
   * column config DTO so the 3.3.6 UI reconciles its optimistic edit.
   *
   * Same order + gates as `setSwimlaneGroupBy`: resolve + tenant-gate the column
   * (404) → owner-authorize via the column's project (403) → validate (400) →
   * write. The column row carries its scalar `projectId` (3.1.3), so the admin
   * gate needs no extra board read.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidWipLimitError` (400).
   */
  async setColumnWipLimit(
    columnId: string,
    limit: number | null,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardColumnRepository.findById(columnId, ctx.workspaceId, tx),
    );
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);
    if (!isValidWipLimit(limit)) throw new InvalidWipLimitError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { wipLimit: limit }, tx),
    );
    return toBoardColumnConfigDto(row);
  },

  // ── Column / board ADMIN writes (Subtask 3.6.2) ────────────────────────────
  // The board-configuration admin surface (Story 3.6): add / rename / reorder /
  // delete a column, map / unmap a status onto a column, rename the board. Each
  // extends the 3.3 config seam — same order (resolve + tenant-gate 404 →
  // owner-authorize 403 → validate 400 → write under withWorkspaceContext so
  // the FORCE-RLS WITH CHECK passes), same `assertBoardConfigAdmin` gate, same
  // scalar-FK `Unchecked` writes (finding #33). NO new table, NO migration —
  // pure config over the Story-3.1 schema. A card's column is always DERIVED
  // from its `work_item.status`, so NONE of these writes ever touch a work item.

  /**
   * Add a column to a board (Subtask 3.6.2). Appends to the end of the board's
   * columns unless an explicit `position` (a fractional-index key the client
   * mints to insert at a spot) is given — mirrors `workflowsService.createStatus`'s
   * append. Returns the new column's config DTO.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnNameError` (400).
   */
  async addColumn(
    boardId: string,
    input: { name: string; position?: string },
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const name = input.name?.trim();
    if (!name) throw new InvalidColumnNameError();

    let position = input.position;
    if (position == null) {
      const columns = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        boardColumnRepository.findByBoard(boardId, ctx.workspaceId, tx),
      );
      const last = columns.length ? columns[columns.length - 1]!.position : null;
      position = keyForAppend(last);
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        boardColumnRepository.create(
          { workspaceId: ctx.workspaceId, projectId: board.projectId, boardId, name, position },
          tx,
        ),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Rename a board column (Subtask 3.6.2). The column row carries its scalar
   * `projectId` (3.1.3) so the admin gate needs no extra board read, exactly
   * like `setColumnWipLimit`. Returns the updated column config DTO.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnNameError` (400).
   */
  async renameColumn(
    columnId: string,
    name: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardColumnRepository.findById(columnId, ctx.workspaceId, tx),
    );
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    const trimmed = name?.trim();
    if (!trimmed) throw new InvalidColumnNameError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { name: trimmed }, tx),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Reorder a board column (Subtask 3.6.2). `position` is the opaque
   * fractional-index sort key the client mints strictly between the two
   * neighbours it dropped the column between (the SAME rank scheme work items /
   * statuses use, `lib/workItems/positioning.ts`) — a reorder is a single-row
   * rewrite needing no cascade, mirroring the status-reorder path
   * (`updateStatus({ position })`). Returns the updated column config DTO.
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidColumnPositionError` (400).
   */
  async reorderColumn(
    columnId: string,
    position: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnConfigDto> {
    const column = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardColumnRepository.findById(columnId, ctx.workspaceId, tx),
    );
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    if (typeof position !== 'string' || position.length === 0) {
      throw new InvalidColumnPositionError();
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardColumnRepository.update(columnId, { position }, tx),
    );
    return toBoardColumnConfigDto(row);
  },

  /**
   * Delete a board column (Subtask 3.6.2). Two guards, both decided from the
   * mirror product (Jira board settings → Columns, decision-authority rung 1):
   *   - `LastColumnError` (409) — a board must keep ≥1 column (Jira never lets
   *     you delete down to zero columns).
   *   - `ColumnNotEmptyError` (409) — refuse while a mapped status still holds
   *     work items on the board ("you can't delete a column with issues"); the
   *     admin remaps those statuses elsewhere first.
   * When it proceeds, it unmaps the column's statuses (they return to
   * `unmappedStatuses` — the 3.2.6 tray) and deletes the `board_column` row, in
   * ONE transaction. It NEVER deletes a work item (a card's column is derived
   * from its `work_item.status`). NOTE: it does NOT specially guard a column
   * mapping the INITIAL status — Story 3.1 deliberately ALLOWS an unmapped
   * status (it surfaces in the tray, its issues simply hidden from the board),
   * so an initial-status guard would contradict that shipped decision (rung 2).
   *
   * Throws: `BoardColumnNotFoundError` (404), `NotBoardAdminError` (403),
   * `LastColumnError` (409), `ColumnNotEmptyError` (409).
   */
  async deleteColumn(columnId: string, ctx: ServiceContext): Promise<void> {
    const column = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardColumnRepository.findById(columnId, ctx.workspaceId, tx),
    );
    if (!column) throw new BoardColumnNotFoundError(columnId);
    await assertBoardConfigAdmin(ctx.userId, column.projectId, ctx.workspaceId);

    // The project's statuses are stable w.r.t. this op (deleteColumn never
    // touches the workflow), so resolve them once outside the tx; the column
    // mappings + counts are read INSIDE the tx, after the lock.
    const statuses = await workflowsService.listStatusesByProject(
      column.projectId,
      ctx.workspaceId,
    );
    const statusById = new Map(statuses.map((s) => [s.id, s]));

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      // Lock the board row so concurrent column adds/deletes on this board
      // serialize — without it two deletes of DIFFERENT columns each read
      // `count == 2`, both pass the last-column guard, and the board is zeroed
      // out (the TOCTOU on the ≥1-column invariant). The not-empty guard's race
      // against a card transitioning INTO the column mid-delete stays
      // best-effort (work-item writes don't touch the board row, so no lock can
      // serialize them) — but that race only UNMAPS a card (it returns to the
      // tray), never loses it, matching Jira's config-vs-issue separation.
      await boardRepository.lockById(column.boardId, ctx.workspaceId, tx);

      // Re-read the board's columns under the lock. A concurrent delete of THIS
      // column (resolved before the lock) leaves it absent now → 404.
      const columns = await boardColumnRepository.findByBoard(column.boardId, ctx.workspaceId, tx);
      if (!columns.some((c) => c.id === columnId)) throw new BoardColumnNotFoundError(columnId);
      // Last-column guard — a board must keep at least one column.
      if (columns.length <= 1) throw new LastColumnError();

      // Not-empty guard — refuse if any of the column's mapped (live) statuses
      // still holds non-archived work items on the board.
      const mappings = await boardColumnStatusRepository.findByColumn(
        columnId,
        ctx.workspaceId,
        tx,
      );
      const statusKeys = mappings
        .map((m) => statusById.get(m.statusId))
        .filter((s): s is WorkflowStatusDto => s != null)
        .map((s) => s.key);
      if (statusKeys.length > 0) {
        const cardCount = await workItemRepository.countProjectIssues(
          column.projectId,
          ctx.workspaceId,
          { statuses: statusKeys },
          tx,
        );
        if (cardCount > 0) throw new ColumnNotEmptyError(columnId, cardCount);
      }

      // Unmap the column's statuses (back to the tray), then drop the column.
      await boardColumnStatusRepository.deleteByColumn(columnId, tx);
      await boardColumnRepository.delete(columnId, tx);
    });
  },

  /**
   * Map (or MOVE) a workflow status onto a board column (Subtask 3.6.2). The
   * mapping table carries `@@unique([boardId, statusId])` (3.1.1) — a status
   * lives in AT MOST ONE column per board — so this is a MOVE, not a duplicate:
   * in ONE transaction it deletes any existing mapping for the status on this
   * board (`deleteByStatus`) then creates the new edge (`create`). Re-mapping a
   * status therefore REPLACES its row; a P2002 backstop covers the concurrent
   * race (mirrors `createStatus`). Returns the new mapping edge DTO.
   *
   * The status must belong to the board's project (else nothing to map);
   * the column must belong to this board.
   *
   * Throws: `BoardNotFoundError` / `BoardColumnNotFoundError` (404),
   * `WorkflowStatusNotFoundError` (404), `NotBoardAdminError` (403),
   * `StatusMappingConflictError` (409).
   */
  async mapStatusToColumn(
    boardId: string,
    columnId: string,
    statusId: string,
    ctx: ServiceContext,
  ): Promise<BoardColumnStatusDto> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertWorkflowMappingAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const column = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardColumnRepository.findById(columnId, ctx.workspaceId, tx),
    );
    if (!column || column.boardId !== boardId) throw new BoardColumnNotFoundError(columnId);

    const status = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workflowsRepository.findStatusById(statusId, ctx.workspaceId, tx),
    );
    if (!status || status.projectId !== board.projectId) {
      throw new WorkflowStatusNotFoundError(statusId);
    }

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // MOVE-not-duplicate: drop any existing column for this status on this
        // board, then create the new edge — both in this one transaction so the
        // unique invariant never sees two rows.
        await boardColumnStatusRepository.deleteByStatus(boardId, statusId, tx);
        try {
          return await boardColumnStatusRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId: board.projectId,
              boardId,
              columnId,
              statusId,
            },
            tx,
          );
        } catch (err) {
          /* istanbul ignore next -- defensive: P2002 only fires when a concurrent map of the same (boardId, statusId) commits between this tx's delete and create; not deterministically testable (mirrors createStatus's P2002 guard) */
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new StatusMappingConflictError(statusId);
          }
          /* istanbul ignore next -- defensive rethrow: the only expected write error here is the P2002 handled above */
          throw err;
        }
      },
    );
    return toBoardColumnStatusDto(row);
  },

  /**
   * Unmap a workflow status from the board (Subtask 3.6.2) — delete its
   * `board_column_status` edge so the status returns to `unmappedStatuses` (the
   * 3.2.6 tray); its work items are simply hidden from the board, never deleted.
   * Idempotent: unmapping a status that is already unmapped (0 rows) is a no-op
   * success — the desired end-state (not mapped) holds either way, so there is
   * no 404 for an already-unmapped / unknown status (the board + admin gates
   * already bound the operation to this workspace).
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403).
   */
  async unmapStatus(boardId: string, statusId: string, ctx: ServiceContext): Promise<void> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertWorkflowMappingAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      boardColumnStatusRepository.deleteByStatus(boardId, statusId, tx),
    );
  },

  /**
   * Rename a board (Subtask 3.6.2). Same gate + order as `setSwimlaneGroupBy`;
   * returns the updated board config DTO so the 3.6.3 UI reconciles.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `InvalidBoardNameError` (400).
   */
  async renameBoard(boardId: string, name: string, ctx: ServiceContext): Promise<BoardDto> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    const trimmed = name?.trim();
    if (!trimmed) throw new InvalidBoardNameError();

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => boardRepository.update(boardId, { name: trimmed }, tx),
    );
    return toBoardDto(row);
  },

  // ── Board LIFECYCLE writes (Subtask 3.7.3) — the multi-board CRUD path:
  // create (seed columns) / set-default / delete (rename is 3.6.2's
  // `renameBoard` above, reused as-is). Same admin gate + write convention as
  // the config writes: resolve + tenant-gate (404) → owner-authorize (403) →
  // validate (400) → write under `withWorkspaceContext` so the FORCE-RLS WITH
  // CHECK passes; scalar-FK `Unchecked` writes (finding #33). A board's CRUD is
  // a project-config write, so it rides the SAME `assertBoardConfigAdmin`
  // (workspace-OWNER) gate the rest of board admin uses — see the gate's note
  // on the card-vs-shipped resolution (the 3.7.3 card said "membership-gated",
  // but the shipped board-config precedent + Jira both gate board admin to
  // admins, so the consistent build is the owner gate; `// TODO(6.4)` widens it
  // to the project-admin role). Issues are NEVER touched by any of these — a
  // card's column is derived from `work_item.status`, and issues belong to the
  // PROJECT, not a board.

  /**
   * List a project's boards in switcher order (Subtask 3.7.3) — the `GET
   * /api/boards` read behind the 3.7.4 switcher. A plain read available to any
   * workspace member (NOT owner-gated — viewing the board switcher is not a
   * config write; the explicit `workspaceId` filter is the tenant gate, finding
   * #26). Returns the boards as switcher DTOs (id / name / type / isDefault /
   * position), ordered by `position`.
   */
  async listBoards(projectId: string, ctx: ServiceContext): Promise<BoardSummaryDto[]> {
    // BROWSE-gated (MOTIR-2296). It was the one board read with no gate at all,
    // so a workspace member who could not browse a private project could still
    // enumerate its boards. A `manage` key here would be wrong — seeing which
    // boards exist is what every member of the project does all day.
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const boards = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findByProjectByPosition(projectId, ctx.workspaceId, tx),
    );
    return boards.map(toBoardSummaryDto);
  },

  /**
   * Create a new (non-default) board on a project (Subtask 3.7.3) and seed its
   * default columns off the project workflow (REUSE the 3.1 board-bootstrap, so
   * a new board is immediately usable). The board appends to the end of the
   * switcher (`position` after the last board); it is NOT the default (the
   * project keeps its existing default — set this one default via
   * `setDefaultBoard`). `type` defaults to `kanban` (the only UI option until
   * the Scrum board, Story 4.5) but is validated against the SHIPPED `BoardType`
   * enum (rung 2) so the check stays total. Returns the new board's switcher DTO.
   *
   * Throws: `ProjectNotFoundError` (404 — unknown / cross-workspace project),
   * `NotBoardAdminError` (403), `InvalidBoardNameError` (400),
   * `InvalidBoardTypeError` (400).
   */
  async createBoard(
    projectId: string,
    input: { name: string; type?: string },
    ctx: ServiceContext,
  ): Promise<BoardSummaryDto> {
    // Resolve + tenant-gate the project AND owner-authorize in one call (the
    // gate 404s a foreign projectId before any membership probe).
    await assertBoardConfigAdmin(ctx.userId, projectId, ctx.workspaceId);
    return createBoardUnchecked(projectId, input, ctx);
  },

  /**
   * Ensure the project has a SCRUM board, creating one if it has none — the
   * "board opens" side effect of starting a sprint (Story 4.4).
   *
   * ⚠️ IT IS NOT GATED ON `board:configure`, AND THAT IS THE POINT (Story
   * MOTIR-2291 · Subtask MOTIR-2350, fixed here after the story's own E2E caught
   * it). Starting a sprint provisions the board the sprint is viewed on; that is
   * a SYSTEM side effect of the sprint act, not the actor configuring a board.
   *
   * Until MOTIR-2350, `startSprint` was workspace-OWNER-only, so the
   * `board:configure` assert inside `createBoard` always passed and the coupling
   * was invisible. `sprint:manage` admits a project MEMBER — who does not hold
   * `board:configure` — so the inner call began refusing them, and the sprint
   * route had no arm for that refusal: starting a sprint returned a **500**.
   *
   * The caller's own authority is checked by the caller (`sprintsService`
   * asserts `sprint:manage` first). Nothing else may call this: it is exported on
   * the service so the sprint flow can reach it, and its name says what it is.
   */
  async ensureScrumBoard(projectId: string, ctx: ServiceContext): Promise<void> {
    const boards = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findByProjectByPosition(projectId, ctx.workspaceId, tx),
    );
    if (boards.some((b) => b.type === BoardType.scrum)) return;
    await createBoardUnchecked(projectId, { name: 'Sprint board', type: 'scrum' }, ctx);
  },

  /**
   * Make a board the project's DEFAULT (Subtask 3.7.3) — the board `/boards`
   * opens when no `?board=` is given. Flips the project's default in ONE
   * transaction: clear the prior default, then set this board — the order the
   * partial unique index `board_one_default_per_project` (`WHERE is_default`)
   * requires (two `is_default = true` rows for a project are rejected, so the
   * clear must precede the set). A no-op (returns the board unchanged) when it is
   * already the default. Returns the now-default board's switcher DTO.
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403).
   */
  async setDefaultBoard(boardId: string, ctx: ServiceContext): Promise<BoardSummaryDto> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    // Already the default → no write (and the clear-then-set below would be a
    // wasteful self-flip).
    if (board.isDefault) return toBoardSummaryDto(board);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        await boardRepository.clearDefaultForProject(board.projectId, ctx.workspaceId, tx);
        return boardRepository.update(boardId, { isDefault: true }, tx);
      },
    );
    return toBoardSummaryDto(row);
  },

  /**
   * Delete a board (Subtask 3.7.3). Removes the board + its column/config rows
   * (the FK `onDelete: Cascade` tears down `board_column` + `board_column_status`);
   * the project's ISSUES are untouched (they belong to the project, and still
   * show on the remaining boards). Two guards, both from the mirror product
   * (rung 1) + the board analogue of `deleteColumn`'s guards:
   *   - `LastBoardError` (409) — a project must keep ≥1 board (the last board
   *     can't be deleted — there'd be no board to open).
   *   - deleting the **default** PROMOTES the next board by position to default,
   *     so the project never ends up with no default.
   * Runs under a project-wide `FOR UPDATE` lock so two concurrent deletes of
   * different boards serialize (closing the TOCTOU on the ≥1-board invariant —
   * the board analogue of `deleteColumn`'s board-row lock).
   *
   * Throws: `BoardNotFoundError` (404), `NotBoardAdminError` (403),
   * `LastBoardError` (409).
   */
  async deleteBoard(boardId: string, ctx: ServiceContext): Promise<void> {
    const board = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      boardRepository.findById(boardId, ctx.workspaceId, tx),
    );
    if (!board) throw new BoardNotFoundError(boardId);
    await assertBoardConfigAdmin(ctx.userId, board.projectId, ctx.workspaceId);

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      // Lock the project's boards so concurrent deletes serialize — without it
      // two deletes of DIFFERENT boards in a 2-board project each read
      // `length == 2`, both pass the last-board guard, and the project is
      // zeroed out (the TOCTOU on the ≥1-board invariant).
      await boardRepository.lockByProject(board.projectId, ctx.workspaceId, tx);

      // Re-read under the lock, in switcher (position) order. A concurrent
      // delete of THIS board (resolved before the lock) leaves it absent → 404.
      const boards = await boardRepository.findByProjectByPosition(
        board.projectId,
        ctx.workspaceId,
        tx,
      );
      const target = boards.find((b) => b.id === boardId);
      if (!target) throw new BoardNotFoundError(boardId);
      // Last-board guard — a project must keep at least one board.
      if (boards.length <= 1) throw new LastBoardError();

      // Delete the board first (cascade drops its columns + mappings); doing
      // it BEFORE promoting keeps the partial unique index satisfied (the
      // default row is gone, so setting another default can't collide).
      await boardRepository.delete(boardId, tx);

      // Promote the next board (lowest remaining position) to default if we
      // just deleted the default — never leave the project without one.
      if (target.isDefault) {
        const next = boards.find((b) => b.id !== boardId)!;
        await boardRepository.update(next.id, { isDefault: true }, tx);
      }
    });
  },
};

/**
 * Board-config admin gate (Subtask 3.3.3). v1 routes "board admin" to the
 * workspace OWNER (finding #36), EXACTLY mirroring `workflowsService`'s
 * `assertProjectAdmin` — board configuration (swimlanes, WIP) is project-
 * settings, the same tier the workflow editor guards. Full per-project RBAC is
 * Epic 6.4 (TODO(6.4): widen the role-set behind this gate; the gate SHAPE is
 * already durable, only the allowed roles change). Also asserts the project
 * belongs to the workspace (404 no-existence-leak) so a foreign projectId can't
 * probe membership.
 *
 * NOTE (decision-ladder + PRODECT_FINDINGS): the 3.3.3 card prose said board
 * config is "a write any workspace member can make today". The SHIPPED 2.2.5
 * editor it names as the precedent is owner-gated (rung 2 > the card), and Jira
 * gates board config to admins (rung 1) — so the owner gate is the consistent
 * build, not "any member". Logged as a finding.
 */
/**
 * Assert the actor may configure this project's boards (Story MOTIR-2256 ·
 * Subtask MOTIR-2296). A thin adapter onto the ONE shared gate, kept as a named
 * function because ten board-shape methods call it and the name says what the
 * call means.
 *
 * ⚠️ IT REPLACES A GATE THAT ASKED A DIFFERENT QUESTION, AND THAT IS A DELIBERATE
 * WIDENING. Until this card, board configuration ran through a module-private
 * `assertBoardConfigAdmin` resolving `isLegacyOwnerRole(membership?.role)` — the
 * workspace OWNER, and nobody else. Not a workspace admin, not the project's own
 * admin. `board:configure` is held by all three, so a project admin can now tune
 * their own board, which is what the key exists to express and what both mirrors
 * do (Jira team-managed and Plane put board configuration under project
 * administration).
 *
 * It is also REQUIRED rather than optional: MOTIR-2293 put `board:configure` into
 * `BUILTIN_ROLE_PERMISSIONS.admin`, so leaving the old gate would have the
 * catalog advertise a permission a project admin holds while this code refuses
 * them — the exact lie `lib/permissions/catalog.ts`'s opening rule forbids.
 *
 * The 404-before-403 ordering comes along with the shared gate: an actor who
 * cannot BROWSE the project gets `ProjectNotFoundError`, so a board they may not
 * see stays invisible rather than merely forbidden.
 */
/**
 * Assert the actor may change which STATUSES a board column projects (Story
 * MOTIR-2256 · Subtask MOTIR-2297). Distinct from {@link assertBoardConfigAdmin}
 * on purpose: the column→status mapping is a WORKFLOW decision surfaced on a
 * board (the inventory's R10 says so), so it asks `workflow:manage`, while the
 * board's own SHAPE — its columns, swimlanes and WIP limits — asks
 * `board:configure`. A role holder who tunes the board should not thereby get to
 * redefine what its columns MEAN.
 *
 * Same widening as its sibling: this replaced a workspace-OWNER-only gate.
 */
async function assertWorkflowMappingAdmin(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  await projectAccessService.assertPermission(
    projectId,
    { userId, workspaceId },
    'workflow:manage',
  );
}

async function assertBoardConfigAdmin(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  await projectAccessService.assertPermission(
    projectId,
    { userId, workspaceId },
    'board:configure',
  );
}

/**
 * Seed a board's default columns off its project's workflow (Subtask 3.1.2 core,
 * SHARED by 3.7.3's `createBoard`). One column per workflow status in
 * `status.position` order, each mapped to its single status — the column-from-
 * workflow projection over the durable many-to-one mapping (3.1.1), NOT a
 * hardcoded 1:1. Reads the statuses through the SAME `tx` (a brand-new project's
 * statuses aren't visible outside the createProject tx yet; an existing
 * project's are stable), then resolves each column's status `key → id`. Rows
 * carry the SCALAR workspaceId/projectId (finding #33). The board row itself is
 * created by the caller (with its own default-ness + position); this only writes
 * the columns + mappings.
 */
async function seedColumnsForBoard(
  boardId: string,
  projectId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const statuses = await workflowsRepository.findStatuses(projectId, workspaceId, tx);
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
  const spec = buildDefaultBoard(statuses.map(toWorkflowStatusDto));

  for (const col of spec.columns) {
    const column = await boardColumnRepository.create(
      { workspaceId, projectId, boardId, name: col.name, position: col.position },
      tx,
    );
    for (const key of col.statusKeys) {
      const statusId = statusIdByKey.get(key);
      // Unreachable — buildDefaultBoard only emits keys drawn from `statuses`;
      // the guard turns a future projection bug into a clear failure instead of
      // a Prisma null-FK error (mirrors seedDefaultWorkflow's guard).
      if (!statusId) {
        throw new Error(`defaultBoard: column "${col.name}" maps an unknown status key "${key}"`);
      }
      await boardColumnStatusRepository.create(
        { workspaceId, projectId, boardId, columnId: column.id, statusId },
        tx,
      );
    }
  }
}

/** True iff `value` is one of the `BoardType` enum values (`kanban` / `scrum`). */
function isBoardType(value: string): value is BoardType {
  return (Object.values(BoardType) as string[]).includes(value);
}

/** True iff `value` is one of the `BoardSwimlaneGroupBy` enum values. */
function isSwimlaneGroupBy(value: string): value is BoardSwimlaneGroupBy {
  return (Object.values(BoardSwimlaneGroupBy) as string[]).includes(value);
}

/** True iff `limit` is `null` (clear) or a non-negative integer. */
function isValidWipLimit(limit: number | null): boolean {
  return limit === null || (Number.isInteger(limit) && limit >= 0);
}

/**
 * The board's lane PAGE SIZE (MOTIR-10535) — how many cards a lane loads at a
 * time: the projection's first page, and every page the lane's scroll-to-bottom
 * asks for after it. It is what bounds a board read (lanes × this, never the
 * project's card count), so every per-card batch on the board is sized by it.
 */
export const BOARD_PAGE_SIZE = 10;

/** The per-project terminal-status key set (category `done`) — the finding-#21
 * terminal generalization, reused for both readiness and terminal-column order. */
function terminalKeySet(statuses: WorkflowStatusDto[]): Set<string> {
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** A column is terminal iff it maps at least one live status and EVERY mapped
 * status is terminal (the Done / Cancelled columns). */
function isTerminalColumn(statusKeys: string[], terminalKeys: Set<string>): boolean {
  return statusKeys.length > 0 && statusKeys.every((k) => terminalKeys.has(k));
}

/** A lane's card order: recency for a done-category (terminal) lane, the board
 * rank for every other. The cursor carries it, so the two never cross. */
function columnOrder(statusKeys: string[], terminalKeys: Set<string>): ColumnOrder {
  return isTerminalColumn(statusKeys, terminalKeys) ? 'recent' : 'position';
}

/** A column's mapped LIVE status keys, in workflow `position` order. */
function columnStatusKeys(liveByColumn: Map<string, WorkflowStatusDto[]>, columnId: string) {
  return (liveByColumn.get(columnId) ?? [])
    .slice()
    .sort(byPosition)
    .map((s) => s.key);
}

/** Sort `WorkflowStatusDto`s by their fractional-index `position` (lexicographic). */
function byPosition(a: WorkflowStatusDto, b: WorkflowStatusDto): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

/** A resolved + validated board filter (Story 6.15.2): the compiled `FilterAst`
 * plus the Epic-5 referents its label/component/custom-field conditions resolve
 * against. Threaded into every board read so the board, its column counts, its
 * `truncated`/cap, and its swimlane lanes all narrow to the matching set. */
type ResolvedBoardFilter = { ast: FilterAst; referents?: ProjectFilterReferents };

/**
 * Resolve the optional board FILTER input (Story 6.15.2) into a compiled
 * `{ ast, referents }`, or `undefined` when no filter narrows the board (no
 * input, or an empty AST — both leave the projection byte-for-byte unfiltered).
 *
 * REUSE, not rebuild: a `savedFilterId` (a row id or a `builtin:<slug>`)
 * resolves through `savedFiltersService.resolve` — the SAME 6.2 read the
 * `/items` navigator uses, with its access gate (an unknown / unauthorized id
 * throws `SavedFilterNotFoundError`, which the 6.15.3 route maps to 404; a
 * stored envelope gone stale resolves to `ast: null`, which degrades to "no
 * filter" exactly like the navigator's read, leaving the degraded-state notice
 * to the 6.15.3 surface). An inline `ast` (the quick-filter builder's output)
 * is validated by `resolveFilterAst` — an unknown field/operator id or a bad
 * value throws a typed `FilterValidationError` (→ 422). `savedFilterId` wins
 * when both are present. Epic-5 referents load through the bounded
 * `loadFilterReferents` the navigator already uses (finding #57 — never
 * load-all). The compiler re-resolves in depth (defence in depth, the
 * `findProjectIssuesFlat` precedent).
 */
async function resolveBoardFilter(
  projectId: string,
  filter: BoardFilterInput | undefined,
  // A member's context, or — for a Visitor's inline filter (MOTIR-6644), which
  // never carries a saved filter — only the project's workspace.
  ctx: ServiceContext | Pick<ServiceContext, 'workspaceId'>,
): Promise<ResolvedBoardFilter | undefined> {
  if (!filter) return undefined;

  let ast: FilterAst | undefined;
  if (filter.savedFilterId) {
    /* istanbul ignore next -- defensive: `getBoard` resolves a saved filter for a member only */
    if (!('userId' in ctx)) return undefined;
    // Saved filters resolve by the project's IDENTIFIER (the `PROD`-style key),
    // not its id — `getBoard` already browse-gated the project, so this read is
    // for the key only.
    const project = await readProject(projectId, ctx);
    /* istanbul ignore next -- defensive: getBoard's assertCanBrowse already resolved the project; a null here would mean it vanished mid-request */
    if (!project) throw new ProjectNotFoundError(projectId);
    const resolved = await savedFiltersService.resolve(
      project.identifier,
      filter.savedFilterId,
      ctx,
    );
    ast = resolved.ast ?? undefined;
  } else {
    ast = filter.ast;
  }

  if (!ast || ast.conditions.length === 0) return undefined;

  const referents = await loadFilterReferents(projectId, ctx.workspaceId, ast);
  // Validate against the registry (an inline board query's path to a typed 422);
  // a saved-filter AST is already validated by `resolve`, so this is a cheap
  // re-check there.
  resolveFilterAst(ast, referents);
  return { ast, referents };
}

/**
 * Everything a board read resolves before it reads a single card (shared by
 * `getBoard` and `getColumnPage`, MOTIR-10535): the reader, the board, its
 * filter, its columns + status mapping, the workflow and the scrum sprint.
 */
type BoardFrame = {
  /** The member reading, or null for a Visitor (MOTIR-6644). */
  member: ServiceContext | null;
  /** A Visitor's private-epic exclusion; `undefined` for a member. */
  excludeIds: readonly string[] | undefined;
  /** The binding every read runs under: the PROJECT's workspace. */
  readCtx: { workspaceId: string; userId: string | null };
  board: Board;
  boardFilter: ResolvedBoardFilter | undefined;
  columns: BoardColumn[];
  liveByColumn: Map<string, WorkflowStatusDto[]>;
  mappedStatusIds: Set<string>;
  statuses: WorkflowStatusDto[];
  terminalKeys: Set<string>;
  categoryByStatusKey: Map<string, WorkflowStatusDto['category']>;
  /** The active sprint on a scrum board (Subtask 4.5.2); null on kanban. */
  activeSprint: Sprint | null;
};

async function loadBoardFrame(
  projectId: string,
  ctx: ServiceContext | VisitorReadContext,
  boardId: string | undefined,
  filter: BoardFilterInput | undefined,
): Promise<BoardFrame> {
  // Project access gate (6.4.3): the board projection is a read of the
  // project — a non-browser (a non-member of a private project) gets a 404,
  // never the board. Runs first so a hidden project never leaks its board.
  // A VISITOR (MOTIR-6644) is gated to their one public project and reads every
  // column, count and lane with the private-epic descendants withheld; a
  // member's read carries no exclusion, byte for byte as before.
  const member = isVisitorContext(ctx) ? null : ctx;
  const excludeIds = member
    ? undefined
    : openVisitorRead(projectId, ctx as VisitorReadContext).excludeIds;
  if (member) await projectAccessService.assertCanBrowse(projectId, member);
  // Every read below binds the PROJECT's workspace and nothing about the actor.
  const readCtx = {
    workspaceId: member ? member.workspaceId : (ctx as VisitorReadContext).project.workspaceId,
    userId: member ? member.userId : null,
  };

  const board = await withWorkspaceServiceContext(readCtx.workspaceId, (tx) =>
    boardId
      ? boardRepository.findById(boardId, readCtx.workspaceId, tx)
      : boardRepository.findDefaultForProject(projectId, readCtx.workspaceId, tx),
  );
  // A selected board must live in the active project (the workspace gate is
  // already in the repo read); the default lookup is project-scoped by query.
  if (!board || board.projectId !== projectId) {
    throw new BoardNotFoundError(boardId ?? `default board for project ${projectId}`);
  }

  // The advanced board filter (Story 6.15.2). Resolved ONCE here — an inline
  // AST is validated (bad condition → typed 422), a saved-filter id resolves
  // through the 6.2 access gate (unknown/unauthorized → SavedFilterNotFound →
  // 404 at the 6.15.3 route). `undefined` when no filter narrows the board, in
  // which case every read below is byte-for-byte the unfiltered projection.
  // Resolved before the scrum no-sprint early return so an invalid filter is
  // rejected consistently regardless of the board's sprint state.
  // A saved filter is its owner's; a Visitor's board takes an inline filter only.
  const boardFilter = member
    ? await resolveBoardFilter(projectId, filter, member)
    : filter && !filter.savedFilterId
      ? await resolveBoardFilter(projectId, filter, readCtx)
      : undefined;

  // The board's own two reads share ONE bound transaction; the workflow LIST is
  // a service call and opens its own (the call-into-another-service clause in
  // the transaction-shape ADR).
  const { columns, mappings } = await withWorkspaceServiceContext(
    readCtx.workspaceId,
    async (tx) => ({
      columns: await boardColumnRepository.findByBoard(board.id, readCtx.workspaceId, tx),
      mappings: await boardColumnStatusRepository.findByBoard(board.id, readCtx.workspaceId, tx),
    }),
  );
  const statuses = await workflowsService.listStatusesByProject(projectId, readCtx.workspaceId);
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  // column id → its mapped LIVE statuses; plus the set of all mapped status
  // ids (any status NOT in it is unmapped). A mapping to a deleted status is
  // skipped (no live key) but does not make the status "unmapped".
  const liveByColumn = new Map<string, WorkflowStatusDto[]>();
  const mappedStatusIds = new Set<string>();
  for (const m of mappings) {
    mappedStatusIds.add(m.statusId);
    const s = statusById.get(m.statusId);
    if (!s) continue;
    const list = liveByColumn.get(m.columnId) ?? [];
    list.push(s);
    liveByColumn.set(m.columnId, list);
  }

  // SPRINT SCOPE (Subtask 4.5.2). A SCRUM board renders only its project's
  // ACTIVE sprint. The sprint is PROJECT-scoped, not board-scoped (schema rung
  // 2: there is no `board.sprintId`; the `sprint_one_active_per_project`
  // partial-unique index makes "the board's active sprint" unambiguous). A
  // `kanban` board is unscoped.
  const activeSprint =
    board.type === BoardType.scrum
      ? await withWorkspaceServiceContext(readCtx.workspaceId, (tx) =>
          sprintRepository.findActiveByProject(projectId, readCtx.workspaceId, tx),
        )
      : null;

  return {
    member,
    excludeIds,
    readCtx,
    board,
    boardFilter,
    columns,
    liveByColumn,
    mappedStatusIds,
    statuses,
    terminalKeys: terminalKeySet(statuses),
    // Status KEY → its CATEGORY, for the CI badge's done-category rule
    // (MOTIR-5474). The badge rule is keyed on the CATEGORY rather than on the
    // column, because a board maps statuses to columns many-to-one.
    categoryByStatusKey: new Map(statuses.map((s) => [s.key, s.category])),
    activeSprint,
  };
}

/**
 * Build one PAGE of a lane (MOTIR-10535): its FULL card count + up to
 * {@link BOARD_PAGE_SIZE} cards strictly after `after` (the first page when
 * absent), in the lane's order, and the cursor naming the page's last card when
 * more remain. It reads one row past the page to learn that, so no second count
 * is needed. A column mapping no live status is an empty lane.
 *
 * The board's scrum sprint scope (Subtask 4.5.2), its filter (6.15.2) and a
 * Visitor's private-epic exclusion (MOTIR-6644) narrow the count AND the cards
 * alike, so the header denominator is always the set the lane pages through.
 */
async function buildColumnPage(
  projectId: string,
  col: BoardColumn,
  frame: BoardFrame,
  after: ColumnCursor | undefined,
): Promise<{
  col: BoardColumn;
  statusKeys: string[];
  rows: WorkItem[];
  totalCount: number;
  cursor: string | null;
}> {
  const statusKeys = columnStatusKeys(frame.liveByColumn, col.id);
  if (statusKeys.length === 0) {
    return { col, statusKeys, rows: [], totalCount: 0, cursor: null };
  }
  const order = columnOrder(statusKeys, frame.terminalKeys);
  const { workspaceId } = frame.readCtx;
  const sprintId = frame.activeSprint?.id;
  const filter = frame.boardFilter;
  const excludeIds = frame.excludeIds;
  // The lane's cards and its own denominator, in ONE bound transaction: two
  // reads of the same predicate rendered as one column header, so a write
  // landing between them cannot make "12 of 9" appear.
  const { totalCount, fetched } = await withWorkspaceServiceContext(workspaceId, async (tx) => ({
    totalCount: await workItemRepository.countProjectIssues(
      projectId,
      workspaceId,
      {
        statuses: statusKeys,
        ...(sprintId ? { sprintId } : {}),
        ...(filter ? { ast: filter.ast, filterReferents: filter.referents } : {}),
        ...(excludeIds ? { excludeIds } : {}),
      },
      tx,
    ),
    fetched: await workItemRepository.findColumnCards(
      projectId,
      workspaceId,
      statusKeys,
      order,
      {
        limit: BOARD_PAGE_SIZE + 1,
        ...(after ? { after } : {}),
        sprintId,
        ...(filter ? { ast: filter.ast, referents: filter.referents } : {}),
        ...(excludeIds ? { excludeIds } : {}),
      },
      tx,
    ),
  }));
  const rows = fetched.slice(0, BOARD_PAGE_SIZE);
  const last = rows[rows.length - 1];
  const cursor = fetched.length > BOARD_PAGE_SIZE && last ? cursorAfter(order, last) : null;
  return { col, statusKeys, rows, totalCount, cursor };
}

/**
 * Every per-card batch of a board read, over the LOADED rows only (MOTIR-10535):
 * readiness, the decision-waiting marker, the review state, the plan hold, the
 * swimlane key and the To fix tag. Each is ONE batched read over `rows` — a
 * fixed number of queries per page, never one per card — so a page costs the
 * same on a 30-card board as on a 3,000-card one. Answers the card mapper and
 * the plans that hold any of the rows.
 */
async function decorateBoardRows(
  projectId: string,
  rows: WorkItem[],
  frame: BoardFrame,
): Promise<{
  toCard: (row: WorkItem) => BoardCardDto;
  planHolds: Record<string, BoardPlanHoldSummaryDto>;
}> {
  const { member, readCtx } = frame;
  const ids = rows.map((r) => r.id);
  const groupBy = frame.board.swimlaneGroupBy as BoardSwimlaneGroupByDto;

  // Readiness (finding #21), one pass over the loaded cards.
  const readyById = await workItemsService.getReadinessForItems(ids, readCtx);

  // The decision-waiting marker (Story MOTIR-4908 · MOTIR-5876): which cards have
  // an awaiting gate, and whether it is this reader's — ONE gate query. A Visitor
  // decides nothing, so no card is waiting on them.
  const pendingById: Awaited<ReturnType<typeof approvalGatesService.pendingDecisionsFor>> = member
    ? await approvalGatesService.pendingDecisionsFor({ projectId, workItemIds: ids }, member)
    : new Map();

  // THE REVIEW MARKERS AND THE REVIEWED BADGE (Story MOTIR-10327 · MOTIR-10341): the
  // review state read model's ONE batch. Per-reader like the marker above, so a
  // Visitor's board reads none. Sized by the page — the whole-board version of
  // this read is what overran the transaction budget (MOTIR-10535).
  const reviewById: CardReviewMap = member
    ? await reviewStateService.cardReviewsFor(projectId, ids, member)
    : {};

  // The PLAN HOLD (Story MOTIR-6017 · MOTIR-6268): which loaded cards an undecided
  // plan holds at Planning, and per holding plan its label and held count (the
  // count is the plan's own, server-side — not the loaded cards'). No read at all
  // when no loaded card is at Planning.
  const planHoldRead = await planTargetLockService.readBoardPlanHolds(projectId, rows, readCtx);
  // Keyed by `planHoldKey`: the plan's id, or `session:<id>` for an OPEN session's
  // hold (AMENDMENT 23 §5; MOTIR-7640).
  const planHolds: Record<string, BoardPlanHoldSummaryDto> = {};
  for (const [key, plan] of planHoldRead.plans) {
    planHolds[key] = {
      kind: plan.kind,
      planId: plan.planId,
      sessionId: plan.sessionId,
      anchorKey: plan.anchorKey,
      title: plan.title,
      heldCount: plan.heldCount,
    };
  }

  // Swimlane membership (Subtask 3.3.4) — per loaded card; a no-op on `none`.
  const swimlaneKeyByCard = await resolveSwimlaneKeys(groupBy, rows, readCtx);

  // The To fix tag's *· with {head}* (MOTIR-7589) and Fixing (MOTIR-10309): read only for
  // the cards showing a reason, and never for a Visitor — a head key names another card.
  const fixTags = member
    ? await withWorkspaceServiceContext(readCtx.workspaceId, (tx) =>
        fixTagFactsFor(
          readCtx.workspaceId,
          rows.filter((r) => r.fixReason !== null).map((r) => r.id),
          tx,
        ),
      )
    : NO_FIX_TAG_FACTS;

  const toCard = (r: WorkItem): BoardCardDto => {
    const card = toBoardCardDto(r, {
      ready: readyById.get(r.id) ?? true,
      pendingDecision: pendingById.get(r.id) ?? null,
      review: reviewById[r.id] ?? null,
      planHold: planHoldRead.byItemId.get(r.id) ?? null,
      swimlaneKey: swimlaneKeyByCard.get(r.id),
      statusCategory: frame.categoryByStatusKey.get(r.status) ?? null,
    });
    Object.assign(card, fixTagFieldsOf(r.id, fixTags));
    // A Visitor's PRIVATE epic card wears "Not public" (MOTIR-6648;
    // `epic-privacy.md` §4) — a member's card is unchanged.
    return !member && r.kind === 'epic' && r.publicChildrenHidden
      ? { ...card, childrenHidden: true as const }
      : card;
  };
  return { toCard, planHolds };
}

/**
 * Resolve a rank-neighbour id to its `position` and `key`, or null when no neighbour is
 * given (the open end of the column). A neighbour must exist and be in the same
 * workspace + project as the board; otherwise it's a 404 (no cross-tenant leak).
 */
async function resolveNeighbour(
  neighbourId: string | undefined,
  projectId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<{ position: string; key: number } | null> {
  if (!neighbourId) return null;
  const neighbour = await workItemRepository.findById(neighbourId, tx);
  if (
    !neighbour ||
    neighbour.workspaceId !== ctx.workspaceId ||
    neighbour.projectId !== projectId
  ) {
    throw new WorkItemNotFoundError(neighbourId);
  }
  return { position: neighbour.position, key: neighbour.key };
}

/** Lane order for the `priority` group-by — Jira shows highest severity first;
 * the catch-all does not apply (priority is non-null). */
const PRIORITY_LANE_ORDER = ['highest', 'high', 'medium', 'low', 'lowest'];

/**
 * Resolve each loaded card's `swimlaneKey` under the active group-by (Subtask
 * 3.3.4), so the client never re-derives lane membership: `assignee` → the
 * card's `assigneeId` (or the catch-all sentinel when unassigned); `priority` →
 * the priority value; `epic` → the card's NEAREST ANCESTOR epic id (or the
 * catch-all when it has none). Returns an EMPTY map for `none` — the flat board
 * stamps no key (the mapper then omits the field). assignee/priority read
 * straight off the loaded row (no query); epic needs ONE bounded recursive walk
 * over the loaded ids (no N+1).
 */
async function resolveSwimlaneKeys(
  groupBy: BoardSwimlaneGroupByDto,
  rows: WorkItem[],
  ctx: Pick<ServiceContext, 'workspaceId'>,
): Promise<Map<string, string>> {
  const keyByCard = new Map<string, string>();
  if (groupBy === 'none' || rows.length === 0) return keyByCard;
  if (groupBy === 'assignee') {
    for (const r of rows) keyByCard.set(r.id, r.assigneeId ?? BOARD_SWIMLANE_NO_VALUE);
  } else if (groupBy === 'priority') {
    for (const r of rows) keyByCard.set(r.id, r.priority);
  } else {
    const pairs = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findEpicAncestors(
        rows.map((r) => r.id),
        ctx.workspaceId,
        tx,
      ),
    );
    const epicByCard = new Map(pairs.map((p) => [p.cardId, p.epicId]));
    for (const r of rows) keyByCard.set(r.id, epicByCard.get(r.id) ?? BOARD_SWIMLANE_NO_VALUE);
  }
  return keyByCard;
}

/**
 * Build the ordered lane list for the board (Subtask 3.3.4) from a BOUNDED
 * grouped aggregate over the board's cards — lanes-with-cards + the catch-all,
 * NEVER a per-card fetch (finding #57). `statusKeys` is the union of the
 * board's mapped column statuses (the card population). Lane order: assignee by
 * display name (alpha), priority by severity rank, epic by epic `position`; the
 * catch-all (unassigned / no epic) always sorts LAST. `none` → no lanes.
 */
async function buildSwimlanes(
  groupBy: BoardSwimlaneGroupByDto,
  projectId: string,
  statusKeys: string[],
  ctx: Pick<ServiceContext, 'workspaceId'>,
  sprintId?: string,
  filter?: ResolvedBoardFilter,
  // A Visitor's private-epic exclusion (MOTIR-6644): lanes count visible cards only.
  excludeIds?: readonly string[],
  // A Visitor's lanes name people by display name only (MOTIR-6646).
  nameOnly = false,
): Promise<BoardSwimlaneDto[]> {
  if (groupBy === 'none' || statusKeys.length === 0) return [];

  // 6.15.2 — the lane aggregates AND in the SAME compiled filter as the columns
  // so a filtered, grouped board's lanes + counts reflect only matching cards
  // (a lane whose cards all fail the filter disappears). `undefined` → the
  // byte-for-byte unfiltered 3.3.4 aggregate.
  const laneFilter =
    filter || excludeIds
      ? {
          ...(filter ? { ast: filter.ast, referents: filter.referents } : {}),
          ...(excludeIds ? { excludeIds } : {}),
        }
      : undefined;

  if (groupBy === 'assignee') {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.aggregateBoardLanesByAssignee(
        projectId,
        ctx.workspaceId,
        statusKeys,
        sprintId,
        laneFilter,
        tx,
      ),
    );
    const assigneeIds = rows.map((r) => r.assigneeId).filter((id): id is string => id !== null);
    const users = await userRepository.findByIds(assigneeIds);
    // A member's lane keeps its `name || email` label; a Visitor's never reads the
    // email and falls back to the neutral label (MOTIR-6646).
    const nameById = new Map(
      users.map((u) => [u.id, nameOnly ? personName(u.name) : u.name?.trim() || u.email]),
    );
    const lanes: BoardSwimlaneDto[] = rows
      .filter((r) => r.assigneeId !== null)
      .map((r) => ({
        key: r.assigneeId as string,
        label: nameById.get(r.assigneeId as string) ?? 'Unknown user',
        kind: 'assignee' as const,
        count: r.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const unassigned = rows.find((r) => r.assigneeId === null);
    if (unassigned) {
      lanes.push({
        key: BOARD_SWIMLANE_NO_VALUE,
        label: 'No assignee',
        kind: 'assignee',
        count: unassigned.count,
      });
    }
    return lanes;
  }

  if (groupBy === 'priority') {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.aggregateBoardLanesByPriority(
        projectId,
        ctx.workspaceId,
        statusKeys,
        sprintId,
        laneFilter,
        tx,
      ),
    );
    return rows
      .map((r) => ({
        key: r.priority as string,
        label: r.priority as string,
        kind: 'priority' as const,
        count: r.count,
      }))
      .sort((a, b) => PRIORITY_LANE_ORDER.indexOf(a.key) - PRIORITY_LANE_ORDER.indexOf(b.key));
  }

  // epic — group by ancestor epic; the catch-all count is DERIVED by
  // subtraction (total board cards − Σ epic-lane counts), so no extra per-card
  // scan is needed to size the "No epic" lane.
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.aggregateBoardLanesByEpic(
      projectId,
      ctx.workspaceId,
      statusKeys,
      sprintId,
      laneFilter,
      tx,
    ),
  );
  const epics = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findByIds(
      rows.map((r) => r.epicId),
      tx,
    ),
  );
  const epicById = new Map(epics.map((e) => [e.id, e]));
  const lanes: BoardSwimlaneDto[] = rows
    .map((r) => {
      const epic = epicById.get(r.epicId);
      return {
        lane: {
          key: r.epicId,
          label: epic ? `${epic.identifier} ${epic.title}` : 'Epic',
          kind: 'epic' as const,
          count: r.count,
        },
        position: epic?.position ?? '',
      };
    })
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((x) => x.lane);

  const epicCardCount = rows.reduce((sum, r) => sum + r.count, 0);
  const total = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.countProjectIssues(
      projectId,
      ctx.workspaceId,
      {
        statuses: statusKeys,
        ...(sprintId ? { sprintId } : {}),
        // The "No epic" catch-all is DERIVED (filtered total − Σ epic-lane counts),
        // so this denominator must use the SAME 6.15.2 filter as the epic
        // aggregate.
        ...(filter ? { ast: filter.ast, filterReferents: filter.referents } : {}),
      },
      tx,
    ),
  );
  const noEpicCount = total - epicCardCount;
  if (noEpicCount > 0) {
    lanes.push({
      key: BOARD_SWIMLANE_NO_VALUE,
      label: 'No epic',
      kind: 'epic',
      count: noEpicCount,
    });
  }
  return lanes;
}

/**
 * Create a board — validation, the transaction and the seeded columns — with NO
 * authorization of its own. Every caller gates first: `createBoard` asserts
 * `board:configure`, and `ensureScrumBoard` is reached only from a sprint start
 * that has already asserted `sprint:manage` (see the ⚠️ there).
 */
async function createBoardUnchecked(
  projectId: string,
  input: { name: string; type?: string },
  ctx: ServiceContext,
): Promise<BoardSummaryDto> {
  const name = input.name?.trim();
  if (!name) throw new InvalidBoardNameError();
  const type = input.type ?? BoardType.kanban;
  if (!isBoardType(type)) throw new InvalidBoardTypeError(String(type));

  const row = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      // Append after the last board by position (the switcher order).
      const boards = await boardRepository.findByProjectByPosition(projectId, ctx.workspaceId, tx);
      const last = boards.length ? boards[boards.length - 1]!.position : null;
      const board = await boardRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId,
          name,
          type,
          isDefault: false,
          position: keyForAppend(last),
        },
        tx,
      );
      await seedColumnsForBoard(board.id, projectId, ctx.workspaceId, tx);
      return board;
    },
  );
  return toBoardSummaryDto(row);
}
