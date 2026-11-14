import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../../_errors';

// POST /api/ai/plan-change/session/mailbox/skip-final-check — SKIP the final check
// of the plan the active project's conversation is running (Story MOTIR-11262 ·
// MOTIR-11266; design `design/ai-chat/design-notes.md` § "⭐ The final check").
//
// ⚠️ THE SAME MAILBOX AS A TURN AND A STOP, taking its own kind — never a second
// channel, for the stop door's reason: one `seq` per job keeps every entry in the
// order it was made. It ends only the final check: motir-ai stops reviewing,
// fixes nothing, and proposes the plan (MOTIR-11267).
//
// ⚠️ NOT AN ERROR PATH. A skip after the check has ended answers 200 with
// `outcome: 'not_running'` and writes nothing; a repeated key answers `skipped`
// again with nothing new. The check can end between render and press.
//
// HTTP only (CLAUDE.md 4-layer): parse the body, call ONE service method, map
// typed errors. NOT rate-limited, deliberately — as its siblings are not: it
// writes one row against a job that is already running and already paid for.
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

  const jobId = bag['jobId'];
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  // REQUIRED, as on the stop door: a double press must raise ONE skip.
  const idempotencyKey = bag['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`idempotencyKey` is required — it is what makes a second press a no-op.',
      },
      { status: 400 },
    );
  }

  const sessionId = readSessionId(bag['sessionId']);
  if (!sessionId) return missingSessionId();

  try {
    const result = await planChangeMailboxService.raiseSkipFinalCheck(
      jobId,
      idempotencyKey,
      ctx,
      sessionId,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
