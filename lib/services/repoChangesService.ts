import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { getGitProvider } from '@/lib/git';
import { RepoNotInProjectError } from '@/lib/git/errors';
import type { ChangedFilesResult, GitProviderId } from '@/lib/git/types';
import { matchRepoInSet, splitRepoRef } from './repoFileReadService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

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
// keeps provider latency off render paths binds it: its two callers are the
// internal route and the MCP `list_changed_files` tool (MOTIR-10069), both a
// model asking on purpose.

export interface RepoChangesContext {
  userId: string;
  workspaceId: string;
  /** The job token's project — the set the repository must belong to. */
  projectId: string;
}

/**
 * The PROJECT-KEYED answer the MCP `list_changed_files` tool renders
 * (MOTIR-10069): every {@link ChangedFilesResult} with the resolved `repoRef`,
 * plus the two misses `read_file`'s project-keyed read names the same way — a
 * `repo` outside the project's set (with the set), and one in the set whose
 * repository is not connected.
 */
export type ProjectChangedFilesResult =
  | (ChangedFilesResult & { repoRef: string })
  | { outcome: 'repo_not_in_project'; repo: string; repoSet: string[] }
  | { outcome: 'repo_not_connected'; repoRef: string; base: string | null; head: string };

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
      return await provider.listChangedFiles(
        connected.installation.installationId,
        connected.owner,
        connected.name,
        resolvedBase,
        resolvedHead,
      );
    } catch (err) {
      // The provider returns every answer it names; a throw is "we could not ask".
      return {
        outcome: 'host_error',
        ...refs,
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }
  },

  /**
   * List the paths `head` changed in one of a PROJECT's repositories — the MCP
   * `list_changed_files` tool's service (MOTIR-10069), the project-keyed twin of
   * {@link listChangedFiles} the way `repoFileReadService.readProjectFile` is
   * `readFile`'s.
   *
   * Gated like `readProjectFile`: the key resolves inside the actor's workspace
   * (another tenant's key is the plain not-found), and `ai:plan` — the key the
   * MCP door checks — is asserted here too. The `repo` is matched against the
   * project's REALIZED set (bare name or `owner/name`, any case) and a miss is
   * answered, with the set, before any provider is resolved.
   */
  async listProjectChangedFiles(
    projectKey: string,
    repo: string,
    head: string,
    base: string | undefined,
    ctx: ServiceContext,
  ): Promise<ProjectChangedFilesResult> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    const repoSet = (await resolveCodeContextState(project.id, ctx)).repos.map((r) => r.repoRef);
    const repoRef = matchRepoInSet(repo, repoSet);
    if (!repoRef) return { outcome: 'repo_not_in_project', repo, repoSet };

    try {
      const result = await this.listChangedFiles(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
        repoRef,
        head,
        base,
      );
      return { ...result, repoRef };
    } catch (err) {
      // In the realized set, yet no CONNECTED repository row realizes it — the
      // fact `read_file` names `repo_not_connected`. Anything else is not ours.
      if (!(err instanceof RepoNotInProjectError)) throw err;
      return {
        outcome: 'repo_not_connected',
        repoRef,
        base: base?.trim() || null,
        head: head.trim(),
      };
    }
  },
};
