import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapExportError } from '@/lib/hosting/exportErrorResponse';
import { hostedApplicationExportService } from '@/lib/services/hostedApplicationExportService';

// /api/organizations/[orgId]/hosting/applications/[applicationId]/exports
// (Story MOTIR-9800 · MOTIR-12134) — a grace-window application's database
// exports. HTTP only: session-gate, one service call, typed errors mapped by
// `mapExportError`. Organisation admins only (the service's gate).
//
// POST asks for an on-demand export → 202 { jobId }. The dump is taken by the
//   `hosting.application-export` job; the export appears in GET once it is
//   stored, under the id `jobId` names.
// GET lists the unexpired exports, newest first → 200 { exports }, with no
//   storage key.

type Params = { params: Promise<{ orgId: string; applicationId: string }> };

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId, applicationId } = await params;
  try {
    const { jobId } = await hostedApplicationExportService.requestExport(
      applicationId,
      { kind: 'user', userId: gate.session.user.id },
      { organizationId: orgId },
    );
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    const mapped = mapExportError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId, applicationId } = await params;
  try {
    const exports = await hostedApplicationExportService.listExports(
      applicationId,
      { kind: 'user', userId: gate.session.user.id },
      { organizationId: orgId },
    );
    return NextResponse.json({ exports });
  } catch (err) {
    const mapped = mapExportError(err);
    if (mapped) return mapped;
    throw err;
  }
}
