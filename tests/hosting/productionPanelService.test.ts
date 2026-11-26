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
  RepositoryTakenOverError,
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
  RELEASE_PAGE_DEFAULT,
  RELEASE_PAGE_MAX,
} from '@/lib/services/productionPanelService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { projectAccessService } from '@/lib/services/projectAccessService';
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

  it('defaults to the design’s five rows a page (MOTIR-10037)', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    await releases(id, 6);
    const input = { projectKey: fx.projectIdentifier, projectRepositoryId: id, actor: fx.ctx };

    const page = await service.getProductionPanel(input);
    expect(RELEASE_PAGE_DEFAULT).toBe(5);
    expect(page.releases).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
  });

  it('refuses as not found an actor its own read finds without the view key', async () => {
    const { fx } = await setup();
    const id = await repo(fx);
    vi.spyOn(projectAccessService, 'getPermissions').mockResolvedValue(new Set());

    await expect(
      service.getProductionPanel({
        projectKey: fx.projectIdentifier,
        projectRepositoryId: id,
        actor: fx.ctx,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
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
      handover: null,
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
      [new RepositoryTakenOverError('r'), 409, 'repository_taken_over'],
    ];
    for (const [err, status, code] of cases) {
      expect(productionRouteError(err), code).toMatchObject({ status, code });
    }
    expect(new Set(cases.filter(([, s]) => s === 409).map(([, , c]) => c)).size).toBe(4);
    expect(productionRouteError(new Error('other'))).toBeNull();
    expect(productionRouteErrorResponse(new Error('other'))).toBeNull();
  });

  it('answers a taken-over repository with its own 409 and a fixed message, not the hidden 404', async () => {
    const res = productionRouteErrorResponse(new RepositoryTakenOverError('repo-secret-id'))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'repository_taken_over',
        message: 'This repository has been taken over and is no longer deployed by Motir.',
      },
    });
  });

  it('answers a fixed message, never the error’s own text', async () => {
    const leaky = new RollbackFailedError('a', 'rollback', 500, 'X');
    Object.defineProperty(leaky, 'message', { value: 'postgresql://app:hunter2@db/app' });
    const res = productionRouteErrorResponse(leaky)!;
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/postgres|hunter2/);
  });
});

