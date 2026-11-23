// MOTIR-12107 — a hosted application's idle policy, against real Postgres and the
// deploy port's fake: a new application's default by target and shape, the
// backfill of existing rows, the release path deploying the stored policy, and
// the switch — redeploying the serving release's own artifact with the new
// policy (no build) and storing it only once that release is live, with every
// refusal typed and changing nothing.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdlePolicyUnsupportedError,
  type DeployReleaseInput,
  type FakeHostingControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  CustomerRepositoryNotDeployableError,
  IdlePolicyApplyFailedError,
  IdlePolicyNotPermittedError,
  IdlePolicyUnsupportedForTargetError,
  NoProductionApplicationError,
  ReleaseInProgressError,
} from '@/lib/hosting/errors';
import { HOSTED_IDLE_SECONDS_DEFAULT, type HostedIdlePolicy } from '@/lib/hosting/idlePolicy';
import type { HostingManifest } from '@/lib/hosting/manifest';
import type { HostingShape, HostingTarget } from '@/lib/hosting/vocabulary';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedIdlePolicyService as service } from '@/lib/services/hostedIdlePolicyService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { releaseDeploymentStatusService } from '@/lib/services/releaseDeploymentStatusService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'none' },
};
const SUSPEND: HostedIdlePolicy = { mode: 'suspend', idleSeconds: 600 };
const ALWAYS_ON: HostedIdlePolicy = { mode: 'always_on' };

function hosting(target: HostingTarget = 'fly') {
  return getHostingDeployPort(target) as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', 'cd'.repeat(32));
  resetHostingFakes();
  resetDatabaseFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
}

async function repo(
  fx: WorkItemFixture,
  opts: { target?: HostingTarget; shape?: HostingShape; seedSource?: string } = {},
): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'repo-web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      seedSource: opts.seedSource ?? 'initialised',
      state: 'created',
      hostingTarget: opts.target ?? 'fly',
      hostingShape: opts.shape ?? null,
    },
  });
  return row.id;
}

const deploy = (projectRepositoryId: string, commitSha: string) =>
  productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha,
    artifactRef: `registry.example/mh-${projectRepositoryId}:${commitSha}`,
    cause: 'merge',
  });

async function application(projectRepositoryId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId } });
}

async function releasesOf(projectRepositoryId: string) {
  const app = await application(projectRepositoryId);
  return adminDb.hostedRelease.findMany({
    where: { applicationId: app.id },
    orderBy: { createdAt: 'asc' },
  });
}

/** The idle policy of every deploy the fake port was asked for, in order. */
function spyDeploys(target: HostingTarget = 'fly') {
  return vi.spyOn(hosting(target), 'deploy');
}
const deployInputs = (spy: ReturnType<typeof spyDeploys>) =>
  spy.mock.calls.map(([input]) => input as DeployReleaseInput);

async function member(fx: WorkItemFixture) {
  await projectMembersService.setAccessMode({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    mode: 'members',
  });
  const user = await usersService.createUser({
    email: 'member@idle.test',
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('a new application’s idle policy', () => {
  it.each([
    ['fly', undefined],
    ['serverless', undefined],
    ['aws', 'function'],
  ] as const)('starts suspend-when-idle on %s %s', async (target, shape) => {
    const fx = await workspace();
    const id = await repo(fx, { target, ...(shape ? { shape } : {}) });

    const app = await hostedApplicationService.ensureApplication(id);

    expect(app.idlePolicy).toEqual({ mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT });
    expect(await application(id)).toMatchObject({
      idleMode: 'suspend',
      idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT,
    });
  });

  it('starts always on for an AWS container, whose shape runs always on only', async () => {
    const fx = await workspace();
    const id = await repo(fx, { target: 'aws', shape: 'container' });

    const app = await hostedApplicationService.ensureApplication(id);

    expect(app.idlePolicy).toEqual({ mode: 'always_on' });
    expect(await application(id)).toMatchObject({ idleMode: 'always_on', idleSeconds: null });
  });

  it('reads a row written without the columns — every row that existed — as always on', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    // The migration's backfill: the column default fills a row that names neither.
    await adminDb.$executeRaw`
      INSERT INTO "hosted_application" ("id", "workspace_id", "project_id",
        "project_repository_id", "target", "slug", "created_at", "updated_at")
      VALUES (${'legacy-app'}, ${fx.workspaceId}, ${fx.projectId}, ${id},
        'fly'::"hosting_target", ${'legacy'}, NOW(), NOW())`;

    expect(await application(id)).toMatchObject({ idleMode: 'always_on', idleSeconds: null });
    expect((await hostedApplicationService.ensureApplication(id)).idlePolicy).toEqual(ALWAYS_ON);
  });

  it('cannot store a window without suspend, or suspend without one', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const app = await hostedApplicationService.ensureApplication(id);

    await expect(
      adminDb.hostedApplication.update({
        where: { id: app.id },
        data: { idleMode: 'always_on', idleSeconds: 300 },
      }),
    ).rejects.toThrow(/hosted_application_idle_seconds_iff_suspend/);
    await expect(
      adminDb.hostedApplication.update({
        where: { id: app.id },
        data: { idleMode: 'suspend', idleSeconds: null },
      }),
    ).rejects.toThrow(/hosted_application_idle_seconds_iff_suspend/);
  });
});

describe('the release path', () => {
  it('deploys the application’s stored policy, not a hard-coded always on', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const spy = spyDeploys();

    await deploy(id, SHA_A);
    const app = await application(id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { idleMode: 'always_on', idleSeconds: null },
    });
    await deploy(id, SHA_B);

    expect(deployInputs(spy).map((i) => i.idle)).toEqual([
      { mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT },
      { mode: 'always_on' },
    ]);
  });
});

