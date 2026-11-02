import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_HISTORY_MAX_COMMITS,
  CODE_HISTORY_MAX_RANGES,
  CODE_HISTORY_TIMEOUT_MS,
  getGitProvider,
} from '@/lib/git';
import { maxDuration } from '@/app/api/internal/ai/repo-history/route';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import {
  GitlabConnectionNotFoundError,
  GitlabOAuthNotConfiguredError,
  GitlabTokenRefreshError,
} from '@/lib/gitlab/errors';
import { subjectLine } from '@/lib/git/codeHistory';

// `readCodeHistory` on the GitProvider seam (MOTIR-10237) — the LOG or BLAME of a
// path at a ref, on both hosts.
//
// Both providers are driven against host-shaped payloads — GitHub's REST commits
// list and its GraphQL blame, GitLab's commits list and file blame — carrying the
// fields the implementations must NOT read (a patch, `html_url`, GitLab's blame
// `lines[]` text), so a regression that starts reading content fails on the
// payload rather than on an object that never had it.
//
// Under test: every absence is a NAMED result and none throws; the caps report
// `truncated`; the host deadline is under the route's budget; nothing
// credential-shaped or content-shaped reaches the result.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');

const GH_TOKEN = 'ghs_code_history_secret';
const GL_TOKEN = 'glpat_code_history_secret';
const SHA_A = '0328041d1152db8ae77652d1618a02e57f745f17';
const SHA_B = '6dcb09b5b57875f334f61aebed695e2e4193db5e';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Reply = (url: string, init?: RequestInit) => Response | Promise<Response>;
let reply: Reply = () => new Response('', { status: 500 });
const hostCalls: { url: string; init?: RequestInit }[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/access_tokens')) {
      return json({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    hostCalls.push({ url, init });
    return reply(url, init);
  });
}

/** A GitHub commits-list entry, as the host sends it (trimmed), with fields that must not leak. */
function ghCommit(sha: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    sha,
    html_url: `https://github.com/acme/web/commit/${sha}`,
    commit: {
      author: { name: 'Ada', email: 'ada@example.com', date: '2026-10-01T10:00:00Z' },
      committer: { name: 'GitHub', date: '2026-10-01T11:00:00Z' },
      message,
    },
    author: { login: 'ada' },
    files: [{ filename: 'lib/a.ts', patch: '@@ +const secretHunk = 1;' }],
    ...extra,
  };
}

function ghBlameRange(start: number, end: number, oid: string) {
  return {
    startingLine: start,
    endingLine: end,
    commit: {
      oid,
      authoredDate: '2026-09-01T00:00:00Z',
      committedDate: '2026-09-02T00:00:00Z',
      messageHeadline: 'feat: add the thing',
      author: { name: 'Bo' },
    },
  };
}

function ghBlameBody(ranges: unknown[], typename = 'Commit') {
  const blame = { ranges };
  const object =
    typename === 'Tag' ? { __typename: 'Tag', target: { blame } } : { __typename: typename, blame };
  return { data: { repository: { object } } };
}

