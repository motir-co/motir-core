import { NextResponse } from 'next/server';
import { visitorThenMember } from '@/lib/visitor/readActor';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardNotFoundError,
  InvalidBoardNameError,
  InvalidSwimlaneGroupByError,
} from '@/lib/boards/errors';
import { FilterValidationError } from '@/lib/filters/errors';
import { SavedFilterNotFoundError } from '@/lib/savedFilters/errors';
import { readBoardFilterInput } from '@/lib/boards/boardPageHttp';
import { boardGateErrorResponse } from '@/lib/boards/boardGateResponse';

// GET /api/board (Subtask 3.1.6) — the board projection for the ACTIVE project's
// default board: a BoardProjectionDto (columns in workflow order plus
// unmappedStatuses). On a flat board each column carries a bounded first page of
// cards + its count + a cursor; on a grouped board (MOTIR-11445) each column is
// meta + its full count only, and the cells load from the lane routes. Thin
// HTTP layer over boardsService.getBoard; session-required; the project +
// workspace come from the active-project context (NEVER the client). No db / no
// transaction here (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[key]/board): the app is single-
// active-project — the /boards and /items pages both resolve getActiveProject()
// and there is no project-by-key route tree to mirror. The project + workspace
// come from the active-project context (NEVER the client).
//
// Board SELECTION (Subtask 3.7.5): a `?boardId=` query param picks WHICH of the
// active project's boards to project; absent → the project's DEFAULT board (the
// pre-3.7 single-board behaviour, unchanged). The board page (`/boards`) carries
// its `?board=` selection here as `?boardId=`. The service tenant-gates the id
// to the active project/workspace (a stale / cross-project id → 404), so the
// param is safe to take from the client.
//
// Board FILTER (Story 6.15 · 6.15.2 read + 6.15.3 wiring): a `?filter=v1:` query
// param carries the COMPILED filter AST (the board page merges the toolbar's
// facets + advanced `?filter=` into one AST via `upgradeFacetsIntoAst`, then
// encodes it here). It's decoded with the SAME `decodeFilterParam` codec the
// /items navigator uses (one codec, two carriers) and threaded to
// `getBoard` as a `BoardFilterInput.ast`, which narrows every column + the
// cap/`truncated` count + swimlane lanes and composes with the Scrum sprint
// scope. A malformed/forged param decodes to `!ok` → treated as NO filter (the
// unfiltered projection — the page only ever emits a valid param, so this is the
// forged-URL degrade, mirroring the navigator's recoverable-state handling).
// `getBoard` re-validates the AST against the registry, so a structurally-valid
// but semantically-bad condition throws `FilterValidationError` → 422.
//
// The header filter REPLACES the board's own stored filter (MOTIR-11564), never
// ANDs with it: a `?filter=` param is the board's whole filter, and with none
// the stored filter applies. `?boardFilter=off` asks for the board's whole scope
// instead (the reader removed every condition on a board that has a stored
// filter); it is ignored beside a `?filter=` and on a board with none. Both
// params are read by `readBoardFilterInput`, the parse the page doors share.

async function memberGET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const params = new URL(req.url).searchParams;
  const boardId = params.get('boardId')?.trim() || undefined;

  // Decode the optional header filter + the stored-filter-off signal. A bad
  // decode → no header filter (the graceful degrade, not a 400): the page never
  // emits a malformed param, so this only guards a hand-forged URL, which then
  // reads as the board's own filter.
  const filter = readBoardFilterInput(params);

  try {
    const board = await boardsService.getBoard(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      boardId,
      filter,
    );
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // An inline filter AST that fails registry validation (6.1.1) → 422.
    if (err instanceof FilterValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // A saved-filter id that resolves to nothing/unauthorized (only reachable
    // via `BoardFilterInput.savedFilterId`, which this route does not currently
    // emit — mapped for the service's full contract) → 404.
    if (err instanceof SavedFilterNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}

/**
 * The board projection — for a VISITOR (MOTIR-6647), the board of the public
 * project the Visitor cookie names, with every private-epic descendant
 * withheld and names only (MOTIR-6644 / MOTIR-6646); an inline `?filter=` still
 * applies — replacing the board's stored filter as it does for a member
 * (MOTIR-11564) — and a saved filter never does. Everyone else is answered exactly as before.
 */
export async function GET(req: Request): Promise<Response> {
  return visitorThenMember(
    req,
    () => memberGET(req),
    async (ctx) => {
      const params = new URL(req.url).searchParams;
      const boardId = params.get('boardId')?.trim() || undefined;
      const filter = readBoardFilterInput(params);
      try {
        const board = await boardsService.getBoard(ctx.project.id, ctx, boardId, filter);
        return NextResponse.json(board);
      } catch (err) {
        if (err instanceof BoardNotFoundError || err instanceof ProjectNotFoundError) {
          return NextResponse.json(
            { code: 'BOARD_NOT_FOUND', error: 'Board not found.' },
            { status: 404 },
          );
        }
        if (err instanceof FilterValidationError) {
          return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
        }
        throw err;
      }
    },
  );
}

// PATCH /api/board — mutate one of the active project's board attributes. ONE
// attribute per request, routed to a single service method (one service call
// per happy-path branch, CLAUDE.md):
//   - { boardId, swimlaneGroupBy } → setSwimlaneGroupBy (Subtask 3.3.3)
//   - { boardId, name }            → renameBoard        (Subtask 3.6.2)
// Thin HTTP layer over boardsService; session-required; workspace from the
// active-project context (NEVER the client). `boardId` rides in the body — the
// same forward-compatible multi-board shape the move route uses (the client
// holds it from the GET projection). No db / no transaction here.
//
// Typed errors → status codes:
//   InvalidSwimlaneGroupByError / InvalidBoardNameError → 400
//   PermissionDeniedError (board:configure)                     → 403
//   ProjectNotFoundError (cannot browse the project)             → 404
//   BoardNotFoundError                                  → 404 (unknown board)

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { boardId, swimlaneGroupBy, name } = (body ?? {}) as Record<string, unknown>;
  if (typeof boardId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` is required.' },
      { status: 400 },
    );
  }
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    if (swimlaneGroupBy !== undefined) {
      if (typeof swimlaneGroupBy !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`swimlaneGroupBy` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.setSwimlaneGroupBy(boardId, swimlaneGroupBy, serviceCtx);
      return NextResponse.json(board);
    }

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`name` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.renameBoard(boardId, name, serviceCtx);
      return NextResponse.json(board);
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected one of `swimlaneGroupBy` or `name`.' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof InvalidSwimlaneGroupByError || err instanceof InvalidBoardNameError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    const gate = boardGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
