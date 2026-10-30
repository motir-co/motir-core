import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionPanelService } from '@/lib/services/productionPanelService';

// ROLL BACK a Motir repository's production (Story MOTIR-9797 · MOTIR-10036) to
// the release it replaced.
//
// POST → 200 ProductionPanelDto (the first page), so the panel re-renders from
// the response. The route does not pre-check permission: the rollback service is
// the authority, and its refusals map to 403 (not an administrator), 409 (no
// previous release, a release in progress, production moved meanwhile), 404 (a
// repository the viewer cannot have) and 502 (the provider failed — nothing
// changed). No session is 401.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ key: string; rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  try {
    return NextResponse.json(
      await productionPanelService.rollback({
        projectKey: key,
        projectRepositoryId: rowId,
        actor: ctx,
      }),
    );
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
