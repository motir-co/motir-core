import { afterEach, describe, expect, it, vi } from 'vitest';
import { repoCommitHistoryClient, RepoCommitHistoryError } from '@/lib/github/repoCommitHistory';

// The two commit-history reads behind the runner-image freshness probe
// (MOTIR-10393), over a faked `fetch`: the request each one makes, the token
// (or none), and every answer that is not a usable one, thrown.

const REPO = { owner: 'motir-co', name: 'motir-core' };

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('repoCommitHistoryClient.newestTouching', () => {
  it('asks the default branch for the newest commit to the path, anonymously with no token', async () => {
    const fetch = reply(200, [
      {
        sha: 'a4e83f13c8a344fd306993b997c9c361c29aa3e4',
        commit: {
          committer: { date: '2026-11-03T12:00:00Z' },
          message: 'MOTIR-10293 Add the AWS CLI\n\nbody line',
        },
      },
    ]);
    vi.stubGlobal('fetch', fetch);

    expect(
      await repoCommitHistoryClient.newestTouching(REPO, 'infra/ci-runner/Dockerfile', null),
    ).toEqual({
      sha: 'a4e83f13c8a344fd306993b997c9c361c29aa3e4',
      committedAt: '2026-11-03T12:00:00Z',
      subject: 'MOTIR-10293 Add the AWS CLI',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/repos/motir-co/motir-core/commits?path=infra%2Fci-runner%2FDockerfile&per_page=1',
    );
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('sends the token when it has one, and reads a commit with no message as an empty subject', async () => {
    const fetch = reply(200, [{ sha: 'abc', commit: { committer: { date: 'd' } } }]);
    vi.stubGlobal('fetch', fetch);
    expect(await repoCommitHistoryClient.newestTouching(REPO, 'p', 'ghs_x')).toMatchObject({
      subject: '',
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ghs_x');
  });

  it('is null when no commit ever touched the path', async () => {
    vi.stubGlobal('fetch', reply(200, []));
    expect(await repoCommitHistoryClient.newestTouching(REPO, 'nowhere', null)).toBeNull();
  });

  it('throws on a refusal with its status and message, a non-list, or a commit with no sha', async () => {
    vi.stubGlobal('fetch', reply(403, { message: 'API rate limit exceeded' }));
    const refused = await repoCommitHistoryClient.newestTouching(REPO, 'p', null).catch((e) => e);
    expect(refused).toBeInstanceOf(RepoCommitHistoryError);
    expect(refused).toMatchObject({ status: 403 });
    expect(refused.message).toBe('GitHub refused the read (HTTP 403: API rate limit exceeded).');

    vi.stubGlobal('fetch', reply(200, { not: 'a list' }));
    await expect(repoCommitHistoryClient.newestTouching(REPO, 'p', null)).rejects.toThrow(
      'commit list was not a list',
    );
    vi.stubGlobal('fetch', reply(200, [{ commit: {} }]));
    await expect(repoCommitHistoryClient.newestTouching(REPO, 'p', null)).rejects.toThrow(
      'commit carried no sha or date',
    );
  });

  it('throws a transport failure with no status, and a refusal with an unreadable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const failure = await repoCommitHistoryClient.newestTouching(REPO, 'p', null).catch((e) => e);
    expect(failure).toMatchObject({ status: null });
    expect(failure.message).toBe('GitHub could not be reached (ECONNRESET).');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'not an error';
      }),
    );
    await expect(repoCommitHistoryClient.newestTouching(REPO, 'p', null)).rejects.toThrow(
      'GitHub could not be reached (unknown).',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    await expect(repoCommitHistoryClient.newestTouching(REPO, 'p', null)).rejects.toThrow(
      'GitHub refused the read (HTTP 502).',
    );
  });
});

describe('repoCommitHistoryClient.relation', () => {
  it.each(['ahead', 'behind', 'identical', 'diverged'] as const)(
    'answers GitHub compare status %s',
    async (status) => {
      const fetch = reply(200, { status, ahead_by: 1 });
      vi.stubGlobal('fetch', fetch);
      expect(await repoCommitHistoryClient.relation(REPO, 'base1', 'head2', null)).toBe(status);
      expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
        'https://api.github.com/repos/motir-co/motir-core/compare/base1...head2?per_page=1',
      );
    },
  );

  it('throws on an unknown commit (404) and on an answer with no status', async () => {
    vi.stubGlobal('fetch', reply(404, { message: 'Not Found' }));
    await expect(repoCommitHistoryClient.relation(REPO, 'a', 'b', null)).rejects.toMatchObject({
      status: 404,
    });
    vi.stubGlobal('fetch', reply(200, { status: 'sideways' }));
    await expect(repoCommitHistoryClient.relation(REPO, 'a', 'b', null)).rejects.toThrow(
      'compare returned no status',
    );
  });
});

// The Services page's two reads (MOTIR-11112).

describe('repoCommitHistoryClient.defaultBranchHead', () => {
  it('reads the default branch, then its head commit, with the token', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/branches/trunk')
        ? new Response(JSON.stringify({ name: 'trunk', commit: { sha: 'f00d' } }))
        : new Response(JSON.stringify({ default_branch: 'trunk' })),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await repoCommitHistoryClient.defaultBranchHead(REPO, 'ghs_x')).toEqual({
      branch: 'trunk',
      sha: 'f00d',
    });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/motir-co/motir-core',
      'https://api.github.com/repos/motir-co/motir-core/branches/trunk',
    ]);
    expect((calls[1]![1].headers as Record<string, string>)['authorization']).toBe('Bearer ghs_x');
  });

  it('throws on a repository with no default branch, and a branch with no head', async () => {
    vi.stubGlobal('fetch', reply(200, { default_branch: '' }));
    await expect(repoCommitHistoryClient.defaultBranchHead(REPO, null)).rejects.toThrow(
      'repository named no default branch',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/branches/')
          ? new Response(JSON.stringify({ commit: {} }))
          : new Response(JSON.stringify({ default_branch: 'main' })),
      ),
    );
    await expect(repoCommitHistoryClient.defaultBranchHead(REPO, null)).rejects.toThrow(
      'branch carried no head commit',
    );
  });
});

