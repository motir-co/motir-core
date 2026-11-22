import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';

// Story 7.10 · MOTIR-891 — the installation grant service, against a real
// Postgres (the motir-core convention). Installation rows are workspace-scoped;
// the write path runs under system context (the webhook), the reads under
// workspace context.

const PASSWORD = 'hunter2hunter2';

const REPO_A: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};
const REPO_B: NormalizedRepo = {
  providerRepoId: '222',
  owner: 'moooon',
  name: 'motir-ai',
  defaultBranch: 'main',
  archived: false,
};

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** Run `fn` as the non-bypass `motir_app` role with both GUCs bound — the role
 *  switch is what makes the workspace RLS policy actually bite. */
async function asAppRole<T>(
  ctx: { userId: string; workspaceId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
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

describe('githubInstallationService.persistInstallation + getWorkspaceInstallation', () => {
  it('persists an installation + its selected repos and reads them back token-free', async () => {
    const { user, workspace } = await makeWorkspace('a@example.com');

    const written = await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A, REPO_B],
    });
    expect(written).toMatchObject({
      provider: 'github',
      installationId: 'inst-1',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    expect(written.repos).toHaveLength(2);
    // No token in the DTO in any form.
    expect(written).not.toHaveProperty('token');
    expect(written).not.toHaveProperty('accessToken');

    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.installationId).toBe('inst-1');
    expect(read?.repos.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
  });

  it('reconciles the selected-repo set on re-persist (drops a de-selected repo)', async () => {
    const { user, workspace } = await makeWorkspace('b@example.com');

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-2',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A, REPO_B],
    });
    // Re-install with only REPO_A selected.
    const second = await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-2',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A],
    });
    expect(second.repos.map((r) => r.repoId)).toEqual(['111']);

    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.repos).toHaveLength(1);
    expect(read?.repos[0]?.name).toBe('motir-core');
  });

  it('returns null when the workspace has no installation (the two grants are independent)', async () => {
    // A workspace/member with NO installation reads null — no identity is
    // required, and no crash. (The identity grant is a separate table this
    // service never touches.)
    const { user, workspace } = await makeWorkspace('c@example.com');
    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read).toBeNull();
  });
});

