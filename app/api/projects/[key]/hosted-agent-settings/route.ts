import { NextResponse } from 'next/server';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import type { UpdateProjectHostedAgentSettingsInput } from '@/lib/dto/projectHostedAgentSettings';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET / PATCH /api/projects/[key]/hosted-agent-settings (Story MOTIR-6989 ·
// MOTIR-6993) — the model a hosted run uses for each leaf difficulty: the
// project's overrides, motir-ai's platform defaults and the effective model.
//
// Thin transport per CLAUDE.md — the session context, ONE service call, typed
// errors mapped:
//   ProjectNotFoundError          → 404 (missing / cross-tenant / non-browsable)
//   PermissionDeniedError         → 403 (PATCH without `ai:configure`)
//   HostedModelNotOfferedError    → 422 HOSTED_MODEL_NOT_OFFERED (nothing written)
//   HostedModelsUnavailableError  → 503 HOSTED_MODELS_UNAVAILABLE (motir-ai unreachable)

interface RouteParams {
  params: Promise<{ key: string }>;
}

function errorResponse(err: unknown): Response | null {
  if (err instanceof HostedModelNotOfferedError) {
    return NextResponse.json(
      { code: 'HOSTED_MODEL_NOT_OFFERED', error: err.message, model: err.model },
      { status: 422 },
    );
  }
  if (err instanceof HostedModelsUnavailableError) {
    return NextResponse.json(
      {
        code: 'HOSTED_MODELS_UNAVAILABLE',
        error: 'The models a Motir agent run may use could not be read. Try again shortly.',
      },
      { status: 503 },
    );
  }
  return projectErrorResponse(err);
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key } = await params;
  try {
    return NextResponse.json(await projectHostedAgentSettingsService.get(key, gate.ctx), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    const res = errorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // Forward only the PRESENT levels — the patch is partial, and `null` (a reset)
  // must be forwarded rather than dropped. The service owns every value check.
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateProjectHostedAgentSettingsInput = {};
  for (const level of WORK_ITEM_DIFFICULTIES) {
    if (level in raw) patch[level] = raw[level] as string | null;
  }

  try {
    return NextResponse.json(await projectHostedAgentSettingsService.update(key, patch, gate.ctx));
  } catch (err) {
    const res = errorResponse(err);
    if (res) return res;
    throw err;
  }
}
