import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapStopError } from '@/lib/hosting/stopErrorResponse';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';

// /api/organizations/[orgId]/hosting/applications/[applicationId]/stop
// (Story MOTIR-9800 · MOTIR-12135) — an organisation admin's Stop now on a
// grace-window application. HTTP only: session-gate, one service call, typed
// errors mapped by `mapStopError`. Organisation admins only (the service's gate).
//
// POST runs the same stop the scheduled sweep runs, to its end → 200
//   { outcome, applicationId, handedOverAt, finalExportId }; `already_stopped`
//   for an application already handed over, with nothing called.

type Params = { params: Promise<{ orgId: string; applicationId: string }> };

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId, applicationId } = await params;
  try {
    const result = await hostedApplicationHandoverService.stopApplication(
      applicationId,
      { kind: 'user', userId: gate.session.user.id },
      { organizationId: orgId },
    );
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapStopError(err);
    if (mapped) return mapped;
    throw err;
  }
}
