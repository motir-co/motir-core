import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';

// `update_page` (Story MOTIR-5760 · MOTIR-7411) — REPLACE a page's whole body
// with markdown, stating the `revision` the caller read, under `page:edit`
// (`docs/decisions/pages.md` §3, §8.2). A thin adapter over
// `pagesService.savePageMarkdown`.
//
// ── Why a stale revision is refused, not merged ─────────────────────────────
// The editor's saves are Yjs updates and merge; a whole-body replace cannot —
// written over a newer revision it would erase whatever a person saved in
// between. So the package refuses it as `PAGE_REVISION_CONFLICT` and writes
// nothing, and `toToolError` turns that into an instruction: get_page, redo the
// edit on what it returns, send the new revision. The replaced body is not lost
// either way: it stays a restorable version in the page's history.
//
// No title edit here: renaming is `rename_page` (MOTIR-8841), which takes no revision.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): the `/api/v1`
// `Page` resource is a subset of this payload.

export const UPDATE_PAGE_TOOL_NAME = 'update_page';

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  markdown: z
    .string()
    .describe('The page’s WHOLE new body as markdown. It replaces the body; it is not appended.'),
  revision: z
    .number()
    .int()
    .min(1)
    .describe(
      'The `revision` your `get_page` (or `create_page`) returned. A page saved since is ' +
        'refused PAGE_REVISION_CONFLICT and nothing is written.',
    ),
};

interface UpdatePageArgs {
  projectKey: string;
  pageId: string;
  markdown: string;
  revision: number;
}

/** The adapter: resolve the project by key, then write the body at the stated revision. */
export async function runUpdatePage(
  args: UpdatePageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const page = await pagesService.savePageMarkdown(ctx, {
      projectId: project.id,
      pageId: args.pageId,
      markdown: args.markdown,
      expectedRevision: args.revision,
    });
    return toolOk(
      `Saved page ${page.title || 'Untitled'} (${page.id}) · now at revision ${page.revision}.`,
      exempt(UPDATE_PAGE_TOOL_NAME, { ...page }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerUpdatePage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    UPDATE_PAGE_TOOL_NAME,
    {
      title: 'Update page',
      description:
        'Replace a page’s WHOLE body with markdown. Edit by reading, changing and writing back: ' +
        'call `get_page`, change its `markdown`, then send the full result here with the ' +
        '`revision` `get_page` returned. If someone saved the page since you read it, this is ' +
        'refused PAGE_REVISION_CONFLICT and nothing is written — a whole-body write would erase ' +
        'their change — so call `get_page` again, redo your edit on what it returns, and send its ' +
        'revision. The previous body stays restorable in the page’s history. Does not rename the ' +
        'page — `rename_page` does. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runUpdatePage(args, resolveContext(extra)),
  );
}
