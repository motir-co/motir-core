import { orgFeatureDisabledResponse } from '@/lib/featureFlags/errorResponse';
import { NextResponse } from 'next/server';

import {
  AskAnchorNotAvailableError,
  DebugAnchorNotTriageBugError,
  DebugTargetChangedError,
  DebugTargetNotAvailableError,
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  GuideCardClosedError,
  GuideCardNotManualError,
  GuideSessionNotPlannableError,
  NotSessionOwnerError,
  PlanNotResumableError,
  PlanSessionAwaitingResumeError,
  ResumeAlreadyStartedError,
  SessionNotFailedError,
  GuideTurnFilesRefusedError,
  InvalidPlanSessionCursorError,
  PlanChangeJobNotRunningError,
  PlanChangeFlipNotOfferedError,
  PlanChangeMailboxJobMismatchError,
  PlanChangeRunPauseAnsweredError,
  PlanChangeRunPauseNotFoundError,
  PlanChangeRunPausePlanDecidedError,
  PlanChangeRunPauseShapeError,
  GuideReplanOfferAlreadyConfirmedError,
  GuideReplanOfferNotFoundError,
  GuideReplanOfferNotOpenError,
  PlanOfferNotFoundError,
  PlanOfferNotOpenError,
  PlanOfferStartRefusedError,
  PlanChangeRunPauseTurnMismatchError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanChangeTurnNotFoundError,
  PlanSessionEndedError,
  PlanSessionNotCopyableError,
  PlanSessionNotFoundError,
  PlanAgainNotAvailableError,
  PlanSessionPlanDecidedError,
  PlanSessionPlanStaleError,
  PlanTargetLockedError,
  TurnFilesGuideOnlyError,
} from '@/lib/planChange/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { PlanNotEditableError, PlanRevisionInFlightError } from '@/lib/plans/errors';
import { InvalidAuthoredBugError } from '@/lib/ai/authoredBug';
import { InvalidGuideTurnError } from '@/lib/ai/guideWorkItem';

