import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { isOrgPlannerFunction, ORG_PLANNER_FUNCTIONS } from '@/lib/dto/orgAiModels';
import { mapOrgAiModelsError } from '@/lib/organizations/aiModelsErrorResponse';
import { orgPlannerModelOverrideService } from '@/lib/services/orgPlannerModelOverrideService';

// /api/organizations/[orgId]/ai-models/planning (story MOTIR-10838 · MOTIR-10845) —
// the org's own Planning, Guide, Debug and Ask models. Thin HTTP layer: 401 without
// a session, 400 for a bad body, then one service call; the service owns the member
// / owner-admin gates (404 non-member, 403 member), the closing guard (409) and the
// motir-ai call.

// GET — every member reads; always 200 with its `state` (ready · locked · unreadable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  try {
    const models = await orgPlannerModelOverrideService.read({
      organizationId: orgId,
      actorUserId: gate.session.user.id,
    });
    return NextResponse.json(models);
  } catch (err) {
    const mapped = mapOrgAiModelsError(err);
    if (mapped) return mapped;
    throw err;
  }
}

const badRequest = (error: string) =>
  NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });

// PATCH — `{ function, model: string | null }`; owner or admin only.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected a JSON body.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('Expected a JSON object.');
  }
  const { function: fn, model } = body as Record<string, unknown>;
  if (!isOrgPlannerFunction(fn)) {
    return badRequest(`\`function\` must be one of ${ORG_PLANNER_FUNCTIONS.join(', ')}.`);
  }
  if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
    return badRequest('`model` must be a model id or null.');
  }

  try {
    const change = await orgPlannerModelOverrideService.write({
      organizationId: orgId,
      actorUserId: gate.session.user.id,
      function: fn,
      model,
    });
    return NextResponse.json(change);
  } catch (err) {
    const mapped = mapOrgAiModelsError(err);
    if (mapped) return mapped;
    throw err;
  }
}
