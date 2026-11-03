import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET / POST /api/workspaces/[workspaceId]/custom-domains — MOTIR-9524.
// List the workspace's customer domains; connect one, optionally naming the
// application it serves (`{ hostname, applicationId? }`, ADR MOTIR-9521 §1). The gate is the
// workspace's address gate (any member lists, a workspace manager writes),
// enforced in the service.
// Thin HTTP transport per CLAUDE.md: parse → gate → ONE service call → mapping.

interface RouteParams {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { workspaceId } = await params;
  try {
    return NextResponse.json(
      await customDomainService.list({ workspaceId, actorUserId: ctx.userId }),
    );
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const hostname =
    body && typeof body === 'object' && 'hostname' in body && typeof body.hostname === 'string'
      ? body.hostname
      : null;
  if (!hostname) {
    return NextResponse.json(
      { error: 'A "hostname" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  // Optional: the application the domain serves. Absent or null = unbound.
  const applicationId =
    body && typeof body === 'object' && 'applicationId' in body ? body.applicationId : null;
  if (applicationId !== null && typeof applicationId !== 'string') {
    return NextResponse.json(
      { error: '"applicationId" must be a string or null.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const dto = await customDomainService.add({
      workspaceId,
      hostname,
      applicationId,
      actorUserId: ctx.userId,
    });
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
