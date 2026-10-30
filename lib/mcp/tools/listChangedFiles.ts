import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  repoChangesService,
  type ProjectChangedFilesResult,
} from '@/lib/services/repoChangesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `list_changed_files` (MOTIR-10069) — which PATHS a branch changed in one of a
// project's repositories, against the default branch or a named base, for an agent
// planning over the MCP. `get_work_item`'s `inFlightCode` says WHERE a neighbour's
// unmerged code is (a repo and a branch); this says WHAT that branch changed, so
// the agent can open those paths with `read_file` at that branch. The hosted
// planner has listed a branch this way since MOTIR-6620 (motir-ai's
// `list_changed_files`, served by `app/api/internal/ai/repo-changes`); until this
// tool an agent on the MCP could not, and the corpus told it to say so.
//
// A thin adapter over `repoChangesService.listProjectChangedFiles`: no repository
// lookup and no Prisma here. The service resolves the key inside the token's
// workspace, asserts `ai:plan` (the key `TOOL_PERMISSIONS` checks at the door),
// and resolves `repo` against THAT PROJECT's set before any provider call.
//
// ⚠️ MIRRORED, NOT IMPORTED — the twin is motir-ai `src/llm/codeReadTools.ts`
// (`CHANGED_FILES_RENDER_CAP`, `changedFilesTruncationMarker`,
// `renderChangesResult`). motir-ai is another repository, so the cap, the marker's
// wording and the outcome sentences are COPIED, and a change to one is a change to
// both. The differences are the argument names (`repo` here, `repoRef` there), the
// item read a sentence sends the reader back to (`get_work_item`, not `get_item`),
// and the hosted twin's channel arms (`core_unwired`, `core_route_absent`,
// `core_unreachable`), which name a hop this tool does not make.
//
// Every outcome is a NON-error result naming itself in `structuredContent.outcome`
// — a model must be able to tell "no such branch" from "the connection is gone"
// from "the diff is too large" from "the host did not answer", and an `isError`
// would collapse them into "the call failed". The only error results are the
// door's: no `ai:plan`, and a project not found.

export const LIST_CHANGED_FILES_TOOL_NAME = 'list_changed_files';

/** How many changed paths one listing RENDERS — equal to motir-ai
 *  `CHANGED_FILES_RENDER_CAP` (and to the provider's own `CHANGED_FILES_MAX`). */
export const CHANGED_FILES_RENDER_CAP = 300;

/** The marker a cut list carries — motir-ai `changedFilesTruncationMarker`, verbatim
 *  but for the argument name. A SENTENCE: a list that simply stops reads as a
 *  branch that changed only these files. */
export function changedFilesTruncationMarker(shown: number): string {
  return (
    `\n[TRUNCATED — the list stopped after ${shown} paths. The branch changed AT LEAST these files ` +
    `and possibly more; do NOT conclude a path is unchanged because it is not listed. Read a path you ` +
    `need with read_file at this branch to check it directly.]`
  );
}

const inputSchema = {
  projectKey: projectKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository — one in this project’s set, by its bare name ("motir-core") or as ' +
        '`owner/name`, case-insensitively: the `repo` of an `inFlightCode` entry on `get_work_item` ' +
        'passes straight through.',
    ),
  head: z
    .string()
    .min(1)
    .describe(
      'The branch (or commit) whose changes to list — the `branch` of an `inFlightCode` entry on ' +
        '`get_work_item`.',
    ),
  base: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The ref to compare against. Omit for the repository’s default branch, which is ' +
        'what you want for a pull request that targets it; pass the entry’s `baseRef` when it names ' +
        'a different one.',
    ),
};

interface ListChangedFilesArgs {
  projectKey: string;
  repo: string;
  head: string;
  base?: string;
}

type Rendered = { summary: string; structured: Record<string, unknown> };

/** The `ok` arm: the list, bounded, with the sentence that says how to read on. */
function renderOk(result: Extract<ProjectChangedFilesResult, { outcome: 'ok' }>): Rendered {
  const { repoRef, head: h, base, files } = result;
  const against = ` against ${base}`;
  const shas =
    result.headSha || result.baseSha
      ? ` (head ${result.headSha ? result.headSha.slice(0, 7) : 'unknown'}, base ${result.baseSha ? result.baseSha.slice(0, 7) : 'unknown'})`
      : '';
  const shown = files.slice(0, CHANGED_FILES_RENDER_CAP);
  const cut = result.truncated || files.length > shown.length;
  const structured = {
    outcome: result.outcome,
    repoRef,
    base,
    head: h,
    baseSha: result.baseSha,
    headSha: result.headSha,
    files: shown,
    truncated: cut,
  };
  if (files.length === 0) {
    return {
      summary: result.truncated
        ? `The host reported a truncated but EMPTY change list for branch ${h} in ${repoRef}${against}${shas}. Nothing can be concluded about what it changed.`
        : `Branch ${h} in ${repoRef} changes NO files${against}${shas} — it exists and has nothing the base does not. This is a statement about the BRANCH, not about the repository.`,
      structured,
    };
  }
  const lines = shown.map((f) =>
    f.status === 'renamed' && f.previousPath
      ? `- ${f.status} ${f.path} (from ${f.previousPath})`
      : `- ${f.status} ${f.path}`,
  );
  const header =
    `Branch ${h} in ${repoRef} changes ${cut ? 'at least ' : ''}${files.length} file${files.length === 1 ? '' : 's'}${against}${shas}. ` +
    `Read any of them with read_file { repo: "${repoRef}", path, ref: "${h}" } — at the branch, not the default branch, which does not have these changes:`;
  return {
    summary: `${header}\n${lines.join('\n')}${cut ? changedFilesTruncationMarker(shown.length) : ''}`,
    structured,
  };
}