// Shared typed-error → HTTP mapping for the plan-change conversation routes
// (Story 7.30 · MOTIR-1728). Returns null for an unrecognized error so the route
// can rethrow (a 500). Kept out of the route files so open / append / submit map
// identically.
export function mapPlanChangeError(err: unknown): NextResponse | null {
  const switchedOff = orgFeatureDisabledResponse(err);
  if (switchedOff) return switchedOff;
  // A mailbox turn addressed at a job this thread is not on joins the 404s
  // (MOTIR-4067): from the caller's side that job simply is not on their
  // conversation, and telling "no such thread" apart from "not that run" would
  // answer a question about somebody else's job.
  if (
    err instanceof PlanChangeSessionNotFoundError ||
    // A session addressed BY ID that is not this project's (MOTIR-6023): 404,
    // the same no-existence-leak answer as a missing thread.
    err instanceof PlanSessionNotFoundError ||
    err instanceof PlanChangeTurnNotFoundError ||
    err instanceof GuideReplanOfferNotFoundError ||
    err instanceof PlanOfferNotFoundError ||
    err instanceof PlanChangeMailboxJobMismatchError ||
    err instanceof PlanChangeRunPauseNotFoundError ||
    err instanceof AskAnchorNotAvailableError ||
    err instanceof DebugTargetNotAvailableError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  // The retired flip into a planning run (AMENDMENT 3): nothing was written.
  if (err instanceof PlanChangeFlipNotOfferedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  // The planner's mid-run pause (MOTIR-8007): a malformed record or answer is a 400;
  // a double answer carries the stored one; a decided plan or a foreign change turn
  // is a conflict with the current state.
  if (err instanceof PlanChangeRunPauseShapeError) {
    return NextResponse.json(
      { code: err.code, error: err.message, reason: err.reason },
      { status: 400 },
    );
  }
  if (err instanceof PlanChangeRunPauseAnsweredError) {
    return NextResponse.json(
      { code: err.code, error: err.message, pauseId: err.pauseId, answer: err.answer },
      { status: 409 },
    );
  }
  if (err instanceof PlanChangeRunPausePlanDecidedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, planId: err.planId, planStatus: err.planStatus },
      { status: 409 },
    );
  }
  if (err instanceof GuideReplanOfferAlreadyConfirmedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, sessionId: err.sessionId },
      { status: 409 },
    );
  }
  // The plan offer (MOTIR-9290 · MOTIR-9291): a decision on an offer that is no
  // longer open, and a start refused before anything was written, each with why.
  if (err instanceof PlanOfferNotOpenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof PlanOfferStartRefusedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof GuideReplanOfferNotOpenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof PlanChangeRunPauseTurnMismatchError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof EmptyPlanChangeTurnError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  // The History list's cursor (MOTIR-9306) is opaque: one this read did not mint
  // is a malformed request, never an empty page.
  if (err instanceof InvalidPlanSessionCursorError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  // Files on a turn (MOTIR-7484; `guide-turn-files.md` A3.2): files on a
  // conversation that is not a guide, or files that are not the guided card's,
  // refuse the WHOLE turn before anything is written — a malformed request.
  if (err instanceof TurnFilesGuideOnlyError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof GuideTurnFilesRefusedError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        reason: err.reason,
        ...(err.attachmentId ? { attachmentId: err.attachmentId } : {}),
      },
      { status: 400 },
    );
  }
  // A lost append race and a submit with nothing to send are both conflicts with
  // the thread's current state, not malformed requests.
  // A turn on an ENDED session (AMENDMENT 23 §3): the session exists and is finished.
  if (err instanceof PlanSessionEndedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, sessionId: err.sessionId },
      { status: 409 },
    );
  }
  // A copy of a session that is still open or ended by a decision or a restart.
  if (err instanceof PlanSessionNotCopyableError) {
    return NextResponse.json(
      { code: err.code, error: err.message, sessionId: err.sessionId, endReason: err.endReason },
      { status: 409 },
    );
  }
  // A carry whose waiting plan was decided while the person typed (MOTIR-7930).
  if (err instanceof PlanSessionPlanDecidedError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        sessionId: err.sessionId,
        planId: err.planId,
        planStatus: err.planStatus,
      },
      { status: 409 },
    );
  }
  // A turn over a waiting plan (MOTIR-7945). The stale outcome is a RESULT the
  // overlay words — never shown raw — naming the finished cards.
  if (err instanceof PlanSessionPlanStaleError) {
    return NextResponse.json(
      { code: err.code, error: err.message, planId: err.planId, finishedCards: err.finishedCards },
      { status: 409 },
    );
  }
  if (err instanceof PlanAgainNotAvailableError) {
    return NextResponse.json(
      { code: err.code, error: err.message, reason: err.reason, latestPlanId: err.latestPlanId },
      { status: 409 },
    );
  }
  // A revise that lost its plan to another revision, or to a decision.
  if (err instanceof PlanRevisionInFlightError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        heldBy: err.heldBy,
        expiresAt: err.expiresAt.toISOString(),
      },
      { status: 409 },
    );
  }
  if (err instanceof PlanNotEditableError) {
    return NextResponse.json(
      { code: err.code, error: err.message, status: err.status },
      { status: 409 },
    );
  }
  if (err instanceof PlanChangeTurnConflictError || err instanceof EmptyPlanChangeIntentError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // A debug landing refused before anything was written (MOTIR-7049): the card
  // was edited underneath the write (409, retryable — the claim was released), or
  // a `diagnose` was anchored on a card that is not a triage bug (422).
  if (err instanceof DebugTargetChangedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // A guide turn refused by the card's own state (MOTIR-7464; ADR AMENDMENT 2,
  // A2.7): a card that is not manual is the wrong KIND of target (422); a card
  // already finished or archived is a conflict with its state (409).
  if (err instanceof GuideCardNotManualError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  if (err instanceof GuideSessionNotPlannableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // RESUMING A FAILED PLANNING SESSION (Story MOTIR-7905 · MOTIR-7916).
  if (err instanceof NotSessionOwnerError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof ResumeAlreadyStartedError) {
    // The winner's job id, so a double-click streams the one attempt that is running.
    return NextResponse.json(
      { code: err.code, error: err.message, jobId: err.jobId },
      { status: 409 },
    );
  }
  if (err instanceof PlanSessionAwaitingResumeError) {
    return NextResponse.json(
      { code: err.code, error: err.message, sessionId: err.sessionId },
      { status: 409 },
    );
  }
  if (err instanceof SessionNotFailedError || err instanceof PlanNotResumableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof GuideCardClosedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof DebugAnchorNotTriageBugError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  // A `debug_bug` result that failed re-validation at this boundary (MOTIR-7049):
  // the far side produced something this build will not write onto a card. An
  // upstream fault, so 502, and it names the field that failed.
  if (err instanceof InvalidAuthoredBugError || err instanceof InvalidGuideTurnError) {
    return NextResponse.json(
      { code: err.code, error: err.message, field: err.field },
      { status: 502 },
    );
  }
  // A mailbox turn addressed at a job that has already finished (MOTIR-4067).
  // 409 for the same reason as the two above — a state conflict, not a malformed
  // request — and it CARRIES THE STATUS, because "that run is over" leaves the
  // client guessing whether to resubmit as a new turn (succeeded / stopped) or to
  // surface a failure, and those are opposite next steps.
  if (err instanceof PlanChangeJobNotRunningError) {
    return NextResponse.json(
      { code: err.code, error: err.message, jobStatus: err.status },
      { status: 409 },
    );
  }
  // Another session holds one of the scope's targets (MOTIR-2787). 409, not 403:
  // the caller MAY plan this item, it is simply taken — and the body names which
  // item, who has it, and when the lease runs out, so the client can say something
  // more useful than "try again".
  if (err instanceof PlanTargetLockedError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        target: err.targetIdentifier,
        holder: err.holderName,
        expiresAt: err.expiresAt.toISOString(),
        // AMENDMENT 23 §4: when it frees at the latest (null for a plan waiting
        // for a decision), and the session holding it.
        freesBy: err.freesBy?.toISOString() ?? null,
        holderSessionId: err.holderSessionId,
        // MOTIR-7912: the holder's session is waiting, and why.
        sessionWaiting: err.sessionWaiting,
        waitingCause: err.waitingCause,
      },
      { status: 409 },
    );
  }
  // A project that does not resolve IN THIS WORKSPACE — the cross-tenant posture
  // is 404, never 403 (no existence leak, finding #26). Unreachable over HTTP,
  // where the context comes from the actor's own active project, but the access
  // gate can raise it and it must not become a 500.
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message },
      { status: err.kind === 'browse' ? 404 : 403 },
    );
  }
  // MOTIR-2355 — the `ai:plan` refusal, carrying the key. A NON-browser never
  // produces it (the 404 above catches them first), so this is precisely "you are
  // on this project and may not spend its AI credits".
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  // The submit path drives the METERED motir-ai job — the same credit / transport
  // mapping the shipped augment route uses.
  if (err instanceof MotirAiOutOfCreditsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
  }
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}

