import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  _resetRunGitBotAuthors,
  hostedRunWriteAccess,
  mintProjectReadCredentials,
  mintRunGitCredentials,
  revokeInstanceCloneCredential,
  revokeRunGitCredentials,
  runGitAppFor,
  runRepositories,
} from '@/lib/github/runGitCredential';
import {
  HostedRunRepositoryNotWritableError,
  RunGitCredentialUnavailableError,
} from '@/lib/hostedRuns/errors';
import { RunCredentialRunNotLiveError } from '@/lib/dispatchRuns/errors';
import { _resetInstallationTokenCache, mintInstallationToken } from '@/lib/github/appAuth';
import { decryptToken } from '@/lib/github/tokenCrypto';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-683 · MOTIR-6449 — a hosted run's git credentials, against a real
// Postgres (the run, its legs, the project's repositories and the recorded tokens
// are real rows). GitHub is stubbed at the HTTP seam with a global `fetch` mock;
// nothing reaches github.com. The contract is
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md`.

const HOUR = 3_600_000;
const STUDIO_APP_ID = '111';
const INTEGRATION_APP_ID = '222';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const ACCEPTED = { contents: 'write', pull_requests: 'write', metadata: 'read', issues: 'read' };

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string;
}

interface InstallationStub {
  status?: number;
  id?: number;
  account?: string;
  permissions?: Record<string, string>;
  suspended?: boolean;
}

interface GithubStub {
  /** `GET /repos/{owner}/{name}/installation`, by `owner/name`. Default: 200. */
  installation?: Record<string, InstallationStub>;
  revokeStatus?: number;
  revokeThrows?: boolean;
}

/** The App a JWT was signed for, read from its `iss` claim. */
function appIdOf(authorization: string): string {
  const jwt = authorization.replace(/^Bearer /, '');
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
    iss?: string;
  };
  return String(payload.iss);
}

let tokenSeq = 0;

function stubGithub(stub: GithubStub = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body, authorization: headers.authorization ?? '' });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const repo = inst[1] ?? '';
        const s = stub.installation?.[repo] ?? {};
        if ((s.status ?? 200) !== 200) return json(s.status ?? 404, {});
        const owner = repo.split('/')[0];
        return json(200, {
          id: s.id ?? (owner === 'motir-projects' ? 7 : 42),
          account: { login: s.account ?? owner },
          permissions: s.permissions ?? ACCEPTED,
          suspended_at: s.suspended ? '2026-09-01T00:00:00Z' : null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/${s.id ?? 42}`,
        });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
        tokenSeq += 1;
        return json(201, {
          token: `ghs_run_${tokenSeq}`,
          expires_at: new Date(Date.now() + HOUR).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') {
        return json(200, {
          slug:
            appIdOf(headers.authorization ?? '') === STUDIO_APP_ID
              ? 'motir-studio'
              : 'motir-integration',
        });
      }
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') {
        const login = decodeURIComponent(user[1] ?? '');
        return json(200, { id: login === 'motir-studio[bot]' ? 1001 : 2002, login });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        if (stub.revokeThrows) throw new Error('network down');
        return new Response(null, { status: stub.revokeStatus ?? 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
  return calls;
}

let fixture: WorkItemFixture;
let seq = 0;

/** A project repository with (by default) a realized GitHub repository. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
  takeoverState?: 'requested' | 'transfer_pending' | 'awaiting_reinstall' | 'done' | 'failed';
  realized?: boolean;
}): Promise<{ id: string; providerRepoId: number }> {
  seq += 1;
  const organizationId = fixture.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fixture.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${fixture.workspaceId}-${opts.owner}`,
      workspaceId: fixture.workspaceId,
      organizationId,
      accountLogin: opts.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const providerRepoId = 900_000 + seq;
  const mirror =
    opts.realized === false
      ? null
      : await adminDb.githubRepo.create({
          data: {
            installationId: inst.id,
            workspaceId: fixture.workspaceId,
            organizationId,
            repoId: String(providerRepoId),
            owner: opts.owner,
            name: opts.name,
            defaultBranch: 'main',
            archived: false,
            provider: 'github',
          },
        });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      role: 'web',
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      takeoverState: opts.takeoverState ?? null,
      position: `a${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror?.id ?? null,
    },
  });
  return { id: row.id, providerRepoId };
}

/** Open a hosted run over one leg per entry; each leg's card is pinned to the
 *  given project repositories (none = the project's primary). */
async function openRun(legs: string[][]): Promise<string> {
  const items = [];
  for (const [i, repoIds] of legs.entries()) {
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: `a hosted card ${i}` },
      fixture.ctx,
    );
    for (const [position, projectRepoId] of repoIds.entries()) {
      await adminDb.workItemRepo.create({
        data: { workspaceId: fixture.workspaceId, workItemId: item.id, projectRepoId, position },
      });
    }
    items.push(item);
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: items.length > 1 ? 'run_scope' : 'run',
      reportedBy: 'cli',
      origin: 'hosted',
      model: 'claude-opus-5-5',
      cards: items.map((it) => ({ key: it.identifier, disposition: 'queued' as const })),
    },
    fixture.ctx,
  );
  return run.id;
}

