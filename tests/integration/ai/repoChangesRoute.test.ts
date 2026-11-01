import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { getGitProvider } from '@/lib/git';
import {
  CHANGED_FILES_CACHE_MAX,
  _resetChangedFilesCache,
} from '@/lib/services/repoChangesService';
import type { ChangedFilesResult } from '@/lib/git/types';
import { GET } from '@/app/api/internal/ai/repo-changes/route';
import { createTestWorkspace, createTestProject } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkProjectRepo } from '../../helpers/projectRepoLink';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-6619 — the repo-changes READ-BACK route end-to-end through the REAL
// route handler, against a real Postgres: both §4 grants, the 400s, the project
// set the repository must belong to, the default base, and the credential rule.
//
// ⚠️ THE OUT-OF-SET ASSERTION IS THE POINT. A repository outside the job's
// project set is a 404, and the provider is NEVER asked about it — asserted
// with a provider double that fails the test if invoked, not inferred from the
// status code (a 404 after a host call would pass a status-only assertion).

const SERVICE_SECRET = 'core-callback-secret-test';
const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  // Deliberately NOT `main`: the default base must be the MIRRORED column, and a
  // hard-coded `main` somewhere would pass a test that used it.
  defaultBranch: 'trunk',
  archived: false,
};
const OTHER_REPO: NormalizedRepo = { ...REPO, providerRepoId: '222', name: 'motir-ai' };
const HEAD_SHA = '0328041d1152db8ae77652d1618a02e57f745f17';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  _resetInstallationTokenCache();
  _resetChangedFilesCache();
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

