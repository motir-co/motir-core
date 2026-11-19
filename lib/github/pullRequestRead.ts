import {
  MAX_ATTEMPTS,
  backoffMs,
  noteGithubRequest,
  observeGithubThrottle,
  retryDelayMs,
  sleep,
  type GithubCallerContext,
} from './restRetry';

// Single pull-request READ leaf (MOTIR-5390) — one authenticated
// `GET /repos/{owner}/{name}/pulls/{number}`, returned as the RAW `pull_request`
// object so the open-delivery reconcile can hand it to the webhook's own
// `pull_request` arm unchanged.
//
// WHY THE RAW PAYLOAD AND NOT A NORMALIZED CHANGE REQUEST. The single-PR endpoint
// returns the same object a `pull_request` delivery carries — `state`, `merged`,
// `merged_at`, `draft`, `head`, `base` (with `base.repo.id`) and `user`. Handing
// it on verbatim means the reconcile reaches `githubProvider.parseChangeRequestEvent`,
// the author attribution and the merged-path capture through exactly the code a
// real delivery goes through, instead of a second normalization that could drift
// from the first.
//
// ⚠️ AN UNANSWERABLE READ IS A RESULT, NOT AN ERROR — the same contract
// `pullRequestBase.ts` states. `404` / `410` mean the host answered and the pull
// request is not there to read (a deleted or transferred repository). The caller
// records that and moves on; only "the host could not be reached" is thrown.

const GITHUB_API = 'https://api.github.com';

/** Per-request deadline. Shorter than the operator-CLI leaves beside it: this runs
 *  inside a scheduled job, where a wedged host should cost one row, not the run. */
const GITHUB_TIMEOUT_MS = 15_000;

/** What the host said about one pull request. */
export type PullRequestRead =
  | { kind: 'found'; pullRequest: Record<string, unknown> }
  | { kind: 'gone'; status: number };

/** Raised when the pull request cannot be read at all — a revoked token, an
 *  installation that lost the repo, a rate limit that outlasted the retries, a
 *  malformed body. Carries the reference so a sweep can report it per row. */
export class PullRequestReadError extends Error {
  readonly code = 'PULL_REQUEST_READ_FAILED' as const;
  constructor(
    readonly ref: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Could not read ${ref}${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'PullRequestReadError';
  }
}

/**
 * Read ONE pull request off GitHub with an installation token.
 *
 * Retries a throttled or transiently-failed response on the shared policy
 * (`./restRetry`), so the reconcile backs off exactly as the other read leaves do.
 */
export async function readPullRequest(
  token: string,
  owner: string,
  name: string,
  number: number,
  context: GithubCallerContext,
): Promise<PullRequestRead> {
  const ref = `${owner}/${name}#${number}`;
  const url = `${GITHUB_API}/repos/${owner}/${name}/pulls/${number}`;
  const site = { ...context, repository: `${owner}/${name}` };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    noteGithubRequest(site);
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'motir',
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS)
        throw new PullRequestReadError(
          ref,
          null,
          err instanceof Error ? err.message : 'unreachable',
        );
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        throw new PullRequestReadError(ref, res.status, 'expected a JSON object');
      return { kind: 'found', pullRequest: body as Record<string, unknown> };
    }

    if (res.status === 404 || res.status === 410) return { kind: 'gone', status: res.status };

    observeGithubThrottle(site, res.status, res.headers, attempt);
    const delay = retryDelayMs(res.status, res.headers, attempt, Date.now());
    if (delay === null || attempt === MAX_ATTEMPTS)
      throw new PullRequestReadError(
        ref,
        res.status,
        delay === null ? 'not retryable' : 'still throttled after the retry budget',
      );
    await sleep(delay);
  }

  // Unreachable: the loop either returns or throws on its last attempt.
  throw new PullRequestReadError(ref, null, 'retry loop exhausted');
}
