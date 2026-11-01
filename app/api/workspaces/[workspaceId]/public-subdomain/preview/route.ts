import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapPublicAddressError } from '@/lib/publicAddresses/errorResponse';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET /api/workspaces/[workspaceId]/public-subdomain/preview
// Story MOTIR-4528 · Subtask MOTIR-9510 (`docs/decisions/public-tenant-addresses.md`
// §8 Amendment 3, story rule 5).
//
// What renaming or releasing the subdomain would do RIGHT NOW: the host that
// would stop being served, whether its name returns at once or is held and
// until when, and whether the 30-day limit allows a change. The confirm dialog
// shows it, so the date a customer reads is computed by the same pure functions
// as the date the write stores.
//
// ⚠️ ADVICE, NEVER A RESERVATION. It takes no lock and writes nothing; PUT and
// DELETE recompute everything under the workspace lock, so a client must not
// treat this answer as a promise. Workspace managers only (the service's gate):
// it previews a change only they can make. `404` when there is no subdomain.
//
// ⚠️ THE COMPLIANCE HOLD APPLIES, unlike the subdomain GET. That GET is a
// member's read of an address; this is the first step of a manager's WRITE, and
// a session the hold would refuse at the PUT or DELETE has no business being
// told what the write would do. It is also what the session-gate guard
// (`tests/api/two-factor-api-gate.test.ts`) asks of every route that reads one.
//
// Thin HTTP transport per `CLAUDE.md`: session, ONE service call, map typed
// errors.

interface RouteParams {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId } = await params;
  try {
    const preview = await publicSubdomainService.previewChange(workspaceId, ctx.userId);
    return NextResponse.json(preview);
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}
