import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoricalPullRequestReadError,
  listMergedPullRequests,
  MAX_PULL_REQUEST_PAGES,
  normalizeHistoricalPullRequest,
} from '@/lib/github/historicalPullRequests';
// The throttling policy moved to a shared leaf when a second reader needed it
// (MOTIR-3034); the assertions below are unchanged, and are the ONE place that
// rule is pinned for every GitHub read leaf.
import { retryDelayMs } from '@/lib/github/restRetry';

// The historical-PR READ leaf (MOTIR-1965) — the wire contract behind the
// mirror backfill: WHICH endpoint is walked, which rows survive normalization,
// and what each throttling signal means. `fetch` is stubbed (the convention the
// metering + provisioning suites use); no database is involved, which is the
// point of keeping the host boundary in its own module.
//
// The `merged_at` filter is asserted here rather than in the service, because
// this is the layer that decides it: a closed-unmerged PR must never leave this
// module, since `hasLinkedPr` (the provenance classifier's evidence) does not
// read the `merged` column and would stamp `byok` on an abandoned PR.

const OWNER = 'moooon-B-V';
const NAME = 'motir-core';
const REPO_ID = '555';
const TOKEN = 'ghs_test';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** One row as GitHub's `GET /repos/{o}/{n}/pulls` returns it. */
function ghPull(
  number: number,
  opts: { mergedAt?: string | null; headRef?: string; title?: string | null } = {},
): Record<string, unknown> {
  return {
    number,
    state: 'closed',
    title: opts.title === undefined ? `A change (MOTIR-${number})` : opts.title,
    merged_at: opts.mergedAt === undefined ? '2026-06-20T10:00:00Z' : opts.mergedAt,
    head: { ref: opts.headRef ?? `subtask/MOTIR-${number}-slug`, sha: `sha-${number}` },
    base: { ref: 'main' },
  };
}

