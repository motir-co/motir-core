import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  repoFileReadService,
  type ProjectFileReadResult,
} from '@/lib/services/repoFileReadService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `read_file` (Story MOTIR-7858 · Subtask MOTIR-7861) — the text of ONE file in
// one of a project's repositories, at a git ref, for an agent planning over the
// MCP. The hosted planner has read files this way since MOTIR-4586 (motir-ai's
// `read_file`, served by `app/api/internal/ai/repo-file`); until this tool an
// agent on the MCP could not, so the two planners checked code facts against
// different evidence — or the MCP one checked none.
//
// A thin adapter over `repoFileReadService.readProjectFile`: no repository
// lookup and no Prisma here. The service resolves the key inside the token's
// workspace, asserts `ai:plan` (the key `TOOL_PERMISSIONS` checks at the door),
// and resolves `repo` against THAT PROJECT's set before any provider call.
//
// ⚠️ MIRRORED, NOT IMPORTED — the twin is motir-ai `src/llm/codeReadTools.ts`
// (`FILE_CONTENT_CAP`, `truncationMarker`, `sliceLines`, `renderReadResult`).
// motir-ai is another repository, so the cap, the marker's wording, the
// line-range semantics and the outcome sentences are COPIED, and a change to one
// is a change to both: the point of the tool is that both planners see the same
// evidence in the same shape.
//
// Every outcome is a NON-error result naming itself in `structuredContent.outcome`
// — a model must be able to tell "no such path" from "no such ref" from "the host
// did not answer", and an `isError` would collapse them into "the call failed".
// The only error results are the door's: no `ai:plan`, and a project not found.

export const READ_FILE_TOOL_NAME = 'read_file';

/** The per-read character cap — equal to motir-ai `FILE_CONTENT_CAP`. */
export const READ_FILE_CONTENT_CAP = 24_000;

/** The marker a truncated read carries — motir-ai `truncationMarker`, verbatim.
 *  A SENTENCE the model can act on, not an ellipsis it can mistake for the end. */
export function truncationMarker(shown: number, total: number): string {
  return (
    `\n\n… [TRUNCATED — this is the first ${shown} of ${total} characters. ` +
    `The file continues beyond this point; do NOT conclude anything from the ` +
    `absence of something you have not seen. Re-read with startLine / endLine ` +
    `to reach the rest.]`
  );
}

/** A 1-based inclusive line range, clamped to the file — motir-ai `sliceLines`. */
export function sliceLines(
  text: string,
  startLine?: number,
  endLine?: number,
): { text: string; from: number; to: number; total: number } | null {
  const lines = text.split('\n');
  const total = lines.length;
  if (startLine === undefined && endLine === undefined) return null;
  const from = Math.max(1, Math.min(startLine ?? 1, total));
  const to = Math.max(from, Math.min(endLine ?? total, total));
  return { text: lines.slice(from - 1, to).join('\n'), from, to, total };
}

const lineField = z.number().int().min(1);

const inputSchema = {
  projectKey: projectKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository to read from — one in this project’s set, by its bare name ("motir-core") or ' +
        'as `owner/name`, case-insensitively. `get_code_health` and `get_project_state` list the set.',
    ),
  path: z
    .string()
    .min(1)
    .describe(
      'The file path RELATIVE TO THE REPOSITORY ROOT, e.g. "lib/git/provider.ts" — or a directory ' +
        'path, e.g. ".github/workflows", to list it. Not a URL, not an absolute path, and never ' +
        'containing "..".',
    ),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The branch, tag or commit to read at. Omit for the repository’s default branch — ' +
        'the MERGED code. To read a card’s UNMERGED code, pass the branch its pull request is on.',
    ),
  startLine: lineField.optional().describe('OPTIONAL, 1-based and inclusive. Read from this line.'),
  endLine: lineField
    .optional()
    .describe(
      'OPTIONAL, 1-based and inclusive. Read up to this line. Omit with `startLine` set to read to ' +
        'the end of the file.',
    ),
};

interface ReadFileArgs {
  projectKey: string;
  repo: string;
  path: string;
  ref?: string;
  startLine?: number;
  endLine?: number;
}

