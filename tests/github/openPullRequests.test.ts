import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OPEN_PULL_REQUEST_PAGES,
  OPEN_PULL_REQUESTS_PER_PAGE,
  OpenPullRequestReadError,
  classifyOpenPullRequest,
  listOpenPullRequests,
} from '@/lib/github/openPullRequests';

// The open pull-request READ leaf (MOTIR-12057 · story MOTIR-11870): which endpoint
// is walked, how far, which rows are same-repository heads, and what each host
// answer means. `fetch` is stubbed; no database.

const SITE = { caller: 'openPullRequestReport', installationId: '144235820' } as const;
const OWNER = 'moooon';
const NAME = 'acme';
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

/** One row as `GET /repos/{o}/{n}/pulls?state=open` returns it. */
function ghPull(
  number: number,
  opts: { headRepoId?: number | null; headRef?: string; updatedAt?: string } = {},
): Record<string, unknown> {
  return {
    number,
    state: 'open',
    updated_at: opts.updatedAt ?? `2026-11-2${number % 10}T10:00:00Z`,
    head: {
      ref: opts.headRef ?? `feature-${number}`,
      repo: opts.headRepoId === null ? null : { id: opts.headRepoId ?? Number(REPO_ID) },
    },
    base: { ref: 'main', repo: { id: Number(REPO_ID) } },
  };
}

const page = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ghPull(from + i));

function jsonPage(rows: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Drain the generator, advancing fake timers so backoff sleeps resolve at once. */
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  let settled = false;
  const pump = (async () => {
    for await (const item of gen) out.push(item);
  })().finally(() => {
    settled = true;
  });
  pump.catch(() => {});
  for (let i = 0; i < 100 && !settled; i += 1) await vi.advanceTimersByTimeAsync(60_000);
  await pump;
  return out;
}

const walk = () => drain(listOpenPullRequests(TOKEN, OWNER, NAME, REPO_ID, SITE));

describe('classifyOpenPullRequest', () => {
  it('reports a same-repository head as { number, headRef, updatedAt }', () => {
    expect(
      classifyOpenPullRequest(ghPull(7, { updatedAt: '2026-11-22T10:00:00Z' }), REPO_ID),
    ).toEqual({
      kind: 'report',
      pr: { number: 7, headRef: 'feature-7', updatedAt: '2026-11-22T10:00:00Z' },
    });
  });

  it('accepts a string head repository id equal to the repository id', () => {
    const row = { ...ghPull(7), head: { ref: 'x', repo: { id: REPO_ID } } };
    expect(classifyOpenPullRequest(row, REPO_ID).kind).toBe('report');
  });

  it.each([
    ['another repository', ghPull(7, { headRepoId: 999 })],
    ['a deleted fork (head.repo null)', ghPull(7, { headRepoId: null })],
    ['a head repository with no id', { ...ghPull(7), head: { ref: 'x', repo: {} } }],
  ])('counts %s as a fork', (_label, row) => {
    expect(classifyOpenPullRequest(row, REPO_ID)).toEqual({ kind: 'fork' });
  });

  it.each([
    ['no number', { ...ghPull(7), number: undefined }],
    ['a fractional number', { ...ghPull(7), number: 1.5 }],
    ['a zero number', { ...ghPull(7), number: 0 }],
    ['no head.ref', { ...ghPull(7), head: { repo: { id: Number(REPO_ID) } } }],
    ['an empty head.ref', ghPull(7, { headRef: '' })],
    ['no updated_at', { ...ghPull(7), updated_at: undefined }],
    ['an unparseable updated_at', ghPull(7, { updatedAt: 'yesterday' })],
    ['no head at all', { number: 7, updated_at: '2026-11-22T10:00:00Z' }],
    ['a non-object row', 'nope'],
    ['an array row', []],
  ])('counts %s as malformed, never guessed', (_label, row) => {
    expect(classifyOpenPullRequest(row, REPO_ID)).toEqual({ kind: 'malformed' });
  });
});

