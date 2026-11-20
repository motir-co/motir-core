import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { getGitProvider } from '@/lib/git';
import { MergeChangeRequestError } from '@/lib/git/errors';
import { githubThrottle } from '@/lib/github/restRetry';
import type { MergeChangeRequestInput } from '@/lib/git/types';

// A THROTTLE IS NOT A PERMISSION REFUSAL (Bug MOTIR-11841). GitHub answers a
// rate-limited call with the same 403 a missing permission answers, told apart only by
// `retry-after` (the secondary limit) or `x-ratelimit-remaining: 0` (the primary). The
// merge path read every 403 as `app_permission_missing`, which recorded a host refusal,
// spent the approval and sent a person to GitHub's settings. Each of the four 403 sites
// — the repository read, the pull request read, the merge PUT and the enqueue — is
// driven here with all three answers: the two throttles, and a bare 403 that must stay
// the permission refusal it always was. No database: the host is `fetch`.

const github = getGitProvider('github');
const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const INPUT: MergeChangeRequestInput = {
  installationId: 'inst-1',
  owner: 'acme',
  name: 'web',
  number: 7,
  expectedHeadSha: HEAD,
};
const NOW_S = 1_800_000_000;

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

const pull = (over: Record<string, unknown> = {}): Route => ({
  status: 200,
  body: {
    node_id: 'PR_7',
    merged: false,
    state: 'open',
    head: { sha: HEAD },
    base: { ref: 'main' },
    mergeable_state: 'blocked',
    ...over,
  },
});

/** Answer each route from its own queue, in order; the LAST answer of a queue repeats. */
function stubHost(routes: {
  repo?: Route[];
  pull?: Route[];
  rules?: Route[];
  merge?: Route[];
  graphql?: Route[];
}) {
  const take = (queue: Route[] | undefined, fallback: Route): Route =>
    queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? fallback);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const route = u.endsWith('/graphql')
        ? take(routes.graphql, { status: 500 })
        : method === 'PUT'
          ? take(routes.merge, { status: 500 })
          : /\/rules\/branches\//.test(u)
            ? take(routes.rules, { status: 200, body: [] })
            : /\/pulls\/\d+$/.test(u)
              ? take(routes.pull, pull())
              : take(routes.repo, { status: 200, body: { allow_squash_merge: true } });
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: route.headers ?? {},
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The three answers each site is driven with, and what each must come out as. */
const SECONDARY: Route = {
  status: 403,
  headers: { 'retry-after': '60' },
  body: { message: 'You have exceeded a secondary rate limit.' },
};
const PRIMARY: Route = {
  status: 403,
  headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW_S + 125) },
  body: { message: 'API rate limit exceeded for installation.' },
};
const BARE = (permission?: string): Route => ({
  status: 403,
  headers: permission ? { 'x-accepted-github-permissions': permission } : {},
  body: { message: 'Resource not accessible by integration' },
});

const ANSWERS = [
  { name: 'retry-after (the SECONDARY limit)', route: SECONDARY, retryAfterSeconds: 60 },
  {
    name: 'x-ratelimit-remaining: 0 (the PRIMARY limit)',
    route: PRIMARY,
    retryAfterSeconds: 125,
  },
] as const;

/** The four 403 sites, each as the routes that make THAT call answer `answer`. */
const QUEUE_RULES: Route = { status: 200, body: [{ type: 'merge_queue' }] };
const SITES: Array<{ name: string; routes: (answer: Route) => Parameters<typeof stubHost>[0] }> = [
  { name: 'the repository read', routes: (answer) => ({ repo: [answer] }) },
  { name: 'the pull request read', routes: (answer) => ({ pull: [answer] }) },
  { name: 'the merge PUT', routes: (answer) => ({ merge: [answer] }) },
  {
    name: 'the pull request RE-read after a 405',
    routes: (answer) => ({
      merge: [{ status: 405, body: { message: 'Pull request is not mergeable' } }],
      pull: [pull(), answer],
    }),
  },
  {
    name: 'the enqueue',
    routes: (answer) => ({ rules: [QUEUE_RULES], graphql: [answer] }),
  },
];

function atNow() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_S * 1_000);
}

describe.each(SITES)('$name', (site) => {
  it.each(ANSWERS)(
    'a throttle by $name is the rate_limited NON-ANSWER, carrying the wait — never a refusal',
    async ({ route, retryAfterSeconds }) => {
      atNow();
      stubHost(site.routes(route));
      const err = await github.mergeChangeRequest!(INPUT).then(
        (result) => {
          throw new Error(`expected a throw, got ${JSON.stringify(result)}`);
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MergeChangeRequestError);
      expect(err).toMatchObject({ reason: 'rate_limited', status: 403, retryAfterSeconds });
      expect((err as Error).message).toContain('rate-limited');
    },
  );

  it('a 403 with NEITHER header is still app_permission_missing, naming what GitHub asked for', async () => {
    stubHost(site.routes(BARE('pull_requests=write; contents=write')));
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing', permission: 'pull_requests: write' },
    });
  });
});

