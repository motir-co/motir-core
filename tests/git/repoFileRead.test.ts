import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGitProvider,
  normalizeRepoFilePath,
  MAX_REPO_PATH_LENGTH,
  REPO_FILE_FETCH_MAX_BYTES,
  REPO_FILE_MAX_BYTES,
  REPO_FILE_READ_TIMEOUT_MS,
  RepoFileReadError,
} from '@/lib/git';
import { maxDuration } from '@/app/api/internal/ai/repo-file/route';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';

// `readFileAtRef` on the GitProvider seam (Story MOTIR-4585 · MOTIR-4586).
//
// The properties under test are the ones the story is actually about, and none
// of them is "it returns the file":
//
//   1. BOTH shipped providers back it. The interface makes that a compile
//      error to get wrong; this asserts it at runtime too, because a stub that
//      throws would also compile and is exactly the disguise MOTIR-2124 removed.
//   2. Every ordinary answer is a DISTINCT value, and none throws. A model that
//      cannot tell "no such path" from "no such ref" will conclude the wrong
//      one, so `not_found !== ref_not_found` is asserted directly rather than
//      left to be read off the code.
//   3. A traversal is refused BEFORE any request is issued. The assertion is on
//      the FETCH MOCK's call count: a 404 from the host would look identical
//      from the outside, and would mean the guarantee is the host's, not ours.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_read',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Every non-token fetch answers `reply`; returns the mock so a test can count
 *  the calls that actually reached a host. */
function stubFetch(reply: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) return tokenResponse();
    void init;
    return reply(u);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The calls that were NOT the token mint — i.e. the ones that reached a host
 *  about the file. This is what the path guard's assertion counts. */
function hostCalls(mock: ReturnType<typeof stubFetch>): string[] {
  return mock.mock.calls.map(([u]) => String(u)).filter((u) => !u.includes('/access_tokens'));
}

/** A 200 with NO declared length whose body is one byte over the fetch limit.
 *  The buffer is zero-filled and never copied, so the test allocates lazily. */
function undeclaredOverFetchLimit(): Response {
  return Object.assign(new Response(null, { status: 200 }), {
    arrayBuffer: async () => new ArrayBuffer(REPO_FILE_FETCH_MAX_BYTES + 1),
  });
}

describe('normalizeRepoFilePath — the guard that runs before any host call', () => {
  it('accepts an ordinary path and canonicalizes it', () => {
    expect(normalizeRepoFilePath('lib/git/provider.ts')).toEqual({
      ok: true,
      path: 'lib/git/provider.ts',
    });
    expect(normalizeRepoFilePath('./lib//git/provider.ts')).toEqual({
      ok: true,
      path: 'lib/git/provider.ts',
    });
    expect(normalizeRepoFilePath('  README.md  ')).toEqual({ ok: true, path: 'README.md' });
  });

  it('refuses traversal, absolute, drive and URL paths', () => {
    for (const bad of [
      '../secrets.env',
      'lib/../../etc/passwd',
      'a/b/../../../c',
      '/etc/passwd',
      '\\\\server\\share\\x',
      'C:/Windows/win.ini',
      'https://example.com/x',
      'file://x',
      '',
      '   ',
      'a\u0000b',
      'a\nb',
      'x'.repeat(MAX_REPO_PATH_LENGTH + 1),
    ]) {
      expect(normalizeRepoFilePath(bad).ok, `expected "${bad}" to be refused`).toBe(false);
    }
  });

  // ⚠️ THE CASE A SUBSTRING GUARD GETS WRONG. `src/..foo/bar.ts` is a legal
  // path whose directory happens to start with two dots, and a
  // `path.includes('..')` check refuses it — silently telling a session that a
  // real file does not exist. The guard is per-SEGMENT for exactly this.
  it('accepts a path whose segment merely BEGINS with dots', () => {
    expect(normalizeRepoFilePath('src/..foo/bar.ts')).toEqual({
      ok: true,
      path: 'src/..foo/bar.ts',
    });
    expect(normalizeRepoFilePath('.github/workflows/ci.yml')).toEqual({
      ok: true,
      path: '.github/workflows/ci.yml',
    });
  });
});

