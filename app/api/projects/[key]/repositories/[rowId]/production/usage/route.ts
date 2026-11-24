import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionUsageService } from '@/lib/services/productionUsageService';

// A Motir repository's PRODUCTION USAGE THIS PERIOD (Story MOTIR-9799 ·
// MOTIR-12108; Decision MOTIR-12100): its application's usage per unit, its
// credits, whether Motir's own cost was recorded, and its state.
//
// GET → 200 ProductionUsageDto `{ period: { start, end }, usage: [{ unit,
// quantity, credits }], credits, motirCostRecorded, state, exhausted }`, `state`
// one of `ok`, `no_release` (no release yet, no usage) and `credits_exhausted`.
// Open to anyone who can browse the project. A customer repository, another
// project's repository and one the viewer cannot see all answer 404
// `repository_not_found`. Motir's own cost is never in the body.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; rowId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  try {
    return NextResponse.json(await productionUsageService.getUsageForRepository(key, rowId, ctx));
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
