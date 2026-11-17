import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { GET, maxDuration } from '@/app/api/internal/ai/repo-file/route';
import { splitRepoRef } from '@/lib/services/repoFileReadService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { REPO_FILE_FETCH_MAX_BYTES, REPO_FILE_READ_TIMEOUT_MS } from '@/lib/git';
import { renderReadFile } from '@/lib/mcp/tools/readFile';
import { createTestWorkspace, createTestProject } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-4586 — the repo-file READ-BACK route end-to-end through the REAL route
// handler, against a real Postgres: both §4 grants, the 400s, the happy path
// that resolves a connected repo → installation token → file text, and the two
// properties the story is actually about.
//
// ⚠️ THE NEGATIVE ASSERTIONS ARE THE POINT, and there are two of them:
//
//   1. A repo NOT connected in the token's workspace is `repo_not_connected` —
//      the same answer as a repo that does not exist anywhere. No existence
//      leak, and no cross-tenant credential can be reached.
//   2. NOTHING credential-shaped is in the serialized response. Asserted over
//      the response TEXT rather than over the parsed object, because a token
//      nested inside an echoed error body is exactly the case a shape
//      assertion walks straight past.

const SERVICE_SECRET = 'core-callback-secret-test';
const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};
const FILE_TEXT = 'export const answer = 42;\n';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  _resetInstallationTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function req(path: string, opts: { bearer?: string; token?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(`http://core${path}`, { headers });
}

const HEAD_SHA = 'fade'.padEnd(40, '2');

function stubGithub(fileReply: () => Response): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      if (String(url).endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_route_secret',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // The ref resolves to its commit first (MOTIR-10122); the read is at it.
      if (String(url).includes('/commits/')) return new Response(HEAD_SHA, { status: 200 });
      if (String(url).includes('/contents/')) return fileReply();
      return new Response('nf', { status: 404 });
    }),
  );
}

