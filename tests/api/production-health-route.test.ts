// MOTIR-12106 — `GET …/repositories/[rowId]/production/health` against real
// Postgres and the deploy port's fake. The route owns the transport: the session
// gate, a member's read of the state and the events (newest first, each with its
// fields), `state: null` before a release, and the indistinguishable 404s for a
// customer, an unknown, another project's and an unbrowsable repository. The
// prober's rules are `tests/services/productionHealthService.test.ts`'s.
//
// Only `getWorkspaceContext` is stubbed (no cookies in the test env).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { HostingManifest } from '@/lib/hosting/manifest';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const HEALTH = '@/app/api/projects/[key]/repositories/[rowId]/production/health/route';
const { GET } = await import(HEALTH);
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { hostedRepositoryAccessService } =
  await import('@/lib/services/hostedRepositoryAccessService');
const { productionHealthService } = await import('@/lib/services/productionHealthService');
const { productionReleaseService } = await import('@/lib/services/productionReleaseService');
const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
const { releaseDeploymentStatusService } =
  await import('@/lib/services/releaseDeploymentStatusService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { addToProjectAs, createCustomRoleAs, setWorkspaceRoleFor } =
  await import('../helpers/workspaceRoleFixtures');

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

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
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

async function goLive(projectRepositoryId: string) {
  const release = await productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha(1),
    artifactRef: `registry.fly.io/x:${sha(1)}`,
    cause: 'merge',
  });
  const app = await adminDb.hostedApplication.update({
    where: { projectRepositoryId },
    data: { productionAddress: 'shop--acme.motir.site' },
  });
  const { appRef } = await hosting().ensureApp({
    repositoryId: projectRepositoryId,
    environment: { kind: 'production' },
  });
  return { appRef, applicationId: app.id, releaseId: release.id };
}

async function setup() {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const member = await usersService.createUser({
    email: 'member@health-route.test',
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
  return {
    fx,
    asMember: () => (ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId }),
  };
}

const params = (key: string, rowId: string) => ({ params: Promise.resolve({ key, rowId }) });
async function read(key: string, rowId: string): Promise<Response> {
  return GET(
    new Request(
      `http://localhost:3000/api/projects/${key}/repositories/${rowId}/production/health`,
    ),
    params(key, rowId),
  );
}

describe('GET …/production/health', () => {
  it('answers a member the state and the events, newest first', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    const { appRef, applicationId, releaseId } = await goLive(id);
    // A restarted-from exit, then an exit the target has not recovered from:
    // two events, the newer first.
    const earlier = new Date(hosting().now().getTime() - 60_000);
    hosting().recordRestartedExit(appRef, { exitCode: 2, oomKilled: false, at: earlier });
    hosting().appendLogLines(appRef, [{ at: new Date(), stream: 'app', message: 'panic' }]);
    await productionHealthService.probeApplication(applicationId);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await productionHealthService.probeApplication(applicationId);
    s.asMember();

    const res = await read('ACME', id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'crashed', since: expect.any(String), condition: null });
    expect(body.events).toEqual([
      {
        id: expect.any(String),
        occurredAt: hosting().now().toISOString(),
        kind: 'crashed',
        reason: 'exit code 1',
        lastLogLines: [{ at: expect.any(String), stream: 'app', message: 'panic' }],
        releaseId,
      },
      {
        id: expect.any(String),
        occurredAt: earlier.toISOString(),
        kind: 'crashed',
        reason: 'exit code 2',
        lastLogLines: [{ at: expect.any(String), stream: 'app', message: 'panic' }],
        releaseId,
      },
    ]);
    const times = body.events.map((e: { occurredAt: string }) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('answers state null before a release, and before a first probe', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();
    expect(await (await read('ACME', id)).json()).toEqual({
      state: null,
      since: null,
      condition: null,
      events: [],
    });
    await goLive(id);
    expect((await (await read('ACME', id)).json()).state).toBeNull();
  });

  it('is the ordinary 404 for a customer, an unknown, another project’s and an unbrowsable repository', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    const customer = await repo(s.fx, 'api', 'organization');
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await repo(other);
    s.asMember();
    for (const [key, rowId] of [
      ['ACME', customer],
      ['ACME', 'missing'],
      ['ACME', foreign],
      ['OTHR', foreign],
    ] as const) {
      const res = await read(key, rowId);
      expect(res.status, `${key}/${rowId}`).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'repository_not_found', message: 'Repository not found.' },
      });
    }
    const outsider = await usersService.createUser({
      email: 'outsider@health-route.test',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    const nothing = await createCustomRoleAs({ ctx: s.fx.ctx, name: 'Nothing', permissions: [] });
    await setWorkspaceRoleFor(outsider.id, s.fx.workspaceId, nothing.id);
    ctxRef.current = { userId: outsider.id, workspaceId: s.fx.workspaceId };
    expect((await read('ACME', id)).status).toBe(404);
  });

  it('is 401 with no session', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    expect((await read('ACME', id)).status).toBe(401);
  });

  it('rethrows an error it has no status for', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();
    vi.spyOn(productionHealthService, 'getHealthForRepository').mockRejectedValue(
      new Error('unexpected'),
    );
    await expect(read('ACME', id)).rejects.toThrow('unexpected');
  });
});
