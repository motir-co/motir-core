// The two reads the runner-version support probe makes (MOTIR-10706): a file on
// a repository's default branch, and a repository's release list. A LEAF
// PRIMITIVE in the `lib/github/appAuth.ts` sense: services import it, routes
// never do.
//
// The token is the caller's: an installation token when the deployment has one,
// or null for an ANONYMOUS read. Both repositories read here are public, so an
// anonymous read answers too, within GitHub's 60 requests an hour per address.

import type { RepoRef } from '@/lib/github/repoCommitHistory';

const GITHUB_API = 'https://api.github.com';

/** A read GitHub refused or that never reached it. `status` is null on a
 *  transport failure. Carries a short detail, never a body or token. */
export class RunnerVersionSourceError extends Error {
  readonly code = 'RUNNER_VERSION_SOURCE_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached (${detail}).`
        : `GitHub refused the read (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RunnerVersionSourceError';
  }
}

async function get(path: string, accept: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { accept, 'user-agent': 'motir' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, { method: 'GET', headers });
  } catch (err) {
    throw new RunnerVersionSourceError(null, err instanceof Error ? err.message : 'unknown');
  }
  if (!res.ok) {
    let message = '';
    try {
      const body = (await res.json()) as { message?: unknown } | null;
      if (typeof body?.message === 'string') message = body.message.slice(0, 200);
    } catch {
      // A refusal with no JSON body is still the refusal; its status says enough.
    }
    throw new RunnerVersionSourceError(res.status, message);
  }
  return res;
}

const repoPath = (repo: RepoRef) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export const runnerVersionSourcesClient = {
  /**
   * The text of `path` on the DEFAULT BRANCH — `GET /repos/{o}/{r}/contents/{path}`
   * with no `ref`, asked for raw so the body is the file itself.
   */
  async fileOnDefaultBranch(repo: RepoRef, path: string, token: string | null): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await get(
      `${repoPath(repo)}/contents/${encoded}`,
      'application/vnd.github.raw+json',
      token,
    );
    try {
      return await res.text();
    } catch (err) {
      throw new RunnerVersionSourceError(
        res.status,
        err instanceof Error ? err.message : 'unreadable body',
      );
    }
  },

  /**
   * The newest 100 releases, as GitHub returns them —
   * `GET /repos/{o}/{r}/releases?per_page=100`. The caller parses the body.
   */
  async releases(repo: RepoRef, token: string | null): Promise<unknown> {
    const res = await get(
      `${repoPath(repo)}/releases?per_page=100`,
      'application/vnd.github+json',
      token,
    );
    try {
      return await res.json();
    } catch {
      throw new RunnerVersionSourceError(res.status, 'release list was not JSON');
    }
  },
};
