// MOTIR-10036 — the Production panel's HTTP surface against real Postgres and the
// deploy port's fake. Every call runs route → service → repository → Prisma; the
// service's own semantics are in `tests/hosting/productionPanelService.test.ts`.
// These tests own the transport: the session gate, the query validation, the
// typed-error → status mapping, the path scoping between two repositories, and
// that no body carries a secret or a provider's words.
//
// Only `getWorkspaceContext` is stubbed (no cookies in the test env); the mock is
// partial, so the real RLS-binding `withWorkspaceContext` is kept.
import { readFileSync } from 'node:fs';
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

const PANEL = '@/app/api/projects/[key]/repositories/[rowId]/production/route';
const ROLLBACK = '@/app/api/projects/[key]/repositories/[rowId]/production/rollback/route';
const { GET } = await import(PANEL);
const { POST } = await import(ROLLBACK);
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { hostedRepositoryAccessService } =
  await import('@/lib/services/hostedRepositoryAccessService');
const { productionReleaseService } = await import('@/lib/services/productionReleaseService');
const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
const { releaseDeploymentStatusService } =
  await import('@/lib/services/releaseDeploymentStatusService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { addToProjectAs } = await import('../helpers/workspaceRoleFixtures');

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
const SECRETISH = /postgres(ql)?:\/\/|hunter2|ciphertext|DATABASE_URL/i;
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

async function release(projectRepositoryId: string, n: number) {
  return productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha(n),
    artifactRef: `registry.fly.io/x:${sha(n)}`,
    cause: 'merge',
  });
}

async function setup() {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const member = await usersService.createUser({
    email: 'member@routes.test',
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
    asAdmin: () => (ctxRef.current = fx.ctx),
    asMember: () => (ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId }),
  };
}

const params = (key: string, rowId: string) => ({ params: Promise.resolve({ key, rowId }) });
const url = (key: string, rowId: string, query = '') =>
  `http://localhost:3000/api/projects/${key}/repositories/${rowId}/production${query}`;

async function read(key: string, rowId: string, query = ''): Promise<Response> {
  return GET(new Request(url(key, rowId, query)), params(key, rowId));
}
async function rollback(key: string, rowId: string): Promise<Response> {
  return POST(new Request(`${url(key, rowId)}/rollback`, { method: 'POST' }), params(key, rowId));
}

describe('GET …/production', () => {
  it('answers the panel to a member, read-only, and pages the history', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    for (let i = 1; i <= 3; i++) await release(id, i);
    s.asMember();

    const res = await read('ACME', id, '?limit=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ isAdministrator: false, canRollback: false });
    expect(body.application.target).toBe('fly');
    expect(body.currentRelease.commitSha).toBe(sha(3));
    expect(body.previousRelease.commitSha).toBe(sha(2));
    expect(body.releases.map((r: { commitSha: string }) => r.commitSha)).toEqual([sha(3), sha(2)]);
    expect(typeof body.nextCursor).toBe('string');

    const next = await (
      await read('ACME', id, `?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`)
    ).json();
    expect(next.releases.map((r: { commitSha: string }) => r.commitSha)).toEqual([sha(1)]);
    expect(next.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(SECRETISH);
  });

  it('tells an administrator they may roll back', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    s.asAdmin();
    expect(await (await read('ACME', id)).json()).toMatchObject({
      isAdministrator: true,
      canRollback: false,
    });
    await release(id, 2);
    expect(await (await read('ACME', id)).json()).toMatchObject({
      isAdministrator: true,
      canRollback: true,
    });
  });

  it('answers the empty panel before a first release', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();

    const res = await read('ACME', id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      application: null,
      releases: [],
      canRollback: false,
    });
  });

  it('is 400 for a malformed cursor or limit', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    s.asAdmin();

    const badCursor = await read('ACME', id, '?cursor=garbage');
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json()).error.code).toBe('invalid_cursor');
    for (const limit of ['abc', '0', '1.5']) {
      const res = await read('ACME', id, `?limit=${limit}`);
      expect(res.status, limit).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_limit');
    }
  });

  it('is the ordinary 404 for a customer repository, an unknown one and another project’s path', async () => {
    const s = await setup();
    const customer = await repo(s.fx, 'api', 'organization');
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await repo(other);
    s.asAdmin();

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
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });

  it('is 401 with no session', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    expect((await read('ACME', id)).status).toBe(401);
  });
});

describe('POST …/production/rollback', () => {
  it('rolls back for an administrator and answers the panel', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    await release(id, 2);
    s.asAdmin();

    const res = await rollback('ACME', id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentRelease).toMatchObject({ commitSha: sha(1), state: 'live' });
    expect(body.previousRelease).toMatchObject({ commitSha: sha(2), state: 'rolled_back' });
    expect(body.currentRelease.restoredBy.id).toBe(s.fx.ownerId);
    expect(hosting().calls.filter((c) => c.operation === 'rollback')).toHaveLength(1);
  });

  it('is 403 for a member, with no port call', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    await release(id, 2);
    s.asMember();
    const from = hosting().calls.length;

    const res = await rollback('ACME', id);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('rollback_not_permitted');
    expect(hosting().calls.slice(from)).toEqual([]);
  });

  it('is 409 with no previous release, 404 for a customer repository, 401 with no session', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    const customer = await repo(s.fx, 'api', 'organization');
    await release(id, 1);

    expect((await rollback('ACME', id)).status).toBe(401);
    s.asAdmin();
    const none = await rollback('ACME', id);
    expect(none.status).toBe(409);
    expect((await none.json()).error.code).toBe('no_previous_release');
    expect((await rollback('ACME', customer)).status).toBe(404);
  });

  it('is 502 when the provider fails, with nothing of its message in the body', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    await release(id, 2);
    s.asAdmin();
    vi.spyOn(hosting(), 'rollback').mockRejectedValue(
      new Error('cannot reach postgresql://app:hunter2@db/app'),
    );

    const res = await rollback('ACME', id);

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('rollback_failed');
    expect(text).not.toMatch(SECRETISH);
  });

  it('rethrows an error it has no status for, so the framework answers 500', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asAdmin();
    const { productionPanelService } = await import('@/lib/services/productionPanelService');
    vi.spyOn(productionPanelService, 'rollback').mockRejectedValue(new Error('unexpected'));

    await expect(rollback('ACME', id)).rejects.toThrow('unexpected');
  });

  it('rolls back only the repository its path names', async () => {
    const s = await setup();
    const web = await repo(s.fx, 'web');
    const api = await repo(s.fx, 'api');
    for (const id of [web, api]) {
      await release(id, 1);
      await release(id, 2);
    }
    s.asAdmin();
    const before = await (await read('ACME', api)).json();

    await rollback('ACME', web);

    expect(await (await read('ACME', api)).json()).toEqual(before);
  });
});

describe('layering', () => {
  it('the routes import no database client, no repository and no port', () => {
    for (const file of [
      'app/api/projects/[key]/repositories/[rowId]/production/route.ts',
      'app/api/projects/[key]/repositories/[rowId]/production/rollback/route.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/@\/lib\/db['/]/);
      expect(source, file).not.toMatch(/@\/lib\/repositories\//);
      expect(source, file).not.toMatch(/@\/lib\/orchestrator|@motir\/orchestrator/);
      expect(source.match(/productionPanelService\.\w+\(/g), file).toHaveLength(1);
    }
    const service = readFileSync('lib/services/productionPanelService.ts', 'utf8');
    expect(service).not.toMatch(/@\/lib\/db['/]|@\/lib\/repositories\//);
  });
});
