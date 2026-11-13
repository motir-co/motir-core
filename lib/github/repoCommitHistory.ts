// Two commit-history reads of ONE repository (MOTIR-10393): the newest commit on
// the default branch that touched a path, and how two commits relate. The daily
// health check's runner-image freshness step asks both of the repository the
// runner image is built from. The Services page (MOTIR-11112) adds two more:
// a repository's default-branch head, and a comparison with its count and its
// oldest commit, to say how far a deployed commit is behind. A LEAF PRIMITIVE in the `lib/github/appAuth.ts`
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

/** The default branch and the commit at its head. */
export interface DefaultBranchHead {
  branch: string;
  sha: string;
}

/** How `head` relates to `base`, with the counts and the OLDEST commit `head`
 *  has that `base` lacks — the Services page's question (MOTIR-11112). */
export interface CommitComparison {
  relation: CommitRelation;
  /** Commits `head` has that `base` lacks. */
  aheadBy: number;
  /** The committer date (ISO-8601) of the oldest of those, or null when there
   *  are none. */
  oldestAheadAt: string | null;
}

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

function isRelation(value: unknown): value is CommitRelation {
  return value === 'ahead' || value === 'behind' || value === 'identical' || value === 'diverged';
}

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
    if (isRelation(status)) return status;
    throw new RepoCommitHistoryError(res.status, 'compare returned no status');
  },

  /**
   * The repository's default branch and its head commit: `GET /repos/{o}/{r}`
   * names the branch, `GET /repos/{o}/{r}/branches/{branch}` its head.
   */
  async defaultBranchHead(repo: RepoRef, token: string | null): Promise<DefaultBranchHead> {
    const meta = await getJson(repoPath(repo), token);
    const branch = asRecord(meta.body)?.['default_branch'];
    if (typeof branch !== 'string' || branch === '') {
      throw new RepoCommitHistoryError(meta.res.status, 'repository named no default branch');
    }
    const head = await getJson(`${repoPath(repo)}/branches/${encodeURIComponent(branch)}`, token);
    const sha = asRecord(asRecord(head.body)?.['commit'])?.['sha'];
    if (typeof sha !== 'string') {
      throw new RepoCommitHistoryError(head.res.status, 'branch carried no head commit');
    }
    return { branch, sha };
  },

  /**
   * `relation`'s compare, with the number of commits `head` has that `base`
   * lacks and the committer date of the OLDEST of them. GitHub lists a
   * comparison's commits oldest first and pages them, so page 1 of one is that
   * oldest commit. A commit GitHub does not know is its 404, thrown.
   */
  async compare(
    repo: RepoRef,
    base: string,
    head: string,
    token: string | null,
  ): Promise<CommitComparison> {
    const { res, body } = await getJson(
      `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1&page=1`,
      token,
    );
    const answer = asRecord(body);
    const status = answer?.['status'];
    const aheadBy = answer?.['ahead_by'];
    if (!isRelation(status) || typeof aheadBy !== 'number') {
      throw new RepoCommitHistoryError(res.status, 'compare returned no status');
    }
    if (aheadBy === 0) return { relation: status, aheadBy, oldestAheadAt: null };
    const commits = answer?.['commits'];
    const oldest = Array.isArray(commits) ? asRecord(commits[0]) : null;
    const date = asRecord(asRecord(oldest?.['commit'])?.['committer'])?.['date'];
    if (typeof date !== 'string') {
      throw new RepoCommitHistoryError(res.status, 'compare listed no dated commit');
    }
    return { relation: status, aheadBy, oldestAheadAt: date };
  },
};
