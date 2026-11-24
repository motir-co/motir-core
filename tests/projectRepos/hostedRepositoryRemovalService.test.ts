import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { hostedRepositoryRemovalService } from '@/lib/services/hostedRepositoryRemovalService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { hostedReleaseUsageService } from '@/lib/services/hostedReleaseUsageService';
import { productionUsageMeterService } from '@/lib/services/productionUsageMeterService';
import { repoDeletionClient, RepoDeletionError } from '@/lib/github/repoDeletion';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { SEED_SOURCE_FLY_STARTER, SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import {
  HostedRepositoryCheckFailedError,
  HostedRepositoryDeletionError,
  ProjectRepoNotFoundError,
  ProjectRepoRemovalBlockedError,
} from '@/lib/projectRepos/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// DELETING A MOTIR-HOSTED REPOSITORY (bug MOTIR-11979 · MOTIR-11981; design
// repository-set §19) over real Postgres.
//
// What is pinned, each by RUNNING it:
//   1. the check (§19.4) — what the confirm says the delete removes, and that it
//      never guesses: a GitHub that cannot answer is a refusal, not a default;
//   2. the end state (§19.2) — the GitHub repository deleted, production's app,
//      database and application row gone (releases with it, custom domains
//      released), previews torn down, environment values and work-item links gone
//      with the row, the `github_repo` mirror KEPT for history but RETIRED from
//      the organisation's connected set (bug MOTIR-12192);
//   3. a repository already gone from GitHub is removable (the
//      `cmwpi5yqc02fc01adg4jxu42y` case) and nothing is deleted there;
//   4. a step that fails leaves the row MARKED, and a retry finishes the rest;
//   5. an organisation link still goes through `removeRow`, untouched;
//   6. `repository:manage` gates both doors;
//   7. the mirror retires only when Motir hosts it and no other row holds it, and
//      a retire that fails never fails the removal (MOTIR-12192).
//
// The host boundaries are faked where they are crossed: the orchestrator's fake
// hosting and database ports, the preview services and the GitHub delete client.

vi.mock('@/lib/ciMetering/ownedOrgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ciMetering/ownedOrgs')>()),
  motirOwnedOrgLogins: vi.fn(async () => [MOTIR_ORG]),
}));

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  resetDatabaseFakes();
  fx = await makeWorkItemFixture();
  vi.spyOn(previewEnablementService, 'disable').mockResolvedValue('disabled');
  vi.spyOn(previewLifecycleService, 'teardownRepository').mockResolvedValue({
    closed: 0,
    usage: [],
  });
  vi.spyOn(hostedReleaseUsageService, 'settleReleaseUsage').mockResolvedValue({
    outcome: 'settled',
    seconds: 60,
  });
  // The meter's own suite drives it against the port (MOTIR-12108).
  vi.spyOn(productionUsageMeterService, 'accrueOutgoingRelease').mockResolvedValue({
    outcome: 'accrued',
    slices: 0,
  });
  vi.spyOn(repoDeletionClient, 'probeRepo').mockResolvedValue('present');
  vi.spyOn(repoDeletionClient, 'deleteRepo').mockResolvedValue('deleted');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(motirOwnedOrgLogins).mockImplementation(async () => [MOTIR_ORG]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface RowOptions {
  name?: string;
  owner?: string;
  /** Leave the mirror off — a repository deleted on GitHub whose mirror went. */
  realized?: boolean;
  state?: 'proposed' | 'created' | 'connected';
  seedSource?: string;
  takeoverState?: 'requested' | 'transfer_pending' | 'awaiting_reinstall' | 'failed' | 'done';
}

/** A hosted row as the creation primitive leaves it, written directly. */
async function hostedRow(opts: RowOptions = {}) {
  const name = opts.name ?? 'acme-shop-web';
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    update: {},
  });
  const mirror =
    opts.realized === false
      ? null
      : await adminDb.githubRepo.create({
          data: {
            installationId: inst.id,
            workspaceId: fx.workspaceId,
            organizationId: fx.workspace.organizationId,
            repoId: `host-${name}`,
            owner: opts.owner ?? MOTIR_ORG,
            name,
            defaultBranch: 'main',
            archived: false,
          },
        });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: opts.seedSource ?? SEED_SOURCE_FLY_STARTER,
      state: opts.state ?? 'created',
      githubRepoId: mirror?.id ?? null,
      takeoverState: opts.takeoverState ?? null,
      hostingTarget: 'fly',
      position: 'a0',
    },
  });
  return { row, mirror };
}