describe('setIdlePolicy with a serving release', () => {
  it('redeploys the serving artifact with the new policy, no build, then stores it', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await deploy(id, SHA_A);
    const spy = spyDeploys();

    const answer = await service.setIdlePolicy({
      projectRepositoryId: id,
      policy: ALWAYS_ON,
      actor: fx.ctx,
    });

    expect(answer).toEqual({ policy: ALWAYS_ON, editable: true, refusal: null });
    const [input] = deployInputs(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(input!.artifact).toEqual({ kind: 'image', ref: first.artifactRef });
    expect(input!.idle).toEqual(ALWAYS_ON);
    expect(await application(id)).toMatchObject({ idleMode: 'always_on', idleSeconds: null });

    // A new release of the same commit and image, recorded as the switch.
    const releases = await releasesOf(id);
    expect(releases.map((r) => [r.commitSha, r.cause, r.state])).toEqual([
      [SHA_A, 'merge', 'replaced'],
      [SHA_A, 'idle_policy', 'live'],
    ]);
    expect(releases[1]!.artifactRef).toBe(first.artifactRef);
    expect(releases[1]!.requestedById).toBe(fx.ownerId);
    expect(hosting().app(`mh-${id}`)!.live!.image).toContain(SHA_A);
  });

  it('keeps rollback working: the previous release is the one the switch replaced', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await deploy(id, SHA_A);

    await service.setIdlePolicy({ projectRepositoryId: id, policy: ALWAYS_ON, actor: fx.ctx });

    const app = await application(id);
    expect(app.previousReleaseId).toBe(first.id);
    expect(
      (await hostedApplicationService.getApplicationForRepositorySystem(id))!.previousRelease,
    ).toMatchObject({ id: first.id, providerReleaseId: first.providerReleaseId });
  });

  it('does nothing for the policy already stored', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await deploy(id, SHA_A);
    const spy = spyDeploys();

    await service.setIdlePolicy({
      projectRepositoryId: id,
      policy: { mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT },
      actor: fx.ctx,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(await releasesOf(id)).toHaveLength(1);
  });

  it('refuses suspend on an AWS container by the port’s rule, writing and deploying nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx, { target: 'aws', shape: 'container' });
    await deploy(id, SHA_A);
    const before = await releasesOf(id);
    const live = hosting('aws').app(`mh-${id}`)!.live;
    const spy = spyDeploys('aws');

    const refused = await service
      .setIdlePolicy({ projectRepositoryId: id, policy: SUSPEND, actor: fx.ctx })
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(IdlePolicyUnsupportedForTargetError);
    expect(refused).toMatchObject({
      code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
      target: 'aws',
      shape: 'container',
      mode: 'suspend',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(await releasesOf(id)).toEqual(before);
    expect(await application(id)).toMatchObject({ idleMode: 'always_on' });
    expect(hosting('aws').app(`mh-${id}`)!.live).toEqual(live);
  });

  it('maps the port refusing at deploy to the same refusal, storing nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await deploy(id, SHA_A);
    vi.spyOn(hosting(), 'deploy').mockRejectedValueOnce(
      new IdlePolicyUnsupportedError('fly', 'machine', 'always_on'),
    );

    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: ALWAYS_ON, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(IdlePolicyUnsupportedForTargetError);

    const app = await application(id);
    expect(app).toMatchObject({ idleMode: 'suspend', currentReleaseId: first.id });
    expect(hosting().app(`mh-${id}`)!.live!.releaseId).toBe(first.providerReleaseId);
  });

  it('answers a failed redeploy as typed, the serving release and stored policy unchanged', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await deploy(id, SHA_A);
    hosting().failNext('deploy');

    const failed = await service
      .setIdlePolicy({ projectRepositoryId: id, policy: ALWAYS_ON, actor: fx.ctx })
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(IdlePolicyApplyFailedError);
    const app = await application(id);
    expect(app).toMatchObject({ idleMode: 'suspend', currentReleaseId: first.id });
    const releases = await releasesOf(id);
    expect(releases.map((r) => [r.cause, r.state])).toEqual([
      ['merge', 'live'],
      ['idle_policy', 'failed'],
    ]);
    expect((failed as IdlePolicyApplyFailedError).releaseId).toBe(releases[1]!.id);
  });

  it('refuses while a release is in flight, storing and deploying nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await deploy(id, SHA_A);
    const app = await application(id);
    await adminDb.hostedRelease.create({
      data: {
        workspaceId: fx.workspaceId,
        applicationId: app.id,
        commitSha: SHA_B,
        cause: 'merge',
        state: 'building',
      },
    });
    const spy = spyDeploys();

    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: ALWAYS_ON, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(ReleaseInProgressError);

    expect(spy).not.toHaveBeenCalled();
    expect(await application(id)).toMatchObject({ idleMode: 'suspend' });
  });
});

