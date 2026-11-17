import { NextResponse } from 'next/server';
import type { ZodError, ZodType, z } from 'zod';
import {
  MotirAiBadRequestError,
  MotirAiConflictError,
  MotirAiUnavailableError,
  PlannerFindingNotFoundError,
  PlannerFindingRecordNotFoundError,
} from '@/lib/ai/errors';
import { NotPlatformStaffError, PlannerFindingInvalidError } from '@/lib/platform/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

/**
 * The `/api/platform/planner-findings/**` routes' transport helpers (Story
 * MOTIR-11455 · MOTIR-11458), shaped like the ideas routes' (`lib/ideas/routeErrors.ts`):
 * one error map over everything the gate, the parsers and the records service
 * throw, and one body / query parser — so five handlers cannot drift apart on a
 * status code. Every response carries `Cache-Control: no-store`: these are a
 * staff member's reads of cross-tenant data.
 *
 * Every gate refusal is `{ code: 'NOT_FOUND' }` 404, exactly as the ideas routes
 * answer it, so a caller cannot tell an unknown route from a refused one.
 *
 * An error this map does not know is RE-THROWN, so Next answers 500 and the
 * defect is visible rather than disguised as a 4xx.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function plannerFindingsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A malformed request, before any service is called. */
class BadPlannerFindingsRequest extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super('Invalid request');
  }
}

function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Parse a JSON body against `schema`, or throw the 400 the map renders. */
export async function parsePlannerFindingsBody<S extends ZodType>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadPlannerFindingsRequest([{ path: '', message: 'body must be JSON' }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadPlannerFindingsRequest(zodIssues(parsed.error));
  return parsed.data;
}

/** Parse a URL's search params against `schema` (repeated keys keep their last value). */
export function parsePlannerFindingsQuery<S extends ZodType>(req: Request, schema: S): z.infer<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new BadPlannerFindingsRequest(zodIssues(parsed.error));
  return parsed.data;
}

/** Map a thrown error to its response, or re-throw it. */
export function plannerFindingsErrorResponse(err: unknown): NextResponse {
  if (err instanceof NotPlatformStaffError) return plannerFindingsJson({ code: 'NOT_FOUND' }, 404);
  if (err instanceof BadPlannerFindingsRequest) {
    return plannerFindingsJson({ code: 'INVALID_REQUEST', issues: err.issues }, 400);
  }
  if (err instanceof PlannerFindingInvalidError) {
    return plannerFindingsJson(
      { code: 'INVALID_REQUEST', issues: [{ path: err.field ?? '', message: err.detail }] },
      400,
    );
  }
  if (err instanceof PlannerFindingNotFoundError) {
    return plannerFindingsJson({ code: err.code, findingId: err.findingId }, 404);
  }
  if (err instanceof PlannerFindingRecordNotFoundError) {
    return plannerFindingsJson({ code: err.code, recordId: err.recordId }, 404);
  }
  // A `projectKey` the staff member cannot browse, or browses without `ai:plan`,
  // is the same 404: the tenant rule is 404-not-403, so it leaks no existence.
  if (err instanceof ProjectNotFoundError || err instanceof PermissionDeniedError) {
    return plannerFindingsJson({ code: 'PROJECT_NOT_FOUND' }, 404);
  }
  // motir-ai's own refusal of the content — it names the field or the problem.
  if (err instanceof MotirAiBadRequestError) {
    return plannerFindingsJson({ code: 'UPSTREAM_REJECTED', detail: err.detail }, 400);
  }
  if (err instanceof MotirAiConflictError) {
    return plannerFindingsJson({ code: 'CONFLICT', detail: err.detail }, 409);
  }
  if (err instanceof MotirAiUnavailableError) {
    return plannerFindingsJson({ code: 'UPSTREAM_UNAVAILABLE' }, 503);
  }
  throw err;
}
