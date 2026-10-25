import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { linkPageBodySchema, presentPageLinkPair } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { PageLinkAlreadyExistsError } from '@/lib/pages/linkErrors';
import { pageLinksService } from '@/lib/services/pageLinksService';

// POST /api/v1/pages/{pageId}/work-items (Story MOTIR-9488 · MOTIR-9567) — link a
// work item to the page by hand: the `manual` row the app's Link page action
// writes, through the ONE call the session route makes
// (`app/api/work-items/[id]/pages/route.ts`), `pageLinksService.linkPageForWorkItem`.
//
// Every gate is the service's: `work_item:edit` then `page:view` on the WORK
// ITEM's project, then the page inside that project — so a page of another
// project is the same 404 `PAGE_NOT_FOUND` an unknown one is. An archived page is
// 409 `PAGE_ARCHIVED` and writes no row.
//
// ── A duplicate is idempotent ────────────────────────────────────────────────
// The service counts the row it wrote and throws `PageLinkAlreadyExistsError` on
// zero, so a second row never exists. This route answers that one error with the
// pair, 200 — repeating a link is a success, as an integration retrying a call
// expects. Nothing is read or written to decide it.
export const POST = withV1Route<{ pageId: string }>({ permission: 'page:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, linkPageBodySchema);
  const input = { pageId: ctx.params.pageId, workItemId: body.workItemId };
  const pair = await withPageErrors(async () => {
    try {
      return await pageLinksService.linkPageForWorkItem(ctx.service, input);
    } catch (err) {
      if (err instanceof PageLinkAlreadyExistsError) {
        return { pageId: err.pageId, workItemId: err.workItemId, source: 'manual' as const };
      }
      throw err;
    }
  });
  return NextResponse.json(presentPageLinkPair(pair));
});
