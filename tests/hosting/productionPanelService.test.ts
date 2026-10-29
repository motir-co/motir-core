// MOTIR-10036 — the Production panel's read and rollback, against real Postgres
// and the deploy port's fake: the panel's shape for a member and an
// administrator, cursor paging without repeats, the empty panel before a first
// release, not found for what the viewer cannot have, and the error map's
// totality over the rollback service's typed errors.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IllegalReleaseTransitionError,
  InvalidReleaseCursorError,
  NoPreviousReleaseError,
  ReleaseInProgressError,
  RollbackFailedError,
  RollbackNotPermittedError,
} from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import {
  productionRouteError,
  productionRouteErrorResponse,
} from '@/lib/hosting/productionPanelErrors';
import { decodeReleaseCursor, encodeReleaseCursor } from '@/lib/hosting/releaseCursor';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { resetHostingFakes } from '@/lib/orchestrator/hosting';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  productionPanelService as service,
  RELEASE_PAGE_MAX,
} from '@/lib/services/productionPanelService';
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
const sha = (n: number) => n.toString(16).padStart(40, '0');

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
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

async function setup(identifier = 'ACME') {
  const fx: WorkItemFixture = await makeWorkItemFixture({ name: identifier, identifier });
  const member = await usersService.createUser({
    email: `member-${identifier}@panel.test`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, member: { userId: member.id, workspaceId: fx.workspaceId } };
}

async function repo(fx: WorkItemFixture, role: 'web' | 'api' = 'web', seedSource = 'initialised') {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource, state: 'created', hostingTarget: 'fly' },
  });
  return row.id;
}

async function releases(projectRepositoryId: string, count: number) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push(
      await productionReleaseService.deployProductionRelease({
        projectRepositoryId,
        commitSha: sha(i),
        artifactRef: `registry.fly.io/x:${sha(i)}`,
        cause: 'merge',
      }),
    );
  }
  return out;
}

describe('getProductionPanel', () => {
  it('reads current, previous and history for a member, read-only', async () => {
    const { fx, member } = await setup();
    const id = await repo(fx);
    const [a, b] = await releases(id, 2);

    const panel = await service.getProductionPanel({
      projectKey: fx.projectIdentifier,
      projectRepositoryId: id,
      actor: member,
    });

    expect(panel.application).toMatchObject({ target: 'fly' });
    expect(panel.currentRelease?.id).toBe(b!.id);
    expect(panel.previousRelease?.id).toBe(a!.id);
    expect(panel.releases.map((r) => r.id)).toEqual([b!.id, a!.id]);
    expect(panel.nextCursor).toBeNull();
    expect(panel).toMatchObject({ isAdministrator: false, canRollback: false });
  });

  it('lets an administrator roll back only when a previous release exists', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    await releases(id, 1);
    const input = { projectKey: fx.projectIdentifier, projectRepositoryId: id, actor: fx.ctx };

    expect(await service.getProductionPanel(input)).toMatchObject({
      isAdministrator: true,
      canRollback: false,
    });
    await releases(id, 1);
    expect(await service.getProductionPanel(input)).toMatchObject({
      isAdministrator: true,
      canRollback: true,
    });
  });

  it('pages the history newest first without repeats, and refuses a malformed cursor', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    const all = await releases(id, 5);
    const input = { projectKey: fx.projectIdentifier, projectRepositoryId: id, actor: fx.ctx };

    const first = await service.getProductionPanel({ ...input, limit: 2 });
    const second = await service.getProductionPanel({
      ...input,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await service.getProductionPanel({
      ...input,
      limit: 2,
      cursor: second.nextCursor,
    });

    const seen = [...first.releases, ...second.releases, ...third.releases].map((r) => r.id);
    expect(seen).toEqual(all.map((r) => r.id).reverse());
    expect(third.nextCursor).toBeNull();
    await expect(
      service.getProductionPanel({ ...input, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidReleaseCursorError);
  });

  it('caps the page at the ceiling and defaults below it', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    await releases(id, 3);
    const input = { projectKey: fx.projectIdentifier, projectRepositoryId: id, actor: fx.ctx };

    expect((await service.getProductionPanel({ ...input, limit: 500 })).releases).toHaveLength(3);
    expect((await service.getProductionPanel({ ...input, limit: 0 })).releases).toHaveLength(1);
    expect(RELEASE_PAGE_MAX).toBe(50);
  });

  it('answers an empty panel before a first release, writing nothing', async () => {
    const { fx } = await setup();
    const id = await repo(fx);

    const panel = await service.getProductionPanel({
      projectKey: fx.projectIdentifier,
      projectRepositoryId: id,
      actor: fx.ctx,
    });

    expect(panel).toEqual({
      application: null,
      currentRelease: null,
      previousRelease: null,
      releases: [],
      nextCursor: null,
      isAdministrator: true,
      canRollback: false,
    });
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });

  it('is not found for a customer repository, another project’s, and a viewer outside a private project', async () => {
    const { fx, member } = await setup();
    const customer = await repo(fx, 'api', 'organization');
    const other = await setup('OTHR');
    const foreign = await repo(other.fx);
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const own = await repo(fx);
    const base = { projectKey: fx.projectIdentifier, actor: fx.ctx };

    await expect(
      service.getProductionPanel({ ...base, projectRepositoryId: customer }),
    ).rejects.toBeInstanceOf(CustomerRepositoryNotDeployableError);
    await expect(
      service.getProductionPanel({ ...base, projectRepositoryId: foreign }),
    ).rejects.toBeInstanceOf(ProjectRepoNotFoundError);
    await expect(
      service.getProductionPanel({ ...base, projectRepositoryId: own, actor: member }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });
});

describe('rollback', () => {
  it('rolls back for an administrator and answers the panel', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    const [a, b] = await releases(id, 2);

    const panel = await service.rollback({
      projectKey: fx.projectIdentifier,
      projectRepositoryId: id,
      actor: fx.ctx,
    });

    expect(panel.currentRelease).toMatchObject({ id: a!.id, state: 'live' });
    expect(panel.previousRelease).toMatchObject({ id: b!.id, state: 'rolled_back' });
  });

  it('refuses a project member who is not an administrator', async () => {
    const { fx, member } = await setup();
    const id = await repo(fx);
    await releases(id, 2);
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: member.userId,
      role: 'member',
    });

    await expect(
      service.rollback({
        projectKey: fx.projectIdentifier,
        projectRepositoryId: id,
        actor: member,
      }),
    ).rejects.toBeInstanceOf(RollbackNotPermittedError);
  });
});

