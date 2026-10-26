import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  PLAN_PROVIDER_RETRY_ATTEMPTS_MAX,
  type PlanProviderRetryInput,
} from '@/lib/services/plansService';
import {
  InvalidPlanStepError,
  NoPlanForJobError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';

// POST /api/internal/ai/plan-step (Story MOTIR-7820 · Subtask MOTIR-7824) — the
// HOSTED planner's door onto the plan's in-flight STEPS: motir-ai's walk reports
// the step each of its sessions opens (`settle`, `lay`, `author`) and clears it
// with `end`, so a person following the plan sees what is being drafted now.
// `report_plan_step` is the MCP twin, with the same four values.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// exactly as `plan-proposals` and `plan-revision-reason`.
//
// ⚠️ THE PLAN IS THE JOB'S. `planId` is accepted and CROSS-CHECKED, never used
// as the address, and a mismatch gets the same 404 a foreign job gets.
//
// ⚠️ `target` IS OPTIONAL ON EVERY STEP HERE. Whether a step may carry one — and
// the two untargeted forms a walk really has, the project-level lay and the
// no-id create — is the step store's rule, and a refusal of it comes back as its
// 422. Checking "target required" here would be a second copy of that rule, and
// the copy that refuses real steps.
//
// NARRATION (Story MOTIR-8060 · MOTIR-8062): the body may carry
// `narration: string[]` — the session's own plain-language sentences — INSTEAD
// of `step`, never with it and never with a `target`. They are appended to the
// plan's kept history; the caps and the "session holds a step" rule are the
// store's (`plansService.recordPlanNarration`).
//
// PROVIDER RETRY (Story MOTIR-9540 · MOTIR-9619): the body may carry
// `providerRetry` INSTEAD — `{ state: 'waiting', attempt, maxAttempts, retryAt }`
// when a model call starts waiting out a provider limit (`attempt` the retry
// about to be made, integers in 1..20 with `attempt ≤ maxAttempts`, `retryAt` an
// ISO-8601 time core clamps to the next 15 minutes), or `{ state: 'cleared' }`
// on every way out of that wait. It names no `target`, it never touches the
// session's step, and it answers `{ planId, providerWait }` (`null` once
// cleared). Exactly one of `step` / `narration` / `providerRetry` is sent.
//
// The signal is ADVISORY, so every refusal is a stable `{ code, error }` and
// never a 500: the walk matches the code and carries on.
//
// Typed errors → status:
//   JobAuthError                          → 401 (bad service bearer / missing-expired token)
//   PLAN_STEP_INVALID (body shape)        → 400
//   NoPlanForJobError / PlanNotFoundError → 404 (no plan for this job in the token's
//                                                project and tenant, or a mismatched planId)
//   PlanNotGeneratingError                → 409 (the plan is not being written any more)
//   InvalidPlanStepError                  → 422 (a target the step may not carry, or a
//                                                ref naming nothing on this plan)
//   the plan gate's refusals              → `aiPlanGateErrorResponse`, as `plan-proposals`

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

const INVALID = 'PLAN_STEP_INVALID';
const STEPS = ['settle', 'lay', 'author', 'end'] as const;
type Step = (typeof STEPS)[number];

function isStep(v: unknown): v is Step {
  return typeof v === 'string' && (STEPS as readonly string[]).includes(v);
}

function isAttempt(v: unknown): v is number {
  return (
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PLAN_PROVIDER_RETRY_ATTEMPTS_MAX
  );
}

/** Why a `providerRetry` body is the wrong shape, or `null` when it is right. */
function providerRetryRefusal(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return '`providerRetry` must be an object.';
  }
  const { state, attempt, maxAttempts, retryAt } = v as Record<string, unknown>;
  if (state === 'cleared') return null;
  if (state !== 'waiting') return '`providerRetry.state` must be one of: waiting, cleared.';
  if (!isAttempt(attempt) || !isAttempt(maxAttempts)) {
    return `\`attempt\` and \`maxAttempts\` must be integers in 1..${PLAN_PROVIDER_RETRY_ATTEMPTS_MAX}.`;
  }
  if (attempt > maxAttempts) return '`attempt` must not exceed `maxAttempts`.';
  if (typeof retryAt !== 'string' || Number.isNaN(Date.parse(retryAt))) {
    return '`retryAt` must be an ISO-8601 time.';
  }
  return null;
}

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
    return fail(INVALID, 'request body must be valid JSON', 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const { jobId, planId, sessionKey, step, target } = b;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail(INVALID, '`jobId` is required.', 400);
  }
  if (planId != null && typeof planId !== 'string') {
    return fail(INVALID, '`planId` must be a string.', 400);
  }
  if (typeof sessionKey !== 'string') {
    return fail(INVALID, '`sessionKey` is required and must be a string.', 400);
  }
  const { narration, providerRetry } = b;
  const forms = [step, narration, providerRetry].filter((form) => form !== undefined).length;
  if (forms !== 1) {
    return fail(INVALID, 'Send exactly one of `step`, `narration` or `providerRetry`.', 400);
  }
  if (step !== undefined && !isStep(step)) {
    return fail(INVALID, `\`step\` must be one of: ${STEPS.join(', ')}.`, 400);
  }
  if (target != null && typeof target !== 'string') {
    return fail(INVALID, '`target` must be a string.', 400);
  }
  if (narration !== undefined) {
    if (!Array.isArray(narration) || narration.some((s) => typeof s !== 'string')) {
      return fail(INVALID, '`narration` must be an array of strings.', 400);
    }
    if (target != null) {
      return fail(INVALID, 'A `narration` call names no `target`.', 400);
    }
  }

  if (providerRetry !== undefined) {
    const refusal = providerRetryRefusal(providerRetry);
    if (refusal) return fail(INVALID, refusal, 400);
    if (target != null) {
      return fail(INVALID, 'A `providerRetry` call names no `target`.', 400);
    }
  }

  try {
    const result = await aiGenerationService.recordPlanStepForJob(
      {
        jobId,
        planId: (planId as string | undefined) ?? null,
        sessionKey,
        targetRef: (target as string | undefined) ?? null,
        ...(step !== undefined ? { step: step as Step } : {}),
        ...(narration !== undefined ? { narration: narration as string[] } : {}),
        ...(providerRetry !== undefined
          ? { providerRetry: providerRetry as PlanProviderRetryInput }
          : {}),
      },
      auth,
    );
    return NextResponse.json(result);
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof PlanNotGeneratingError) {
      return fail(err.code, err.message, 409);
    }
    if (err instanceof InvalidPlanStepError) {
      return fail(err.code, err.message, 422);
    }
    throw err;
  }
}