/** What one outcome renders to: the human/model sentence and the structured fields. */
export function renderReadFile(
  result: ProjectFileReadResult,
  range: { startLine?: number; endLine?: number } = {},
): { summary: string; structured: Record<string, unknown> } {
  if (result.outcome === 'repo_not_in_project') {
    const set = result.repoSet.length
      ? result.repoSet.map((r) => `"${r}"`).join(', ')
      : 'none — no repository is connected to it';
    return {
      summary: `The repo "${result.repo}" is not part of this project's repository set — only ${set} can be read. No read was made.`,
      structured: { outcome: result.outcome, repo: result.repo, repoSet: result.repoSet },
    };
  }

  const repoRef = result.repoRef;
  switch (result.outcome) {
    case 'found': {
      const where = `"${result.path}" in ${repoRef} at ${result.ref}`;
      // A NUL is not text a model can read. The provider serves any blob under
      // its size cap as text, so this is decided here, over what came back —
      // not as a new member of the union motir-ai also consumes.
      if (result.text.includes('\u0000')) {
        return {
          summary: `${where} is a BINARY file (${result.bytes} bytes), so no text is returned. The file EXISTS; use the code graph to ask a structural question instead.`,
          structured: {
            outcome: 'binary',
            repoRef,
            path: result.path,
            ref: result.ref,
            bytes: result.bytes,
          },
        };
      }
      const sliced = sliceLines(result.text, range.startLine, range.endLine);
      const body = sliced ? sliced.text : result.text;
      const head = sliced
        ? `${where}, lines ${sliced.from}-${sliced.to} of ${sliced.total}:`
        : `${where} (${result.bytes} bytes):`;
      const truncated = body.length > READ_FILE_CONTENT_CAP;
      const shown = truncated
        ? `${body.slice(0, READ_FILE_CONTENT_CAP)}${truncationMarker(READ_FILE_CONTENT_CAP, body.length)}`
        : body;
      return {
        summary: `${head}\n\n${shown}`,
        structured: {
          outcome: 'found',
          repoRef,
          path: result.path,
          ref: result.ref,
          bytes: result.bytes,
          lines: sliced ? { from: sliced.from, to: sliced.to, total: sliced.total } : null,
          truncated,
          text: shown,
        },
      };
    }
    case 'binary':
      // The provider classifies the blob itself since MOTIR-7873, so a binary
      // file arrives here as its own outcome rather than as `found` text.
      return {
        summary: `"${result.path}" in ${repoRef} at ${result.ref} is a BINARY file (${result.bytes} bytes), so no text is returned. The file EXISTS; use the code graph to ask a structural question instead.`,
        structured: {
          outcome: result.outcome,
          repoRef,
          path: result.path,
          ref: result.ref,
          bytes: result.bytes,
        },
      };
    case 'directory': {
      // A DIRECTORY is LISTED, never read (MOTIR-9868) — the supported way to
      // find a file the code graph does not parse. Mirrors motir-ai
      // `renderDirectory`.
      const lines = result.entries.map((e) =>
        e.type === 'dir' ? `${e.name}/` : `${e.name} (${e.type})`,
      );
      const cut = result.truncated
        ? `\n\n… [TRUNCATED — the host listed only the first ${result.entries.length} entries. The directory holds more; do NOT conclude a file is absent because it is not listed here. Read a deeper path, or find the file by name with code_search.]`
        : '';
      return {
        summary:
          `"${result.path}" in ${repoRef} at ${result.ref} is a DIRECTORY, so it has no text; its ${result.entries.length} immediate entries follow (a trailing "/" is a subdirectory). Read one with read_file at its full path:\n\n` +
          `${lines.join('\n')}${cut}`,
        structured: {
          outcome: result.outcome,
          repoRef,
          path: result.path,
          ref: result.ref,
          entries: result.entries,
          truncated: result.truncated,
        },
      };
    }
    case 'not_found':
      return {
        summary: `There is no file at "${result.path}" in ${repoRef} at ${result.ref}. The REF resolved, so this is a statement about the path: the file is not there. It is NOT a statement about the repository or the project.`,
        structured: { outcome: result.outcome, repoRef, path: result.path, ref: result.ref },
      };
    case 'ref_not_found':
      return {
        summary: `The ref "${result.ref}" does not exist in ${repoRef}, so nothing was read. This says NOTHING about whether "${result.path}" exists — re-read at a ref that exists (the repository's default branch if you have no reason to pick another).`,
        structured: { outcome: result.outcome, repoRef, path: result.path, ref: result.ref },
      };
    case 'too_large':
      return {
        summary: `"${result.path}" in ${repoRef} is larger than the host will serve inline (${result.limitBytes} bytes). The file EXISTS and was not read. Use the code graph to ask a structural question about it instead.`,
        structured: {
          outcome: result.outcome,
          repoRef,
          path: result.path,
          ref: result.ref,
          limitBytes: result.limitBytes,
        },
      };
    case 'unauthorized':
      return {
        summary: `The stored credential for ${repoRef} was refused by its host, so nothing could be read. The file's existence is UNKNOWN, not denied. Do not assert any code fact about this repository.`,
        structured: { outcome: result.outcome, repoRef, path: result.path, ref: result.ref },
      };
    case 'invalid_path':
      return {
        summary: `That path was refused before any request was made: ${result.reason}. Ask for a path relative to the repository root.`,
        structured: {
          outcome: result.outcome,
          repoRef,
          path: result.path,
          reason: result.reason,
        },
      };
    case 'unreachable':
      return {
        summary: `${repoRef}'s host did not answer (${result.failure}${result.detail ? `: ${result.detail}` : ''}). Nothing is known about "${result.path}" — this is a failure to ASK, not an answer, and it is NOT evidence that the file is absent.`,
        structured: {
          outcome: result.outcome,
          repoRef,
          path: result.path,
          ref: result.ref,
          failure: result.failure,
        },
      };
    case 'repo_not_connected':
      return {
        summary: `"${repoRef}" is in this project's set but is not a repository connected to its organisation, so there was nothing to read. This is a fact about the CONNECTION, not about any file.`,
        structured: { outcome: result.outcome, repoRef },
      };
    case 'provider_unavailable':
      return {
        summary: `${repoRef}'s Git provider could not be used on this deployment (${result.detail}), so nothing could be read. The file's existence is UNKNOWN.`,
        structured: { outcome: result.outcome, repoRef, detail: result.detail },
      };
    default: {
      // A member added to the union later: named verbatim, never guessed at.
      const outcome = String((result as { outcome: unknown }).outcome);
      return {
        summary: `Reading from ${repoRef} returned an outcome this tool does not recognise ("${outcome}"), so nothing can be concluded from it.`,
        structured: { outcome, repoRef },
      };
    }
  }
}

