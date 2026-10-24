import { NextResponse } from 'next/server';

import type { SharpenAction } from '@/lib/ai/types';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { aiSharpenService } from '@/lib/services/aiSharpenService';
import { noActiveProject, readSessionId } from '../plan-change/_errors';
import { badRequest, mapSharpenError, NO_STORE } from './_errors';

// POST /api/ai/sharpen — the SHARPEN door (Task MOTIR-1101 · Subtask MOTIR-8181).
//
// Three bodies, one door, like the Guide me through door:
//   { planId } | { conversationId }               — OPEN a Sharpen session on a plan
//                                                   or a plan-change conversation
//                                                   (resumes the caller's open one,
//                                                   sending nothing)
//   { sessionId, action, readingId?, text? }      — ACT on the pending question:
//                                                   answer | own_words | skip |
//                                                   you_decide | stop
//   { sessionId, turnId }                         — RE-RUN a turn whose submit or
//                                                   job failed (replay-safe)
//
// GET /api/ai/sharpen?planId= | ?conversationId= — the caller's OPEN session on that
// target, or `null`. `?conversationId=&latest=1` answers their LATEST session there,
// open or ended (MOTIR-9316): the rail lists what an ended grilling settled after a
// reload.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors. No `db`, no repository, no `motir-ai` import.

const ACTIONS: readonly SharpenAction[] = ['answer', 'own_words', 'skip', 'you_decide', 'stop'];

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest('Invalid JSON body.');
  }
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const sessionId = readSessionId(body.sessionId);
  const turnId = nonEmpty(body.turnId);
  const planId = nonEmpty(body.planId);
  const conversationId = nonEmpty(body.conversationId);

  try {
    if (turnId) {
      if (!sessionId) return badRequest('`sessionId` is required with `turnId`.');
      const result = await aiSharpenService.resubmit(sessionId, turnId, ctx);
      return NextResponse.json(result, { headers: NO_STORE });
    }
    if (sessionId) {
      if (!ACTIONS.includes(body.action as SharpenAction)) {
        return badRequest(`\`action\` must be one of ${ACTIONS.join(', ')}.`);
      }
      if (body.readingId !== undefined && typeof body.readingId !== 'string') {
        return badRequest('`readingId` must be a string.');
      }
      if (body.text !== undefined && typeof body.text !== 'string') {
        return badRequest('`text` must be a string.');
      }
      const result = await aiSharpenService.act(
        sessionId,
        body.action as SharpenAction,
        {
          ...(typeof body.readingId === 'string' ? { readingId: body.readingId } : {}),
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
        },
        ctx,
      );
      return NextResponse.json(result, { headers: NO_STORE });
    }
    if (planId && conversationId) {
      return badRequest('Name a `planId` or a `conversationId`, not both.');
    }
    if (!planId && !conversationId) {
      return badRequest('One of `planId`, `conversationId` or `sessionId` is required.');
    }
    const result = await aiSharpenService.open(
      planId ? { planId } : { conversationId: conversationId! },
      ctx,
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    const mapped = mapSharpenError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const params = new URL(req.url).searchParams;
  const planId = nonEmpty(params.get('planId'));
  const conversationId = nonEmpty(params.get('conversationId'));
  if (Boolean(planId) === Boolean(conversationId)) {
    return badRequest('Exactly one of `planId` or `conversationId` is required.');
  }
  const latest = params.get('latest') === '1';
  if (latest && !conversationId) {
    return badRequest('`latest` is read with a `conversationId`.');
  }
  try {
    const session = latest
      ? await aiSharpenService.getLatestForConversation(conversationId!, ctx)
      : await aiSharpenService.getOpenFor(
          planId ? { planId } : { conversationId: conversationId! },
          ctx,
        );
    return NextResponse.json(session, { headers: NO_STORE });
  } catch (err) {
    const mapped = mapSharpenError(err);
    if (mapped) return mapped;
    throw err;
  }
}
