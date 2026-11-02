import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { parseRunRecordQuery } from '@/lib/runs/runRecordQuery';
import { runRecordReadService } from '@/lib/services/runRecordReadService';

// POST /api/internal/ai/search-run-records (MOTIR-10240) — which runs of the
// job's OWN project match a card (`workItemKey`), a scope (`scopeWorkItemKey`)
// or a status list (`statuses`), newest first, cursor-paginated. One row per run
// with its set as COUNTS, never its legs. The project is the TOKEN's
// (`auth.projectId`); no caller-supplied project exists.
//
// Thin transport: authenticate → validate the body → ONE service call. A search
// that matched no run is 200 `outcome: nothing_matched`, never a 404 — the
// consumer is a model, and "no run did that" is an answer. A project the token's
// user cannot browse maps as `search-work-items` maps it (404 browse / 403 edit).

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
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
    return fail('RUN_RECORD_QUERY_INVALID', 'request body must be valid JSON', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('RUN_RECORD_QUERY_INVALID', 'request body must be a JSON object', 400);
  }
  const parsed = parseRunRecordQuery(body as Record<string, unknown>);
  if (!parsed.ok) return fail('RUN_RECORD_QUERY_INVALID', parsed.error, 400);

  try {
    const result = await runRecordReadService.searchRuns(auth.projectId, parsed.filters, auth.ctx);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return fail(err.code, err.message, 404);
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    throw err;
  }
}
