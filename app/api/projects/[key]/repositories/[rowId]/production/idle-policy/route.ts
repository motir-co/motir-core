import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { parseIdlePolicy } from '@/lib/hosting/idlePolicy';
import { productionRouteErrorResponse } from '@/lib/hosting/productionPanelErrors';
import { productionPanelService } from '@/lib/services/productionPanelService';

// A Motir repository's production IDLE POLICY (Story MOTIR-9799 · MOTIR-12107):
// always on, or suspend after a quiet window.
//
// GET → 200 IdlePolicyDto `{ policy, editable, refusal }`. Open to anyone who can
// browse the project; `editable` is true for a project administrator. A
// repository with no production application yet answers `policy: null`.
//
// PUT `{ mode: 'always_on' }` | `{ mode: 'suspend', idleSeconds? }` → 200
// IdlePolicyDto, once the serving release runs the new policy (it is redeployed
// with no build) or, with nothing serving, once it is stored. The route does not
// pre-check permission: the idle-policy service is the authority. Refusals: 400
// (a malformed policy), 403 (not an administrator), 409
// `HOSTING_IDLE_POLICY_UNSUPPORTED` (the target and shape cannot run it, named in
// `details`), 409 `release_in_progress`, 409 `no_application`, 404 (a
// repository the viewer cannot have, or a customer one), 502 (the redeploy
// failed — nothing changed). No session is 401.

type Params = { params: Promise<{ key: string; rowId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  try {
    return NextResponse.json(
      await productionPanelService.getIdlePolicy({
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

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, rowId } = await params;
  try {
    const body: unknown = await req.json().catch(() => null);
    return NextResponse.json(
      await productionPanelService.setIdlePolicy({
        projectKey: key,
        projectRepositoryId: rowId,
        actor: ctx,
        policy: parseIdlePolicy(body),
      }),
    );
  } catch (err) {
    const mapped = productionRouteErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