beforeEach(() => {
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  hostCalls.length = 0;
  reply = () => json([]);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the seam declares readCodeHistory as REQUIRED', () => {
  it('both shipped providers implement it', () => {
    expect(typeof github.readCodeHistory).toBe('function');
    expect(typeof gitlab.readCodeHistory).toBe('function');
  });

  it('the host deadline is under the history route’s maxDuration', () => {
    expect(CODE_HISTORY_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
  });

  it('the commit cap is the hosts’ own page size', () => {
    expect(CODE_HISTORY_MAX_COMMITS).toBe(100);
  });

  it('a subject is a message’s first line, and nothing for a non-string', () => {
    expect(subjectLine('fix: one\n\nbody')).toBe('fix: one');
    expect(subjectLine('  single  ')).toBe('single');
    expect(subjectLine(42)).toBe('');
  });
});

describe('github.readCodeHistory — log', () => {
  const read = (path = 'lib/a.ts', ref = 'main') =>
    github.readCodeHistory('inst-1', 'acme', 'web', 'log', path, ref);

  it('lists the commits that changed the path, newest first, metadata only', async () => {
    reply = () =>
      json([ghCommit(SHA_A, 'fix: second\n\nlong body'), ghCommit(SHA_B, 'feat: first')]);
    const result = await read();
    expect(result).toEqual({
      outcome: 'ok',
      kind: 'log',
      path: 'lib/a.ts',
      ref: 'main',
      commits: [
        { sha: SHA_A, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'fix: second' },
        { sha: SHA_B, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'feat: first' },
      ],
      truncated: false,
    });
    expect(hostCalls[0]!.url).toBe(
      'https://api.github.com/repos/acme/web/commits?sha=main&path=lib%2Fa.ts&per_page=100',
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(GH_TOKEN);
    expect(serialized).not.toContain('secretHunk');
    expect(serialized).not.toContain('github.com');
  });

  it('falls back to the login and the committer date, and skips an entry with no sha', async () => {
    reply = () =>
      json([
        {
          sha: SHA_A,
          commit: { committer: { date: '2026-01-01T00:00:00Z' }, message: 'x' },
          author: { login: 'cy' },
        },
        { sha: 'not-a-sha', commit: { message: 'dropped' } },
      ]);
    const result = await read();
    expect(result).toMatchObject({
      outcome: 'ok',
      commits: [{ sha: SHA_A, author: 'cy', date: '2026-01-01T00:00:00Z', subject: 'x' }],
    });
  });

  it('a further page is truncated', async () => {
    reply = () =>
      json([ghCommit(SHA_A, 'x')], 200, {
        link: '<https://api.github.com/repos/acme/web/commits?page=2>; rel="next"',
      });
    expect(await read()).toMatchObject({ outcome: 'ok', truncated: true });
  });

  it('a path with no commits at the ref is path_not_found, never an empty ok', async () => {
    reply = () => json([]);
    expect(await read()).toEqual({
      outcome: 'path_not_found',
      kind: 'log',
      path: 'lib/a.ts',
      ref: 'main',
    });
  });

  it('an unknown ref is no_such_ref (404, 422 and an empty repository’s 409)', async () => {
    for (const status of [404, 422, 409]) {
      reply = () => json({ message: 'No commit found for SHA: nope' }, status);
      expect((await read('lib/a.ts', 'nope')).outcome).toBe('no_such_ref');
    }
  });

  it('401 and a non-rate-limit 403 are revoked; a rate-limit 403 is host_error', async () => {
    reply = () => json({ message: 'Bad credentials' }, 401);
    expect((await read()).outcome).toBe('revoked');
    reply = () => json({ message: 'Resource not accessible by integration' }, 403);
    expect((await read()).outcome).toBe('revoked');
    reply = () =>
      json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub commits returned 403',
    });
  });

  it('a walk the host gave up on is too_large; a 5xx and a non-list body are host_error', async () => {
    reply = () => new Response('the request timed out', { status: 502 });
    expect((await read()).outcome).toBe('too_large');
    reply = () => new Response('bad gateway', { status: 502 });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub commits returned 502',
    });
    reply = () => json({ not: 'a list' });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub commits returned no commit list',
    });
  });

  it('a fetch that rejects is host_error with its message; a non-Error is "unknown"', async () => {
    reply = () => {
      throw new Error('socket hang up');
    };
    expect(await read()).toMatchObject({ outcome: 'host_error', detail: 'socket hang up' });
    reply = () => {
      throw 'nope';
    };
    expect(await read()).toMatchObject({ outcome: 'host_error', detail: 'unknown' });
  });

  it('a host that does not answer inside the deadline is host_error', async () => {
    reply = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    vi.useFakeTimers();
    const pending = read();
    await vi.advanceTimersByTimeAsync(CODE_HISTORY_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({
      outcome: 'host_error',
      detail: `no response within ${CODE_HISTORY_TIMEOUT_MS}ms`,
    });
  });

  it('a mint the App is not configured for is not_connected; a removed installation is revoked', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    expect((await read()).outcome).toBe('not_connected');
    expect(hostCalls).toEqual([]);

    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal('fetch', async () => json({ message: 'Not Found' }, 404));
    expect((await read()).outcome).toBe('revoked');
    vi.stubGlobal('fetch', async () => json({ message: 'boom' }, 500));
    expect((await read()).outcome).toBe('host_error');
  });
});

