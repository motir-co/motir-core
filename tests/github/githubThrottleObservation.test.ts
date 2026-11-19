import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_secret_installation_token',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { getGitProvider } from '@/lib/git';
import { listMergedPullRequests } from '@/lib/github/historicalPullRequests';
import { readPullRequestBaseRef } from '@/lib/github/pullRequestBase';
import { listPullRequestFiles } from '@/lib/github/pullRequestFiles';
import { readPullRequest } from '@/lib/github/pullRequestRead';
import {
  classifyGithubThrottle,
  GITHUB_CALLERS,
  observeGithubThrottle,
  retryDelayMs,
  type GithubCallSite,
} from '@/lib/github/restRetry';

// MOTIR-11842 — a GitHub throttle leaves a record of WHICH limit it was and WHO
// tripped it. On 2026-11-19 the motir-co installation was secondary-limited for
// ~40 minutes and the only lines Motir kept were `… (403): still throttled after
// the retry budget` and `the github merge answered 403`: the retry loop read
// `retry-after` / `x-ratelimit-*` to pick its wait and threw them away, and the
// merge path read none of them.
//
// Each throttle SHAPE GitHub sends is driven here — `retry-after`; `remaining: 0`
// with a reset; a bare 429 — through the classifier, through every read leaf and
// through the merge seam, and the ONE structured line each writes is parsed back
// and its fields asserted. No database: the host is `fetch`, stubbed.

const SITE: GithubCallSite = {
  caller: 'pullRequestReconcile',
  installationId: '144235820',
  repository: 'motir-co/motir-gateway',
};

const TOKEN = 'ghs_secret_installation_token';

/** The three throttle shapes, as GitHub sends them, and the limit each is. */
const SHAPES: Array<{
  name: string;
  status: number;
  headers: Record<string, string>;
  classification: 'primary' | 'secondary';
}> = [
  {
    name: 'a secondary limit — 403 with retry-after',
    status: 403,
    headers: {
      'retry-after': '60',
      'x-ratelimit-resource': 'core',
      'x-ratelimit-limit': '15000',
      'x-ratelimit-used': '115',
      'x-ratelimit-remaining': '14885',
      'x-ratelimit-reset': '1795139640',
    },
    classification: 'secondary',
  },
  {
    name: 'the primary budget spent — 403 with remaining 0 and a reset',
    status: 403,
    headers: {
      'x-ratelimit-resource': 'core',
      'x-ratelimit-limit': '15000',
      'x-ratelimit-used': '15000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1795139640',
    },
    classification: 'primary',
  },
  {
    name: 'the primary budget spent — 429 with remaining 0 and a reset',
    status: 429,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795139640' },
    classification: 'primary',
  },
  {
    name: 'a bare 429 — no header at all',
    status: 429,
    headers: {},
    classification: 'secondary',
  },
];

let warn: MockInstance;

