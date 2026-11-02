import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { presentPageSearch } from '@/lib/api/v1/pages/schema';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';

// GET /api/internal/ai/pages?q=…[&cursor=…] (MOTIR-10238) — the planner's page
// SEARCH: the live pages of the job's OWN project by words and meaning. The same
// door `search_pages` (MCP) and `GET /api/v1/projects/{key}/pages/search` call —
// `pagesService.searchPages` through v1's `presentPageSearch` — so the access
// filter, the 200-character rule, the cursor and the archived-page exclusion are
// the service's, never a parallel query path. The project is the TOKEN's
// (`auth.projectId`); no caller-supplied project exists.
//
// ⚠️ A REFUSED QUERY IS AN ANSWER AT 200, `repo-file`'s convention: the consumer is
// a model, so `query_empty`, `query_too_long` and `cursor_invalid` are named
// outcomes it reasons from, not a 4xx a tolerant client branch would swallow.
// Only a failed credential keeps its 401, and a token whose user cannot read the
// project's pages keeps the 404 / 403 `search-work-items` gives that case.
//
// ⚠️ NO HITS IS `ok` WITH EMPTY `items` — and `mode` / `message` travel with it,
// so a `full-text-only` or `not-indexed` empty answer carries the service's own
// sentence that it is not proof no similar page exists.

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
  const q = params.get('q') ?? '';
  const cursor = params.get('cursor');

  try {
    const result = presentPageSearch(
      await pagesService.searchPages(auth.ctx, {
        projectId: auth.projectId,
        q,
        cursor: cursor || null,
      }),
    );
    return NextResponse.json({ result: { outcome: 'ok', ...result } });
  } catch (err) {
    if (err instanceof PageSearchQueryEmptyError) {
      return NextResponse.json({ result: { outcome: 'query_empty', message: err.message } });
    }
    if (err instanceof PageSearchQueryTooLongError) {
      return NextResponse.json({
        result: { outcome: 'query_too_long', message: err.message, limit: err.limit },
      });
    }
    if (err instanceof PageLevelCursorInvalidError) {
      return NextResponse.json({ result: { outcome: 'cursor_invalid', message: err.message } });
    }
    if (
      err instanceof ProjectNotFoundError ||
      (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
    ) {
      return NextResponse.json(
        { code: 'PROJECT_NOT_FOUND', error: 'Project not found.' },
        { status: 404 },
      );
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    throw err;
  }
}
