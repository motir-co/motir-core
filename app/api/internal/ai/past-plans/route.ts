import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { parsePastPlanQuery } from '@/lib/plans/pastPlans';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';

// GET /api/internal/ai/past-plans (MOTIR-10241) — SEARCH the job's OWN project's
// plans in every status, declined and abandoned included, each row carrying its
// `status` and `decisionReason`: how similar work was shaped before, and why a
// plan ended. Newest first, keyset-paged. A metadata read — no proposal content;
// `past-plan` reads one plan with its proposals.
//
// Query: `q` (substring of title or summary, ≤ 200), `status` (comma list of plan
// statuses), `cursor` (a previous `nextCursor`), `limit` (1–50, default 20).
//
// Service-to-service ONLY (the service bearer + the job token). The project is
// the TOKEN's; there is no caller-supplied project. Thin transport: authenticate,
// validate, ONE service call, map typed errors. A search that matched nothing is
// 200 `outcome: 'nothing-matched'`, never a 404.
//
//   JobAuthError         → 401
//   bad query            → 400 PAST_PLANS_QUERY_INVALID
//   ProjectNotFoundError → 404 (the token's user cannot browse it — never 403)
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const status = params.get('status');
  const parsed = parsePastPlanQuery({
    q: params.get('q'),
    status: status === null ? null : status.split(','),
    cursor: params.get('cursor'),
    limit: params.get('limit'),
  });
  if (!parsed.ok) {
    return NextResponse.json(
      { code: 'PAST_PLANS_QUERY_INVALID', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const result = await aiBoundaryService.searchPastPlans(
      auth.projectId,
      parsed.filters,
      auth.ctx,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
