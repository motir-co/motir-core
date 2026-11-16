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

// GET /api/board/lanes/[laneKey]/cells?boardId=&filter= (MOTIR-11446) — ONE
// swimlane's FIRST page in every column of the board, in one request: what a
// lane coming into view loads. Thin HTTP layer over `boardsService.getLanePage`;
// the project + workspace come from the active-project context (NEVER the
// client), exactly as `GET /api/board`.
//
//   - `[laneKey]` — the lane, as the projection's `swimlanes[].key` names it (the
//     catch-all sentinel and priority values included), passed through unparsed:
//     whether the board's group-by can hold it is the service's question.
//   - `boardId` (required) and `filter` (optional) — as on the column page.
//
// No cursor: a lane page is first pages only. Every later page of a cell is
// `GET /api/board/columns/[columnId]/cards?lane=&cursor=`.
//
// A VISITOR pages the public project's board with the same private-epic
// exclusion the projection applies.
//
// Typed errors → status codes (`lib/boards/boardPageHttp.ts`, shared with the
// column route):
//   a missing `boardId`                                               → 400 BAD_REQUEST
//   InvalidBoardLaneError                                             → 400
//   BoardNotFoundError / ProjectNotFoundError                         → 404
//   FilterValidationError                                             → 422

async function readLane(
  req: Request,
  projectId: string,
  ctx: ServiceContext | VisitorReadContext,
  laneKey: string,
): Promise<Response> {
  const { boardId, filter } = readBoardPageParams(req);
  if (!boardId) return badRequest('`boardId` is required.');
  try {
    const page = await boardsService.getLanePage(projectId, ctx, boardId, laneKey, filter);
    return NextResponse.json(page);
  } catch (err) {
    const mapped = boardPageErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

async function memberGET(req: Request, laneKey: string): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }
  return readLane(
    req,
    ctx.projectId,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    laneKey,
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ laneKey: string }> },
): Promise<Response> {
  const { laneKey } = await params;
  return visitorThenMember(
    req,
    () => memberGET(req, laneKey),
    (ctx) => readLane(req, ctx.project.id, ctx, laneKey),
  );
}
