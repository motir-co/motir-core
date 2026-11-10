import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { isOrgRunModelKey, ORG_RUN_MODEL_KEYS } from '@/lib/dto/orgAiModels';
import { mapOrgAiModelsError } from '@/lib/organizations/aiModelsErrorResponse';
import { orgRunModelOverrideService } from '@/lib/services/orgRunModelOverrideService';

// /api/organizations/[orgId]/ai-models/runs (story MOTIR-10838 · MOTIR-10850) — the
// org's own hosted-run models: a default per difficulty, the review agent and the
// design run. Thin HTTP layer, the sibling of `../planning`: 401 without a session,
// 400 for a bad body, then one service call; the service owns the member /
// owner-admin gates (404 non-member, 403 member), the closing guard (409), the tier
// and the run-model offer.

// GET — every member reads; always 200 with its `state` (ready · locked · unreadable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  try {
    const models = await orgRunModelOverrideService.read({
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

// PATCH — `{ key, model: string | null }`, one row per call; owner or admin only.
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
  const { key, model } = body as Record<string, unknown>;
  if (!isOrgRunModelKey(key)) {
    return badRequest(`\`key\` must be one of ${ORG_RUN_MODEL_KEYS.join(', ')}.`);
  }
  if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
    return badRequest('`model` must be a model id or null.');
  }

  try {
    const change = await orgRunModelOverrideService.write({
      organizationId: orgId,
      actorUserId: gate.session.user.id,
      key,
      model,
    });
    return NextResponse.json(change);
  } catch (err) {
    const mapped = mapOrgAiModelsError(err);
    if (mapped) return mapped;
    throw err;
  }
}