describe('a 429 is a throttle wherever it lands', () => {
  it('a bare 429 names no wait', async () => {
    stubHost({ merge: [{ status: 429 }] });
    await expect(github.mergeChangeRequest!(INPUT)).rejects.toMatchObject({
      reason: 'rate_limited',
      status: 429,
      retryAfterSeconds: null,
    });
  });

  it('a 429 carrying retry-after names it', async () => {
    stubHost({ repo: [{ status: 429, headers: { 'retry-after': '90' } }] });
    await expect(github.mergeChangeRequest!(INPUT)).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterSeconds: 90,
    });
  });
});

describe('the GraphQL enqueue answers its PRIMARY limit with 200 and a RATE_LIMITED error', () => {
  it('is a throttle carrying the reset — not the protection refusal an unknown error would be', async () => {
    atNow();
    stubHost({
      rules: [QUEUE_RULES],
      graphql: [
        {
          status: 200,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW_S + 30) },
          body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
        },
      ],
    });
    await expect(github.mergeChangeRequest!(INPUT)).rejects.toMatchObject({
      reason: 'rate_limited',
      status: 200,
      retryAfterSeconds: 30,
    });
  });

  it('with no rate-limit headers it is still a throttle, naming no wait', async () => {
    stubHost({
      rules: [QUEUE_RULES],
      graphql: [{ status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'slow' }] } }],
    });
    await expect(github.mergeChangeRequest!(INPUT)).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterSeconds: null,
    });
  });
});

describe('the MERGEABILITY read the press makes first names a throttle too', () => {
  it('throws rate_limited with the wait, so the log says what happened', async () => {
    stubHost({ pull: [SECONDARY] });
    await expect(github.readChangeRequestMergeability!(INPUT)).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterSeconds: 60,
      message: 'the github merge was rate-limited (403; retry after 60s)',
    });
  });

  it('a bare 403 there is still the unexpected status it always was', async () => {
    stubHost({ pull: [BARE()] });
    await expect(github.readChangeRequestMergeability!(INPUT)).rejects.toMatchObject({
      reason: 'unexpected_status',
      status: 403,
      retryAfterSeconds: null,
    });
  });
});

describe('githubThrottle — which throttle a response is', () => {
  const at = (h: Record<string, string>) => new Headers(h);
  const NOW = NOW_S * 1_000;

  it('names each of the three signals, and the wait each carries', () => {
    expect(githubThrottle(403, at({ 'retry-after': '60' }), NOW)).toEqual({
      signal: 'retry_after',
      waitMs: 60_000,
    });
    expect(
      githubThrottle(
        429,
        at({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW_S + 5) }),
        NOW,
      ),
    ).toEqual({ signal: 'rate_limit_reset', waitMs: 5_000 });
    expect(githubThrottle(429, at({}), NOW)).toEqual({
      signal: 'too_many_requests',
      waitMs: null,
    });
  });

  it('a reset already past is a wait of nothing, never a negative one', () => {
    expect(
      githubThrottle(
        403,
        at({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW_S - 10) }),
        NOW,
      ),
    ).toEqual({ signal: 'rate_limit_reset', waitMs: 0 });
  });

  it('is null for a bare 403, a remaining budget, and every status that is not 403 / 429', () => {
    expect(githubThrottle(403, at({}), NOW)).toBeNull();
    expect(
      githubThrottle(403, at({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1' }), NOW),
    ).toBeNull();
    expect(githubThrottle(403, at({ 'retry-after': 'soon' }), NOW)).toBeNull();
    expect(githubThrottle(500, at({ 'retry-after': '60' }), NOW)).toBeNull();
    expect(githubThrottle(404, at({}), NOW)).toBeNull();
  });
});

describe('MergeChangeRequestError carries a wait only on rate_limited', () => {
  it('a throttle with no named wait reads so, and other reasons never carry one', () => {
    const throttled = new MergeChangeRequestError('github', 'rate_limited', { status: 429 });
    expect(throttled.message).toBe('the github merge was rate-limited (429)');
    expect(throttled.retryAfterSeconds).toBeNull();
    expect(new MergeChangeRequestError('github', 'rate_limited').message).toBe(
      'the github merge was rate-limited (throttled)',
    );
    expect(
      new MergeChangeRequestError('github', 'unexpected_status', {
        status: 500,
        retryAfterSeconds: 60,
      }).retryAfterSeconds,
    ).toBeNull();
  });
});
