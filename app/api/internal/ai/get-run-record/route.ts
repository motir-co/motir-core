import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { runRecordReadService } from '@/lib/services/runRecordReadService';

// POST /api/internal/ai/get-run-record (MOTIR-10240) — one run of the job's OWN
// project: how it ended (status, stop reason, end time, the hosted end line) and,
// per leg, its card key, disposition, skip reason, exit code and what it
// recorded as different (the discrepancy comment's body, bounded).
//
// ⚠️ ONE `not_found` FOR EVERY ABSENCE, at 200. An unknown id, a run of another
// project or workspace, and a run the reader may not see all answer
// `{ result: { outcome: 'not_found' } }`, so the route never confirms a run exists
// elsewhere and the motir-ai tool never reads an HTTP status to learn an absence.

function fail(error: string): NextResponse {
  return NextResponse.json({ code: 'RUN_RECORD_QUERY_INVALID', error }, { status: 400 });
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
    return fail('request body must be valid JSON');
  }
  const runId =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)['runId']
      : undefined;
  if (typeof runId !== 'string' || runId.trim() === '') return fail('`runId` is required.');

  const result = await runRecordReadService.readRun(auth.projectId, runId.trim(), auth.ctx);
  return NextResponse.json({ result });
}