describe('githubInstallationService.mintAccessTokenForWorkspace', () => {
  it('mints a token THROUGH the provider seam for the workspace installation', async () => {
    const { publicKey: _pub, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    void _pub;
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    const fetchMock = vi.fn(
      async (_url: string): Promise<Response> =>
        new Response(
          JSON.stringify({
            token: 'ghs_scoped',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { user, workspace } = await makeWorkspace('d@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-9', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A],
    });

    const tok = await githubInstallationService.mintAccessTokenForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(tok?.token).toBe('ghs_scoped');
    // Dispatched to the installation-scoped GitHub endpoint via the seam.
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe('https://api.github.com/app/installations/inst-9/access_tokens');
  });

  it('returns null when the workspace has no installation', async () => {
    const { user, workspace } = await makeWorkspace('e@example.com');
    const tok = await githubInstallationService.mintAccessTokenForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(tok).toBeNull();
  });

  it('a minted token is NEVER persisted — no github row carries it (negative DB read, MOTIR-896)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              token: 'ghs_never_persist_me',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const { user, workspace } = await makeWorkspace('f@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-10', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A, REPO_B],
    });
    const tok = await githubInstallationService.mintAccessTokenForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(tok?.token).toBe('ghs_never_persist_me');

    // The schema carries no token column (the appAuth cache is in-memory only);
    // this negative read pins that — a future column/write that persists the
    // minted token long-lived would surface it in a raw row dump and fail here.
    // A direct-DB ASSERTION runs as the OWNER (MOTIR-2887) — and NEGATIVE ("no
    // row contains the token"), so it must be taken by the client that sees
    // everything, not one a policy can narrow.
    const rows = {
      installations: await adminDb.githubInstallation.findMany(),
      repos: await adminDb.githubRepo.findMany(),
    };
    expect(rows.installations.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('ghs_never_persist_me');
  });
});

describe('githubInstallationService.bindInstallationForWorkspace', () => {
  function stubGithubFetch(): void {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    const json = (o: unknown): Response =>
      new Response(JSON.stringify(o), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_bind',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: [
            { id: 111, name: 'motir-core', owner: { login: 'moooon' }, default_branch: 'main' },
            { id: 222, name: 'motir-ai', owner: { login: 'moooon' }, default_branch: 'main' },
          ],
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: { login: 'moooon', type: 'Organization' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** The ledger row that MEANS "this repo has a code graph" — a succeeded
   *  `system.code-graph-index` run carrying the repo's `output.repoRef`. *  Since MOTIR-11885 the first-index gate counts only a row the HANDOFF wrote
   *  (`output.indexedBy: 'motir-codegraph'`); an old-fleet row is enqueued again. */
  async function seedSucceededIndex(workspaceId: string, repoRef: string): Promise<void> {
    await adminDb.jobRun.create({
      data: {
        workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${repoRef}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        output: { indexed: true, repoRef, projectsIndexed: 1, indexedBy: 'motir-codegraph' },
      },
    });
  }

  it('a RE-bind enqueues only the repos with NO code graph yet (MOTIR-896 · MOTIR-1961)', async () => {
    stubGithubFetch();
    const send = spyOnJobDispatch();
    // The suite does not restore mocks between tests, so the spy is shared —
    // clear it or a sibling test's sends leak into this one's assertions.
    send.mockClear();
    const { workspace } = await makeWorkspace('rebind@example.com');
    // Repo 111 is already mirrored AND indexed; the seam returns 111 + 222 —
    // only 222 lacks a graph.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-bind', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A],
    });
    await seedSucceededIndex(workspace.id, 'moooon/motir-core');

    const dto = await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: workspace.id,
      installationId: 'inst-bind',
    });

    expect(dto.repos.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    const indexSends = dispatchedEvents(send).filter((e) => e.name === 'system.code-graph-index');
    expect(indexSends.map((e) => (e.data as { repoName: string }).repoName)).toEqual(['motir-ai']);
  });

  it('a RE-bind RECOVERS an already-mirrored repo that was never indexed (MOTIR-1961)', async () => {
    // The defect's state at the bind path: repo 111 has been mirrored for months
    // and has no index run. The old gate skipped it as "not newly added", so
    // re-binding — the user's most obvious remedy — repaired nothing.
    stubGithubFetch();
    const send = spyOnJobDispatch();
    // The suite does not restore mocks between tests, so the spy is shared —
    // clear it or a sibling test's sends leak into this one's assertions.
    send.mockClear();
    const { workspace } = await makeWorkspace('rebind-recover@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-bind', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A],
    });

    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: workspace.id,
      installationId: 'inst-bind',
    });

    const indexed = dispatchedEvents(send)
      .filter((e) => e.name === 'system.code-graph-index')
      .map((e) => (e.data as { repoName: string }).repoName);
    expect(indexed.sort()).toEqual(['motir-ai', 'motir-core']);
  });

  it('a succeeded run that indexed NOTHING does not count as a graph (MOTIR-1961)', async () => {
    // `indexRepoIntoWorkspaceProjects` returns `{ indexed: false, reason }` — a
    // SUCCEEDED job_run with no `output.repoRef` — when the workspace had no
    // projects. Reading that as "indexed" would strand the repo permanently.
    stubGithubFetch();
    const send = spyOnJobDispatch();
    // The suite does not restore mocks between tests, so the spy is shared —
    // clear it or a sibling test's sends leak into this one's assertions.
    send.mockClear();
    const { workspace } = await makeWorkspace('rebind-noprojects@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-bind', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A],
    });
    await adminDb.jobRun.create({
      data: {
        workspaceId: workspace.id,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: 'evt-no-projects',
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        output: { indexed: false, reason: 'no_projects' },
      },
    });

    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: workspace.id,
      installationId: 'inst-bind',
    });

    const indexed = dispatchedEvents(send)
      .filter((e) => e.name === 'system.code-graph-index')
      .map((e) => (e.data as { repoName: string }).repoName);
    expect(indexed.sort()).toEqual(['motir-ai', 'motir-core']);
  });

  it('binds a fresh install: fetches account + repos through the seam and persists them', async () => {
    stubGithubFetch();
    const { user, workspace } = await makeWorkspace('bind@example.com');

    const dto = await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: workspace.id,
      installationId: 'inst-bind',
    });

    expect(dto).toMatchObject({
      installationId: 'inst-bind',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    expect(dto.repos.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    // The token never crosses the DTO boundary.
    expect(JSON.stringify(dto)).not.toContain('ghs_bind');

    // Now bound → the webhook-style reconcile / the settings read find it.
    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.installationId).toBe('inst-bind');
    expect(read?.repos).toHaveLength(2);
  });
});

