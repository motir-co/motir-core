import { NextResponse } from 'next/server';
import { scipUploadCredentialService } from '@/lib/services/scipUploadCredentialService';
import { scipUploadRefusal } from '@/lib/projectRepos/scipUploadResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// A REPOSITORY'S SCIP UPLOAD CREDENTIALS — one row of the Repositories room (Story
// MOTIR-12262 · MOTIR-12339; design repository-set §20).
//
//   GET            → 200 { credentials: ScipUploadCredentialDto[] }   — never a token
//   POST { name }  → 201 MintedScipUploadCredentialDto               — the token, ONCE
//
// Both gated on `repository:manage` inside the service. A refusal is the room's
// `{ code, error, retryable }`: motir-ai's `codegraph_repository_not_registered` and
// `upload_credential_limit_reached` (409) and `codegraph_unavailable` (503,
// retryable). The mint's answer is `Cache-Control: no-store`, and nothing here logs a
// request or response body.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { rowId } = await params;
  try {
    const credentials = await scipUploadCredentialService.list(rowId, gate.ctx);
    return NextResponse.json({ credentials }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const refused = await scipUploadRefusal(err);
    if (refused) return refused;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { rowId } = await params;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json(
      {
        code: 'PROJECT_REPO_INVALID_FIELD',
        error: '`name` must name the credential.',
        retryable: false,
      },
      { status: 422 },
    );
  }
  try {
    const minted = await scipUploadCredentialService.mint(rowId, { name: body.name }, gate.ctx);
    return NextResponse.json(minted, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const refused = await scipUploadRefusal(err);
    if (refused) return refused;
    throw err;
  }
}
