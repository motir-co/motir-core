// Shared connector HTTP scaffolding (Story 7.16 · MOTIR-1501) — the paginate +
// rate-limit/retry helpers every live-API connector reuses (GitHub here; Jira +
// Linear on MOTIR-940; Plane on MOTIR-1639). Pure transport: no DB, no Prisma.
//
// `fetchWithRetry` backs off on 429 (honouring `Retry-After`) and 5xx, retries
// transient network throws, and translates a terminal non-2xx into a typed
// `ConnectorError` (auth → `ConnectorAuthError`, else `ConnectorHttpError`) so a
// raw HTTP failure never escapes a connector. `fetch`, `sleep`, and the jitter
// source are all injectable so the retry policy is deterministically testable
// without real network or real delays.

import { ConnectorAuthError, ConnectorHttpError } from './errors';
import { assertPublicHttpUrl } from './publicUrl';

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles each retry (default 500). */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait in ms (default 15_000). */
  maxDelayMs?: number;
  /** Injectable fetch (default the global `fetch`) — tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep — tests pass a no-op to skip real waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1) (default `Math.random`) — tests pass `() => 0`
   *  for a deterministic backoff. */
  random?: () => number;
  /** The source label, threaded into thrown errors' messages. */
  source?: string;
  signal?: AbortSignal;
  /** Called before each attempt is sent — a host that meters its own requests
   *  counts them here (GitHub, MOTIR-11844). */
  beforeRequest?: () => void;
  /** Called with each answer an attempt got, before it is judged. */
  afterResponse?: (res: Response, attempt: number) => void;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `Retry-After` header — either a delay in seconds, or an HTTP-date —
 *  into a millisecond wait. Returns null when absent / unparseable. `now` is
 *  injectable for a deterministic HTTP-date computation in tests. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/** Exponential backoff for `attempt` (1-based) with full jitter, capped at
 *  `maxDelayMs`. Exported for the connectors' own paging loops + tests. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(exp * random());
}

/** `url` without its trailing slashes — a scan, because `/\/+$/` backtracks
 *  polynomially on a long run of them (CodeQL js/polynomial-redos). */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * Fetch `url` with rate-limit/retry resilience. A request on the real network
 * goes only to a public address (`assertPublicHttpUrl`, MOTIR-7816). Returns the `Response` on the
 * first 2xx. Retries 429 (waiting `Retry-After` when present, else backoff) and
 * 5xx and network throws up to `maxAttempts`; a 401/403 throws immediately
 * (`ConnectorAuthError` — a retry cannot fix auth); any other 4xx throws
 * `ConnectorHttpError` (not retryable); an exhausted 429/5xx throws
 * `ConnectorHttpError`.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  // The real network only: an injected fetch is a test stub that reaches nothing.
  if (!opts.fetchImpl) await assertPublicHttpUrl(url, opts.source);

  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      opts.beforeRequest?.();
      res = await doFetch(url, { ...init, signal: opts.signal ?? init.signal });
    } catch (err) {
      // Network-level throw (DNS, reset, abort-less transient). Retry with
      // backoff; on the last attempt rethrow as a typed HTTP error.
      if (attempt >= maxAttempts) {
        throw new ConnectorHttpError(
          0,
          url,
          `network error after ${maxAttempts} attempts: ${String(err)}`,
          opts.source,
        );
      }
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }

    opts.afterResponse?.(res, attempt);
    if (res.ok) return res;
    lastStatus = res.status;

    if (res.status === 401 || res.status === 403) {
      // 403 can be a GitHub secondary rate-limit — retry ONLY when the response
      // carries a rate-limit signal; a plain 403/401 is auth and fails fast.
      const isRateLimited =
        res.status === 403 &&
        (res.headers.get('retry-after') !== null ||
          res.headers.get('x-ratelimit-remaining') === '0');
      if (!isRateLimited) {
        throw new ConnectorAuthError(
          res.status,
          `source rejected credentials (${res.status})`,
          opts.source,
        );
      }
    }

    const retryable = res.status === 429 || res.status >= 500 || res.status === 403;
    if (!retryable || attempt >= maxAttempts) {
      throw new ConnectorHttpError(res.status, url, `source returned ${res.status}`, opts.source);
    }

    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const wait = retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    await sleep(Math.min(wait, maxDelayMs));
  }

  // Unreachable (the loop either returns or throws), but keeps the type checker
  // happy and guards a future refactor.
  throw new ConnectorHttpError(lastStatus, url, `exhausted ${maxAttempts} attempts`, opts.source);
}

/**
 * Parse an RFC-5988 `Link` header (as GitHub / Jira paginate) into a
 * `rel → url` map, e.g. `{ next: 'https://…?page=2', last: '…?page=9' }`.
 * Returns `{}` when the header is absent / empty.
 */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    const rel = match?.[2];
    const link = match?.[1];
    if (rel && link) out[rel] = link;
  }
  return out;
}

/** Extract a query param's value from a URL string (used to read `page` out of
 *  a `Link: rel="next"` URL). Returns null when absent / malformed. */
export function queryParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    const captured = url.match(new RegExp(`[?&]${name}=([^&]+)`))?.[1];
    return captured ? decodeURIComponent(captured) : null;
  }
}

/**
 * Drive a paginated source to exhaustion as an async generator — the shared
 * "loop until no next cursor" the connectors' `listIssues` callers can use to
 * stream every page without materialising them all. `fetchPage` returns one
 * page + the next cursor (null = done). Never fetches all into memory: each
 * page is yielded before the next is fetched.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<{ page: T; nextCursor: string | null }>,
  startCursor: string | null = null,
): AsyncGenerator<T> {
  let cursor = startCursor;
  // Guard against a source that never terminates its cursor.
  const seen = new Set<string>();
  for (;;) {
    const { page, nextCursor } = await fetchPage(cursor);
    yield page;
    if (nextCursor === null) return;
    if (seen.has(nextCursor)) return;
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}
