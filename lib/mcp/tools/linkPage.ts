import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PageLinkAlreadyExistsError } from '@/lib/pages/linkErrors';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { presentPageLinkPair } from '@/lib/api/v1/pages/schema';
import { derived } from '../payloads/define';
import { linkPagePayload } from '../payloads/pages';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `link_page` (Story MOTIR-9487 · MOTIR-9558) — link a page to a work item of the
// same project by hand, or unlink it, under `page:edit`. ONE tool with an
// `action`, as `archive_page` is. A thin adapter over
// `pageLinksService.linkPageForWorkItem` / `unlinkPageForWorkItem` (MOTIR-9197),
// the doors the work item's page strip uses — they also require `work_item:edit`
// and `page:view` on the work item's project, and stay authoritative.
//
// Three things the service does not give for free, which this adapter owns:
//
//  • IDEMPOTENT LINK. A pair that already has its hand link throws
//    `PAGE_LINK_ALREADY_LINKED`; the tool answers success with `changed: false`
//    and writes nothing. Unlinking a pair with no hand link stays the named
//    refusal `PAGE_LINK_NOT_FOUND`: only linking is idempotent.
//  • CROSS-PROJECT BY NAME. The service takes its project from the WORK ITEM, so
//    a page elsewhere can only read `PAGE_NOT_FOUND` there. The tool compares
//    both ends with the project `projectKey` names and refuses a mismatch as
//    `CROSS_PROJECT_LINK` before the service is called. The page end is named
//    only when the caller can view the project the page lives in
//    (`pagesService.getPageProjectId`); a page it cannot see stays
//    `PAGE_NOT_FOUND`, the one answer an unknown id gets.
//  • NO LEAK. No text names a page's or a work item's title — only ids and keys.
//
// DERIVED (MOTIR-9604): `/api/v1` answers a link or an unlink with the bare
// pair, `PageLinkPair` (MOTIR-9567). This payload is that pair, presented through
// v1's own presenter, plus `action` and `changed` — and the drift guard probes
// the pair inside it (`payloads/pages.ts`).

export const LINK_PAGE_TOOL_NAME = 'link_page';

export const CROSS_PROJECT_LINK_CODE = 'CROSS_PROJECT_LINK';

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  workItemKey: workItemKeyField.describe(
    'The work item to link the page to — its key, e.g. "ACME-7". It must be in `projectKey`.',
  ),
  action: z
    .enum(['link', 'unlink'])
    .optional()
    .describe('`link` (the default) adds the hand link; `unlink` removes it.'),
};

interface LinkPageArgs {
  projectKey: string;
  pageId: string;
  workItemKey: string;
  action?: 'link' | 'unlink';
}

/** The adapter: both ends must be in the named project, then link or unlink. */
export async function runLinkPage(
  args: LinkPageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const item = await resolveWorkItemByKey(args.workItemKey, ctx);
    if (item.projectId !== project.id) {
      return toolError(
        CROSS_PROJECT_LINK_CODE,
        `Work item ${item.identifier} is not in project ${project.identifier}. A page links only ` +
          'to a work item of its own project.',
      );
    }
    // Unknown, or in a project the caller cannot view: PAGE_NOT_FOUND, thrown here.
    const pageProjectId = await pagesService.getPageProjectId(ctx, args.pageId);
    if (pageProjectId !== project.id) {
      return toolError(
        CROSS_PROJECT_LINK_CODE,
        `Page ${args.pageId} is not in project ${project.identifier}. A page links only to a ` +
          'work item of its own project.',
      );
    }

    const input = { workItemId: item.id, pageId: args.pageId };
    const action = args.action ?? 'link';
    if (action === 'unlink') {
      const pair = presentPageLinkPair(await pageLinksService.unlinkPageForWorkItem(ctx, input));
      return toolOk(
        `Unlinked page ${pair.pageId} from ${item.identifier}.`,
        derived(linkPagePayload, { ...pair, action, changed: true }),
      );
    }
    try {
      const pair = presentPageLinkPair(await pageLinksService.linkPageForWorkItem(ctx, input));
      return toolOk(
        `Linked page ${pair.pageId} to ${item.identifier}.`,
        derived(linkPagePayload, { ...pair, action, changed: true }),
      );
    } catch (err) {
      if (!(err instanceof PageLinkAlreadyExistsError)) throw err;
      return toolOk(
        `Page ${args.pageId} is already linked to ${item.identifier} — nothing changed.`,
        derived(linkPagePayload, {
          pageId: args.pageId,
          workItemId: item.id,
          source: 'manual' as const,
          action,
          changed: false,
        }),
      );
    }
  } catch (err) {
    return toToolError(err);
  }
}

export function registerLinkPage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LINK_PAGE_TOOL_NAME,
    {
      title: 'Link page',
      description:
        'Link a page to a work item of the same project by hand, so it shows on the work ' +
        'item’s pages, or remove that link with `action: "unlink"`. Returns the pair ' +
        '(`pageId`, `workItemId`, `source`), the `action` and `changed`. Linking a pair that is ' +
        'already linked succeeds with `changed: false`; unlinking a pair with no hand link is ' +
        'refused PAGE_LINK_NOT_FOUND. A work item or page in another project than `projectKey` ' +
        'is refused CROSS_PROJECT_LINK, and an archived page cannot be linked (PAGE_ARCHIVED), ' +
        'though an existing link to one can still be removed. Needs the right to edit the work ' +
        'item as well. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runLinkPage(args, resolveContext(extra)),
  );
}
