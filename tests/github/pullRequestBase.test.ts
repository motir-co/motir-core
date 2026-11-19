import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PullRequestBaseReadError,
  readBaseRefFromPayload,
  readPullRequestBaseRef,
} from '@/lib/github/pullRequestBase';

/** Who the read names itself as (MOTIR-11842); its throttle lines carry it. */
const SITE = { caller: 'pullRequestBaseRefBackfill', installationId: '144235820' } as const;

// The pull-request BASE-BRANCH read leaf (MOTIR-3034) — the wire contract behind
// the `base_ref` backfill: which endpoint is read, what counts as an ANSWER, and
// which failures are the caller's to see. `fetch` is stubbed; no database is
// involved, which is the point of keeping the host boundary in its own module.
//
// The load-bearing distinction asserted here is UNANSWERABLE vs ERROR. A pull
// request the installation can no longer see is an ANSWER — the row keeps its
// null, `classifyRepoDelivery` keeps reading it as UNKNOWN, and the item stays
// held. That is the fail-closed doctrine working. Only a host that could not be
// reached at all is thrown, so a sweep can report the repository and continue.

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Drive a call to completion with fake timers, so a retry's backoff does not make
 * the suite wait for it in wall-clock seconds.
 *
 * The LOOP (rather than one `runAllTimersAsync`) is deliberate, and is the same
 * shape `historicalPullRequests.test.ts` uses for the same reason: a retry creates
 * its NEXT sleep only after the previous one has fired, so a single advance would
 * return while the read is still parked on a timer that does not exist yet.
 */
async function run<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.finally(() => {
    settled = true;
  });
  tracked.catch(() => {}); // the awaiting caller owns the rejection, not this loop
  for (let i = 0; i < 100 && !settled; i += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return tracked;
}

describe('readBaseRefFromPayload', () => {
  it('reads `base.ref` — the same path the webhook parser and the listing read', () => {
    expect(readBaseRefFromPayload({ number: 7, base: { ref: 'main' } })).toEqual({
      kind: 'answered',
      baseRef: 'main',
    });
    // Never a hard-coded 'main': a self-hoster's trunk is whatever their repo says.
    expect(readBaseRefFromPayload({ base: { ref: 'trunk' } })).toEqual({
      kind: 'answered',
      baseRef: 'trunk',
    });
  });

  it('is UNANSWERABLE — never a default — when the payload carries no base', () => {
    for (const raw of [null, {}, { base: {} }, { base: { ref: '' } }, { base: { ref: 7 } }]) {
      expect(readBaseRefFromPayload(raw).kind).toBe('unanswerable');
    }
  });
});

describe('readPullRequestBaseRef', () => {
  it('reads the SINGLE-pull-request endpoint with the installation token', async () => {
    fetchMock.mockResolvedValue(ok({ base: { ref: 'main' } }));

    const read = await run(
      readPullRequestBaseRef('ghs_test', 'moooon-B-V', 'motir-core', 2121, SITE),
    );

    expect(read).toEqual({ kind: 'answered', baseRef: 'main' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/moooon-B-V/motir-core/pulls/2121');
    expect((init as RequestInit & { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer ghs_test',
    );
  });

  it('a 404 / 410 is an ANSWER — unanswerable, not an error and not a retry', async () => {
    for (const status of [404, 410]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response('{}', { status }));

      const read = await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE));

      expect(read.kind).toBe('unanswerable');
      // One call: the row is not there, so retrying it is spending rate limit on
      // a question that has been answered.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('a 200 whose payload lost its base is unanswerable, not a guess', async () => {
    fetchMock.mockResolvedValue(ok({ number: 1 }));
    expect((await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE))).kind).toBe('unanswerable');
  });

  it('retries a THROTTLED response and then answers', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(ok({ base: { ref: 'main' } }));

    const read = await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE));

    expect(read).toEqual({ kind: 'answered', baseRef: 'main' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('THROWS a typed error on a non-retryable failure, naming the repo and status', async () => {
    // A 403 with NO throttling header is an ACCESS failure — the installation
    // lost the repo — and must reach the caller so the sweep reports it.
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));

    await expect(
      run(readPullRequestBaseRef('t', 'moooon-B-V', 'motir-core', 9, SITE)),
    ).rejects.toBeInstanceOf(PullRequestBaseReadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a NETWORK failure and then throws with a null status', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const err = await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE).catch((e: unknown) => e));

    expect(err).toBeInstanceOf(PullRequestBaseReadError);
    // Null status is the tell that no response was ever received — the sweep's
    // report says "unreachable", not "the host said something".
    expect((err as PullRequestBaseReadError).status).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5); // MAX_ATTEMPTS
  });

  it('a 200 whose body is not JSON AT ALL is unanswerable, not a parse throw', async () => {
    // A proxy's HTML error page under a 200 makes `res.json()` REJECT. The row
    // must keep its null and the sweep must keep going — an unhandled
    // `SyntaxError` escaping here would abort a whole repository's repair.
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 200 }));

    expect((await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE))).kind).toBe('unanswerable');
  });

  it('THROWS when throttling outlasts the retry budget', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }));

    const err = await run(readPullRequestBaseRef('t', 'o', 'n', 1, SITE).catch((e: unknown) => e));

    expect(err).toBeInstanceOf(PullRequestBaseReadError);
    expect((err as PullRequestBaseReadError).status).toBe(429);
  });
});
