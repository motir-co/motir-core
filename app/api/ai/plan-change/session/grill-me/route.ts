import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';

// GRILL ME, STORED ON THE CONVERSATION (Story MOTIR-11799 · MOTIR-11801). `PUT` sets
// the addressed session's switch to `on` and returns the session as it now stands, so
// the composer's switch reads the server's value. Idempotent: setting the value it
// already has changes nothing. `ai:plan`-gated in the service, like every other
// conversation action; an ended session is a 409.
// NOT rate-limited, deliberately: it submits no model job, so it spends nothing.
export async function PUT(req: Request): Promise<Response> {
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
  const on = (body as { on?: unknown })?.on;
  if (typeof on !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`on` must be true or false.' },
      { status: 400 },
    );
  }

  try {
    const session = await planChangeSessionsService.setGrillMe(ctx, { sessionId }, on);
    return NextResponse.json(session, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
