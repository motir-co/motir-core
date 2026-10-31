import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { getGitProvider, REPO_FILE_MAX_BYTES } from '@/lib/git';
import { UnknownGitProviderError } from '@/lib/git/registry';
import type { GitProviderId, RepoFileReadResult } from '@/lib/git/types';
import { normalizeRepoFilePath } from '@/lib/git/fileRead';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The repo-file READ service (Story MOTIR-4585 · MOTIR-4586) — the core-owned
// read motir-ai calls back into DURING a planning job, so a session can look at
// the source it is planning against instead of only being TOLD about it.
//
// ── Why the read happens HERE ────────────────────────────────────────────────
// motir-ai holds no provider credential (the 7.5 ingest invariant), and this
// keeps it that way: motir-core resolves the provider off the stored
// discriminator, mints (or reuses) an installation token, calls the host, and
// returns TEXT. The token lives in-process for the length of one call, is never
// persisted (`mintInstallationToken`'s standing contract), and never appears in
// anything this service returns. That is the same shape
// `githubCodeScanningProxyService` uses, one capability over.
//
// ── But NOT the same DEGRADATION, and this is the part worth reading ─────────
// That proxy returns `null` for every failure — not connected, unconfigured
// App, mint failure, host unavailable — because its consumer is a DETECTOR that
// only ever asked "is there a source here?", and a detector may treat every no
// as the same no. This service's consumer is a MODEL deciding what it now
// knows, and for it those answers are different facts. Collapsing them means a
// session concludes "this project has no code connected" from "that branch does
// not exist", which is a wrong belief it will then plan on. So every outcome is
// NAMED (`RepoFileReadResult`), and nothing here returns null.
//
// ── Tenancy ─────────────────────────────────────────────────────────────────
// The caller is a job token and the WORKSPACE is the token's own, signed by
// core. The repo lookup runs under `withWorkspaceContext` (the RLS gate) and
// filters on the ORGANISATION that workspace belongs to, resolved off the
// workspace row: a repository is connected once, to the organisation (Story
// MOTIR-4669), so a job for any of its workspaces reads it, and a job for
// another organisation never does. A `repoRef` naming somebody else's
// repository is indistinguishable from one naming nothing —
// `repo_not_connected` either way, no existence leak.
//
// ⚠️ It filtered on the WORKSPACE until MOTIR-5188, which made
// `repo_not_connected` a FALSE reason in every workspace but the installing
// one — the exact wrong belief the paragraph above exists to prevent.

export interface RepoFileReadContext {
  userId: string;
  workspaceId: string;
}

/** How a read will be consumed. `ranged` — the caller reads a LINE RANGE of the
 *  text, so a file over the whole-file limit is served (MOTIR-10143). */
export interface RepoFileReadOptions {
  ranged?: boolean;
  /** Resolve the ref to its commit and read AT it (MOTIR-10122) — see `readFile`. */
  pinCommit?: boolean;
}

/**
 * The WHOLE-file limit (MOTIR-10143): a found text file over
 * `REPO_FILE_MAX_BYTES`, read with no line range, is answered `too_large` with
 * its line count — the number a caller needs to ask for a range instead. A
 * ranged read, and every other outcome, passes through unchanged.
 */
export function applyWholeFileLimit(
  result: RepoFileReadResult,
  options: RepoFileReadOptions,
): RepoFileReadResult {
  if (result.outcome !== 'found' || options.ranged || result.bytes <= REPO_FILE_MAX_BYTES) {
    return result;
  }
  return {
    outcome: 'too_large',
    path: result.path,
    ref: result.ref,
    limitBytes: REPO_FILE_MAX_BYTES,
    // Counted the way `sliceLines` numbers them, so the range a caller asks for
    // from this number is the range the read will honour.
    totalLines: result.text.split('\n').length,
  };
}

/** The service's result: the provider's own outcomes, plus the two this layer
 *  decides — the repo is not connected here, and the provider is unusable. */