async function seedConnectedProject() {
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    identifier: 'ACME',
    name: 'Acme',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId: 'inst-1', accountLogin: 'moooon', accountType: 'User' },
    repos: [REPO],
  });
  const token = mintJobToken({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { token };
}

describe('splitRepoRef — the parser that is NOT the GitHub one', () => {
  it('splits at the LAST slash, so a nested GitLab group survives', () => {
    expect(splitRepoRef('moooon/motir-core')).toEqual({ owner: 'moooon', name: 'motir-core' });
    // The case `lib/github/codeScanning.ts`'s two-segment parser refuses, and
    // which `normalizeProject` in the GitLab provider stores exactly this way.
    expect(splitRepoRef('acme/platform/web')).toEqual({ owner: 'acme/platform', name: 'web' });
    expect(splitRepoRef('https://github.com/moooon/motir-core.git')).toEqual({
      owner: 'moooon',
      name: 'motir-core',
    });
  });

  it('refuses a ref with no owner, no name, or a traversal in the owner', () => {
    for (const bad of ['', 'solo', '/name', 'owner/', '../x/y']) {
      expect(splitRepoRef(bad), `expected "${bad}" to be refused`).toBeNull();
    }
  });
});

describe('GET /api/internal/ai/repo-file — read-back auth', () => {
  it('rejects a missing/wrong service bearer with 401', async () => {
    const res = await GET(req('/api/internal/ai/repo-file?repoRef=a/b&path=x.ts', { token: 'x' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'service_unauthorized' });
  });

  it('rejects a missing/tampered job token with 401', async () => {
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=a/b&path=x.ts', { bearer: SERVICE_SECRET }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'token_invalid' });
  });
});

describe('GET /api/internal/ai/repo-file — validation', () => {
  it('400 when repoRef is missing', async () => {
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?path=x.ts', { bearer: SERVICE_SECRET, token }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when path is missing', async () => {
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/ai/repo-file — the connected repo', () => {
  it('returns the file text, and takes the ref from the stored default branch', async () => {
    stubGithub(() => new Response(FILE_TEXT, { status: 200 }));
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=lib/x.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        outcome: 'found',
        path: 'lib/x.ts',
        ref: 'main',
        commitSha: HEAD_SHA,
        text: FILE_TEXT,
        bytes: FILE_TEXT.length,
      },
    });
  });

  it('honours an explicit ref', async () => {
    stubGithub(() => new Response(FILE_TEXT, { status: 200 }));
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=lib/x.ts&ref=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await res.json()).toMatchObject({ result: { ref: 'feat/x', commitSha: HEAD_SHA } });
  });

  // MOTIR-10143 — a file over the 1 MB whole-file limit: refused whole with its
  // line count, served to a caller that says it reads a range.
  it('serves a file over 1 MB only to a ranged read, and names its lines otherwise', async () => {
    const big = 'x'.repeat(1024 * 1024) + '\nlast';
    stubGithub(() => new Response(big, { status: 200 }));
    const { token } = await seedConnectedProject();
    const whole = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=big.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await whole.json()).toEqual({
      result: {
        outcome: 'too_large',
        path: 'big.ts',
        ref: 'main',
        commitSha: HEAD_SHA,
        limitBytes: 1024 * 1024,
        totalLines: 2,
      },
    });

    const ranged = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=big.ts&startLine=2', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await ranged.json()).toMatchObject({
      result: { outcome: 'found', bytes: big.length, text: big },
    });
  });

  // ⚠️ A NAMED OUTCOME, AT 200. A 404 here would be indistinguishable from the
  // ROUTE being absent, and a client's tolerant error branch absorbs both — the
  // failure mode this whole result union exists to make impossible.
  it('answers 200 with a named outcome for an absent path', async () => {
    stubGithub(() => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=nope.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { outcome: 'not_found', path: 'nope.ts', ref: 'main', commitSha: HEAD_SHA },
    });
  });

  // MOTIR-7873 — a binary blob reaches the model as a NAMED outcome carrying no
  // content, never as `found` with its bytes decoded into replacement characters.
  it('passes a binary file through as the named `binary` outcome, with no text', async () => {
    const png = readFileSync(join(process.cwd(), 'app/apple-icon.png'));
    stubGithub(() => new Response(new Uint8Array(png), { status: 200 }));
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=app/apple-icon.png', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        outcome: 'binary',
        path: 'app/apple-icon.png',
        ref: 'main',
        commitSha: HEAD_SHA,
        bytes: png.length,
      },
    });
  });

  it('refuses a traversal as a named outcome, without reaching the host', async () => {
    stubGithub(() => new Response('should never be reached', { status: 200 }));
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=..%2F..%2Fetc%2Fpasswd', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { outcome: 'invalid_path' } });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/contents/'))).toBe(false);
  });

  it('reports a repo connected in ANOTHER workspace exactly as one that does not exist', async () => {
    stubGithub(() => new Response(FILE_TEXT, { status: 200 }));
    const { token } = await seedConnectedProject();
    // A second workspace with its own connected repo. The first workspace's
    // token must not be able to tell it apart from a name nobody has.
    const other = await createTestWorkspace({ name: 'Other' });
    await githubInstallationService.persistInstallation({
      workspaceId: other.workspace.id,
      installation: { installationId: 'inst-2', accountLogin: 'someone', accountType: 'User' },
      repos: [{ ...REPO, providerRepoId: '222', owner: 'someone', name: 'private' }],
    });

    const theirs = await GET(
      req('/api/internal/ai/repo-file?repoRef=someone/private&path=lib/x.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    const nobodys = await GET(
      req('/api/internal/ai/repo-file?repoRef=nobody/at-all&path=lib/x.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await theirs.json()).toEqual({
      result: { outcome: 'repo_not_connected', repoRef: 'someone/private' },
    });
    expect(await nobodys.json()).toEqual({
      result: { outcome: 'repo_not_connected', repoRef: 'nobody/at-all' },
    });
  });

  // ⚠️ OVER THE SERIALIZED PAYLOAD, not the parsed object. A token echoed inside
  // a nested error string satisfies every shape assertion ever written about a
  // response and is still a leak.
  it('emits no token, and no URL carrying one, in the response body', async () => {
    stubGithub(
      () =>
        new Response(FILE_TEXT, {
          status: 200,
          headers: { 'x-echo': 'ghs_route_secret' },
        }),
    );
    const { token } = await seedConnectedProject();
    const res = await GET(
      req('/api/internal/ai/repo-file?repoRef=moooon/motir-core&path=lib/x.ts', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    const body = await res.text();
    expect(body).not.toContain('ghs_route_secret');
    expect(body).not.toContain('download_url');
    expect(body).not.toContain(SERVICE_SECRET);
    expect(body).not.toContain(token);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MOTIR-11532 — THE STORY GATE FOR MOTIR-11495: the file's git blob id survives
// provider → service → this route, on GitHub and on GitLab, and is ABSENT on
// every arm where carrying it would be a lie about the file.
//
// The real route, the real service and both real providers run over real
// Postgres; only the git host is replayed, at the `fetch` boundary, by a STRICT
// fixture per host. Three properties make the equality mean something:
//
//   - The recorded id is keyed by the REF IN THE REQUEST, and the branch name
//     answers a DIFFERENT id from the resolved commit — so a provider that asked
//     about the ref the caller named, not the commit it read, fails.
//   - Neither id is the git object id of the fixture's own text — so an id
//     computed by hashing what motir received fails.
//   - A request the fixture does not recognise is RECORDED and fails the case in
//     `afterEach`, naming it. It cannot throw instead: the id read is best effort
//     and absorbs a throw into "no id", which would silently measure a mechanism
//     that landed somewhere else as a host with no id.
//
// `stubGithub` above is deliberately left answering the object-id question with
// nothing (its catch-all 404): the found literal in "returns the file text" is
// that "host gave no id" arm, and it stays literal.
// ════════════════════════════════════════════════════════════════════════════

const COMMIT = '9fceb02d0ae598e95dc970b74767f19372d61af8';
/** The host's recorded id for the content AT `COMMIT` — what the gate expects. */
const COMMIT_BLOB = '3f786850e387550fdab836ed7e6dc881de23001b';
/** The id the host would answer for the BRANCH NAME: a read that asked about the
 *  ref rather than the commit answers this, and fails the equality. */
const BRANCH_BLOB = 'aaaabbbbccccddddeeeeffff0000111122223333';
const GL_COMMIT_BLOB = 'b0b0b0b0c1c1c1c1d2d2d2d2e3e3e3e3f4f4f4f4';
const GL_BRANCH_BLOB = '0123456789abcdef0123456789abcdef01234567';
const GH_TOKEN = 'ghs_route_secret';
const GL_TOKEN = 'glpat_route_secret';
const LEAKY_URL = `https://raw.githubusercontent.com/moooon/motir-core/main/lib/x.ts?token=${GH_TOKEN}`;

/** The git object id git itself would compute for `text` — what the gate's ids are NOT. */
const gitBlobIdOf = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');

interface HostRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  signalled: boolean;
}
let hostRequests: HostRequest[] = [];
let unanswered: string[] = [];

function record(input: string | URL | Request, init: RequestInit = {}): HostRequest {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const r: HostRequest = {
    method: (init.method ?? 'GET').toUpperCase(),
    url: input instanceof Request ? input.url : String(input),
    headers,
    body: typeof init.body === 'string' ? init.body : null,
    signalled: init.signal instanceof AbortSignal,
  };
  hostRequests.push(r);
  return r;
}

function refuse(r: HostRequest): Response {
  unanswered.push(`${r.method} ${r.url}`);
  return new Response('the gate fixture has no answer for this request', { status: 599 });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

interface GithubHost {
  /** The `/commits/<ref>` resolve. Default: every ref names `COMMIT`. */
  resolve?: (ref: string) => Response;
  /** The raw `/contents/<path>?ref=` read. Default: `FILE_TEXT`. */
  content?: (path: string) => Response;
  /** The id the host holds for `<ref>:<path>`, or null for none. */
  idFor?: (ref: string) => string | null;
}

const githubIdFor = (ref: string) =>
  ref === COMMIT ? COMMIT_BLOB : ref === 'main' ? BRANCH_BLOB : null;

/** A strict GitHub: the token mint, the resolve, the raw read, the GraphQL object
 *  read the merged provider issues — and, as fallbacks a provider reaching the
 *  id another way would use, the JSON contents envelope and the tree listing.
 *  Every id-bearing shape answers the SAME recorded id, and carries a
 *  token-bearing `download_url` where GitHub's real envelope does. */
function githubHost(host: GithubHost = {}): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const idFor = host.idFor ?? githubIdFor;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const r = record(input, init);
    const url = new URL(r.url);
    const p = url.pathname;
    if (r.method === 'POST' && p.endsWith('/access_tokens')) {
      return json({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    const repo = '/repos/moooon/motir-core';
    if (r.method === 'GET' && p.startsWith(`${repo}/commits/`)) {
      const ref = decodeURIComponent(p.slice(`${repo}/commits/`.length));
      return host.resolve ? host.resolve(ref) : new Response(COMMIT, { status: 200 });
    }
    if (r.method === 'GET' && p.startsWith(`${repo}/contents/`)) {
      const path = decodeURIComponent(p.slice(`${repo}/contents/`.length));
      const ref = url.searchParams.get('ref') ?? '';
      if (r.headers['accept'] === 'application/vnd.github.raw') {
        return host.content ? host.content(path) : new Response(FILE_TEXT, { status: 200 });
      }
      // FALLBACK — the JSON contents envelope, as GitHub really serves it.
      return json({ type: 'file', path, sha: idFor(ref), download_url: LEAKY_URL });
    }
    if (r.method === 'GET' && p.startsWith(`${repo}/git/trees/`)) {
      // FALLBACK — the tree listing, one blob at the path.
      const ref = decodeURIComponent(p.slice(`${repo}/git/trees/`.length));
      return json({ sha: ref, tree: [{ path: 'lib/x.ts', type: 'blob', sha: idFor(ref) }] });
    }
    if (r.method === 'POST' && p === '/graphql') {
      const { variables } = JSON.parse(r.body ?? '{}') as {
        variables?: { owner?: string; name?: string; expression?: string };
      };
      const expression = variables?.expression ?? '';
      const ref = expression.slice(0, expression.indexOf(':'));
      const oid =
        variables?.owner === 'moooon' && variables.name === 'motir-core' ? idFor(ref) : null;
      return json({
        data: { repository: { object: oid ? { oid, download_url: LEAKY_URL } : null } },
      });
    }
    return refuse(r);
  });
}

interface GitlabHost {
  resolve?: (ref: string) => Response;
  /** The raw read; the fixture adds `x-gitlab-blob-id` for the ref read at. */
  content?: (path: string) => Response;
  /** The tree listing at a path. Default: empty, so a 404 is `not_found`. */
  tree?: (path: string) => unknown[];
  idFor?: (ref: string) => string | null;
}

const gitlabIdFor = (ref: string) =>
  ref === COMMIT ? GL_COMMIT_BLOB : ref === 'main' ? GL_BRANCH_BLOB : null;

/** A strict GitLab: the commit resolve, the raw file read (which sets
 *  `X-Gitlab-Blob-Id`, as GitLab's files endpoints do), the HEAD metadata read
 *  and the JSON file envelope as fallbacks, and the tree listing. */
function gitlabHost(host: GitlabHost = {}): void {
  vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.example');
  vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
    token: GL_TOKEN,
  } as never);
  const idFor = host.idFor ?? gitlabIdFor;
  const withId = (res: Response, ref: string): Response => {
    const id = idFor(ref);
    if (!res.ok || !id) return res;
    const headers = new Headers(res.headers);
    headers.set('x-gitlab-blob-id', id);
    return new Response(res.body, { status: res.status, headers });
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const r = record(input, init);
    const url = new URL(r.url);
    // Keep the encoded project / file segments: GitLab addresses both encoded.
    const p = r.url.slice(url.origin.length).split('?')[0] ?? '';
    const project = '/api/v4/projects/acme%2Fweb/repository';
    if (r.method === 'GET' && p.startsWith(`${project}/commits/`)) {
      const ref = decodeURIComponent(p.slice(`${project}/commits/`.length));
      return host.resolve ? host.resolve(ref) : json({ id: COMMIT });
    }
    if (p.startsWith(`${project}/files/`)) {
      const rest = p.slice(`${project}/files/`.length);
      const ref = url.searchParams.get('ref') ?? '';
      if (r.method === 'GET' && rest.endsWith('/raw')) {
        const path = decodeURIComponent(rest.slice(0, -'/raw'.length));
        return withId(
          host.content ? host.content(path) : new Response(FILE_TEXT, { status: 200 }),
          ref,
        );
      }
      // FALLBACKS — the HEAD metadata read and the JSON file envelope.
      if (r.method === 'HEAD') return withId(new Response(null, { status: 200 }), ref);
      if (r.method === 'GET') {
        return json({ file_path: decodeURIComponent(rest), blob_id: idFor(ref), ref });
      }
    }
    if (r.method === 'GET' && p === `${project}/tree`) {
      return json(host.tree ? host.tree(url.searchParams.get('path') ?? '') : []);
    }
    return refuse(r);
  });
}

async function seedGitlabRepo(): Promise<{ token: string }> {
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme GL' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    identifier: 'ACMG',
    name: 'Acme GL',
  });
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: workspace.id,
      installationId: 'gl-conn-1',
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'gitlab',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      installationId: installation.id,
      repoId: '11532',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'gitlab',
    },
  });
  return {
    token: mintJobToken({ userId: owner.id, workspaceId: workspace.id, projectId: project.id }),
  };
}

