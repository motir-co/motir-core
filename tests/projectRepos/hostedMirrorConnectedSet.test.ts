import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { hostedMirrorRetirementService } from '@/lib/services/hostedMirrorRetirementService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { liveOrganizationReposService } from '@/lib/services/liveOrganizationReposService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { ProjectRepoInvalidFieldError } from '@/lib/projectRepos/errors';
import { SEED_SOURCE_FLY_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A MOTIR-HOSTED REPOSITORY IS ITS PROJECT'S, NEVER THE ORGANISATION'S
// (bug MOTIR-12192), over real Postgres.
//
// What is pinned, each by RUNNING it:
//   1. Settings › Organisation › Git's inventory and the project picker never
//      carry a repository Motir hosts — held by a project or not — and a link
//      by id that skips the picker is refused the same way;
//   2. a RETIRED mirror leaves every connected-set read: the first-index pass's
//      population, motir-ai's reconcile inventory, the organisation's list, the
//      CI fleet's live list, the index sweeps and the link-by-coordinates read;
//   3. the data migration (`hostedMirrorRetirementService.sweep`) retires exactly
//      the hosted mirrors no project holds, is idempotent, rehearses with a dry
//      run, and never touches an imported repository or a held hosted one;
//   4. a retired mirror's pull requests stay readable;
//   5. mirroring a repository for a project again un-retires it.
//
// The owned-org set is the real `motirOwnedOrgLogins()`, configured through
// `GITHUB_FALLBACK_ORG` as a deployment configures it.

const MOTIR_ORG = 'motir-projects';

let fx: WorkItemFixture;
let orgId: string;
let customerInstallationId: string;
let hostInstallationId: string;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  customerInstallationId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'acme',
        accountType: 'Organization',
      },
    })
  ).id;
  hostInstallationId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `host-${fx.workspaceId}`,
        workspaceId: null,
        organizationId: null,
        accountLogin: MOTIR_ORG,
        accountType: 'Organization',
      },
    })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function mirror(opts: { owner: string; name: string; retiredAt?: Date | null }) {
  const hosted = opts.owner.toLowerCase() === MOTIR_ORG;
  return adminDb.githubRepo.create({
    data: {
      installationId: hosted ? hostInstallationId : customerInstallationId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: `${opts.owner}-${opts.name}`,
      owner: opts.owner,
      name: opts.name,
      defaultBranch: 'main',
      archived: false,
      retiredAt: opts.retiredAt ?? null,
    },
  });
}

/** The project row that HOLDS a mirror, as the creation primitive leaves it. */
function holdingRow(githubRepoId: string, name: string, projectId = fx.projectId) {
  return adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_FLY_STARTER,
      state: 'created',
      githubRepoId,
      position: `a${name.length}`,
    },
  });
}

async function secondProject() {
  return createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
  });
}

describe('the organisation-scoped surfaces leave a repository Motir hosts out', () => {
  it('Settings › Organisation › Git lists only the organisation’s own repositories', async () => {
    const own = await mirror({ owner: 'acme', name: 'web' });
    const heldHosted = await mirror({ owner: MOTIR_ORG, name: 'shop-web' });
    await holdingRow(heldHosted.id, 'shop-web');
    // A left-behind one, as production held two on 2026-11-24, and one whose
    // owner differs only in case (GitHub logins are case-insensitive).
    await mirror({ owner: MOTIR_ORG, name: 'motir' });
    await mirror({ owner: 'Motir-Projects', name: 'sandbox' });

    const inventory = await organizationRepoService.listInventory(fx.ctx);
    expect(inventory.map((row) => row.repo.id)).toEqual([own.id]);
    expect(inventory[0]!.repo.hostedByMotir).toBe(false);

    // The disconnect dialog's usage list is the same list (one read, both surfaces).
    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.map((row) => row.githubRepoId)).toEqual([own.id]);
  });

  it('the project picker never offers one, held or left behind', async () => {
    const own = await mirror({ owner: 'acme', name: 'api' });
    const heldHosted = await mirror({ owner: MOTIR_ORG, name: 'shop-web' });
    await holdingRow(heldHosted.id, 'shop-web');
    await mirror({ owner: MOTIR_ORG, name: 'motir' });
    const second = await secondProject();

    const options = await organizationRepoService.listAvailableForProject(second.id, fx.ctx);
    expect(options.map((option) => option.id)).toEqual([own.id]);
  });

  it('a link by id that skips the picker is refused like a repository the organisation lacks', async () => {
    const heldHosted = await mirror({ owner: MOTIR_ORG, name: 'shop-web' });
    await holdingRow(heldHosted.id, 'shop-web');
    const retiredOwn = await mirror({ owner: 'acme', name: 'old', retiredAt: new Date() });
    const second = await secondProject();

    for (const githubRepoId of [heldHosted.id, retiredOwn.id]) {
      await expect(
        organizationRepoService.linkExistingRepo(second.id, { githubRepoId, role: 'web' }, fx.ctx),
      ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    }
    expect(await adminDb.projectRepo.count({ where: { projectId: second.id } })).toBe(0);
  });

  it('with no owned org configured, Motir hosts nothing and every repository is listed', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    const repo = await mirror({ owner: MOTIR_ORG, name: 'motir' });
    const inventory = await organizationRepoService.listInventory(fx.ctx);
    expect(inventory.map((row) => row.repo.id)).toEqual([repo.id]);
  });
});

