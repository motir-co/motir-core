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
import { GithubAppTokenError, mintInstallationToken } from '@/lib/github/appAuth';
import type { MergeChangeRequestInput } from '@/lib/git/types';

// THE MERGE SEAM'S EDGES (Story MOTIR-4882 · MOTIR-5519 — the story gate's coverage
// floor over MOTIR-5514 / MOTIR-5516). `tests/git/mergeChangeRequest.test.ts` pins the
// matrix a person reads about; this file drives every OTHER answer the host can give
// on the merge and enqueue paths, so none of them is an untested guess. No database:
// the host is `fetch`, answered IN ORDER per route, and the App credential is mocked.

const github = getGitProvider('github');
const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const INPUT: MergeChangeRequestInput = {
  installationId: 'inst-1',
  owner: 'acme',
  name: 'web',
  number: 7,
  expectedHeadSha: HEAD,
};
const ALL_METHODS = { allow_squash_merge: true };
const QUEUE_RULES = [{ type: 'merge_queue' }];

type Route = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

const pull = (over: Record<string, unknown> = {}): Route => ({
  status: 200,
  body: {
    node_id: 'PR_7',
    merged: false,
    state: 'open',
    head: { sha: HEAD },
    base: { ref: 'main' },
    ...over,
  },
});

/**
 * Answer each route from its own queue, in order; the LAST answer of a queue repeats.
 * `repo`, `pull`, `rules`, `merge` and `graphql` are the five calls a merge can make.
 */
function stubHost(routes: {
  repo?: Route[];
  pull?: Route[];
  rules?: Route[];
  merge?: Route[];
  graphql?: Route[];
  throws?: unknown;
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const take = (queue: Route[] | undefined, fallback: Route): Route =>
    queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? fallback);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (routes.throws !== undefined) throw routes.throws;
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ method, url: u });
      const route = u.endsWith('/graphql')
        ? take(routes.graphql, { status: 500 })
        : method === 'PUT'
          ? take(routes.merge, { status: 500 })
          : /\/rules\/branches\//.test(u)
            ? take(routes.rules, { status: 200, body: [] })
            : /\/pulls\/\d+$/.test(u)
              ? take(routes.pull, pull())
              : take(routes.repo, { status: 200, body: ALL_METHODS });
      const text = route.raw ?? (route.body === undefined ? null : JSON.stringify(route.body));
      return new Response(text, { status: route.status, headers: route.headers ?? {} });
    }),
  );
  return calls;
}

