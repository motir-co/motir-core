import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';
import { badRequest, noActiveProject, parseCreateBody } from '@/lib/pages/commentRouteInput';
import { badIntegerResponse, parsePositiveInt } from '@/lib/pages/routeErrors';
import { getActiveProject } from '@/lib/projects';
import { pageCommentsService } from '@/lib/services/pageCommentsService';

// GET / POST /api/pages/[pageId]/comments (Story MOTIR-10866 · MOTIR-10873) —
// a page's discussion. GET lists one page of its open (default) or resolved
// threads, each with every reply, plus both counts and the caller's
// `capabilities`; `order` (`asc` | `desc`) runs the list either way along its
// key. POST starts a thread, page-level or, with `anchor: { bytes, quote }`
// (bytes as base64), inline. The project comes from the active-project context.

type Params = { params: Promise<{ pageId: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  const query = new URL(req.url).searchParams;
  const status = query.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved') {
    return badRequest('Expected `status` to be `open` or `resolved`.');
  }
  const order = query.get('order');
  if (order !== null && order !== 'asc' && order !== 'desc') {
    return badRequest('Expected `order` to be `asc` or `desc`.');
  }
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? undefined : parsePositiveInt(rawLimit);
  if (limit === null) return badIntegerResponse('limit');

  try {
    const page = await pageCommentsService.listPageThreads(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      {
        projectId: ctx.projectId,
        pageId,
        status,
        order: order ?? undefined,
        cursor: query.get('cursor'),
        limit,
      },
    );
    return NextResponse.json(page);
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}

/** Start a thread — 201 with the new thread (no replies, open). */
export async function POST(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  const parsed = await parseCreateBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const thread = await pageCommentsService.postPageComment(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, ...parsed.value },
    );
    return NextResponse.json(thread, { status: 201 });
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}
