// MOTIR-10035 — roll back production, against real Postgres and the deploy
// port's fake: the previous release serves again and the left one becomes the
// previous, the usage of the leaving release is settled before the port call,
// every refusal is typed and changes nothing, a port failure changes nothing and
// leaks nothing, two rollbacks at once stay consistent with the port, and the
// state changes announce their GitHub statuses after commit without this service
// posting any.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IllegalReleaseTransitionError,
  NoPreviousReleaseError,
  ReleaseInProgressError,
  RollbackFailedError,
  RollbackNotPermittedError,
} from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { HOSTED_RELEASE_TRANSITIONS } from '@/lib/hosting/vocabulary';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { productionRollbackService as service } from '@/lib/services/productionRollbackService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { releaseDeploymentStatusService } from '@/lib/services/releaseDeploymentStatusService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

const CONNECTION_STRING = /postgres(ql)?:\/\//;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

let logged: string[];
let announced: string[];

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', 'cd'.repeat(32));
  resetHostingFakes();
  resetDatabaseFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  announced = [];
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockImplementation(
    async (releaseId) => {
      announced.push(releaseId);
    },
  );
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a),
          )
          .join(' '),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

async function repo(
  fx: WorkItemFixture,
  opts: { role?: 'web' | 'api'; seedSource?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'web';
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      seedSource: opts.seedSource ?? 'initialised',
      state: 'created',
      hostingTarget: 'fly',
    },
  });
  return row.id;
}

const deploy = (projectRepositoryId: string, commitSha: string) =>
  productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha,
    artifactRef: `registry.fly.io/mh-${projectRepositoryId}:${commitSha}`,
    cause: 'merge',
  });

/** Two releases: A replaced, B live and current. */
async function twoReleases(projectRepositoryId: string) {
  const a = await deploy(projectRepositoryId, SHA_A);
  const b = await deploy(projectRepositoryId, SHA_B);
  return { a, b };
}

async function application(projectRepositoryId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId } });
}

async function releaseRow(id: string) {
  return adminDb.hostedRelease.findUniqueOrThrow({ where: { id } });
}

async function snapshot(projectRepositoryId: string) {
  const app = await application(projectRepositoryId);
  const releases = await adminDb.hostedRelease.findMany({
    where: { applicationId: app.id },
    orderBy: { id: 'asc' },
  });
  return {
    pointers: [app.currentReleaseId, app.previousReleaseId],
    releases: releases.map((r) => [r.id, r.state, r.liveAt?.toISOString() ?? null]),
  };
}

/** A project member and a workspace member outside the project. */
async function nonAdmins(fx: WorkItemFixture) {
  await projectMembersService.setAccessMode({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    mode: 'members',
  });
  const member = await usersService.createUser({
    email: 'member@rollback.test',
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: member.id,
    role: 'member',
  });
  const outsider = await usersService.createUser({
    email: 'outsider@rollback.test',
    password: 'hunter2hunter2',
    name: 'Outsider',
  });
  await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
  return {
    member: { userId: member.id, workspaceId: fx.workspaceId },
    outsider: { userId: outsider.id, workspaceId: fx.workspaceId },
  };
}

