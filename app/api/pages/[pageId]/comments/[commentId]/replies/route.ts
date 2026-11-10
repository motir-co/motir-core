import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';
import { noActiveProject, parseBodyOnly } from '@/lib/pages/commentRouteInput';
import { getActiveProject } from '@/lib/projects';
import { pageCommentsService } from '@/lib/services/pageCommentsService';

// POST /api/pages/[pageId]/comments/[commentId]/replies (Story MOTIR-10866 ·
// MOTIR-10873) — reply to a thread. `commentId` must be the thread's root: a
// reply to a reply is 422 `PAGE_COMMENT_REPLY_DEPTH_EXCEEDED`.

type Params = { params: Promise<{ pageId: string; commentId: string }> };

/** 201 with the reply. */
export async function POST(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, commentId } = await params;

  const parsed = await parseBodyOnly(req);
  if (!parsed.ok) return parsed.response;

  try {
    const reply = await pageCommentsService.postPageReply(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, parentCommentId: commentId, bodyMd: parsed.value.bodyMd },
    );
    return NextResponse.json(reply, { status: 201 });
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}
