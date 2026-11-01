import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionPanelService } from '@/lib/services/productionPanelService';

// A Motir repository's PRODUCTION state (Story MOTIR-9797 · MOTIR-10036): its
// application, current and previous release, a newest-first page of release
// history, and whether the viewer may roll back.
//
// GET ?cursor=<opaque>&limit=<1..50> → 200 ProductionPanelDto. Open to anyone who
// can browse the project. A customer repository, another project's repository
// and one the viewer cannot see all answer 404; a malformed cursor or limit 400.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string; rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  const search = new URL(req.url).searchParams;
  const rawLimit = search.get('limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    return NextResponse.json(
      { error: { code: 'invalid_limit', message: '`limit` must be a whole number from 1.' } },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await productionPanelService.getProductionPanel({
        projectKey: key,
        projectRepositoryId: rowId,
        actor: ctx,
        cursor: search.get('cursor'),
        limit,
      }),
    );
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
