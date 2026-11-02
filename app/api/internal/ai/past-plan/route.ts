import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';

// GET /api/internal/ai/past-plan?planId= (MOTIR-10241) — ONE plan of the job's
// OWN project with its proposals, as `getPlanForReader` returns it. A plan that
// does not exist, belongs to another project, or to another workspace — or one
// the token's user may not read — is ONE answer: 404 `PLAN_NOT_FOUND`.
//
// Service-to-service ONLY. The project is the TOKEN's. Thin transport.
//
//   JobAuthError      → 401
//   no `planId`       → 400 PAST_PLAN_ID_REQUIRED
//   PlanNotFoundError → 404 PLAN_NOT_FOUND
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const planId = new URL(req.url).searchParams.get('planId')?.trim() ?? '';
  if (planId === '') {
    return NextResponse.json(
      { code: 'PAST_PLAN_ID_REQUIRED', error: '`planId` is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await aiBoundaryService.readPastPlan(auth.projectId, planId, auth.ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