describe('repoCommitHistoryClient.compare', () => {
  it('answers the relation, the count, and the oldest commit head has (page 1 of one)', async () => {
    const fetch = reply(200, {
      status: 'ahead',
      ahead_by: 7,
      commits: [{ sha: 'old', commit: { committer: { date: '2026-11-12T09:00:00Z' } } }],
    });
    vi.stubGlobal('fetch', fetch);
    expect(await repoCommitHistoryClient.compare(REPO, 'dep', 'head', null)).toEqual({
      relation: 'ahead',
      aheadBy: 7,
      oldestAheadAt: '2026-11-12T09:00:00Z',
    });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.github.com/repos/motir-co/motir-core/compare/dep...head?per_page=1&page=1',
    );
  });

  it('carries no oldest commit when head has none base lacks', async () => {
    vi.stubGlobal('fetch', reply(200, { status: 'identical', ahead_by: 0, commits: [] }));
    expect(await repoCommitHistoryClient.compare(REPO, 'a', 'a', null)).toEqual({
      relation: 'identical',
      aheadBy: 0,
      oldestAheadAt: null,
    });
  });

  it('throws on an answer with no status or count, and on commits with no date', async () => {
    vi.stubGlobal('fetch', reply(200, { status: 'ahead' }));
    await expect(repoCommitHistoryClient.compare(REPO, 'a', 'b', null)).rejects.toThrow(
      'compare returned no status',
    );
    vi.stubGlobal('fetch', reply(200, { status: 'ahead', ahead_by: 2, commits: 'x' }));
    await expect(repoCommitHistoryClient.compare(REPO, 'a', 'b', null)).rejects.toThrow(
      'compare listed no dated commit',
    );
    vi.stubGlobal('fetch', reply(200, { status: 'diverged', ahead_by: 1, commits: [{}] }));
    await expect(repoCommitHistoryClient.compare(REPO, 'a', 'b', null)).rejects.toThrow(
      'compare listed no dated commit',
    );
  });
});
