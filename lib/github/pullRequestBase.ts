import {
  MAX_ATTEMPTS,
  backoffMs,
  noteGithubRequest,
  observeGithubThrottle,
  retryDelayMs,
  sleep,
  type GithubCallerContext,
} from './restRetry';

// Pull-request BASE-BRANCH read leaf (MOTIR-3034) — one authenticated
// `GET /repos/{owner}/{name}/pulls/{number}`, reduced to the single field the
// repository-set completion gate is missing on a pre-column mirror row.
//
// WHY A TARGETED READ AND NOT THE HISTORICAL SWEEP BESIDE IT. `listMergedPullRequests`
// already re-reads a repository's whole merged history and its service already
// writes `baseRef`, so running THAT would also fill these rows. It is the wrong
// instrument here for two reasons:
//   * COST. The rows with a null base are a bounded, finite set — every mirror row
//     written before the `base_ref` migration — and there are far fewer of them
//     than there are merged pull requests in a repository's history. One request
//     per affected ROW is strictly cheaper than one per hundred rows of history,
//     against the same rate limit.
//   * BLAST RADIUS. The historical sweep rewrites the whole content tuple —
//     `state`, `merged`, `head_ref`, `title` and the RESOLVED work-item link. This
//     repair has no business re-deriving a link. It writes ONE column, only where
//     that column is null, so a row it touches differs from its previous self in
//     exactly the fact that was missing.
//
// ⚠️ AN UNANSWERABLE READ IS A RESULT, NOT AN ERROR. A pull request the
// installation can no longer see — deleted repository, transferred repository, a
// number that 404s — must leave the row NULL. `classifyRepoDelivery` reads null as
// UNKNOWN and holds the item, which is the correct and deliberate fail-closed
// state (`lib/workItems/repoDelivery.ts`); writing a guess to escape it is the one
// thing this whole repair is not allowed to do. So the leaf distinguishes "the
// host answered, and the answer is that this pull request is not available" from
// "the host could not be reached", and only the second is thrown.

const GITHUB_API = 'https://api.github.com';

/** Per-request deadline. Same value and same reason as the historical listing's:
 *  this runs from an operator CLI, so nothing upstream holds a connection, but a
 *  wedged host must surface as an error inside a resumable run. */
const GITHUB_TIMEOUT_MS = 30_000;

/** What the host had to say about one pull request's base branch.
 *
 *  - `answered` — the base branch, verbatim from the provider.
 *  - `unanswerable` — the host responded, and the response does not contain a
 *    base branch for this pull request (it is gone, or the payload is malformed).
 *    The caller leaves the column null; it does NOT retry and it does NOT guess. */
export type PullRequestBaseRead =
  | { kind: 'answered'; baseRef: string }
  | { kind: 'unanswerable'; reason: string };

/** Raised when a repository's pull requests cannot be read AT ALL — a revoked
 *  token, an installation that lost the repo, an exhausted rate limit that
 *  outlasted the retries. Carries the repo so a sweep can report it and move to
 *  the next one rather than aborting the whole run (the historical sweep's
 *  per-repo error contract, unchanged). */
export class PullRequestBaseReadError extends Error {
  readonly code = 'PULL_REQUEST_BASE_READ_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Could not read ${repoRef} pull request${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'PullRequestBaseReadError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Pull the `base.ref` out of a single-pull-request payload.
 *
 * The single-PR endpoint returns the SAME `pull_request` object the webhook
 * delivers and the listing yields, so this reads the identical path
 * (`base.ref`) that `githubProvider.parseChangeRequest` and
 * `normalizeHistoricalPullRequest` read — which is what makes a backfilled base
 * indistinguishable from a live-delivered one.
 *
 * A payload with no usable `base.ref` is UNANSWERABLE, never a default.
 */
export function readBaseRefFromPayload(raw: unknown): PullRequestBaseRead {
  const baseRef = asRecord(asRecord(raw)?.['base'])?.['ref'];
  if (typeof baseRef !== 'string' || baseRef.length === 0)
    return { kind: 'unanswerable', reason: 'the payload carries no base branch' };
  return { kind: 'answered', baseRef };
}

/**
 * Read ONE pull request's base branch off GitHub with an installation token.
 *
 * Retries a throttled or transiently-failed response on the shared policy
 * (`./restRetry`), so a sweep over many rows backs off exactly as the historical
 * walk does rather than hammering a limit the other leaf is already respecting.
 *
 * `404` / `410` are ANSWERS: the pull request is not there to be read. They
 * resolve to `unanswerable`, never an error and never a guess.
 */
export async function readPullRequestBaseRef(
  token: string,
  owner: string,
  name: string,
  number: number,
  context: GithubCallerContext,
): Promise<PullRequestBaseRead> {
  const repoRef = `${owner}/${name}`;
  const url = `${GITHUB_API}/repos/${owner}/${name}/pulls/${number}`;
  const site = { ...context, repository: repoRef };

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
      // Network / timeout: retryable on the same budget as a 5xx.
      if (attempt === MAX_ATTEMPTS)
        throw new PullRequestBaseReadError(
          `${repoRef}#${number}`,
          null,
          err instanceof Error ? err.message : 'unreachable',
        );
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      return readBaseRefFromPayload(body);
    }

    // The pull request itself is gone (deleted or transferred repository, a
    // number that never existed). The host answered; the answer is that there is
    // nothing to read, and the row stays UNKNOWN.
    if (res.status === 404 || res.status === 410)
      return { kind: 'unanswerable', reason: `the host returned ${res.status}` };

    observeGithubThrottle(site, res.status, res.headers, attempt);
    const delay = retryDelayMs(res.status, res.headers, attempt, Date.now());
    if (delay === null || attempt === MAX_ATTEMPTS)
      throw new PullRequestBaseReadError(
        `${repoRef}#${number}`,
        res.status,
        delay === null ? 'not retryable' : 'still throttled after the retry budget',
      );
    await sleep(delay);
  }

  // Unreachable: the loop either returns or throws on its last attempt.
  throw new PullRequestBaseReadError(`${repoRef}#${number}`, null, 'retry loop exhausted');
}