/** Every `github.throttle` line written so far, parsed. */
function throttleLines(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map(([first]) => (typeof first === 'string' ? first : ''))
    .filter((line) => line.includes('"github.throttle"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyGithubThrottle — which limit a 403/429 hit', () => {
  it.each(SHAPES)('$name → $classification', ({ status, headers, classification }) => {
    expect(classifyGithubThrottle(status, new Headers(headers))).toBe(classification);
  });

  it('a 403 that carries no throttling signal is an ACCESS failure, not a throttle', () => {
    expect(classifyGithubThrottle(403, new Headers())).toBeNull();
    // `remaining: 0` with no usable reset is not a primary-limit answer either —
    // exactly as the retry loop reads it.
    expect(classifyGithubThrottle(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBeNull();
  });

  it.each([200, 401, 404, 405, 422, 500, 502])('a %i is never a throttle', (status) => {
    expect(classifyGithubThrottle(status, new Headers({ 'retry-after': '60' }))).toBeNull();
  });

  it('agrees with retryDelayMs on every 403/429 shape: a throttle is exactly what it retries', () => {
    const headerSets: Array<Record<string, string>> = [
      {},
      { 'retry-after': '60' },
      { 'retry-after': '0' },
      { 'retry-after': 'soon' },
      { 'x-ratelimit-remaining': '0' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795139640' },
      { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1795139640' },
      { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795139640' },
    ];
    for (const status of [403, 429]) {
      for (const set of headerSets) {
        const headers = new Headers(set);
        const throttled = classifyGithubThrottle(status, headers) !== null;
        expect(
          retryDelayMs(status, headers, 1, 0) !== null,
          `${status} ${JSON.stringify(set)}`,
        ).toBe(throttled);
      }
    }
  });

  it('keeps the retry waits exactly as before: retry-after, then the reset, then the backoff', () => {
    expect(retryDelayMs(403, new Headers({ 'retry-after': '60' }), 1, 0)).toBe(60_000);
    expect(
      retryDelayMs(
        429,
        new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }),
        1,
        40_000,
      ),
    ).toBe(60_000);
    // A reset already past still waits the backoff floor.
    expect(
      retryDelayMs(
        403,
        new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }),
        3,
        999_999_999,
      ),
    ).toBe(4_000);
    expect(retryDelayMs(429, new Headers(), 2, 0)).toBe(2_000);
    expect(retryDelayMs(503, new Headers(), 1, 0)).toBe(1_000);
    expect(retryDelayMs(403, new Headers(), 1, 0)).toBeNull();
    expect(retryDelayMs(404, new Headers(), 1, 0)).toBeNull();
  });
});

describe('observeGithubThrottle — ONE structured line per throttled answer', () => {
  it.each(SHAPES)(
    '$name: names the caller, installation, repository, status, limit and headers',
    (shape) => {
      const written = observeGithubThrottle(SITE, shape.status, new Headers(shape.headers), 2);

      const lines = throttleLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual(written);
      expect(lines[0]).toEqual({
        event: 'github.throttle',
        caller: 'pullRequestReconcile',
        installationId: '144235820',
        repository: 'motir-co/motir-gateway',
        status: shape.status,
        classification: shape.classification,
        attempt: 2,
        // ONLY the headers the answer carried — nothing invented for the absent ones.
        headers: shape.headers,
      });
    },
  );

  it('writes the line as one JSON object, so CloudWatch Logs Insights reads its fields', () => {
    observeGithubThrottle(SITE, 403, new Headers({ 'retry-after': '60' }));
    expect(warn).toHaveBeenCalledTimes(1);
    const [line, ...rest] = warn.mock.calls[0]!;
    expect(rest).toEqual([]);
    expect(typeof line).toBe('string');
    expect(String(line)).not.toContain('\n');
    expect(JSON.parse(String(line))).toMatchObject({ event: 'github.throttle', attempt: null });
  });

  it('carries x-github-request-id — what GitHub Support asks for about one answer', () => {
    const written = observeGithubThrottle(
      SITE,
      403,
      new Headers({ 'retry-after': '60', 'x-github-request-id': 'C0DE:1234:ABCD' }),
    );
    expect(written?.headers['x-github-request-id']).toBe('C0DE:1234:ABCD');
  });

  it('copies no credential: headers outside the allowlist never reach the line', () => {
    observeGithubThrottle(
      SITE,
      403,
      new Headers({
        'retry-after': '60',
        authorization: `Bearer ${TOKEN}`,
        'set-cookie': 'session=abc',
        'x-accepted-github-permissions': 'contents=write',
      }),
    );
    const raw = String(warn.mock.calls[0]![0]);
    expect(raw).not.toContain(TOKEN);
    expect(raw.toLowerCase()).not.toContain('authorization');
    expect(raw).not.toContain('session=abc');
    expect(Object.keys(throttleLines()[0]!['headers'] as object)).toEqual(['retry-after']);
  });

  it('writes nothing for an answer that is not a throttle', () => {
    expect(observeGithubThrottle(SITE, 403, new Headers())).toBeNull();
    expect(observeGithubThrottle(SITE, 500, new Headers({ 'retry-after': '5' }))).toBeNull();
    expect(observeGithubThrottle(SITE, 404, new Headers())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('names a closed set of callers — one CloudWatch dimension value each', () => {
    expect(new Set(GITHUB_CALLERS).size).toBe(GITHUB_CALLERS.length);
    for (const caller of GITHUB_CALLERS) expect(caller).toMatch(/^[a-zA-Z.]+$/);
  });
});

// ── THE READ LEAVES ───────────────────────────────────────────────────────────

/** Answer every call with `shape`, then a page/object that ends the read. */
function stubThrottledThenOk(
  shape: (typeof SHAPES)[number],
  okBody: unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: shape.status, headers: shape.headers }))
    .mockResolvedValue(new Response(JSON.stringify(okBody), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Drive a read to completion with fake timers, as the leaf suites do. */
async function run<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.finally(() => {
    settled = true;
  });
  tracked.catch(() => {});
  for (let i = 0; i < 100 && !settled; i += 1) await vi.advanceTimersByTimeAsync(60_000);
  return tracked;
}

const CONTEXT = { installationId: '144235820' } as const;

const LEAVES: Array<{
  caller: (typeof GITHUB_CALLERS)[number];
  okBody: unknown;
  read: () => Promise<unknown>;
}> = [
  {
    caller: 'pullRequestReconcile',
    okBody: { number: 7, state: 'open' },
    read: () =>
      readPullRequest(TOKEN, 'motir-co', 'motir-gateway', 7, {
        ...CONTEXT,
        caller: 'pullRequestReconcile',
      }),
  },
  {
    caller: 'pullRequestBaseRefBackfill',
    okBody: { base: { ref: 'main' } },
    read: () =>
      readPullRequestBaseRef(TOKEN, 'motir-co', 'motir-gateway', 7, {
        ...CONTEXT,
        caller: 'pullRequestBaseRefBackfill',
      }),
  },
  {
    caller: 'webhook.changedPaths',
    okBody: [],
    read: () =>
      listPullRequestFiles(TOKEN, 'motir-co', 'motir-gateway', 7, {
        ...CONTEXT,
        caller: 'webhook.changedPaths',
      }),
  },
  {
    caller: 'historicalPullRequestBackfill',
    okBody: [],
    read: async () => {
      const pages = [];
      for await (const page of listMergedPullRequests(TOKEN, 'motir-co', 'motir-gateway', '9', {
        ...CONTEXT,
        caller: 'historicalPullRequestBackfill',
      }))
        pages.push(page);
      return pages;
    },
  },
];

describe('every read leaf reports its throttled answers, once each', () => {
  for (const leaf of LEAVES) {
    it.each(SHAPES)(`${leaf.caller}: $name`, async (shape) => {
      vi.useFakeTimers();
      const fetchMock = stubThrottledThenOk(shape, leaf.okBody);

      await run(leaf.read());

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const lines = throttleLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        caller: leaf.caller,
        installationId: '144235820',
        repository: 'motir-co/motir-gateway',
        status: shape.status,
        classification: shape.classification,
        attempt: 1,
        headers: shape.headers,
      });
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
    });
  }

  it('a read that stays throttled writes one line per throttled try, each numbered', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403, headers: { 'retry-after': '1' } })),
    );
    const err = await run(
      readPullRequestBaseRef(TOKEN, 'motir-co', 'motir-gateway', 7, {
        ...CONTEXT,
        caller: 'pullRequestBaseRefBackfill',
      }).catch((e: unknown) => e),
    );
    expect(String(err)).toContain('still throttled after the retry budget');
    expect(throttleLines().map((line) => line['attempt'])).toEqual([1, 2, 3, 4, 5]);
  });

  it('an access 403 (no throttling signal) writes no throttle line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await readPullRequest(TOKEN, 'motir-co', 'motir-gateway', 7, {
      ...CONTEXT,
      caller: 'pullRequestReconcile',
    }).catch(() => null);
    expect(throttleLines()).toEqual([]);
  });
});