const recorded = (runId: string) =>
  adminDb.dispatchRunGitCredential.findMany({
    where: { dispatchRunId: runId },
    orderBy: { createdAt: 'asc' },
  });

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_STUDIO_APP_ID', STUDIO_APP_ID);
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', INTEGRATION_APP_ID);
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
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

describe('which App writes a project repository — keyed off its establish state', () => {
  it('created → motir-studio until a takeover has transferred it; connected → Motir Integration', () => {
    expect(runGitAppFor({ state: 'created', takeoverState: null })).toBe('motir-studio');
    expect(runGitAppFor({ state: 'created', takeoverState: 'failed' })).toBe('motir-studio');
    expect(runGitAppFor({ state: 'created', takeoverState: 'requested' })).toBe('motir-studio');
    expect(runGitAppFor({ state: 'created', takeoverState: 'transfer_pending' })).toBe(
      'motir-studio',
    );
    expect(runGitAppFor({ state: 'created', takeoverState: 'awaiting_reinstall' })).toBe(
      'motir-integration',
    );
    expect(runGitAppFor({ state: 'created', takeoverState: 'done' })).toBe('motir-integration');
    expect(runGitAppFor({ state: 'connected', takeoverState: null })).toBe('motir-integration');
  });
});

describe("the run's repository set", () => {
  it("is the union of every leg's repositories, in project repository order", async () => {
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const studio = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    // Leg 1 names api then web; leg 2 names site and api again.
    const runId = await openRun([
      [api.id, web.id],
      [studio.id, api.id],
    ]);
    expect((await runRepositories(runId)).map((r) => [r.repository, r.app])).toEqual([
      ['acme/web', 'motir-integration'],
      ['acme/api', 'motir-integration'],
      ['motir-projects/site', 'motir-studio'],
    ]);
  });

  it("puts a leg whose card names no repository on the project's primary", async () => {
    await seedRepo({ state: 'connected', owner: 'acme', name: 'primary' });
    const other = await seedRepo({ state: 'connected', owner: 'acme', name: 'other' });
    const runId = await openRun([[], [other.id]]);
    expect((await runRepositories(runId)).map((r) => r.repository)).toEqual([
      'acme/primary',
      'acme/other',
    ]);
  });

  it('refuses a repository with nothing on GitHub yet', async () => {
    const unborn = await seedRepo({
      state: 'created',
      owner: 'motir-projects',
      name: 'unborn',
      realized: false,
    });
    const runId = await openRun([[unborn.id]]);
    await expect(runRepositories(runId)).rejects.toMatchObject({
      reason: 'repository_unrealized',
    });
  });
});

