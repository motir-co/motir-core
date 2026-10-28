import { NextResponse } from 'next/server';

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
// treat this answer as a promise. A read, so no compliance hold — the same
// posture as the subdomain GET. Workspace managers only (the service's gate):
// it previews a change only they can make. `404` when there is no subdomain.
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