// ── THE MERGE / ENQUEUE PATH ─────────────────────────────────────────────────

const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const MERGE_INPUT = {
  installationId: '144235820',
  owner: 'motir-co',
  name: 'motir-gateway',
  number: 179,
  expectedHeadSha: HEAD,
};

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

/** Route the merge's calls: repo read, pull read, rules read, merge PUT, GraphQL. */
function stubMergeHost(routes: {
  repo?: Route;
  pull?: Route;
  rules?: Route;
  merge?: Route;
  graphql?: Route;
  compare?: Route;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const route = u.endsWith('/graphql')
        ? routes.graphql
        : init?.method === 'PUT'
          ? routes.merge
          : /\/rules\/branches\//.test(u)
            ? routes.rules
            : /\/compare\//.test(u)
              ? routes.compare
              : /\/pulls\/\d+$/.test(u)
                ? routes.pull
                : routes.repo;
      if (!route) throw new Error(`unrouted ${u}`);
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
      });
    }),
  );
}

const OK_REPO: Route = { status: 200, body: { allow_squash_merge: true } };
const OPEN_PULL: Route = {
  status: 200,
  body: {
    node_id: 'PR_1',
    merged: false,
    state: 'open',
    head: { sha: HEAD },
    base: { ref: 'main' },
  },
};

