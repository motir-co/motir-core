import { NextResponse } from 'next/server';
import { hostedRepositoryRemovalService } from '@/lib/services/hostedRepositoryRemovalService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// WHAT REMOVING A MOTIR-HOSTED ROW WOULD DELETE (bug MOTIR-11979 · MOTIR-11981;
// design/repository-set §19.4).
//
//   GET → 200 HostedRepositoryRemovalDto — the row's blast radius: whether its
//         repository still exists on GitHub, production and its custom domains,
//         the open previews, the environment values and the open work items that
//         target it. The confirm reads it when it opens and never guesses.
//
//   409 PROJECT_REPO_REMOVAL_BLOCKED while a takeover hand-off is in flight;
//   502 HOSTED_REPOSITORY_CHECK_FAILED when GitHub cannot say whether the
//   repository exists — the confirm shows Check again and nothing can be confirmed.
//
// Read-only. The DELETE beside it (`../route.ts`) is the act.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId } = await params;
  try {
    return NextResponse.json(await hostedRepositoryRemovalService.getRemovalImpact(rowId, ctx));
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
