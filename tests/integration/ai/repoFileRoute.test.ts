import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { GET } from '@/app/api/internal/ai/repo-file/route';
import { splitRepoRef } from '@/lib/services/repoFileReadService';
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
