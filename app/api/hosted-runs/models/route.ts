import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { hostedRunPickerService } from '@/lib/services/hostedRunPickerService';

// GET /api/hosted-runs/models (MOTIR-6483) — the models the Run hosted picker
// offers, and the one it preselects (`docs/decisions/hosted-agent-run.md` §7).
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate (401 signed
// out), ONE service call, and the answer. Any signed-in member of a workspace may
// read it: the list is one list for everyone, and it carries no tenant data.
//
// ⚠️ UNAVAILABLE IS A 503 WITH A STABLE CODE, NEVER A 200 WITH AN EMPTY LIST.
// The picker disables Run hosted and says why on this code; an empty list would
// tell the person no model exists while motir-ai is merely unreachable.
//
// `?workItem=<KEY>` (Story MOTIR-6989 · MOTIR-6996) adds `resolved` — the card's
// preselection from its difficulty, and why — or `resolved: null` where it cannot
// be told (a key the caller cannot browse reads exactly like one that names
// nothing). Without it the answer is unchanged.
//
// Each model carries `capacity` (Story MOTIR-9541 · MOTIR-9629): `{ verdict:
// 'available' }` or `{ verdict: 'no_capacity', reason }` — the verdict and its reason
// code only, never a counter, limit, share or tenant identifier, so the field is
// tenant-safe by construction. A failed capacity read reads every model available.
export async function GET(request: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const workItem = new URL(request.url).searchParams.get('workItem')?.trim() || null;
  const offered = await hostedRunPickerService.readModels(workItem, gate.ctx);
  if (offered.state === 'unavailable') {
    return NextResponse.json(
      {
        code: 'hosted_models_unavailable',
        error: 'The models a hosted run may use could not be read. Try again shortly.',
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  return NextResponse.json(
    {
      models: offered.models,
      default: offered.default,
      ...(offered.resolved !== undefined ? { resolved: offered.resolved } : {}),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