describe('a RETIRED mirror leaves every connected-set read', () => {
  it('first-index pass, reconcile inventory, org list, CI fleet, index sweeps, link-by-name', async () => {
    const live = await mirror({ owner: 'acme', name: 'web' });
    const retired = await mirror({ owner: MOTIR_ORG, name: 'motir', retiredAt: new Date() });
    // Both owe an index and are paused, so every sweep would select both.
    await adminDb.githubRepo.updateMany({
      where: { id: { in: [live.id, retired.id] } },
      data: {
        indexPausedReason: 'allowance',
        indexPausedAt: new Date(),
        indexedHeadSha: 'aaa',
        defaultBranchHeadSha: 'bbb',
      },
    });

    const reads = await withSystemContext(async (tx) => ({
      firstIndexPass: await githubRepoRepository.listWithInstallation(tx),
      firstIndexPassScoped: await githubRepoRepository.listWithInstallation(tx, {
        workspaceId: fx.workspaceId,
      }),
      reconcile: await githubRepoRepository.listRefsByOrganizations([orgId], tx),
      organisation: await githubRepoRepository.listByOrganization(orgId, tx),
      workspace: await githubRepoRepository.listByWorkspace(fx.workspaceId, tx),
      fleet: await githubRepoRepository.listLiveGithubByOrganizations([orgId], tx),
      drift: await githubRepoRepository.listNeedingDriftRecompute(10, tx),
      paused: await githubRepoRepository.listIndexPaused(10, tx),
      pausedOrgs: await githubRepoRepository.listIndexPausedOrgs(
        { reason: null, search: null, limit: 10, offset: 0 },
        tx,
      ),
      pausedRepos: await githubRepoRepository.listIndexPausedReposForOrgs([orgId], tx),
      byName: await githubRepoRepository.findConnectedByName(MOTIR_ORG, 'motir', tx),
      byOrgName: await githubRepoRepository.findConnectedByOrganizationAndName(
        orgId,
        MOTIR_ORG,
        'motir',
        tx,
      ),
      byWorkspaceName: await githubRepoRepository.findConnectedByWorkspaceAndName(
        fx.workspaceId,
        MOTIR_ORG,
        'motir',
        tx,
      ),
    }));

    expect(reads.firstIndexPass.map((r) => r.id)).toEqual([live.id]);
    expect(reads.firstIndexPassScoped.map((r) => r.id)).toEqual([live.id]);
    expect(reads.reconcile).toEqual([{ organizationId: orgId, owner: 'acme', name: 'web' }]);
    expect(reads.organisation.map((r) => r.id)).toEqual([live.id]);
    expect(reads.workspace.map((r) => r.id)).toEqual([live.id]);
    expect(reads.fleet.map((r) => r.id)).toEqual([live.id]);
    expect(reads.drift.map((r) => r.id)).toEqual([live.id]);
    expect(reads.paused.map((r) => r.id)).toEqual([live.id]);
    expect(reads.pausedOrgs.map((r) => r.pausedRepos)).toEqual([1]);
    expect(reads.pausedRepos).toHaveLength(1);
    expect(reads.byName).toEqual([]);
    expect(reads.byOrgName).toBeNull();
    expect(reads.byWorkspaceName).toBeNull();

    // motir-ai's reconcile reads it through this service; it no longer lists it.
    const answer = await liveOrganizationReposService.resolve([{ coreOrganizationId: orgId }]);
    expect(answer.organizations[0]).toMatchObject({ status: 'live', repoRefs: ['acme/web'] });
  });

  it('keeps the row, so its pull requests stay readable', async () => {
    const retired = await mirror({ owner: MOTIR_ORG, name: 'sandbox', retiredAt: new Date() });
    await adminDb.githubPullRequest.create({
      data: { repoId: retired.id, number: 7, state: 'closed', merged: true, headRef: 'feat' },
    });
    const pr = await adminDb.githubPullRequest.findFirst({
      where: { repoId: retired.id },
      include: { repo: true },
    });
    expect(pr).toMatchObject({ number: 7, repo: { owner: MOTIR_ORG, name: 'sandbox' } });
  });

  it('mirroring the repository for a project again rejoins the connected set', async () => {
    const retired = await mirror({ owner: MOTIR_ORG, name: 'sandbox', retiredAt: new Date() });
    const mirrored = await githubInstallationService.persistProvisionedRepo({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `host-${fx.workspaceId}`,
        accountLogin: MOTIR_ORG,
        accountType: 'Organization',
      },
      repo: {
        providerRepoId: retired.repoId,
        owner: MOTIR_ORG,
        name: 'sandbox',
        defaultBranch: 'main',
        archived: false,
      },
    });
    expect(mirrored.id).toBe(retired.id);
    expect(mirrored.retiredAt).toBeNull();
  });
});

