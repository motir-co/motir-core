import { getGitProvider } from '@/lib/git';
import { normalizeRepoFilePath } from '@/lib/git/fileRead';
import { RepoNotInProjectError } from '@/lib/git/errors';
import type { CodeHistoryKind, CodeHistoryResult, GitProviderId } from '@/lib/git/types';
import { matchRepoInSet } from './repoFileReadService';
import { resolveConnectedRepoInProject, type RepoChangesContext } from './repoChangesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE CODE HISTORY READ (MOTIR-10237) — who changed a path, when and why: its
// commit LOG at a ref, or its BLAME at a ref. The core-owned read motir-ai calls
// back into during a planning job (`GET /api/internal/ai/repo-history`) and the
// MCP `get_code_history` tool reads through, beside `repoChangesService` and
// shaped exactly like it: the repository is resolved against the job's PROJECT
// SET before any provider is resolved, the provider is resolved off the stored
// discriminator, the token is minted in-process by the provider, and the answer
// is METADATA — a commit's sha, author, date and subject; a blame range's lines
// and commit — so neither the token nor any file content reaches a result.
//
// ⚠️ NOT CACHED. A branch name moves, so a log "at main" is a fact about this
// moment. (A log at a full sha is immutable and could be cached the way the
// commit-pair cache keeps a compare; nothing asks for it often enough yet.)
//
// ⚠️ ON DEMAND ONLY — the provider read's rule: its callers are a model asking on
// purpose, never a render path.

/**
 * What the history read answers: every {@link CodeHistoryResult}, plus a path the
 * service refused before asking anyone (`invalid_path`, with the reason).
 */
export type RepoHistoryResult =
  | CodeHistoryResult
  | { outcome: 'invalid_path'; kind: CodeHistoryKind; path: string; ref: string; reason: string };

/**
 * The PROJECT-KEYED answer the MCP `get_code_history` tool renders: every
 * {@link RepoHistoryResult} with the resolved `repoRef`, plus the two misses the
 * other project-keyed reads name the same way — a `repo` outside the project's set
 * (with the set), and one in the set whose repository is not connected.
 */
export type ProjectRepoHistoryResult =
  | (RepoHistoryResult & { repoRef: string })
  | { outcome: 'repo_not_in_project'; repo: string; repoSet: string[] }
  | {
      outcome: 'repo_not_connected';
      repoRef: string;
      kind: CodeHistoryKind;
      path: string;
      ref: string | null;
    };

export const repoHistoryService = {
  /**
   * The LOG or BLAME of `path` at `ref` in one repository of the job's project —
   * `ref` defaulting to the repository's MIRRORED default branch (the stored
   * column, not a host call).
   *
   * Throws {@link RepoNotInProjectError} when the repository is not in the job's
   * project set, before any provider is resolved; every other answer is named.
   */
  async readHistory(
    ctx: RepoChangesContext,
    repoRef: string,
    kind: CodeHistoryKind,
    path: string,
    ref?: string,
  ): Promise<RepoHistoryResult> {
    const connected = await resolveConnectedRepoInProject(ctx, repoRef);
    const resolvedRef = ref?.trim() || connected.defaultBranch;

    const guarded = normalizeRepoFilePath(path);
    if (!guarded.ok) {
      return {
        outcome: 'invalid_path',
        kind,
        path,
        ref: resolvedRef,
        reason: guarded.reason,
      };
    }
    const asked = { kind, path: guarded.path, ref: resolvedRef };

    let provider;
    try {
      provider = getGitProvider(connected.installation.provider as GitProviderId);
    } catch {
      // A row whose provider is not registered on this deployment.
      return { outcome: 'not_connected', ...asked };
    }

    // The STORED canonical coordinates, never the caller's spelling.
    try {
      return await provider.readCodeHistory(
        connected.installation.installationId,
        connected.owner,
        connected.name,
        kind,
        asked.path,
        asked.ref,
      );
    } catch (err) {
      // The provider returns every answer it names; a throw is "we could not ask".
      return {
        outcome: 'host_error',
        ...asked,
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }
  },

  /**
   * The history of a path in one of a PROJECT's repositories — the MCP
   * `get_code_history` tool's service, the project-keyed twin of
   * {@link readHistory} as `listProjectChangedFiles` is `listChangedFiles`'.
   *
   * Gated like it: the key resolves inside the actor's workspace (another
   * tenant's key is the plain not-found), and `ai:plan` is asserted here too.
   * The `repo` is matched against the project's REALIZED set and a miss is
   * answered, with the set, before any provider is resolved.
   */
  async readProjectHistory(
    projectKey: string,
    repo: string,
    kind: CodeHistoryKind,
    path: string,
    ref: string | undefined,
    ctx: ServiceContext,
  ): Promise<ProjectRepoHistoryResult> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    const repoSet = (await resolveCodeContextState(project.id, ctx)).repos.map((r) => r.repoRef);
    const repoRef = matchRepoInSet(repo, repoSet);
    if (!repoRef) return { outcome: 'repo_not_in_project', repo, repoSet };

    try {
      const result = await this.readHistory(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
        repoRef,
        kind,
        path,
        ref,
      );
      return { ...result, repoRef };
    } catch (err) {
      // In the realized set, yet no CONNECTED repository row realizes it.
      if (!(err instanceof RepoNotInProjectError)) throw err;
      return { outcome: 'repo_not_connected', repoRef, kind, path, ref: ref?.trim() || null };
    }
  },
};
