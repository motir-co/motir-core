import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import {
  projectRunnerGroupService,
  RunnerGroupNotProvisionedError,
} from '@/lib/services/projectRunnerGroupService';
import { runnerGroupClient, runnerGroupNameFor } from '@/lib/github/runnerGroups';
import { repoVisibilityClient } from '@/lib/github/repoVisibility';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  renderSyncOutcome,
  runSyncProjectRunnerGroups,
} from '../../scripts/ci-fleet/syncProjectRunnerGroups';

// A project's runner groups in CONNECTED orgs (Story MOTIR-8699 · MOTIR-8712),
// over real Postgres. The provisioning org's group is the shipped path and is
// pinned by `projectRunnerGroupService.test.ts`; this suite pins the org-keyed
// SET beside it:
//
//   * a connected org WITH the provisioning App gets one group IN that org,
//     through that org's installation, access-listed to PRIVATE repos only;
//   * an org WITHOUT the App is skipped with no write;
//   * re-runs adopt, a lost group is re-created, an emptied org loses its group;
//   * one org's failure is that org's alone;
//   * a handoff never touches a connected-org group;
//   * two concurrent syncs keep both repositories (the lock).
//
// The ONLY fake is `fetch` — one runner-group fake per org.

const MOTIR_ORG = 'motir-projects';
const MOTIR_INSTALLATION = '556677';
const CONNECTED_ORG = 'acme-connected';
const CONNECTED_INSTALLATION = '880011';
const MIRROR_INSTALLATION = '55501';

interface Call {
  url: string;
  method: string;
  authorization: string;
}

