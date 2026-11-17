import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitProvider, REPO_FILE_MAX_BYTES } from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';

// `readFileAtRef`'s `binary` outcome (MOTIR-7873), beside `repoFileRead.test.ts`
// rather than inside it: this spec opens a real binary fixture from the tree,
// and keeping it apart from that file's `docs/…` fixture paths keeps both out
// of the docs-guard lane's derivation (`tests/helpers/docsGuardLane.ts`), which
// neither belongs in — no documentation edit can change either verdict.

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

/** Every non-token fetch answers `reply`. */
function stubFetch(reply: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) return tokenResponse();
    return reply(u);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ─── A BINARY blob is NAMED, never decoded into `found` (MOTIR-7873) ────────
//
// Both providers used to `res.text()` every 200 body and return it as `found`,
// so a PNG reached a planning model as a page of U+FFFD and raw NULs, with
// `bytes` measured on the DECODED string — each invalid byte became a 3-byte
// replacement character, which inflated the count and could tip a small binary
// over the cap into `too_large`. The fixtures are real bytes, compared on their
// real length, and the same cases run against BOTH hosts: a session must learn
// the same fact about a file wherever it is hosted.

/** A real PNG from this repository — 4,877 bytes, the reproduction's own file. */
const PNG = readFileSync(join(process.cwd(), 'app/apple-icon.png'));
/** UTF-8 text with multibyte characters: its byte length is NOT its `.length`. */
const MULTIBYTE = 'export const greeting = "héllo — 你好 👋";\n';
/** Valid UTF-8 (all ASCII) carrying a NUL — git's own binary heuristic. */
const NUL_TEXT = Buffer.from('header\u0000rest of a binary record\n', 'utf8');
/**
 * Under the cap on the wire, OVER it once decoded: every 0xFF is an invalid
 * UTF-8 byte that decodes to U+FFFD, three bytes each.
 */
const INFLATING = Buffer.alloc(Math.floor(REPO_FILE_MAX_BYTES / 2), 0xff);

function bytesResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 200 });
}

describe.each([
  ['github', 'inst-1', 'moooon'],
  ['gitlab', 'conn-1', 'acme'],
] as const)('%s.readFileAtRef — a binary blob', (host, installationId, owner) => {
  const provider = host === 'github' ? github : gitlab;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
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

  it('names a PNG `binary`, with `bytes` equal to the blob’s real length', async () => {
    stubFetch(() => bytesResponse(PNG));
    expect(PNG.length).toBe(4877);
    expect(
      await provider.readFileAtRef(installationId, owner, 'web', 'app/apple-icon.png', 'main'),
    ).toEqual({ outcome: 'binary', path: 'app/apple-icon.png', ref: 'main', bytes: PNG.length });
  });

  // MOTIR-11528: the id is asked only on a FOUND answer, so a binary read with
  // the ask on carries none and never reaches the host's object read.
  it('carries no blobSha on a binary answer, and makes no id request, with the ask on', async () => {
    const fetchMock = stubFetch(() => bytesResponse(PNG));
    const result = await provider.readFileAtRef(
      installationId,
      owner,
      'web',
      'app/apple-icon.png',
      'main',
      { blobSha: true },
    );
    expect(result).toEqual({
      outcome: 'binary',
      path: 'app/apple-icon.png',
      ref: 'main',
      bytes: PNG.length,
    });
    const hostCalls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => !u.includes('/access_tokens'));
    expect(hostCalls).toHaveLength(1);
    expect(hostCalls.some((u) => u.endsWith('/graphql'))).toBe(false);
  });

  it('names valid UTF-8 carrying a NUL `binary` — git’s own heuristic', async () => {
    stubFetch(() => bytesResponse(NUL_TEXT));
    expect(await provider.readFileAtRef(installationId, owner, 'web', 'data.bin', 'main')).toEqual({
      outcome: 'binary',
      path: 'data.bin',
      ref: 'main',
      bytes: NUL_TEXT.length,
    });
  });

  it('still returns multibyte UTF-8 text as `found`, with `bytes` its REAL length', async () => {
    stubFetch(() => bytesResponse(Buffer.from(MULTIBYTE, 'utf8')));
    const result = await provider.readFileAtRef(installationId, owner, 'web', 'lib/x.ts', 'main');
    expect(result).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: 'main',
      text: MULTIBYTE,
      bytes: Buffer.byteLength(MULTIBYTE, 'utf8'),
    });
    // The case a `.length` measurement gets wrong: the two must differ here.
    expect(Buffer.byteLength(MULTIBYTE, 'utf8')).toBeGreaterThan(MULTIBYTE.length);
  });

  it('names a blob over the cap only when DECODED `binary`, not `too_large`', async () => {
    expect(INFLATING.length).toBeLessThan(REPO_FILE_MAX_BYTES);
    expect(Buffer.byteLength(INFLATING.toString('utf8'), 'utf8')).toBeGreaterThan(
      REPO_FILE_MAX_BYTES,
    );
    stubFetch(() => bytesResponse(INFLATING));
    expect(await provider.readFileAtRef(installationId, owner, 'web', 'blob.dat', 'main')).toEqual({
      outcome: 'binary',
      path: 'blob.dat',
      ref: 'main',
      bytes: INFLATING.length,
    });
  });
});