describe('setIdlePolicy with nothing serving', () => {
  it('stores the policy without deploying', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await hostedApplicationService.ensureApplication(id);
    const spy = spyDeploys();

    const answer = await service.setIdlePolicy({
      projectRepositoryId: id,
      policy: SUSPEND,
      actor: fx.ctx,
    });

    expect(answer.policy).toEqual(SUSPEND);
    expect(spy).not.toHaveBeenCalled();
    expect(await application(id)).toMatchObject({ idleMode: 'suspend', idleSeconds: 600 });
  });

  it('checks the target’s shape first: suspend on an AWS container is refused and not stored', async () => {
    const fx = await workspace();
    const id = await repo(fx, { target: 'aws', shape: 'container' });
    await hostedApplicationService.ensureApplication(id);

    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: SUSPEND, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(IdlePolicyUnsupportedForTargetError);
    expect(await application(id)).toMatchObject({ idleMode: 'always_on', idleSeconds: null });
  });

  it('refuses a repository with no production application yet', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: SUSPEND, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(NoProductionApplicationError);
    expect(
      await service.readIdlePolicy({ projectRepositoryId: id, isAdministrator: true }),
    ).toEqual({ policy: null, editable: false, refusal: null });
  });
});

describe('who may change it', () => {
  it('refuses a project member who is not an administrator, storing and deploying nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await deploy(id, SHA_A);
    const viewer = await member(fx);
    const spy = spyDeploys();

    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: ALWAYS_ON, actor: viewer }),
    ).rejects.toBeInstanceOf(IdlePolicyNotPermittedError);

    expect(spy).not.toHaveBeenCalled();
    expect(await application(id)).toMatchObject({ idleMode: 'suspend' });
  });

  it('reads the policy with editable only for an administrator, and names the refused mode', async () => {
    const fx = await workspace();
    const id = await repo(fx, { target: 'aws', shape: 'container' });
    await hostedApplicationService.ensureApplication(id);

    expect(
      await service.readIdlePolicy({ projectRepositoryId: id, isAdministrator: false }),
    ).toEqual({
      policy: ALWAYS_ON,
      editable: false,
      refusal: {
        code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
        target: 'aws',
        shape: 'container',
        mode: 'suspend',
      },
    });
    expect(
      (await service.readIdlePolicy({ projectRepositoryId: id, isAdministrator: true })).editable,
    ).toBe(true);
  });
});

describe('a customer repository', () => {
  it('has no policy to read or change, and nothing is created, deployed or written', async () => {
    const fx = await workspace();
    const id = await repo(fx, { seedSource: 'organization' });
    const spy = spyDeploys();
    // Nothing here writes the project: its row stays as it was.
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    await expect(
      service.readIdlePolicy({ projectRepositoryId: id, isAdministrator: true }),
    ).rejects.toBeInstanceOf(CustomerRepositoryNotDeployableError);
    await expect(
      service.setIdlePolicy({ projectRepositoryId: id, policy: SUSPEND, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(CustomerRepositoryNotDeployableError);

    expect(spy).not.toHaveBeenCalled();
    expect(await adminDb.hostedApplication.count()).toBe(0);
    expect(await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).toEqual(
      project,
    );
  });
});
