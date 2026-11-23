import { githubFetch } from '@/lib/github/githubFetch';
import {
  MAX_ATTEMPTS,
  backoffMs,
  retryDelayMs,
  sleep,
  type GithubCallSite,
  type GithubCallerContext,
} from './restRetry';

// Open pull-request READ leaf (MOTIR-12057 · story MOTIR-11870) — page a
// repository's OPEN pull requests off the REST API with an installation token, for
// the one-time report that tells motir-codegraph which branches are under review.
//
// A sibling of `historicalPullRequests.ts`, not a flag on it: that leaf keeps
// merged rows only, by design, and normalizes into the mirror's change-request
// shape. This one keeps a different field set — the head's REPOSITORY id, to tell
// a same-repository head from a fork, and `updated_at`, the time the service's
// newest-wins rule orders reports on. The retry policy is the shared one
// (`./restRetry`), so both leaves wait on GitHub the same way.

const GITHUB_API = 'https://api.github.com';

/** Per-request deadline: an operator CLI, nothing upstream holds a connection. */
const GITHUB_TIMEOUT_MS = 30_000;

/** GitHub's maximum page size; a short page ends the walk. */
export const OPEN_PULL_REQUESTS_PER_PAGE = 100;

/** Pages walked before the leaf REPORTS a truncation rather than looping on a host
 *  that keeps answering full pages. 100 × 100 = 10 000 open pull requests. */
export const MAX_OPEN_PULL_REQUEST_PAGES = 100;

/** One same-repository open pull request, as the forward needs it. */
export interface OpenPullRequest {
  number: number;
  headRef: string;
  /** `updated_at`, kept as GitHub wrote it. */
  updatedAt: string;
}

/** One page of the walk. */
export interface OpenPullRequestPage {
  /** The same-repository heads on this page, in host order. */
  reports: OpenPullRequest[];
  /** Rows whose head lives in another repository, or whose fork was deleted. */
  forks: number;
  /** Same-repository rows missing a number, a head ref or a parseable `updated_at`. */
  malformed: number;
  /** Every row the page carried. */
  scanned: number;
  /** 1-based page number. */
  page: number;
  /** Whether the walk stopped at {@link MAX_OPEN_PULL_REQUEST_PAGES} with more to read. */
  truncated: boolean;
}

/** A repository's open pull requests could not be read: names the repository and
 *  the status, so the report records it on that repository and moves on. */
export class OpenPullRequestReadError extends Error {
  readonly code = 'OPEN_PR_READ_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Could not read ${repoRef} open pull requests${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'OpenPullRequestReadError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A GitHub numeric id as the string the mirror stores, or null. */
function readId(value: unknown): string | null {
  return typeof value === 'number' || (typeof value === 'string' && value !== '')
    ? String(value)
    : null;
}

/**
 * Classify one listed row against the repository's GitHub id.
 *
 * Same-repository means `head.repo.id` equals `providerRepoId`; a null `head.repo`
 * (the fork was deleted) is a fork too, because its branch is not in this
 * repository. A same-repository row missing a field is `malformed`, never guessed.
 */
export function classifyOpenPullRequest(
  raw: unknown,
  providerRepoId: string,
): { kind: 'report'; pr: OpenPullRequest } | { kind: 'fork' } | { kind: 'malformed' } {
  const pr = asRecord(raw);
  const head = asRecord(pr?.['head']);
  if (readId(asRecord(head?.['repo'])?.['id']) !== providerRepoId) {
    // A row with no head at all says nothing about where its branch lives.
    return head ? { kind: 'fork' } : { kind: 'malformed' };
  }
  const number = pr?.['number'];
  const headRef = head?.['ref'];
  const updatedAt = pr?.['updated_at'];
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number < 1 ||
    typeof headRef !== 'string' ||
    headRef === '' ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return { kind: 'malformed' };
  }
  return { kind: 'report', pr: { number, headRef, updatedAt } };
}

async function fetchPage(
  token: string,
  owner: string,
  name: string,
  page: number,
  site: GithubCallSite,
): Promise<unknown[]> {
  const repoRef = `${owner}/${name}`;
  // `sort=created&direction=asc` pins the walk: a pull request opened mid-walk lands
  // at the end, and none shifts across a page boundary.
  const url =
    `${GITHUB_API}/repos/${owner}/${name}/pulls` +
    `?state=open&sort=created&direction=asc&per_page=${OPEN_PULL_REQUESTS_PER_PAGE}&page=${page}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await githubFetch(
        site,
        url,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'motir',
          },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        },
        attempt,
      );
    } catch (err) {
      if (attempt === MAX_ATTEMPTS)
        throw new OpenPullRequestReadError(
          repoRef,
          null,
          err instanceof Error ? err.message : 'unreachable',
        );
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (!Array.isArray(body))
        throw new OpenPullRequestReadError(repoRef, res.status, 'expected a JSON array');
      return body;
    }

    const delay = retryDelayMs(res.status, res.headers, attempt, Date.now());
    if (delay === null || attempt === MAX_ATTEMPTS)
      throw new OpenPullRequestReadError(
        repoRef,
        res.status,
        delay === null ? 'not retryable' : 'still throttled after the retry budget',
      );
    await sleep(delay);
  }

  /* v8 ignore next 2 -- unreachable: the loop returns or throws on its last attempt */
  throw new OpenPullRequestReadError(repoRef, null, 'retry loop exhausted');
}

/**
 * Walk a repository's OPEN pull requests, oldest first, one page at a time, until
 * a page holds fewer than {@link OPEN_PULL_REQUESTS_PER_PAGE} rows. Hitting the
 * page bound is reported as `truncated: true` on the last page, never a silent stop.
 */
export async function* listOpenPullRequests(
  token: string,
  owner: string,
  name: string,
  providerRepoId: string,
  context: GithubCallerContext,
): AsyncGenerator<OpenPullRequestPage> {
  const site = { ...context, repository: `${owner}/${name}` };
  for (let page = 1; page <= MAX_OPEN_PULL_REQUEST_PAGES; page += 1) {
    const rows = await fetchPage(token, owner, name, page, site);
    const reports: OpenPullRequest[] = [];
    let forks = 0;
    let malformed = 0;
    for (const row of rows) {
      const read = classifyOpenPullRequest(row, providerRepoId);
      if (read.kind === 'report') reports.push(read.pr);
      else if (read.kind === 'fork') forks += 1;
      else malformed += 1;
    }
    const last = rows.length < OPEN_PULL_REQUESTS_PER_PAGE;
    yield {
      reports,
      forks,
      malformed,
      scanned: rows.length,
      page,
      truncated: !last && page === MAX_OPEN_PULL_REQUEST_PAGES,
    };
    if (last) return;
  }
}
