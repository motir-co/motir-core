import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentPageSearch, type V1PageSearchHit } from '@/lib/api/v1/pages/schema';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { searchPagesPayload } from '../payloads/pages';
import { pageProjectKeyField, resolvePageProject } from './pageRef';

// `search_pages` (Story MOTIR-9489 · MOTIR-9553) — find the live pages of one
// project by a word in the title or the body. A thin adapter over
// `pagesService.searchPages`, the same door `GET /api/v1/projects/{projectKey}/
// pages/search` calls: the access filter, the query rules and the cursor are the
// service's, so every refusal reaches the agent by the code the REST route puts
// in its body (`PAGE_SEARCH_QUERY_EMPTY`, `PAGE_SEARCH_QUERY_TOO_LONG`,
// `PAGE_CURSOR_INVALID`, the project-access refusal) through `toToolError`.
//
// The result is v1's search page through v1's own presenter, so each hit PROBES
// `PageSearchHit` (`payloads/pages.ts`). A hit is the page's identity, place, a
// snippet and a rank — never its body: `get_page` reads the page.

export const SEARCH_PAGES_TOOL_NAME = 'search_pages';

const inputSchema = {
  projectKey: pageProjectKeyField,
  q: z
    .string()
    .describe(
      'The words to find in a page’s title or body (at most 200 characters). An empty query ' +
        'is refused PAGE_SEARCH_QUERY_EMPTY — a search never lists every page.',
    ),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The `nextCursor` a previous `search_pages` call returned, to read the next hits.'),
};

interface SearchPagesArgs {
  projectKey: string;
  q: string;
  cursor?: string;
}

function placeOf(hit: V1PageSearchHit): string {
  const where = [...hit.place.folderPath];
  if (hit.place.parentPageTitle !== null) where.push(hit.place.parentPageTitle);
  return where.length ? where.join(' / ') : 'project root';
}

function renderHits(projectKey: string, q: string, items: V1PageSearchHit[], next: string | null) {
  if (items.length === 0) return `No live page in ${projectKey} matches "${q}".`;
  const lines = items.map(
    (hit) =>
      `- ${hit.title || 'Untitled'} (${hit.id}) · in ${placeOf(hit)} · rank ${hit.rank.toFixed(4)}` +
      (hit.snippet ? `\n  ${hit.snippet}` : ''),
  );
  return [
    `${items.length} page${items.length === 1 ? '' : 's'} in ${projectKey} matching "${q}":`,
    ...lines,
    next === null ? 'No more hits.' : `More hits: call search_pages again with cursor "${next}".`,
  ].join('\n');
}

/** The adapter: resolve the project by key, then search through the service. */
export async function runSearchPages(
  args: SearchPagesArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const result = presentPageSearch(
      await pagesService.searchPages(ctx, {
        projectId: project.id,
        q: args.q,
        cursor: args.cursor ?? null,
      }),
    );
    return toolOk(
      renderHits(project.identifier, args.q.trim(), result.items, result.nextCursor),
      derived(searchPagesPayload, { ...result }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerSearchPages(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    SEARCH_PAGES_TOOL_NAME,
    {
      title: 'Search pages',
      description:
        'Find the live pages of one project by a word in the title or the body. Hits are ranked ' +
        'best first, 20 at a time: pass the returned `nextCursor` as `cursor` for the next ones. ' +
        'Each hit is the page’s id, title, place, rank and a short snippet around the match — ' +
        'not the page; read it with `get_page`. An empty query is refused ' +
        'PAGE_SEARCH_QUERY_EMPTY and one over 200 characters PAGE_SEARCH_QUERY_TOO_LONG. Archived ' +
        'pages are never returned. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runSearchPages(args, resolveContext(extra)),
  );
}
