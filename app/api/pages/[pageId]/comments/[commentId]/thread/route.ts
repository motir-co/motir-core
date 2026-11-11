import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';
import { noActiveProject } from '@/lib/pages/commentRouteInput';
import { getActiveProject } from '@/lib/projects';
import { pageCommentsService } from '@/lib/services/pageCommentsService';

// GET /api/pages/[pageId]/comments/[commentId]/thread (Story MOTIR-10867 ·
// MOTIR-10906) — one thread by a comment's id, wherever it sits in either list:
// the read a `/pages/<pageId>?thread=<rootCommentId>` link resolves against. A
// reply's id answers the thread it sits in. 200 with the thread and its
// `workItemRefs`; 404 `PAGE_COMMENT_NOT_FOUND` when the page holds no such
// comment, and the list's own `PAGE_NOT_FOUND` for a page that is not the
// caller's. A viewer reads it: reading a discussion needs no `comment:add`.

type Params = { params: Promise<{ pageId: string; commentId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, commentId } = await params;

  try {
    const thread = await pageCommentsService.readPageThread(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, commentId },
    );
    return NextResponse.json(thread);
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}