describe('github.readCodeHistory — blame', () => {
  const read = (path = 'lib/a.ts', ref = 'main') =>
    github.readCodeHistory('inst-1', 'acme', 'web', 'blame', path, ref);

  it('answers per line range the commit that last changed it, through GraphQL', async () => {
    reply = () => json(ghBlameBody([ghBlameRange(1, 4, SHA_A), ghBlameRange(5, 9, SHA_B)]));
    const result = await read();
    expect(result).toEqual({
      outcome: 'ok',
      kind: 'blame',
      path: 'lib/a.ts',
      ref: 'main',
      blame: [
        {
          startLine: 1,
          endLine: 4,
          sha: SHA_A,
          author: 'Bo',
          date: '2026-09-01T00:00:00Z',
          subject: 'feat: add the thing',
        },
        {
          startLine: 5,
          endLine: 9,
          sha: SHA_B,
          author: 'Bo',
          date: '2026-09-01T00:00:00Z',
          subject: 'feat: add the thing',
        },
      ],
      truncated: false,
    });
    const call = hostCalls[0]!;
    expect(call.url).toBe('https://api.github.com/graphql');
    expect(call.init?.method).toBe('POST');
    const sent = JSON.parse(String(call.init?.body)) as { variables: Record<string, string> };
    expect(sent.variables).toEqual({
      owner: 'acme',
      name: 'web',
      expression: 'main',
      path: 'lib/a.ts',
    });
    expect(JSON.stringify(result)).not.toContain(GH_TOKEN);
  });

  it('a tag’s target commit is blamed; an incomplete range is dropped; a committed date stands in', async () => {
    const partial = ghBlameRange(2, 3, SHA_B);
    partial.commit.authoredDate = undefined as unknown as string;
    reply = () =>
      json(ghBlameBody([ghBlameRange(1, 1, SHA_A), { startingLine: 'x' }, partial], 'Tag'));
    const result = await read('lib/a.ts', 'v1.0.0');
    expect(result).toMatchObject({
      outcome: 'ok',
      blame: [
        { startLine: 1, endLine: 1, sha: SHA_A },
        { startLine: 2, endLine: 3, sha: SHA_B, date: '2026-09-02T00:00:00Z' },
      ],
    });
  });

  it('more than the cap is cut and truncated', async () => {
    const many = Array.from({ length: CODE_HISTORY_MAX_RANGES + 1 }, (_, i) =>
      ghBlameRange(i + 1, i + 1, SHA_A),
    );
    reply = () => json(ghBlameBody(many));
    const result = await read();
    expect(result).toMatchObject({ outcome: 'ok', truncated: true });
    expect((result as { blame: unknown[] }).blame).toHaveLength(CODE_HISTORY_MAX_RANGES);
  });

  it('a ref that resolves to nothing is no_such_ref; a commit with no such path is path_not_found', async () => {
    reply = () => json({ data: { repository: { object: null } } });
    expect((await read('lib/a.ts', 'nope')).outcome).toBe('no_such_ref');

    reply = () => json({ data: { repository: { object: { __typename: 'Blob' } } } });
    expect((await read()).outcome).toBe('no_such_ref');

    reply = () =>
      json({
        data: { repository: { object: { __typename: 'Commit', blame: null } } },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository', 'object', 'blame'],
            message: "Could not resolve file for path 'lib/x.ts'.",
          },
        ],
      });
    expect((await read('lib/x.ts')).outcome).toBe('path_not_found');

    reply = () => json({ data: { repository: { object: { __typename: 'Commit', blame: null } } } });
    expect((await read('lib/x.ts')).outcome).toBe('path_not_found');

    reply = () =>
      json({ data: null, errors: [{ message: "Could not resolve file for path 'lib/x.ts'." }] });
    expect((await read('lib/x.ts')).outcome).toBe('path_not_found');
  });

  it('a repository the token cannot see is revoked; a body with no repository and no error is host_error', async () => {
    reply = () =>
      json({
        data: { repository: null },
        errors: [
          { type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository' },
        ],
      });
    expect((await read()).outcome).toBe('revoked');
    reply = () =>
      json({ data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: 'no' }] });
    expect((await read()).outcome).toBe('revoked');
    reply = () => json({ data: { repository: null } });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub GraphQL returned no repository',
    });
  });

  it('a timeout is too_large; 401 / 403 are revoked; a rate limit and a 5xx are host_error', async () => {
    reply = () =>
      json({
        data: { repository: { object: { __typename: 'Commit', blame: null } } },
        errors: [{ message: 'Something went wrong: timeout' }],
      });
    expect((await read()).outcome).toBe('too_large');
    reply = () => json({ message: 'Bad credentials' }, 401);
    expect((await read()).outcome).toBe('revoked');
    reply = () => json({ message: 'forbidden' }, 403);
    expect((await read()).outcome).toBe('revoked');
    reply = () => json({ message: 'rate limit' }, 403);
    expect((await read()).outcome).toBe('host_error');
    reply = () => new Response('gateway timeout', { status: 504 });
    expect((await read()).outcome).toBe('too_large');
    reply = () => new Response('bad gateway', { status: 502 });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub GraphQL returned 502',
    });
    reply = () => new Response('not json', { status: 200 });
    expect(await read()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitHub GraphQL returned no body',
    });
    reply = () => {
      throw new Error('ECONNRESET');
    };
    expect(await read()).toMatchObject({ outcome: 'host_error', detail: 'ECONNRESET' });
  });

  it('an empty file is ok with no ranges', async () => {
    reply = () => json(ghBlameBody([]));
    expect(await read()).toMatchObject({
      outcome: 'ok',
      kind: 'blame',
      blame: [],
      truncated: false,
    });
  });
});

