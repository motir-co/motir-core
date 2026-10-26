import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// GET /api/pages/search?projectId=<id>&q=<text>&cursor=<opaque> (Story
// MOTIR-9491 · MOTIR-9636) — the session door the `/pages` search box reads:
// pages found by a word or by meaning, fused into one ranking, with the `mode`
// that says whether meaning took part. HTTP only: the session, one service
// call, the shared page refusal map. The DTO is `pagesService.searchPages`'s,
// returned as is.
//
// ⚠️ `q` IS NOT PRE-CHECKED, unlike `link-search`. It reaches the service as
// given, as the v1 route passes it, so the service's order holds: a caller
// who cannot read pages is refused before anything is said about the query.
//
//   400  no `projectId` (`BAD_REQUEST`), or a cursor this service did not
//        issue (`PAGE_CURSOR_INVALID`)
//   403  a browser of the project without `page:view`
//   404  a project the caller cannot browse (the page routes' one not-found)
//   422  an empty or whitespace query (`PAGE_SEARCH_QUERY_EMPTY`), or one over
//        200 characters (`PAGE_SEARCH_QUERY_TOO_LONG`, with `limit`)
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const params = new URL(req.url).searchParams;
  const projectId = params.get('projectId') ?? '';
  const q = params.get('q') ?? '';
  const cursor = params.get('cursor');
  if (projectId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`projectId` is required.' },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await pagesService.searchPages(ctx, { projectId, q, cursor }));
  } catch (err) {
    return pageErrorResponse(err);
  }
}
