import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapPublicAddressError } from '@/lib/publicAddresses/errorResponse';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET / PUT / DELETE /api/workspaces/[workspaceId]/public-subdomain
// Story MOTIR-3878 · Subtask MOTIR-4215; DELETE is Story MOTIR-4451 · Subtask
// MOTIR-4454; the contract below is Story MOTIR-4528 · Subtask MOTIR-9510
// (`docs/decisions/public-tenant-addresses.md` §8 Amendment 3).
//
// GET    — the workspace's subdomain DTO, or `null` when it has none. It carries
//          `nextChangeAllowedAt`: the date the 30-day limit next allows a rename
//          or release, or `null` when one is allowed now.
// PUT    — `{ label }`. CLAIMS (201) when the workspace has no subdomain and
//          RENAMES (200) when it has one. One verb, because from the customer's
//          side there is one control — a field with the address in it — and
//          which act it performs is a fact about the server's state rather than a
//          choice the caller makes. The service keeps them distinct: a rename is
//          a change under the 30-day limit, a first claim is not. A rename stops
//          serving the old name at once; nothing redirects to the new one.
// DELETE — RELEASE the subdomain. It stops being served at once, and `200
//          { returnsAt }` says when its name returns to the pool: an ISO date
//          when it is held (claimed 24 hours or more before), `null` when it
//          returned at once. The pane states that date, and cannot read it back
//          from GET once the row is gone. `404` when the workspace has none.
//
// The dated PREVIEW of a rename or release is `./preview` — advice for the
// confirm dialog, never a reservation: these writes recompute under the
// workspace lock.
//
// ⚠️ DELETE takes no body and therefore has no "which act is this?" branch —
// unlike PUT, whose one verb serves two acts. It is a separate verb rather than
// a `PUT { label: null }` because release is not a kind of naming.
//
// Thin HTTP transport per `CLAUDE.md`: parse, gate, ONE service call, map typed
// errors. Every rule — the cloud gate, the membership gate, the label grammar,
// the hold, the 30-day limit, the row lock — lives in the service.

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
    const dto = await publicSubdomainService.getForWorkspace(workspaceId, ctx.userId);
    return NextResponse.json(dto);
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
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
  const label =
    body && typeof body === 'object' && 'label' in body && typeof body.label === 'string'
      ? body.label
      : null;
  if (!label) {
    return NextResponse.json(
      { error: 'A "label" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    // Which act this is, is a question about SERVER STATE, so the server
    // answers it — not the caller through a second endpoint or a flag they
    // could get wrong.
    const existing = await publicSubdomainService.getForWorkspace(workspaceId, ctx.userId);
    const dto = existing
      ? await publicSubdomainService.rename(workspaceId, label, ctx.userId)
      : await publicSubdomainService.claim(workspaceId, label, ctx.userId);
    return NextResponse.json(dto, { status: existing ? 200 : 201 });
  } catch (err) {
    const mapped = mapPublicAddressError(err);
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

  const { workspaceId } = await params;

  try {
    // 200 WITH A BODY, not 204: the one fact the pane needs afterwards — when
    // the released name returns — has no other source once the row is gone.
    const released = await publicSubdomainService.release(workspaceId, ctx.userId);
    return NextResponse.json(released, { status: 200 });
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}