describe('hostedRunWriteAccess — the per-repository check (AC2)', () => {
  it('answers ok for a Motir-created repository without asking GitHub', async () => {
    const calls = stubGithub();
    expect(
      await hostedRunWriteAccess([{ repository: 'motir-projects/site', app: 'motir-studio' }]),
    ).toEqual([{ repository: 'motir-projects/site', app: 'motir-studio', ok: true }]);
    expect(calls).toEqual([]);
  });

  it('refuses a connected repository the installation no longer reaches — reason verbatim', async () => {
    stubGithub({
      installation: { 'acme/gone': { status: 404 }, 'acme/paused': { suspended: true } },
    });
    const out = await hostedRunWriteAccess([
      { repository: 'acme/gone', app: 'motir-integration' },
      { repository: 'acme/paused', app: 'motir-integration' },
    ]);
    expect(out).toEqual([
      {
        repository: 'acme/gone',
        app: 'motir-integration',
        ok: false,
        reason:
          'Motir Integration can no longer reach acme/gone — reconnect it in the Repositories room',
        fix: 'reconnect',
        fixUrl: null,
      },
      {
        repository: 'acme/paused',
        app: 'motir-integration',
        ok: false,
        reason:
          'Motir Integration can no longer reach acme/paused — reconnect it in the Repositories room',
        fix: 'reconnect',
        fixUrl: null,
      },
    ]);
  });

  it('refuses a connected repository whose installation has not accepted write — reason verbatim', async () => {
    stubGithub({
      installation: {
        'acme/web': { account: 'acme', permissions: { contents: 'read', pull_requests: 'write' } },
      },
    });
    expect(
      await hostedRunWriteAccess([{ repository: 'acme/web', app: 'motir-integration' }]),
    ).toEqual([
      {
        repository: 'acme/web',
        app: 'motir-integration',
        ok: false,
        reason:
          "hosted runs on acme/web need Motir Integration's updated permissions — an owner of acme accepts them on GitHub",
        fix: 'accept_permissions',
        fixUrl: 'https://github.com/organizations/acme/settings/installations/42',
      },
    ]);
  });

  it('in a mixed set names the refused repository and only it', async () => {
    stubGithub({ installation: { 'acme/api': { status: 404 } } });
    const out = await hostedRunWriteAccess([
      { repository: 'motir-projects/site', app: 'motir-studio' },
      { repository: 'acme/web', app: 'motir-integration' },
      { repository: 'acme/api', app: 'motir-integration' },
    ]);
    expect(out.filter((r) => !r.ok).map((r) => r.repository)).toEqual(['acme/api']);
    expect(out.filter((r) => r.ok).map((r) => r.repository)).toEqual([
      'motir-projects/site',
      'acme/web',
    ]);
  });

  it('answers not_configured when the App the repository needs is not wired', async () => {
    stubGithub();
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    await expect(
      hostedRunWriteAccess([{ repository: 'motir-projects/site', app: 'motir-studio' }]),
    ).rejects.toMatchObject({ reason: 'not_configured' });
  });
});

