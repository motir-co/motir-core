import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProject } from '@/lib/api/v1/pages/resolve';
import { presentPageSearch, readPageSearchQuery } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { pagesService } from '@/lib/services/pagesService';

// GET /api/v1/projects/{projectKey}/pages/search?q=&cursor= (Story MOTIR-9489 ·
// MOTIR-9552; by meaning since MOTIR-9490 · MOTIR-9574) — find the project's
// live pages by words and by meaning, fused into one ranking, with the `mode`
// that says whether meaning took part.
//
// A thin door over `pagesService.searchPages`, the same one the MCP
// `search_pages` tool calls: the access filter, the query embedding, the
// ranking, the paging and every refusal are the service's, so this route adds
// none of its own.
//
// ⚠️ ORDER: the project is resolved INSIDE `withPageErrors`, so a key the
// caller cannot browse is the page-style 404 `PAGE_NOT_FOUND`, and `q` is NOT
// pre-checked here — an empty query must reach the service, which refuses a
// caller without `page:view` (403) before it looks at the query (422).
export const GET = withV1Route<{ projectKey: string }>({ permission: 'page:view' }, async (ctx) => {
  const { q, cursor } = readPageSearchQuery(new URL(ctx.req.url));
  const result = await withPageErrors(async () => {
    const project = await resolvePageProject(ctx.params.projectKey, ctx.service);
    return pagesService.searchPages(ctx.service, { projectId: project.id, q, cursor });
  });
  return NextResponse.json(presentPageSearch(result));
});
