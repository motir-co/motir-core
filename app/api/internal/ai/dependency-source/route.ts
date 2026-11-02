import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { dependencyReadService } from '@/lib/services/dependencyReadService';

// GET /api/internal/ai/dependency-source?package=zod&version=4.2.1[&ecosystem=npm]
//   [&path=lib/index.d.ts][&startLine=N][&endLine=M]
// (MOTIR-10242) — one file's text, or one directory's entries, of a package's
// published source at a version, read by motir-core from the public npm registry
// and unpacked in memory. Same service-to-service auth as the repo-file route.
//
// ⚠️ IT ANSWERS 200 WITH A NAMED OUTCOME for every absence and every failure to
// ask; only a missing parameter (400) and a failed credential (401/403) keep a
// 4xx. Every result carries `framing: "data"`: the text is THIRD-PARTY, and the
// caller quotes it as data. A line range returns only those lines (and serves a
// file over the whole-file limit); the caller applies its own character cap.

/** Above two `DEPENDENCY_FETCH_TIMEOUT_MS` requests, so a dead registry is `unreachable`. */
export const maxDuration = 30;

function lineParam(raw: string | null): number | undefined | null {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

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
  const version = params.get('version');
  if (!pkg) {
    return NextResponse.json(
      { code: 'validation_error', error: 'package is required' },
      { status: 400 },
    );
  }
  if (!version) {
    return NextResponse.json(
      { code: 'validation_error', error: 'version is required' },
      { status: 400 },
    );
  }
  const startLine = lineParam(params.get('startLine'));
  const endLine = lineParam(params.get('endLine'));
  if (startLine === null || endLine === null) {
    return NextResponse.json(
      { code: 'validation_error', error: 'startLine and endLine must be whole numbers from 1' },
      { status: 400 },
    );
  }
  const result = await dependencyReadService.readSource(
    params.get('ecosystem') || 'npm',
    pkg,
    version,
    params.get('path') ?? undefined,
    { startLine, endLine },
  );
  return NextResponse.json({ result });
}
