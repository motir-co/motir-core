import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  repoHistoryService,
  type ProjectRepoHistoryResult,
} from '@/lib/services/repoHistoryService';
import type { CodeHistoryKind } from '@/lib/git/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `get_code_history` (MOTIR-10237) — who changed a path in one of a project's
// repositories, when and why: the commit LOG of the path at a ref, or its BLAME.
// `read_file` already answers "the file at a commit"; this answers the history
// around it. The hosted planner reads the same thing through
// `app/api/internal/ai/repo-history`.
//
// A thin adapter over `repoHistoryService.readProjectHistory`: no repository
// lookup and no Prisma here. The service resolves the key inside the token's
// workspace, asserts `ai:plan`, and resolves `repo` against THAT PROJECT's set
// before any provider call.
//
// Every outcome is a NON-error result naming itself in `structuredContent.outcome`
// — "no such ref", "no such path", "the connection is gone", "the host would not
// compute it" and "the host did not answer" are different facts, and an `isError`
// would collapse them into "the call failed". The only error results are the
// door's: no `ai:plan`, and a project not found.

export const GET_CODE_HISTORY_TOOL_NAME = 'get_code_history';

/** How many commits a log RENDERS — the provider's own `CODE_HISTORY_MAX_COMMITS`. */
export const CODE_HISTORY_COMMIT_RENDER_CAP = 100;
/** How many blame ranges a blame RENDERS — the provider's own `CODE_HISTORY_MAX_RANGES`. */
export const CODE_HISTORY_RANGE_RENDER_CAP = 500;

/** The marker a cut answer carries. A SENTENCE: a list that simply stops reads as complete. */
export function codeHistoryTruncationMarker(kind: CodeHistoryKind, shown: number): string {
  return kind === 'log'
    ? `\n[TRUNCATED — the log stopped after ${shown} commits, newest first. The path has AT LEAST ` +
        `these commits and possibly older ones; do NOT conclude the oldest listed commit created it.]`
    : `\n[TRUNCATED — the blame stopped after ${shown} line ranges. Lines after the last range are ` +
        `NOT described here; do NOT conclude they are unchanged.]`;
}

const inputSchema = {
  projectKey: projectKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository — one in this project’s set, by its bare name ("motir-core") or as ' +
        '`owner/name`, case-insensitively.',
    ),
  path: z.string().min(1).describe('The repository-relative path of the file, e.g. "lib/foo.ts".'),
  kind: z
    .enum(['log', 'blame'])
    .describe(
      '`log` — the commits that changed the path, newest first (sha, author, date, subject). ' +
        '`blame` — per line range, the commit that last changed those lines.',
    ),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The branch, tag or commit to read at. Omit for the repository’s default branch.',
    ),
};

interface GetCodeHistoryArgs {
  projectKey: string;
  repo: string;
  path: string;
  kind: CodeHistoryKind;
  ref?: string;
}

type Rendered = { summary: string; structured: Record<string, unknown> };
type OkResult = Extract<ProjectRepoHistoryResult, { outcome: 'ok' }>;

function renderLog(result: Extract<OkResult, { kind: 'log' }>): Rendered {
  const { repoRef, path, ref, commits } = result;
  const shown = commits.slice(0, CODE_HISTORY_COMMIT_RENDER_CAP);
  const cut = result.truncated || commits.length > shown.length;
  const structured = {
    outcome: result.outcome,
    kind: result.kind,
    repoRef,
    path,
    ref,
    commits: shown,
    truncated: cut,
  };
  if (shown.length === 0) {
    return {
      summary: `The host answered an EMPTY log for ${path} at ${ref} in ${repoRef}${cut ? ', and said the answer was cut' : ''}. Nothing can be concluded about who changed it.`,
      structured,
    };
  }
  const lines = shown.map(
    (c) =>
      `- ${c.sha.slice(0, 12)} ${c.date ?? 'unknown date'} ${c.author ?? 'unknown author'} — ${c.subject || '(no subject)'}`,
  );
  return {
    summary:
      `${path} at ${ref} in ${repoRef} was changed by ${cut ? 'at least ' : ''}${shown.length} commit${shown.length === 1 ? '' : 's'}, newest first:\n` +
      `${lines.join('\n')}${cut ? codeHistoryTruncationMarker('log', shown.length) : ''}`,
    structured,
  };
}

function renderBlame(result: Extract<OkResult, { kind: 'blame' }>): Rendered {
  const { repoRef, path, ref, blame } = result;
  const shown = blame.slice(0, CODE_HISTORY_RANGE_RENDER_CAP);
  const cut = result.truncated || blame.length > shown.length;
  const structured = {
    outcome: result.outcome,
    kind: result.kind,
    repoRef,
    path,
    ref,
    blame: shown,
    truncated: cut,
  };
  if (shown.length === 0) {
    return {
      summary: `${path} at ${ref} in ${repoRef} has NO lines to blame — the file exists and is empty. This is a statement about the FILE's content, not a failure to read it.`,
      structured,
    };
  }
  const lines = shown.map(
    (r) =>
      `- lines ${r.startLine}-${r.endLine}: ${r.sha.slice(0, 12)} ${r.date ?? 'unknown date'} ${r.author ?? 'unknown author'}${r.subject ? ` — ${r.subject}` : ''}`,
  );
  return {
    summary:
      `Blame of ${path} at ${ref} in ${repoRef}, ${shown.length} line range${shown.length === 1 ? '' : 's'}:\n` +
      `${lines.join('\n')}${cut ? codeHistoryTruncationMarker('blame', shown.length) : ''}`,
    structured,
  };
}

