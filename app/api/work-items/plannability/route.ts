import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { plannabilityService } from '@/lib/services/plannabilityService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/plannability?key=<identifier> (MOTIR-10544; design
// MOTIR-10543) — can this card be planned? The roadmap canvas card's Plan button
// asks before it opens the planning overlay, and opens the can't-plan alert
// instead when the answer carries reasons.
//
// The twin of `app/api/work-items/planning-anchor/route.ts`, the other read a
// work-item launch of the planning workspace makes: resolved against the actor's
// ACTIVE project (the overlay is that project's), the 2FA hold after the
// no-project arm, ONE service call, and the no-existence-leak 404 for a key the
// actor cannot see. A browser without `ai:plan` is the plan-change doors' own
// 403 `PERMISSION_DENIED`.
//
// Thin HTTP over `plannabilityService.checkPlannable`. No `db` here.

export async function GET(req: Request): Promise<Response> {
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const key = new URL(req.url).searchParams.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '`key` is required.' }, { status: 400 });
  }

  try {
    const answer = await plannabilityService.checkPlannable(ctx.projectId, key, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // Live state read at click time: never serve a cached answer.
    return NextResponse.json(answer, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json(
        { code: 'NOT_FOUND', error: 'Work item not available.' },
        { status: 404 },
      );
    }
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message, permission: err.permission },
        { status: 403 },
      );
    }
    /* v8 ignore next -- the RE-THROW: every class the one service call raises is
       answered above, so only a real fault (a dropped connection, a bug) gets
       here, and it belongs to Next's error boundary rather than to a 404. */
    throw err;
  }
}
