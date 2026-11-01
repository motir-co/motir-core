import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { planValidityService } from '@/lib/services/planValidityService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ValidityCondition } from '@/lib/dto/sprints';

// POST /api/internal/ai/validate-plan-forest (MOTIR-1550) — the WHOLE-PLAN
// (forest) analogue of the pre-commit finishability check. Body
// `{ planId, condition? }` (NO targetKey — it validates the ENTIRE projected
// forest, not one subtree) → `planValidityService.validateProjectedPlan` → the
// `{ planId, valid, rejections, blockers, … }` validity DTO, plus `advisories`.
// This is the entry the `generate_tree` /replan worker (MOTIR-1398) runs as its pre-commit post-condition over the
// multi-root epic forest it proposes: a cross-root `blocked_by` edge (a story
// under epic B gated by a story under epic A) is VALID here, whereas iterating
// the single-target `validate-plan` per root would false-positive it.
//
// ⚠️ IT INHERITS THE APPROVABILITY HALF (MOTIR-3575) — deliberately, and because
// this is a thin transport nothing here changed. `valid` now means BOTH *approve
// would accept it* and *every item can be finished*, and `rejections` carries the
// first reason approve would refuse. That is what the generator's pre-commit
// post-condition wants: it runs this immediately before closing a plan, and a
// plan closed on a `valid: true` that only meant finishable is exactly the dead
// plan MOTIR-3560 reported.
//
// ⚠️ AND IT ANSWERS THE SHAPE ADVISORIES BESIDE THE VERDICT (MOTIR-9873, widened
// by MOTIR-10087): `{ ...verdict, advisories }`, the same shape the PAT
// `validate_plan` tool answers. `advisories` lists every `kind: 'shape'` entry on
// a card the plan PROPOSES or modifies (`planValidityService.projectedShapeAdvisories`)
// and never changes `valid`. motir-ai's forest close (`generate_tree` /
// `revise_plan`) reads it to re-open the phase on a link that opens the wrong
// card (MOTIR-9820) and on a criterion-indexed shape entry — the
// self-blocking design a runner reads as LIFT and stops on (MOTIR-10087);
// without it that close read the field as absent and sealed the card.
//
// Read-only, server-to-server only (§4a service bearer + §4b job-scoped token,
// via authenticateJobRequest) — never reachable from the browser and NEVER
// touches the write path. Thin transport, mirroring `validate-plan-sprint`:
// authenticate, parse, the verdict and its advisories (one service, read side by
// side), map typed errors.
//
// Typed errors → status:
//   JobAuthError              → 401
//   (bad/missing body, unknown condition) → 400
//   PlanNotFoundError         → 404
//   ProjectNotFoundError      → 404
//   ProjectAccessDeniedError  → 404 (no existence leak)
export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'request body must be an object' },
      { status: 400 },
    );
  }
  const { planId, condition } = body as Record<string, unknown>;
  if (typeof planId !== 'string' || planId.length === 0) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'planId is required' },
      { status: 400 },
    );
  }
  if (condition !== undefined && condition !== 'loose' && condition !== 'tight') {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: "condition must be 'loose' or 'tight'" },
      { status: 400 },
    );
  }

  try {
    // A SYSTEM caller (MOTIR-6330): motir-ai validating a plan its own job
    // wrote, so the Plans room's reader scope does not apply — browse only.
    const opts = { caller: 'system' } as const;
    // In turn, not `Promise.all`: an unknown plan rejects the verdict while the
    // advisories read still holds a transaction open, and the 404 would answer
    // before that read settled.
    const result = await planValidityService.validateProjectedPlan(
      planId,
      auth.ctx,
      condition as ValidityCondition | undefined,
      opts,
    );
    const advisories = await planValidityService.projectedShapeAdvisories(planId, auth.ctx, opts);
    // The `modify`s approve will send back from built work (MOTIR-10106), beside
    // the verdict — informational, never a reason to re-open the phase.
    const rescopeWarnings = await planValidityService.projectedRescopeWarnings(
      planId,
      auth.ctx,
      opts,
    );
    return NextResponse.json({ ...result, advisories, rescopeWarnings });
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