export type RepoFileServiceResult =
  | (RepoFileReadResult & {
      /**
       * The FULL commit id the ref resolved to, and the commit the read was made
       * at (MOTIR-10122) — present on every outcome whose ref resolved, absent
       * where it did not (no such ref, a refused credential, a host that did not
       * answer, a path refused before any request).
       */
      commitSha?: string;
    })
  | { outcome: 'repo_not_connected'; repoRef: string }
  | { outcome: 'provider_unavailable'; repoRef: string; detail: string };

/** The PROJECT-scoped read's result (MOTIR-7861): the service's own outcomes,
 *  plus the one only a project-scoped caller can get — the repository is not in
 *  THAT project's set. Deliberately NOT a member of `RepoFileServiceResult`,
 *  which motir-ai's planner route also returns and switches on. */
export type ProjectFileReadResult =
  | (RepoFileServiceResult & { repoRef: string })
  | { outcome: 'repo_not_in_project'; repo: string; repoSet: string[] };

/**
 * Match a caller's `repo` against a project's realized repository set: the full
 * `owner/name` first, then the bare name — both case-insensitively. A bare name
 * two owners share resolves to the first in set order; `owner/name` is the
 * unambiguous spelling, and the set the miss returns names it.
 */
export function matchRepoInSet(repo: string, repoSet: readonly string[]): string | null {
  const wanted = repo.trim().toLowerCase();
  if (!wanted) return null;
  const full = repoSet.find((r) => r.toLowerCase() === wanted);
  if (full) return full;
  return repoSet.find((r) => r.slice(r.lastIndexOf('/') + 1).toLowerCase() === wanted) ?? null;
}

/**
 * Split a `repoRef` into `(owner, name)` at the LAST slash.
 *
 * ⚠️ NOT `lib/github/codeScanning.ts`'s `parseRepoRef`, and the difference is
 * load-bearing rather than duplication. That one requires EXACTLY two segments,
 * which is right for GitHub and wrong here: a GitLab group nests, so
 * `acme/platform/web` is one project whose owner is `acme/platform` — and
 * `normalizeProject` in the GitLab provider already stores it that way, taking
 * everything before the last slash as the owner. Reusing the two-segment parser
 * would refuse every nested-group project with "not connected", which is a
 * false statement about a repository that is connected.
 */
export function splitRepoRef(repoRef: string): { owner: string; name: string } | null {
  const ref = repoRef
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(github|gitlab)\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const cut = ref.lastIndexOf('/');
  if (cut <= 0 || cut === ref.length - 1) return null;
  const owner = ref.slice(0, cut);
  const name = ref.slice(cut + 1);
  if (!owner || !name || owner.includes('..') || name.includes('/')) return null;
  return { owner, name };
}

/**
 * The mint failed (an App not configured on this deploy, a revoked connection),
 * or the host answered a status no arm names. Both are "we could not ask", which
 * is a different fact from any answer.
 */
function unavailable(repoRef: string, err: unknown): RepoFileServiceResult {
  return {
    outcome: 'provider_unavailable',
    repoRef,
    detail: err instanceof Error ? err.message : 'unknown',
  };
}

