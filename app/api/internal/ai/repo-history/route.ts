import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { RepoNotInProjectError } from '@/lib/git/errors';
import type { CodeHistoryKind } from '@/lib/git/types';
import { repoHistoryService } from '@/lib/services/repoHistoryService';

// GET /api/internal/ai/repo-history?repoRef=owner/name&path=lib/x.ts&kind=log|blame[&ref=main]
// (MOTIR-10237) — who changed a path, when and why: the commit LOG of a path at a
// ref, or its BLAME. The read a planning session asks when it must weigh a
// decision's date against the age of the code it contradicts. Same §4a service
// bearer + §4b job token as `repo-changes`, and the same shape.
//
// ⚠️ A REPOSITORY OUTSIDE THE JOB'S PROJECT SET IS A 404, and no provider is
// called for it. Every OTHER answer — no such ref, no such path, a revoked
// connection, a history the host would not compute, a host that did not answer —
// is 200 with a NAMED outcome: the consumer is a model, and those are answers to
// reason from rather than failures to retry.
//
// ⚠️ METADATA ONLY, AND NOTHING CREDENTIAL-SHAPED. The response carries shas,
// authors, dates, subjects and line numbers; no file content and no diff. The
// token is minted in-process and never serialized, and
// `tests/integration/ai/repoHistoryRoute.test.ts` greps the payload for it.

/**
 * The invocation budget for this route. It must stay ABOVE
 * `CODE_HISTORY_TIMEOUT_MS`, so a dead host surfaces as the `host_error` outcome
 * inside the budget; `tests/git/readCodeHistory.test.ts` asserts the ordering.
 */
export const maxDuration = 30;

const KINDS: readonly CodeHistoryKind[] = ['log', 'blame'];

function invalid(error: string): Response {
  return NextResponse.json({ code: 'validation_error', error }, { status: 400 });
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const repoRef = params.get('repoRef');
  const path = params.get('path');
  const kind = params.get('kind');
  const ref = params.get('ref');
  if (!repoRef) return invalid('repoRef is required');
  if (!path?.trim()) return invalid('path is required');
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    return invalid('kind must be one of: log, blame');
  }

  try {
    const result = await repoHistoryService.readHistory(
      { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId, projectId: auth.projectId },
      repoRef,
      kind as CodeHistoryKind,
      path,
      ref ?? undefined,
    );
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof RepoNotInProjectError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
