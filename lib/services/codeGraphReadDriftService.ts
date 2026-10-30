import { graphTrailsHead } from '@/lib/codeGraph/indexState';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';
import type { CodeGraphDriftDTO, CodeGraphDriftUnavailable } from '@/lib/dto/codeGraphRead';
import type { ChangedFilesResult } from '@/lib/git/types';
import { repoChangesService } from '@/lib/services/repoChangesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE DRIFT A CODE-GRAPH READ CARRIES (MOTIR-10094) — what changed on the default
// branch since the commit the graph was built from, handed to the agent beside
// the answer it read off that graph.
//
// ⚠️ A COUNT SAYS HOW MUCH, NEVER WHERE. `commitsBehind: 1` reads as harmless, and
// one squash-merge can be a whole story: a planner that searched a graph one commit
// behind wrote a layer that commit had just added as "not on main" on six cards.
// So the read is handed the PATHS changed between the two commits, which is what
// decides whether an absence the graph reports can be trusted — it holds only for
// code outside them.
//
// ⚠️ ON DEMAND, AND ONCE PER COMMIT PAIR. The paths come from the git host's
// compare (`repoChangesService`, the same listing a planning session's
// `list_changed_files` makes), asked only when an agent reads the graph — never on
// a render path — and the answer for a pair of shas is cached there, because a
// compare between two commits never changes.
//
// ⚠️ IT NEVER FAILS THE READ. A compare the host cannot answer is reported as
// such (`changedPathsUnavailable`), never as an empty list and never as an error:
// the graph answer is still the graph answer.

/** The most changed paths one drift entry carries, and the most query-area paths. */
export const CODE_GRAPH_DRIFT_PATHS_MAX = 50;

/** The area a read searched: the words of its query, and `code_grep`'s path prefix. */
export interface CodeGraphReadArea {
  text?: string;
  pathPrefix?: string;
}

// Words too common in a query to say anything about a path.
const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'into', 'when', 'what', 'where']);

/**
 * The words of a query that can name a path: split at non-alphanumerics and at
 * camelCase humps, lower-cased, four letters or more. `chooseInTx` gives `choose`;
 * `fleet pool chooser` gives `fleet`, `pool`, `chooser`.
 */
export function queryAreaWords(text: string): string[] {
  const words = text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** The changed paths inside the searched area — under the prefix, or naming a query word. */
export function pathsInArea(paths: readonly string[], area: CodeGraphReadArea): string[] {
  const prefix = area.pathPrefix?.trim().replace(/^\.?\//, '');
  if (prefix) return paths.filter((p) => p.startsWith(prefix));
  const words = queryAreaWords(area.text ?? '');
  if (words.length === 0) return [];
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    return words.some((w) => lower.includes(w));
  });
}

function toDrift(
  repo: CodeContextRepoDTO & { indexedSha: string; defaultHead: string },
  listed: ChangedFilesResult,
  area: CodeGraphReadArea,
): CodeGraphDriftDTO {
  const pair = {
    repoRef: repo.repoRef,
    indexedSha: repo.indexedSha,
    defaultHead: repo.defaultHead,
    commitsBehind: repo.commitsBehind,
  };
  if (listed.outcome !== 'ok') {
    return {
      ...pair,
      changedPaths: null,
      changedPathsTruncated: false,
      changedPathsUnavailable: listed.outcome satisfies CodeGraphDriftUnavailable,
      changedPathsInQueryArea: null,
    };
  }
  const paths = listed.files.map((f) => f.path);
  // The area is matched over EVERY path the host listed, before this answer's own
  // bound cuts the list, so a match past the 50th path is still named.
  const inArea = pathsInArea(paths, area);
  return {
    ...pair,
    changedPaths: paths.slice(0, CODE_GRAPH_DRIFT_PATHS_MAX),
    changedPathsTruncated: listed.truncated || paths.length > CODE_GRAPH_DRIFT_PATHS_MAX,
    changedPathsUnavailable: null,
    changedPathsInQueryArea: inArea.slice(0, CODE_GRAPH_DRIFT_PATHS_MAX),
  };
}

export const codeGraphReadDriftService = {
  /**
   * One drift entry per repository the read covered whose graph trails its
   * default branch, in the set's order — `[]` when every one is at its head.
   */
  async forRead(
    projectId: string,
    repos: readonly CodeContextRepoDTO[],
    area: CodeGraphReadArea,
    ctx: ServiceContext,
  ): Promise<CodeGraphDriftDTO[]> {
    const behind = repos.filter(
      (r): r is CodeContextRepoDTO & { indexedSha: string; defaultHead: string } =>
        graphTrailsHead(r.indexedSha, r.defaultHead),
    );
    return Promise.all(
      behind.map(async (repo) => {
        let listed: ChangedFilesResult;
        try {
          listed = await repoChangesService.listChangedFiles(
            { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
            repo.repoRef,
            repo.defaultHead,
            repo.indexedSha,
          );
        } catch (err) {
          // The repository is in the project's set by construction, so a refusal
          // here is a failure to ASK — reported, never thrown into the read.
          listed = {
            outcome: 'host_error',
            base: repo.indexedSha,
            head: repo.defaultHead,
            detail: err instanceof Error ? err.message : 'unknown',
          };
        }
        return toDrift(repo, listed, area);
      }),
    );
  },
};
