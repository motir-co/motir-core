import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { fleetCapacityRequestService } from '@/lib/services/fleetCapacityRequestService';
import { mapBillingError } from '@/lib/billing/errorResponse';
import { mapFleetCapacityRequestError } from '@/lib/ciFleet/capacityRequestErrorResponse';

// POST /api/organizations/[orgId]/billing/fleet-use/capacity-requests — an owner
// or admin of a Host org asks for more capacity on one of its OWN accounts,
// named by fleet kind (Story MOTIR-9368 · MOTIR-9662). HTTP-only: session-gate,
// check the body's SHAPE, call ONE service method, map typed errors. The service
// owns the cloud gate, the owner/admin gate, the kind → account resolution and
// every rule on the figure and the reason. No account or shard id goes in or out.

type CapacityBody =
  | { ok: true; fleetKind: string; desiredVcpu: number; reason: string }
  | { ok: false; response: NextResponse };

function invalid(field: string): CapacityBody {
  return {
    ok: false,
    response: NextResponse.json({ code: 'INVALID_BODY', field }, { status: 400 }),
  };
}

async function readBody(req: Request): Promise<CapacityBody> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return invalid('body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('body');
  const { fleetKind, desiredVcpu, reason } = parsed as Record<string, unknown>;
  if (typeof fleetKind !== 'string') return invalid('fleetKind');
  if (typeof desiredVcpu !== 'number') return invalid('desiredVcpu');
  if (typeof reason !== 'string') return invalid('reason');
  return { ok: true, fleetKind, desiredVcpu, reason };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  const body = await readBody(req);
  if (!body.ok) return body.response;

  try {
    const request = await fleetCapacityRequestService.requestForOrganization({
      organizationId: orgId,
      actorUserId: session.user.id,
      fleetKind: body.fleetKind,
      desiredVcpu: body.desiredVcpu,
      reason: body.reason,
    });
    return NextResponse.json({ request });
  } catch (err) {
    const mapped = mapBillingError(err) ?? mapFleetCapacityRequestError(err);
    if (mapped) return mapped;
    throw err;
  }
}
