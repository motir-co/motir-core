import { NextResponse } from 'next/server';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { hostedRepositoryRemovalService } from '@/lib/services/hostedRepositoryRemovalService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { isProjectRepoRole } from '@/lib/projectRepos/vocabulary';
import type { PatchProjectRepoInput } from '@/lib/dto/projectRepos';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// ONE row of a project's repository set (Story MOTIR-1775 · MOTIR-1782).
//
//   PATCH  → 200 ProjectRepoDto — rename the row (or change its role / seed
//            source). This is what makes the set EDITABLE BEFORE EXECUTION real:
//            the edit is persisted, so it survives a page refresh mid-flow rather
//            than living in component state.
//   DELETE → 204 — remove the row from the project. An ORGANISATION link is
//            dropped and nothing else (ADR §4.2): its mirror is un-claimed and
//            stays connected to the workspace. A MOTIR-HOSTED row Motir still
//            holds is DELETED with everything that runs from it — previews,
//            production, the GitHub repository — and the row last (MOTIR-11981;
//            design/repository-set §19). A hosted delete that stops part way is
//            a 502 with the row left marked, and a retry finishes it.
//
// The row id is workspace-scoped and self-sufficient — `projectRepoSetService`
// resolves it to its project and gates on THAT — so `[key]` is not re-resolved
// here. It stays in the path because the set is a project-scoped resource and the
// URL should say so; a row id from another project simply 404s on the gate.

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId } = await params;
  const body = (await req.json().catch(() => null)) as Partial<PatchProjectRepoInput> | null;
  if (!body) {
    return NextResponse.json(
      { code: 'PROJECT_REPO_INVALID_FIELD', error: 'A JSON body is required.' },
      { status: 422 },
    );
  }
  if (body.role !== undefined && !isProjectRepoRole(body.role)) {
    return NextResponse.json(
      { code: 'PROJECT_REPO_INVALID_FIELD', error: '`role` is not a known repository role.' },
      { status: 422 },
    );
  }

  // Only the keys PRESENT are forwarded — `patchRow` is a partial edit and
  // distinguishes "absent" from "null" for `label`, so spreading the raw body
  // would turn every omitted field into an explicit clear.
  const input: PatchProjectRepoInput = {
    ...(body.role !== undefined ? { role: body.role } : {}),
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
    ...('label' in body ? { label: body.label ?? null } : {}),
    ...(typeof body.seedSource === 'string' ? { seedSource: body.seedSource } : {}),
  };

  try {
    const row = await projectRepoSetService.patchRow(rowId, input, ctx);
    return NextResponse.json(row);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId } = await params;
  try {
    // Idempotent by design in the service: removing an already-gone row is a
    // no-op, so a double-submit is 204 rather than a 404 the user cannot act on.
    await hostedRepositoryRemovalService.remove(rowId, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