function stubGithub(compareReply: () => Response) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    if (String(url).endsWith('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_route_secret',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (String(url).includes('/compare/')) return compareReply();
    return new Response('nf', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function compareOk(): Response {
  return new Response(
    JSON.stringify({
      base_commit: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
      merge_base_commit: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
      commits: [{ sha: HEAD_SHA }],
      files: [
        { filename: 'lib/a.ts', status: 'modified', patch: '@@ hunk' },
        {
          filename: 'lib/b.ts',
          status: 'added',
          contents_url: `https://api.github.com/repos/moooon/motir-core/contents/lib/b.ts?ref=${HEAD_SHA}`,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A workspace + project with BOTH repos connected to the organisation, and only
 *  `motir-core` in the project's set. */
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

/** Spy on the REAL registered provider's method — the object `getGitProvider`
 *  hands the service — so a call reaching it is observed, not inferred. */
function providerDouble(onCall: () => void = () => undefined) {
  const github = getGitProvider('github');
  const real = github.listChangedFiles.bind(github);
  return vi.spyOn(github, 'listChangedFiles').mockImplementation(async (...args) => {
    onCall();
    return real(...args);
  });
}

describe('GET /api/internal/ai/repo-changes — read-back auth', () => {
  it('rejects a missing/wrong service bearer with 401', async () => {
    const res = await GET(req('/api/internal/ai/repo-changes?repoRef=a/b&head=x', { token: 'x' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'service_unauthorized' });
  });

  it('rejects a missing/tampered job token with 401', async () => {
    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=a/b&head=x', { bearer: SERVICE_SECRET }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'token_invalid' });

    const tampered = await GET(
      req('/api/internal/ai/repo-changes?repoRef=a/b&head=x', {
        bearer: SERVICE_SECRET,
        token: 'not-a-real-token',
      }),
    );
    expect(tampered.status).toBe(401);
  });
});

describe('GET /api/internal/ai/repo-changes — validation', () => {
  it('400 when repoRef or head is missing', async () => {
    const { token } = await seed();
    const noRepo = await GET(
      req('/api/internal/ai/repo-changes?head=feat%2Fx', { bearer: SERVICE_SECRET, token }),
    );
    expect(noRepo.status).toBe(400);
    const noHead = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-core', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(noHead.status).toBe(400);
  });
});

describe('GET /api/internal/ai/repo-changes — the job’s project set', () => {
  it('404s a repository outside the project set, and never calls the provider', async () => {
    const fetchMock = stubGithub(compareOk);
    const { token } = await seed();
    const double = providerDouble(() => {
      expect.unreachable('the provider must not be called for a repository outside the set');
    });

    // Connected to the organisation, but not in this project's set.
    const connectedElsewhere = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-ai&head=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    // Not connected anywhere.
    const nobodys = await GET(
      req('/api/internal/ai/repo-changes?repoRef=nobody/at-all&head=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );

    expect(connectedElsewhere.status).toBe(404);
    expect(nobodys.status).toBe(404);
    // Indistinguishable: no existence leak between the two.
    expect((await connectedElsewhere.json()).code).toBe('REPO_NOT_IN_PROJECT');
    expect((await nobodys.json()).code).toBe('REPO_NOT_IN_PROJECT');
    expect(double).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s a repository in ANOTHER project’s set of the same workspace', async () => {
    stubGithub(compareOk);
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
    const double = providerDouble(() => {
      expect.unreachable('the provider must not be called for another project’s repository');
    });

    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-ai&head=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(404);
    expect(double).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/ai/repo-changes — an in-set repository', () => {
  it('omitting base compares against the MIRRORED default branch', async () => {
    const fetchMock = stubGithub(compareOk);
    const { token } = await seed();
    const double = providerDouble();

    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-core&head=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        outcome: 'ok',
        base: 'trunk',
        head: 'feat/x',
        files: [
          { path: 'lib/a.ts', status: 'modified' },
          { path: 'lib/b.ts', status: 'added' },
        ],
        truncated: false,
        baseSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
        headSha: HEAD_SHA,
      },
    });
    expect(double).toHaveBeenCalledWith('inst-1', 'moooon', 'motir-core', 'trunk', 'feat/x');
    const compareUrl = fetchMock.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes('/compare/'));
    expect(compareUrl).toBe(
      'https://api.github.com/repos/moooon/motir-core/compare/trunk...feat%2Fx',
    );
  });

  it('honours an explicit base', async () => {
    stubGithub(compareOk);
    const { token } = await seed();
    const double = providerDouble();
    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-core&head=feat%2Fx&base=release', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(await res.json()).toMatchObject({ result: { outcome: 'ok', base: 'release' } });
    expect(double).toHaveBeenCalledWith('inst-1', 'moooon', 'motir-core', 'release', 'feat/x');
  });

  // A NAMED OUTCOME AT 200, `repo-file`'s rule — a 404 here would be
  // indistinguishable from the out-of-set 404 above.
  it('answers 200 with no_such_ref for a head that does not exist', async () => {
    stubGithub(() => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const { token } = await seed();
    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-core&head=nope', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { outcome: 'no_such_ref', base: 'trunk', head: 'nope' },
    });
  });

  // ⚠️ OVER THE SERIALIZED PAYLOAD, not the parsed object.
  it('emits no token, and no URL carrying one, in the response body', async () => {
    stubGithub(compareOk);
    const { token } = await seed();
    const res = await GET(
      req('/api/internal/ai/repo-changes?repoRef=moooon/motir-core&head=feat%2Fx', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    const body = await res.text();
    expect(body).not.toContain('ghs_route_secret');
    expect(body).not.toContain('Bearer');
    expect(body).not.toContain('http');
    expect(body).not.toContain('contents_url');
    expect(body).not.toContain('@@ hunk');
    expect(body).not.toContain(SERVICE_SECRET);
    expect(body).not.toContain(token);
  });
});

describe('GET /api/internal/ai/repo-changes — the commit-pair cache (MOTIR-10094)', () => {
  const BASE = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
  const sha = (n: number) => n.toString(16).padStart(40, '0');

  /** The provider's compare, counted, answering `answer` — no host is reached. */
  function counted(answer: (base: string, head: string) => ChangedFilesResult) {
    const github = getGitProvider('github');
    return vi
      .spyOn(github, 'listChangedFiles')
      .mockImplementation(async (_i, _o, _n, base, head) => answer(base, head));
  }
  const ok = (base: string, head: string): ChangedFilesResult => ({
    outcome: 'ok',
    base,
    head,
    files: [{ path: 'lib/a.ts', status: 'added' }],
    truncated: false,
    baseSha: base,
    headSha: head,
  });
  const get = (token: string, base: string, head: string) =>
    GET(
      req(`/api/internal/ai/repo-changes?repoRef=moooon/motir-core&head=${head}&base=${base}`, {
        bearer: SERVICE_SECRET,
        token,
      }),
    );

  it('a pair of full shas is compared ONCE; the second ask is the same answer from the cache', async () => {
    const { token } = await seed();
    const compare = counted(ok);
    const first = await (await get(token, BASE, HEAD_SHA)).json();
    const second = await (await get(token, BASE.toUpperCase(), HEAD_SHA)).json();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ result: { outcome: 'ok', files: [{ path: 'lib/a.ts' }] } });
  });

  it('a branch NAME is never cached — it moves', async () => {
    const { token } = await seed();
    const compare = counted(ok);
    await get(token, 'trunk', HEAD_SHA);
    await get(token, 'trunk', HEAD_SHA);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('too_large is kept; a failure to ASK is not', async () => {
    const { token } = await seed();
    const large = counted((base, head) => ({ outcome: 'too_large', base, head }));
    await get(token, BASE, HEAD_SHA);
    await get(token, BASE, HEAD_SHA);
    expect(large).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    const failing = counted((base, head) => ({ outcome: 'host_error', base, head, detail: 'x' }));
    await get(token, BASE, sha(7));
    await get(token, BASE, sha(7));
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most ${CHANGED_FILES_CACHE_MAX} pairs, dropping the oldest first`, async () => {
    const { token } = await seed();
    const compare = counted(ok);
    for (let i = 1; i <= CHANGED_FILES_CACHE_MAX + 1; i += 1) await get(token, BASE, sha(i));
    expect(compare).toHaveBeenCalledTimes(CHANGED_FILES_CACHE_MAX + 1);
    // The newest is still kept; the first one asked was dropped to make room.
    await get(token, BASE, sha(CHANGED_FILES_CACHE_MAX + 1));
    expect(compare).toHaveBeenCalledTimes(CHANGED_FILES_CACHE_MAX + 1);
    await get(token, BASE, sha(1));
    expect(compare).toHaveBeenCalledTimes(CHANGED_FILES_CACHE_MAX + 2);
  }, 120_000);
});
