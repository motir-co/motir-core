import {
  noteGithubRequest,
  observeGithubThrottle,
  type GithubCaller,
  type GithubCallSite,
} from '@/lib/github/restRetry';

// THE ONE COUNTED DOOR TO GITHUB'S API (MOTIR-11844).
//
// MOTIR-11842 taught the pull-request read leaves and the merge seam to count
// every request they send (`GithubRequestCount`, one EMF series per caller) and
// to report every throttled answer as one `github.throttle` log line. Every other
// GitHub call in motir-core — check runs, provisioning, Actions, runners,
// deployments, collaborators, code scanning, the App and user reads — still
// called `fetch` itself, so a burst from any of them before a secondary limit
// could not be attributed.
//
// So EVERY request motir-core sends to GitHub goes through `githubFetch`, which
// takes the call site as its first argument: a new call site cannot reach GitHub
// without naming itself. `tests/github/githubFetchGuard.test.ts` fails on a raw
// `fetch` in any production module that talks to GitHub.
//
// It changes nothing about the request or its answer: the same `fetch`, the same
// `init`, the same `Response` (or the same thrown network error) comes back. It
// only counts the request before it is sent and passes the answer's status and
// headers to `observeGithubThrottle`, which writes a line only for a throttle.

/** A call site, or just its caller when the installation and repository are not
 *  known where the request is made. */
export type GithubSite = GithubCaller | GithubCallSite;

function siteOf(site: GithubSite): GithubCallSite {
  return typeof site === 'string' ? { caller: site, installationId: null, repository: null } : site;
}

/**
 * Send ONE request to GitHub on behalf of `site`: count it, send it with the
 * global `fetch`, report the answer if it is a throttle, and return it unchanged.
 *
 * `attempt` is the 1-based try of a call that retries, carried onto the throttle
 * line; leave it out for a call that does not.
 */
export async function githubFetch(
  site: GithubSite,
  input: string | URL,
  init?: RequestInit,
  attempt: number | null = null,
): Promise<Response> {
  const resolved = siteOf(site);
  noteGithubRequest(resolved);
  const res = await fetch(input, init);
  // The observation only READS an answer; it must never be what fails a call.
  // An answer without headers (a stub that resolves to nothing) goes back to the
  // caller untouched, so the caller's own handling sees exactly what `fetch`
  // gave it — and not a TypeError thrown here, inside the caller's network-error
  // `catch`, that would be retried as an outage.
  if (res?.headers) observeGithubThrottle(resolved, res.status, res.headers, attempt);
  return res;
}

/**
 * A `fetch`-shaped function bound to `site`, for a transport that takes the
 * function it sends with (`fetchWithinDeadline`). Each call is one counted
 * {@link githubFetch}.
 */
export function githubFetchFor(
  site: GithubSite,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => githubFetch(site, input, init);
}

/**
 * The before/after hooks for a retrying transport that owns its own loop
 * (`fetchWithRetry`): count each attempt as it is sent, report each answer that
 * throttled it.
 */
export function githubRequestHooks(site: GithubSite): {
  beforeRequest: () => void;
  afterResponse: (res: Response, attempt: number) => void;
} {
  const resolved = siteOf(site);
  return {
    beforeRequest: () => noteGithubRequest(resolved),
    afterResponse: (res, attempt) =>
      void observeGithubThrottle(resolved, res.status, res.headers, attempt),
  };
}
