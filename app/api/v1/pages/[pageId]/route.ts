import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProjectId } from '@/lib/api/v1/pages/resolve';
import { presentPage } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { pagesService } from '@/lib/services/pagesService';

// /api/v1/pages/{pageId} (Story MOTIR-9486 · MOTIR-9493) — one page, addressed
// by the id its address `/pages/<id>` carries.
//
// ── 404, never a title, for a page the caller cannot see ────────────────────
// A page that never existed, one in another project or workspace, and one in a
// project the caller cannot browse are ONE answer: `PAGE_NOT_FOUND`, decided in
// the service (`getPageProjectId`) and rendered by `mapPageErrorToV1`, so the id
// is no existence oracle.

// GET — the page as an agent reads it: title, placement, `revision`, newest
// version and markdown body, exactly what `pagesService.getPageMarkdown` returns.
export const GET = withV1Route<{ pageId: string }>({ permission: 'page:view' }, async (ctx) => {
  const page = await withPageErrors(async () => {
    const projectId = await resolvePageProjectId(ctx.params.pageId, ctx.service);
    return pagesService.getPageMarkdown(ctx.service, { projectId, pageId: ctx.params.pageId });
  });
  return NextResponse.json(presentPage(page));
});