describe('github_installation RLS', () => {
  it("hides another workspace's installation under the app role", async () => {
    const a = await makeWorkspace('rls-a@example.com');
    const b = await makeWorkspace('rls-b@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: a.workspace.id,
      installation: { installationId: 'inst-a', accountLogin: 'a', accountType: 'Organization' },
      repos: [REPO_A],
    });

    // Bound to B's workspace GUC, A's row is invisible; bound to A's, it's visible.
    const underB = await asAppRole({ userId: b.user.id, workspaceId: b.workspace.id }, (tx) =>
      githubInstallationRepository.findByWorkspaceId(a.workspace.id, tx),
    );
    expect(underB).toBeNull();

    const underA = await asAppRole({ userId: a.user.id, workspaceId: a.workspace.id }, (tx) =>
      githubInstallationRepository.findByWorkspaceId(a.workspace.id, tx),
    );
    expect(underA).not.toBeNull();
  });

  it('a system-context read sees the row (the webhook-writer escape)', async () => {
    const { workspace } = await makeWorkspace('sys@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-sys', accountLogin: 's', accountType: 'User' },
      repos: [],
    });
    const row = await withSystemContext((tx) =>
      githubInstallationRepository.findByInstallationId('inst-sys', tx),
    );
    expect(row?.workspaceId).toBe(workspace.id);
  });
});

// ── The repository's ARCHIVED state (MOTIR-1959) ─────────────────────────────
//
// The mirror row is where "is this repository still writable?" is RECORDED, and
// the whole guard downstream reads it. Two properties are pinned here, because
// getting either wrong makes the guard look present and be useless:
//
//   1. It is STAMPED from the host's own value at every write, and RE-STAMPED on
//      every reconcile — otherwise it freezes at whatever was true the day the
//      repo was connected, which is exactly the state MOTIR-1956 recorded.
//   2. It is FLIPPED by the `repository` delivery, which is the only signal that
//      arrives when a repo is archived long after it joined the set.
describe('a mirror row records whether its repository is ARCHIVED', () => {
  const ARCHIVED_REPO: NormalizedRepo = { ...REPO_A, archived: true };

  /** A direct-DB ASSERTION, so it runs as the OWNER (MOTIR-2887). */
  async function mirrorOf(repoId: string) {
    return adminDb.githubRepo.findFirst({ where: { repoId } });
  }

  it('stamps the host value on the reconcile write — live and archived alike', async () => {
    const { workspace } = await makeWorkspace('arch-stamp@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-arch', accountLogin: 'a', accountType: 'Organization' },
      repos: [ARCHIVED_REPO, REPO_B],
    });

    expect((await mirrorOf('111'))?.archived).toBe(true);
    expect((await mirrorOf('222'))?.archived).toBe(false);
  });

  it('RE-STAMPS it on the next reconcile — the value never freezes at connect time', async () => {
    // The `installation_repositories` delivery is the cheapest refresh Motir gets,
    // so it must carry liveness the same way it already carries the coordinates.
    const { workspace } = await makeWorkspace('arch-restamp@example.com');
    const install = {
      workspaceId: workspace.id,
      installation: { installationId: 'inst-re', accountLogin: 'a', accountType: 'Organization' },
    };
    await githubInstallationService.persistInstallation({ ...install, repos: [REPO_A] });
    expect((await mirrorOf('111'))?.archived).toBe(false);

    await githubInstallationService.persistInstallation({ ...install, repos: [ARCHIVED_REPO] });
    expect((await mirrorOf('111'))?.archived).toBe(true);

    // …and back, so an un-archive on the host needs no repair inside Motir.
    await githubInstallationService.persistInstallation({ ...install, repos: [REPO_A] });
    expect((await mirrorOf('111'))?.archived).toBe(false);
  });

  it('applies an ARCHIVED / UNARCHIVED delivery to the mirror row', async () => {
    const { workspace } = await makeWorkspace('arch-hook@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-hook', accountLogin: 'a', accountType: 'Organization' },
      repos: [REPO_A],
    });

    await expect(
      githubInstallationService.applyArchivedState({ providerRepoId: '111', archived: true }),
    ).resolves.toBe(true);
    expect((await mirrorOf('111'))?.archived).toBe(true);

    await expect(
      githubInstallationService.applyArchivedState({ providerRepoId: '111', archived: false }),
    ).resolves.toBe(true);
    expect((await mirrorOf('111'))?.archived).toBe(false);
  });

  it('is IDEMPOTENT under redelivery, and silent about a repository it does not mirror', async () => {
    // GitHub retries; a redelivery must write the same row again rather than
    // throw, and a delivery for a repo behind the shared provisioning
    // installation that belongs to no project must not 500 — it would make
    // GitHub retry a delivery no retry can fix.
    const { workspace } = await makeWorkspace('arch-redeliver@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-rd', accountLogin: 'a', accountType: 'Organization' },
      repos: [REPO_A],
    });

    await githubInstallationService.applyArchivedState({ providerRepoId: '111', archived: true });
    await githubInstallationService.applyArchivedState({ providerRepoId: '111', archived: true });
    expect((await mirrorOf('111'))?.archived).toBe(true);

    await expect(
      githubInstallationService.applyArchivedState({ providerRepoId: 'nobody', archived: true }),
    ).resolves.toBe(false);
  });
});
