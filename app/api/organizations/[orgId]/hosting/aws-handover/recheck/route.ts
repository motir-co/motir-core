import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import {
  badHandoverRequest,
  mapTenantHandoverError,
  readHandoverBody,
} from '@/lib/hosting/tenantHandoverErrorResponse';
import { tenantAccountHandoverService } from '@/lib/services/tenantAccountHandoverService';

// POST /api/organizations/[orgId]/hosting/aws-handover/recheck (Story
// MOTIR-9800 · MOTIR-12131) — the new owner has met AWS's standalone
// requirements: read them again and carry on. Body { tenantAccountId } → 200
// { handover }; 409 when no step waits on them.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  const tenantAccountId = (await readHandoverBody(req))?.['tenantAccountId'];
  if (typeof tenantAccountId !== 'string') {
    return badHandoverRequest('`tenantAccountId` is required.');
  }
  try {
    const handover = await tenantAccountHandoverService.recheckStandalone(tenantAccountId, {
      userId: gate.session.user.id,
      organizationId: orgId,
    });
    return NextResponse.json({ handover });
  } catch (err) {
    const mapped = mapTenantHandoverError(err);
    if (mapped) return mapped;
    throw err;
  }
}
