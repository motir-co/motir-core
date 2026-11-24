import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionHealthService } from '@/lib/services/productionHealthService';

// A Motir repository's PRODUCTION HEALTH (Story MOTIR-9799 · MOTIR-12106): its
// application's one health state, when it began, the probe condition beside it,
// and its crash events, newest first, each with its masked last log lines.
//
// GET → 200 ProductionHealthDto `{ state, since, condition, events }`, `state`
// null before a first release is probed. Open to anyone who can browse the
// project. A customer repository, another project's repository and one the
// viewer cannot see all answer 404 `repository_not_found`.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  try {
    return NextResponse.json(await productionHealthService.getHealthForRepository(key, rowId, ctx));
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
