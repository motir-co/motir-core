import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/internal/ai/get-subtree?rootKey=MOTIR-806[&depth=2][&jobId=…]  (Subtask 7.5.1)
//
// `jobId` (MOTIR-11340) — a PLANNING read: each committed row that job's own
// undecided plan modifies or removes carries `planProposal` (`{ planItemId, op,
// approved: false, committedTitle? }`), and its `title` / `kind` / `obsolescence`
// are the plan's. The plan is found by `sourceJobId` in the token's workspace, as
// `plan-proposals` finds it; with no jobId, or no plan for it, the rows are as stored.
//
// A root (epic/story, by key) + its descendants bounded by `depth` DESCENDANT
// levels — a bounded-neighborhood push (Epic-7 Principle #2), NEVER a whole-tree
// read: an absent / oversized `depth` is CLAMPED in the service (finding #57).
// Each node is the same cheap skeleton row `skeleton`/`plan-tree` returns.
// Service-to-service ONLY; the root is resolved AS the token's user within the
// token's project, so a cross-tenant / cross-project rootKey is a 404.
//
// Typed errors → status:
//   JobAuthError                       → 401
//   WorkItemNotFoundError              → 404 (absent / cross-tenant root)
//   ProjectNotFoundError               → 404 (project not in the token's tenant)
//   ProjectAccessDeniedError('browse') → 404
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const url = new URL(req.url);
  const rootKey = url.searchParams.get('rootKey');
  if (!rootKey) {
    return NextResponse.json(
      { code: 'ROOT_KEY_REQUIRED', error: '`rootKey` is required.' },
      { status: 400 },
    );
  }
  const depthParam = url.searchParams.get('depth');
  const depth = depthParam !== null ? Number(depthParam) : undefined;

  try {
    const jobId = url.searchParams.get('jobId') || undefined;
    const result = await aiBoundaryService.getSubtree(
      auth.projectId,
      rootKey,
      depth,
      auth.ctx,
      jobId,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
