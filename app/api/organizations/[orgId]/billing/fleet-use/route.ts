import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { fleetUseService } from '@/lib/services/fleetUseService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// GET /api/organizations/[orgId]/billing/fleet-use — the org's fleet use: its
// plan and figures, use and waiting per figure, where each kind of its work runs
// and, on Host, its own accounts (Story MOTIR-9368 · MOTIR-9661). HTTP-only:
// session-gate, call ONE service method, map typed errors. Owner or admin only
// (the service applies Billing & plans' view gate); no id of any account leaves.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  try {
    const fleetUse = await fleetUseService.readForOrganization({
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ fleetUse });
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
