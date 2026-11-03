import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { PageNotFoundError, PageVersionNotFoundError } from '@/lib/pages';
import { parsePositiveInt } from '@/lib/pages/routeErrors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';

// GET /api/internal/ai/pages/{pageId}[?version=N] (MOTIR-10238) — the planner's
// page READ: one page of the job's OWN project as markdown (title, placement,
// revision, newest version, body), or one saved version of it. The same door
// `get_page` (MCP) calls, `pagesService.getPageMarkdown`; read-only, no lock.
//
// ⚠️ ONE `not_found` FOR EVERY ABSENCE OF THE PAGE. An unknown id, a page of
// another project or workspace, and a project the token's user cannot read pages
// in all answer the SAME bytes, so the route never confirms that a page exists
// elsewhere — `routeErrors.ts`'s non-member rule, at 200 with a named outcome
// (`repo-file`'s convention: the consumer is a model).
//
// ⚠️ A VERSION THE PAGE DOES NOT HAVE IS `version_not_found`, never the current
// body as a fallback — the service's own rule (MOTIR-7429).

const NOT_FOUND = { result: { outcome: 'not_found' } } as const;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const { pageId } = await params;
  const rawVersion = new URL(req.url).searchParams.get('version');
  let version: number | undefined;
  if (rawVersion !== null) {
    const parsed = parsePositiveInt(rawVersion);
    if (parsed === null) {
      return NextResponse.json(
        { code: 'validation_error', error: 'version must be a positive integer' },
        { status: 400 },
      );
    }
    version = parsed;
  }

  try {
    const page = await pagesService.getPageMarkdown(auth.ctx, {
      projectId: auth.projectId,
      pageId,
      ...(version !== undefined ? { version } : {}),
    });
    return NextResponse.json({ result: { outcome: 'found', page } });
  } catch (err) {
    if (
      err instanceof PageNotFoundError ||
      err instanceof ProjectNotFoundError ||
      err instanceof ProjectAccessDeniedError
    ) {
      return NextResponse.json(NOT_FOUND);
    }
    if (err instanceof PageVersionNotFoundError) {
      return NextResponse.json({ result: { outcome: 'version_not_found', version } });
    }
    throw err;
  }
}
