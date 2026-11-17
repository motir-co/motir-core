import { NextResponse } from 'next/server';
import { visitorThenMember } from '@/lib/visitor/readActor';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  badRequest,
  boardPageErrorResponse,
  readBoardPageParams,
} from '@/lib/boards/boardPageHttp';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';

// GET /api/board/columns/[columnId]/cards?boardId=&cursor=&lane=&filter=
// (MOTIR-10535, MOTIR-11446) — a page of one board column. Thin HTTP layer over
// `boardsService`; the project + workspace come from the active-project context
// (NEVER the client), exactly as `GET /api/board`.
//
//   - `boardId` (required) — the board the column belongs to, tenant-gated to the
//     active project by the service like the projection's `?boardId=`.
//   - `lane`    (optional) — ONE swimlane of a grouped board, as the projection's
//     `swimlanes[].key` names it (the catch-all sentinel and priority values
//     included, passed through unparsed). Present → that (lane × column) CELL's
//     page from `getCellPage`, a `BoardCellPageDto`. Absent → the column's own
//     next page from `getColumnPage`, a `BoardColumnPageDto`, byte for byte the
//     flat board's door.
//   - `cursor`  — the page's own `cursor` from the projection, the lane page or
//     the previous page. REQUIRED without `lane`; optional with it, where absent
//     asks for the cell's FIRST page (a cell that never loaded). A cursor that
//     column did not mint → 400.
//   - `filter`  (optional) — the SAME `?filter=v1:` param the projection was
//     read with; a bad decode degrades to no filter, as on the projection.
//
// A VISITOR (MOTIR-6647) pages the public project's board with the same
// private-epic exclusion the projection applies.
//
// Typed errors → status codes (`lib/boards/boardPageHttp.ts`, shared with the
// lane route):
//   a missing `boardId`, or `cursor` without `lane`                   → 400 BAD_REQUEST
//   InvalidBoardCursorError / InvalidBoardLaneError                   → 400
//   BoardNotFoundError / BoardColumnNotFoundError / ProjectNotFoundError → 404
//   FilterValidationError                                             → 422

async function readPage(
  req: Request,
  projectId: string,
  ctx: ServiceContext | VisitorReadContext,
  columnId: string,
): Promise<Response> {
  const { boardId, filter, params } = readBoardPageParams(req);
  const lane = params.get('lane') ?? undefined;
  const cursor = params.get('cursor')?.trim() || undefined;
  if (!boardId || (lane === undefined && !cursor)) {
    return badRequest('`boardId` and `cursor` are required.');
  }
  try {
    const page =
      lane === undefined
        ? await boardsService.getColumnPage(projectId, ctx, boardId, columnId, cursor!, filter)
        : await boardsService.getCellPage(projectId, ctx, boardId, columnId, lane, cursor, filter);
    return NextResponse.json(page);
  } catch (err) {
    const mapped = boardPageErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
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
  return readPage(
    req,
    ctx.projectId,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    columnId,
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ columnId: string }> },
): Promise<Response> {
  const { columnId } = await params;
  return visitorThenMember(
    req,
    () => memberGET(req, columnId),
    (ctx) => readPage(req, ctx.project.id, ctx, columnId),
  );
}
