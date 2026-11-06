import { NextResponse } from 'next/server';
import { visitorThenMember } from '@/lib/visitor/readActor';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  InvalidBoardCursorError,
} from '@/lib/boards/errors';
import { decodeFilterParam } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';
import type { BoardFilterInput } from '@/lib/dto/boards';

// GET /api/board/columns/[columnId]/cards?boardId=&cursor=&filter= (MOTIR-10535)
// — the NEXT PAGE of one board lane: what the board fetches when the user
// scrolls a lane to its bottom. Thin HTTP layer over
// `boardsService.getColumnPage`; the project + workspace come from the
// active-project context (NEVER the client), exactly as `GET /api/board`.
//
//   - `boardId` (required) — the board the lane belongs to, tenant-gated to the
//     active project by the service like the projection's `?boardId=`.
//   - `cursor`  (required) — the lane's `cursor` from the projection or the
//     previous page. A cursor this lane did not mint → 400.
//   - `filter`  (optional) — the SAME `?filter=v1:` param the projection was
//     read with, so a page never holds a card the filtered lane would not; a bad
//     decode degrades to no filter, as on the projection.
//
// A VISITOR (MOTIR-6647) pages the public project's board with the same
// private-epic exclusion the projection applies.
//
// Typed errors → status codes:
//   InvalidBoardCursorError / a missing `boardId` or `cursor`  → 400
//   BoardNotFoundError / BoardColumnNotFoundError / ProjectNotFoundError → 404
//   FilterValidationError                                       → 422

type PageParams = { boardId: string; cursor: string; filter: BoardFilterInput | undefined };

/** Read the page query, or answer the 400 a missing required param owes. */
function readPageParams(req: Request): PageParams | Response {
  const params = new URL(req.url).searchParams;
  const boardId = params.get('boardId')?.trim();
  const cursor = params.get('cursor')?.trim();
  if (!boardId || !cursor) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` and `cursor` are required.' },
      { status: 400 },
    );
  }
  const rawFilter = params.get('filter')?.trim() || undefined;
  let filter: BoardFilterInput | undefined;
  if (rawFilter) {
    const decoded = decodeFilterParam(rawFilter);
    if (decoded.ok && decoded.ast.conditions.length > 0) filter = { ast: decoded.ast };
  }
  return { boardId, cursor, filter };
}

/** The typed refusals of a page read, as the status each owes; null = not ours. */
function pageErrorResponse(err: unknown): Response | null {
  if (err instanceof InvalidBoardCursorError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof BoardNotFoundError || err instanceof BoardColumnNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json(
      { code: 'BOARD_NOT_FOUND', error: 'Board not found.' },
      { status: 404 },
    );
  }
  if (err instanceof FilterValidationError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}

async function memberGET(req: Request, columnId: string): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }
  const read = readPageParams(req);
  if (read instanceof Response) return read;

  try {
    const page = await boardsService.getColumnPage(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      read.boardId,
      columnId,
      read.cursor,
      read.filter,
    );
    return NextResponse.json(page);
  } catch (err) {
    const mapped = pageErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ columnId: string }> },
): Promise<Response> {
  const { columnId } = await params;
  return visitorThenMember(
    req,
    () => memberGET(req, columnId),
    async (ctx) => {
      const read = readPageParams(req);
      if (read instanceof Response) return read;
      try {
        const page = await boardsService.getColumnPage(
          ctx.project.id,
          ctx,
          read.boardId,
          columnId,
          read.cursor,
          read.filter,
        );
        return NextResponse.json(page);
      } catch (err) {
        const mapped = pageErrorResponse(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );
}
