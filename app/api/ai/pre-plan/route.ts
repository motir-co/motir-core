import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { MotirAiError } from '@/lib/ai/errors';
import { InvalidDesignChoiceError } from '@/lib/ai/preplanErrors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/pre-plan (Subtask 7.3.70) — the resumable pre-plan read the
// discovery UI (7.3.5) loads its state from: the session strategy decisions +
// each artifact's forward revision log + the per-revision diffs, for the active
// project.
//
// Thin HTTP layer over aiPreplanService (CLAUDE.md 4-layer): read the session
// (getSession → 401) + the active-project context (getActiveProject, the project
// analogue of getSession — mirrors /api/ai/chat + /api/board), call ONE service
// method, map typed errors to status codes. No `db` / no `motir-ai` import here —
// the open-core boundary lives in the `server-only` client the service calls.
//
// Project comes from the active-project context (server-resolved within the
// actor's own workspace), never the client — so a cross-tenant project is
// unreachable; a null context is simply "no active project" → 404 (the
// no-existence-leak shape, finding #26). A not-yet-started pre-plan is NOT an
// error: motir-ai returns the empty state ({ session: null, docs: [] }) and this
// route serializes it as a 200. Only a motir-ai transport / upstream failure
// maps to 502 (the dependency failed, not the caller) — never a misleading empty.

// NOT rate-limited, deliberately (MOTIR-2597): this reads and writes the project's own pre-plan
// state, so no model job is submitted and no provider money is spent on this path. The AI
// ceiling guards the doors that SUBMIT; adding one here would only cap a database read.
export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  try {
    const state = await aiPreplanService.getPreplanState(ctx);
    return NextResponse.json(state, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    // Any motir-ai-side failure (unreachable / misconfigured / rejected) maps
    // through the 7.1.1 taxonomy to a typed error → 502: the upstream dependency
    // failed, not the caller's request.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}

// PATCH /api/ai/pre-plan (Subtask 7.3.81) — persist the onboarding design choice
// the user picked in the design step (MOTIR-1040), so re-entering the step (or
// resuming on a later visit) restores the saved look. Same thin HTTP layer +
// gates as the GET (getSession → 401, getActiveProject → 404 no-existence-leak),
// one service call.
//
// The body carries only `{ designChoice: { styleId, paletteId, typeId,
// backgrounds? } }` — the three axes and, optionally, a background id or `none`
// for each page area (MOTIR-11607). A malformed body (missing/!object/non-string
// axis, a backgrounds that is not three strings) is a 400 before the service
// runs; an axis or background whose id is not a registered id is a 422
// (InvalidDesignChoiceError — motir-core owns the registries). Only a
// motir-ai transport / upstream failure maps to 502. The Theme toggle is a
// preview mode, NOT an axis, and is never sent here.

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const body: unknown = await req.json().catch(() => null);
  const dc = (body as { designChoice?: unknown } | null)?.designChoice;
  if (
    !dc ||
    typeof dc !== 'object' ||
    Array.isArray(dc) ||
    typeof (dc as Record<string, unknown>).styleId !== 'string' ||
    typeof (dc as Record<string, unknown>).paletteId !== 'string' ||
    typeof (dc as Record<string, unknown>).typeId !== 'string' ||
    !isBackgroundsShape((dc as Record<string, unknown>).backgrounds)
  ) {
    return NextResponse.json(
      {
        code: 'INVALID_BODY',
        error:
          'Expected { designChoice: { styleId, paletteId, typeId, backgrounds?: { landing, login, hero } } }.',
      },
      { status: 400 },
    );
  }
  const axes = dc as {
    styleId: string;
    paletteId: string;
    typeId: string;
    backgrounds?: { landing: string; login: string; hero: string };
  };

  try {
    const designChoice = await aiPreplanService.saveDesignChoice(ctx, {
      styleId: axes.styleId,
      paletteId: axes.paletteId,
      typeId: axes.typeId,
      ...(axes.backgrounds === undefined
        ? {}
        : {
            backgrounds: {
              landing: axes.backgrounds.landing,
              login: axes.backgrounds.login,
              hero: axes.backgrounds.hero,
            },
          }),
    });
    return NextResponse.json(
      { designChoice },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    // An unknown axis id is the caller's bug (motir-core owns the registries) → 422.
    if (err instanceof InvalidDesignChoiceError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // Any motir-ai-side failure maps through the 7.1.1 taxonomy → 502.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}

// The optional per-area backgrounds (MOTIR-11607): absent, or an object holding a
// string for each of landing, login and hero. Only the SHAPE is checked here; the
// service validates each value against the background registry (→ 422).
function isBackgroundsShape(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.landing === 'string' && typeof v.login === 'string' && typeof v.hero === 'string';
}
