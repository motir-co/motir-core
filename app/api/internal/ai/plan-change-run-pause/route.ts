import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { mapPlanChangeError } from '@/app/api/ai/plan-change/_errors';
import { planChangeRunPauseService } from '@/lib/services/planChangeRunPauseService';

// POST /api/internal/ai/plan-change-run-pause
//   { jobId, kind, changeTurnIds, reason?, question?, repos?, idempotencyKey }
// (Story MOTIR-7990 · MOTIR-8007) — the RUNNING planning job records ONE open
// PAUSE for its conversation: `kind: 'replan'` (a START OVER offer, with a one-line
// `reason`), `kind: 'unclear'` (a question) or `kind: 'code_unsearchable'` (a target
// repository's code cannot be searched; `repos` names each one and why, MOTIR-9167). The walk is paused while its job keeps
// running; the person's answer rides the shipped mailbox back (`planChangeRunPauseService`).
//
// Answers `{ outcome: 'recorded' | 'already_open', pause }`: the same key again is
// `recorded` with the same pause; a different key while a pause is open is
// `already_open` with the existing one. Refusals write no row: a terminal job → 409
// `PLAN_CHANGE_JOB_NOT_RUNNING`, a decided plan → 409, a change turn from another
// session or job → 409, a kind without its own text → 400.
//
// Service-to-service ONLY: the §4a service bearer + the §4b job token, exactly as
// the sibling `plan-change-mailbox` route. HTTP only: parse, ONE service call, map
// typed errors.
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
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bag = (body ?? {}) as Record<string, unknown>;
  const jobId = bag['jobId'];
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'JOB_ID_REQUIRED', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  const kind = bag['kind'];
  if (kind !== 'replan' && kind !== 'unclear' && kind !== 'code_unsearchable') {
    return NextResponse.json(
      {
        code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
        error: '`kind` must be `replan`, `unclear` or `code_unsearchable`.',
      },
      { status: 400 },
    );
  }
  const rawIds = bag['changeTurnIds'];
  if (!Array.isArray(rawIds) || !rawIds.every((i) => typeof i === 'string')) {
    return NextResponse.json(
      {
        code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
        error: '`changeTurnIds` must be an array of mailbox entry ids.',
      },
      { status: 400 },
    );
  }
  const idempotencyKey = bag['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`idempotencyKey` is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeRunPauseService.recordPause(
      {
        jobId,
        kind,
        changeTurnIds: rawIds as string[],
        reason: typeof bag['reason'] === 'string' ? bag['reason'] : null,
        question: typeof bag['question'] === 'string' ? bag['question'] : null,
        repos: bag['repos'],
        // The `unclear` question's options (MOTIR-11700) — checked by the service.
        options: bag['options'],
        idempotencyKey,
      },
      { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId, projectId: auth.projectId },
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    // `mapPlanChangeError` already answers a `MotirAiError` (502) and an out-of-credits
    // one (402), so no branch of its own is needed here.
    if (mapped) return mapped;
    throw err;
  }
}
