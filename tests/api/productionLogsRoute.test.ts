// MOTIR-12105 — `GET …/repositories/[rowId]/production/logs` against real
// Postgres and the deploy port's fake. Every call runs route → service →
// repository → Prisma → port; the masking rules themselves are pinned in
// `tests/hosting/logMasking.test.ts` and the service's in
// `tests/hosting/productionLogsService.test.ts`. These tests own the transport:
// the session gate, a member's read with every query parameter reaching the
// port, the two empty states as 200s, the stable 400s, the indistinguishable
// 404s with no port call, and that no body carries a secret or a provider's
// words.
//
// Only `getWorkspaceContext` is stubbed (no cookies in the test env); the mock is
// partial, so the real RLS-binding `withWorkspaceContext` is kept.
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

const LOGS = '@/app/api/projects/[key]/repositories/[rowId]/production/logs/route';
const { GET } = await import(LOGS);
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { hostedRepositoryAccessService } =
  await import('@/lib/services/hostedRepositoryAccessService');
const { environmentConfigService } = await import('@/lib/services/environmentConfigService');
const { productionLogsService } = await import('@/lib/services/productionLogsService');
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
const KEY = 'cd'.repeat(32);
const SECRET = 'swordfish-0042';
const sha = (n: number) => n.toString(16).padStart(40, '0');
const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 12, minute));

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
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

async function goLive(projectRepositoryId: string): Promise<string> {
  const live = await productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha(1),
    artifactRef: `registry.fly.io/x:${sha(1)}`,
    cause: 'merge',
  });
  expect(live.state).toBe('live');
  const { appRef } = await hosting().ensureApp({
    repositoryId: projectRepositoryId,
    environment: { kind: 'production' },
  });
  return appRef;
}

async function setup() {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const member = await usersService.createUser({
    email: 'member@logs.test',
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
async function read(key: string, rowId: string, query = ''): Promise<Response> {
  return GET(
    new Request(
      `http://localhost:3000/api/projects/${key}/repositories/${rowId}/production/logs${query}`,
    ),
    params(key, rowId),
  );
}

describe('GET …/production/logs', () => {
  it('answers a member the masked lines, newest first, with every query parameter honoured', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await environmentConfigService.set(
      id,
      'production',
      { name: 'API_SECRET', value: SECRET, isSecret: true },
      s.fx.ctx,
    );
    const appRef = await goLive(id);
    hosting().appendLogLines(appRef, [
      { at: at(1), stream: 'app', message: 'error before the window' },
      { at: at(2), stream: 'app', message: `error with ${SECRET}` },
      { at: at(3), stream: 'platform', message: 'Error restarting' },
      { at: at(4), stream: 'app', message: 'ok' },
      { at: at(5), stream: 'app', message: 'error after the window' },
    ]);
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    s.asMember();

    const window = `since=${at(2).toISOString()}&until=${at(4).toISOString()}`;
    const res = await read('ACME', id, `?${window}&q=error&limit=1`);
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first).toEqual({
      state: 'ok',
      lines: [{ at: at(3).toISOString(), stream: 'platform', message: 'Error restarting' }],
      cursor: expect.any(String),
    });
    expect(readLogs.mock.calls[0]![1]).toEqual({
      since: at(2),
      until: at(4),
      filter: 'error',
      limit: 1,
    });

    const next = await read(
      'ACME',
      id,
      `?${window}&q=error&limit=1&cursor=${encodeURIComponent(first.cursor)}`,
    );
    const text = await next.text();
    expect(JSON.parse(text)).toEqual({
      state: 'ok',
      lines: [{ at: at(2).toISOString(), stream: 'app', message: 'error with ***' }],
      cursor: null,
    });
    expect(text).not.toContain(SECRET);
  });

  it('drops a line the filter matched only through a secret', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await environmentConfigService.set(
      id,
      'production',
      { name: 'API_SECRET', value: SECRET, isSecret: true },
      s.fx.ctx,
    );
    hosting().appendLogLines(await goLive(id), [
      { at: at(1), stream: 'app', message: `token ${SECRET}` },
    ]);
    s.asMember();
    const res = await read('ACME', id, '?q=fish');
    expect(await res.json()).toEqual({ state: 'ok', lines: [], cursor: null });
  });

  it('answers no_release with nothing live, and unavailable as a 200 when the target cannot answer', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();
    const none = await read('ACME', id);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ state: 'no_release', lines: [], cursor: null });

    const appRef = await goLive(id);
    hosting().setLogsUnavailable(appRef, 'provider said postgres://u:hunter2@db');
    const down = await read('ACME', id);
    expect(down.status).toBe(200);
    const text = await down.text();
    expect(JSON.parse(text)).toEqual({ state: 'unavailable', lines: [], cursor: null });
    expect(text).not.toMatch(/hunter2|postgres/);
  });

  it('is 400 with a stable code for a malformed range, limit or cursor', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await goLive(id);
    s.asMember();
    for (const [query, code] of [
      ['?since=yesterday', 'invalid_log_range'],
      ['?until=2026-99-01T00:00:00Z', 'invalid_log_range'],
      ['?since=2026-11-02T00:00:00Z&until=2026-11-01T00:00:00Z', 'invalid_log_range'],
      ['?limit=0', 'invalid_limit'],
      ['?limit=abc', 'invalid_limit'],
      ['?limit=1.5', 'invalid_limit'],
      ['?cursor=garbage', 'invalid_cursor'],
    ] as const) {
      const res = await read('ACME', id, query);
      expect(res.status, query).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error.code, query).toBe(code);
      expect(text).not.toContain('garbage');
    }
  });

  it('clamps a limit past the ceiling', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await goLive(id);
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    s.asMember();
    expect((await read('ACME', id, '?limit=999999')).status).toBe(200);
    expect(readLogs.mock.calls[0]![1].limit).toBe(1000);
  });

  it('is the ordinary 404 for a customer, an unknown, another project’s and an unbrowsable repository, with no port call', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await goLive(id);
    const customer = await repo(s.fx, 'api', 'organization');
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await repo(other);
    const outsider = await usersService.createUser({
      email: 'outsider@logs.test',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    // A workspace role that grants nothing — not even `project:browse`.
    const nothing = await createCustomRoleAs({ ctx: s.fx.ctx, name: 'Nothing', permissions: [] });
    await setWorkspaceRoleFor(outsider.id, s.fx.workspaceId, nothing.id);
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    const ensureApp = vi.spyOn(hosting(), 'ensureApp');

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
    ctxRef.current = { userId: outsider.id, workspaceId: s.fx.workspaceId };
    const unbrowsable = await read('ACME', id);
    expect(unbrowsable.status).toBe(404);
    expect((await unbrowsable.json()).error.code).toBe('repository_not_found');
    expect(readLogs).not.toHaveBeenCalled();
    expect(ensureApp).not.toHaveBeenCalled();
  });

  it('is 401 with no session', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    expect((await read('ACME', id)).status).toBe(401);
  });

  it('rethrows an error it has no status for, so the framework answers 500', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();
    vi.spyOn(productionLogsService, 'readProductionLogs').mockRejectedValue(
      new Error('unexpected'),
    );
    await expect(read('ACME', id)).rejects.toThrow('unexpected');
  });
});
