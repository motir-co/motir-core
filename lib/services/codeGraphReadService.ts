import { readCodeGraph, type RawCodeGraphRead } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';
import type { CodeGraphReadDTO, CodeGraphReadTool } from '@/lib/dto/codeGraphRead';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The MCP code-graph READ (Story MOTIR-7858 · Subtask MOTIR-7862) — what
// `code_explore` / `code_search` / `code_grep` call. motir-core holds no graph-read credential
// and cannot mint one (`docs/decisions/code-graph-service.md` item 2 and its
// MOTIR-7860 amendment), so the read itself runs in motir-ai, through the hosted
// planner's OWN executor, behind `POST /v1/code-graph/read`. What stays here is
// everything the route leaves to its caller:
//
//   - the TENANT and the GATE: the key resolves inside the actor's workspace
//     (another tenant's key is the plain not-found), and `ai:plan` — the key the
//     MCP door checks — is asserted before anything else is read;
//   - the REPOSITORY SET: the project's realized set is bound here and sent as
//     `repoRefs`; an agent's `repo` is checked against it in core, so a miss is
//     answered with the set and no round trip;
//   - COMMITS-BEHIND on `not_indexed` / `content_not_indexed`, which motir-ai has
//     no figure for;
//   - the BOUNDARY'S FAILURES, mapped to `graph_unavailable` with a reason code.
//
// ⚠️ NO RE-RENDERING. `ok.text` is the planner executor's bytes, and the story's
// parity claim (the MCP agent reads what the hosted planner reads) rests on this
// service passing it through untouched.

/** Match an agent's `repo` against the set: `owner/name` first, then the bare name. */
function matchRepo(repo: string, repoSet: readonly string[]): string | null {
  const wanted = repo.trim().toLowerCase();
  if (!wanted) return null;
  const full = repoSet.find((r) => r.toLowerCase() === wanted);
  if (full) return full;
  return repoSet.find((r) => r.slice(r.lastIndexOf('/') + 1).toLowerCase() === wanted) ?? null;
}

/** A boundary failure → its reason code; `null` for one that must stay an error. */
function failureReason(err: unknown): string | null {
  // A request motir-ai REJECTED is a bug in what was sent (or a bad agent
  // argument it validated) — the caller must see it, not a soft state.
  if (err instanceof MotirAiBadRequestError) return null;
  if (err instanceof MotirAiConfigError) return 'ai_not_configured';
  if (err instanceof MotirAiUnavailableError) return 'ai_unreachable';
  if (err instanceof MotirAiError) return 'ai_error';
  return null;
}

function enrich(
  answer: RawCodeGraphRead,
  repos: readonly CodeContextRepoDTO[],
  repoSet: readonly string[],
): CodeGraphReadDTO {
  switch (answer.state) {
    case 'not_indexed': {
      const repo = repos.find((r) => r.repoRef.toLowerCase() === answer.repoRef.toLowerCase());
      return {
        state: 'not_indexed',
        repoRef: answer.repoRef,
        indexState: repo?.indexState ?? null,
        commitsBehind: repo?.commitsBehind ?? null,
        refreshFailing: repo?.refreshFailing ?? null,
        graphTooLarge: repo?.graphTooLarge ?? null,
      };
    }
    case 'content_not_indexed': {
      const repo = repos.find((r) => r.repoRef.toLowerCase() === answer.repoRef.toLowerCase());
      return {
        state: 'content_not_indexed',
        repoRef: answer.repoRef,
        indexState: repo?.indexState ?? null,
        commitsBehind: repo?.commitsBehind ?? null,
      };
    }
    // A defence only: core checked the repo first, so this means motir-ai and
    // core disagree about the set — reported with core's set, the one bound.
    case 'repo_not_in_set':
      return { state: 'repo_not_in_set', repo: answer.repoRef, available: [...repoSet] };
    case 'ok':
      return { state: 'ok', text: answer.text };
    case 'graph_unavailable':
      return { state: 'graph_unavailable', reason: answer.reason };
    case 'no_graph':
    case 'stale_cursor':
    case 'invalid_cursor':
      return { state: answer.state };
    default: {
      // A state motir-ai added later: named verbatim, never guessed at.
      const state = String((answer as { state: unknown }).state);
      return { state: 'graph_unavailable', reason: `unknown_state:${state}` };
    }
  }
}

export interface CodeGraphReadArgs {
  /** `code_explore` / `code_search`. */
  query?: string;
  /** `code_grep` (MOTIR-10066): the text or RE2 pattern searched for in file contents. */
  pattern?: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  /** `code_grep`: a path prefix the search is limited to. */
  path?: string;
  repo?: string;
  cursor?: string;
  limit?: number;
}

export const codeGraphReadService = {
  async read(
    tool: CodeGraphReadTool,
    projectKey: string,
    args: CodeGraphReadArgs,
    ctx: ServiceContext,
  ): Promise<CodeGraphReadDTO> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    // The ungated join `getPlanningCodeHealth` uses — legal because the gate ran.
    const { repos } = await resolveCodeContextState(project.id, ctx);
    if (repos.length === 0) return { state: 'no_repositories' };
    const repoSet = repos.map((r) => r.repoRef);

    let repoFilter: string[] | undefined;
    if (args.repo !== undefined) {
      const matched = matchRepo(args.repo, repoSet);
      if (!matched) return { state: 'repo_not_in_set', repo: args.repo, available: repoSet };
      repoFilter = [matched];
    }

    let answer: RawCodeGraphRead;
    try {
      answer = await readCodeGraph({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: project.id,
        tool,
        repoRefs: repoSet,
        args: {
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          ...(args.regex !== undefined ? { regex: args.regex } : {}),
          ...(args.caseInsensitive !== undefined ? { caseInsensitive: args.caseInsensitive } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(repoFilter ? { repos: repoFilter } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      });
    } catch (err) {
      const reason = failureReason(err);
      if (reason === null) throw err;
      return { state: 'graph_unavailable', reason };
    }
    return enrich(answer, repos, repoSet);
  },
};
