import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// PATCH / DELETE /api/workspaces/[workspaceId]/custom-domains/[addressId] — MOTIR-9524.
// PATCH `{ applicationId }` re-points the domain (null unbinds it, ADR
// MOTIR-9521 §1). Removal reserves nothing: the host is addable again at once.
//
// Answers 204 even when the platform's certificate withdrawal fails: the row is
// the source of truth for what we serve, and a certificate left behind for a
// hostname that no longer points at us protects nothing. The service logs it.

interface RouteParams {
  params: Promise<{ workspaceId: string; addressId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, addressId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const applicationId =
    body && typeof body === 'object' && 'applicationId' in body ? body.applicationId : undefined;
  if (applicationId !== null && typeof applicationId !== 'string') {
    return NextResponse.json(
      {
        error: 'An "applicationId" (a string, or null to unbind) is required.',
        code: 'BAD_REQUEST',
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await customDomainService.bind({
        workspaceId,
        addressId,
        applicationId,
        actorUserId: ctx.userId,
      }),
    );
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, addressId } = await params;
  try {
    await customDomainService.remove({ workspaceId, addressId, actorUserId: ctx.userId });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
