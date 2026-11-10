import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';
import { noActiveProject, parseBodyOnly } from '@/lib/pages/commentRouteInput';
import { getActiveProject } from '@/lib/projects';
import { pageCommentsService } from '@/lib/services/pageCommentsService';

// PATCH / DELETE /api/pages/[pageId]/comments/[commentId] (Story MOTIR-10866 ·
// MOTIR-10873) — edit a comment's body, or delete it (a root takes its replies).
// The author, or a holder of `comment:moderate`; the package decides which.

type Params = { params: Promise<{ pageId: string; commentId: string }> };

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, commentId } = await params;

  const parsed = await parseBodyOnly(req);
  if (!parsed.ok) return parsed.response;

  try {
    const comment = await pageCommentsService.editPageCommentBody(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, commentId, bodyMd: parsed.value.bodyMd },
    );
    return NextResponse.json(comment);
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}

/** Answers `{ commentId, parentCommentId, replyCount }`. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, commentId } = await params;

  try {
    const result = await pageCommentsService.removePageComment(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, commentId },
    );
    return NextResponse.json(result);
  } catch (err) {
    return pageCommentErrorResponse(err);
  }
}
