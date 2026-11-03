import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { dependencyReadService } from '@/lib/services/dependencyReadService';

// GET /api/internal/ai/dependency-versions?package=zod[&ecosystem=npm]
// (MOTIR-10242) — a package's published versions and dist-tags, read by
// motir-core from the public npm registry for the hosted planner. Same
// service-to-service auth as the repo-file route; no project data enters the
// registry request.
//
// ⚠️ IT ANSWERS 200 WITH A NAMED OUTCOME for every absence and every failure to
// ask (`package_not_found`, `invalid_package`, `ecosystem_unsupported`,
// `too_large`, `unreachable`) — the consumer is a model. Only a missing
// parameter (400) and a failed credential (401/403) keep a 4xx.

/** Above `DEPENDENCY_FETCH_TIMEOUT_MS`, so a dead registry is the `unreachable` outcome. */
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  try {
    await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const pkg = params.get('package');
  if (!pkg) {
    return NextResponse.json(
      { code: 'validation_error', error: 'package is required' },
      { status: 400 },
    );
  }
  const result = await dependencyReadService.listVersions(params.get('ecosystem') || 'npm', pkg);
  return NextResponse.json({ result });
}