/** Production as a first release leaves it: app, database, one live release,
 *  and one custom domain bound to it. */
async function production(rowId: string) {
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectRepositoryId: rowId,
      target: 'fly',
      slug: 'shop--acme',
      productionAddress: 'shop--acme.motir.site',
      productionAppName: 'mh-shop',
      databaseProjectId: 'neon-shop',
    },
  });
  const release = await adminDb.hostedRelease.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      commitSha: 'abc123',
      cause: 'merge',
      state: 'live',
      liveAt: new Date(),
    },
  });
  await adminDb.hostedApplication.update({
    where: { id: app.id },
    data: { currentReleaseId: release.id },
  });
  const domain = await adminDb.publicAddress.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      hostname: 'shop.acme.test',
      kind: 'custom_domain',
      status: 'active',
    },
  });
  return { app, release, domain };
}

async function environmentValues(rowId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await adminDb.environmentConfigEntry.create({
      data: {
        workspaceId: fx.workspaceId,
        projectRepositoryId: rowId,
        environment: 'production',
        name: `KEY_${i}`,
        value: 'v',
      },
    });
    await adminDb.environmentConfigChange.create({
      data: {
        workspaceId: fx.workspaceId,
        projectRepositoryId: rowId,
        environment: 'production',
        name: `KEY_${i}`,
        action: 'added',
        isSecret: false,
      },
    });
  }
}

/** A work item that targets the row; `done` ones are not counted as open. */
async function targetingWorkItem(rowId: string, done = false) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: done ? 'done' : 'open' });
  if (done) await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
  await adminDb.workItemRepo.create({
    data: { workspaceId: fx.workspaceId, workItemId: item.id, projectRepoId: rowId, position: 0 },
  });
  return item;
}

async function openPreview(repoId: string) {
  await adminDb.previewDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId,
      pullRequestNumber: 7,
      headSha: 'def',
      host: 'pr-7--shop.preview.motir.site',
      state: 'ready',
    },
  });
}

async function viewerCtx() {
  const viewer = await adminDb.user.create({
    data: { email: 'hosted-remove-viewer@example.com', name: 'Viewer', emailVerified: true },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'viewer' },
  });
  return { userId: viewer.id, workspaceId: fx.workspaceId };
}