describe('mintRunGitCredentials — one uncached token per installation (AC1, AC5)', () => {
  it('asks for exactly the run’s repositories per installation and exactly contents + pull_requests write', async () => {
    const calls = stubGithub();
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const runId = await openRun([[site.id, web.id, api.id]]);

    const entries = await mintRunGitCredentials(runId);

    const mints = calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(mints).toHaveLength(2);
    const studioMint = mints.find((c) => c.url.includes('/installations/7/'));
    const integrationMint = mints.find((c) => c.url.includes('/installations/42/'));
    expect(appIdOf(studioMint!.authorization)).toBe(STUDIO_APP_ID);
    expect(studioMint!.body).toEqual({
      repository_ids: [site.providerRepoId],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(appIdOf(integrationMint!.authorization)).toBe(INTEGRATION_APP_ID);
    expect(integrationMint!.body).toEqual({
      repository_ids: [web.providerRepoId, api.providerRepoId],
      permissions: { contents: 'write', pull_requests: 'write' },
    });

    expect(entries.map((e) => e.repository)).toEqual([
      'motir-projects/site',
      'acme/web',
      'acme/api',
    ]);
    // Repositories in one installation share its token.
    expect(entries[1]!.token).toBe(entries[2]!.token);
    expect(entries[0]!.token).not.toBe(entries[1]!.token);

    // AC5: the author is the bot of the App that writes each repository.
    expect(entries[0]!.author).toEqual({
      name: 'motir-studio[bot]',
      email: '1001+motir-studio[bot]@users.noreply.github.com',
    });
    expect(entries[1]!.author).toEqual({
      name: 'motir-integration[bot]',
      email: '2002+motir-integration[bot]@users.noreply.github.com',
    });

    // Recorded, encrypted, one row per token.
    const rows = await recorded(runId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.app, r.installationId, r.repositories]).sort()).toEqual(
      [
        ['motir-integration', '42', ['acme/web', 'acme/api']],
        ['motir-studio', '7', ['motir-projects/site']],
      ].sort(),
    );
    for (const row of rows) {
      expect(row.tokenEncrypted).not.toContain('ghs_run_');
      expect(decryptToken(row.tokenEncrypted)).toMatch(/^ghs_run_\d+$/);
    }
  });

  it('adds workflows write only for an installation that holds it (AMENDMENT 2026-10-29)', async () => {
    const calls = stubGithub({
      installation: {
        'acme/web': { permissions: { ...ACCEPTED, workflows: 'write' } },
        'beta/api': { id: 43 },
      },
    });
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const api = await seedRepo({ state: 'connected', owner: 'beta', name: 'api' });
    const runId = await openRun([[web.id, api.id]]);

    await mintRunGitCredentials(runId);

    const mints = calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(mints.find((c) => c.url.includes('/installations/42/'))!.body).toEqual({
      repository_ids: [web.providerRepoId],
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
    });
    // Not yet accepted: the run still mints, without asking for what GitHub would refuse.
    expect(mints.find((c) => c.url.includes('/installations/43/'))!.body).toEqual({
      repository_ids: [api.providerRepoId],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });

  it('never serves or fills the appAuth cache, and a second mint records new tokens', async () => {
    const calls = stubGithub();
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);

    const first = await mintRunGitCredentials(runId);
    const second = await mintRunGitCredentials(runId);
    expect(first[0]!.token).not.toBe(second[0]!.token);
    expect(await recorded(runId)).toHaveLength(2);

    // The shared cache was never written: asking it for the same installation mints.
    const before = calls.filter((c) => c.url.endsWith('/access_tokens')).length;
    await mintInstallationToken('42');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens')).length).toBe(before + 1);
    // And the cached token (all permissions, every repository) is not what a run got.
    const cachedCall = calls.filter((c) => c.url.endsWith('/access_tokens')).at(-1);
    expect(cachedCall?.body ?? null).toBeNull();
  });
});

describe('mintRunGitCredentials — refusals record nothing (AC3)', () => {
  it('refuses a run that is no longer running', async () => {
    const calls = stubGithub();
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { status: 'succeeded', endedAt: new Date() },
    });
    await expect(mintRunGitCredentials(runId)).rejects.toBeInstanceOf(RunCredentialRunNotLiveError);
    expect(calls).toEqual([]);
    expect(await recorded(runId)).toHaveLength(0);
  });

  it('refuses a run with a repository its App cannot write, naming every such repository', async () => {
    const calls = stubGithub({
      installation: {
        'acme/api': { status: 404 },
        'acme/docs': { permissions: { contents: 'write', pull_requests: 'read' } },
      },
    });
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const docs = await seedRepo({ state: 'connected', owner: 'acme', name: 'docs' });
    const runId = await openRun([[web.id, api.id, docs.id]]);

    const err = await mintRunGitCredentials(runId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedRunRepositoryNotWritableError);
    expect((err as HostedRunRepositoryNotWritableError).code).toBe(
      'hosted_repository_not_writable',
    );
    expect(
      (err as HostedRunRepositoryNotWritableError).refusals.map((r) => [r.repository, r.fix]),
    ).toEqual([
      ['acme/api', 'reconnect'],
      ['acme/docs', 'accept_permissions'],
    ]);
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toEqual([]);
    expect(await recorded(runId)).toHaveLength(0);
  });

  it('fails operationally (not as a refusal) when motir-studio does not reach its own repository', async () => {
    stubGithub({ installation: { 'motir-projects/site': { status: 404 } } });
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const runId = await openRun([[site.id]]);
    const err = await mintRunGitCredentials(runId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunGitCredentialUnavailableError);
    expect((err as RunGitCredentialUnavailableError).reason).toBe('github_unavailable');
  });

  it("no code path of the run's git credentials reads a person's GitHub token", () => {
    for (const file of [
      'lib/github/runGitCredential.ts',
      'lib/repositories/dispatchRunGitCredentialRepository.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/githubIdentity|GithubIdentity|getUserToken|getLiveToken/);
    }
  });
});