/** What one non-`ok` outcome of a resolved repository renders to. */
function renderAbsence(
  result: Exclude<ProjectRepoHistoryResult, OkResult | { outcome: 'repo_not_in_project' }>,
): Rendered {
  const { repoRef, kind, path, ref } = result;
  const asked = { repoRef, kind, path, ref };
  const what = kind === 'log' ? 'log' : 'blame';
  switch (result.outcome) {
    case 'repo_not_connected':
      return {
        summary: `"${repoRef}" is in this project's set but is not a repository connected to its organisation, so the ${what} of ${path} could not be read. This is a fact about the CONNECTION, not about the file.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'invalid_path':
      return {
        summary: `"${path}" is not a repository path this read can ask for (${result.reason}). Nothing was read.`,
        structured: { outcome: result.outcome, ...asked, reason: result.reason },
      };
    case 'no_such_ref':
      return {
        summary: `The ref "${ref}" does not resolve in ${repoRef}, so no ${what} was read. The branch may have been merged and deleted. This says NOTHING about the file's history on other refs.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'path_not_found':
      return {
        summary: `${path} is not a file with history at "${ref}" in ${repoRef}. Check the path with read_file at that ref; it may have been moved or never existed there.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'not_connected':
      return {
        summary: `${repoRef} has no usable connection on this deployment, so the ${what} of ${path} is UNKNOWN — a fact about the CONNECTION, not about the file.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'revoked':
      return {
        summary: `The stored credential for ${repoRef} was refused by its host, so the ${what} of ${path} is UNKNOWN, not empty. Do not assert any history fact about this repository.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'too_large':
      return {
        summary: `The host declined to compute the ${what} of ${path} at "${ref}" in ${repoRef} because it is too large. The file EXISTS; nothing more can be concluded from this answer.`,
        structured: { outcome: result.outcome, ...asked },
      };
    case 'host_error':
      return {
        summary: `${repoRef}'s host did not answer the ${what} of ${path} (${result.detail || 'no detail'}). This is a failure to ASK, not an answer — it is NOT evidence that nobody changed the file.`,
        structured: { outcome: result.outcome, ...asked, detail: result.detail },
      };
    default: {
      const outcome = String((result as { outcome: unknown }).outcome);
      return {
        summary: `Reading the ${what} of ${path} in ${repoRef} returned an outcome this tool does not recognise ("${outcome}"), so nothing can be concluded from it.`,
        structured: { outcome, ...asked },
      };
    }
  }
}

/** What one outcome renders to: the model sentence and the structured fields. */
export function renderGetCodeHistory(result: ProjectRepoHistoryResult): Rendered {
  if (result.outcome === 'repo_not_in_project') {
    const set = result.repoSet.length
      ? result.repoSet.map((r) => `"${r}"`).join(', ')
      : 'none — no repository is connected to it';
    return {
      summary: `The repo "${result.repo}" is not part of this project's repository set — only ${set} can be read. Nothing was read. This is a fact about the project's repository SET, not about the file.`,
      structured: { outcome: result.outcome, repo: result.repo, repoSet: result.repoSet },
    };
  }
  if (result.outcome === 'ok') {
    return result.kind === 'log' ? renderLog(result) : renderBlame(result);
  }
  return renderAbsence(result);
}

/** The adapter: one service call, then the bound and the named outcome. */
export async function runGetCodeHistory(
  args: GetCodeHistoryArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await repoHistoryService.readProjectHistory(
      args.projectKey.trim().toUpperCase(),
      args.repo,
      args.kind,
      args.path,
      args.ref,
      ctx,
    );
    const { summary, structured } = renderGetCodeHistory(result);
    return toolOk(summary, exempt(GET_CODE_HISTORY_TOOL_NAME, structured));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetCodeHistory(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_CODE_HISTORY_TOOL_NAME,
    {
      title: 'Get code history',
      description:
        'Who changed a file in one of a project\'s repositories, when and why. `kind: "log"` ' +
        'returns the commits that changed the path at a ref, newest first — sha, author, date and ' +
        'subject, at most 100. `kind: "blame"` returns, per line range, the commit that last ' +
        'changed those lines — sha, author, date and subject, at most 500 ranges. Commit metadata ' +
        'only: no file content and no diff (read the file itself with `read_file`). Output says ' +
        'so when it is cut. Every result names its `outcome` — `ok`, `no_such_ref`, ' +
        '`path_not_found`, `invalid_path`, `not_connected`, `revoked`, `too_large`, `host_error` ' +
        '(a failure to ask, not an answer), `repo_not_connected`, or `repo_not_in_project` (with ' +
        'the set). Read-only; gated on the planning permission. The project key resolves inside ' +
        'the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetCodeHistory(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
