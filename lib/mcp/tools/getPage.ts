import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField, pageProjectKeyField, renderPageText, resolvePageProject } from './pageRef';

// `get_page` (Story MOTIR-5760 · MOTIR-7410) — a page as an agent reads it: its
// title, placement, `revision`, newest version and body as MARKDOWN, by project
// key and page id, under `page:view` (`docs/decisions/pages.md` §5, §8.2).
//
// The read an agent makes before it writes: the `revision` it returns is what
// `update_page` must send back, and a stale one is refused by name. A page in
// another project, or an unknown id, is the same `PAGE_NOT_FOUND` — the gate on
// one project never confirms a page exists in another.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): the `/api/v1`
// `Page` resource is a subset of this payload.

export const GET_PAGE_TOOL_NAME = 'get_page';

// `version` (MOTIR-7429) reads ONE version's body instead of the current one —
// an argument on this door, not a second tool, the way `get_work_item` takes
// `planId`. A number the page does not have is `PAGE_VERSION_NOT_FOUND`, never
// the current body as a fallback.
const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'A version NUMBER (from the page’s history). Returns that version’s markdown, number, ' +
        'author, `savedAt`, and whether it is `sealed` (published for a decision) or `frozen` ' +
        '(approved). Omit to read the current body.',
    ),
};

/** The adapter: resolve the project by key, then read the page as markdown. */
export async function runGetPage(
  args: { projectKey: string; pageId: string; version?: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const page = await pagesService.getPageMarkdown(ctx, {
      projectId: project.id,
      pageId: args.pageId,
      ...(args.version !== undefined ? { version: args.version } : {}),
    });
    return toolOk(renderPageText(page), exempt(GET_PAGE_TOOL_NAME, { ...page }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetPage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_PAGE_TOOL_NAME,
    {
      title: 'Get page',
      description:
        'Read one page of a project as MARKDOWN — its `title`, where it is filed ' +
        '(`placement`: a parent page or a folder), its current `revision`, its newest version ' +
        '(`latestVersion`: number, author, when) and its body as `markdown`. The page id is the ' +
        '`<id>` in the page’s address `/pages/<id>`. Read before you write: `update_page` must ' +
        'send back the `revision` this returns, and is refused `PAGE_REVISION_CONFLICT` when ' +
        'someone has saved since. Pass `version` to read one version of the page instead — the ' +
        'text a decision was published or approved at — and get `version` (number, author, ' +
        '`savedAt`, `sealed`, `frozen`) beside the markdown; a number the page does not have is ' +
        'refused `PAGE_VERSION_NOT_FOUND`. Read-only. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runGetPage(args, resolveContext(extra)),
  );
}