describe('revokeRunGitCredentials (AC4)', () => {
  it('revokes every unexpired token once, deletes the rows, and skips an expired one', async () => {
    const calls = stubGithub();
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[site.id, web.id]]);
    const minted = await mintRunGitCredentials(runId);
    // A third, already-dead token from an earlier mint.
    const [one] = await recorded(runId);
    await adminDb.dispatchRunGitCredential.create({
      data: {
        workspaceId: one!.workspaceId,
        dispatchRunId: runId,
        app: 'motir-integration',
        installationId: '42',
        repositories: ['acme/web'],
        tokenEncrypted: one!.tokenEncrypted,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const results = await revokeRunGitCredentials(runId);
    expect(results.map((r) => r.status).sort()).toEqual(['expired', 'revoked', 'revoked']);
    const deletes = calls.filter((c) => c.url.endsWith('/installation/token'));
    expect(deletes).toHaveLength(2);
    expect(deletes.map((d) => d.authorization).sort()).toEqual(
      [...new Set(minted.map((m) => `token ${m.token}`))].sort(),
    );
    expect(await recorded(runId)).toHaveLength(0);
  });

  it('returns a failed revoke as a typed result, keeps its row, and never throws', async () => {
    stubGithub({ revokeStatus: 500 });
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);
    await mintRunGitCredentials(runId);

    const failed = await revokeRunGitCredentials(runId);
    expect(failed).toMatchObject([{ status: 'failed', detail: 'GitHub answered 500' }]);
    expect(await recorded(runId)).toHaveLength(1);

    stubGithub({ revokeThrows: true });
    await expect(revokeRunGitCredentials(runId)).resolves.toMatchObject([
      { status: 'failed', detail: 'network down' },
    ]);

    // GitHub already considers it dead → revoked, and the row goes.
    stubGithub({ revokeStatus: 401 });
    await expect(revokeRunGitCredentials(runId)).resolves.toMatchObject([{ status: 'revoked' }]);
    expect(await recorded(runId)).toHaveLength(0);
  });

  it('answers an unknown run with no results rather than throwing', async () => {
    stubGithub();
    await expect(revokeRunGitCredentials('no-such-run')).resolves.toEqual([]);
  });
});