describe('getRemovalImpact — what the confirm says the delete removes (§19.4)', () => {
  it('counts everything that runs from a repository Motir holds, and calls it destructive', async () => {
    const { row, mirror } = await hostedRow();
    await production(row.id);
    await environmentValues(row.id, 3);
    await targetingWorkItem(row.id);
    await targetingWorkItem(row.id);
    await targetingWorkItem(row.id, true);
    await openPreview(mirror!.id);

    const impact = await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx);

    expect(impact).toEqual({
      repository: 'motir',
      production: { address: 'shop--acme.motir.site', domains: 1 },
      previews: 1,
      environmentValues: 3,
      openWorkItems: 2,
      destructive: true,
    });
    expect(repoDeletionClient.probeRepo).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      owner: MOTIR_ORG,
      repo: 'acme-shop-web',
    });
  });

  it('reads a repository GitHub answers 404 for as gone, and quiet when nothing runs', async () => {
    vi.mocked(repoDeletionClient.probeRepo).mockResolvedValue('absent');
    const { row } = await hostedRow();
    await environmentValues(row.id, 2);

    expect(await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx)).toEqual({
      repository: 'gone',
      production: null,
      previews: 0,
      environmentValues: 2,
      openWorkItems: 0,
      destructive: false,
    });
  });

  it('keeps the danger weight for a gone repository that still runs production', async () => {
    const { row } = await hostedRow({ realized: false });
    const { app } = await production(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { productionAddress: null },
    });

    const impact = await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx);
    expect(impact.repository).toBe('gone');
    // No address claimed yet: the application's own label names it.
    expect(impact.production).toEqual({ address: 'shop--acme', domains: 1 });
    expect(impact.destructive).toBe(true);
    expect(repoDeletionClient.probeRepo).not.toHaveBeenCalled();
  });

  it('names a never-created and a taken-over row, neither of which deletes anything', async () => {
    const never = await hostedRow({ name: 'never', state: 'proposed', realized: false });
    const yours = await hostedRow({ name: 'yours', takeoverState: 'done', owner: 'yue' });

    expect(
      await hostedRepositoryRemovalService.getRemovalImpact(never.row.id, fx.ctx),
    ).toMatchObject({ repository: 'never', destructive: false });
    expect(
      await hostedRepositoryRemovalService.getRemovalImpact(yours.row.id, fx.ctx),
    ).toMatchObject({ repository: 'yours', destructive: false });
    expect(repoDeletionClient.probeRepo).not.toHaveBeenCalled();
  });

  it('reads a repository outside every org Motir owns as yours', async () => {
    const { row } = await hostedRow({ owner: 'someone-else' });
    expect(await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx)).toMatchObject({
      repository: 'yours',
    });
  });

  it('never guesses: a GitHub that cannot answer is a check failure', async () => {
    vi.mocked(repoDeletionClient.probeRepo).mockRejectedValue(new RepoDeletionError(500, 'boom'));
    const { row } = await hostedRow();
    await expect(
      hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx),
    ).rejects.toBeInstanceOf(HostedRepositoryCheckFailedError);
  });

  it('refuses a missing row, a hand-off in flight, and an actor without repository:manage', async () => {
    await expect(
      hostedRepositoryRemovalService.getRemovalImpact('nope', fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoNotFoundError);

    const moving = await hostedRow({ name: 'moving', takeoverState: 'transfer_pending' });
    await expect(
      hostedRepositoryRemovalService.getRemovalImpact(moving.row.id, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoRemovalBlockedError);

    const { row } = await hostedRow();
    await expect(
      hostedRepositoryRemovalService.getRemovalImpact(row.id, await viewerCtx()),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', permission: 'repository:manage' });
  });
});

describe('remove — the delete sequence (§19.6)', () => {
  it('deletes the repository and everything that runs from it, row last, keeping the mirror', async () => {
    const { row, mirror } = await hostedRow();
    const { app, domain } = await production(row.id);
    await environmentValues(row.id, 2);
    const item = await targetingWorkItem(row.id);
    const port = getHostingDeployPort('fly');
    const destroyApp = vi.spyOn(port, 'destroyApp');
    const deleteDatabase = vi.spyOn(getDatabasePort(), 'deleteDatabase');

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);

    // previews: credential withdrawn, then torn down — the takeover's two calls.
    expect(previewEnablementService.disable).toHaveBeenCalledWith(row.id);
    expect(previewLifecycleService.teardownRepository).toHaveBeenCalledWith(row.id, {
      pushNamespace: null,
    });
    // production: usage settled before the app goes, then the database.
    expect(hostedReleaseUsageService.settleReleaseUsage).toHaveBeenCalledWith(
      (await adminDb.hostedRelease.findFirst({ where: { applicationId: app.id } }))?.id ??
        expect.any(String),
    );
    // …and its last window metered, with every open day charged now (MOTIR-12108).
    expect(productionUsageMeterService.accrueOutgoingRelease).toHaveBeenCalledWith(
      expect.any(String),
      { chargeNow: true },
    );
    expect(destroyApp).toHaveBeenCalledWith({ appRef: 'mh-shop' });
    expect(deleteDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ applicationRef: row.id, databaseRef: 'neon-shop' }),
    );
    // the GitHub repository, through the provisioning installation.
    expect(repoDeletionClient.deleteRepo).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      owner: MOTIR_ORG,
      repo: 'acme-shop-web',
    });

    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
    expect(await adminDb.hostedApplication.count({ where: { id: app.id } })).toBe(0);
    expect(await adminDb.hostedRelease.count({ where: { applicationId: app.id } })).toBe(0);
    expect(
      await adminDb.environmentConfigEntry.count({ where: { projectRepositoryId: row.id } }),
    ).toBe(0);
    // …and their change history, which the confirm promises goes with them.
    expect(
      await adminDb.environmentConfigChange.count({ where: { projectRepositoryId: row.id } }),
    ).toBe(0);
    expect(await adminDb.workItemRepo.count({ where: { projectRepoId: row.id } })).toBe(0);
    // Kept: the custom domain (released, not deleted), the work item, the mirror.
    expect(await adminDb.publicAddress.findUnique({ where: { id: domain.id } })).toMatchObject({
      applicationId: null,
    });
    expect(await adminDb.workItem.count({ where: { id: item.id } })).toBe(1);
    expect(await adminDb.githubRepo.count({ where: { id: mirror!.id } })).toBe(1);
    // …but no longer connected to the organisation (MOTIR-12192).
    expect(
      (await adminDb.githubRepo.findUnique({ where: { id: mirror!.id } }))?.retiredAt,
    ).toBeInstanceOf(Date);
  });

  it('removes a row whose repository is already gone from GitHub (cmwpi5yqc02fc01adg4jxu42y)', async () => {
    vi.mocked(repoDeletionClient.deleteRepo).mockResolvedValue('absent');
    const { row } = await hostedRow({ name: 'motir-envcheck-sandbox' });
    await environmentValues(row.id, 1);

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);

    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('removes a gone row whose mirror went too, deleting nothing on GitHub', async () => {
    const { row } = await hostedRow({ realized: false });
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
    expect(previewEnablementService.disable).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('removes a never-created row without marking it or touching a host', async () => {
    const { row } = await hostedRow({ state: 'proposed', realized: false });
    const markSpy = vi.spyOn(
      (await import('@/lib/repositories/projectRepoRepository')).projectRepoRepository,
      'markHostedDeletionStarted',
    );
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(markSpy).not.toHaveBeenCalled();
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('removes a taken-over row and leaves the repository where it is', async () => {
    const { row } = await hostedRow({ takeoverState: 'done', owner: 'yue' });
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(previewEnablementService.disable).not.toHaveBeenCalled();
    expect(previewLifecycleService.teardownRepository).toHaveBeenCalled();
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('shuts down production for a taken-over row and never touches the repository (review of #4382)', async () => {
    const { row } = await hostedRow({ takeoverState: 'done', owner: 'yue' });
    const { app } = await production(row.id);
    const destroyApp = vi.spyOn(getHostingDeployPort('fly'), 'destroyApp');

    // The check reads it as the person's own, and still destructive.
    expect(await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx)).toMatchObject({
      repository: 'yours',
      production: { address: 'shop--acme.motir.site', domains: 1 },
      destructive: true,
    });
    expect(repoDeletionClient.probeRepo).not.toHaveBeenCalled();

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(destroyApp).toHaveBeenCalledWith({ appRef: 'mh-shop' });
    expect(previewEnablementService.disable).not.toHaveBeenCalled();
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
    expect(await adminDb.hostedApplication.count({ where: { id: app.id } })).toBe(0);
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('does not reach the host again on a retry after production’s app was destroyed', async () => {
    const { row } = await hostedRow();
    const { app } = await production(row.id);
    const port = getHostingDeployPort('fly');
    const destroyApp = vi.spyOn(port, 'destroyApp');
    const ensureApp = vi.spyOn(port, 'ensureApp');
    vi.spyOn(getDatabasePort(), 'deleteDatabase').mockRejectedValueOnce(new Error('neon'));

    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toMatchObject({
      step: 'production',
    });
    expect(await adminDb.hostedApplication.findUnique({ where: { id: app.id } })).toMatchObject({
      currentReleaseId: null,
      productionAppName: null,
    });

    vi.mocked(hostedReleaseUsageService.settleReleaseUsage).mockClear();
    vi.mocked(productionUsageMeterService.accrueOutgoingRelease).mockClear();
    destroyApp.mockClear();
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(hostedReleaseUsageService.settleReleaseUsage).not.toHaveBeenCalled();
    expect(productionUsageMeterService.accrueOutgoingRelease).not.toHaveBeenCalled();
    expect(ensureApp).not.toHaveBeenCalled();
    expect(destroyApp).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('finds production’s app through the port when the release never recorded its name', async () => {
    const { row } = await hostedRow();
    const { app } = await production(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { productionAppName: null, databaseProjectId: null },
    });
    const port = getHostingDeployPort('fly');
    const ensureApp = vi.spyOn(port, 'ensureApp');
    const destroyApp = vi.spyOn(port, 'destroyApp');

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);

    expect(ensureApp).toHaveBeenCalledWith({
      repositoryId: row.id,
      environment: { kind: 'production' },
    });
    const { appRef } = (await ensureApp.mock.results[0]!.value) as { appRef: string };
    expect(destroyApp).toHaveBeenCalledWith({ appRef });
  });

  it('skips the port entirely for an application that never ran', async () => {
    const { row } = await hostedRow();
    const app = await adminDb.hostedApplication.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectRepositoryId: row.id,
        target: 'fly',
        slug: 'idle--acme',
      },
    });
    const destroyApp = vi.spyOn(getHostingDeployPort('fly'), 'destroyApp');
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(destroyApp).not.toHaveBeenCalled();
    expect(hostedReleaseUsageService.settleReleaseUsage).not.toHaveBeenCalled();
    expect(await adminDb.hostedApplication.count({ where: { id: app.id } })).toBe(0);
  });

  it('stops at a failed GitHub delete with the row MARKED, and a retry finishes the rest', async () => {
    const { row } = await hostedRow();
    const { app } = await production(row.id);
    vi.mocked(repoDeletionClient.deleteRepo).mockRejectedValueOnce(
      new RepoDeletionError(403, 'Must have admin rights'),
    );

    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toMatchObject({
      step: 'repository',
    });
    const marked = await adminDb.projectRepo.findUnique({ where: { id: row.id } });
    expect(marked?.hostedDeletionStartedAt).toBeInstanceOf(Date);
    // Production went before the failure, and stays gone.
    expect(await adminDb.hostedApplication.count({ where: { id: app.id } })).toBe(0);
    // The room reads the stamp (the unfinished state).
    const dto = (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).find(
      (r) => r.id === row.id,
    );
    expect(dto?.hostedDeletionStartedAt).toBe(marked!.hostedDeletionStartedAt!.toISOString());
    // A fresh check lists only what is left.
    expect(await hostedRepositoryRemovalService.getRemovalImpact(row.id, fx.ctx)).toMatchObject({
      repository: 'motir',
      production: null,
    });

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });

  it('keeps the first stamp across retries', async () => {
    const { row } = await hostedRow();
    vi.mocked(repoDeletionClient.deleteRepo).mockRejectedValue(new Error('down'));
    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toBeInstanceOf(
      HostedRepositoryDeletionError,
    );
    const first = (await adminDb.projectRepo.findUnique({ where: { id: row.id } }))!
      .hostedDeletionStartedAt;
    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toBeInstanceOf(
      HostedRepositoryDeletionError,
    );
    expect(
      (await adminDb.projectRepo.findUnique({ where: { id: row.id } }))!.hostedDeletionStartedAt,
    ).toEqual(first);
  });

  it('names the previews step when the preview teardown fails', async () => {
    const { row } = await hostedRow();
    vi.mocked(previewLifecycleService.teardownRepository).mockRejectedValueOnce(new Error('fly'));
    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toMatchObject({
      code: 'HOSTED_REPOSITORY_DELETION_UNFINISHED',
      step: 'previews',
    });
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
  });

  it('names the production step when the host refuses the destroy', async () => {
    const { row } = await hostedRow();
    await production(row.id);
    vi.spyOn(getHostingDeployPort('fly'), 'destroyApp').mockRejectedValueOnce(new Error('fly'));
    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toMatchObject({
      step: 'production',
    });
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(1);
  });

  it('re-asserts the host owner right before the GitHub delete', async () => {
    const { row } = await hostedRow();
    vi.mocked(motirOwnedOrgLogins)
      .mockImplementationOnce(async () => [MOTIR_ORG])
      .mockImplementationOnce(async () => []);
    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).rejects.toMatchObject({
      step: 'repository',
    });
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
  });

  it('refuses while a takeover hand-off is in flight, and an actor without repository:manage', async () => {
    const moving = await hostedRow({ name: 'moving', takeoverState: 'awaiting_reinstall' });
    await expect(
      hostedRepositoryRemovalService.remove(moving.row.id, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoRemovalBlockedError);
    const { row } = await hostedRow();
    await expect(
      hostedRepositoryRemovalService.remove(row.id, await viewerCtx()),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', permission: 'repository:manage' });
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(1);
  });

  it('is a no-op for a row that is already gone', async () => {
    await expect(hostedRepositoryRemovalService.remove('gone', fx.ctx)).resolves.toBeUndefined();
  });

  it('retires the mirror of a repository already gone from GitHub (MOTIR-12192)', async () => {
    vi.mocked(repoDeletionClient.deleteRepo).mockResolvedValue('absent');
    const { row, mirror } = await hostedRow({ name: 'motir-envcheck-sandbox' });
    await adminDb.githubPullRequest.create({
      data: { repoId: mirror!.id, number: 3, state: 'closed', merged: true, headRef: 'x' },
    });

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);

    const kept = await adminDb.githubRepo.findUnique({
      where: { id: mirror!.id },
      include: { pullRequests: true },
    });
    expect(kept?.retiredAt).toBeInstanceOf(Date);
    expect(kept?.pullRequests.map((pr) => pr.number)).toEqual([3]);
  });

  it('keeps a taken-over repository’s mirror connected — it is the person’s now', async () => {
    const { row, mirror } = await hostedRow({ takeoverState: 'done', owner: 'yue' });
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect((await adminDb.githubRepo.findUnique({ where: { id: mirror!.id } }))?.retiredAt).toBe(
      null,
    );
  });

  it('keeps an organisation repository connected when its link is removed (criterion 4)', async () => {
    const { row, mirror } = await hostedRow({
      name: 'org-repo',
      owner: 'acme',
      state: 'connected',
      seedSource: SEED_SOURCE_ORGANIZATION,
    });
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect((await adminDb.githubRepo.findUnique({ where: { id: mirror!.id } }))?.retiredAt).toBe(
      null,
    );
  });

  it('retires a hosted mirror only when its LAST row goes', async () => {
    const { row, mirror } = await hostedRow({ name: 'shared-hosted' });
    // A second project linked it through the organisation picker before the
    // picker stopped offering hosted repositories.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const link = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: other.id,
        role: 'web',
        name: 'shared-hosted',
        seedSource: SEED_SOURCE_ORGANIZATION,
        state: 'connected',
        githubRepoId: mirror!.id,
        position: 'a0',
      },
    });

    await hostedRepositoryRemovalService.remove(link.id, fx.ctx);
    expect((await adminDb.githubRepo.findUnique({ where: { id: mirror!.id } }))?.retiredAt).toBe(
      null,
    );

    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(
      (await adminDb.githubRepo.findUnique({ where: { id: mirror!.id } }))?.retiredAt,
    ).toBeInstanceOf(Date);
  });

  it('a retire that fails never fails the removal the database already kept', async () => {
    const { row } = await hostedRow({ name: 'retire-fails' });
    const { hostedMirrorRetirementService } =
      await import('@/lib/services/hostedMirrorRetirementService');
    vi.spyOn(hostedMirrorRetirementService, 'retireIfHostedAndUnheld').mockRejectedValue(
      new Error('database went away'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(hostedRepositoryRemovalService.remove(row.id, fx.ctx)).resolves.toBeUndefined();

    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('retire-hosted-mirrors'),
      expect.any(Error),
    );
  });

  it('hands an organisation link to removeRow, exactly as before', async () => {
    const { row } = await hostedRow({
      name: 'org-link',
      owner: 'acme',
      state: 'connected',
      seedSource: SEED_SOURCE_ORGANIZATION,
    });
    const removeRow = vi.spyOn(projectRepoSetService, 'removeRow');
    await hostedRepositoryRemovalService.remove(row.id, fx.ctx);
    expect(removeRow).toHaveBeenCalledWith(row.id, fx.ctx);
    expect(previewLifecycleService.teardownRepository).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count({ where: { id: row.id } })).toBe(0);
  });
});
