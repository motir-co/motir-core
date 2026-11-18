import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeRunPauseService } from '@/lib/services/planChangeRunPauseService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';

// The planner's mid-run PAUSE, from the person's side (Story MOTIR-7990 ·
// MOTIR-8007). The planner records it on the job-token door
// (`/api/internal/ai/plan-change-run-pause`); this route READS it and ANSWERS it.
//
// GET  ?sessionId&jobId  → the session's latest pause, or `null`, so the rail can
//                          poll while the run is paused.
// POST { sessionId, jobId, pauseId, choice, text?, optionId? }
//        choice `start_over` | `apply` on a replan pause, `reply` (with `text`, or with
//        `optionId` naming one of the question's options, MOTIR-11700) on an
//        unclear pause, `resume` on a code_unsearchable pause (MOTIR-9167: the code can
//        be searched now — the run re-checks on receipt) → `{ outcome: 'answered', pause, delivery }`, or, when the run
//        ended before the answer could be delivered,
//        `{ outcome: 'refused', code, jobStatus, choice, text?, pause }` (the choice
//        and reply stay recorded). A different answer to an answered pause → 409 with
//        the stored one; a pause that is not on this session and job → 404.
//
// HTTP only (CLAUDE.md 4-layer). NOT rate-limited, deliberately, on the mailbox route's reasoning:
// no job is submitted and no provider money is spent — an answer is a database write
// and a mailbox entry for a run that is already running and paid for.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const params = new URL(req.url).searchParams;
  const sessionId = readSessionId(params.get('sessionId'));
  if (!sessionId) return missingSessionId();
  const jobId = params.get('jobId');
  if (!jobId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  try {
    const pause = await planChangeRunPauseService.latestForSession(sessionId, ctx);
    // Only a pause of the run the caller asked about; another job's is not theirs here.
    return NextResponse.json(pause && pause.jobId === jobId ? pause : null, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bag = (body ?? {}) as Record<string, unknown>;
  const sessionId = readSessionId(bag['sessionId']);
  if (!sessionId) return missingSessionId();
  const jobId = bag['jobId'];
  const pauseId = bag['pauseId'];
  if (typeof jobId !== 'string' || !jobId || typeof pauseId !== 'string' || !pauseId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` and `pauseId` are required.' },
      { status: 400 },
    );
  }
  const choice = bag['choice'];
  if (choice !== 'start_over' && choice !== 'apply' && choice !== 'reply' && choice !== 'resume') {
    return NextResponse.json(
      {
        code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE',
        error: '`choice` must be `start_over`, `apply`, `reply` or `resume`.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeRunPauseService.answer(
      {
        sessionId,
        jobId,
        pauseId,
        choice,
        text: typeof bag['text'] === 'string' ? bag['text'] : null,
        // A reply that picked one of the question's options (MOTIR-11700).
        ...(typeof bag['optionId'] === 'string' ? { optionId: bag['optionId'] } : {}),
      },
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
