import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  presentPageSearch,
  type V1PageSearchHit,
  type V1PageSearchResult,
} from '@/lib/api/v1/pages/schema';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { searchPagesPayload } from '../payloads/pages';
import { pageProjectKeyField, resolvePageProject } from './pageRef';

// `search_pages` (Story MOTIR-9489 · MOTIR-9553; by meaning since MOTIR-9490 ·
// MOTIR-9575) — find the live pages of one project by words or by what they
// mean, the two rankings fused. A thin adapter over
// `pagesService.searchPages`, the same door `GET /api/v1/projects/{projectKey}/
// pages/search` calls: the access filter, the query rules and the cursor are the
// service's, so every refusal reaches the agent by the code the REST route puts
// in its body (`PAGE_SEARCH_QUERY_EMPTY`, `PAGE_SEARCH_QUERY_TOO_LONG`,
// `PAGE_CURSOR_INVALID`, the project-access refusal) through `toToolError`.
//
// The result is v1's search page through v1's own presenter, so each hit PROBES
// `PageSearchHit` (`payloads/pages.ts`). A hit is the page's identity, place, a
// snippet and a fused score — never its body: `get_page` reads the page.
//
// ⚠️ A DEGRADED SEARCH IS NEVER WORDED AS "NOTHING MATCHES". In `full-text-only`
// and `not-indexed` mode meaning took no part, so an empty answer means only that
// no WORD matched; the text says that, with the service's own `message`
// verbatim, so REST and MCP never disagree.

export const SEARCH_PAGES_TOOL_NAME = 'search_pages';

const inputSchema = {
  projectKey: pageProjectKeyField,
  q: z
    .string()
    .describe(
      'What to find: words in a page’s title or body, or a phrase describing what the page is ' +
        'about — a meaning-only phrase that shares no word with the page is fine (at most 200 ' +
        'characters). An empty query is refused PAGE_SEARCH_QUERY_EMPTY — a search never lists ' +
        'every page.',
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

/** What the mode means, in one line — the service's `message` when it has one. */
function modeLine(result: V1PageSearchResult): string {
  if (result.mode === 'merged') return 'Mode: merged — results combine meaning and words.';
  return `Mode: ${result.mode} — ${result.message ?? ''}`.trimEnd();
}

/** The rendered text: mode first, then the hits (or the honest empty line), then the cursor. */
export function renderHits(projectKey: string, q: string, result: V1PageSearchResult): string {
  const mode = modeLine(result);
  if (result.items.length === 0) {
    if (result.mode === 'merged') return `${mode}\nNo live page in ${projectKey} matches "${q}".`;
    const why =
      result.mode === 'full-text-only'
        ? 'and semantic search did not run'
        : 'and no page in this project is indexed for meaning yet';
    return `${mode}\nNo word match for "${q}" in ${projectKey}, ${why} — this is not evidence that no similar page exists.`;
  }
  const lines = result.items.map(
    (hit) =>
      `- ${hit.title || 'Untitled'} (${hit.id}) · in ${placeOf(hit)} · score ${hit.rank.toFixed(4)}` +
      (hit.snippet ? `\n  ${hit.snippet}` : ''),
  );
  const n = result.items.length;
  return [
    mode,
    `${n} page${n === 1 ? '' : 's'} in ${projectKey} for "${q}", best first (scores compare only within this search):`,
    ...lines,
    result.nextCursor === null
      ? 'No more hits.'
      : `More hits: call search_pages again with cursor "${result.nextCursor}".`,
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
      renderHits(project.identifier, args.q.trim(), result),
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
        'Find the live pages of one project by words or by what they mean. The query is matched ' +
        'against page titles and bodies as words AND by meaning, and the two rankings are merged, ' +
        'best first, 20 at a time: pass the returned `nextCursor` as `cursor` for the next ones. ' +
        'A meaning-only phrase is fine. Each hit is the page’s id, title, place, score and a ' +
        'short snippet — not the page; read it with `get_page`. `mode` says how the hits were ' +
        'ranked: `merged` (meaning and words), `full-text-only` (semantic search did not run) or ' +
        '`not-indexed` (no page in the project is indexed for meaning yet); the last two are word ' +
        'matches only and are not proof that no similar page exists. An empty query is refused ' +
        'PAGE_SEARCH_QUERY_EMPTY and one over 200 characters PAGE_SEARCH_QUERY_TOO_LONG. Archived ' +
        'pages are never returned. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runSearchPages(args, resolveContext(extra)),
  );
}
