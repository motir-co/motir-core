import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// POST /api/workspaces/[workspaceId]/custom-domains/[addressId]/verify — MOTIR-9524.
// Prove ownership from DNS, then ask the platform for a certificate. Both are
// side effects the SERVICE runs outside any transaction; this file only routes.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ workspaceId: string; addressId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, addressId } = await params;
  try {
    return NextResponse.json(
      await customDomainService.verify({ workspaceId, addressId, actorUserId: ctx.userId }),
    );
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