// MOTIR-12138 — the panel's read carries the takeover facts for an application in
// every state, sets canManageHandover from the organisation-admin question, keeps
// Roll back off whenever the deploy guard answers taken_over, and never carries a
// storage key, connection string or provider message.
describe('getProductionPanel — the takeover handover', () => {
  async function world() {
    const { fx, member } = await setup();
    const id = await repo(fx);
    const [first] = await releases(id, 2);
    const app = await adminDb.hostedApplication.findFirstOrThrow({
      where: { projectRepositoryId: id },
    });
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    const org = await adminDb.organization.findUniqueOrThrow({
      where: { id: ws.organizationId! },
    });
    const read = (actor: { userId: string; workspaceId: string } = fx.ctx) =>
      service.getProductionPanel({
        projectKey: fx.projectIdentifier,
        projectRepositoryId: id,
        actor,
      });
    return { fx, member, id, app, org, first: first!, read };
  }

  function carriesNoSecret(panel: unknown) {
    const json = JSON.stringify(panel);
    expect(json).not.toContain('storageKey');
    expect(json).not.toContain('hosting-exports/');
    expect(json).not.toMatch(/postgres(ql)?:\/\//);
  }

  it('reads a live app: the organisation, no notice, no exports, Roll back as shipped', async () => {
    const w = await world();
    const panel = await w.read();
    expect(panel.handover).toEqual({
      state: 'live',
      target: 'fly',
      stopsAt: null,
      handedOverAt: null,
      upstreamAddress: null,
      handedOverAccountId: null,
      organizationId: w.org.id,
      organizationName: w.org.name,
      latestGraceNotice: null,
      canManageHandover: true,
      deployRefusal: null,
      exports: [],
      finalExportExpiresAt: null,
    });
    expect(panel.canRollback).toBe(true);
  });

  it('reads a grace app: stopsAt, the newest notice, the exports with who asked, taken_over and no Roll back', async () => {
    const w = await world();
    const stopsAt = new Date('2026-12-22T10:00:00.000Z');
    await adminDb.hostedApplication.update({
      where: { id: w.app.id },
      data: { state: 'grace', stopsAt },
    });
    await adminDb.hostedApplicationNotice.create({
      data: {
        workspaceId: w.fx.workspaceId,
        applicationId: w.app.id,
        kind: 'transferred',
        sentAt: new Date('2026-11-22T10:00:00.000Z'),
      },
    });
    await adminDb.hostedApplicationNotice.create({
      data: {
        workspaceId: w.fx.workspaceId,
        applicationId: w.app.id,
        kind: 'seven_days',
        sentAt: new Date('2026-12-15T10:00:00.000Z'),
      },
    });
    const future = new Date(Date.now() + 7 * 86_400_000);
    const base = {
      workspaceId: w.fx.workspaceId,
      applicationId: w.app.id,
      kind: 'on_demand',
      expiresAt: future,
    };
    await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        id: 'exp-old',
        requestedByUserId: w.fx.ownerId,
        storageKey: 'hosting-exports/w/a/exp-old.dump',
        sizeBytes: BigInt(1024),
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        id: 'exp-new',
        requestedByUserId: 'user-gone',
        storageKey: 'hosting-exports/w/a/exp-new.dump',
        sizeBytes: BigInt(2048),
        createdAt: new Date(Date.now() - 3_600_000),
      },
    });
    await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        id: 'exp-expired',
        requestedByUserId: null,
        storageKey: 'hosting-exports/w/a/exp-expired.dump',
        sizeBytes: BigInt(1),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: w.fx.ownerId } });

    const panel = await w.read();
    expect(panel.handover).toMatchObject({
      state: 'grace',
      stopsAt: stopsAt.toISOString(),
      latestGraceNotice: { kind: 'seven_days', sentAt: '2026-12-15T10:00:00.000Z' },
      deployRefusal: 'taken_over',
      canManageHandover: true,
    });
    expect(panel.handover!.exports).toEqual([
      expect.objectContaining({ id: 'exp-new', sizeBytes: '2048', requestedBy: null }),
      expect.objectContaining({
        id: 'exp-old',
        kind: 'on_demand',
        requestedBy: { id: w.fx.ownerId, name: owner.name },
      }),
    ]);
    // An administrator with a previous release still gets no Roll back.
    expect(panel).toMatchObject({ isAdministrator: true, canRollback: false });
    carriesNoSecret(panel);

    // A member reads the same facts and list, read-only.
    const asMember = await w.read(w.member);
    expect(asMember.handover).toMatchObject({ canManageHandover: false, state: 'grace' });
    expect(asMember.handover!.exports.map((e) => e.id)).toEqual(['exp-new', 'exp-old']);
  });

  it('sets canManageHandover false for a project administrator who is not an organisation admin', async () => {
    const w = await world();
    await addToProjectAs({
      key: w.fx.projectIdentifier,
      actorUserId: w.fx.ownerId,
      ctx: w.fx.ctx,
      targetUserId: w.member.userId,
      role: 'admin',
    });
    const panel = await w.read(w.member);
    expect(panel.isAdministrator).toBe(true);
    expect(panel.handover!.canManageHandover).toBe(false);
  });

  it('reads an AWS app handed over: the account id and the upstream address', async () => {
    const w = await world();
    const at = new Date('2026-11-24T10:00:00.000Z');
    await adminDb.hostedApplication.update({
      where: { id: w.app.id },
      data: {
        target: 'aws',
        state: 'handed_over',
        handedOverAt: at,
        handedOverAccountId: '482109375512',
        upstreamAddress: 'd2k8f4w1q9x3ab.cloudfront.net',
      },
    });
    const panel = await w.read();
    expect(panel.handover).toMatchObject({
      state: 'handed_over',
      target: 'aws',
      handedOverAt: at.toISOString(),
      handedOverAccountId: '482109375512',
      upstreamAddress: 'd2k8f4w1q9x3ab.cloudfront.net',
      deployRefusal: 'taken_over',
      finalExportExpiresAt: null,
    });
    expect(panel.canRollback).toBe(false);
  });

  it('reads a stopped Fly app: when its final export is kept until', async () => {
    const w = await world();
    const at = new Date('2026-12-22T10:02:00.000Z');
    await adminDb.hostedApplication.update({
      where: { id: w.app.id },
      data: { state: 'handed_over', handedOverAt: at },
    });
    const panel = await w.read();
    expect(panel.handover).toMatchObject({
      state: 'handed_over',
      finalExportExpiresAt: '2027-01-21T10:02:00.000Z',
    });
  });

  it('reads handing_over as taken over, and the rollback still refuses on the server', async () => {
    const w = await world();
    await adminDb.hostedApplication.update({
      where: { id: w.app.id },
      data: { state: 'handing_over' },
    });
    const panel = await w.read();
    expect(panel.handover).toMatchObject({ state: 'handing_over', deployRefusal: 'taken_over' });
    expect(panel.canRollback).toBe(false);
    await expect(
      service.rollback({
        projectKey: w.fx.projectIdentifier,
        projectRepositoryId: w.id,
        actor: w.fx.ctx,
      }),
    ).rejects.toBeInstanceOf(RepositoryTakenOverError);
  });
});