describe('rollbackProduction', () => {
  it('serves the previous release again and makes the left one the previous', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);

    const app = await service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx });

    expect(app.currentRelease).toMatchObject({
      id: a.id,
      state: 'live',
      restoredBy: { id: fx.ownerId, name: fx.owner.name },
    });
    expect(app.currentRelease!.restoredAt).not.toBeNull();
    expect(app.previousRelease).toMatchObject({ id: b.id, state: 'rolled_back' });
    const stored = await application(id);
    expect([stored.currentReleaseId, stored.previousReleaseId]).toEqual([a.id, b.id]);
    expect(hosting().app(`mh-${id}`)!.live!.image).toContain(SHA_A);
  });

  it('settles the leaving release, then calls the port rollback once with no env or database', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);
    await adminDb.hostedRelease.update({
      where: { id: b.id },
      data: { liveAt: hosting().now() },
    });
    hosting().advanceSeconds(300);
    const aBefore = await releaseRow(a.id);
    await adminDb.hostedRelease.update({
      where: { id: a.id },
      data: { usageSettledUntil: aBefore.liveAt },
    });
    const from = hosting().calls.length;

    await service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx });

    const calls = hosting().calls.slice(from);
    const ops = calls.map((c) => c.operation);
    expect(ops.filter((o) => o === 'rollback')).toHaveLength(1);
    expect(ops.indexOf('usageSince')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('usageSince')).toBeLessThan(ops.indexOf('rollback'));
    const rollback = calls.find((c) => c.operation === 'rollback')!;
    expect(rollback.appRef).toBe(`mh-${id}`);
    expect(rollback.envNames).toBeUndefined();
    expect(ops).not.toContain('runReleaseCommand');
    expect(ops).not.toContain('deploy');

    expect((await releaseRow(b.id)).usageSeconds).toBe(300);
    const restored = await releaseRow(a.id);
    expect(restored.liveAt!.getTime()).toBeGreaterThan(aBefore.liveAt!.getTime());
    expect(restored.usageSettledUntil).toBeNull();
    expect(restored.endedAt).toBeNull();
  });

  it('announces both state changes after commit and posts no status itself', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);
    announced = [];

    await service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx });

    expect([...new Set(announced)].sort()).toEqual([a.id, b.id].sort());
  });

  it('rolls back again to the release the first rollback took out', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);
    await service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx });

    const app = await service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx });

    expect(app.currentRelease).toMatchObject({ id: b.id, state: 'live' });
    expect(app.previousRelease).toMatchObject({ id: a.id, state: 'rolled_back' });
  });

  it('refuses with no previous release, before any port call, changing nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await deploy(id, SHA_A);
    const before = await snapshot(id);
    const from = hosting().calls.length;

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);

    expect(hosting().calls.slice(from)).toEqual([]);
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses when the previous release never went live, or nothing is live', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);
    await adminDb.hostedRelease.update({ where: { id: a.id }, data: { state: 'failed' } });
    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);

    await adminDb.hostedRelease.update({ where: { id: a.id }, data: { state: 'replaced' } });
    await adminDb.hostedRelease.update({ where: { id: b.id }, data: { state: 'replaced' } });
    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    expect(hosting().calls.map((c) => c.operation)).not.toContain('rollback');
  });

  it('maps the port’s own no-previous-release refusal to the domain one', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const { NoPreviousReleaseError: PortNoPrevious } = await import('@motir/orchestrator');
    vi.spyOn(hosting(), 'rollback').mockRejectedValue(new PortNoPrevious(`mh-${id}`));
    const before = await snapshot(id);

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses a project member and a user outside the project, touching nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const { member, outsider } = await nonAdmins(fx);
    const before = await snapshot(id);
    const from = hosting().calls.length;

    for (const actor of [member, outsider]) {
      await expect(
        service.rollbackProduction({ projectRepositoryId: id, actor }),
      ).rejects.toBeInstanceOf(RollbackNotPermittedError);
    }

    expect(hosting().calls.slice(from)).toEqual([]);
    expect(await snapshot(id)).toEqual(before);
    const leaving = await adminDb.hostedRelease.findFirstOrThrow({ where: { state: 'live' } });
    expect(leaving.usageSeconds).toBeNull();
  });

  it('lets an unexpected permission failure through untouched', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const { projectAccessService } = await import('@/lib/services/projectAccessService');
    const boom = new Error('database down');
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(boom);

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBe(boom);
  });

  it('refuses a customer repository and a repository with no application, with no port call', async () => {
    const fx = await workspace();
    const customer = await repo(fx, { seedSource: 'organization' });
    const bare = await repo(fx, { role: 'api' });

    await expect(
      service.rollbackProduction({ projectRepositoryId: customer, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(CustomerRepositoryNotDeployableError);
    await expect(
      service.rollbackProduction({ projectRepositoryId: bare, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    await expect(
      service.rollbackProduction({ projectRepositoryId: 'missing', actor: fx.ctx }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    expect(hosting().calls).toEqual([]);
    expect(await adminDb.hostedRelease.count()).toBe(0);
  });

  it('refuses while a release is in flight, with no port call', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const app = await application(id);
    await hostedApplicationService.createRelease({
      applicationId: app.id,
      commitSha: SHA_C,
      cause: 'merge',
    });
    const from = hosting().calls.length;

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(ReleaseInProgressError);
    expect(hosting().calls.slice(from)).toEqual([]);
  });

  it('changes nothing and leaks nothing when the port rollback fails', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const before = await snapshot(id);
    vi.spyOn(hosting(), 'rollback').mockRejectedValue(
      Object.assign(new Error('cannot reach postgresql://app:hunter2@db/app'), {
        code: 'FLY_UNAVAILABLE',
      }),
    );

    const error = await service
      .rollbackProduction({ projectRepositoryId: id, actor: fx.ctx })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RollbackFailedError);
    expect(error).toMatchObject({ step: 'rollback', status: null, causeCode: 'FLY_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toMatch(CONNECTION_STRING);
    expect((error as Error).message).not.toMatch(CONNECTION_STRING);
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
    expect(await snapshot(id)).toEqual(before);
  });

  it('keeps an unnamed port failure to its class name, and an unknown one to UNKNOWN', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await twoReleases(id);
    const spy = vi.spyOn(hosting(), 'rollback');

    spy.mockRejectedValueOnce(new TypeError('postgres://leak'));
    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toMatchObject({ causeCode: 'TypeError' });
    spy.mockRejectedValueOnce('postgres://leak');
    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toMatchObject({ causeCode: 'UNKNOWN' });
    // Persistent: the usage settle asks for the app first, and gives up quietly.
    vi.spyOn(hosting(), 'ensureApp').mockRejectedValue(
      Object.assign(new Error('x'), { name: 'OrchestratorApiError' }),
    );
    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toMatchObject({ step: 'app' });
  });

  it('fails closed when the port restores a release the rows do not expect', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { b } = await twoReleases(id);
    const row = await releaseRow(b.id);
    vi.spyOn(hosting(), 'rollback').mockResolvedValue({
      target: 'fly',
      appRef: `mh-${id}`,
      environment: { kind: 'production' },
      releaseId: row.providerReleaseId!,
      providerRef: row.providerRef!,
    });
    const before = await snapshot(id);

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toMatchObject({ step: 'verify', causeCode: 'RESTORED_RELEASE_MISMATCH' });
    expect(await snapshot(id)).toEqual(before);
  });

  it('fails closed when the pointers moved while the port rolled back', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);
    const port = hosting();
    const inner = port.rollback.bind(port);
    vi.spyOn(port, 'rollback').mockImplementation(async (input) => {
      const handle = await inner(input);
      const app = await application(id);
      await adminDb.hostedApplication.update({
        where: { id: app.id },
        data: { previousReleaseId: null },
      });
      return handle;
    });

    await expect(
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ).rejects.toBeInstanceOf(IllegalReleaseTransitionError);
    expect((await releaseRow(a.id)).state).toBe('replaced');
    expect((await releaseRow(b.id)).state).toBe('live');
  });

  it('stays consistent with the port when two rollbacks run at once', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const { a, b } = await twoReleases(id);

    const outcomes = await Promise.allSettled([
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
      service.rollbackProduction({ projectRepositoryId: id, actor: fx.ctx }),
    ]);

    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason).toHaveProperty('code');
    }
    const app = await application(id);
    expect(app.currentReleaseId).not.toBe(app.previousReleaseId);
    expect([app.currentReleaseId, app.previousReleaseId].sort()).toEqual([a.id, b.id].sort());
    const current = await releaseRow(app.currentReleaseId!);
    const previous = await releaseRow(app.previousReleaseId!);
    expect(current.state).toBe('live');
    expect(['replaced', 'rolled_back']).toContain(previous.state);
    // The rows agree with what the port is serving.
    expect(hosting().app(`mh-${id}`)!.live!.releaseId).toBe(current.providerReleaseId);
  });

  it('rolls back one application without touching another in the project', async () => {
    const fx = await workspace();
    const web = await repo(fx, { role: 'web' });
    const api = await repo(fx, { role: 'api' });
    await twoReleases(web);
    await twoReleases(api);
    const other = await snapshot(api);

    await service.rollbackProduction({ projectRepositoryId: web, actor: fx.ctx });

    expect(await snapshot(api)).toEqual(other);
  });
});

describe('the legal-edge table', () => {
  it('lets a replaced or rolled-back release return to live, and nothing else revives', () => {
    expect(HOSTED_RELEASE_TRANSITIONS.replaced).toEqual(['live']);
    expect(HOSTED_RELEASE_TRANSITIONS.rolled_back).toEqual(['live']);
    expect(HOSTED_RELEASE_TRANSITIONS.failed).toEqual([]);
  });
});
