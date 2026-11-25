import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { repoDeletionClient } from '@/lib/github/repoDeletion';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import {
  AWS_DEPLOY_CHECK_REPOSITORY_PREFIX,
  awsDeployCheckRepositoryName,
  awsDeployCheckRepositoryService,
  DeployCheckProjectNotFoundError,
} from '@/lib/services/awsDeployCheckRepositoryService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE AWS DEPLOY CHECK'S OWN REPOSITORY (bug MOTIR-12243), over real Postgres.
//
// What is pinned, each by RUNNING it:
//   1. `ensure` finds the project by key INSIDE the organisation (another
//      organisation's project of the same key is not it; two in one organisation
//      are refused), and creates the check's row through the creation door AS THE
//      MOTIR SYSTEM ACCOUNT — a Motir-created row (`initialised`, role `other`)
//      the AWS adapter hosts, never an `organization` one it refuses;
//   2. a re-run answers the same row (`already_settled`) and leaves no second one;
//   3. a failed establish comes back as `failed` with the pass's own reason;
//   4. `remove` deletes the check's row and its GitHub repository through the
//      Repositories room's own delete, as the system account, and keeps any row
//      whose name is not the check's; an absent row is `absent`.
//
// The host boundaries are faked where they are crossed: the establish pass's
// GitHub work (`establishSet` — its own suites drive it against GitHub), the
// preview services and the GitHub delete client. Every database write is real.

vi.mock('@/lib/ciMetering/ownedOrgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ciMetering/ownedOrgs')>()),
  motirOwnedOrgLogins: vi.fn(async () => [MOTIR_ORG]),
}));

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '998877';

let fx: WorkItemFixture;
let organizationId: string;
let establishFails: boolean;

/** What the establish pass leaves on success: a GitHub repository in Motir's
 *  hosted organisation, mirrored and attached; the row `created`. */
