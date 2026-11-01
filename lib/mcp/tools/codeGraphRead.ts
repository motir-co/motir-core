import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  CodeGraphCommitDTO,
  CodeGraphDriftDTO,
  CodeGraphReadDTO,
  CodeGraphReadTool,
} from '@/lib/dto/codeGraphRead';
import { codeGraphReadService, type CodeGraphReadArgs } from '@/lib/services/codeGraphReadService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `code_explore` and `code_search` (Story MOTIR-7858 · Subtask MOTIR-7862) — the
// hosted code graph, for an agent planning over the MCP. Each is a thin adapter
// over `codeGraphReadService.read`, which runs the hosted planner's OWN executor
// in motir-ai: an `ok` answer's text is those bytes, verbatim — the *page k of N*
// line, the cursor and the pending footer included — so this agent reads what the
// hosted planner reads for the same query, repository set and graph commit.
//
// Every other answer is a NAMED state with one sentence saying what to do next.
// Only the door's refusals (no `ai:plan`; project not found) are errors.
//
// `code_grep` (MOTIR-10066) is the third: a search of the indexed FILE CONTENTS —
// string literals, comments, function bodies and files that are not code — which
// the symbol index behind the other two cannot answer. Same door, same states,
// plus `content_not_indexed` for a graph built before contents were stored.

export const CODE_EXPLORE_TOOL_NAME = 'code_explore';
export const CODE_SEARCH_TOOL_NAME = 'code_search';
export const CODE_GREP_TOOL_NAME = 'code_grep';

const queryField = z
  .string()
  .min(1)
  .describe('What to look for: a symbol, a concept, or a few words naming the code you want.');
const repoField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL. Limit the read to ONE repository in the project’s set — its bare name ("motir-core") ' +
      'or `owner/name`, case-insensitively. Omit to read every indexed repository in the set.',
  );
const cursorField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL. Fetch the NEXT PAGE of an earlier result: pass the `cursor` printed on that ' +
      'result’s page line, exactly as printed, with the same other arguments. Omit for page 1.',
  );

const exploreSchema = {
  projectKey: projectKeyField,
  query: queryField,
  repo: repoField,
  cursor: cursorField,
};
const searchSchema = {
  ...exploreSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('OPTIONAL. The page size — how many symbols to return per page.'),
};

const grepSchema = {
  projectKey: projectKeyField,
  pattern: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      'The text to find in the files, matched literally and case-sensitively unless `regex` or ' +
        '`caseInsensitive` says otherwise. It is NOT trimmed.',
    ),
  regex: z
    .boolean()
    .optional()
    .describe(
      'OPTIONAL. Treat `pattern` as a regular expression (RE2 syntax: no backreferences or ' +
        'lookaround). Matched one line at a time.',
    ),
  caseInsensitive: z.boolean().optional().describe('OPTIONAL. Match regardless of letter case.'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. Limit the search to files under this path prefix, e.g. "lib/billing/" or ' +
        '"app/pricing/page.tsx".',
    ),
  repo: repoField,
  cursor: cursorField,
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('OPTIONAL. The page size — how many matching lines to return per page.'),
};

/** How many changed paths the drift note prints per repository; the payload carries the rest. */
const DRIFT_NOTE_PATHS = 20;

const short = (sha: string) => sha.slice(0, 7);

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, DRIFT_NOTE_PATHS).join(', ');
  return paths.length > DRIFT_NOTE_PATHS
    ? `${shown}, and ${paths.length - DRIFT_NOTE_PATHS} more in \`drift\``
    : shown;
}

