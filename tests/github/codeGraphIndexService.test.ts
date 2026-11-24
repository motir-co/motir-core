import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 7.5 · MOTIR-1500 — the code-graph index service, the producer half. Real
// Postgres (the motir-core convention): seed an installation + workspace + N
// projects, stub the GitHub tarball fetch (global `fetch`), and spy the motir-ai
// boundary. Asserts the workspace→projects fan-out this service resolves.
//
// ⚠️ IT IS A READ-ONLY SERVICE NOW (MOTIR-2057). MOTIR-1974 split it into
// `resolveIndexTarget` (reads) + `indexRepoIntoProject` (ONE project's fetch +
// upload); the second half is DELETED, because both code-graph jobs build in a
// fleet container and the in-function bytes path is exactly what failed ~68% of
// `motir-core`'s refreshes. So the stubbed `fetch` and the motir-ai spy below are
// kept as TRIPWIRES — they must record nothing — and the dispatch shape both jobs
// now share lives in `tests/jobs/code-graph-index.test.ts`.

const PASSWORD = 'hunter2hunter2';
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xaa, 0xbb]);

function stubGithubTarball(): ReturnType<typeof vi.fn> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_x',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/tarball/')) return new Response(TARBALL, { status: 200 });
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(async () => {
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

describe('codeGraphIndexService — resolve, then index one project per step', () => {
  it('resolves every project of the workspace, and indexes the tarball into each', async () => {
    const user = await usersService.createUser({
      email: 'cg-svc@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const projectA = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Alpha',
      identifier: 'ALPHA',
    });
    const projectB = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Beta',
      identifier: 'BETAX',
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-cg',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '555',
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    const fetchMock = stubGithubTarball();

    const input = {
      installationId: 'inst-cg',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
      archived: false,
    };

    // Phase 1 — reads only. It touches NO network (this is what makes it cheap
    // to replay at every later step boundary).
    const target = await codeGraphIndexService.resolveIndexTarget(input);
    expect(target).toEqual({
      indexed: true,
      repoRef: 'moooon/acme',
      providerId: 'github',
      organizationId: workspace.organizationId,
      // ⚠️ ONE ANCHOR, NOT A LIST (MOTIR-4652 · Story MOTIR-4642). This used to be
      // `projectIds: [projectA.id, projectB.id]` — the fan-out's work list, one
      // container per entry, N byte-identical graphs. The graph is keyed to the
      // ORGANISATION now, so the projects are not what is being indexed; exactly
      // one of them is still named, and only to resolve the run credential
      // motir-ai mints per project. Asserted as "one of the workspace's" rather
      // than as `projectA.id`, because WHICH one is not a contract.
      anchorProjectId: expect.any(String),
    });
    expect(target.indexed && [projectA.id, projectB.id]).toContain(
      target.indexed && target.anchorProjectId,
    );
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);

    // ⚠️ AND THERE IS NO PHASE 2 IN THIS SERVICE ANY MORE (MOTIR-2057). It owned
    // `indexRepoIntoProject` — one project's tarball fetch + bytes upload — which
    // BOTH jobs used to drive and which only `system.code-graph-refresh` was
    // still on after MOTIR-2027. That method is deleted, and this assertion is
    // what keeps it deleted: a service that can pull a repo into the function is
    // one import away from re-creating the 180 s-bounded path that failed ~68% of
    // `motir-core`'s refreshes. Building is handed off to motir-codegraph
    // (`lib/jobs/indexHandoffSteps.ts`, MOTIR-11883).
    expect('indexRepoIntoProject' in codeGraphIndexService).toBe(false);
    // The upload it used to drive is gone too (MOTIR-2138), so "never called"
    // has become "cannot be called" — there is no byte-upload method left on the
    // motir-ai client for a future phase 2 to reach for.
    expect((motirAiClient as unknown as Record<string, unknown>)['indexCodeGraph']).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);
  });

  it('no-ops cleanly when the workspace has no projects', async () => {
    const user = await usersService.createUser({
      email: 'cg-empty@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Empty',
      ownerUserId: user.id,
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-empty', accountLogin: 'moooon', accountType: 'User' },
      repos: [
        { providerRepoId: '1', owner: 'moooon', name: 'r', defaultBranch: 'main', archived: false },
      ],
    });

    // Auto-created workspaces may seed a default project; remove any so the
    // "no projects" branch is exercised deterministically.
    await adminDb.project.deleteMany({ where: { workspaceId: workspace.id } });

    const fetchMock = stubGithubTarball();

    const res = await codeGraphIndexService.resolveIndexTarget({
      installationId: 'inst-empty',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });

    expect(res).toEqual({ indexed: false, reason: 'no_projects' });
    // Never fetched a tarball, and there is no motir-ai upload left to call
    // (MOTIR-2138).
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);
    expect((motirAiClient as unknown as Record<string, unknown>)['indexCodeGraph']).toBeUndefined();
  });

  it('no-ops when the installation is gone', async () => {
    const res = await codeGraphIndexService.resolveIndexTarget({
      installationId: 'inst-nope',
      workspaceId: 'ws-gone',
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });
    expect(res).toEqual({ indexed: false, reason: 'installation_missing' });
  });

  it('refuses a provider that cannot resolve a pre-signed tarball URL (MOTIR-2124)', async () => {
    // ⚠️ THE UNIT-LEVEL HALF of the dispatch regression in
    // `tests/jobs/code-graph-index.test.ts`. The fleet hands a container a URL and
    // no host credential, so a provider with no `resolveRepoTarballUrl` can never
    // index — GitLab's archive endpoint serves bytes and never redirects to a
    // self-authorizing URL, so it has none. Before this gate the fact surfaced as
    // a THROW at `bootIndexContainer`, i.e. five retries and a dead-letter per
    // trigger; the verdict is what makes it terminal, legible and free.
    const user = await usersService.createUser({
      email: 'gitlab-cannot-index@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Gitlab',
      ownerUserId: user.id,
    });
    // The workspace needs a project: the three tenant verdicts are checked
    // BEFORE the capability gate (a vanished tenant is a truer description of
    // that run than "the host cannot index"), so an empty workspace would
    // short-circuit to `no_projects` and prove nothing about the provider.
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Gitlab P',
      identifier: 'PRJGL',
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-gitlab',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        { providerRepoId: '9', owner: 'moooon', name: 'r', defaultBranch: 'main', archived: false },
      ],
    });
    // How a GitLab connection is really stored: the same entity under a different
    // discriminator (`gitlabConnectionService` writes `provider: 'gitlab'`).
    await adminDb.githubInstallation.update({
      where: { installationId: 'inst-gitlab' },
      data: { provider: 'gitlab' },
    });

    const res = await codeGraphIndexService.resolveIndexTarget({
      installationId: 'inst-gitlab',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });

    expect(res).toEqual({ indexed: false, reason: 'provider_cannot_index' });
    // The verdict carries NO repoRef — a repo nothing indexed must never look
    // indexed to `listSucceededCodeGraphIndexRepoRefs` (§6).
    expect(res).not.toHaveProperty('repoRef');
  });

  it('an UNREGISTERED provider collapses into the same verdict, never a throw', async () => {
    // `getGitProvider` throws on an unknown id, and this step's shipped contract
    // is that it never throws (the vanished-tenant verdicts have to reach the
    // ledger). A provider nothing registered is also the strongest possible case
    // of "cannot be indexed", so it belongs in the same arm rather than crashing
    // the run.
    const user = await usersService.createUser({
      email: 'unknown-provider@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Unknown',
      ownerUserId: user.id,
    });
    // The workspace needs a project: the three tenant verdicts are checked
    // BEFORE the capability gate (a vanished tenant is a truer description of
    // that run than "the host cannot index"), so an empty workspace would
    // short-circuit to `no_projects` and prove nothing about the provider.
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Unknown P',
      identifier: 'PRJUN',
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-unknown',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '11',
          owner: 'moooon',
          name: 'r',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await adminDb.githubInstallation.update({
      where: { installationId: 'inst-unknown' },
      data: { provider: 'bitbucket' },
    });

    await expect(
      codeGraphIndexService.resolveIndexTarget({
        installationId: 'inst-unknown',
        workspaceId: workspace.id,
        repoOwner: 'moooon',
        repoName: 'r',
        defaultBranch: 'main',
      }),
    ).resolves.toEqual({ indexed: false, reason: 'provider_cannot_index' });
  });
});