async function realize(rowId: string, name: string): Promise<void> {
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
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: `host-${name}`,
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  await adminDb.projectRepo.update({
    where: { id: rowId },
    data: { state: 'created', githubRepoId: mirror.id },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  organizationId = fx.workspace.organizationId;
  const meta = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
  await seedSystemPrincipal({ workspaceId: meta.workspaceId, projectId: meta.projectId });
  establishFails = false;

  // The establish pass, as it settles exactly the row it is handed — observed
  // through the set the creation door appended to.
  vi.spyOn(projectRepoProvisioningService, 'establishSet').mockImplementation(
    async (projectId, ctx, options = {}) => {
      const rows = await projectRepoSetService.listByProject(projectId, ctx);
      const mine = rows.find((r) => r.id === options.rowId)!;
      if (mine.state === 'created') {
        return {
          projectId,
          rows: [{ rowId: mine.id, name: mine.name, outcome: 'already_settled', row: mine }],
        };
      }
      if (establishFails) {
        await adminDb.projectRepo.update({
          where: { id: mine.id },
          data: { state: 'failed', failureReason: 'GitHub refused the repository' },
        });
        const failed = (await projectRepoSetService.listByProject(projectId, ctx)).find(
          (r) => r.id === mine.id,
        )!;
        return {
          projectId,
          rows: [
            {
              rowId: mine.id,
              name: mine.name,
              outcome: 'failed',
              row: failed,
              failureCode: 'REPO_CREATE_FAILED',
              failureReason: 'GitHub refused the repository',
            },
          ],
        };
      }
      await realize(mine.id, mine.name);
      const settled = (await projectRepoSetService.listByProject(projectId, ctx)).find(
        (r) => r.id === mine.id,
      )!;
      return {
        projectId,
        rows: [{ rowId: mine.id, name: mine.name, outcome: 'created', row: settled }],
      };
    },
  );
  vi.spyOn(previewEnablementService, 'disable').mockResolvedValue('disabled');
  vi.spyOn(previewLifecycleService, 'teardownRepository').mockResolvedValue({
    closed: 0,
    usage: [],
  });
  vi.spyOn(repoDeletionClient, 'deleteRepo').mockResolvedValue('deleted');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(motirOwnedOrgLogins).mockImplementation(async () => [MOTIR_ORG]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const args = (shape: 'function' | 'container' = 'function') => ({
  organizationId,
  projectKey: fx.projectIdentifier,
  shape,
});

describe('ensure', () => {
  it('creates a Motir-created repository for the shape, as the Motir system account', async () => {
    const made = await awsDeployCheckRepositoryService.ensure(args('function'));
    expect(made).toEqual({
      repositoryId: expect.any(String),
      name: 'motir-deploy-check-aws-function',
      outcome: 'created',
      state: 'created',
      githubRepository: `${MOTIR_ORG}/motir-deploy-check-aws-function`,
      failureCode: null,
      failureReason: null,
    });

    const row = await adminDb.projectRepo.findUniqueOrThrow({
      where: { id: made.repositoryId },
      include: { githubRepo: true },
    });
    // Not `organization`: the AWS adapter hosts this row instead of refusing it.
    expect(row).toMatchObject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      seedSource: SEED_SOURCE_INITIALISED,
      role: 'other',
    });
    expect(row.githubRepo?.repoId).toBe('host-motir-deploy-check-aws-function');

    const system = await adminDb.user.findUniqueOrThrow({
      where: { email: MOTIR_SYSTEM_USER_EMAIL },
    });
    const [, ctx] = vi.mocked(projectRepoProvisioningService.establishSet).mock.calls[0]!;
    expect(ctx).toEqual({ userId: system.id, workspaceId: fx.workspaceId });
  });

  it('a re-run answers the same repository and leaves no second one; the other shape is its own', async () => {
    const first = await awsDeployCheckRepositoryService.ensure(args('function'));
    const again = await awsDeployCheckRepositoryService.ensure(args('function'));
    expect(again).toMatchObject({ repositoryId: first.repositoryId, outcome: 'already_settled' });
    const container = await awsDeployCheckRepositoryService.ensure(args('container'));
    expect(container.repositoryId).not.toBe(first.repositoryId);
    expect(container.name).toBe(awsDeployCheckRepositoryName('container'));

    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows.map((r) => r.name).sort()).toEqual([
      'motir-deploy-check-aws-container',
      'motir-deploy-check-aws-function',
    ]);
  });

  it('a failed establish answers `failed` with the pass’s own code and reason', async () => {
    establishFails = true;
    const made = await awsDeployCheckRepositoryService.ensure(args('function'));
    expect(made).toMatchObject({
      outcome: 'failed',
      state: 'failed',
      githubRepository: null,
      failureCode: 'REPO_CREATE_FAILED',
      failureReason: 'GitHub refused the repository',
    });
  });

  it('takes the project of the given organisation, not another of the same key', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: fx.projectIdentifier });
    expect(other.workspace.organizationId).not.toBe(organizationId);
    const made = await awsDeployCheckRepositoryService.ensure(args());
    const row = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: made.repositoryId } });
    expect(row.projectId).toBe(fx.projectId);
    expect(await adminDb.projectRepo.count({ where: { projectId: other.projectId } })).toBe(0);
  });

  it('refuses a key the organisation has no project for, creating nothing', async () => {
    await expect(
      awsDeployCheckRepositoryService.ensure({ ...args(), projectKey: 'NOPE' }),
    ).rejects.toMatchObject({
      code: 'DEPLOY_CHECK_PROJECT_NOT_FOUND',
      message: `Organisation ${organizationId} has no project keyed NOPE.`,
    });
    expect(await adminDb.projectRepo.count()).toBe(0);
  });

  it('refuses a key two of the organisation’s workspaces share, creating nothing', async () => {
    const twin = await makeWorkItemFixture({ name: 'Twin', identifier: fx.projectIdentifier });
    await adminDb.workspace.update({
      where: { id: twin.workspaceId },
      data: { organizationId },
    });
    const refusal = awsDeployCheckRepositoryService.ensure(args());
    await expect(refusal).rejects.toBeInstanceOf(DeployCheckProjectNotFoundError);
    await expect(refusal).rejects.toMatchObject({
      matches: 2,
      message: expect.stringMatching(/has 2 projects keyed PROD/),
    });
    expect(await adminDb.projectRepo.count()).toBe(0);
  });
});

describe('remove', () => {
  it('deletes the check’s repository on GitHub and its row, as the Motir system account', async () => {
    const made = await awsDeployCheckRepositoryService.ensure(args());
    expect(await awsDeployCheckRepositoryService.remove(made.repositoryId)).toBe('removed');
    expect(await adminDb.projectRepo.findUnique({ where: { id: made.repositoryId } })).toBeNull();
    expect(repoDeletionClient.deleteRepo).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      owner: MOTIR_ORG,
      repo: 'motir-deploy-check-aws-function',
    });

    // And a second destroy finds it gone.
    expect(await awsDeployCheckRepositoryService.remove(made.repositoryId)).toBe('absent');
  });

  it('keeps a repository whose name is not the check’s', async () => {
    const row = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'web',
        name: 'billing-web',
        seedSource: SEED_SOURCE_INITIALISED,
        state: 'created',
        position: 'a0',
      },
    });
    expect(row.name.startsWith(AWS_DEPLOY_CHECK_REPOSITORY_PREFIX)).toBe(false);
    expect(await awsDeployCheckRepositoryService.remove(row.id)).toBe('kept');
    expect(await adminDb.projectRepo.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(repoDeletionClient.deleteRepo).not.toHaveBeenCalled();
  });

  it('answers `absent` for an id that names no row', async () => {
    expect(await awsDeployCheckRepositoryService.remove('cmnorow0000000000000000')).toBe('absent');
  });
});