/** One repository's drift line: the pair, the count, the changed paths and the query's share of them. */
function describeDrift(d: CodeGraphDriftDTO): string {
  const count =
    d.commitsBehind === null
      ? 'an uncounted number of commits'
      : `${d.commitsBehind} commit${d.commitsBehind === 1 ? '' : 's'}`;
  const head = `- ${d.repoRef}: the graph is at ${short(d.indexedSha)}, ${count} behind the default branch at ${short(d.defaultHead)}.`;
  if (d.changedPaths === null) {
    return `${head} What changed could not be listed (${d.changedPathsUnavailable}), so every absence in this answer is unproven for that repository: read the default branch with \`read_file\` before writing one.`;
  }
  if (d.changedPaths.length === 0) {
    return `${head} No file changed between the two commits, so the graph's code is the default branch's.`;
  }
  const changed = `${d.changedPathsTruncated ? 'At least these' : 'These'} ${d.changedPaths.length} paths changed since: ${listPaths(d.changedPaths)}${d.changedPathsTruncated ? ' (the list was cut)' : ''}.`;
  const area =
    d.changedPathsInQueryArea && d.changedPathsInQueryArea.length > 0
      ? ` The searched area touches ${d.changedPathsInQueryArea.length} of them: ${listPaths(d.changedPathsInQueryArea)} — read those with \`read_file\` at the default branch before you write anything is absent.`
      : ' None of them names the searched area, but a symbol need not be named in its file’s path.';
  return `${head} ${changed}${area}`;
}

/**
 * THE DRIFT NOTE (MOTIR-10094) — appended AFTER the executor's bytes, never inside
 * them, so the graph's answer stays the hosted planner's answer byte for byte.
 */
export function renderCodeGraphDrift(drift: readonly CodeGraphDriftDTO[]): string {
  return [
    'THE GRAPH IS BEHIND THE DEFAULT BRANCH for the repositories below, so this answer is the code as it was at the graph’s commit.',
    ...drift.map(describeDrift),
    'An absence in this answer ("no X exists", "not on main") holds only for code OUTSIDE the changed paths; where what you searched touches one, read it with `read_file` (the default branch, live) before you write it.',
  ].join('\n');
}

/**
 * THE COMMIT LINE (MOTIR-10122) — the commit each repository's graph was built at,
 * full sha, appended after the executor's bytes like the drift note. A planning
 * session's recorded reads cite it, and `plan.py` takes it from this text, the
 * only part of a result its session stream carries.
 */
export function renderCodeGraphCommits(commits: readonly CodeGraphCommitDTO[]): string {
  return `Graph commit${commits.length === 1 ? '' : 's'} read: ${commits.map((c) => `${c.repoRef}@${c.indexedSha}`).join(', ')}.`;
}

/** The one-line summary for a non-`ok` state: the state, then what to do next. */
export function summarizeCodeGraphRead(dto: CodeGraphReadDTO): string {
  switch (dto.state) {
    case 'ok': {
      const text = dto.drift ? `${dto.text}\n\n${renderCodeGraphDrift(dto.drift)}` : dto.text;
      return dto.commits.length > 0 ? `${text}\n\n${renderCodeGraphCommits(dto.commits)}` : text;
    }
    case 'no_repositories':
      return 'This project has no repository in its set, so there is no code graph to read. Plan without code facts, and do not assert any.';
    case 'repo_not_in_set':
      return `The repo "${dto.repo}" is not in this project's set — only ${dto.available.map((r) => `"${r}"`).join(', ')} can be read. No read was made.`;
    case 'not_indexed': {
      const facts = [
        dto.indexState,
        dto.commitsBehind !== null ? `${dto.commitsBehind} commits behind` : null,
        dto.refreshFailing ? 'refresh failing' : null,
        dto.graphTooLarge ? 'graph over the size cap' : null,
      ].filter((f): f is string => Boolean(f));
      return `${dto.repoRef} is not indexed yet${facts.length ? ` (${facts.join(', ')})` : ''} — read its files with \`read_file\` instead.`;
    }
    case 'content_not_indexed': {
      const facts = [
        dto.indexState,
        dto.commitsBehind !== null ? `${dto.commitsBehind} commits behind` : null,
      ].filter((f): f is string => Boolean(f));
      return `${dto.repoRef}'s file contents are not indexed yet${facts.length ? ` (${facts.join(', ')})` : ''}: its graph was built before contents were stored, so this is NOT an empty match. Its next index run stores them; until then read its files with \`read_file\`.`;
    }
    case 'no_graph':
      return 'No code graph exists for this project yet. Read files with `read_file` instead, and do not conclude the code is absent.';
    case 'stale_cursor':
      return 'The cursor is stale: the code changed since that page. Re-run the query without `cursor` to start from page 1.';
    case 'invalid_cursor':
      return 'That cursor was not issued for this read. Re-run the query without `cursor`, or pass a cursor exactly as a page line printed it.';
    case 'graph_unavailable':
      return `The code graph could not be read right now (${dto.reason}). This is a failure to ASK, not an answer — retry later, or read files with \`read_file\`.`;
  }
}

