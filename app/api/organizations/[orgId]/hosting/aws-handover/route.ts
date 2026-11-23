import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import {
  badHandoverRequest,
  mapTenantHandoverError,
  readHandoverBody,
} from '@/lib/hosting/tenantHandoverErrorResponse';
import { tenantAccountHandoverService } from '@/lib/services/tenantAccountHandoverService';

// /api/organizations/[orgId]/hosting/aws-handover (Story MOTIR-9800 ·
// MOTIR-12131) — hand the organisation's AWS account over at takeover, with its
// apps running. HTTP only: session-gate, one service call, typed errors mapped
// by `mapTenantHandoverError`. Organisation admins only (the service's gate).
//
// POST { ownerEmail, githubOwner } starts the handover → 201 { handover }.
// GET ?tenantAccountId=… reads its checklist → 200 { handover }.
// Neither answer carries the owner's email address or any one-time code.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  const body = await readHandoverBody(req);
  const ownerEmail = body?.['ownerEmail'];
  const githubOwner = body?.['githubOwner'];
  if (typeof ownerEmail !== 'string' || typeof githubOwner !== 'string') {
    return badHandoverRequest('`ownerEmail` and `githubOwner` are required.');
  }
  try {
    const handover = await tenantAccountHandoverService.start(
      orgId,
      { ownerEmail, githubOwner },
      gate.session.user.id,
    );
    return NextResponse.json({ handover }, { status: 201 });
  } catch (err) {
    const mapped = mapTenantHandoverError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  const tenantAccountId = new URL(req.url).searchParams.get('tenantAccountId');
  if (!tenantAccountId) return badHandoverRequest('`tenantAccountId` is required.');
  try {
    const handover = await tenantAccountHandoverService.status(tenantAccountId, {
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
