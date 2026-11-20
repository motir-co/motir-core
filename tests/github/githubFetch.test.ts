import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { githubReadCodeBlame, githubReadCodeLog } from '@/lib/git/providers/githubCodeHistory';
import { githubFetch, githubFetchFor, githubRequestHooks } from '@/lib/github/githubFetch';
import { userOrgsClient } from '@/lib/github/userOrgs';
import { GithubConnector } from '@/lib/import/connectors/githubConnector';
import {
  flushGithubRequestMetricsForTests,
  GITHUB_REQUEST_METRIC,
  resetGithubRequestMetricsForTests,
} from '@/lib/monitoring/githubRequestMetrics';

// MOTIR-11844 — `githubFetch` is the one counted door every GitHub request in
// motir-core goes through: it counts the request under its caller
// (`GithubRequestCount`) and reports a throttled answer as the `github.throttle`
// line, and otherwise hands back exactly what `fetch` did. The two shared
// transports a GitHub module may send through (`fetchWithinDeadline`,
// `fetchWithRetry`) are driven here through their GitHub users, so the counted
// send and the hooks are proven to reach the network path, not only to exist.
// `tests/github/githubFetchGuard.test.ts` holds every other module to the door.

const SECONDARY = { 'retry-after': '60', 'x-github-request-id': 'C0FE:1:2:3' };

let written: string[];
let warn: MockInstance;

function counts(): Record<string, number> {
  flushGithubRequestMetricsForTests();
  return Object.fromEntries(
    written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((line) => [line['Caller'] as string, line[GITHUB_REQUEST_METRIC] as number]),
  );
}

function throttleLines(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map(([first]) => (typeof first === 'string' ? first : ''))
    .filter((line) => line.includes('"github.throttle"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  resetGithubRequestMetricsForTests();
  vi.stubEnv('MONITORING_CLOUDWATCH_NAMESPACE', 'Motir/Core');
  vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', 'web');
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetGithubRequestMetricsForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('githubFetch — count, send, report, return unchanged', () => {
  it('sends with the global fetch and returns its very Response', async () => {
    const answer = new Response('{"ok":true}', { status: 200 });
    const send = vi.fn().mockResolvedValue(answer);
    vi.stubGlobal('fetch', send);
    const init = { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' };

    const res = await githubFetch('rateLimit', 'https://api.github.com/rate_limit', init);

    expect(res).toBe(answer);
    expect(send).toHaveBeenCalledWith('https://api.github.com/rate_limit', init);
    expect(counts()).toEqual({ rateLimit: 1 });
    expect(throttleLines()).toEqual([]);
  });

  it('a bare caller reports a throttle with no installation or repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 403, headers: SECONDARY })),
    );

    const res = await githubFetch('user.orgs', 'https://api.github.com/user/orgs');

    expect(res.status).toBe(403);
    expect(throttleLines()).toEqual([
      {
        event: 'github.throttle',
        caller: 'user.orgs',
        installationId: null,
        repository: null,
        status: 403,
        classification: 'secondary',
        attempt: null,
        headers: SECONDARY,
      },
    ]);
  });

  it('a full call site and an attempt ride onto the line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795139640' },
        }),
      ),
    );
    const site = { caller: 'checkRuns.write', installationId: '42', repository: 'o/r' } as const;

    await githubFetch(site, 'https://api.github.com/repos/o/r/check-runs', undefined, 3);

    expect(throttleLines()).toEqual([
      expect.objectContaining({
        caller: 'checkRuns.write',
        installationId: '42',
        repository: 'o/r',
        status: 429,
        classification: 'primary',
        attempt: 3,
      }),
    ]);
  });

  it('a refusal that is not a throttle is counted and writes no line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await githubFetch('repoVisibility', 'https://api.github.com/repos/o/r');
    await githubFetch('repoVisibility', 'https://api.github.com/repos/o/r');
    expect(counts()).toEqual({ repoVisibility: 2 });
    expect(throttleLines()).toEqual([]);
  });

  it('a network failure is still a request sent, and the same error comes back', async () => {
    const boom = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(boom));
    await expect(githubFetch('fleetQueue', 'https://api.github.com/x')).rejects.toBe(boom);
    expect(counts()).toEqual({ fleetQueue: 1 });
  });
});

describe('githubFetchFor / githubRequestHooks — the two shapes a shared transport takes', () => {
  it('githubFetchFor binds the site: each call is one counted githubFetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 403, headers: SECONDARY })),
    );
    const send = githubFetchFor('codeHistory.log');
    await send('https://api.github.com/a');
    await send('https://api.github.com/b', { method: 'GET' });
    expect(counts()).toEqual({ 'codeHistory.log': 2 });
    expect(throttleLines()).toHaveLength(2);
  });

  it('githubRequestHooks counts before and reports after, with the attempt', () => {
    const hooks = githubRequestHooks({
      caller: 'import.github',
      installationId: null,
      repository: 'o/r',
    });
    hooks.beforeRequest();
    hooks.afterResponse(new Response(null, { status: 200 }), 1);
    hooks.beforeRequest();
    hooks.afterResponse(new Response(null, { status: 403, headers: SECONDARY }), 2);
    expect(counts()).toEqual({ 'import.github': 2 });
    expect(throttleLines()).toEqual([
      expect.objectContaining({ caller: 'import.github', repository: 'o/r', attempt: 2 }),
    ]);
  });
});

describe('the GitHub users of the shared transports count through them', () => {
  it('the code-history log and blame reads (fetchWithinDeadline) count under their callers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/graphql')
          ? new Response(null, { status: 403, headers: SECONDARY })
          : new Response('[]', { status: 200 }),
      ),
    );
    const asked = { ref: 'main', path: 'README.md' };
    await githubReadCodeLog('t', 'motir-co', 'motir-core', { ...asked, kind: 'log' });
    await githubReadCodeBlame('t', 'motir-co', 'motir-core', { ...asked, kind: 'blame' });

    expect(counts()).toEqual({ 'codeHistory.log': 1, 'codeHistory.blame': 1 });
    expect(throttleLines()).toEqual([
      expect.objectContaining({ caller: 'codeHistory.blame', repository: 'motir-co/motir-core' }),
    ]);
  });

  it('the issue-import connector (fetchWithRetry) counts every attempt, retries included', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403, headers: { 'retry-after': '1' } }))
      .mockResolvedValue(new Response(JSON.stringify({ full_name: 'o/r' }), { status: 200 }));
    const connector = new GithubConnector({
      token: 't',
      owner: 'o',
      repo: 'r',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { sleep: async () => {}, random: () => 0 },
    });

    await connector.connect();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual({ 'import.github': 2 });
    expect(throttleLines()).toEqual([
      expect.objectContaining({ caller: 'import.github', repository: 'o/r', attempt: 1 }),
    ]);
  });

  it('a module leaf (the user-orgs read) counts under its own caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    await userOrgsClient.listForToken('gho_t');
    expect(counts()).toEqual({ 'user.orgs': 1 });
  });
});
