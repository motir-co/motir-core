import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProjectId } from '@/lib/api/v1/pages/resolve';
import {
  movePageBodySchema,
  presentPagePlacement,
  readPageParent,
} from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { pagesService } from '@/lib/services/pagesService';

// PATCH /api/v1/pages/{pageId}/placement (Story MOTIR-9486 · MOTIR-9495) — move
// a page with its subtree: under a page, into a folder or to the project root,
// optionally beside a named sibling. The REST twin of the session route
// `app/api/pages/[pageId]/placement/route.ts`: the same body, the same
// `parseParentBody`, the same ONE call to `pagesService.movePage`.
//
// Every move rule — the cycle, the depth limit, an archived page or parent, the
// neighbours — is the package's (`packages/pages/src/move.ts`), decided under the
// project's structure lock and rendered by `mapPageErrorToV1`. This route adds
// none of them.
export const PATCH = withV1Route<{ pageId: string }>({ permission: 'page:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, movePageBodySchema);
  const parent = readPageParent(body.parent);
  const placement = await withPageErrors(async () => {
    const projectId = await resolvePageProjectId(ctx.params.pageId, ctx.service);
    return pagesService.movePage(ctx.service, {
      projectId,
      pageId: ctx.params.pageId,
      parent,
      beforeId: body.beforeId ?? null,
      afterId: body.afterId ?? null,
    });
  });
  return NextResponse.json(presentPagePlacement(placement));
});
