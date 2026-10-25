import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentPagePlacement, type V1PagePlacement } from '@/lib/api/v1/pages/schema';
import { parseParentBody } from '@/lib/pages/parentInput';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { movePagePayload } from '../payloads/pages';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';

// `move_page` (Story MOTIR-9487 · MOTIR-9556) — re-file a page, with its whole
// subtree, under another page, into a folder or at the project root, under
// `page:edit`. A thin adapter over `pagesService.movePage`, the same door
// `PATCH /api/v1/pages/{pageId}/placement` calls: the structure lock, the cycle,
// depth, cross-project, archived and neighbour rules are the package's, so every
// refusal reaches the agent by its own code through `toToolError`
// (`PAGE_NOT_FOUND`, `PAGE_ARCHIVED`, `PAGE_PARENT_ARCHIVED`, `PAGE_CYCLE`,
// `PAGE_DEPTH_EXCEEDED`, `FOLDER_NOT_FOUND`, `PAGE_NEIGHBOUR_INVALID`).
//
// A destination in ANOTHER project never reaches the package's
// `CROSS_PROJECT_PAGE_PARENT`: the project-narrowed context
// (`page_project_narrow` / `folder_project_narrow`) hides the foreign row, so it
// is refused `PAGE_NOT_FOUND` / `FOLDER_NOT_FOUND` — the same answer an unknown
// id gets, which tells the agent nothing about the other project. The REST
// route answers the same (`tests/api/pages-routes-tree.test.ts`).
//
// The result is v1's `PagePlacement` through v1's own presenter, so the payload
// PROBES that resource (`payloads/pages.ts`). A move to where the page already is
// writes nothing and answers `moved: false` — not an error.

export const MOVE_PAGE_TOOL_NAME = 'move_page';

// `parent.kind` is a plain string ON PURPOSE, as on `create_page`: a kind the
// package does not know (`work_item`) must reach `parsePlacement` and be refused
// there as `PAGE_PARENT_NOT_ALLOWED`, not swallowed as a schema error. A
// `folder` / `page` with no id is the one shape refusal the adapter makes
// itself, `PAGE_PARENT_ID_REQUIRED`, exactly as `create_page` does.
const parentSchema = z
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
  .describe(
    'Where the page goes: `{ "kind": "root" }`, `{ "kind": "folder", "id" }` (an id from ' +
      '`list_folders`) or `{ "kind": "page", "id" }` to nest it under another page.',
  );

const neighbourField = z.string().min(1).optional();

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  parent: parentSchema,
  beforeId: neighbourField.describe(
    'A page at the destination the moved page lands right AFTER. Omit both neighbours to ' +
      'place it last (or keep its place when the parent does not change).',
  ),
  afterId: neighbourField.describe('A page at the destination the moved page lands right BEFORE.'),
};

interface MovePageArgs {
  projectKey: string;
  pageId: string;
  parent: { kind: string; id?: string };
  beforeId?: string;
  afterId?: string;
}

function renderParent(parent: V1PagePlacement['parent']): string {
  if (parent.kind === 'root') return 'at the project root';
  return parent.kind === 'folder' ? `in folder ${parent.id}` : `under page ${parent.id}`;
}

/** The adapter: resolve the project by key, then move through the service. */
export async function runMovePage(
  args: MovePageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const parent = parseParentBody(args.parent);
  if (parent === null) {
    return toolError(
      'PAGE_PARENT_ID_REQUIRED',
      `A "${args.parent.kind}" parent needs the id of its ${args.parent.kind}. ` +
        'Pass `{ "kind": "root" }` to move the page to the project root.',
    );
  }
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const placement = presentPagePlacement(
      await pagesService.movePage(ctx, {
        projectId: project.id,
        pageId: args.pageId,
        parent,
        beforeId: args.beforeId ?? null,
        afterId: args.afterId ?? null,
      }),
    );
    const text = placement.moved
      ? `Moved page ${placement.id} ${renderParent(placement.parent)}.`
      : `Page ${placement.id} is already ${renderParent(placement.parent)} — nothing moved.`;
    return toolOk(text, derived(movePagePayload, { ...placement }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerMovePage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    MOVE_PAGE_TOOL_NAME,
    {
      title: 'Move page',
      description:
        'Re-file a page, with all its sub-pages, under another page, into a folder or at the ' +
        'project root, and optionally place it between two siblings with `beforeId` / `afterId`. ' +
        'Returns where the page now sits: its parent, position and ancestor pages. A move to ' +
        'where the page already is changes nothing and answers `moved: false`. Refused by name: ' +
        'a page under itself or its own sub-page (PAGE_CYCLE), a destination page or folder in ' +
        'another project, which reads as missing (PAGE_NOT_FOUND / FOLDER_NOT_FOUND) exactly as ' +
        'an unknown id does, an archived page (PAGE_ARCHIVED) or archived parent ' +
        '(PAGE_PARENT_ARCHIVED), and a tree deeper than 10 levels (PAGE_DEPTH_EXCEEDED). Honors ' +
        'the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runMovePage(args, resolveContext(extra)),
  );
}
