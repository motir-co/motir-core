import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseParentBody } from '@/lib/pages/parentInput';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageProjectKeyField, resolvePageProject } from './pageRef';

// `create_page` (Story MOTIR-5760 · MOTIR-7411) — a new page with a MARKDOWN
// body, filed under a parent page, a folder or the project root, under
// `page:edit` (`docs/decisions/pages.md` §5, §8.2). A thin adapter over
// `pagesService.createPageFromMarkdown`, which creates the row and writes the
// body in ONE transaction: a refused parent or an over-cap body rolls the page
// back, so a refusal never leaves an empty page behind.
//
// `parent.kind` is a plain string ON PURPOSE, as `PageParentInput` is: a kind
// the package does not know (`work_item`) must reach `parsePlacement` and be
// refused there as `PAGE_PARENT_NOT_ALLOWED`, the one place that rule lives —
// not be swallowed as a schema error that never names the rule.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): the `/api/v1`
// `Page` resource is a subset of this payload.

export const CREATE_PAGE_TOOL_NAME = 'create_page';

const inputSchema = {
  projectKey: pageProjectKeyField,
  title: z
    .string()
    .optional()
    .describe('The page’s title. Omit for an untitled page; rename it in the editor later.'),
  markdown: z.string().optional().describe('The page’s body as markdown. Omit for an empty page.'),
  parent: z
    .object({
      kind: z
        .string()
        .min(1)
        .describe('`root`, `folder` (an id from `list_folders`) or `page` (a page id).'),
      id: z
        .string()
        .min(1)
        .optional()
        .describe('The folder or page id. Required unless `kind` is `root`.'),
    })
    .optional()
    .describe(
      'Where to file the page: `{ "kind": "root" }`, `{ "kind": "folder", "id": … }` or ' +
        '`{ "kind": "page", "id": … }` for a sub-page. Omit to file it at the project root.',
    ),
};

interface CreatePageArgs {
  projectKey: string;
  title?: string;
  markdown?: string;
  parent?: { kind: string; id?: string };
}

/** The adapter: resolve the project by key, then create the page with its body. */
export async function runCreatePage(
  args: CreatePageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const parent = args.parent === undefined ? undefined : parseParentBody(args.parent);
  if (parent === null) {
    return toolError(
      'PAGE_PARENT_ID_REQUIRED',
      `A "${args.parent?.kind}" parent needs the id of its ${args.parent?.kind}. ` +
        'Pass `{ "kind": "root" }` to file the page at the project root.',
    );
  }
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const page = await pagesService.createPageFromMarkdown(ctx, {
      projectId: project.id,
      title: args.title,
      parent,
      markdown: args.markdown,
    });
    return toolOk(
      `Created page ${page.title || 'Untitled'} (${page.id}) at /pages/${page.id} · ` +
        `revision ${page.revision}. Send that revision to \`update_page\` to change its body.`,
      exempt(CREATE_PAGE_TOOL_NAME, { ...page }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreatePage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CREATE_PAGE_TOOL_NAME,
    {
      title: 'Create page',
      description:
        'Create a page in a project with a MARKDOWN body — at the project root, in a folder ' +
        '(`parent: { kind: "folder", id }`, an id from `list_folders`), or as a sub-page ' +
        '(`parent: { kind: "page", id }`). Returns the new page as `get_page` reads it: its id ' +
        '(its address is `/pages/<id>`), its placement, its `revision` and its markdown. To change ' +
        'its body later, call `update_page` with that `revision`. A page cannot be filed under a ' +
        'work item (PAGE_PARENT_NOT_ALLOWED). Nothing is created when a refusal comes back. ' +
        'Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runCreatePage(args, resolveContext(extra)),
  );
}
