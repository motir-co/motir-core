import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// DELETE /api/projects/[key]/public-addresses/[addressId] — MOTIR-4216.
//
// Answers 204 even when the platform's certificate withdrawal fails: the row is
// the source of truth for what we serve, and a certificate left behind for a
// hostname that no longer points at us protects nothing. The service logs it.

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string; addressId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { key, addressId } = await params;
  try {
    await customDomainService.remove({ key, addressId, actorUserId: ctx.userId, ctx });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