function jsonPage(rows: unknown[], init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * Drain the generator, advancing fake timers so the backoff sleeps resolve
 * without the suite paying them in wall-clock seconds.
 *
 * The loop (rather than one `runAllTimersAsync`) is deliberate: a retry creates
 * its NEXT sleep only after the previous one has fired, so a single advance
 * would return while the generator is still parked on a timer that does not
 * exist yet. It keeps advancing until the pump settles.
 */
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  let settled = false;
  const pump = (async () => {
    for await (const page of gen) out.push(page);
  })().finally(() => {
    settled = true;
  });
  pump.catch(() => {}); // the awaiting caller owns the rejection, not this loop
  for (let i = 0; i < 100 && !settled; i += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  await pump;
  return out;
}

describe('normalizeHistoricalPullRequest', () => {
  it('produces the same NormalizedChangeRequest shape the webhook parser does', () => {
    const pr = normalizeHistoricalPullRequest(ghPull(42), REPO_ID);
    expect(pr).not.toBeNull();
    expect(pr!.changeRequest).toEqual({
      providerRepoId: REPO_ID,
      number: 42,
      state: 'closed',
      merged: true,
      headRef: 'subtask/MOTIR-42-slug',
      baseRef: 'main',
      title: 'A change (MOTIR-42)',
      // MOTIR-4968 — the seam grew a required `draft`, and this backfill states
      // it as a LITERAL false for the same reason it states `state: 'closed'`:
      // this path only ever produces a MERGED pull request, which is never a
      // draft and which the lifecycle answers `done` on before the draft guard
      // is reached. That is exactly the parity this test asserts, so the field
      // belongs in the expectation rather than being excluded from it.
      draft: false,
      // MOTIR-7005 — the head commit, read off `head.sha` like the ref beside it.
      headSha: 'sha-42',
      // MOTIR-10340 — the author is not backfilled: a historical row has none.
      author: null,
    });
    expect(pr!.mergedAt.toISOString()).toBe('2026-06-20T10:00:00.000Z');
  });

  it('rejects a closed-UNMERGED pull request (merged_at null)', () => {
    expect(normalizeHistoricalPullRequest(ghPull(7, { mergedAt: null }), REPO_ID)).toBeNull();
  });

  it('rejects a row missing a required field, rather than defaulting to a guess', () => {
    expect(normalizeHistoricalPullRequest({ ...ghPull(1), number: 'one' }, REPO_ID)).toBeNull();
    expect(normalizeHistoricalPullRequest({ ...ghPull(1), head: {} }, REPO_ID)).toBeNull();
    expect(normalizeHistoricalPullRequest({ ...ghPull(1), base: {} }, REPO_ID)).toBeNull();
    expect(
      normalizeHistoricalPullRequest({ ...ghPull(1), merged_at: 'not-a-date' }, REPO_ID),
    ).toBeNull();
    expect(normalizeHistoricalPullRequest(null, REPO_ID)).toBeNull();
    expect(normalizeHistoricalPullRequest('a string', REPO_ID)).toBeNull();
  });

  it('carries a null title through (the mirror column is nullable)', () => {
    const pr = normalizeHistoricalPullRequest(ghPull(3, { title: null }), REPO_ID);
    expect(pr!.changeRequest.title).toBeNull();
  });
});

describe('retryDelayMs — the three throttling signals GitHub sends', () => {
  const at = (h: Record<string, string>) => new Headers(h);
  const NOW = 1_800_000_000_000; // fixed; the unit is ms since epoch

  it('honours a secondary limit’s retry-after (seconds)', () => {
    expect(retryDelayMs(403, at({ 'retry-after': '30' }), 1, NOW)).toBe(30_000);
  });

  it('waits for a primary limit’s reset when remaining is 0', () => {
    const reset = String(Math.floor(NOW / 1000) + 45);
    expect(
      retryDelayMs(403, at({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 1, NOW),
    ).toBe(45_000);
  });

  it('never returns less than the backoff floor for a reset already in the past', () => {
    const reset = String(Math.floor(NOW / 1000) - 600); // clock skew
    const delay = retryDelayMs(
      403,
      at({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
      2,
      NOW,
    );
    expect(delay).toBe(2_000); // BASE_BACKOFF_MS * 2^(attempt-1)
  });

  it('treats a 403 with NO throttling signal as an access failure, not a rate limit', () => {
    expect(retryDelayMs(403, at({}), 1, NOW)).toBeNull();
  });

  it('retries a bare 429 and any 5xx on exponential backoff', () => {
    expect(retryDelayMs(429, at({}), 1, NOW)).toBe(1_000);
    expect(retryDelayMs(500, at({}), 3, NOW)).toBe(4_000);
    expect(retryDelayMs(502, at({}), 1, NOW)).toBe(1_000);
  });

  it('does not retry a 401 / 404 / 422', () => {
    for (const status of [401, 404, 422]) {
      expect(retryDelayMs(status, at({}), 1, NOW)).toBeNull();
    }
  });
});

describe('listMergedPullRequests', () => {
  it('walks CLOSED pull requests in stable creation order, 100 per page', async () => {
    fetchMock.mockImplementation(async () => jsonPage([ghPull(1)]));

    await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.github.com/repos/${OWNER}/${NAME}/pulls` +
        '?state=closed&sort=created&direction=asc&per_page=100&page=1',
    );
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('yields only MERGED pull requests but counts every closed one as scanned', async () => {
    fetchMock.mockImplementation(async () =>
      jsonPage([ghPull(1), ghPull(2, { mergedAt: null }), ghPull(3)]),
    );

    const pages = await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));

    expect(pages).toHaveLength(1);
    expect(pages[0]!.scanned).toBe(3);
    expect(pages[0]!.merged.map((p) => p.changeRequest.number)).toEqual([1, 3]);
  });

  it('paginates until a short page, and stops there', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ghPull(i + 1));
    fetchMock
      .mockImplementationOnce(async () => jsonPage(full))
      .mockImplementationOnce(async () => jsonPage([ghPull(101)]));

    const pages = await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages.every((p) => !p.truncated)).toBe(true);
  });

  it('stops on an EMPTY page without asking for another', async () => {
    fetchMock.mockImplementationOnce(async () => jsonPage([]));
    const pages = await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pages[0]!.scanned).toBe(0);
  });

  it('retries a throttled page and then succeeds — the run is not lost to a rate limit', async () => {
    fetchMock
      .mockImplementationOnce(
        async () =>
          new Response('{"message":"secondary rate limit"}', {
            status: 403,
            headers: { 'retry-after': '1' },
          }),
      )
      .mockImplementationOnce(async () => jsonPage([ghPull(9)]));

    const pages = await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages[0]!.merged.map((p) => p.changeRequest.number)).toEqual([9]);
  });

  it('throws a typed, repo-named error on a non-retryable status', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));

    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toThrow(
      HistoricalPullRequestReadError,
    );
    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toMatchObject({
      repoRef: `${OWNER}/${NAME}`,
      status: 404,
    });
  });

  it('gives up after the retry budget on a persistently throttled repo', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
    );

    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toThrow(
      /still throttled after the retry budget/,
    );
  });

  it('retries a network failure, then surfaces it as a typed error', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toMatchObject({
      repoRef: `${OWNER}/${NAME}`,
      status: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5); // MAX_ATTEMPTS
  });

  it('rejects a non-array body rather than reading it as an empty history', async () => {
    fetchMock.mockImplementation(async () =>
      jsonPage({ message: 'Not Found' } as unknown as unknown[]),
    );
    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toThrow(
      /expected a JSON array/,
    );
  });

  it('rejects a 200 whose body is not JSON AT ALL — an HTML error page is not an empty history', async () => {
    // The other arm of the same guard: a 200 carrying a proxy's HTML error page
    // makes `res.json()` REJECT, and the leaf's `.catch(() => null)` turns that
    // into the same typed read error rather than an unhandled parse throw
    // escaping a generator that a sweep is iterating. Without this the walk would
    // die mid-repository with a `SyntaxError` no report could attribute.
    fetchMock.mockImplementation(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    await expect(drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID))).rejects.toThrow(
      /expected a JSON array/,
    );
  });

  it('REPORTS truncation at the page bound instead of silently stopping', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ghPull(i + 1));
    fetchMock.mockImplementation(async () => jsonPage(full));

    const pages = await drain(listMergedPullRequests(TOKEN, OWNER, NAME, REPO_ID));

    expect(pages).toHaveLength(MAX_PULL_REQUEST_PAGES);
    expect(pages.at(-1)!.truncated).toBe(true);
    expect(pages.slice(0, -1).every((p) => !p.truncated)).toBe(true);
  });
});
