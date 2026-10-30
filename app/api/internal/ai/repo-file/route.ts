import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { repoFileReadService } from '@/lib/services/repoFileReadService';

// GET /api/internal/ai/repo-file?repoRef=owner/name&path=lib/foo.ts[&ref=main]
// (Story MOTIR-4585 · MOTIR-4586) — the ai→core read-back a planning session's
// `read_file` tool is built on. Same §4a+§4b service-to-service auth and
// own-workspace scoping as every other read-back route.
//
// ⚠️ IT ANSWERS 200 WITH A NAMED OUTCOME, NOT 404 WITH AN ERROR. The consumer
// is a MODEL: "that path is not in this repository" is an ANSWER it should
// reason from, not a failure it should retry or treat as the channel being
// broken. An HTTP status is the wrong instrument for that distinction anyway —
// it cannot tell a missing FILE from a missing ROUTE, and a client's tolerant
// error branch absorbs both into the same silence. The two cases that ARE about
// the request rather than the repository — a missing parameter and a failed
// credential — keep their 4xx, because those are the caller's to fix.
//
// ⚠️ NOTHING CREDENTIAL-SHAPED IS IN THIS RESPONSE, AND THAT IS ASSERTED
// (`tests/git/repoFileReadRoute.test.ts` greps the SERIALIZED payload, not the
// shape). The provider's raw media type is what makes it easy to hold: GitHub's
// JSON envelope carries a `download_url` that is token-bearing on a private
// repo, and asking for `application/vnd.github.raw` means that field never
// enters this process at all.

/**
 * The invocation budget for this route.
 *
 * It must stay ABOVE `REPO_FILE_READ_TIMEOUT_MS` — the whole point of
 * bounding the host call is that a dead host surfaces as the `unreachable`
 * OUTCOME inside the budget, rather than as a platform timeout with no body,
 * which a caller cannot distinguish from anything else. `tests/git/
 * repoFileRead.test.ts` asserts the ordering so the two numbers cannot drift
 * past each other unnoticed.
 */
export const maxDuration = 30;

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
  const ref = params.get('ref');
  if (!repoRef) {
    return NextResponse.json(
      { code: 'validation_error', error: 'repoRef is required' },
      { status: 400 },
    );
  }
  if (!path) {
    return NextResponse.json(
      { code: 'validation_error', error: 'path is required' },
      { status: 400 },
    );
  }

  // The planner's read: pinned to the commit the ref resolves to (MOTIR-10122).
  const result = await repoFileReadService.readFile(auth.ctx, repoRef, path, ref ?? undefined, {
    pinCommit: true,
  });
  return NextResponse.json({ result });
}