describe('the seam declares readFileAtRef as REQUIRED', () => {
  it('both shipped providers implement it', () => {
    expect(typeof github.readFileAtRef).toBe('function');
    expect(typeof gitlab.readFileAtRef).toBe('function');
  });

  // The tarball capability is the DELIBERATE contrast: optional, and GitLab
  // genuinely cannot back it. Asserting both in one place is what keeps a later
  // reader from "fixing" the asymmetry in either direction.
  it('and that is the OPPOSITE of resolveRepoTarballUrl, on purpose', () => {
    expect(typeof github.resolveRepoTarballUrl).toBe('function');
    expect(gitlab.resolveRepoTarballUrl).toBeUndefined();
  });

  it('the host deadline is under the reading route’s maxDuration', () => {
    expect(REPO_FILE_READ_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
  });
});

describe('github.readFileAtRef', () => {
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

  it('returns the file text, asks for the RAW media type, and bounds the request', async () => {
    const fetchMock = stubFetch(() => new Response('export const x = 1;\n', { status: 200 }));

    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main');
    expect(result).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: 'main',
      text: 'export const x = 1;\n',
      bytes: 20,
    });

    const [url, init] = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/contents/'),
    ) as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/moooon/acme/contents/lib/x.ts?ref=main');
    // The raw type is not a preference: the JSON envelope carries a
    // `download_url` that is token-bearing on a private repo, and never asking
    // for it is why no such URL can leak from this path.
    expect(init.headers).toMatchObject({
      accept: 'application/vnd.github.raw',
      authorization: 'Bearer ghs_read',
    });
    expect(init.signal).toBeDefined();
  });

  it('mints a HOSTED repository’s token through the PROVISIONING App — by provenance, as the merge does (MOTIR-5681)', async () => {
    // Only the provisioning App is configured: a read that minted through the user-facing
    // App would throw `GithubAppNotConfiguredError` before any request, which is exactly how
    // a decision document on a hosted repository used to be unreadable.
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '1001');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-hosted');
    stubFetch(() => new Response('# ADR\n', { status: 200 }));

    const result = await github.readFileAtRef(
      'inst-hosted',
      'motir-hosted',
      'pages',
      'docs/decisions/page-body.md',
      'main',
    );
    expect(result).toMatchObject({ outcome: 'found', text: '# ADR\n' });
  });

  it('encodes each path segment without encoding the separators', async () => {
    const fetchMock = stubFetch(() => new Response('x', { status: 200 }));
    await github.readFileAtRef('inst-1', 'moooon', 'acme', 'a b/c+d.ts', 'feat/x y');
    const url = hostCalls(fetchMock)[0] as string;
    expect(url).toContain('/contents/a%20b/c%2Bd.ts');
    expect(url).toContain('?ref=feat%2Fx%20y');
  });

  it('distinguishes a missing PATH from a missing REF — both are 404 upstream', async () => {
    stubFetch(() => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const missingPath = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'nope.ts', 'main');
    expect(missingPath).toEqual({ outcome: 'not_found', path: 'nope.ts', ref: 'main' });

    _resetInstallationTokenCache();
    stubFetch(
      () =>
        new Response(JSON.stringify({ message: 'No commit found for the ref no-such-branch' }), {
          status: 404,
        }),
    );
    const missingRef = await github.readFileAtRef(
      'inst-1',
      'moooon',
      'acme',
      'lib/x.ts',
      'no-such-branch',
    );
    expect(missingRef).toEqual({
      outcome: 'ref_not_found',
      path: 'lib/x.ts',
      ref: 'no-such-branch',
    });
    // The assertion the whole discipline is for: they are DIFFERENT facts.
    expect(missingRef.outcome).not.toBe(missingPath.outcome);
  });

  it('names a blob over what the raw read serves, and does NOT report it as a credential failure', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ errors: [{ code: 'too_large' }], message: 'This API returns blobs…' }),
          { status: 403 },
        ),
    );
    expect(await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big.bin', 'main')).toEqual({
      outcome: 'too_large',
      path: 'big.bin',
      ref: 'main',
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });
  });

  it('names a refused credential', async () => {
    stubFetch(() => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
    expect(await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main')).toEqual({
      outcome: 'unauthorized',
      path: 'lib/x.ts',
      ref: 'main',
    });
  });

  it('refuses a body DECLARED over the fetch limit before buffering it', async () => {
    stubFetch(
      () =>
        new Response('a'.repeat(64), {
          status: 200,
          headers: { 'content-length': String(REPO_FILE_FETCH_MAX_BYTES + 1) },
        }),
    );
    expect(await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big.txt', 'main')).toEqual({
      outcome: 'too_large',
      path: 'big.txt',
      ref: 'main',
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });
  });

  it('caps a body over the fetch limit that declared no length', async () => {
    stubFetch(undeclaredOverFetchLimit);
    expect(await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big.txt', 'main')).toEqual({
      outcome: 'too_large',
      path: 'big.txt',
      ref: 'main',
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });
  });

  // MOTIR-10143: the 1 MB whole-file limit is the SERVICE's. The provider hands
  // back a text blob over it, so a ranged read of a large file can be served.
  it('returns a text file over the 1 MB whole-file limit as `found`', async () => {
    const text = 'line\n'.repeat(Math.ceil((REPO_FILE_MAX_BYTES + 1) / 5));
    stubFetch(() => new Response(text, { status: 200 }));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big.ts', 'main');
    expect(result).toMatchObject({ outcome: 'found', bytes: text.length });
    expect(result.outcome === 'found' && result.text).toBe(text);
  });

  it('returns an EMPTY file as `found`, never as absent', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    expect(await github.readFileAtRef('inst-1', 'moooon', 'acme', 'empty.txt', 'main')).toEqual({
      outcome: 'found',
      path: 'empty.txt',
      ref: 'main',
      text: '',
      bytes: 0,
    });
  });

  it('reports a transport failure as `unreachable`, distinct from every absence', async () => {
    stubFetch(() => {
      throw new Error('ECONNRESET');
    });
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main'),
    ).toMatchObject({ outcome: 'unreachable', failure: 'unreachable', detail: 'ECONNRESET' });
  });

  it('reports the deadline as `unreachable` with failure `timeout`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).includes('/access_tokens')) return tokenResponse();
        const signal = init?.signal as AbortSignal;
        Object.defineProperty(signal, 'aborted', { value: true, configurable: true });
        throw new Error('This operation was aborted');
      }),
    );
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main'),
    ).toMatchObject({ outcome: 'unreachable', failure: 'timeout' });
  });

  // The ONE throwing case. A 500 is not an answer a model can plan around, and
  // collapsing it into "not found" is exactly the tolerant-branch failure this
  // capability is written against.
  it('THROWS a typed error for a status no arm names', async () => {
    stubFetch(() => new Response('upstream exploded', { status: 502 }));
    const err = await github
      .readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoFileReadError);
    expect((err as RepoFileReadError).status).toBe(502);
    expect((err as RepoFileReadError).providerId).toBe('github');
  });

  it('refuses a traversal WITHOUT issuing a request', async () => {
    const fetchMock = stubFetch(() => new Response('should never be reached', { status: 200 }));
    const result = await github.readFileAtRef(
      'inst-1',
      'moooon',
      'acme',
      '../../etc/passwd',
      'main',
    );
    expect(result).toMatchObject({ outcome: 'invalid_path' });
    // ⚠️ THE ASSERTION THE CRITERION IS ABOUT. GitHub would 404 this too, and a
    // 404 is indistinguishable from an honest miss — so the guarantee has to be
    // that nothing was SENT, not that the answer came back negative. Nothing at
    // all was: the guard runs ahead of the token mint, so not even that fired.
    expect(hostCalls(fetchMock)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not put the token, or any URL carrying one, in the result', async () => {
    stubFetch(() => new Response('const secret = "not a token";', { status: 200 }));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', 'main');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghs_read');
    expect(serialized).not.toContain('download_url');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('gitlab.readFileAtRef', () => {
  beforeEach(() => {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_read',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('URL-encodes the project path AND the file path', async () => {
    const fetchMock = stubFetch(() => new Response('module x\n', { status: 200 }));
    const result = await gitlab.readFileAtRef(
      'conn-1',
      'acme/platform',
      'web',
      'src/app/page.ts',
      'main',
    );
    expect(result).toMatchObject({ outcome: 'found', text: 'module x\n' });
    const url = hostCalls(fetchMock)[0] as string;
    // The NESTED group is the case a two-segment parser gets wrong; both the
    // project path's slash and the file path's are encoded.
    expect(url).toContain('/api/v4/projects/acme%2Fplatform%2Fweb/repository/files/');
    expect(url).toContain('src%2Fapp%2Fpage.ts/raw?ref=main');
  });

  it('gives the SAME named outcomes as GitHub for the same facts', async () => {
    stubFetch(
      () => new Response(JSON.stringify({ message: '404 File Not Found' }), { status: 404 }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'nope.ts', 'main')).toEqual({
      outcome: 'not_found',
      path: 'nope.ts',
      ref: 'main',
    });

    stubFetch(
      () => new Response(JSON.stringify({ message: '404 Reference Not Found' }), { status: 404 }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', 'nope')).toEqual({
      outcome: 'ref_not_found',
      path: 'src/x.ts',
      ref: 'nope',
    });

    stubFetch(() => new Response('{"message":"401 Unauthorized"}', { status: 401 }));
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', 'main')).toEqual({
      outcome: 'unauthorized',
      path: 'src/x.ts',
      ref: 'main',
    });
  });

  // ⚠️ THE ARM WITH NO UPSTREAM COUNTERPART. GitLab has no inline size refusal,
  // so without our own cap the same file would be a named `too_large` on one
  // host and a multi-megabyte string on the other — a session learning a
  // different fact about a repository because of where it is hosted.
  it('applies the SHARED fetch cap that GitLab itself does not enforce', async () => {
    stubFetch(
      () =>
        new Response('a'.repeat(64), {
          status: 200,
          headers: { 'content-length': String(REPO_FILE_FETCH_MAX_BYTES + 1) },
        }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'big.bin', 'main')).toEqual({
      outcome: 'too_large',
      path: 'big.bin',
      ref: 'main',
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });

    stubFetch(undeclaredOverFetchLimit);
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'big.bin', 'main')).toMatchObject({
      outcome: 'too_large',
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });
  });

  // MOTIR-10143: as on GitHub, a text file over the 1 MB whole-file limit is
  // handed back — the limit is the service's, applied only to an unranged read.
  it('returns a text file over the 1 MB whole-file limit as `found`', async () => {
    const text = 'a'.repeat(REPO_FILE_MAX_BYTES + 1);
    stubFetch(() => new Response(text, { status: 200 }));
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'big.ts', 'main')).toMatchObject({
      outcome: 'found',
      bytes: REPO_FILE_MAX_BYTES + 1,
    });
  });

  it('refuses a traversal WITHOUT issuing a request, and without minting a token', async () => {
    const fetchMock = stubFetch(() => new Response('should never be reached', { status: 200 }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'a/../../b', 'main');
    expect(result).toMatchObject({ outcome: 'invalid_path' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not put the token in the result', async () => {
    stubFetch(() => new Response('x', { status: 200 }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', 'main');
    expect(JSON.stringify(result)).not.toContain('glpat_read');
  });
});

// ─── The HOST's object id on a found read, when asked (MOTIR-11528) ─────────
//
// The properties: the id is the host's answer passed through (a recorded id
// that is NOT the git object id of the returned text still comes back), it is
// asked for the path and ref the text was read at, nothing changes without the
// ask, no other outcome asks for it, and a host that gives none — or fails on
// the question — leaves the read found. The fixtures are each host's recorded
// answer shape: GitHub's GraphQL `Repository.object … on Blob { oid }`, GitLab's
// `X-Gitlab-Blob-Id` header on the files endpoints.

/** The git object id of `text` as a blob — what a hash WE computed would be. */
function gitBlobIdOf(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

const RECORDED_OID = '3f786850e387550fdab836ed7e6dc881de23001b';
const SHA_256_OID = 'c'.repeat(64);
const READ_AT = '9fceb02d0ae598e95dc970b74767f19372d61af8';

interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
  signal: AbortSignal | undefined;
}

/** A fetch mock that records method, body and signal of every host call. */
function recordingFetch(reply: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) return tokenResponse();
    const call = {
      url: u,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return reply(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function graphqlOid(oid: unknown): Response {
  return new Response(JSON.stringify({ data: { repository: { object: { oid } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request that never answers until its signal aborts — the deadline's case. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
  });
}

describe('github.readFileAtRef — the blob id, when asked', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const TEXT = 'export const x = 1;\n';

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** The text read answers TEXT; the object read answers `objectReply`. */
  function host(objectReply: (call: RecordedCall) => Response | Promise<Response>) {
    return recordingFetch((call) =>
      call.url.endsWith('/graphql') ? objectReply(call) : new Response(TEXT, { status: 200 }),
    );
  }

  it('answers the recorded oid, asked for the ref and path the text was read at', async () => {
    const calls = host(() => graphqlOid(RECORDED_OID));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', './lib//x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 20,
      blobSha: RECORDED_OID,
    });
    // Exactly two host calls: the text, then the id — no ref is resolved again.
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repos/moooon/acme/contents/lib/x.ts?ref=${READ_AT}`,
      'https://api.github.com/graphql',
    ]);
    const idCall = calls[1] as RecordedCall;
    expect(idCall.method).toBe('POST');
    expect(JSON.parse(idCall.body as string).variables).toEqual({
      owner: 'moooon',
      name: 'acme',
      expression: `${READ_AT}:lib/x.ts`,
    });
    expect(JSON.parse(idCall.body as string).query).toMatch(/on Blob \{ oid \}/);
    expect(idCall.signal).toBeDefined();
  });

  it('passes the host’s id through — never a digest of the text it received', async () => {
    expect(RECORDED_OID).not.toBe(gitBlobIdOf(TEXT));
    host(() => graphqlOid(RECORDED_OID.toUpperCase()));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ outcome: 'found', text: TEXT, blobSha: RECORDED_OID });
  });

  it('accepts a SHA-256 repository’s 64-hex object id', async () => {
    host(() => graphqlOid(SHA_256_OID));
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT, {
        blobSha: true,
      }),
    ).toMatchObject({ outcome: 'found', blobSha: SHA_256_OID });
  });

  it('without the ask makes exactly today’s one request and answers no blobSha', async () => {
    const calls = host(() => graphqlOid(RECORDED_OID));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT);
    expect(result).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 20,
    });
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repos/moooon/acme/contents/lib/x.ts?ref=${READ_AT}`,
    ]);
    const explicitOff = await github.readFileAtRef(
      'inst-1',
      'moooon',
      'acme',
      'lib/x.ts',
      READ_AT,
      {
        blobSha: false,
      },
    );
    expect(explicitOff).not.toHaveProperty('blobSha');
  });

  it.each([
    ['an object that is not a blob', () => graphqlOid(undefined)],
    [
      'no object at all',
      () => new Response(JSON.stringify({ data: { repository: { object: null } } })),
    ],
    ['a value that is not an object id', () => graphqlOid('not-a-sha')],
    ['a GraphQL error', () => new Response(JSON.stringify({ errors: [{ type: 'NOT_FOUND' }] }))],
    ['a refused credential', () => new Response('{"message":"Bad credentials"}', { status: 401 })],
    ['a status no arm names', () => new Response('upstream exploded', { status: 502 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    [
      'a dead host',
      () => {
        throw new Error('ECONNRESET');
      },
    ],
  ])('leaves the read found, with no blobSha, on %s', async (_label, reply) => {
    host(reply);
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT, {
        blobSha: true,
      }),
    ).toEqual({ outcome: 'found', path: 'lib/x.ts', ref: READ_AT, text: TEXT, bytes: 20 });
  });

  it('bounds the id request by REPO_FILE_READ_TIMEOUT_MS, and a timeout leaves the read found', async () => {
    host((call) => hangUntilAborted(call.signal));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT, {
      blobSha: true,
    });
    await vi.advanceTimersByTimeAsync(REPO_FILE_READ_TIMEOUT_MS);
    expect(await pending).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 20,
    });
  });

  it.each([
    ['not_found', () => new Response('{"message":"Not Found"}', { status: 404 })],
    [
      'ref_not_found',
      () => new Response('{"message":"No commit found for the ref x"}', { status: 404 }),
    ],
    ['unauthorized', () => new Response('{"message":"Bad credentials"}', { status: 401 })],
    ['too_large', () => new Response('{"errors":[{"code":"too_large"}]}', { status: 403 })],
    [
      'directory',
      () =>
        new Response(JSON.stringify([{ name: 'x.ts', path: 'lib/x.ts', type: 'file', sha: 'a' }]), {
          status: 200,
        }),
    ],
    [
      'unreachable',
      () => {
        throw new Error('ECONNRESET');
      },
    ],
  ])('a %s answer carries no blobSha and makes no id request', async (outcome, reply) => {
    const calls = recordingFetch((call) =>
      call.url.endsWith('/graphql') ? graphqlOid(RECORDED_OID) : reply(),
    );
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib', READ_AT, {
      blobSha: true,
    });
    expect(result.outcome).toBe(outcome);
    expect(result).not.toHaveProperty('blobSha');
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(false);
  });

  it('an over-size blob carries no blobSha and makes no id request', async () => {
    const calls = recordingFetch((call) =>
      call.url.endsWith('/graphql') ? graphqlOid(RECORDED_OID) : undeclaredOverFetchLimit(),
    );
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big.txt', READ_AT, {
      blobSha: true,
    });
    expect(result).toEqual({
      outcome: 'too_large',
      path: 'big.txt',
      ref: READ_AT,
      limitBytes: REPO_FILE_FETCH_MAX_BYTES,
    });
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(false);
  });

  it('a rejected path makes no request at all, the id request included', async () => {
    const calls = host(() => graphqlOid(RECORDED_OID));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', '../x', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ outcome: 'invalid_path' });
    expect(result).not.toHaveProperty('blobSha');
    expect(calls).toEqual([]);
  });

  it('keeps the raw media type, and the serialized answer carries no download_url or token', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) return tokenResponse();
      if (u.endsWith('/graphql')) return graphqlOid(RECORDED_OID);
      expect(init?.headers).toMatchObject({ accept: 'application/vnd.github.raw' });
      return new Response(TEXT, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'lib/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ blobSha: RECORDED_OID });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('download_url');
    expect(serialized).not.toContain('ghs_read');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('gitlab.readFileAtRef — the blob id, when asked', () => {
  const TEXT = 'module x\n';
  const RAW = `https://gitlab.com/api/v4/projects/acme%2Fweb/repository/files/src%2Fx.ts/raw?ref=${READ_AT}`;
  const METADATA = `https://gitlab.com/api/v4/projects/acme%2Fweb/repository/files/src%2Fx.ts?ref=${READ_AT}`;

  beforeEach(() => {
    vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.com');
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_read',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function rawWith(headers: Record<string, string>): Response {
    return new Response(TEXT, { status: 200, headers });
  }

  it('answers the X-Gitlab-Blob-Id the raw read carried, with no second request', async () => {
    expect(RECORDED_OID).not.toBe(gitBlobIdOf(TEXT));
    const calls = recordingFetch(() => rawWith({ 'x-gitlab-blob-id': RECORDED_OID }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toEqual({
      outcome: 'found',
      path: 'src/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 9,
      blobSha: RECORDED_OID,
    });
    expect(calls.map((c) => c.url)).toEqual([RAW]);
  });

  it('asks the metadata HEAD for the same path and ref when the raw read carried no id', async () => {
    const calls = recordingFetch((call) =>
      call.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'x-gitlab-blob-id': RECORDED_OID } })
        : rawWith({}),
    );
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ outcome: 'found', text: TEXT, blobSha: RECORDED_OID });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', RAW],
      ['HEAD', METADATA],
    ]);
    expect((calls[1] as RecordedCall).signal).toBeDefined();
  });

  it('without the ask makes exactly today’s one request and answers no blobSha', async () => {
    const calls = recordingFetch(() => rawWith({ 'x-gitlab-blob-id': RECORDED_OID }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT);
    expect(result).toEqual({
      outcome: 'found',
      path: 'src/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 9,
    });
    expect(calls.map((c) => c.url)).toEqual([RAW]);
  });

  it.each([
    ['no id header', () => new Response(null, { status: 200 })],
    [
      'a value that is not an object id',
      () => new Response(null, { status: 200, headers: { 'x-gitlab-blob-id': 'zz' } }),
    ],
    ['a refused credential', () => new Response(null, { status: 403 })],
    ['a missing file', () => new Response(null, { status: 404 })],
    [
      'a dead host',
      () => {
        throw new Error('ECONNRESET');
      },
    ],
  ])(
    'leaves the read found, with no blobSha, when the metadata read gives %s',
    async (_l, head) => {
      recordingFetch((call) => (call.method === 'HEAD' ? head() : rawWith({})));
      expect(
        await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, { blobSha: true }),
      ).toEqual({ outcome: 'found', path: 'src/x.ts', ref: READ_AT, text: TEXT, bytes: 9 });
    },
  );

  it('bounds the metadata read by REPO_FILE_READ_TIMEOUT_MS, and a timeout leaves the read found', async () => {
    recordingFetch((call) =>
      call.method === 'HEAD' ? hangUntilAborted(call.signal) : rawWith({}),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, {
      blobSha: true,
    });
    await vi.advanceTimersByTimeAsync(REPO_FILE_READ_TIMEOUT_MS);
    expect(await pending).toEqual({
      outcome: 'found',
      path: 'src/x.ts',
      ref: READ_AT,
      text: TEXT,
      bytes: 9,
    });
  });

  it.each([
    ['not_found', () => new Response('{"message":"404 File Not Found"}', { status: 404 })],
    ['ref_not_found', () => new Response('{"message":"404 Reference Not Found"}', { status: 404 })],
    ['unauthorized', () => new Response('{"message":"401 Unauthorized"}', { status: 401 })],
    [
      'too_large',
      () =>
        new Response('a', {
          status: 200,
          headers: {
            'content-length': String(REPO_FILE_FETCH_MAX_BYTES + 1),
            'x-gitlab-blob-id': RECORDED_OID,
          },
        }),
    ],
    [
      'unreachable',
      () => {
        throw new Error('ECONNRESET');
      },
    ],
  ])('a %s answer carries no blobSha and makes no id request', async (outcome, reply) => {
    const calls = recordingFetch((call) =>
      call.url.includes('/repository/tree')
        ? new Response('[]', { status: 200 })
        : call.method === 'HEAD'
          ? new Response(null, { status: 200, headers: { 'x-gitlab-blob-id': RECORDED_OID } })
          : reply(),
    );
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result.outcome).toBe(outcome);
    expect(result).not.toHaveProperty('blobSha');
    expect(calls.some((c) => c.method === 'HEAD')).toBe(false);
  });

  it('a directory answer carries no blobSha and makes no id request', async () => {
    const calls = recordingFetch((call) =>
      call.url.includes('/repository/tree')
        ? new Response(
            JSON.stringify([{ id: '1', name: 'x.ts', type: 'blob', path: 'src/x.ts' }]),
            {
              status: 200,
            },
          )
        : new Response('{"message":"404 File Not Found"}', { status: 404 }),
    );
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src', READ_AT, {
      blobSha: true,
    });
    expect(result.outcome).toBe('directory');
    expect(result).not.toHaveProperty('blobSha');
    expect(calls.some((c) => c.method === 'HEAD')).toBe(false);
  });

  it('a rejected path makes no request at all, the id request included', async () => {
    const calls = recordingFetch(() => rawWith({ 'x-gitlab-blob-id': RECORDED_OID }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', '../x', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ outcome: 'invalid_path' });
    expect(calls).toEqual([]);
  });

  it('does not put the token in a result that carries the id', async () => {
    recordingFetch(() => rawWith({ 'x-gitlab-blob-id': RECORDED_OID }));
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'src/x.ts', READ_AT, {
      blobSha: true,
    });
    expect(result).toMatchObject({ blobSha: RECORDED_OID });
    expect(JSON.stringify(result)).not.toContain('glpat_read');
  });
});
