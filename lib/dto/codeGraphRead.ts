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

export type CodeGraphReadDTO =
  | { state: 'ok'; text: string }
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
