import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { getGitProvider } from '@/lib/git';
import { GET } from '@/app/api/internal/ai/repo-history/route';
import { repoHistoryService } from '@/lib/services/repoHistoryService';
import { createTestWorkspace, createTestProject } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkProjectRepo } from '../../helpers/projectRepoLink';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-10237 — the code-history READ-BACK route end-to-end through the REAL route
// handler, against a real Postgres: both §4 grants, the 400s, the project set the
// repository must belong to (asserted with a provider double that fails the test
// if invoked), the default ref, the named outcomes, and the credential rule over
// the SERIALIZED payload.

const SERVICE_SECRET = 'core-callback-secret-test';
const GH_TOKEN = 'ghs_history_route_secret';
const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  // NOT `main`: the default ref must be the MIRRORED column.
  defaultBranch: 'trunk',
  archived: false,
};
const OTHER_REPO: NormalizedRepo = { ...REPO, providerRepoId: '222', name: 'motir-ai' };
const SHA = '0328041d1152db8ae77652d1618a02e57f745f17';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  _resetInstallationTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubGithub(hostReply: (url: string) => Response) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    if (String(url).endsWith('/access_tokens')) {
      return json({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return hostReply(String(url));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const logOk = () =>
  json([
    {
      sha: SHA,
      html_url: `https://github.com/moooon/motir-core/commit/${SHA}`,
      commit: {
        author: { name: 'Ada', date: '2026-10-01T10:00:00Z' },
        message: 'fix: the thing\n\nbody',
      },
      files: [{ filename: 'lib/a.ts', patch: '@@ hunk' }],
    },
  ]);

async function seed() {
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
    repos: [REPO, OTHER_REPO],
  });
  const mirrored = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, name: REPO.name },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: mirrored.id,
    name: REPO.name,
  });
  const token = mintJobToken({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { token, workspace, owner };
}

function providerDouble(onCall: () => void = () => undefined) {
  const github = getGitProvider('github');
  const real = github.readCodeHistory.bind(github);
  return vi.spyOn(github, 'readCodeHistory').mockImplementation(async (...args) => {
    onCall();
    return real(...args);
  });
}

const URL_BASE = '/api/internal/ai/repo-history';

describe('GET /api/internal/ai/repo-history — read-back auth', () => {
  it('rejects a missing service bearer and a missing / tampered job token with 401', async () => {
    const q = `${URL_BASE}?repoRef=a/b&path=x&kind=log`;
    const noBearer = await GET(req(q, { token: 'x' }));
    expect(noBearer.status).toBe(401);
    expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });
    const noToken = await GET(req(q, { bearer: SERVICE_SECRET }));
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toMatchObject({ code: 'token_invalid' });
    const tampered = await GET(req(q, { bearer: SERVICE_SECRET, token: 'not-a-real-token' }));
    expect(tampered.status).toBe(401);
  });
});

describe('GET /api/internal/ai/repo-history — validation', () => {
  it('400 for a missing repoRef, a missing path, and a missing or unknown kind', async () => {
    const { token } = await seed();
    const auth = { bearer: SERVICE_SECRET, token };
    for (const q of [
      '?path=x&kind=log',
      '?repoRef=moooon/motir-core&kind=log',
      '?repoRef=moooon/motir-core&path=%20&kind=log',
      '?repoRef=moooon/motir-core&path=x',
      '?repoRef=moooon/motir-core&path=x&kind=diff',
    ]) {
      const res = await GET(req(`${URL_BASE}${q}`, auth));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'validation_error' });
    }
  });
});