/** The adapter: one service call, then the range, the cap and the named outcome. */
export async function runReadFile(
  args: ReadFileArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await repoFileReadService.readProjectFile(
      args.projectKey.trim().toUpperCase(),
      args.repo,
      args.path,
      args.ref,
      ctx,
    );
    const { summary, structured } = renderReadFile(result, {
      ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
      ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    });
    return toolOk(summary, exempt('read_file', structured));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerReadFile(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    READ_FILE_TOOL_NAME,
    {
      title: 'Read a file',
      description:
        "Read the TEXT of one file in one of a project's repositories, as the git host holds it at a " +
        'ref (the repository’s default branch unless you name another) — the same read the hosted ' +
        'planner makes. Use it to CHECK a code fact before you write it into a card. Pointed at a ' +
        'DIRECTORY it LISTS the immediate entries (names and file / dir / symlink / submodule) — the ' +
        'way to find a file that is not code (a CI workflow, a Dockerfile, a config) when ' +
        '`code_search` on its name did not. `repo` is the ' +
        'bare name or `owner/name` of a repository in the project’s set. Ask for a line RANGE ' +
        '(`startLine` / `endLine`, 1-based, inclusive) when you know where to look: output is capped ' +
        'at 24,000 characters and a cut read ends with a sentence saying so. Every result names its ' +
        '`outcome` — `found`, `directory` (with `entries` and `truncated`), `not_found` (the path is ' +
        'absent at a ref that exists), `ref_not_found`, ' +
        '`too_large`, `binary`, `unauthorized`, `invalid_path`, `unreachable` (a failure to ask, not ' +
        'an answer), `repo_not_connected`, `provider_unavailable`, or `repo_not_in_project` (with the ' +
        'set) — and none of them means the project has no code. Read-only; gated on the planning ' +
        'permission. The project key resolves inside the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runReadFile(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
