import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { isRestartAnswer } from '@/lib/planChange/restart';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';

// THE RESTART — Plan something new (Story MOTIR-7631 · MOTIR-7649;
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 3, A3.3). `confirm` ends
// the session `restarted` and returns the NEW empty session for the same scope,
// which the overlay swaps to in place: the Plan something new dialog posts it
// (MOTIR-11261), with nothing written to the conversation first. `keep` answers a
// confirm TURN a thread already holds — it writes the Keep planning marker and
// returns the same session. `ai:plan`-gated in the service.
// NOT rate-limited, deliberately: it submits no model job, so it spends nothing.
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
  const sessionId = readSessionId((body as { sessionId?: unknown })?.sessionId);
  if (!sessionId) return missingSessionId();
  const answer = (body as { answer?: unknown })?.answer;
  if (!isRestartAnswer(answer)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: "`answer` must be 'confirm' or 'keep'." },
      { status: 400 },
    );
  }

  try {
    const result =
      answer === 'confirm'
        ? await planChangeSessionsService.restart(ctx, { sessionId })
        : await planChangeSessionsService.keepPlanning(ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