async function run(
  tool: CodeGraphReadTool,
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const dto = await codeGraphReadService.read(
      tool,
      args.projectKey.trim().toUpperCase(),
      {
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
        ...(args.regex !== undefined ? { regex: args.regex } : {}),
        ...(args.caseInsensitive !== undefined ? { caseInsensitive: args.caseInsensitive } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.repo !== undefined ? { repo: args.repo } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      ctx,
    );
    return toolOk(summarizeCodeGraphRead(dto), exempt(tool, { ...dto }));
  } catch (err) {
    return toToolError(err);
  }
}

export const runCodeExplore = (
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> => run('code_explore', args, ctx);
export const runCodeSearch = (
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> => run('code_search', args, ctx);
export const runCodeGrep = (
  args: { projectKey: string } & CodeGraphReadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> => run('code_grep', args, ctx);

const STATES =
  'Every answer carries a `state`: `ok` (the text, plus `drift` when a repository read is behind ' +
  'its default branch: the graph’s commit, the head, `commitsBehind` and the `changedPaths` since — ' +
  'an absence holds only outside them), `no_repositories`, `repo_not_in_set` (with ' +
  '`available`), `not_indexed` (with the repo’s index state and commits behind), `no_graph`, ' +
  '`stale_cursor`, `invalid_cursor`, or `graph_unavailable` (with a `reason`) — none of them an ' +
  'error, and none means the project has no code.';
/** `code_grep`'s one extra state, said on its own description only. */
const GREP_STATE =
  ' `code_grep` adds `content_not_indexed` (with the repo’s index state and commits behind): the ' +
  'repo’s graph was built before file contents were stored — NOT an empty match.';

export function registerCodeGraphRead(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CODE_EXPLORE_TOOL_NAME,
    {
      title: 'Explore the code graph',
      description:
        "Explore a project's hosted code graph around a query: the matching symbols with their " +
        'files and lines, and how they connect (calls, imports). It is the hosted planner’s own ' +
        '`code_explore` (motir-ai), so the answer is the same text that planner reads for the same ' +
        'query, repository set and graph commit. Results PAGE: a result with more than one page ' +
        'prints `page k of N` and a `cursor` to pass back for the next. ' +
        STATES +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: exploreSchema,
    },
    async (args, extra) => {
      try {
        return await runCodeExplore(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
  server.registerTool(
    CODE_SEARCH_TOOL_NAME,
    {
      title: 'Search the code graph',
      description:
        "Search a project's hosted code graph for symbols by name: each match with its kind, file " +
        'and line, and a qualified id. It is the hosted planner’s own `code_search` (motir-ai), so ' +
        'the answer is the text that planner reads. `limit` sets the page size; a result with more ' +
        'than one page prints `page k of N` and a `cursor` to pass back for the next. ' +
        STATES +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: searchSchema,
    },
    async (args, extra) => {
      try {
        return await runCodeSearch(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
  server.registerTool(
    CODE_GREP_TOOL_NAME,
    {
      title: 'Search the file contents',
      description:
        "Search the CONTENTS of a project's indexed files for a piece of text — the lines inside " +
        'string literals, comments, function bodies and files that are not code (copy, config, ' +
        'JSON, YAML), which `code_search` and `code_explore` cannot see: they match symbol names ' +
        'and paths only. Use it to find every place that still says something (a removal, a ' +
        'rename, a copy change). Each match is `path:line: text`. The answer names the commit it ' +
        'searched and the files under `path` it did NOT search (binary, or over the size cap) — ' +
        'read those with `read_file` before calling a list complete. It is the hosted planner’s ' +
        'own `code_grep` (motir-ai). Results PAGE like `code_search`. ' +
        STATES +
        GREP_STATE +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: grepSchema,
    },
    async (args, extra) => {
      try {
        return await runCodeGrep(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
