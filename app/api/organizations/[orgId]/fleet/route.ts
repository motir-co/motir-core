import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { orgFleetService } from '@/lib/services/orgFleetService';
import { mapBillingError } from '@/lib/billing/errorResponse';

// GET /api/organizations/[orgId]/fleet — what the org runs on the fleet now: the
// Fleet use figures, its live hosted runs, its members' agents, its CI jobs in
// flight and waiting, its index job count and what Motir stopped for it in the
// last seven days. Each part reads or is `not_read` on its own. HTTP-only:
// session-gate, call ONE service method, map typed errors. Owner or admin only
// (the service applies Billing & plans' view gate); no id of any account,
// machine or shard leaves.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { orgId } = await params;
  try {
    const fleet = await orgFleetService.read({
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ fleet });
  } catch (err) {
    const mapped = mapBillingError(err);
    if (mapped) return mapped;
    throw err;
  }
}
