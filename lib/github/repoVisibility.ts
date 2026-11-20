import { githubFetch } from '@/lib/github/githubFetch';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// Is this repository PRIVATE? (Story MOTIR-8699 · MOTIR-8712) — the one read the
// connected-org runner-group sync makes before access-listing a repository, so a
// PUBLIC repository's id never reaches a fleet runner group. A fork's pull request
// on a public repository can execute arbitrary code on a self-hosted runner, so
// the service filters to private repositories and `RUNNER_GROUP_TEMPLATE`'s
// `allows_public_repositories: false` is the second wall.
//
// The mirror (`github_repo`) carries no visibility column, so this asks GitHub,
// through the same org target the group is managed with. A LEAF PRIMITIVE in the
// `lib/github/appAuth.ts` sense: services import it, routes never do.

const GITHUB_API = 'https://api.github.com';

/** GitHub refused or was unreachable while reading a repository's visibility.
 *  Carries the status and a short detail, never the raw body. */
export class RepoVisibilityApiError extends Error {
  readonly code = 'REPO_VISIBILITY_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while reading a repository's visibility (${detail}).`
        : `GitHub refused a repository read (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepoVisibilityApiError';
  }
}

export const repoVisibilityClient = {
  /**
   * TRUE when GitHub reports the repository `private`. Anything that is not a
   * readable repository with a boolean `private` throws: an unknown visibility is
   * never treated as private, because the cost of that guess is a public
   * repository on a self-hosted runner.
   */
  async isPrivate(owner: string, name: string, target?: GithubOrgTarget): Promise<boolean> {
    const { token } = await resolveOrgAuth(target);
    let res: Response;
    try {
      res = await githubFetch(
        'repoVisibility',
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'motir',
            authorization: `Bearer ${token}`,
          },
        },
      );
    } catch (err) {
      throw new RepoVisibilityApiError(null, err instanceof Error ? err.message : 'unknown');
    }
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      body =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message = body?.['message'];
      throw new RepoVisibilityApiError(
        res.status,
        typeof message === 'string' ? message.slice(0, 200) : '',
      );
    }
    const isPrivate = body?.['private'];
    if (typeof isPrivate !== 'boolean') {
      throw new RepoVisibilityApiError(res.status, 'repository read returned no visibility');
    }
    return isPrivate;
  },
};