const merge = () => github.mergeChangeRequest!(INPUT);
const refused = (code: string, extra: Record<string, unknown> = {}) => ({
  outcome: 'refused',
  refusal: { code, ...extra },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the REPOSITORY read', () => {
  it('403 names the permission a merge needs; 404 is a changed subject; any other status throws', async () => {
    stubHost({ repo: [{ status: 403 }] });
    await expect(merge()).resolves.toEqual(
      refused('app_permission_missing', { permission: 'contents: write' }),
    );
    stubHost({ repo: [{ status: 404 }] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
    stubHost({ repo: [{ status: 500 }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('a repository that allows only merge commits is merged with merge_method: merge', async () => {
    stubHost({
      repo: [{ status: 200, body: { allow_merge_commit: true } }],
      merge: [{ status: 200, body: { merged: true, sha: 'm1' } }],
    });
    await expect(merge()).resolves.toEqual({ outcome: 'merged', commitSha: 'm1' });
  });
});

describe('the PULL REQUEST read before merging', () => {
  it('404 → subject_changed; 403 names the permission the host asked for, or none; 500 throws', async () => {
    stubHost({ pull: [{ status: 404 }] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
    stubHost({
      pull: [{ status: 403, headers: { 'x-accepted-github-permissions': 'pull_requests=read' } }],
    });
    await expect(merge()).resolves.toEqual(
      refused('app_permission_missing', { permission: 'pull_requests: read' }),
    );
    stubHost({ pull: [{ status: 403, headers: { 'x-accepted-github-permissions': 'none' } }] });
    await expect(merge()).resolves.toEqual(refused('app_permission_missing'));
    stubHost({ pull: [{ status: 500 }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('a CLOSED pull request, or one whose head moved, is a changed subject — no merge call', async () => {
    const closed = stubHost({ pull: [pull({ state: 'closed' })] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
    expect(closed.some((c) => c.method === 'PUT')).toBe(false);
    stubHost({ pull: [pull({ head: { sha: 'moved' } })] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
  });

  it('a rules read that answers with unreadable JSON is not a queue answer — the merge proceeds', async () => {
    stubHost({
      rules: [{ status: 200, raw: 'not json' }],
      merge: [{ status: 200, body: { merged: true, sha: 'm2' } }],
    });
    await expect(merge()).resolves.toEqual({ outcome: 'merged', commitSha: 'm2' });
  });
});

describe('the MERGE call', () => {
  it('a 200 whose body is not an object is an error, not a merge', async () => {
    stubHost({ merge: [{ status: 200, body: ['merged'] }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
    stubHost({ merge: [{ status: 200, raw: '<html>' }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('a host that cannot be reached is `unreachable`, whatever was thrown', async () => {
    stubHost({ throws: new TypeError('fetch failed') });
    await expect(merge()).rejects.toMatchObject({ reason: 'unreachable' });
    stubHost({ throws: 'socket hang up' });
    await expect(merge()).rejects.toMatchObject({ reason: 'unreachable' });
  });
});

describe('a 405 is classified by RE-READING the pull request', () => {
  const blocked = (message?: string): Route => ({
    status: 405,
    body: message === undefined ? {} : { message },
  });

  it('the re-read answering 404 / 403 / 500', async () => {
    stubHost({ merge: [blocked('no')], pull: [pull(), { status: 404 }] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
    stubHost({ merge: [blocked('no')], pull: [pull(), { status: 403 }] });
    await expect(merge()).resolves.toEqual(
      refused('app_permission_missing', { permission: 'contents: write' }),
    );
    stubHost({ merge: [blocked('no')], pull: [pull(), { status: 500 }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('a pull request that merged, closed or moved in the moment between the two reads', async () => {
    stubHost({ merge: [blocked('no')], pull: [pull(), pull({ merged: true })] });
    await expect(merge()).resolves.toEqual(refused('already_merged'));
    stubHost({ merge: [blocked('no')], pull: [pull(), pull({ state: 'closed' })] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
    stubHost({ merge: [blocked('no')], pull: [pull(), pull({ head: { sha: 'moved' } })] });
    await expect(merge()).resolves.toEqual(refused('subject_changed'));
  });

  it('a 405 with NO message: unstable checks carry no reason, and a protection rule carries none either', async () => {
    stubHost({ merge: [blocked()], pull: [pull(), pull({ mergeable_state: 'unstable' })] });
    await expect(merge()).resolves.toEqual(refused('checks_not_green'));
    stubHost({ merge: [blocked()], pull: [pull(), pull({ mergeable_state: 'blocked' })] });
    await expect(merge()).resolves.toEqual(refused('branch_protected'));
  });

  it('BEHIND a strict base is out of date, though the message names the required checks (MOTIR-10054)', async () => {
    const strict = '2 of 2 required status checks are expected.';
    stubHost({ merge: [blocked(strict)], pull: [pull(), pull({ mergeable_state: 'behind' })] });
    await expect(merge()).resolves.toEqual(refused('out_of_date', { reason: strict }));
    stubHost({ merge: [blocked()], pull: [pull(), pull({ mergeable_state: 'behind' })] });
    await expect(merge()).resolves.toEqual(refused('out_of_date'));
    // The same message over a head that is NOT behind is still a checks refusal.
    stubHost({ merge: [blocked(strict)], pull: [pull(), pull({ mergeable_state: 'blocked' })] });
    await expect(merge()).resolves.toEqual(refused('checks_not_green', { reason: strict }));
  });
});

describe('the ENQUEUE call', () => {
  const queued = (over: Parameters<typeof stubHost>[0]) =>
    stubHost({ rules: [{ status: 200, body: QUEUE_RULES }], ...over });
  const graphqlError = (error: Record<string, unknown>): Route => ({
    status: 200,
    body: { data: { enqueuePullRequest: null }, errors: [error] },
  });

  it('a pull request with no node_id cannot be addressed by the queue — an error', async () => {
    queued({ pull: [pull({ node_id: undefined })] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('GraphQL 403 names the permission; any other failing status throws', async () => {
    queued({
      graphql: [
        { status: 403, headers: { 'x-accepted-github-permissions': 'pull_requests=write' } },
      ],
    });
    await expect(merge()).resolves.toEqual(
      refused('app_permission_missing', { permission: 'pull_requests: write' }),
    );
    queued({ graphql: [{ status: 502 }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('an answer with neither an entry nor an error is an error', async () => {
    queued({ graphql: [{ status: 200, body: { data: { enqueuePullRequest: null } } }] });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });

  it('an unrecognised error is a protection refusal — with the host wording when it gave one', async () => {
    queued({ graphql: [graphqlError({ message: 'Queue is paused' })] });
    await expect(merge()).resolves.toEqual(
      refused('branch_protected', { reason: 'Queue is paused' }),
    );
    queued({ graphql: [graphqlError({ type: 42 })] });
    await expect(merge()).resolves.toEqual(refused('branch_protected'));
  });

  it('a CONFLICTING pull request the queue refuses is a conflict', async () => {
    queued({
      pull: [pull({ mergeable_state: 'dirty' })],
      graphql: [graphqlError({ message: 'Pull request is not mergeable' })],
    });
    await expect(merge()).resolves.toEqual(refused('conflict'));
  });

  it('a pull request BEHIND a strict base the queue refuses is out of date, not red checks (MOTIR-10054)', async () => {
    queued({
      pull: [pull({ mergeable_state: 'behind' })],
      graphql: [graphqlError({ message: 'Required status checks are expected' })],
    });
    await expect(merge()).resolves.toEqual(
      refused('out_of_date', { reason: 'Required status checks are expected' }),
    );
    queued({ pull: [pull({ mergeable_state: 'behind' })], graphql: [graphqlError({})] });
    await expect(merge()).resolves.toEqual(refused('out_of_date'));
  });

  it('"already queued" whose entry cannot be read back is an error, never a guessed entry', async () => {
    queued({
      graphql: [
        graphqlError({ message: 'Pull request is already in the merge queue' }),
        { status: 500 },
      ],
    });
    await expect(merge()).rejects.toBeInstanceOf(MergeChangeRequestError);
  });
});

describe('the INSTALLATION-TOKEN mint every merge-side call starts with (MOTIR-7508)', () => {
  // The seam's contract: what throws out of a merge is only what is not an answer, and
  // it throws as `MergeChangeRequestError` — the one non-answer every caller maps
  // (the press to its UNEXPECTED arm, the auto-merge to its unreachable comment). A
  // token endpoint that answered 503 used to escape as `GithubAppTokenError`, which no
  // caller maps, so an Approve-and-merge press crashed AFTER its approval committed.
  const mintFails = (err: unknown) => vi.mocked(mintInstallationToken).mockRejectedValueOnce(err);

  it('a token endpoint that ANSWERED with a status throws as the merge non-answer, carrying it', async () => {
    const calls = stubHost({});
    mintFails(new GithubAppTokenError('token endpoint returned 503', 503));
    const err = await merge().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeChangeRequestError);
    expect(err).toMatchObject({ reason: 'unexpected_status', status: 503 });
    // Nothing reached the repository without a token.
    expect(calls).toEqual([]);
  });

  it('a token endpoint that never answered is unreachable', async () => {
    stubHost({});
    mintFails(new GithubAppTokenError('token endpoint unreachable (ECONNRESET)'));
    await expect(merge()).rejects.toMatchObject({
      name: 'MergeChangeRequestError',
      reason: 'unreachable',
      status: null,
    });
  });

  it('the mergeability read takes the same translation', async () => {
    stubHost({});
    mintFails(new GithubAppTokenError('token endpoint returned 502', 502));
    await expect(github.readChangeRequestMergeability!(INPUT)).rejects.toBeInstanceOf(
      MergeChangeRequestError,
    );
  });

  it('an error that is not a mint failure passes through unchanged', async () => {
    stubHost({});
    const boom = new Error('not a mint failure');
    mintFails(boom);
    await expect(merge()).rejects.toBe(boom);
  });
});
