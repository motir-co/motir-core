import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import {
  badHandoverRequest,
  mapTenantHandoverError,
  readHandoverBody,
} from '@/lib/hosting/tenantHandoverErrorResponse';
import { tenantAccountHandoverService } from '@/lib/services/tenantAccountHandoverService';

// POST /api/organizations/[orgId]/hosting/aws-handover/email-code (Story
// MOTIR-9800 · MOTIR-12131) — the one-time code AWS emailed the new owner, for
// the handover's `move_email` step. Body { tenantAccountId, code } → 200
// { handover }. The code goes straight to AWS: it is never stored, logged or
// returned. 422 when AWS refuses it; 409 when the step is not waiting on it.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  const body = await readHandoverBody(req);
  const tenantAccountId = body?.['tenantAccountId'];
  const code = body?.['code'];
  if (typeof tenantAccountId !== 'string' || typeof code !== 'string') {
    return badHandoverRequest('`tenantAccountId` and `code` are required.');
  }
  try {
    const handover = await tenantAccountHandoverService.submitEmailCode(tenantAccountId, code, {
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
