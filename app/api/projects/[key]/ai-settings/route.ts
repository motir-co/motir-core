import { NextResponse } from 'next/server';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import type { UpdateProjectAiSettingsInput } from '@/lib/dto/projectAiSettings';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET / PATCH /api/projects/[key]/ai-settings (Story 7.13 · Subtask MOTIR-919)
// Read or admin-update a project's AI-planning configuration — the auto-plan
// cadence, the AI sprint packing, the planner-model override, the Story-7.4
// drafted-explanations opt-in and the MOTIR-3331 record-planning-mistakes switch
// the same panel surfaces. The HTTP surface for the
// MOTIR-915 service, which is its single entry point: no route touches Prisma
// for these fields.
//
// Thin transport per CLAUDE.md — read the session context, call ONE service
// method, map typed errors. The service resolves the project by its
// workspace-unique `key` itself (alias-blind, tenant-scoped), so unlike the
// estimation-config route there is no separate `getByKey` hop: a cross-workspace
// or never-existed key reads as a 404 with no existence leak.
//
// Typed errors → status codes (all via the shared `projectErrorResponse`):
//   ProjectNotFoundError    → 404  (missing / cross-tenant / non-browsable)
//   PermissionDeniedError (ai:configure) → 403  (PATCH — a member may READ but not change)
//   InvalidAiSettingsError  → 422  (out-of-range threshold / sprint length, or a
//                                   malformed planner-model override; the body
//                                   carries `field` so the panel can slot the
//                                   message under the offending control)

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  try {
    const settings = await projectAiSettingsService.getAiSettings(key, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
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

  // Forward only the PRESENT keys — the patch is partial by contract (an absent
  // field is left untouched), and the service owns every value check, so the
  // route stays a transport. `in` (not a truthiness test) so `false` / `0` /
  // `null` are forwarded rather than dropped. A key this route does not name is
  // IGNORED, never a 400 — so a stale client still sending the retired planner
  // model (MOTIR-7228) saves the rest of its patch.
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateProjectAiSettingsInput = {};
  if ('aiAutoPlanEnabled' in raw) {
    patch.aiAutoPlanEnabled = raw.aiAutoPlanEnabled as boolean;
  }
  if ('aiAutoPlanThreshold' in raw) {
    patch.aiAutoPlanThreshold = raw.aiAutoPlanThreshold as number;
  }
  if ('aiSprintPlanningEnabled' in raw) {
    patch.aiSprintPlanningEnabled = raw.aiSprintPlanningEnabled as boolean;
  }
  if ('aiSprintLengthDays' in raw) {
    patch.aiSprintLengthDays = raw.aiSprintLengthDays as number;
  }
  if ('aiGenerateExplanations' in raw) {
    patch.aiGenerateExplanations = raw.aiGenerateExplanations as boolean;
  }
  if ('aiRecordPlanningMistakes' in raw) {
    patch.aiRecordPlanningMistakes = raw.aiRecordPlanningMistakes as boolean;
  }
  if ('aiFinalCheck' in raw) {
    patch.aiFinalCheck = raw.aiFinalCheck as boolean;
  }

  try {
    const settings = await projectAiSettingsService.updateAiSettings(key, patch, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
