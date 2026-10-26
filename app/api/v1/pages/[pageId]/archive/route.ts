import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProjectId } from '@/lib/api/v1/pages/resolve';
import { presentPageArchive } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { pagesService } from '@/lib/services/pagesService';

// POST /api/v1/pages/{pageId}/archive (Story MOTIR-9488 · MOTIR-9566) — archive a
// page with every live sub-page under it, as one set. The REST twin of the
// session route `app/api/pages/[pageId]/archive/route.ts`'s POST: no body, the
// same ONE call to `pagesService.archivePage`.
//
// No revision: the service takes `{ projectId, pageId }` only and an archive
// writes no content. A page already archived, or a sub-page of an archived set,
// is 409 `PAGE_ARCHIVED` — the package's refusal, rendered by `mapPageErrorToV1`.
export const POST = withV1Route<{ pageId: string }>({ permission: 'page:edit' }, async (ctx) => {
  const result = await withPageErrors(async () => {
    const projectId = await resolvePageProjectId(ctx.params.pageId, ctx.service);
    return pagesService.archivePage(ctx.service, { projectId, pageId: ctx.params.pageId });
  });
  return NextResponse.json(presentPageArchive(result));
});
