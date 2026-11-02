// The DTO the MCP `code_explore` / `code_search` tools return (Story MOTIR-7858 ·
// MOTIR-7862). A discriminated union on `state`: `ok` carries the hosted planner
// executor's text VERBATIM (motir-ai `POST /v1/code-graph/read`); every other
// member is a state an agent reports as such. None of them is an error, and none
// carries a graph-read credential — motir-core never holds one.

import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';

/**
 * The graph tools the door serves. `code_grep` (MOTIR-10066) searches the indexed
 * FILE CONTENTS rather than the symbol index. The rest of the family is a follow-up.
 */
export type CodeGraphReadTool = 'code_explore' | 'code_search' | 'code_grep';

/**
 * HOW FAR ONE REPOSITORY'S GRAPH TRAILS ITS DEFAULT BRANCH, as data (MOTIR-10094).
 *
 * Present on an `ok` answer for every repository the read covered whose indexed
 * commit differs from its default branch's head — and absent for one at the head,
 * so a current graph's answer carries no drift fields at all.
 *
 * ⚠️ THE PATHS, NOT THE COUNT, ARE THE FACT. One squash-merge is one commit and can
 * be a whole story, so `commitsBehind: 1` says nothing about what the graph is
 * missing. An absence the graph reports ("no X exists") holds only for code
 * OUTSIDE `changedPaths`; where the searched area touches one, the default branch
 * must be read (`read_file`) before the absence is written down.
 */
export interface CodeGraphDriftDTO {
  /** `owner/name`. */
  repoRef: string;
  /** The commit the graph was built from. */
  indexedSha: string;
  /** The default branch's head, as last mirrored. */
  defaultHead: string;
  /** Commits between the two, when counted; `null` when not (never coerced to 0). */
  commitsBehind: number | null;
  /**
   * The paths changed between `indexedSha` and `defaultHead`, from the git host's
   * compare, at most `CODE_GRAPH_DRIFT_PATHS_MAX`
   * (`lib/services/codeGraphDriftService.ts`). `null` ONLY when the host
   * could not list them — `changedPathsUnavailable` then says why. Never an empty
   * list standing in for "could not ask".
   */
  changedPaths: string[] | null;
  /** True when the list was cut — by the host's own cap or by this answer's bound. */
  changedPathsTruncated: boolean;
  /** Why `changedPaths` is null: the host's own outcome for the compare. */
  changedPathsUnavailable: CodeGraphDriftUnavailable | null;
  /**
   * The changed paths that name the searched area — a query word in the path, or
   * under the `code_grep` `path` prefix. A LEAD, not a bound: a symbol's name need
   * not appear in its file's path. Empty when none does, `null` when the paths
   * could not be listed.
   */
  changedPathsInQueryArea: string[] | null;
}

/** One repository's graph commit, as an `ok` read carries it (MOTIR-10122). */
export interface CodeGraphCommitDTO {
  /** `owner/name`. */
  repoRef: string;
  /** The full commit id the repository's graph was built from. */
  indexedSha: string;
}

/** The compare outcomes that leave a drift without a path list. */
export type CodeGraphDriftUnavailable =
  | 'too_large'
  | 'no_such_ref'
  | 'not_connected'
  | 'revoked'
  | 'host_error';

export type CodeGraphReadDTO =
  | {
      state: 'ok';
      text: string;
      /**
       * The commit each repository's graph was built at, for every repository the
       * read covered that HAS a graph (MOTIR-10122) — what a recorded planning
       * read cites, so a check can open the code the answer came from. A graph
       * can trail its branch; this is the graph's commit, never the branch head.
       */
      commits: CodeGraphCommitDTO[];
      /** Only when some repository read is behind its default branch (MOTIR-10094). */
      drift?: CodeGraphDriftDTO[];
    }
  /** The project's set holds no realized repository — decided in core, no ai call. */
  | { state: 'no_repositories' }
  | { state: 'repo_not_in_set'; repo: string; available: string[] }
  /** Enriched from core's own code context: motir-ai has no commits-behind figure. */
  | {
      state: 'not_indexed';
      repoRef: string;
      indexState: CodeGraphIndexState | null;
      commitsBehind: number | null;
      refreshFailing: boolean | null;
      graphTooLarge: CodeContextRepoDTO['graphTooLarge'];
    }
  /**
   * `code_grep` only: the repo IS indexed, but its graph was built before file
   * contents were stored (MOTIR-10066) — not an empty match. Enriched like
   * `not_indexed`, so the agent sees how far behind the graph is.
   */
  | {
      state: 'content_not_indexed';
      repoRef: string;
      indexState: CodeGraphIndexState | null;
      commitsBehind: number | null;
    }
  | { state: 'no_graph' }
  | { state: 'stale_cursor' }
  | { state: 'invalid_cursor' }
  | { state: 'graph_unavailable'; reason: string };