/** What one outcome renders to: the model sentence and the structured fields. */
export function renderListChangedFiles(result: ProjectChangedFilesResult): Rendered {
  if (result.outcome === 'repo_not_in_project') {
    const set = result.repoSet.length
      ? result.repoSet.map((r) => `"${r}"`).join(', ')
      : 'none — no repository is connected to it';
    return {
      summary: `The repo "${result.repo}" is not part of this project's repository set — only ${set} can be listed. Nothing was listed. This is a fact about the project's repository SET, not about the branch.`,
      structured: { outcome: result.outcome, repo: result.repo, repoSet: result.repoSet },
    };
  }
  if (result.outcome === 'ok') return renderOk(result);

  const { repoRef, head: h } = result;
  const refs = { repoRef, base: result.base, head: h };
  switch (result.outcome) {
    case 'repo_not_connected':
      return {
        summary: `"${repoRef}" is in this project's set but is not a repository connected to its organisation, so the branch "${h}" could not be listed. This is a fact about the CONNECTION, not about the branch.`,
        structured: { outcome: result.outcome, ...refs },
      };
    case 'no_such_ref':
      return {
        summary: `The branch "${h}" (or the base "${result.base}") does not resolve in ${repoRef}, or the two share no history, so nothing was listed. The pull request may have merged and its branch been deleted — re-read the item with get_work_item. This says NOTHING about whether the repository has code.`,
        structured: { outcome: result.outcome, ...refs },
      };
    case 'not_connected':
      return {
        summary: `${repoRef} has no usable connection on this deployment, so the branch "${h}" could not be listed. What it changed is UNKNOWN — a fact about the CONNECTION, not about the branch.`,
        structured: { outcome: result.outcome, ...refs },
      };
    case 'revoked':
      return {
        summary: `The stored credential for ${repoRef} was refused by its host, so the branch "${h}" could not be listed. What it changed is UNKNOWN, not nothing. Do not assert any code fact about this repository.`,
        structured: { outcome: result.outcome, ...refs },
      };
    case 'too_large':
      return {
        summary: `The host declined to compute the change list for branch "${h}" in ${repoRef} against ${result.base} because the comparison is too large. The branch EXISTS and changes many files; read the specific paths you need with read_file at ref "${h}".`,
        structured: { outcome: result.outcome, ...refs },
      };
    case 'host_error':
      return {
        summary: `${repoRef}'s host did not answer the change listing for "${h}" (${result.detail || 'no detail'}). This is a failure to ASK, not an answer — it is NOT evidence that the branch changed nothing.`,
        structured: { outcome: result.outcome, ...refs, detail: result.detail },
      };
    default: {
      // A member added to the union later: named verbatim, never guessed at.
      const outcome = String((result as { outcome: unknown }).outcome);
      return {
        summary: `Listing branch "${h}" in ${repoRef} returned an outcome this tool does not recognise ("${outcome}"), so nothing can be concluded from it.`,
        structured: { outcome, ...refs },
      };
    }
  }
}

/** The adapter: one service call, then the bound and the named outcome. */
export async function runListChangedFiles(
  args: ListChangedFilesArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await repoChangesService.listProjectChangedFiles(
      args.projectKey.trim().toUpperCase(),
      args.repo,
      args.head,
      args.base,
      ctx,
    );
    const { summary, structured } = renderListChangedFiles(result);
    return toolOk(summary, exempt(LIST_CHANGED_FILES_TOOL_NAME, structured));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerListChangedFiles(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    LIST_CHANGED_FILES_TOOL_NAME,
    {
      title: 'List changed files',
      description:
        "List the PATHS a branch changed in one of a project's repositories, against a base (the " +
        'repository’s default branch unless you name another) — names and a status (added / ' +
        'modified / removed / renamed), no content — the same listing the hosted planner makes. Use ' +
        'it on a NEIGHBOUR’S IN-FLIGHT CODE: `get_work_item` returns `inFlightCode` with the `repo` ' +
        'and `branch` of an unmerged pull request (the card’s own, or inherited from a parent); pass ' +
        'them here as `repo` and `head`, then open what matters with `read_file` at that same branch ' +
        'as `ref`. Output is bounded at 300 paths and says so when it is cut. Every result names its ' +
        '`outcome` — `ok` (with `files` and `truncated`), `no_such_ref`, `not_connected`, `revoked`, ' +
        '`too_large`, `host_error` (a failure to ask, not an answer), `repo_not_connected`, or ' +
        '`repo_not_in_project` (with the set) — and none of them means the branch changed nothing or ' +
        'the project has no code. Read-only; gated on the planning permission. The project key ' +
        'resolves inside the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runListChangedFiles(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
