// Two commit-history reads of ONE repository (MOTIR-10393): the newest commit on
// the default branch that touched a path, and how two commits relate. The daily
// health check's runner-image freshness step asks both of the repository the
// runner image is built from. A LEAF PRIMITIVE in the `lib/github/appAuth.ts`
// sense: services import it, routes never do.
//
// The token is the caller's: an installation token when the deployment has one
// for the repository's owner, or null for an ANONYMOUS read, which a public
// repository answers (60 requests an hour per address — the step makes a
// handful a day).

const GITHUB_API = 'https://api.github.com';

/** A read GitHub refused or that never reached it. `status` is null on a
 *  transport failure. Carries a short detail, never a body or token. */
export class RepoCommitHistoryError extends Error {
  readonly code = 'REPO_COMMIT_HISTORY_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached (${detail}).`
        : `GitHub refused the read (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepoCommitHistoryError';
  }
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface TouchingCommit {
  sha: string;
  /** ISO-8601 committer date. */
  committedAt: string;
  /** The first line of the commit message. */
  subject: string;
}

/** How `head` relates to `base`, in GitHub's compare vocabulary. */
export type CommitRelation = 'ahead' | 'behind' | 'identical' | 'diverged';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function getJson(
  path: string,
  token: string | null,
): Promise<{ res: Response; body: unknown }> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'motir',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, { method: 'GET', headers });
  } catch (err) {
    throw new RepoCommitHistoryError(null, err instanceof Error ? err.message : 'unknown');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = asRecord(body)?.['message'];
    throw new RepoCommitHistoryError(
      res.status,
      typeof message === 'string' ? message.slice(0, 200) : '',
    );
  }
  return { res, body };
}

const repoPath = (repo: RepoRef) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export const repoCommitHistoryClient = {
  /**
   * The newest commit on the DEFAULT BRANCH that touched `path` (a file or a
   * directory), or null when none ever did. `GET /repos/{o}/{r}/commits?path=`
   * with no `sha` reads the default branch.
   */
  async newestTouching(
    repo: RepoRef,
    path: string,
    token: string | null,
  ): Promise<TouchingCommit | null> {
    const { res, body } = await getJson(
      `${repoPath(repo)}/commits?path=${encodeURIComponent(path)}&per_page=1`,
      token,
    );
    if (!Array.isArray(body)) {
      throw new RepoCommitHistoryError(res.status, 'commit list was not a list');
    }
    const first = asRecord(body[0]);
    if (!first) return null;
    const sha = first['sha'];
    const commit = asRecord(first['commit']);
    const date = asRecord(commit?.['committer'])?.['date'];
    const message = commit?.['message'];
    if (typeof sha !== 'string' || typeof date !== 'string') {
      throw new RepoCommitHistoryError(res.status, 'commit carried no sha or date');
    }
    return {
      sha,
      committedAt: date,
      subject: typeof message === 'string' ? (message.split('\n')[0] ?? '').slice(0, 200) : '',
    };
  },

  /**
   * How `head` relates to `base` — `GET /repos/{o}/{r}/compare/{base}...{head}`.
   * `ahead`: head has commits base lacks; `behind` or `identical`: head is
   * contained in base; `diverged`: each has commits the other lacks. A commit
   * GitHub does not know is its 404, thrown.
   */
  async relation(
    repo: RepoRef,
    base: string,
    head: string,
    token: string | null,
  ): Promise<CommitRelation> {
    const { res, body } = await getJson(
      `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      token,
    );
    const status = asRecord(body)?.['status'];
    if (
      status === 'ahead' ||
      status === 'behind' ||
      status === 'identical' ||
      status === 'diverged'
    ) {
      return status;
    }
    throw new RepoCommitHistoryError(res.status, 'compare returned no status');
  },
};
