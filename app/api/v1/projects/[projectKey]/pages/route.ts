import { NextResponse } from 'next/server';
import { withPageErrors } from '@/lib/api/v1/pages/errors';
import { resolvePageProject } from '@/lib/api/v1/pages/resolve';
import { createPageBodySchema, presentPage, readPageParent } from '@/lib/api/v1/pages/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { pagesService } from '@/lib/services/pagesService';

// POST /api/v1/projects/{projectKey}/pages (Story MOTIR-9486 · MOTIR-9493) —
// create a page at the root, in a folder or under a page, with an optional
// markdown body.
//
// Gated on `page:edit`, the key `pagesService.createPageFromMarkdown` asserts —
// the same door the MCP `create_page` and the app's New page go through, so this
// route adds no page logic of its own. The project is resolved by key BEFORE the
// page refusals are mapped: a key the caller cannot browse is the project's
// ordinary 404, not a page's.
export const POST = withV1Route<{ projectKey: string }>(
  { permission: 'page:edit' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, createPageBodySchema);
    const parent = readPageParent(body.parent);
    const project = await resolvePageProject(ctx.params.projectKey, ctx.service);

    const page = await withPageErrors(() =>
      pagesService.createPageFromMarkdown(ctx.service, {
        projectId: project.id,
        parent,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
      }),
    );

    ctx.responseHeaders.set('Location', `/api/v1/pages/${page.id}`);
    return NextResponse.json(presentPage(page), { status: 201 });
  },
);
