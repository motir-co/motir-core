import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapExportError } from '@/lib/hosting/exportErrorResponse';
import { hostedApplicationExportService } from '@/lib/services/hostedApplicationExportService';

// /api/organizations/[orgId]/hosting/applications/[applicationId]/exports/[exportId]/download
// (Story MOTIR-9800 · MOTIR-12134) — download one database export. Organisation
// admins only; each call records one download and answers 302 to a signed link
// valid for five minutes. An export past its expiry is 404.

type Params = {
  params: Promise<{ orgId: string; applicationId: string; exportId: string }>;
};

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId, applicationId, exportId } = await params;
  try {
    const url = await hostedApplicationExportService.downloadUrl(
      exportId,
      { kind: 'user', userId: gate.session.user.id },
      { applicationId, organizationId: orgId },
    );
    return NextResponse.redirect(url, 302);
  } catch (err) {
    const mapped = mapExportError(err);
    if (mapped) return mapped;
    throw err;
  }
}
