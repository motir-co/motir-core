import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { parseProductionLogQuery } from '@/lib/hosting/productionLogQuery';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionLogsService } from '@/lib/services/productionLogsService';

// A Motir repository's PRODUCTION LOGS (Story MOTIR-9799 · MOTIR-12105): one page
// of the current release's output, newest first, every production secret value
// masked.
//
// GET ?since=<ISO>&until=<ISO>&q=<text>&limit=<1..1000>&cursor=<opaque>
//   → 200 ProductionLogsDto `{ lines, cursor, state }`, `state` one of `ok` ·
//   `no_release` · `unavailable` (the target could not answer — still a 200).
// Open to anyone who can browse the project. A customer repository, another
// project's repository and one the viewer cannot see all answer 404; a
// malformed range, limit or cursor 400. A limit past 1000 is clamped.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string; rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  const search = new URL(req.url).searchParams;
  try {
    const query = parseProductionLogQuery({
      since: search.get('since'),
      until: search.get('until'),
      q: search.get('q'),
      limit: search.get('limit'),
      cursor: search.get('cursor'),
    });
    return NextResponse.json(
      await productionLogsService.readProductionLogs({
        projectKey: key,
        projectRepositoryId: rowId,
        actor: ctx,
        query,
      }),
    );
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
