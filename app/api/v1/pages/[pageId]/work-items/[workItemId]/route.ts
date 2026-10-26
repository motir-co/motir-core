import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProjectId } from '@/lib/api/v1/pages/resolve';
import { presentPageLinkPair } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { pageLinksService } from '@/lib/services/pageLinksService';

// DELETE /api/v1/pages/{pageId}/work-items/{workItemId} (Story MOTIR-9488 ·
// MOTIR-9567) — remove the page's HAND link to a work item, through ONE call to
// `pageLinksService.unlinkPageForWorkItem`, the session route's.
//
// A pair with no hand link is 404 `PAGE_LINK_NOT_FOUND` — a mention or embed in
// the body is not one, and is untouched. No archive question: a link whose page
// was archived since stays removable. The gates are the link's, and the page is
// resolved first, as there (see the POST).
export const DELETE = withV1Route<{ pageId: string; workItemId: string }>(
  { permission: 'page:edit' },
  async (ctx) => {
    const pair = await withPageErrors(async () => {
      await resolvePageProjectId(ctx.params.pageId, ctx.service);
      return pageLinksService.unlinkPageForWorkItem(ctx.service, {
        pageId: ctx.params.pageId,
        workItemId: ctx.params.workItemId,
      });
    });
    return NextResponse.json(presentPageLinkPair(pair));
  },
);