let calls: Call[];
let motirGroups: RunnerGroupFake;
let connectedGroups: RunnerGroupFake;
let connectedInstalled: boolean;
let visibility: Map<string, boolean>;
let beforeConnectedPut: (() => Promise<void>) | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method, authorization: headers['authorization'] ?? '' });

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(MOTIR_INSTALLATION) });
      }
      if (u.endsWith(`/orgs/${CONNECTED_ORG}/installation`)) {
        return connectedInstalled
          ? json(200, { id: Number(CONNECTED_INSTALLATION) })
          : json(404, { message: 'Not Found' });
      }
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(u);
      if (mint) {
        return json(200, {
          token: `ghs_${mint[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const repo = /\/repos\/([^/]+)\/([^/]+)$/.exec(new URL(u).pathname);
      if (repo && method === 'GET') {
        const isPrivate = visibility.get(repo[2]!);
        if (isPrivate === undefined) return json(404, { message: 'Not Found' });
        return json(200, { name: repo[2], private: isPrivate });
      }
      return (
        (await motirGroups.handle(u, method, body)) ??
        (await connectedGroups.handle(u, method, body)) ??
        json(500, { message: `unexpected fetch: ${method} ${u}` })
      );
    }),
  );
}

let nextRepoId = 700_001;

/** Mirror `names` in the connected org under the user-facing App's installation
 *  and link each to the project as an established `connected` row. */
async function connectRepos(fx: WorkItemFixture, names: string[]): Promise<Map<string, number>> {
  const ids = new Map(names.map((name) => [name, nextRepoId++]));
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: MIRROR_INSTALLATION,
      accountLogin: CONNECTED_ORG,
      accountType: 'Organization',
    },
    repos: names.map((name) => ({
      providerRepoId: String(ids.get(name)),
      owner: CONNECTED_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  const roles = ['web', 'api', 'mobile', 'shared', 'infra', 'other'] as const;
  const existing = await adminDb.projectRepo.count({ where: { projectId: fx.projectId } });
  for (const [i, name] of names.entries()) {
    const mirror = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: String(ids.get(name)) },
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: roles[(existing + i) % roles.length]!,
        name,
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: `a${existing + i}`,
        githubRepoId: mirror.id,
        state: 'connected',
      },
    });
  }
  return ids;
}

function targetOf(fx: WorkItemFixture) {
  return { projectId: fx.projectId, workspaceId: fx.workspaceId };
}

function connectedCalls(): Call[] {
  return calls.filter((c) => c.url.includes(`/orgs/${CONNECTED_ORG}/actions/runner-groups`));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  connectedInstalled = true;
  visibility = new Map();
  beforeConnectedPut = null;
  motirGroups = createRunnerGroupFake(MOTIR_ORG);
  connectedGroups = createRunnerGroupFake(CONNECTED_ORG, {
    beforeRepositoriesPut: () => beforeConnectedPut?.(),
  });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  installGitHub();
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

describe('a connected org WITH the provisioning App', () => {
  it('gets one group IN that org, through its installation, listing private repos only', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-core', 'motir-skills']);
    visibility.set('motir-core', true);
    visibility.set('motir-skills', false);

    const result = await projectRunnerGroupService.syncForProject(targetOf(fx));

    const group = connectedGroups.onlyGroup();
    expect(group.name).toBe(runnerGroupNameFor(fx.projectId));
    expect(group.repositoryIds).toEqual([ids.get('motir-core')]);
    expect(group.allowsPublicRepositories).toBe(false);
    expect(result.connectedOrgs).toEqual([
      {
        org: CONNECTED_ORG,
        outcome: 'synced',
        runnerGroupId: group.id,
        repositoryIds: [ids.get('motir-core')],
        created: true,
      },
    ]);
    for (const call of connectedCalls()) {
      expect(call.authorization).toBe(`Bearer ghs_${CONNECTED_INSTALLATION}`);
    }
    // Nothing of the connected org's lands in the provisioning org's group.
    expect(motirGroups.groups.size).toBe(1);
    expect(motirGroups.onlyGroup().repositoryIds).toEqual([]);

    const row = await adminDb.projectRunnerGroup.findFirstOrThrow();
    expect(row).toMatchObject({
      org: CONNECTED_ORG,
      installationId: CONNECTED_INSTALLATION,
      runnerGroupId: group.id,
      syncPending: false,
    });
  });

  it('a re-run adopts the stored group and creates no second one', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    const again = await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.groups.size).toBe(1);
    expect(again.connectedOrgs?.[0]).toMatchObject({ outcome: 'synced', created: false });
  });

  it('adopts a group by NAME when a crashed run left it with no row', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    await adminDb.projectRunnerGroup.deleteMany();
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.groups.size).toBe(1);
  });

  it('re-creates the group when the stored id is gone (404)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    const first = connectedGroups.onlyGroup().id;
    connectedGroups.deleteOutOfBand(first);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    const second = connectedGroups.onlyGroup().id;
    expect(second).not.toBe(first);
    expect((await adminDb.projectRunnerGroup.findFirstOrThrow()).runnerGroupId).toBe(second);
  });

  it('deletes the group and its row once the org holds no private repository', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    visibility.set('motir-core', false);
    const result = await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(result.connectedOrgs?.[0]).toMatchObject({ org: CONNECTED_ORG, outcome: 'deleted' });
    expect(connectedGroups.groups.size).toBe(0);
    expect(await adminDb.projectRunnerGroup.count()).toBe(0);
  });

  it('one org failing marks only that row pending; the provisioning pass completes', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    connectedGroups.failWith(500, 5);

    const result = await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(result.outcome).toBe('synced');
    expect(result.connectedOrgs?.[0]).toMatchObject({
      org: CONNECTED_ORG,
      outcome: 'sync_pending',
    });
    expect((await adminDb.projectRunnerGroup.findFirstOrThrow()).syncPending).toBe(true);
  });
});

describe('a connected org WITHOUT the provisioning App', () => {
  it('is skipped_no_install with no runner-group request and no row', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    connectedInstalled = false;

    const result = await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(result.connectedOrgs).toEqual([{ org: CONNECTED_ORG, outcome: 'skipped_no_install' }]);
    expect(connectedCalls()).toHaveLength(0);
    expect(calls.some((c) => c.url.includes(`/repos/${CONNECTED_ORG}/`))).toBe(false);
    expect(await adminDb.projectRunnerGroup.count()).toBe(0);
  });
});

describe('the reads', () => {
  it('requireRunnerGroupIdFor reads the column for the provisioning org and the row otherwise', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));

    await expect(
      projectRunnerGroupService.requireRunnerGroupIdFor(targetOf(fx), 'Motir-Projects'),
    ).resolves.toBe(motirGroups.onlyGroup().id);
    await expect(
      projectRunnerGroupService.requireRunnerGroupIdFor(targetOf(fx), 'ACME-Connected'),
    ).resolves.toBe(connectedGroups.onlyGroup().id);

    const err = await projectRunnerGroupService
      .requireRunnerGroupIdFor(targetOf(fx), 'nobody-org')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerGroupNotProvisionedError);
    expect((err as RunnerGroupNotProvisionedError).org).toBe('nobody-org');
  });

  it('readForOrg answers the stored row and makes no GitHub request', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    calls = [];

    await expect(
      projectRunnerGroupService.readForOrg(targetOf(fx), CONNECTED_ORG),
    ).resolves.toMatchObject({
      runnerGroupId: connectedGroups.onlyGroup().id,
      syncPending: false,
    });
    await expect(projectRunnerGroupService.readForOrg(targetOf(fx), 'nobody-org')).resolves.toBe(
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

// A repository's VISIBILITY changing on GitHub (MOTIR-11426). The connected
// org's access list is judged private-only at sync time, and the establish,
// removal and transfer paths were the only syncs — so a repository established
// while PUBLIC stayed off its group after it went private, and its fleet jobs
// queued forever (motir-codegraph, 2026-11-15). The `repository` delivery's
// `privatized` / `publicized` actions now re-sync every project holding it.
describe('a visibility change on GitHub (MOTIR-11426)', () => {
  function deliver(action: 'privatized' | 'publicized', repoId: number | string) {
    return githubWebhookService.handleEvent('repository', {
      action,
      repository: { id: repoId, name: 'motir-codegraph', owner: { login: CONNECTED_ORG } },
    });
  }

  it('`privatized` adds a repository established while public to the group', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-core', 'motir-codegraph']);
    visibility.set('motir-core', true);
    visibility.set('motir-codegraph', false);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.onlyGroup().repositoryIds).toEqual([ids.get('motir-core')]);

    visibility.set('motir-codegraph', true);
    expect(await deliver('privatized', ids.get('motir-codegraph')!)).toEqual({
      event: 'repository',
      outcome: 'runner_groups_resynced',
    });

    expect(connectedGroups.onlyGroup().repositoryIds).toEqual([
      ids.get('motir-core'),
      ids.get('motir-codegraph'),
    ]);
    const row = await adminDb.projectRunnerGroup.findFirstOrThrow();
    expect(row.syncPending).toBe(false);
  });

  it('`privatized` creates the group when the org held no private repository before', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-codegraph']);
    visibility.set('motir-codegraph', false);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.groups.size).toBe(0);

    visibility.set('motir-codegraph', true);
    await deliver('privatized', ids.get('motir-codegraph')!);

    expect(connectedGroups.onlyGroup().repositoryIds).toEqual([ids.get('motir-codegraph')]);
  });

  it('`publicized` removes the repository from the group', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-core', 'motir-codegraph']);
    visibility.set('motir-core', true);
    visibility.set('motir-codegraph', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.onlyGroup().repositoryIds).toHaveLength(2);

    visibility.set('motir-codegraph', false);
    expect(await deliver('publicized', ids.get('motir-codegraph')!)).toEqual({
      event: 'repository',
      outcome: 'runner_groups_resynced',
    });

    expect(connectedGroups.onlyGroup().repositoryIds).toEqual([ids.get('motir-core')]);
  });

  it('`publicized` of the org’s last private repository deletes the group', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-codegraph']);
    visibility.set('motir-codegraph', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.groups.size).toBe(1);

    visibility.set('motir-codegraph', false);
    await deliver('publicized', ids.get('motir-codegraph')!);

    expect(connectedGroups.groups.size).toBe(0);
    expect(await adminDb.projectRunnerGroup.count()).toBe(0);
  });

  it('re-syncs EVERY project that holds the repository', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-codegraph']);
    const mirror = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: String(ids.get('motir-codegraph')) },
    });
    const second = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Second project',
        slug: 'second',
        identifier: 'TWO',
      },
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: second.id,
        role: 'web',
        name: 'motir-codegraph',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: mirror.id,
        state: 'connected',
      },
    });
    visibility.set('motir-codegraph', true);

    await deliver('privatized', ids.get('motir-codegraph')!);

    const names = [...connectedGroups.groups.values()].map((g) => g.name).sort();
    expect(names).toEqual([runnerGroupNameFor(fx.projectId), runnerGroupNameFor(second.id)].sort());
  });

  it('a repository no project has established is `unknown_repo`, with no GitHub call', async () => {
    expect(await deliver('privatized', 999_999)).toEqual({
      event: 'repository',
      outcome: 'unknown_repo',
    });
    expect(calls).toHaveLength(0);
  });

  it('a delivery with no repository id is `malformed`', async () => {
    expect(await githubWebhookService.handleEvent('repository', { action: 'publicized' })).toEqual({
      event: 'repository',
      outcome: 'malformed',
    });
  });

  it('a failed re-sync does not fail the delivery — that org is marked pending', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-core', 'motir-codegraph']);
    visibility.set('motir-core', true);
    visibility.set('motir-codegraph', false);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    connectedGroups.failWith(500, 5);
    visibility.set('motir-codegraph', true);

    expect(await deliver('privatized', ids.get('motir-codegraph')!)).toEqual({
      event: 'repository',
      outcome: 'runner_groups_resynced',
    });
    expect((await adminDb.projectRunnerGroup.findFirstOrThrow()).syncPending).toBe(true);
  });
});

describe('handoff and deletion', () => {
  it('syncAfterHandoff deletes only the provisioning group', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncAfterHandoff(targetOf(fx));
    expect(motirGroups.groups.size).toBe(0);
    expect(connectedGroups.groups.size).toBe(1);
    expect(await adminDb.projectRunnerGroup.count()).toBe(1);
  });

  it('deleteForProject removes every org’s group', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    const result = await projectRunnerGroupService.deleteForProject(targetOf(fx));
    expect(result).toMatchObject({
      outcome: 'deleted',
      connectedOrgs: [{ org: CONNECTED_ORG, outcome: 'deleted' }],
    });
    expect(connectedGroups.groups.size).toBe(0);
    expect(await adminDb.projectRunnerGroup.count()).toBe(0);
  });
});

describe('the failure edges (MOTIR-8716)', () => {
  it('requireRunnerGroupIdFor the provisioning org with no group names that org', async () => {
    const fx = await makeWorkItemFixture();
    const err = await projectRunnerGroupService
      .requireRunnerGroupIdFor(targetOf(fx), MOTIR_ORG)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerGroupNotProvisionedError);
    expect((err as RunnerGroupNotProvisionedError).org).toBe(MOTIR_ORG);
    expect((err as Error).message).toContain(`in ${MOTIR_ORG}`);
  });

  it('a connected-org group GitHub will not delete is delete_failed, and its row stays for a retry', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    const groupId = connectedGroups.onlyGroup().id;
    connectedGroups.failWith(500, 5);

    const result = await projectRunnerGroupService.deleteForProject(targetOf(fx));
    expect(result.connectedOrgs).toEqual([
      expect.objectContaining({
        org: CONNECTED_ORG,
        outcome: 'delete_failed',
        runnerGroupId: groupId,
      }),
    ]);
    expect(await adminDb.projectRunnerGroup.count()).toBe(1);
    expect(connectedGroups.groups.size).toBe(1);
  });

  it('a failure that is not an Error is reported as unknown, on delete and on sync', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    await projectRunnerGroupService.syncForProject(targetOf(fx));

    vi.spyOn(repoVisibilityClient, 'isPrivate').mockRejectedValueOnce('not an error');
    const synced = await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(synced.connectedOrgs).toEqual([
      { org: CONNECTED_ORG, outcome: 'sync_pending', detail: 'unknown' },
    ]);

    const real = runnerGroupClient.deleteGroup.bind(runnerGroupClient);
    vi.spyOn(runnerGroupClient, 'deleteGroup').mockImplementation(async (id, target) => {
      if (target) throw 'not an error either';
      return real(id, target);
    });
    const deleted = await projectRunnerGroupService.deleteForProject(targetOf(fx));
    expect(deleted.connectedOrgs).toEqual([
      expect.objectContaining({ org: CONNECTED_ORG, outcome: 'delete_failed', detail: 'unknown' }),
    ]);
  });
});

describe('the table', () => {
  it('refuses a second row for the same (project, org), and hides rows from another workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const row = {
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      org: CONNECTED_ORG,
      installationId: CONNECTED_INSTALLATION,
      runnerGroupId: 1,
      runnerGroupName: 'g',
    };
    await adminDb.projectRunnerGroup.create({ data: row });
    await expect(adminDb.projectRunnerGroup.create({ data: row })).rejects.toThrow();

    const seenByOther = await withWorkspaceServiceContext(other.workspaceId, (tx) =>
      tx.projectRunnerGroup.findMany(),
    );
    expect(seenByOther).toEqual([]);
    const seenByOwner = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      tx.projectRunnerGroup.findMany(),
    );
    expect(seenByOwner).toHaveLength(1);
  });

  it('two CONCURRENT syncs leave both repositories in the connected org’s list', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await connectRepos(fx, ['motir-core', 'motir-ai']);
    visibility.set('motir-core', true);
    visibility.set('motir-ai', true);
    const aiRow = await adminDb.projectRepo.findFirstOrThrow({ where: { name: 'motir-ai' } });
    await adminDb.projectRepo.update({ where: { id: aiRow.id }, data: { state: 'proposed' } });
    await projectRunnerGroupService.syncForProject(targetOf(fx));
    expect(connectedGroups.onlyGroup().repositoryIds).toEqual([ids.get('motir-core')]);

    const firstPutIssued = deferred();
    const firstPutAllowed = deferred();
    let gated = false;
    beforeConnectedPut = async () => {
      if (gated) return;
      gated = true;
      firstPutIssued.resolve();
      await firstPutAllowed.promise;
    };
    const first = projectRunnerGroupService.syncForProject(targetOf(fx));
    await firstPutIssued.promise;
    await adminDb.projectRepo.update({ where: { id: aiRow.id }, data: { state: 'connected' } });
    const second = projectRunnerGroupService.syncForProject(targetOf(fx));
    await new Promise((resolve) => setTimeout(resolve, 300));
    firstPutAllowed.resolve();
    await Promise.all([first, second]);

    expect(connectedGroups.onlyGroup().repositoryIds.sort()).toEqual(
      [ids.get('motir-core'), ids.get('motir-ai')].sort(),
    );
  }, 20_000);
});

describe('the one-shot script', () => {
  it('prints one line per org and exits 0 when everything synced', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SYNC' });
    await connectRepos(fx, ['motir-core']);
    visibility.set('motir-core', true);
    const result = await runSyncProjectRunnerGroups(['--project', fx.projectIdentifier]);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toMatch(new RegExp(`^${CONNECTED_ORG}: synced group=\\d+`));
  });

  it('exits 1 when any org is sync_pending', () => {
    expect(
      renderSyncOutcome({
        outcome: 'synced',
        runnerGroupId: 1,
        created: false,
        repositoryIds: [],
        connectedOrgs: [{ org: CONNECTED_ORG, outcome: 'sync_pending', detail: 'boom' }],
      }).exitCode,
    ).toBe(1);
  });

  it('refuses an unknown key', async () => {
    await expect(runSyncProjectRunnerGroups(['--project', 'NOPE'])).resolves.toMatchObject({
      exitCode: 1,
    });
  });

  // MOTIR-8814: a project key is unique per WORKSPACE only. Production holds two
  // projects keyed MOTIR, so `--project MOTIR` refused with nothing the operator
  // could re-run with.
  describe('a key two workspaces share (MOTIR-8814)', () => {
    async function twoTenantsKeyed(identifier: string) {
      const ours = await makeWorkItemFixture({ name: 'Ours', identifier });
      const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier });
      return { ours, theirs };
    }

    it('an ambiguous --project still refuses, naming each candidate’s id and workspace', async () => {
      const { ours, theirs } = await twoTenantsKeyed('TWIN');
      const result = await runSyncProjectRunnerGroups(['--project', 'TWIN']);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe('2 projects share the key TWIN; refusing to guess');
      expect(result.lines.slice(1)).toEqual([
        `  --project-id ${ours.projectId}  (workspace ${ours.workspaceId})`,
        `  --project-id ${theirs.projectId}  (workspace ${theirs.workspaceId})`,
      ]);
      expect(calls).toHaveLength(0);
    });

    it('--project-id syncs exactly that project, printing the same per-org lines', async () => {
      const { ours } = await twoTenantsKeyed('TWIN');
      await connectRepos(ours, ['motir-core']);
      visibility.set('motir-core', true);
      for (const argv of [['--project-id', ours.projectId], [`--project-id=${ours.projectId}`]]) {
        const result = await runSyncProjectRunnerGroups(argv);
        expect(result.exitCode).toBe(0);
        expect(result.lines).toHaveLength(2);
        expect(result.lines[0]).toMatch(/^provisioning org: /);
        expect(result.lines[1]).toMatch(new RegExp(`^${CONNECTED_ORG}: synced group=\\d+`));
      }
      const group = await adminDb.projectRunnerGroup.findFirstOrThrow({
        where: { org: CONNECTED_ORG },
      });
      expect(group.projectId).toBe(ours.projectId);
    });

    it('an unknown --project-id refuses with exit 1 and names the id', async () => {
      await expect(
        runSyncProjectRunnerGroups(['--project-id', 'cm_no_such_project']),
      ).resolves.toEqual({ exitCode: 1, lines: ['no project has the id cm_no_such_project'] });
      expect(calls).toHaveLength(0);
    });

    it('refuses both flags at once, and neither', async () => {
      const usage = { exitCode: 1, lines: ['usage: --project <KEY> | --project-id <id>'] };
      await expect(runSyncProjectRunnerGroups([])).resolves.toEqual(usage);
      await expect(
        runSyncProjectRunnerGroups(['--project', 'TWIN', '--project-id', 'x']),
      ).resolves.toEqual(usage);
    });
  });
});
