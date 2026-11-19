// Shared GitHub REST throttling policy for the read leaves (MOTIR-3034).
//
// Extracted from `historicalPullRequests.ts`, which owned it alone until a
// second leaf needed it (`pullRequestBase.ts`). Kept as ONE module rather than
// copied, for the same reason `lib/workItems/repoDelivery.ts` is one module: two
// throttling rules against the same host, on the same installation token and the
// same rate limit, would drift into two different ideas of when GitHub is asking
// us to wait — and the one that drifts LOW is the one that gets the installation
// secondary-limited for every other caller.

/** Attempts per request before the error propagates — the initial try plus
 *  retries for a rate-limited or transiently-failed response. */
export const MAX_ATTEMPTS = 5;

/** Ceiling on ONE rate-limit sleep. GitHub's primary-limit reset can be up to an
 *  hour away; waiting that long inside a single request would look like a hang.
 *  Capped, then retried — with the attempt budget above, a genuinely exhausted
 *  primary limit ends the run with a clear error and the operator re-runs later
 *  (every caller of this policy is idempotent, so a re-run resumes). */
export const MAX_BACKOFF_MS = 60_000;

/** The floor between retries, doubled per attempt. */
export const BASE_BACKOFF_MS = 1_000;

/** Sleep, bounded by {@link MAX_BACKOFF_MS}. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_BACKOFF_MS)));
}

/** The plain exponential backoff for attempt `n` (1-based). */
export function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * WHICH throttle a response is, when it is one (Bug MOTIR-11841) — or null for a
 * response GitHub did not throttle.
 *
 * GitHub signals throttling three ways and this checks all three, because they
 * do not co-occur: a SECONDARY limit sends `retry-after` (seconds) on a 403; a
 * PRIMARY limit sends `x-ratelimit-remaining: 0` plus `x-ratelimit-reset` (unix
 * seconds) on a 403 or 429; and a bare 429 may carry neither. `waitMs` is the wait
 * the host NAMED — the retry-after, or the time left until the reset (never
 * negative) — and null for the bare 429, which names none.
 *
 * ⚠️ A 403 WITH NO THROTTLING SIGNAL IS NOT HERE. It is an ACCESS failure (the
 * installation lost the repository, or lacks a permission), and the merge path
 * reports it as one; reading it as a throttle would tell a person to wait for a
 * setting nobody changes.
 */
export type GithubThrottle =
  | { signal: 'retry_after' | 'rate_limit_reset'; waitMs: number }
  | { signal: 'too_many_requests'; waitMs: null };

export function githubThrottle(
  status: number,
  headers: { get(name: string): string | null },
  nowMs: number,
): GithubThrottle | null {
  if (status !== 403 && status !== 429) return null;

  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return { signal: 'retry_after', waitMs: retryAfter * 1_000 };
  }

  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (remaining === 0 && Number.isFinite(reset) && reset > 0) {
    // `reset` is unix SECONDS; one already in the past is a wait of nothing.
    return { signal: 'rate_limit_reset', waitMs: Math.max(reset * 1_000 - nowMs, 0) };
  }

  return status === 429 ? { signal: 'too_many_requests', waitMs: null } : null;
}

/**
 * How long to wait before retrying a response, or null when the response is not
 * retryable.
 *
 * A throttle ({@link githubThrottle}) waits what the host named: the `retry-after`
 * as given, a primary-limit reset with the backoff floor under it (so a reset
 * already in the past, or a clock skew, cannot spin the retry loop), and a bare 429
 * the plain backoff. A 5xx is retried on plain exponential backoff. Anything else —
 * 401, 404, 422, a 403 with no throttling signal — is a real failure the caller
 * must see, so it returns null.
 */
export function retryDelayMs(
  status: number,
  headers: { get(name: string): string | null },
  attempt: number,
  nowMs: number,
): number | null {
  const backoff = backoffMs(attempt);

  if (status === 403 || status === 429) {
    const throttle = githubThrottle(status, headers, nowMs);
    if (!throttle) return null;
    if (throttle.signal === 'retry_after') return throttle.waitMs;
    if (throttle.signal === 'rate_limit_reset') return Math.max(throttle.waitMs, backoff);
    return backoff;
  }

  if (status >= 500) return backoff;
  return null;
}