async function readVia(
  token: string,
  repoRef: string,
  path: string,
  extra = '',
): Promise<{ status: number; text: string; result: Record<string, unknown> }> {
  const res = await GET(
    req(`/api/internal/ai/repo-file?repoRef=${repoRef}&path=${encodeURIComponent(path)}${extra}`, {
      bearer: SERVICE_SECRET,
      token,
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    result: (JSON.parse(text) as { result: Record<string, unknown> }).result,
  };
}

describe('MOTIR-11532 — the blob id through GET /api/internal/ai/repo-file', () => {
  beforeEach(() => {
    hostRequests = [];
    unanswered = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(unanswered, 'requests the gate fixture could not answer').toEqual([]);
  });

  it('the recorded ids are neither the branch’s nor a hash of the text', () => {
    expect(COMMIT_BLOB).not.toBe(BRANCH_BLOB);
    expect(GL_COMMIT_BLOB).not.toBe(GL_BRANCH_BLOB);
    for (const id of [COMMIT_BLOB, GL_COMMIT_BLOB]) {
      expect(id).not.toBe(gitBlobIdOf(FILE_TEXT));
    }
  });

  describe('GitHub', () => {
    it('a pinned found read answers the host’s id for the RESOLVED COMMIT, beside commitSha', async () => {
      githubHost();
      const { token } = await seedConnectedProject();
      const { status, result } = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      expect(status).toBe(200);
      expect(result).toEqual({
        outcome: 'found',
        path: 'lib/x.ts',
        ref: 'main',
        commitSha: COMMIT,
        text: FILE_TEXT,
        bytes: FILE_TEXT.length,
        blobSha: COMMIT_BLOB,
      });
      // The branch's id is what a read about `main` would have answered.
      expect(result['blobSha']).not.toBe(githubIdFor('main'));
      const graphql = hostRequests.filter((r) => r.url.endsWith('/graphql'));
      expect(graphql).toHaveLength(1);
      expect(JSON.parse(graphql[0]!.body ?? '{}').variables.expression).toBe(`${COMMIT}:lib/x.ts`);
    });

    it('a ranged read carries the same id as the whole-file read, and still the whole text', async () => {
      githubHost();
      const { token } = await seedConnectedProject();
      const whole = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      const ranged = await readVia(
        token,
        'moooon/motir-core',
        'lib/x.ts',
        '&startLine=1&endLine=5',
      );
      expect(ranged.result).toMatchObject({ outcome: 'found', text: FILE_TEXT, commitSha: COMMIT });
      expect(ranged.result['blobSha']).toBe(COMMIT_BLOB);
      expect(ranged.result['blobSha']).toBe(whole.result['blobSha']);
    });

    it('the raw media type is still asked, and the payload carries nothing credential-shaped', async () => {
      githubHost();
      const { token } = await seedConnectedProject();
      const { text } = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      const content = hostRequests.filter((r) => r.url.includes('/contents/'));
      expect(content.map((r) => r.headers['accept'])).toEqual(['application/vnd.github.raw']);
      expect(text).toContain(COMMIT_BLOB);
      for (const leak of ['download_url', 'Bearer', GH_TOKEN, token, SERVICE_SECRET]) {
        expect(text).not.toContain(leak);
      }
    });

    it('the JSON-envelope fallback shape the fixture serves carries a download_url — which never reaches the payload', async () => {
      // The fallback is what a provider reaching the id through GitHub's REST
      // envelope would meet: prove the fixture really serves the leaky shape.
      githubHost();
      const envelope = await fetch(
        'https://api.github.com/repos/moooon/motir-core/contents/lib/x.ts?ref=' + COMMIT,
        { headers: { accept: 'application/vnd.github+json' } },
      );
      expect(await envelope.json()).toMatchObject({ sha: COMMIT_BLOB, download_url: LEAKY_URL });
      hostRequests = [];
      const { token } = await seedConnectedProject();
      const { text } = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      expect(text).not.toContain('download_url');
      expect(text).not.toContain(GH_TOKEN);
    });

    it('every host request FOR THE FILE carries an abort signal, inside the route’s budget', async () => {
      githubHost();
      const { token } = await seedConnectedProject();
      await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      const forTheFile = hostRequests.filter((r) => !r.url.endsWith('/access_tokens'));
      expect(forTheFile.map((r) => new URL(r.url).pathname)).toEqual([
        `/repos/moooon/motir-core/commits/main`,
        `/repos/moooon/motir-core/contents/lib/x.ts`,
        '/graphql',
      ]);
      expect(forTheFile.every((r) => r.signalled)).toBe(true);
      expect(REPO_FILE_READ_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
    });

    it('a host that gives no id leaves the read found and intact, with no blobSha', async () => {
      githubHost({ idFor: () => null });
      const { token } = await seedConnectedProject();
      const { status, result } = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      expect(status).toBe(200);
      expect(result).toEqual({
        outcome: 'found',
        path: 'lib/x.ts',
        ref: 'main',
        commitSha: COMMIT,
        text: FILE_TEXT,
        bytes: FILE_TEXT.length,
      });
      expect(
        hostRequests.filter((r) => !r.url.endsWith('/access_tokens')).every((r) => r.signalled),
      ).toBe(true);
    });

    it('the real renderer keeps the route’s blobSha on its structured found answer', async () => {
      githubHost();
      const { token } = await seedConnectedProject();
      const { result } = await readVia(token, 'moooon/motir-core', 'lib/x.ts');
      const { structured } = renderReadFile({ ...result, repoRef: 'moooon/motir-core' } as never);
      expect(structured).toMatchObject({ outcome: 'found', commitSha: COMMIT });
      expect(structured['blobSha']).toBe(result['blobSha']);
      expect(structured['blobSha']).toBe(COMMIT_BLOB);
    });

    const png = () => readFileSync(join(process.cwd(), 'app/apple-icon.png'));
    const negatives: {
      name: string;
      path: string;
      host: GithubHost;
      expected: Record<string, unknown>;
      readsContent?: boolean;
      reachesHost?: boolean;
      /** The provider read FOUND text and asked its id; the service's whole-file
       *  limit then answered `too_large`, which drops it (MOTIR-11529). */
      providerFound?: boolean;
      absent?: string[];
    }[] = [
      {
        name: 'a directory',
        path: 'lib',
        host: {
          content: () =>
            json([
              { name: 'x.ts', path: 'lib/x.ts', type: 'file', sha: COMMIT_BLOB },
              { name: 'git', path: 'lib/git', type: 'dir', sha: BRANCH_BLOB },
            ]),
        },
        expected: {
          outcome: 'directory',
          path: 'lib',
          ref: 'main',
          commitSha: COMMIT,
          entries: [
            { name: 'git', type: 'dir' },
            { name: 'x.ts', type: 'file' },
          ],
          truncated: false,
        },
      },
      {
        name: 'a missing path',
        path: 'nope.ts',
        host: { content: () => json({ message: 'Not Found' }, { status: 404 }) },
        expected: { outcome: 'not_found', path: 'nope.ts', ref: 'main', commitSha: COMMIT },
      },
      {
        name: 'a ref that names no commit',
        path: 'lib/x.ts',
        host: { resolve: () => json({ message: 'Not Found' }, { status: 404 }) },
        expected: { outcome: 'ref_not_found', path: 'lib/x.ts', ref: 'main' },
        readsContent: false,
      },
      {
        name: 'a refused credential on the resolve',
        path: 'lib/x.ts',
        host: { resolve: () => json({ message: 'Bad credentials' }, { status: 401 }) },
        expected: { outcome: 'unauthorized', path: 'lib/x.ts', ref: 'main' },
        readsContent: false,
      },
      {
        name: 'a blob the host refuses as too large',
        path: 'huge.bin',
        host: {
          content: () =>
            json(
              {
                message:
                  'This API returns blobs up to 100 MB in size. The requested blob is too large to fetch via the API.',
                errors: [{ code: 'too_large' }],
              },
              { status: 403 },
            ),
        },
        expected: {
          outcome: 'too_large',
          path: 'huge.bin',
          ref: 'main',
          commitSha: COMMIT,
          limitBytes: REPO_FILE_FETCH_MAX_BYTES,
        },
        absent: ['totalLines'],
      },
      {
        name: 'a text file over the 1 MB whole-file limit',
        path: 'big.ts',
        host: { content: () => new Response('x'.repeat(1024 * 1024) + '\nlast', { status: 200 }) },
        expected: {
          outcome: 'too_large',
          path: 'big.ts',
          ref: 'main',
          commitSha: COMMIT,
          limitBytes: 1024 * 1024,
          totalLines: 2,
        },
        providerFound: true,
      },
      {
        name: 'a binary blob',
        path: 'app/apple-icon.png',
        host: { content: () => new Response(new Uint8Array(png()), { status: 200 }) },
        expected: {
          outcome: 'binary',
          path: 'app/apple-icon.png',
          ref: 'main',
          commitSha: COMMIT,
          bytes: png().length,
        },
      },
      {
        name: 'a path traversal',
        path: '../../etc/passwd',
        host: {},
        expected: { outcome: 'invalid_path', path: '../../etc/passwd' },
        reachesHost: false,
      },
      {
        name: 'a transport failure during the content read',
        path: 'lib/x.ts',
        host: {
          content: () => {
            throw new TypeError('fetch failed');
          },
        },
        expected: {
          outcome: 'unreachable',
          path: 'lib/x.ts',
          ref: 'main',
          commitSha: COMMIT,
          failure: 'unreachable',
        },
      },
    ];

    it.each(negatives)('$name carries no blobSha key', async (c) => {
      githubHost(c.host);
      const { token } = await seedConnectedProject();
      const { status, result } = await readVia(token, 'moooon/motir-core', c.path);
      expect(status).toBe(200);
      expect(result).toMatchObject(c.expected);
      expect(result).not.toHaveProperty('blobSha');
      for (const key of c.absent ?? []) expect(result).not.toHaveProperty(key);
      // No arm the PROVIDER answers as non-found asks the host for an id.
      expect(hostRequests.some((r) => r.url.endsWith('/graphql'))).toBe(c.providerFound === true);
      if (c.readsContent === false) {
        expect(hostRequests.some((r) => r.url.includes('/contents/'))).toBe(false);
      }
      if (c.reachesHost === false) expect(hostRequests).toEqual([]);
    });
  });

  describe('GitLab', () => {
    it('a pinned found read answers GitLab’s id for the resolved commit, beside commitSha', async () => {
      gitlabHost();
      const { token } = await seedGitlabRepo();
      const { result } = await readVia(token, 'acme/web', 'src/x.ts');
      expect(result).toEqual({
        outcome: 'found',
        path: 'src/x.ts',
        ref: 'main',
        commitSha: COMMIT,
        text: FILE_TEXT,
        bytes: FILE_TEXT.length,
        blobSha: GL_COMMIT_BLOB,
      });
      expect(result['blobSha']).not.toBe(gitlabIdFor('main'));
      const raw = hostRequests.filter((r) => r.url.includes('/raw?'));
      expect(new URL(raw[0]!.url).searchParams.get('ref')).toBe(COMMIT);
    });

    it('a ranged read carries the same id, and still the whole text', async () => {
      gitlabHost();
      const { token } = await seedGitlabRepo();
      const whole = await readVia(token, 'acme/web', 'src/x.ts');
      const ranged = await readVia(token, 'acme/web', 'src/x.ts', '&startLine=1&endLine=5');
      expect(ranged.result).toMatchObject({ outcome: 'found', text: FILE_TEXT });
      expect(ranged.result['blobSha']).toBe(GL_COMMIT_BLOB);
      expect(ranged.result['blobSha']).toBe(whole.result['blobSha']);
    });

    it('a ref that names no commit is ref_not_found with no blobSha and no content read', async () => {
      gitlabHost({ resolve: () => json({ message: '404 Commit Not Found' }, { status: 404 }) });
      const { token } = await seedGitlabRepo();
      const { result } = await readVia(token, 'acme/web', 'src/x.ts', '&ref=nope');
      expect(result).toEqual({ outcome: 'ref_not_found', path: 'src/x.ts', ref: 'nope' });
      expect(hostRequests.some((r) => r.url.includes('/files/'))).toBe(false);
    });

    it('a 404 path with an empty tree is not_found, and with entries a directory — neither with a blobSha', async () => {
      const notFound = () => json({ message: '404 File Not Found' }, { status: 404 });
      gitlabHost({ content: notFound });
      const { token } = await seedGitlabRepo();
      const missing = await readVia(token, 'acme/web', 'nope.ts');
      expect(missing.result).toEqual({
        outcome: 'not_found',
        path: 'nope.ts',
        ref: 'main',
        commitSha: COMMIT,
      });
      expect(missing.result).not.toHaveProperty('blobSha');

      vi.unstubAllGlobals();
      gitlabHost({
        content: notFound,
        tree: () => [
          { name: 'x.ts', type: 'blob', mode: '100644' },
          { name: 'lib', type: 'tree', mode: '040000' },
        ],
      });
      const dir = await readVia(token, 'acme/web', 'src');
      expect(dir.result).toEqual({
        outcome: 'directory',
        path: 'src',
        ref: 'main',
        commitSha: COMMIT,
        entries: [
          { name: 'lib', type: 'dir' },
          { name: 'x.ts', type: 'file' },
        ],
        truncated: false,
      });
      expect(dir.result).not.toHaveProperty('blobSha');
    });

    it('the payload carries no GitLab token and no Bearer', async () => {
      gitlabHost();
      const { token } = await seedGitlabRepo();
      const { text } = await readVia(token, 'acme/web', 'src/x.ts');
      expect(text).toContain(GL_COMMIT_BLOB);
      for (const leak of ['Bearer', GL_TOKEN, token, 'download_url']) {
        expect(text).not.toContain(leak);
      }
      expect(hostRequests.every((r) => r.signalled)).toBe(true);
    });
  });
});
