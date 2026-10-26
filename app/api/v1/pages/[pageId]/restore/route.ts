import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProjectId } from '@/lib/api/v1/pages/resolve';
import { presentPageRestore } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { pagesService } from '@/lib/services/pagesService';

// POST /api/v1/pages/{pageId}/restore (Story MOTIR-9488 · MOTIR-9566) — restore
// an archive ROOT and exactly its set, to the first rung of the landing ladder
// that still holds. The REST twin of the session route's DELETE
// (`app/api/pages/[pageId]/archive/route.ts`): no body, ONE call to
// `pagesService.restorePage`.
//
// No revision. A live page is 409 `PAGE_NOT_ARCHIVED`, and a sub-page that left
// with its root is 409 `PAGE_ARCHIVE_ROOT_REQUIRED` — both the package's.
export const POST = withV1Route<{ pageId: string }>({ permission: 'page:edit' }, async (ctx) => {
  const result = await withPageErrors(async () => {
    const projectId = await resolvePageProjectId(ctx.params.pageId, ctx.service);
    return pagesService.restorePage(ctx.service, { projectId, pageId: ctx.params.pageId });
  });
  return NextResponse.json(presentPageRestore(result));
});