export const repoFileReadService = {
  /**
   * Read one file's text from a connected repository, at `ref` or at the
   * repository's own default branch.
   *
   * The default branch comes from the STORED row, not from a second host call:
   * it is a mirrored column, it is what every other consumer already reads, and
   * asking the host for it would double the latency of the common case to learn
   * something we wrote down at connect time.
   *
   * A file over the whole-file limit is served only to a `ranged` read
   * ({@link applyWholeFileLimit}).
   *
   * `pinCommit` (MOTIR-10122) is the PLANNER's read — the MCP `read_file` and the
   * hosted planner's internal route: the ref is resolved to its commit first and
   * the file read AT it, and the answer carries `commitSha`. One host call more,
   * so the other consumers (a decision page, a path advisory) keep the plain read.
   */
  async readFile(
    ctx: RepoFileReadContext,
    repoRef: string,
    path: string,
    ref?: string,
    options: RepoFileReadOptions = {},
  ): Promise<RepoFileServiceResult> {
    const coords = splitRepoRef(repoRef);
    if (!coords) return { outcome: 'repo_not_connected', repoRef };

    const connected = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) =>
        githubRepoRepository.findConnectedByOrganizationAndName(
          await resolveOrganizationId(ctx.workspaceId, tx),
          coords.owner,
          coords.name,
          tx,
        ),
    );
    if (!connected) return { outcome: 'repo_not_connected', repoRef };

    let provider;
    try {
      provider = getGitProvider(connected.installation.provider as GitProviderId);
    } catch (err) {
      // A row whose provider is not registered on this deployment. Named rather
      // than thrown: it is a deployment fact, and a session that is told which
      // one can stop asking about this repository instead of retrying.
      return {
        outcome: 'provider_unavailable',
        repoRef,
        detail:
          err instanceof UnknownGitProviderError
            ? err.message
            : `the ${connected.installation.provider} provider could not be resolved`,
      };
    }

    // The STORED canonical coordinates, never the caller's ref — casing on
    // GitHub is the host's, and the caller's spelling is model-supplied.
    const asked = ref?.trim() || connected.defaultBranch;
    const { installationId } = connected.installation;
    if (!options.pinCommit) {
      try {
        const read = await provider.readFileAtRef(
          installationId,
          connected.owner,
          connected.name,
          path,
          asked,
        );
        return applyWholeFileLimit(read, options);
      } catch (err) {
        return unavailable(repoRef, err);
      }
    }

    // The path guard runs before ANY host call, the resolve included, so a
    // refused path costs nothing — the provider runs it again for its own sake.
    const guarded = normalizeRepoFilePath(path);
    if (!guarded.ok) return { outcome: 'invalid_path', path, reason: guarded.reason };
    try {
      // ⚠️ RESOLVE FIRST, THEN READ AT THE SHA (MOTIR-10122). A planning
      // session's reads are recorded with the commit they were made at, so a
      // check can open the code the session saw. Reading at the branch and
      // resolving it separately could cite a commit the read never saw when the
      // branch moves between the two calls; reading AT the resolved sha cannot.
      const resolved = await provider.resolveRef(
        installationId,
        connected.owner,
        connected.name,
        asked,
      );
      if (resolved.outcome === 'unreachable') {
        const { failure, detail } = resolved;
        return { outcome: 'unreachable', path: guarded.path, ref: asked, failure, detail };
      }
      if (resolved.outcome !== 'resolved') {
        return { outcome: resolved.outcome, path: guarded.path, ref: asked };
      }
      const read = await provider.readFileAtRef(
        installationId,
        connected.owner,
        connected.name,
        guarded.path,
        resolved.sha,
      );
      // The answer names the ref the caller ASKED for; the sha rides beside it.
      const limited = applyWholeFileLimit(read, options);
      return limited.outcome === 'invalid_path'
        ? limited
        : { ...limited, ref: asked, commitSha: resolved.sha };
    } catch (err) {
      return unavailable(repoRef, err);
    }
  },

  /**
   * Read one file from one of a PROJECT's repositories — the MCP `read_file`
   * tool's service (Story MOTIR-7858 · MOTIR-7861).
   *
   * ⚠️ THE PROJECT SET, NOT THE ORGANISATION, IS THE BOUNDARY. `readFile` checks
   * only that the organisation connected the repository, which is right for a
   * planning job (its envelope already carries the project's set) and wrong for
   * a project-keyed tool: it would let a token bound to one project read a
   * sibling project's repository. So the `repo` is resolved against the
   * project's REALIZED set first, and a miss is answered before any provider
   * call.
   *
   * Gated like `aiConventionService.getPlanningCodeHealth`: the key resolves
   * inside the actor's workspace (another tenant's key is the plain not-found),
   * and `ai:plan` — the key the MCP door checks — is asserted here too.
   */
  async readProjectFile(
    projectKey: string,
    repo: string,
    path: string,
    ref: string | undefined,
    ctx: ServiceContext,
    options: RepoFileReadOptions = {},
  ): Promise<ProjectFileReadResult> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    const repoSet = (await resolveCodeContextState(project.id, ctx)).repos.map((r) => r.repoRef);
    const repoRef = matchRepoInSet(repo, repoSet);
    if (!repoRef) return { outcome: 'repo_not_in_project', repo, repoSet };

    const result = await this.readFile(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      repoRef,
      path,
      ref,
      { ...options, pinCommit: true },
    );
    return { ...result, repoRef };
  },
};
