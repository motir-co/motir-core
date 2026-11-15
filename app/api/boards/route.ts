import { NextResponse } from 'next/server';
import { visitorThenMember } from '@/lib/visitor/readActor';
import { visitorServiceContext } from '@/lib/visitor/context';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidBoardNameError, InvalidBoardTypeError } from '@/lib/boards/errors';
import { boardGateErrorResponse } from '@/lib/boards/boardGateResponse';
import { FilterValidationError } from '@/lib/filters/errors';

// /api/boards (Subtask 3.7.3) — the multi-board CRUD collection for the ACTIVE
// project (the board lifecycle: list + create; per-board rename/set-default/
// delete live under /api/boards/[id]). Thin HTTP layer over boardsService;
// session-required; the project + workspace come from the active-project
// context (NEVER the client), like /api/board. No db / no transaction here
// (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[key]/boards): the app is single-
// active-project — /boards resolves getActiveProject() and there is no
// project-by-key route tree to mirror (same rationale as /api/board).

// GET /api/boards — the active project's boards as switcher rows
// (BoardSummaryDto[], ordered by position). Any member may read (the switcher
// is not a config write); the workspace gate is the active-project context.
async function memberGET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const boards = await boardsService.listBoards(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return NextResponse.json({ boards });
}

/**
 * The project's boards — for a VISITOR (MOTIR-6647), the boards of the public
 * project the Visitor cookie names, read on the Visitor's narrowed service
 * context (a board's name and type are not private); for everyone else exactly
 * as before.
 */
export async function GET(req?: Request): Promise<Response> {
  if (!req) return memberGET();
  return visitorThenMember(req, memberGET, async (ctx) => {
    const boards = await boardsService.listBoards(ctx.project.id, visitorServiceContext(ctx));
    return NextResponse.json({ boards });
  });
}

// POST /api/boards — create a board on the active project (seeds default
// columns off the workflow; non-default). Body: { name, type?, filter? } (type
// defaults to kanban; `filter` is the board's optional stored filter, a
// `FilterEnvelope` `{ v, c, f }` — MOTIR-10560). Returns 201 with the new
// board's switcher DTO.
//
// Typed errors → status codes:
//   InvalidBoardNameError / InvalidBoardTypeError → 400
//   FilterValidationError (stored filter refused; no board created) → 422
//     `{ code, error, conditionIndex? }` — the 0-based refused condition
//   PermissionDeniedError (board:configure)                     → 403
//   ProjectNotFoundError (cannot browse the project)             → 404
//   ProjectNotFoundError                          → 404
export async function POST(req: Request): Promise<Response> {
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

  const { name, type, filter } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` is required.' },
      { status: 400 },
    );
  }
  if (type !== undefined && typeof type !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`type` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const board = await boardsService.createBoard(
      ctx.projectId,
      { name, type, filter },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(board, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidBoardNameError || err instanceof InvalidBoardTypeError) {
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
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
