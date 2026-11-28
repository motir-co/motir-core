import { NextResponse } from 'next/server';
import { scipUploadCredentialService } from '@/lib/services/scipUploadCredentialService';
import { scipUploadRefusal } from '@/lib/projectRepos/scipUploadResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// REVOKE ONE SCIP UPLOAD CREDENTIAL of a Repositories-room row (Story MOTIR-12262 ·
// MOTIR-12339).
//
//   POST → 200 { credentialId, revoked }   — a repeat answers `revoked: false`
//
// On a Motir-hosted row whose installed credential this is, the repository's secret
// and variables are deleted before the code graph revokes it. Gated on
// `repository:manage` inside the service.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ rowId: string; credentialId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { rowId, credentialId } = await params;
  try {
    return NextResponse.json(
      await scipUploadCredentialService.revoke(rowId, credentialId, gate.ctx),
    );
  } catch (err) {
    const refused = await scipUploadRefusal(err);
    if (refused) return refused;
    throw err;
  }
}