describe('listOpenPullRequests', () => {
  it('walks state=open oldest first, 100 a page, with the installation token', async () => {
    fetchMock.mockResolvedValueOnce(jsonPage([ghPull(1)]));
    await walk();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.github.com/repos/${OWNER}/${NAME}/pulls?state=open&sort=created&direction=asc&per_page=100&page=1`,
    );
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reads a full first page and a short second page, then stops', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonPage(page(OPEN_PULL_REQUESTS_PER_PAGE)))
      .mockResolvedValueOnce(
        jsonPage([
          ghPull(101),
          ghPull(102, { headRepoId: 999 }),
          ghPull(103, { headRepoId: null }),
          { number: 104 },
        ]),
      );
    const pages = await walk();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/&page=2$/);
    expect(
      pages.map((p) => [p.page, p.scanned, p.reports.length, p.forks, p.malformed, p.truncated]),
    ).toEqual([
      [1, 100, 100, 0, 0, false],
      [2, 4, 1, 2, 1, false],
    ]);
    expect(pages[1]!.reports).toEqual([
      { number: 101, headRef: 'feature-101', updatedAt: '2026-11-21T10:00:00Z' },
    ]);
  });

  it('an empty first page is one page with nothing in it', async () => {
    fetchMock.mockResolvedValueOnce(jsonPage([]));
    expect(await walk()).toEqual([
      { reports: [], forks: 0, malformed: 0, scanned: 0, page: 1, truncated: false },
    ]);
  });

  it('reports the page bound as truncated, never a silent stop', async () => {
    fetchMock.mockImplementation(async () => jsonPage(page(OPEN_PULL_REQUESTS_PER_PAGE)));
    const pages = await walk();
    expect(pages).toHaveLength(MAX_OPEN_PULL_REQUEST_PAGES);
    expect(pages.slice(0, -1).every((p) => !p.truncated)).toBe(true);
    expect(pages.at(-1)!.truncated).toBe(true);
  });

  it('retries a 5xx, then reads the page', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('oops', { status: 502 }))
      .mockResolvedValueOnce(jsonPage([ghPull(1)]));
    const pages = await walk();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages[0]!.reports).toHaveLength(1);
  });

  it('retries a throttled 403 (retry-after), then reads the page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('slow down', { status: 403, headers: { 'retry-after': '2' } }),
      )
      .mockResolvedValueOnce(jsonPage([ghPull(1)]));
    expect((await walk())[0]!.reports).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error, then reads the page', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonPage([]));
    expect(await walk()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 404 raises the typed read error naming the repository and status, with no retry', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const error = await walk().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenPullRequestReadError);
    expect(error).toMatchObject({
      code: 'OPEN_PR_READ_FAILED',
      repoRef: 'moooon/acme',
      status: 404,
    });
    expect((error as Error).message).toBe(
      'Could not read moooon/acme open pull requests (404): not retryable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 5xx on every attempt raises the read error after the retry budget', async () => {
    fetchMock.mockImplementation(
      async () => new Response('down', { status: 503, headers: { 'retry-after': '1' } }),
    );
    const error = await walk().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('a network error on every attempt raises the read error with no status', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await walk().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: null });
    expect((error as Error).message).toBe(
      'Could not read moooon/acme open pull requests: fetch failed',
    );
  });

  it('a thrown non-Error on every attempt reads as unreachable', async () => {
    fetchMock.mockRejectedValue('boom');
    expect(((await walk().catch((e: unknown) => e)) as Error).message).toMatch(/: unreachable$/);
  });

  it('a 200 whose body is not JSON raises the read error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(((await walk().catch((e: unknown) => e)) as Error).message).toMatch(
      /expected a JSON array/,
    );
  });

  it('a 200 whose body is not an array raises the read error', async () => {
    fetchMock.mockResolvedValueOnce(jsonPage({ message: 'odd' }));
    const error = await walk().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200 });
    expect((error as Error).message).toMatch(/expected a JSON array/);
  });
});