// Coverage top-up (MOTIR-692): the operational-failure edges no refusal or
// happy-path scenario above reaches — an unexpected `appJwt` throw, GitHub
// answering something the two reads (`installationOn`, the bot-author reads)
// don't recognise, a project with no repository at all, a mint whose response
// is malformed, and the two DB reads `revokeRunGitCredentials` guards.
describe('coverage top-up — the operational edges', () => {
  it('appJwt rethrows an error that is neither of the two configured shapes', async () => {
    stubGithub();
    const appAuth = await import('@/lib/github/appAuth');
    vi.spyOn(appAuth, 'createAppJwt').mockImplementationOnce(() => {
      throw new Error('a signing bug, not a configuration one');
    });
    await expect(
      hostedRunWriteAccess([{ repository: 'acme/web', app: 'motir-integration' }]),
    ).rejects.toThrow('a signing bug, not a configuration one');
  });

  it('an installation answered with no id is github_unavailable, not a silent pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(JSON.stringify({ account: { login: 'acme' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );
    await expect(
      hostedRunWriteAccess([{ repository: 'acme/web', app: 'motir-integration' }]),
    ).rejects.toMatchObject({ reason: 'github_unavailable' });
  });

  it("the bot author read fails when GitHub's own App answers with no slug, or the bot user with no id", async () => {
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);

    stubGithub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(
            JSON.stringify({
              id: 42,
              account: { login: 'acme' },
              permissions: ACCEPTED,
              suspended_at: null,
              html_url: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
          return new Response(
            JSON.stringify({ token: 'ghs_x', expires_at: new Date().toISOString() }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        // No `slug` — the bot-author read cannot name the login at all.
        if (url.endsWith('/app')) {
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
      }),
    );
    await expect(mintRunGitCredentials(runId)).rejects.toMatchObject({
      reason: 'github_unavailable',
    });

    // Retried after a bad read — a failed bot-author read is never cached — now
    // the App answers a slug but the bot user has no id.
    _resetInstallationTokenCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(
            JSON.stringify({
              id: 42,
              account: { login: 'acme' },
              permissions: ACCEPTED,
              suspended_at: null,
              html_url: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
          return new Response(
            JSON.stringify({ token: 'ghs_y', expires_at: new Date().toISOString() }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (url.endsWith('/app')) {
          return new Response(JSON.stringify({ slug: 'motir-integration' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (/\/users\/.+$/.test(url)) {
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
      }),
    );
    await expect(mintRunGitCredentials(runId)).rejects.toMatchObject({
      reason: 'github_unavailable',
    });
  });

  it('a project with no repository at all refuses the run set as `no_repository`', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: 'no repos here' },
      fixture.ctx,
    );
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'hosted',
        model: 'claude-opus-5-5',
        cards: [{ key: card.identifier, disposition: 'queued' as const }],
      },
      fixture.ctx,
    );
    await expect(runRepositories(run.id)).rejects.toMatchObject({ reason: 'no_repository' });
  });

  it("a mint that fails, or answers a malformed body, refuses the run's git credentials", async () => {
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);

    stubGithub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(
            JSON.stringify({
              id: 42,
              account: { login: 'acme' },
              permissions: ACCEPTED,
              suspended_at: null,
              html_url: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
          return new Response('{}', { status: 502 });
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
      }),
    );
    await expect(mintRunGitCredentials(runId)).rejects.toMatchObject({
      reason: 'github_unavailable',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(
            JSON.stringify({
              id: 42,
              account: { login: 'acme' },
              permissions: ACCEPTED,
              suspended_at: null,
              html_url: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
          // No `token`/`expires_at` — a body the mint cannot use.
          return new Response('{}', {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
      }),
    );
    await expect(mintRunGitCredentials(runId)).rejects.toMatchObject({
      reason: 'github_unavailable',
    });
  });

  it('a run whose recorded tokens cannot be read revokes nothing but never throws', async () => {
    stubGithub();
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);
    await mintRunGitCredentials(runId);

    const { dispatchRunGitCredentialRepository } =
      await import('@/lib/repositories/dispatchRunGitCredentialRepository');
    vi.spyOn(dispatchRunGitCredentialRepository, 'listByRun').mockRejectedValueOnce(
      new Error('the read is down'),
    );
    const result = await revokeRunGitCredentials(runId);
    expect(result).toMatchObject([{ status: 'failed', credentialId: '' }]);
    expect(result[0]?.detail).toContain('the read is down');
    // The row is untouched — a later, healthy call can still revoke it.
    expect(await recorded(runId)).toHaveLength(1);
  });

  it('a run whose own row cannot even be read revokes nothing but never throws', async () => {
    stubGithub();
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const runId = await openRun([[web.id]]);
    await mintRunGitCredentials(runId);

    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    vi.spyOn(dispatchRunRepository, 'findById').mockRejectedValueOnce(new Error('db is down'));
    await expect(revokeRunGitCredentials(runId)).resolves.toEqual([]);
  });
});

// Story MOTIR-6860 · MOTIR-6872 — an agent instance's CLONE credentials: read-only,
// one per installation the project's repositories span, recorded nowhere.
describe('mintProjectReadCredentials — an agent instance’s clone tokens', () => {
  /** Installations answer as usual; the token mint answers `status` with `body`. */
  function stubMint(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
          return new Response(
            JSON.stringify({ id: 42, account: { login: 'acme' }, suspended_at: null }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
      }),
    );
  }

  it('mints ONE read-only token per installation over exactly its repositories, skipping one not on GitHub yet', async () => {
    const web = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const studio = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    await seedRepo({ state: 'connected', owner: 'acme', name: 'pending', realized: false });
    const calls = stubGithub();

    const creds = await mintProjectReadCredentials(fixture.projectId, fixture.workspaceId);

    expect(creds.map((c) => c.repositories)).toEqual([
      ['acme/web', 'acme/api'],
      ['motir-projects/site'],
    ]);
    for (const c of creds) {
      expect(c.token).toMatch(/^ghs_run_\d+$/);
      expect(c.expiresAt).toBeInstanceOf(Date);
    }
    const mints = calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(mints.map((m) => m.body)).toEqual([
      {
        repository_ids: [web.providerRepoId, api.providerRepoId],
        permissions: { contents: 'read' },
      },
      { repository_ids: [studio.providerRepoId], permissions: { contents: 'read' } },
    ]);
    // The Studio-created repository's token comes from motir-studio, the rest from Integration.
    expect(mints.map((m) => appIdOf(m.authorization))).toEqual([INTEGRATION_APP_ID, STUDIO_APP_ID]);
    // Nothing is recorded: an instance's clone credential is revoked, not stored.
    expect(await adminDb.dispatchRunGitCredential.count()).toBe(0);
  });

  it('a project with no repository on GitHub answers no credentials and asks GitHub nothing', async () => {
    await seedRepo({ state: 'connected', owner: 'acme', name: 'pending', realized: false });
    const calls = stubGithub();
    expect(await mintProjectReadCredentials(fixture.projectId, fixture.workspaceId)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an installation that is gone or suspended refuses, naming the repository', async () => {
    await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    stubGithub({ installation: { 'acme/web': { status: 404 } } });
    await expect(
      mintProjectReadCredentials(fixture.projectId, fixture.workspaceId),
    ).rejects.toMatchObject({
      reason: 'github_unavailable',
      message: expect.stringContaining('acme/web'),
    });

    stubGithub({ installation: { 'acme/web': { suspended: true } } });
    await expect(
      mintProjectReadCredentials(fixture.projectId, fixture.workspaceId),
    ).rejects.toBeInstanceOf(RunGitCredentialUnavailableError);
  });

  it('a mint GitHub refuses, or answers with an unusable body, is github_unavailable', async () => {
    await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    stubMint(502, {});
    await expect(
      mintProjectReadCredentials(fixture.projectId, fixture.workspaceId),
    ).rejects.toMatchObject({
      reason: 'github_unavailable',
      message: expect.stringContaining('502'),
    });

    stubMint(201, { token: 'ghs_x' });
    await expect(
      mintProjectReadCredentials(fixture.projectId, fixture.workspaceId),
    ).rejects.toMatchObject({ reason: 'github_unavailable' });
  });
});

describe('revokeInstanceCloneCredential — best-effort, never throws', () => {
  it('counts 204, 401 and 404 as revoked, and a 5xx or a network failure as not', async () => {
    for (const [revokeStatus, revoked] of [
      [204, true],
      [401, true],
      [404, true],
      [500, false],
    ] as const) {
      const calls = stubGithub({ revokeStatus });
      expect(await revokeInstanceCloneCredential('ghs_clone')).toBe(revoked);
      expect(calls[0]).toMatchObject({ method: 'DELETE', authorization: 'token ghs_clone' });
    }
    stubGithub({ revokeThrows: true });
    expect(await revokeInstanceCloneCredential('ghs_clone')).toBe(false);
  });
});
