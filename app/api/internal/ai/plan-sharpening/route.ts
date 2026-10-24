import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import type { SubmittedRequirement } from '@/lib/ai/types';
import { isRecommendationList } from '@/lib/sharpening/requirement';
import type {
  PlannerAssumptionDto,
  SharpeningPerItemInput,
  SharpeningScope,
  SharpeningWriteBackInput,
} from '@/lib/dto/plans';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { planSharpeningService } from '@/lib/services/planSharpeningService';
import { SharpeningInputInvalidError, SharpeningPlanClosedError } from '@/lib/sharpening/errors';

// PUT /api/internal/ai/plan-sharpening (Task MOTIR-1101 · Subtask MOTIR-8175) —
// the door motir-ai's grilling session writes the answers a person SETTLED
// through: onto a plan's `sharpenedRequirement` and its `add` proposals'
// bodies. There is no work-item scope (retired, MOTIR-9314): Motir AI never edits
// a committed card as the person — a change to one reaches it through the plan
// the person approves. The body is `SharpeningWriteBackInput`, carrying
// the CUMULATIVE state; the write is idempotent (`planSharpeningService`).
//
// Service-to-service only (§4a service bearer + §4b job token), acting as the
// token's user — the same surface as the plan-proposals internal door, because
// the grilling session is a motir-ai job and a cookie route is unreachable from
// it. Thin transport: authenticate, parse, ONE service call, map errors.
//
// Typed errors → status (problem JSON `{ code, message }`):
//   JobAuthError                          → 401
//   malformed body / scope / jobId        → 400 SHARPENING_INVALID
//                                           (a `{ workItemKey }` scope included)
//   ProjectNotFoundError / PermissionDeniedError
//                                         → 404 / 403 (the plan gate, `ai:view_plan`)
//   ProjectAccessDeniedError              → 404 browse / 403
//   PlanNotFoundError                     → 404
//   SharpeningPlanClosedError             → 409 SHARPENING_PLAN_CLOSED
//   SharpeningInputInvalidError           → 422 SHARPENING_INPUT_INVALID
export async function PUT(req: Request): Promise<Response> {
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
    return invalid('request body must be valid JSON');
  }
  const parsed = parseInput(body);
  if (typeof parsed === 'string') return invalid(parsed);

  try {
    return NextResponse.json(await planSharpeningService.writeBack(parsed, auth.ctx));
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof PlanNotFoundError) return problem(err.code, err.message, 404);
    if (err instanceof ProjectAccessDeniedError) {
      return problem(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    if (err instanceof SharpeningPlanClosedError) return problem(err.code, err.message, 409);
    if (err instanceof SharpeningInputInvalidError) {
      return problem(err.code, err.message, 422);
    }
    throw err;
  }
}

function problem(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message, error: message }, { status });
}

function invalid(message: string): NextResponse {
  return problem('SHARPENING_INVALID', message, 400);
}

const REQUIREMENT_PARTS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
  'assumptions',
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** The body as `SharpeningWriteBackInput`, or the reason it is not one. */
function parseInput(body: unknown): SharpeningWriteBackInput | string {
  if (!isObject(body)) return 'request body must be a JSON object';
  if (typeof body.jobId !== 'string' || !body.jobId) return '`jobId` is required.';

  const s = body.scope;
  if (!isObject(s) || typeof s.planId !== 'string' || !s.planId || Object.keys(s).length !== 1) {
    return '`scope` must be `{ planId }`.';
  }
  const scope: SharpeningScope = { planId: s.planId };

  const r = body.requirement ?? {};
  if (!isObject(r)) return '`requirement` must be an object.';
  const requirement: Partial<SubmittedRequirement> = {};
  for (const part of REQUIREMENT_PARTS) {
    if (r[part] === undefined) continue;
    if (part === 'assumptions') {
      // A list of `{ id?, text }` (MOTIR-9160) — or a string from a sender that
      // predates the list, which stays one recommendation.
      if (typeof r[part] === 'string') requirement[part] = r[part];
      else if (isRecommendationList(r[part])) requirement[part] = r[part];
      else return '`requirement.assumptions` must be a list of `{ id?, text }` or a string.';
      continue;
    }
    if (typeof r[part] !== 'string') return `\`requirement.${part}\` must be a string.`;
    requirement[part] = r[part];
  }

  const pa = body.plannerAssumptions ?? [];
  if (!Array.isArray(pa)) return '`plannerAssumptions` must be a list.';
  const plannerAssumptions: PlannerAssumptionDto[] = [];
  for (const a of pa) {
    if (!isObject(a) || typeof a.question !== 'string' || typeof a.recommendation !== 'string') {
      return 'each planner assumption needs a `question` and a `recommendation`.';
    }
    plannerAssumptions.push({ question: a.question, recommendation: a.recommendation });
  }

  let perItem: SharpeningPerItemInput[] | undefined;
  if (body.perItem !== undefined) {
    if (!Array.isArray(body.perItem)) return '`perItem` must be a list.';
    perItem = [];
    for (const p of body.perItem) {
      if (
        !isObject(p) ||
        typeof p.planItemId !== 'string' ||
        !isStringList(p.acceptance ?? []) ||
        !isStringList(p.assumptions ?? [])
      ) {
        return 'each `perItem` needs a `planItemId` and string lists `acceptance` / `assumptions`.';
      }
      perItem.push({
        planItemId: p.planItemId,
        acceptance: (p.acceptance ?? []) as string[],
        assumptions: (p.assumptions ?? []) as string[],
      });
    }
  }

  return {
    jobId: body.jobId,
    scope,
    requirement,
    plannerAssumptions,
    ...(perItem ? { perItem } : {}),
  };
}
