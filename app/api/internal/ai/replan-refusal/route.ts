import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { NoPlanForJobError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { CommentForbiddenError, EmptyCommentBodyError } from '@/lib/comments/errors';
import {
  ReplanRefusalTooLateError,
  replanRefusalService,
} from '@/lib/services/replanRefusalService';

// POST /api/internal/ai/replan-refusal (MOTIR-10233) — the CAN'T-PLAN verdict of a
// run's re-plan. The question-free first session found the run's report cannot be
// planned; this comments on the run's card why (a reply under the run's own comment
// when it named one) and ends any grilling open on the plan. motir-ai then closes the
// plan with the ordinary final append, and an empty plan is discarded there.
//
// Auth: §4a service bearer + §4b job token, exactly as `log-bug`. The project is the
// TOKEN's; the body carries none. Thin transport: authenticate → validate the body →
// ONE service call → map typed errors.
//
//   JobAuthError                       → 401
//   REPLAN_REFUSAL_INVALID             → 400 (body shape)
//   NoPlanForJobError / not found      → 404 (no plan for this job in the token's project,
//                                             or a key outside it — 404-not-403)
//   ProjectAccessDeniedError           → 404 browse / 403 edit
//   CommentForbiddenError              → 403 (the token's user may not comment)
//   EmptyCommentBodyError              → 400
//   ReplanRefusalTooLateError          → 409 (the plan left `generating` or holds a proposal)

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('REPLAN_REFUSAL_INVALID', 'request body must be valid JSON', 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const { jobId, workItemKey, bodyMd, replyToCommentId } = b;
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail('REPLAN_REFUSAL_INVALID', '`jobId` is required.', 400);
  }
  if (typeof workItemKey !== 'string' || workItemKey.trim() === '') {
    return fail('REPLAN_REFUSAL_INVALID', '`workItemKey` is required.', 400);
  }
  if (typeof bodyMd !== 'string' || bodyMd.trim() === '') {
    return fail('REPLAN_REFUSAL_INVALID', '`bodyMd` is required.', 400);
  }
  if (replyToCommentId != null && typeof replyToCommentId !== 'string') {
    return fail('REPLAN_REFUSAL_INVALID', '`replyToCommentId` must be a string.', 400);
  }

  try {
    const result = await replanRefusalService.recordRefusal(
      {
        jobId,
        workItemKey,
        bodyMd,
        replyToCommentId:
          typeof replyToCommentId === 'string' && replyToCommentId.trim() !== ''
            ? replyToCommentId.trim()
            : null,
      },
      auth,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (
      err instanceof NoPlanForJobError ||
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectNotFoundError
    ) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    if (err instanceof CommentForbiddenError) return fail(err.code, err.message, 403);
    if (err instanceof EmptyCommentBodyError) return fail(err.code, err.message, 400);
    if (err instanceof ReplanRefusalTooLateError) return fail(err.code, err.message, 409);
    throw err;
  }
}