describe('the data migration — hostedMirrorRetirementService.sweep', () => {
  async function estate() {
    const own = await mirror({ owner: 'acme', name: 'unused' });
    const held = await mirror({ owner: MOTIR_ORG, name: 'shop-web' });
    await holdingRow(held.id, 'shop-web');
    const sandbox = await mirror({ owner: MOTIR_ORG, name: 'motir-envcheck-sandbox' });
    const starter = await mirror({ owner: 'Motir-Projects', name: 'motir' });
    const already = await mirror({ owner: MOTIR_ORG, name: 'gone', retiredAt: new Date(0) });
    return { own, held, sandbox, starter, already };
  }

  it('retires exactly the hosted mirrors no project holds, and nothing else', async () => {
    const { own, held, sandbox, starter, already } = await estate();
    const now = new Date('2026-11-25T00:00:00Z');

    const report = await hostedMirrorRetirementService.sweep({ dryRun: false, now });

    // Candidates: every connected, unheld mirror (the imported one included).
    expect(report.scanned).toBe(3);
    expect(report.retired.map((m) => m.repoRef).sort()).toEqual([
      'Motir-Projects/motir',
      `${MOTIR_ORG}/motir-envcheck-sandbox`,
    ]);
    expect(report.retired[0]).toMatchObject({ organizationId: orgId, workspaceId: fx.workspaceId });
    const rows = await adminDb.githubRepo.findMany({ select: { id: true, retiredAt: true } });
    const retiredAt = new Map(rows.map((row) => [row.id, row.retiredAt]));
    expect(retiredAt.get(sandbox.id)).toEqual(now);
    expect(retiredAt.get(starter.id)).toEqual(now);
    expect(retiredAt.get(own.id)).toBeNull();
    expect(retiredAt.get(held.id)).toBeNull();
    expect(retiredAt.get(already.id)).toEqual(new Date(0));

    // Idempotent: a second run finds nothing to retire.
    const again = await hostedMirrorRetirementService.sweep({ dryRun: false });
    expect(again).toMatchObject({ scanned: 1, retired: [] });
  });

  it('a dry run lists the same mirrors and writes nothing', async () => {
    const { sandbox, starter } = await estate();
    const report = await hostedMirrorRetirementService.sweep({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.retired.map((m) => m.id).sort()).toEqual([sandbox.id, starter.id].sort());
    expect(await adminDb.githubRepo.count({ where: { retiredAt: { not: null } } })).toBe(1);
  });

  it('skips a mirror a project linked between the list and the write', async () => {
    const sandbox = await mirror({ owner: MOTIR_ORG, name: 'sandbox' });
    const list = githubRepoRepository.listConnectedUnheld.bind(githubRepoRepository);
    vi.spyOn(githubRepoRepository, 'listConnectedUnheld').mockImplementation(async (tx) => {
      const rows = await list(tx);
      await holdingRow(sandbox.id, 'sandbox');
      return rows;
    });
    const report = await hostedMirrorRetirementService.sweep({ dryRun: false });
    expect(report.retired).toEqual([]);
    expect((await adminDb.githubRepo.findUnique({ where: { id: sandbox.id } }))?.retiredAt).toBe(
      null,
    );
  });

  it('retireIfHostedAndUnheld leaves a missing mirror and an imported one alone', async () => {
    const own = await mirror({ owner: 'acme', name: 'unused' });
    expect(await hostedMirrorRetirementService.retireIfHostedAndUnheld(null)).toBe(false);
    expect(await hostedMirrorRetirementService.retireIfHostedAndUnheld(own)).toBe(false);
    expect((await adminDb.githubRepo.findUnique({ where: { id: own.id } }))?.retiredAt).toBe(null);
  });
});
