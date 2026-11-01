import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitProvider, RepoFileReadError } from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';

// `resolveRef` on the GitProvider seam (MOTIR-10122) — a ref to the commit it
// names NOW, so a read made "at main" is recorded at a commit someone can reopen.
// Every ordinary answer is a named value; only a status no arm names throws.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function stubFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_resolve',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return reply(u, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function hostCalls(mock: ReturnType<typeof stubFetch>): [string, RequestInit | undefined][] {
  return mock.mock.calls
    .map(([u, init]) => [String(u), init] as [string, RequestInit | undefined])
    .filter(([u]) => !u.includes('/access_tokens'));
}

describe('the seam declares resolveRef as REQUIRED', () => {
  it('both shipped providers implement it', () => {
    expect(typeof github.resolveRef).toBe('function');
    expect(typeof gitlab.resolveRef).toBe('function');
  });
});

describe('github.resolveRef', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks the commits endpoint for the SHA media type and returns the id, lower-cased', async () => {
    const fetchMock = stubFetch(() => new Response(`${SHA.toUpperCase()}\n`, { status: 200 }));
    expect(await github.resolveRef('inst-1', 'moooon', 'acme', 'feat/x')).toEqual({
      outcome: 'resolved',
      ref: 'feat/x',
      sha: SHA,
    });
    const [[url, init]] = hostCalls(fetchMock) as [[string, RequestInit]];
    expect(url).toBe('https://api.github.com/repos/moooon/acme/commits/feat%2Fx');
    expect((init.headers as Record<string, string>)['accept']).toBe('application/vnd.github.sha');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([404, 422])('a %s is ref_not_found', async (status) => {
    stubFetch(() => new Response(JSON.stringify({ message: 'No commit found' }), { status }));
    expect(await github.resolveRef('inst-1', 'moooon', 'acme', 'nope')).toEqual({
      outcome: 'ref_not_found',
      ref: 'nope',
    });
  });

  it.each([401, 403])('a %s is unauthorized', async (status) => {
    stubFetch(() => new Response('{}', { status }));
    expect(await github.resolveRef('inst-1', 'moooon', 'acme', 'main')).toEqual({
      outcome: 'unauthorized',
      ref: 'main',
    });
  });

  it('a transport failure is unreachable, naming it', async () => {
    stubFetch(() => {
      throw new Error('ECONNRESET');
    });
    expect(await github.resolveRef('inst-1', 'moooon', 'acme', 'main')).toEqual({
      outcome: 'unreachable',
      ref: 'main',
      failure: 'unreachable',
      detail: 'ECONNRESET',
    });
  });

  it('the deadline is unreachable with failure timeout', async () => {
    stubFetch((_url, init) => {
      Object.defineProperty(init!.signal as AbortSignal, 'aborted', {
        value: true,
        configurable: true,
      });
      throw new Error('This operation was aborted');
    });
    expect(await github.resolveRef('inst-1', 'moooon', 'acme', 'main')).toMatchObject({
      outcome: 'unreachable',
      failure: 'timeout',
    });
  });

  it('THROWS for a status no arm names, and for a body that is not a full sha', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    await expect(github.resolveRef('inst-1', 'moooon', 'acme', 'main')).rejects.toBeInstanceOf(
      RepoFileReadError,
    );
    stubFetch(() => new Response('main', { status: 200 }));
    await expect(github.resolveRef('inst-1', 'moooon', 'acme', 'main')).rejects.toBeInstanceOf(
      RepoFileReadError,
    );
  });
});

describe('gitlab.resolveRef', () => {
  beforeEach(() => {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_resolve',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the commit’s id, with the project path and the ref encoded', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ id: SHA, short_id: SHA.slice(0, 8) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await gitlab.resolveRef('conn-1', 'acme/platform', 'web', 'feat/x')).toEqual({
      outcome: 'resolved',
      ref: 'feat/x',
      sha: SHA,
    });
    expect(hostCalls(fetchMock)[0]![0]).toContain(
      '/api/v4/projects/acme%2Fplatform%2Fweb/repository/commits/feat%2Fx',
    );
  });

  it('gives the SAME named outcomes as GitHub for the same facts', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    expect(await gitlab.resolveRef('conn-1', 'acme', 'web', 'nope')).toEqual({
      outcome: 'ref_not_found',
      ref: 'nope',
    });
    stubFetch(() => new Response('{}', { status: 403 }));
    expect(await gitlab.resolveRef('conn-1', 'acme', 'web', 'main')).toEqual({
      outcome: 'unauthorized',
      ref: 'main',
    });
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await gitlab.resolveRef('conn-1', 'acme', 'web', 'main')).toMatchObject({
      outcome: 'unreachable',
      failure: 'unreachable',
    });
  });

  it('THROWS for a status no arm names, and for a body with no id', async () => {
    stubFetch(() => new Response('boom', { status: 502 }));
    await expect(gitlab.resolveRef('conn-1', 'acme', 'web', 'main')).rejects.toBeInstanceOf(
      RepoFileReadError,
    );
    stubFetch(() => new Response('not json', { status: 200 }));
    await expect(gitlab.resolveRef('conn-1', 'acme', 'web', 'main')).rejects.toBeInstanceOf(
      RepoFileReadError,
    );
  });
});
