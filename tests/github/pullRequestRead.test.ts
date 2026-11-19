import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PullRequestReadError, readPullRequest } from '@/lib/github/pullRequestRead';

/** Who the read names itself as (MOTIR-11842); its throttle lines carry it. */
const SITE = { caller: 'pullRequestReconcile', installationId: '144235820' } as const;

// The single pull-request READ leaf (MOTIR-5390) — the wire contract behind the
// open-delivery reconcile: which endpoint is read, what counts as an ANSWER, and
// which failures the caller sees. `fetch` is stubbed; no database is involved.
//
// The load-bearing distinction is GONE vs ERROR, the same one `pullRequestBase`
// draws: a pull request the host no longer has is an answer the reconcile records
// and moves past, and only a host that could not be read is thrown.

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

/** Drive a call through its retry sleeps with fake timers (the sibling leaves' shape). */
async function run<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.finally(() => {
    settled = true;
  });
  tracked.catch(() => {});
  for (let i = 0; i < 100 && !settled; i += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return tracked;
}

const PR = { number: 7, state: 'closed', merged: true, base: { ref: 'main' } };

describe('readPullRequest', () => {
  it('reads the single-PR endpoint with the installation token and returns the payload verbatim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(PR), { status: 200 }));

    await expect(run(readPullRequest('ghs_x', 'moooon', 'motir-meta', 7, SITE))).resolves.toEqual({
      kind: 'found',
      pullRequest: PR,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/moooon/motir-meta/pulls/7');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer ghs_x' });
  });

  it.each([404, 410])(
    'a %i is an ANSWER — the pull request is gone — not an error',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status }));
      await expect(run(readPullRequest('t', 'o', 'n', 1, SITE))).resolves.toEqual({
        kind: 'gone',
        status,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a 5xx and returns the answer that follows', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(PR), { status: 200 }));

    await expect(run(readPullRequest('t', 'o', 'n', 7, SITE))).resolves.toMatchObject({
      kind: 'found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure, and throws once the budget is spent', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const err = await run(readPullRequest('t', 'o', 'n', 7, SITE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestReadError);
    expect((err as PullRequestReadError).message).toContain('socket hang up');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('throws on a non-retryable status without retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    const err = await run(readPullRequest('t', 'o', 'n', 7, SITE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestReadError);
    expect((err as PullRequestReadError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws once a throttled response outlasts the retry budget', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 429 }));

    const err = await run(readPullRequest('t', 'o', 'n', 7, SITE)).catch((e: unknown) => e);
    expect((err as PullRequestReadError).message).toContain('still throttled');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([['[]'], ['null'], ['not json']])(
    'a 200 whose body is not a JSON object (%s) is an error, never a guessed payload',
    async (body) => {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const err = await run(readPullRequest('t', 'o', 'n', 7, SITE)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PullRequestReadError);
      expect((err as PullRequestReadError).message).toContain('expected a JSON object');
    },
  );
});
