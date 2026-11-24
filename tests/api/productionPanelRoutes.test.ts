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
const IDLE = '@/app/api/projects/[key]/repositories/[rowId]/production/idle-policy/route';
const USAGE = '@/app/api/projects/[key]/repositories/[rowId]/production/usage/route';
const { GET } = await import(PANEL);
const { POST } = await import(ROLLBACK);
const { GET: GET_IDLE, PUT: PUT_IDLE } = await import(IDLE);
const { GET: GET_USAGE } = await import(USAGE);
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
  vi.unstubAllGlobals();
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

async function readIdle(key: string, rowId: string): Promise<Response> {
  return GET_IDLE(new Request(`${url(key, rowId)}/idle-policy`), params(key, rowId));
}
async function putIdle(key: string, rowId: string, body: unknown): Promise<Response> {
  return PUT_IDLE(
    new Request(`${url(key, rowId)}/idle-policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(key, rowId),
  );
}

describe('…/production/idle-policy (MOTIR-12107)', () => {
  it('answers a member read-only and an administrator editable', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);

    s.asMember();
    const asMember = await readIdle('ACME', id);
    expect(asMember.status).toBe(200);
    expect(await asMember.json()).toEqual({
      policy: { mode: 'suspend', idleSeconds: 300 },
      editable: false,
      refusal: null,
    });
    s.asAdmin();
    expect((await (await readIdle('ACME', id)).json()).editable).toBe(true);
  });

  it('switches an administrator’s application and answers the new policy', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    s.asAdmin();

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policy: { mode: 'always_on' },
      editable: true,
      refusal: null,
    });
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId: id } }),
    ).toMatchObject({ idleMode: 'always_on', idleSeconds: null });
  });

  it('is 403 for a member, storing and deploying nothing', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    const deploys = hosting().calls.filter((c) => c.operation === 'deploy').length;
    s.asMember();

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('idle_policy_not_permitted');
    expect(hosting().calls.filter((c) => c.operation === 'deploy')).toHaveLength(deploys);
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId: id } }),
    ).toMatchObject({ idleMode: 'suspend' });
  });

  it('is 409 HOSTING_IDLE_POLICY_UNSUPPORTED for suspend on an AWS container, naming both', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await adminDb.projectRepo.update({
      where: { id },
      data: { hostingTarget: 'aws', hostingShape: 'container' },
    });
    await release(id, 1);
    s.asAdmin();

    const res = await putIdle('ACME', id, { mode: 'suspend' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
        message: 'This hosting target and shape cannot run that idle policy.',
        details: { target: 'aws', shape: 'container', mode: 'suspend' },
      },
    });
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId: id } }),
    ).toMatchObject({ idleMode: 'always_on' });
  });

  it('is 400 for a malformed policy', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    s.asAdmin();

    for (const body of [
      'not json',
      [],
      { mode: 'sometimes' },
      { mode: 'suspend', idleSeconds: 5 },
      { mode: 'suspend', idleSeconds: 90_000 },
      { mode: 'suspend', idleSeconds: 61.5 },
      { mode: 'always_on', idleSeconds: 300 },
    ]) {
      const res = await putIdle('ACME', id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_idle_policy');
    }
  });

  it('is 409 no_application before production exists, and 404 for a customer repository', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    const customer = await repo(s.fx, 'api', 'organization');
    s.asAdmin();

    expect(await (await readIdle('ACME', id)).json()).toEqual({
      policy: null,
      editable: false,
      refusal: null,
    });
    const none = await putIdle('ACME', id, { mode: 'always_on' });
    expect(none.status).toBe(409);
    expect((await none.json()).error.code).toBe('no_application');
    for (const res of [
      await readIdle('ACME', customer),
      await putIdle('ACME', customer, {
        mode: 'always_on',
      }),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('repository_not_found');
    }
  });

  it('is 502 when the redeploy fails, and 401 with no session', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    expect((await readIdle('ACME', id)).status).toBe(401);
    expect((await putIdle('ACME', id, { mode: 'always_on' })).status).toBe(401);
    s.asAdmin();
    hosting().failNext('deploy');

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('idle_policy_failed');
  });

  it('rethrows an error it has no status for, so the framework answers 500', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asAdmin();
    const { productionPanelService } = await import('@/lib/services/productionPanelService');
    vi.spyOn(productionPanelService, 'getIdlePolicy').mockRejectedValue(new Error('read'));
    vi.spyOn(productionPanelService, 'setIdlePolicy').mockRejectedValue(new Error('write'));

    await expect(readIdle('ACME', id)).rejects.toThrow('read');
    await expect(putIdle('ACME', id, { mode: 'always_on' })).rejects.toThrow('write');
  });
});

/** motir-ai answering this organisation's balance. */
function stubBalance(balance: number): void {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      if (String(u).includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

async function readUsage(key: string, rowId: string): Promise<Response> {
  return GET_USAGE(new Request(`${url(key, rowId)}/usage`), params(key, rowId));
}

describe('always on while out of credits (MOTIR-12108)', () => {
  async function exhausted(balance: number) {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    await adminDb.hostedApplication.update({
      where: { projectRepositoryId: id },
      data: { creditsExhaustedSince: new Date(Date.now() - 3_600_000) },
    });
    stubBalance(balance);
    s.asAdmin();
    return id;
  }

  it('is 409 always_on_refused_out_of_credits below zero, storing and deploying nothing', async () => {
    const id = await exhausted(-5);
    const deploys = hosting().calls.filter((c) => c.operation === 'deploy').length;

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('always_on_refused_out_of_credits');
    expect(hosting().calls.filter((c) => c.operation === 'deploy')).toHaveLength(deploys);
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId: id } }),
    ).toMatchObject({ idleMode: 'suspend' });
  });

  it('lifts the refusal at once on a top-up, before the meter’s next pass', async () => {
    const id = await exhausted(250);

    expect((await putIdle('ACME', id, { mode: 'always_on' })).status).toBe(200);
  });

  it('still lets an administrator choose suspend when idle', async () => {
    const id = await exhausted(-5);

    expect((await putIdle('ACME', id, { mode: 'suspend', idleSeconds: 600 })).status).toBe(200);
  });
});

describe('GET …/production/usage (MOTIR-12108)', () => {
  it('answers a member this period’s usage and credits, with no figure of Motir’s cost', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    const app = await adminDb.hostedApplication.findUniqueOrThrow({
      where: { projectRepositoryId: id },
      include: { workspace: true },
    });
    const end = new Date();
    await adminDb.productionUsageSlice.create({
      data: {
        workspaceId: app.workspaceId,
        organizationId: app.workspace.organizationId,
        applicationId: app.id,
        releaseId: app.currentReleaseId,
        unit: 'fly_small_seconds',
        quantity: 3600,
        credits: 7.5,
        motirCostUsd: 0.0092,
        periodStart: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)),
        chargeDay: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())),
        sliceStart: new Date(end.getTime() - 3_600_000),
        sliceEnd: end,
        idempotencyKey: `${app.id}:fly_small_seconds:${end.toISOString()}`,
      },
    });
    s.asMember();

    const res = await readUsage('ACME', id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      usage: [{ unit: 'fly_small_seconds', quantity: 3600, credits: 7.5 }],
      // Today's open day is in the rows, and charged only once it closes
      // (Decision MOTIR-12100 §2), so nothing is charged yet.
      credits: 0,
      motirCostRecorded: true,
      state: 'ok',
      exhausted: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/0\.0092|motirCostUsd/);
  });

  it('answers no_release before a first release', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    s.asMember();

    expect(await (await readUsage('ACME', id)).json()).toMatchObject({
      usage: [],
      credits: 0,
      state: 'no_release',
    });
  });

  it('answers credits_exhausted while the organisation is below zero', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    await release(id, 1);
    const since = new Date(Date.now() - 86_400_000);
    await adminDb.hostedApplication.update({
      where: { projectRepositoryId: id },
      data: { creditsExhaustedSince: since },
    });
    stubBalance(-12);
    s.asAdmin();

    expect(await (await readUsage('ACME', id)).json()).toMatchObject({
      state: 'credits_exhausted',
      exhausted: { since: since.toISOString(), balance: -12, canSuspend: true, suspendsAt: null },
    });
  });

  it('rethrows an error it has no status for, so the framework answers 500', async () => {
    const s = await setup();
    const id = await repo(s.fx);
    const { productionUsageService } = await import('@/lib/services/productionUsageService');
    vi.spyOn(productionUsageService, 'getUsageForRepository').mockRejectedValue(new Error('boom'));
    s.asAdmin();

    await expect(readUsage('ACME', id)).rejects.toThrow('boom');
  });

  it('is the ordinary 404 for a customer repository and another project’s path, 401 with no session', async () => {
    const s = await setup();
    const customer = await repo(s.fx, 'api', 'organization');
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await repo(other);
    expect((await readUsage('ACME', customer)).status).toBe(401);
    s.asAdmin();

    for (const [key, rowId] of [
      ['ACME', customer],
      ['ACME', foreign],
      ['OTHR', foreign],
    ] as const) {
      const res = await readUsage(key, rowId);
      expect(res.status, `${key}/${rowId}`).toBe(404);
      expect((await res.json()).error.code).toBe('repository_not_found');
    }
  });
});

describe('layering', () => {
  it('the routes import no database client, no repository and no port', () => {
    for (const [file, handlers] of [
      ['app/api/projects/[key]/repositories/[rowId]/production/route.ts', 1],
      ['app/api/projects/[key]/repositories/[rowId]/production/rollback/route.ts', 1],
      // GET and PUT, one service call each.
      ['app/api/projects/[key]/repositories/[rowId]/production/idle-policy/route.ts', 2],
    ] as const) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/@\/lib\/db['/]/);
      expect(source, file).not.toMatch(/@\/lib\/repositories\//);
      expect(source, file).not.toMatch(/@\/lib\/orchestrator|@motir\/orchestrator/);
      expect(source.match(/productionPanelService\.\w+\(/g), file).toHaveLength(handlers);
    }
    const usage = readFileSync(
      'app/api/projects/[key]/repositories/[rowId]/production/usage/route.ts',
      'utf8',
    );
    expect(usage).not.toMatch(/@\/lib\/db['/]|@\/lib\/repositories\/|@motir\/orchestrator/);
    expect(usage.match(/productionUsageService\.\w+\(/g)).toHaveLength(1);
    const service = readFileSync('lib/services/productionPanelService.ts', 'utf8');
    expect(service).not.toMatch(/@\/lib\/db['/]|@\/lib\/repositories\//);
  });
});