describe('the merge seam reports a throttled answer before it maps the 403', () => {
  const github = getGitProvider('github');

  it.each(SHAPES)('the merge PUT answering $name', async (shape) => {
    stubMergeHost({
      repo: OK_REPO,
      pull: OPEN_PULL,
      rules: { status: 200, body: [] },
      merge: { status: shape.status, headers: shape.headers, body: { message: 'slow down' } },
    });

    await github.mergeChangeRequest!(MERGE_INPUT).catch(() => null);

    const lines = throttleLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: 'github.throttle',
      caller: 'mergeChangeRequest',
      installationId: '144235820',
      repository: 'motir-co/motir-gateway',
      status: shape.status,
      classification: shape.classification,
      attempt: null,
      headers: shape.headers,
    });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('the repository read answering a secondary limit names mergeChangeRequest', async () => {
    stubMergeHost({ repo: { status: 403, headers: { 'retry-after': '60' } } });
    await github.mergeChangeRequest!(MERGE_INPUT);
    expect(throttleLines()).toMatchObject([{ caller: 'mergeChangeRequest', status: 403 }]);
  });

  it('the enqueue answering a secondary limit names mergeQueueEnqueue', async () => {
    stubMergeHost({
      repo: OK_REPO,
      pull: OPEN_PULL,
      rules: { status: 200, body: [{ type: 'merge_queue' }] },
      graphql: { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-resource': 'graphql' } },
    });
    await github.mergeChangeRequest!(MERGE_INPUT);
    expect(throttleLines()).toEqual([
      expect.objectContaining({
        caller: 'mergeQueueEnqueue',
        classification: 'secondary',
        headers: { 'retry-after': '60', 'x-ratelimit-resource': 'graphql' },
      }),
    ]);
  });

  it('readChangeRequestMergeability names itself', async () => {
    stubMergeHost({ pull: { status: 429, headers: {} } });
    await github.readChangeRequestMergeability!(MERGE_INPUT).catch(() => null);
    expect(throttleLines()).toMatchObject([
      { caller: 'readChangeRequestMergeability', classification: 'secondary', status: 429 },
    ]);
  });

  it('readReleaseContainsMerge names itself', async () => {
    stubMergeHost({
      pull: { status: 200, body: { merged: true, merge_commit_sha: 'abc123' } },
      compare: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795139640' },
      },
    });
    expect(await github.readReleaseContainsMerge!({ ...MERGE_INPUT, release: 'v1' })).toBe(
      'unknown',
    );
    expect(throttleLines()).toMatchObject([
      { caller: 'readReleaseContainsMerge', classification: 'primary' },
    ]);
  });

  it('a permission 403 with no throttling signal writes no throttle line', async () => {
    stubMergeHost({
      repo: { status: 403, headers: { 'x-accepted-github-permissions': 'contents=write' } },
    });
    await expect(github.mergeChangeRequest!(MERGE_INPUT)).resolves.toMatchObject({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing' },
    });
    expect(throttleLines()).toEqual([]);
  });
});
