import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { BoardNotFoundError, InvalidBoardNameError, LastBoardError } from '@/lib/boards/errors';
import { boardGateErrorResponse } from '@/lib/boards/boardGateResponse';
import { FilterValidationError } from '@/lib/filters/errors';

// /api/boards/[id] (Subtask 3.7.3) — per-board lifecycle mutations:
//   PATCH  { name }            → renameBoard      (3.6.2, reused)
//   PATCH  { isDefault: true } → setDefaultBoard
//   PATCH  { filter }          → setBoardFilter   (MOTIR-10560; `null` clears)
//   DELETE                     → deleteBoard      (guards: last-board, promote-default)
// Thin HTTP layer over boardsService; session-required; workspace from the
// active-project context (NEVER the client). The board id is the path param;
// the service tenant-gates it (a board outside the active workspace is a 404).
// No db / no transaction here (CLAUDE.md).

// PATCH /api/boards/[id] — ONE attribute per request, routed to a single
// service method (one service call per happy-path branch):
//   { name }            → renameBoard
//   { isDefault: true } → setDefaultBoard
//   { filter }          → setBoardFilter — the board's stored filter, a
//                         `FilterEnvelope` `{ v, c, f }`; a PRESENT `null`
//                         clears it (detected with `'filter' in body`, so an
//                         absent key never reaches this branch)
//
// Typed errors → status codes:
//   InvalidBoardNameError → 400
//   FilterValidationError (stored filter refused; unchanged) → 422
//     `{ code, error, conditionIndex? }` — the 0-based refused condition
//   PermissionDeniedError (board:configure)                     → 403
//   ProjectNotFoundError (cannot browse the project)             → 404
//   BoardNotFoundError    → 404
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const fields = (body ?? {}) as Record<string, unknown>;
  const { name, isDefault } = fields;
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`name` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.renameBoard(id, name, serviceCtx);
      return NextResponse.json(board);
    }

    if (isDefault !== undefined) {
      if (isDefault !== true) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`isDefault` may only be set to true (promote a board).' },
          { status: 400 },
        );
      }
      const board = await boardsService.setDefaultBoard(id, serviceCtx);
      return NextResponse.json(board);
    }

    if (typeof fields === 'object' && 'filter' in fields) {
      const board = await boardsService.setBoardFilter(id, fields.filter, serviceCtx);
      return NextResponse.json(board);
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected one of `name`, `isDefault` or `filter`.' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof InvalidBoardNameError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof FilterValidationError) {
      // `conditionIndex` (0-based) names the refused condition when the write
      // located it, so the UI can say "Condition n".
      return NextResponse.json(
        {
          code: err.code,
          error: err.message,
          ...(err.conditionIndex !== undefined ? { conditionIndex: err.conditionIndex } : {}),
        },
        { status: 422 },
      );
    }
    const gate = boardGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}

// DELETE /api/boards/[id] — delete a board (its issues survive on the project).
// Returns 204 on success.
//
// Typed errors → status codes:
//   PermissionDeniedError (board:configure)                     → 403
//   ProjectNotFoundError (cannot browse the project)             → 404
//   BoardNotFoundError → 404
//   LastBoardError     → 409 (a project must keep at least one board)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const { id } = await params;

  try {
    await boardsService.deleteBoard(id, { userId: ctx.userId, workspaceId: ctx.workspaceId });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const gate = boardGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof LastBoardError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
