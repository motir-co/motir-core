import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { getGitProvider } from '@/lib/git';
import { RepoNotInProjectError } from '@/lib/git/errors';
import type { ChangedFilesResult, GitProviderId } from '@/lib/git/types';
import { splitRepoRef } from './repoFileReadService';

// The CHANGED-FILES listing (Story MOTIR-6617 · MOTIR-6619) — the core-owned read
// motir-ai calls back into during a planning job to learn WHICH paths a branch
// changed, so a session told that a neighbour card's code lives on a branch
// (`inFlightCode`, MOTIR-6618) can then read those paths at that ref through
// `repo-file`. It sits beside `repoFileReadService` and mirrors it: resolve the
// repository off the stored rows, resolve the provider off the stored
// discriminator, mint the token in-process, call the host, return NAMES — the
// token never leaves this process and never appears in a result.
//
// ── Where it is STRICTER than the file read, and why ─────────────────────────
// `repo-file` resolves a repository against the ORGANISATION and answers a miss
// with a named `repo_not_connected` at 200. This listing resolves against the
// JOB's PROJECT SET — the `ProjectRepo` rows of the token's project that realize
// the connected repository — and a miss is a THROWN `RepoNotInProjectError`
// (404 at the route) raised BEFORE any provider is resolved, so no host is asked
// about a repository the job's project does not use. A connected repository in
// another project of the organisation and a name nobody has are the same 404.
//
// ⚠️ ON DEMAND ONLY. This is `compareCommits`' host endpoint, and the rule that
// keeps provider latency off render paths binds it: its one caller is the
// internal route.

// ── THE COMMIT-PAIR CACHE (MOTIR-10094) ─────────────────────────────────────
// A compare between two COMMIT SHAS never changes: commits are immutable, so the
// paths one changed against the other are the same answer for ever. The graph
// DRIFT every MCP code read now carries (`codeGraphDriftService`) asks exactly
// that question — the graph's indexed commit against the default branch's head —
// once per read, and a planning session reads dozens of times between pushes. So
// an answer for a pair of full shas is kept, keyed on the CONNECTED repository's
// id (never the caller's spelling) and the two shas.
//
// ⚠️ ONLY THE ANSWERS A COMMIT PAIR FIXES ARE KEPT: `ok` and `too_large`. A branch
// NAME moves, so a pair naming one is never cached; and `no_such_ref`, `revoked`,
// `not_connected` and `host_error` are facts about the CONNECTION or the moment,
// which the next call may answer differently.

/** A full git object id — SHA-1 (40) or SHA-256 (64) hex. A branch name never is. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** How many commit-pair answers one process keeps; the oldest is dropped first. */
export const CHANGED_FILES_CACHE_MAX = 256;

const pairCache = new Map<string, ChangedFilesResult>();

function rememberPair(key: string, result: ChangedFilesResult): ChangedFilesResult {
  if (result.outcome !== 'ok' && result.outcome !== 'too_large') return result;
  pairCache.delete(key);
  pairCache.set(key, result);
  while (pairCache.size > CHANGED_FILES_CACHE_MAX) {
    const oldest = pairCache.keys().next().value as string;
    pairCache.delete(oldest);
  }
  return result;
}

/** Test-only: forget every cached commit-pair answer. */
export function _resetChangedFilesCache(): void {
  pairCache.clear();
}

export interface RepoChangesContext {
  userId: string;
  workspaceId: string;
  /** The job token's project — the set the repository must belong to. */
  projectId: string;
}

export const repoChangesService = {
  /**
   * List the paths `head` changed against `base`, or against the repository's
   * MIRRORED default branch when `base` is omitted (the stored column, not a
   * second host call — `repoFileReadService.readFile`'s rule).
   *
   * Throws {@link RepoNotInProjectError} when the repository is not in the job's
   * project set; every other answer is a named {@link ChangedFilesResult}.
   */
  async listChangedFiles(
    ctx: RepoChangesContext,
    repoRef: string,
    head: string,
    base?: string,
  ): Promise<ChangedFilesResult> {
    const coords = splitRepoRef(repoRef);
    if (!coords) throw new RepoNotInProjectError(repoRef);

    const connected = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const repo = await githubRepoRepository.findConnectedByOrganizationAndName(
          await resolveOrganizationId(ctx.workspaceId, tx),
          coords.owner,
          coords.name,
          tx,
        );
        if (!repo) return null;
        // The job's project set. The project is the token's own, in the token's
        // own workspace, so its `ProjectRepo` rows are admitted by the
        // active-workspace arm — the org-read subtlety `listByGithubRepoId`
        // warns about does not arise for a single project's own rows.
        const inSet = await projectRepoRepository.findByProjectAndGithubRepoId(
          ctx.projectId,
          repo.id,
          tx,
        );
        return inSet ? repo : null;
      },
    );
    if (!connected) throw new RepoNotInProjectError(repoRef);

    const resolvedBase = base?.trim() || connected.defaultBranch;
    const resolvedHead = head.trim();
    const refs = { base: resolvedBase, head: resolvedHead };

    // A pair of full shas is answered from the cache when it has been asked before.
    const pairKey =
      FULL_SHA.test(resolvedBase) && FULL_SHA.test(resolvedHead)
        ? `${connected.id}:${resolvedBase.toLowerCase()}:${resolvedHead.toLowerCase()}`
        : null;
    const cached = pairKey ? pairCache.get(pairKey) : undefined;
    if (cached) return cached;

    let provider;
    try {
      provider = getGitProvider(connected.installation.provider as GitProviderId);
    } catch {
      // A row whose provider is not registered on this deployment: there is no
      // connection this deployment can use.
      return { outcome: 'not_connected', ...refs };
    }

    // The STORED canonical coordinates, never the caller's spelling.
    try {
      const result = await provider.listChangedFiles(
        connected.installation.installationId,
        connected.owner,
        connected.name,
        resolvedBase,
        resolvedHead,
      );
      return pairKey ? rememberPair(pairKey, result) : result;
    } catch (err) {
      // The provider returns every answer it names; a throw is "we could not ask".
      return {
        outcome: 'host_error',
        ...refs,
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }
  },
};