/** The shared "no active project" 404 — the plan-change routes act on the actor's
 *  ACTIVE project (the shipped `/api/ai/augment` shape), so all three need it. */
export function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 404 },
  );
}

/**
 * The session a request ADDRESSES (MOTIR-6023; AMENDMENT 17 §2) — every
 * conversation door names its session by id, because a scope now holds many.
 * Returns the id, or `null` when it is absent or not a non-empty string.
 */
export function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The 400 a door answers when the `sessionId` it requires is missing. */
export function missingSessionId(): NextResponse {
  return NextResponse.json(
    { code: 'BAD_REQUEST', error: '`sessionId` is required — name the conversation by its id.' },
    { status: 400 },
  );
}

/**
 * A turn body's `attachmentIds` (MOTIR-7484; `guide-turn-files.md` A3.2): absent
 * or null is no files; otherwise an array of non-empty strings, else `invalid`.
 * The SHAPE only — the count, the card and the conversation are the service's.
 * The bound here is far above the turn cap, so an absurd array is refused before
 * any read.
 */
export function readAttachmentIds(value: unknown): string[] | 'invalid' {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) return 'invalid';
  const ids: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > 64) return 'invalid';
    ids.push(v.trim());
  }
  return ids;
}

/** The 400 a door answers when `attachmentIds` is not an array of ids. */
export function invalidAttachmentIds(): NextResponse {
  return NextResponse.json(
    { code: 'BAD_REQUEST', error: '`attachmentIds` must be an array of attachment ids.' },
    { status: 400 },
  );
}
