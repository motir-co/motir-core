import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentPageArchive, presentPageRestore } from '@/lib/api/v1/pages/schema';
import type { PageRestoreLandingDto } from '@/lib/dto/pages';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { archivePagePayload } from '../payloads/pages';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';

// `archive_page` (Story MOTIR-9487 · MOTIR-9557) — archive a page with its live
// sub-pages, or restore an archive root, under `page:edit`. ONE tool with an
// `action` rather than two, because the story names `archive_page` with a
// restore action. A thin adapter over `pagesService.archivePage` /
// `pagesService.restorePage`, the doors the page tree's Archive and Restore use:
// both assert `page:edit` themselves, so the tool re-checks nothing, and every
// refusal reaches the agent by its own code through `toToolError`
// (`PAGE_ARCHIVED`, `PAGE_NOT_ARCHIVED`, `PAGE_ARCHIVE_ROOT_REQUIRED`,
// `PAGE_NOT_FOUND` — one answer for an unknown page and another project's).
//
// Nothing is deleted: permanent delete is `page:delete`, which no tool carries.
//
// DERIVED (MOTIR-9604): `/api/v1` publishes each half as its own resource —
// `PageArchive` and `PageRestore` (MOTIR-9566) — and both branches present
// through v1's own presenters, so the drift guard probes each branch against the
// resource it is (`payloads/pages.ts`).

export const ARCHIVE_PAGE_TOOL_NAME = 'archive_page';

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  action: z
    .enum(['archive', 'restore'])
    .optional()
    .describe(
      '`archive` (the default) archives the page with its live sub-pages; `restore` brings an ' +
        'archived page back, with the sub-pages that left with it.',
    ),
};

interface ArchivePageArgs {
  projectKey: string;
  pageId: string;
  action?: 'archive' | 'restore';
}

function renderLanding(landing: PageRestoreLandingDto): string {
  switch (landing.kind) {
    case 'original':
      return 'where it was';
    case 'ancestorPage':
      return `under its nearest live ancestor page ${landing.parentPageId}, because its parent is gone`;
    case 'folder':
      return `in folder ${landing.folderId}, because its parent page is gone`;
    case 'root':
      return 'at the project root, because its parent is gone';
  }
}

/** The adapter: resolve the project by key, then archive or restore through the service. */
export async function runArchivePage(
  args: ArchivePageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const input = { projectId: project.id, pageId: args.pageId };
    if (args.action === 'restore') {
      const restored = presentPageRestore(await pagesService.restorePage(ctx, input));
      const others = restored.restoredIds.length - 1;
      return toolOk(
        `Restored page ${args.pageId}` +
          (others > 0 ? ` with ${others} sub-page${others === 1 ? '' : 's'}` : '') +
          ` ${renderLanding(restored.landing)}.`,
        derived(archivePagePayload, { ...restored }),
      );
    }
    const archived = presentPageArchive(await pagesService.archivePage(ctx, input));
    return toolOk(
      `Archived page ${archived.rootId}` +
        (archived.subPageCount > 0
          ? ` with ${archived.subPageCount} sub-page${archived.subPageCount === 1 ? '' : 's'}`
          : '') +
        '. Nothing was deleted: restore it with `action: "restore"`.',
      derived(archivePagePayload, { ...archived }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerArchivePage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ARCHIVE_PAGE_TOOL_NAME,
    {
      title: 'Archive page',
      description:
        'Archive a page — it takes all its live sub-pages with it — or restore it with ' +
        '`action: "restore"`. Nothing is deleted. Archive returns the ids that left ' +
        '(`archivedIds`, `rootId`, `subPageCount`); restore returns the ids that came back and ' +
        '`landing`, where the page landed — `original`, or its nearest live ancestor page, its ' +
        'folder or the root when its old parent is gone. Restore applies to an archive ROOT: a ' +
        'sub-page that left with its parent is refused PAGE_ARCHIVE_ROOT_REQUIRED (restore the ' +
        'root). Archiving an archived page is refused PAGE_ARCHIVED, restoring a live one ' +
        'PAGE_NOT_ARCHIVED. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runArchivePage(args, resolveContext(extra)),
  );
}