describe('gitlab.readCodeHistory', () => {
  function stubToken(): void {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: GL_TOKEN,
    } as Awaited<ReturnType<typeof gitlabConnectionService.getAccessToken>>);
  }
  const log = (path = 'lib/a.ts', ref = 'main') =>
    gitlab.readCodeHistory('conn-1', 'acme', 'web', 'log', path, ref);
  const blame = (path = 'lib/a.ts', ref = 'main') =>
    gitlab.readCodeHistory('conn-1', 'acme', 'web', 'blame', path, ref);

  const glCommit = (id: string, title: string) => ({
    id,
    title,
    message: `${title}\n\nbody`,
    author_name: 'Ada',
    authored_date: '2026-10-01T10:00:00Z',
    committed_date: '2026-10-01T11:00:00Z',
    web_url: `https://gitlab.com/acme/web/-/commit/${id}`,
  });

  it('log: the commits list, with ref_name and path, and a further page truncated', async () => {
    stubToken();
    reply = () =>
      json([glCommit(SHA_A, 'fix: second'), glCommit(SHA_B, 'feat: first')], 200, {
        'x-next-page': '2',
      });
    const result = await log();
    expect(result).toEqual({
      outcome: 'ok',
      kind: 'log',
      path: 'lib/a.ts',
      ref: 'main',
      commits: [
        { sha: SHA_A, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'fix: second' },
        { sha: SHA_B, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'feat: first' },
      ],
      truncated: true,
    });
    expect(hostCalls[0]!.url).toMatch(
      /\/api\/v4\/projects\/acme%2Fweb\/repository\/commits\?ref_name=main&path=lib%2Fa\.ts&per_page=100$/,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(GL_TOKEN);
    expect(serialized).not.toContain('gitlab.com');
  });

  it('log: an empty list is path_not_found; a non-list body is host_error; a bad entry is skipped', async () => {
    stubToken();
    reply = () => json([]);
    expect((await log()).outcome).toBe('path_not_found');
    reply = () => json({});
    expect(await log()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitLab commits returned no commit list',
    });
    reply = () => json([{ id: 'zz' }, { id: SHA_A, message: 'only message' }]);
    expect(await log()).toMatchObject({
      outcome: 'ok',
      truncated: false,
      commits: [{ sha: SHA_A, author: null, date: null, subject: 'only message' }],
    });
  });

  it('a 404 names what is missing: the project (revoked), the file, or the ref', async () => {
    stubToken();
    reply = () => json({ message: '404 Project Not Found' }, 404);
    expect((await log()).outcome).toBe('revoked');
    reply = () => json({ message: '404 File Not Found' }, 404);
    expect((await blame()).outcome).toBe('path_not_found');
    reply = () => json({ message: '404 Commit Not Found' }, 404);
    expect((await blame()).outcome).toBe('no_such_ref');
  });

  it('401 / 403 are revoked; a too-large refusal is too_large; a 5xx is host_error', async () => {
    stubToken();
    reply = () => json({ message: '401 Unauthorized' }, 401);
    expect((await log()).outcome).toBe('revoked');
    reply = () => json({ message: '403 Forbidden' }, 403);
    expect((await blame()).outcome).toBe('revoked');
    reply = () => json({ message: 'blame is too large' }, 422);
    expect((await blame()).outcome).toBe('too_large');
    reply = () => new Response('bad gateway', { status: 502 });
    expect(await blame()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitLab blame returned 502',
    });
    reply = () => {
      throw new Error('ENOTFOUND');
    };
    expect(await log()).toMatchObject({ outcome: 'host_error', detail: 'ENOTFOUND' });
  });

  it('blame: numbers the groups’ lines into ranges, reading only their COUNT', async () => {
    stubToken();
    reply = () =>
      json([
        { commit: glCommit(SHA_A, 'feat: top'), lines: ['const secretLine = 1;', 'two'] },
        { commit: glCommit(SHA_B, 'fix: middle'), lines: [] },
        { commit: glCommit(SHA_B, ''), lines: ['three', 'four', 'five'] },
        { commit: { id: 'bad' }, lines: ['six'] },
        { commit: glCommit(SHA_A, 'feat: top'), lines: ['seven'] },
      ]);
    const result = await blame();
    expect(result).toEqual({
      outcome: 'ok',
      kind: 'blame',
      path: 'lib/a.ts',
      ref: 'main',
      blame: [
        {
          startLine: 1,
          endLine: 2,
          sha: SHA_A,
          author: 'Ada',
          date: '2026-10-01T10:00:00Z',
          subject: 'feat: top',
        },
        {
          startLine: 3,
          endLine: 5,
          sha: SHA_B,
          author: 'Ada',
          date: '2026-10-01T10:00:00Z',
          subject: null,
        },
        {
          startLine: 7,
          endLine: 7,
          sha: SHA_A,
          author: 'Ada',
          date: '2026-10-01T10:00:00Z',
          subject: 'feat: top',
        },
      ],
      truncated: false,
    });
    expect(hostCalls[0]!.url).toMatch(/\/repository\/files\/lib%2Fa\.ts\/blame\?ref=main$/);
    expect(JSON.stringify(result)).not.toContain('secretLine');
  });

  it('blame: past the cap is truncated; a non-list body is host_error', async () => {
    stubToken();
    const many = Array.from({ length: CODE_HISTORY_MAX_RANGES + 1 }, () => ({
      commit: glCommit(SHA_A, 'x'),
      lines: ['l'],
    }));
    reply = () => json(many);
    expect(await blame()).toMatchObject({ outcome: 'ok', truncated: true });
    reply = () => json({ nope: true });
    expect(await blame()).toMatchObject({
      outcome: 'host_error',
      detail: 'GitLab blame returned no blame list',
    });
  });

  it('maps the token read’s failures to not_connected / revoked / host_error, without a host call', async () => {
    const spy = vi.spyOn(gitlabConnectionService, 'getAccessToken');
    spy.mockRejectedValueOnce(new GitlabOAuthNotConfiguredError());
    expect((await log()).outcome).toBe('not_connected');
    spy.mockRejectedValueOnce(new GitlabConnectionNotFoundError());
    expect((await blame()).outcome).toBe('not_connected');
    spy.mockRejectedValueOnce(new GitlabTokenRefreshError('invalid_grant'));
    expect((await log()).outcome).toBe('revoked');
    spy.mockRejectedValueOnce(new Error('db down'));
    expect(await log()).toMatchObject({ outcome: 'host_error', detail: 'db down' });
    spy.mockRejectedValueOnce('weird');
    expect(await log()).toMatchObject({
      outcome: 'host_error',
      detail: 'the connection token could not be read',
    });
    expect(hostCalls).toEqual([]);
  });
});
