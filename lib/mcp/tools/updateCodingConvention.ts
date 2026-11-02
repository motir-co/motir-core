import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodingConventionDTO, SavedConventionDTO } from '@/lib/dto/codeHealth';
import { ConventionVersionConflictError } from '@/lib/codeHealth/errors';
import { aiConventionService, CONVENTION_MAX_CHARS } from '@/lib/services/aiConventionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `update_coding_convention` (MOTIR-10183) — WRITE one repository's coding
// convention, the same save the /code editor makes, for an admin working with an
// agent who has approved an edit to that repository's house rules.
//
// A thin adapter over `aiConventionService.saveConventionByKey`, which resolves the
// key inside the token's workspace and `repo` against the project's set exactly as
// `get_coding_convention` does, then calls `saveConvention` — the editor's own
// method. So the gate (`ai:configure`, here AND at the door: `TOOL_PERMISSIONS`),
// the blank and too-long refusals, the stale-`baseVersion` conflict and the
// recorded author (the person behind the token) are the editor's, not a copy.
//
// The conflict is answered HERE rather than by `toToolError`, because the version
// that won belongs in `structuredContent`, where an agent can rebase on it without
// parsing a sentence. Nothing is written on any refusal.
//
// NOT in `CLI_TOKEN_GRANT`, and no planner session lists it: a `motir run` agent
// and a planning run never write a convention.

export const UPDATE_CODING_CONVENTION_TOOL_NAME = 'update_coding_convention';

const inputSchema = {
  projectKey: projectKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository whose convention to write — one in this project’s set, by its bare name ' +
        '("motir-core") or as `owner/name`, case-insensitively, as `get_coding_convention` takes it.',
    ),
  contentMd: z
    .string()
    .describe(
      `The WHOLE convention document as Markdown — it replaces the current text as a new version; ` +
        `the older versions stay in the history. Not blank, at most ${CONVENTION_MAX_CHARS} characters.`,
    ),
  baseVersion: z
    .number()
    .int()
    .min(0)
    .describe(
      'The `version` your edit is based on — what `get_coding_convention` returned (0 when the ' +
        'repository has no convention yet). If a newer version was saved since, nothing is ' +
        'written and the answer carries the version that won.',
    ),
};

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

function byline(c: CodingConventionDTO): string {
  return c.authorKind === 'edited'
    ? `edited by ${c.editedByName ?? 'a team member'} on ${isoDay(c.createdAt)}`
    : 'derived';
}

/** The fields an agent needs from one version — the same keys `get_coding_convention` uses. */
function versionFields(c: CodingConventionDTO): Record<string, unknown> {
  return {
    version: c.version,
    authorKind: c.authorKind,
    editedByName: c.editedByName,
    editedByUserId: c.editedByUserId,
    updatedAt: c.createdAt,
    contentMd: c.contentMd,
  };
}

/** What a completed call renders to: the text a model reads, and the structured fields. */
export function renderSavedConvention(result: SavedConventionDTO): {
  summary: string;
  structured: Record<string, unknown>;
} {
  if (result.state === 'repo_not_in_project') {
    const set = result.repoSet.length
      ? result.repoSet.map((r) => `"${r}"`).join(', ')
      : 'none — no repository is connected to it';
    return {
      summary: `Nothing was written. The repo "${result.repo}" is not part of this project's repository set — only ${set} can be written.`,
      structured: { state: result.state, repo: result.repo, repoSet: result.repoSet },
    };
  }
  const c = result.convention;
  if (!c) {
    return {
      summary: `Saved the convention of ${result.repoRef}, but reading it back returned nothing; call get_coding_convention to see it.`,
      structured: { state: result.state, repoRef: result.repoRef },
    };
  }
  return {
    summary: `Saved ${result.repoRef} · coding convention v${c.version} · ${byline(c)}.`,
    structured: { state: result.state, repoRef: result.repoRef, ...versionFields(c) },
  };
}

/** The stale-`baseVersion` refusal, with the version that won in `structuredContent`. */
export function conventionConflictResult(
  err: ConventionVersionConflictError,
  baseVersion: number,
): CallToolResult {
  const latest = err.latest.convention;
  const who = latest ? ` (${byline(latest)})` : '';
  return {
    ...toolError(
      err.code,
      `The convention is at v${err.latestVersion}${who}; your edit is based on v${baseVersion}. ` +
        `Nothing was written — apply your change to the text in \`latest\` (or call ` +
        `get_coding_convention) and send baseVersion ${err.latestVersion}.`,
    ),
    // An error result is checked against no output schema, so this is a bare
    // object, as `rateLimitedToolError`'s is.
    structuredContent: {
      code: err.code,
      repoRef: err.latest.repoKey,
      latestVersion: err.latestVersion,
      latest: latest ? versionFields(latest) : null,
    },
  };
}

/** The adapter: one service call, its answer rendered, its refusals mapped. */
export async function runUpdateCodingConvention(
  args: { projectKey: string; repo: string; contentMd: string; baseVersion: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await aiConventionService.saveConventionByKey(
      args.projectKey.trim().toUpperCase(),
      args.repo,
      { contentMd: args.contentMd, baseVersion: args.baseVersion },
      ctx,
    );
    const { summary, structured } = renderSavedConvention(result);
    return toolOk(summary, exempt('update_coding_convention', structured));
  } catch (err) {
    if (err instanceof ConventionVersionConflictError) {
      return conventionConflictResult(err, args.baseVersion);
    }
    return toToolError(err);
  }
}

export function registerUpdateCodingConvention(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    UPDATE_CODING_CONVENTION_TOOL_NAME,
    {
      title: 'Update coding convention',
      description:
        "WRITE one repository's CODING CONVENTION — the same save the Code page's editor makes. " +
        '`contentMd` is the whole document and becomes a NEW version, `edited` by the person ' +
        'behind this token; earlier versions stay in the history. Read the current text and ' +
        'version with `get_coding_convention` first and send that version as `baseVersion`: if a ' +
        'newer one was saved since, nothing is written and the refusal ' +
        '(`CONVENTION_VERSION_CONFLICT`) carries the version that won in `structuredContent.latest`. ' +
        'A blank body is `CONVENTION_BLANK`, an oversized one `CONVENTION_TOO_LONG`. Gated on ' +
        '`ai:configure` (a project admin), in the token’s grant and in the owner’s role. Write ' +
        'only an edit a person has approved.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdateCodingConvention(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