describe('the release cursor', () => {
  it('round-trips and refuses every malformed token', () => {
    const cursor = { createdAt: '2026-10-29T12:00:00.000Z', id: 'rel_1' };
    expect(decodeReleaseCursor(encodeReleaseCursor(cursor))).toEqual(cursor);
    const bad = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const raw of [
      '%%%',
      bad({ createdAt: 'x' }),
      bad(['not a date', 'rel_1']),
      bad(['2026-10-29T12:00:00.000Z', '']),
      bad(['2026-10-29T12:00:00.000Z', 7]),
    ]) {
      expect(() => decodeReleaseCursor(raw), raw).toThrow(InvalidReleaseCursorError);
    }
  });
});

describe('productionRouteError', () => {
  it('maps every typed error the rollback and the panel declare, with stable codes', () => {
    const cases: Array<[unknown, number, string]> = [
      [new RollbackNotPermittedError('r'), 403, 'rollback_not_permitted'],
      [new NoPreviousReleaseError('a'), 409, 'no_previous_release'],
      [new ReleaseInProgressError('a', 'r', 'building'), 409, 'release_in_progress'],
      [new IllegalReleaseTransitionError('r', 'replaced', 'live', null), 409, 'rollback_conflict'],
      [new CustomerRepositoryNotDeployableError('r'), 404, 'repository_not_found'],
      [new ApplicationNotFoundError('r'), 404, 'repository_not_found'],
      [new ProjectRepoNotFoundError('r'), 404, 'repository_not_found'],
      [new ProjectNotFoundError('p'), 404, 'repository_not_found'],
      [new RollbackFailedError('a', 'rollback', 503, 'FLY'), 502, 'rollback_failed'],
      [new InvalidReleaseCursorError(), 400, 'invalid_cursor'],
    ];
    for (const [err, status, code] of cases) {
      expect(productionRouteError(err), code).toMatchObject({ status, code });
    }
    expect(new Set(cases.filter(([, s]) => s === 409).map(([, , c]) => c)).size).toBe(3);
    expect(productionRouteError(new Error('other'))).toBeNull();
    expect(productionRouteErrorResponse(new Error('other'))).toBeNull();
  });

  it('answers a fixed message, never the error’s own text', async () => {
    const leaky = new RollbackFailedError('a', 'rollback', 500, 'X');
    Object.defineProperty(leaky, 'message', { value: 'postgresql://app:hunter2@db/app' });
    const res = productionRouteErrorResponse(leaky)!;
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/postgres|hunter2/);
  });
});
