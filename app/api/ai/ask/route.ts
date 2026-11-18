import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiAskService } from '@/lib/services/aiAskService';
import {
  invalidAttachmentIds,
  mapPlanChangeError,
  noActiveProject,
  readAttachmentIds,
  readSessionId,
} from '../plan-change/_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { PlanSeedNotApplicableError } from '@/lib/planChange/errors';

// POST /api/ai/ask — the project conversation's ONE DOOR for a user turn
// (Story MOTIR-1343 · MOTIR-1819; contract in
// `docs/decisions/conversation-turn-intent.md`).
//
// ⚠️ IT IS NOT AN "ASK-ONLY" ENDPOINT THE CLIENT PICKS WHEN IT ALREADY KNOWS.
// The person types into one composer with no mode to flip, so the client posts
// the TEXT and nothing else — never an `intent`. The turn is submitted as
// `ask_project`, and what it turns out to be is the JOB'S answer: a question is
// answered with citations, a plan-change request is handed back and dispatched
// to the SHIPPED plan-change submit (see the settle route). An `intent` in this
// body would be the mode re-entering through the back door, so it is not read —
// and `tests/ai/askRoutes.test.ts` asserts that it is not.
//
// Two bodies, one door:
//   { body, isAnswer? }          — a new turn. `isAnswer` is ADR §1's wire field
//                                  and is NOT an intent: it records which
//                                  affordance sent the turn (the shipped
//                                  `isAnswer` precedent), so the thread can say
//                                  later whether the planner's question was
//                                  answered or superseded. Beside it,
//                                  `answerOptionId` names the option the person
//                                  CLICKED (MOTIR-11700), resolved against the
//                                  question the thread waits on.
//   Either body may carry `anchorKey` (MOTIR-7047 · ADR AMENDMENT 1, A1.2): ONE
//   work-item key the turn is ABOUT — usually the triage bug just reported. It is
//   DATA, not an intent or a mode: the turn still lands on the project-wide
//   thread, the key is resolved through the keyed read (triage included) and
//   browse-gated in the service, and an unknown / foreign / hidden key is the
//   planning-anchor route's no-existence-leak 404. A non-string is a 400.
//   A new turn may carry `attachmentIds` (MOTIR-7484; `guide-turn-files.md`
//   A3.2): DATA like `anchorKey`, legal only on a GUIDE conversation named by
//   `sessionId` — anywhere else the whole turn is a 400 before anything is
//   written. With files, `body` may be empty.
//   { body, sessionId, runJobId, planId } — a MID-RUN turn (MOTIR-7996; ADR
//                                  AMENDMENT 4): typed while a planning run is in
//                                  progress. It is answered by an `ask_project` job
//                                  carrying a run snapshot, and only a change
//                                  verdict reaches the running job's mailbox (at
//                                  settle). `sessionId` is required with them, and
//                                  must be the session that is on `runJobId` — a
//                                  mismatch is the mailbox's no-existence-leak 404.
//   { turnId, flip? }            — RE-RUN a turn already on the thread: the retry
//                                  after a failed submit (`flip` absent) and the
//                                  correction affordance (`flip: true`). The
//                                  DIRECTION of a flip is derived server-side
//                                  from what the turn ran as; the client names
//                                  the turn, never the intent.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors. No `db`, no `$transaction`, no `motir-ai` import.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // The AI ceiling on the door that SUBMITS the job — the same `ai:generate`
  // bucket the plan-change submit spends, because an ask turn costs a real model
  // run. Spent after the two gates and before the body is read, since a 429 after
  // the provider call has already paid the bill.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = raw as {
    body?: unknown;
    turnId?: unknown;
    flip?: unknown;
    isAnswer?: unknown;
    answerOptionId?: unknown;
    sessionId?: unknown;
    seedGateId?: unknown;
    anchorKey?: unknown;
    attachmentIds?: unknown;
    runJobId?: unknown;
    planId?: unknown;
  };
  // The conversation the client holds (MOTIR-6023; AMENDMENT 17 §2). Optional
  // here: with none, the caller's resumable project-wide session is used, and a
  // new turn with none STARTS one — the ask door stays self-sufficient.
  const sessionId = readSessionId(body.sessionId) ?? undefined;
  const attachmentIds = readAttachmentIds(body.attachmentIds);
  if (attachmentIds === 'invalid') return invalidAttachmentIds();
  if (
    body.anchorKey !== undefined &&
    body.anchorKey !== null &&
    typeof body.anchorKey !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`anchorKey` must be a work-item key.' },
      { status: 400 },
    );
  }
  const anchorKey =
    typeof body.anchorKey === 'string' && body.anchorKey.trim().length > 0
      ? body.anchorKey.trim()
      : undefined;

  try {
    if (typeof body.turnId === 'string' && body.turnId.length > 0) {
      const result = await aiAskService.resubmit(body.turnId, ctx, {
        flip: body.flip === true,
        ...(sessionId ? { sessionId } : {}),
        ...(anchorKey ? { anchorKey } : {}),
      });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (typeof body.body !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`body` or `turnId` is required.' },
        { status: 400 },
      );
    }
    const runJobId = typeof body.runJobId === 'string' ? body.runJobId.trim() : '';
    const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
    if (runJobId && planId) {
      if (!sessionId) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`sessionId` is required with `runJobId`.' },
          { status: 400 },
        );
      }
      const result = await aiAskService.submitMidRunTurn(body.body, ctx, {
        sessionId,
        runJobId,
        planId,
      });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const seedGateId =
      typeof body.seedGateId === 'string' && body.seedGateId.trim().length > 0
        ? body.seedGateId.trim()
        : null;
    const result = await aiAskService.submitTurn(body.body, ctx, {
      isAnswer: body.isAnswer === true,
      // The option an answer PICKED (MOTIR-11700) — honoured only with `isAnswer`, and
      // resolved by the service against the question the thread waits on.
      ...(body.isAnswer === true &&
      typeof body.answerOptionId === 'string' &&
      body.answerOptionId.length > 0
        ? { answerOptionId: body.answerOptionId }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(seedGateId && !sessionId ? { seedGateId } : {}),
      ...(anchorKey ? { anchorKey } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // A pick's project-anchored first turn whose gate may not seed the project
    // scope (MOTIR-6435) — the same one-body 422 the anchored plan route answers.
    if (err instanceof PlanSeedNotApplicableError) {
      return NextResponse.json({ code: 'SEED_NOT_APPLICABLE' }, { status: 422 });
    }
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
