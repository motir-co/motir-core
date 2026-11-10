import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';
import { noActiveProject } from '@/lib/pages/commentRouteInput';
import { getActiveProject } from '@/lib/projects';
import { pageCommentsService } from '@/lib/services/pageCommentsService';

// POST / DELETE /api/pages/[pageId]/comments/[commentId]/resolution (Story
// MOTIR-10866 · MOTIR-10873) — resolve a thread (POST) or reopen it (DELETE),
// the archive route's verb pair. On a reply either is 422
// `PAGE_COMMENT_NOT_ROOT`; on a thread already in that state it answers the
// thread unchanged.

type Params = { params: Promise<{ pageId: string; commentId: string }> };

async function act(kind: 'resolve' | 'reopen', { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, commentId } = await params;

  try {
    const service = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    const input = { projectId: ctx.projectId, pageId, commentId };
    const thread =
      kind === 'resolve'
        ? await pageCommentsService.resolvePageThread(service, input)
        : await pageCommentsService.reopenPageThread(service, input);
    return NextResponse.json(thread);
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}

/** Resolve — answers the thread. */
export async function POST(_req: Request, params: Params): Promise<Response> {
  return act('resolve', params);
}

/** Reopen — answers the thread. */
export async function DELETE(_req: Request, params: Params): Promise<Response> {
  return act('reopen', params);
}