describe('GET /api/internal/ai/repo-history — the job’s project set', () => {
  it('404s a repository outside the set, connected or not, and never calls the provider', async () => {
    const fetchMock = stubGithub(logOk);
    const { token } = await seed();
    const double = providerDouble(() => {
      expect.unreachable('the provider must not be called for a repository outside the set');
    });
    const auth = { bearer: SERVICE_SECRET, token };
    const elsewhere = await GET(req(`${URL_BASE}?repoRef=moooon/motir-ai&path=x&kind=log`, auth));
    const nobodys = await GET(req(`${URL_BASE}?repoRef=nobody/at-all&path=x&kind=blame`, auth));
    expect(elsewhere.status).toBe(404);
    expect(nobodys.status).toBe(404);
    expect((await elsewhere.json()).code).toBe('REPO_NOT_IN_PROJECT');
    expect((await nobodys.json()).code).toBe('REPO_NOT_IN_PROJECT');
    expect(double).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s a repository in ANOTHER project’s set, and one in ANOTHER workspace', async () => {
    stubGithub(logOk);
    const { token, workspace, owner } = await seed();
    const other = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      identifier: 'OTHR',
      name: 'Other',
    });
    const aiRepo = await adminDb.githubRepo.findFirstOrThrow({
      where: { workspaceId: workspace.id, name: OTHER_REPO.name },
    });
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: other.id,
      githubRepoId: aiRepo.id,
      name: OTHER_REPO.name,
    });

    // Another tenant connects and links its own repository.
    const { workspace: ws2, owner: owner2 } = await createTestWorkspace({ name: 'Rival' });
    const p2 = await createTestProject({
      workspaceId: ws2.id,
      actorUserId: owner2.id,
      identifier: 'RIVL',
      name: 'Rival',
    });
    const rivalRepo: NormalizedRepo = {
      ...REPO,
      providerRepoId: '333',
      owner: 'rival',
      name: 'secret',
    };
    await githubInstallationService.persistInstallation({
      workspaceId: ws2.id,
      installation: { installationId: 'inst-2', accountLogin: 'rival', accountType: 'User' },
      repos: [rivalRepo],
    });
    const mirrored2 = await adminDb.githubRepo.findFirstOrThrow({
      where: { workspaceId: ws2.id, name: 'secret' },
    });
    await linkProjectRepo({
      workspaceId: ws2.id,
      projectId: p2.id,
      githubRepoId: mirrored2.id,
      name: 'secret',
    });

    const double = providerDouble(() => {
      expect.unreachable('the provider must not be called outside the job’s project set');
    });
    const auth = { bearer: SERVICE_SECRET, token };
    const sibling = await GET(req(`${URL_BASE}?repoRef=moooon/motir-ai&path=x&kind=log`, auth));
    const tenant = await GET(req(`${URL_BASE}?repoRef=rival/secret&path=x&kind=log`, auth));
    expect(sibling.status).toBe(404);
    expect(tenant.status).toBe(404);
    expect(double).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/ai/repo-history — an in-set repository', () => {
  it('omitting ref reads at the MIRRORED default branch', async () => {
    const fetchMock = stubGithub(logOk);
    const { token } = await seed();
    const double = providerDouble();
    const res = await GET(
      req(`${URL_BASE}?repoRef=moooon/motir-core&path=lib%2Fa.ts&kind=log`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        outcome: 'ok',
        kind: 'log',
        path: 'lib/a.ts',
        ref: 'trunk',
        commits: [
          { sha: SHA, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'fix: the thing' },
        ],
        truncated: false,
      },
    });
    expect(double).toHaveBeenCalledWith(
      'inst-1',
      'moooon',
      'motir-core',
      'log',
      'lib/a.ts',
      'trunk',
    );
    const hostUrl = fetchMock.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes('/commits?'));
    expect(hostUrl).toBe(
      'https://api.github.com/repos/moooon/motir-core/commits?sha=trunk&path=lib%2Fa.ts&per_page=100',
    );
  });

  it('honours an explicit ref and answers blame', async () => {
    stubGithub(() =>
      json({
        data: {
          repository: {
            object: {
              __typename: 'Commit',
              blame: {
                ranges: [
                  {
                    startingLine: 1,
                    endingLine: 3,
                    commit: {
                      oid: SHA,
                      authoredDate: '2026-09-01T00:00:00Z',
                      messageHeadline: 'feat: x',
                      author: { name: 'Bo' },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const { token } = await seed();
    const double = providerDouble();
    const res = await GET(
      req(`${URL_BASE}?repoRef=moooon/motir-core&path=lib%2Fa.ts&kind=blame&ref=release`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await res.json()).toMatchObject({
      result: {
        outcome: 'ok',
        kind: 'blame',
        ref: 'release',
        blame: [{ startLine: 1, endLine: 3, sha: SHA }],
      },
    });
    expect(double).toHaveBeenCalledWith(
      'inst-1',
      'moooon',
      'motir-core',
      'blame',
      'lib/a.ts',
      'release',
    );
  });

  it('answers every miss as a NAMED outcome at 200', async () => {
    const { token } = await seed();
    const auth = { bearer: SERVICE_SECRET, token };
    const get = (q: string) => GET(req(`${URL_BASE}?repoRef=moooon/motir-core&${q}`, auth));

    stubGithub(() => json({ message: 'No commit found' }, 404));
    let res = await get('path=lib%2Fa.ts&kind=log&ref=nope');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { outcome: 'no_such_ref', kind: 'log', path: 'lib/a.ts', ref: 'nope' },
    });

    stubGithub(() => json([]));
    res = await get('path=lib%2Fgone.ts&kind=log');
    expect((await res.json()).result.outcome).toBe('path_not_found');

    stubGithub(() => json({ message: 'Bad credentials' }, 401));
    res = await get('path=lib%2Fa.ts&kind=log');
    expect((await res.json()).result.outcome).toBe('revoked');

    stubGithub(() => new Response('bad gateway', { status: 502 }));
    res = await get('path=lib%2Fa.ts&kind=log');
    expect((await res.json()).result).toMatchObject({ outcome: 'host_error' });

    const double = providerDouble(() => {
      expect.unreachable('an invalid path is refused before any provider call');
    });
    res = await get('path=..%2Fetc%2Fpasswd&kind=log');
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ outcome: 'invalid_path', ref: 'trunk' });
    expect(double).not.toHaveBeenCalled();
  });

  it('a provider that throws is host_error, not a 500', async () => {
    const { token } = await seed();
    vi.spyOn(getGitProvider('github'), 'readCodeHistory').mockRejectedValueOnce(
      new Error('kaboom'),
    );
    const res = await GET(
      req(`${URL_BASE}?repoRef=moooon/motir-core&path=lib%2Fa.ts&kind=log`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ outcome: 'host_error', detail: 'kaboom' });
  });

  // ⚠️ OVER THE SERIALIZED PAYLOAD, not the parsed object.
  it('emits no token, no URL and no file content in the response body', async () => {
    stubGithub(logOk);
    const { token } = await seed();
    const res = await GET(
      req(`${URL_BASE}?repoRef=moooon/motir-core&path=lib%2Fa.ts&kind=log`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    const body = await res.text();
    expect(body).not.toContain(GH_TOKEN);
    expect(body).not.toContain('Bearer');
    expect(body).not.toContain('http');
    expect(body).not.toContain('@@ hunk');
    expect(body).not.toContain(SERVICE_SECRET);
    expect(body).not.toContain(token);
  });
});

describe('GET /api/internal/ai/repo-history — an unexpected failure', () => {
  it('a service failure that is not the out-of-set refusal is rethrown', async () => {
    const { token } = await seed();
    vi.spyOn(repoHistoryService, 'readHistory').mockRejectedValueOnce(new Error('db down'));
    await expect(
      GET(
        req(`${URL_BASE}?repoRef=moooon/motir-core&path=a.ts&kind=log`, {
          bearer: SERVICE_SECRET,
          token,
        }),
      ),
    ).rejects.toThrow('db down');
  });

  it('a provider that throws a non-Error is host_error "unknown"', async () => {
    const { token } = await seed();
    vi.spyOn(getGitProvider('github'), 'readCodeHistory').mockRejectedValueOnce('weird');
    const res = await GET(
      req(`${URL_BASE}?repoRef=moooon/motir-core&path=a.ts&kind=log`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect((await res.json()).result).toMatchObject({ outcome: 'host_error', detail: 'unknown' });
  });
});
