import { delimiter, join } from 'node:path';
import { NextResponse } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObjectStore, type ObjectStore } from '../helpers/hostedApplicationExportFixtures';

// Stop now (Story MOTIR-9800 · MOTIR-12135) over real Postgres: an organisation
// admin's POST runs the same stop the sweep runs, to its end; a member is 403,
// another organisation's application 404, and an application outside its grace
// window 409 with nothing called at the provider. The compliance gate is the one
// route stub; the ports are the orchestrator's fakes, `pg_dump` the stand-in on
// PATH, the object store the in-memory stand-in.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => undefined) }));
const store: { current: ObjectStore } = { current: createObjectStore() };
vi.mock('@/lib/blob/uploader', () => ({
  putPrivateStream: (...a: Parameters<ObjectStore['putPrivateStream']>) =>
    store.current.putPrivateStream(...a),
  deleteAttachmentBlob: (key: string) => store.current.deleteAttachmentBlob(key),
  signedDownloadUrl: (...a: Parameters<ObjectStore['signedDownloadUrl']>) =>
    store.current.signedDownloadUrl(...a),
}));
vi.mock('@/lib/services/productionDatabaseService', () => ({
  productionDatabaseService: {
    getProductionMigrationEnv: async () => ({
      DIRECT_URL: 'postgresql://tenant:pw@db.tenant.example:5432/neondb',
    }),
  },
}));

const { db } = await import('@/lib/db');
const { ApplicationStopFailedError } = await import('@/lib/hosting/errors');
const { mapStopError } = await import('@/lib/hosting/stopErrorResponse');
const { sendEvent } = await import('@/lib/jobs/sendEvent');
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { getDatabasePort, resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { hostedApplicationHandoverService } =
  await import('@/lib/services/hostedApplicationHandoverService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

const stopRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/stop/route');

const realPath = process.env['PATH'];

beforeAll(() => {
  process.env['PATH'] = `${join(__dirname, '..', 'helpers', 'fakePgDump')}${delimiter}${realPath}`;
});

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  resetDatabaseFakes();
  store.current = createObjectStore();
  requireCompliantSession.mockReset();
  vi.mocked(sendEvent).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  process.env['PATH'] = realPath;
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signInAs(userId: string) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: userId, email: `${userId}@example.test` } },
  });
}

const stop = (orgId: string, applicationId: string) =>
  stopRoute.POST(
    new Request(
      `http://localhost:3000/api/organizations/${orgId}/hosting/applications/${applicationId}/stop`,
      { method: 'POST' },
    ),
    { params: Promise.resolve({ orgId, applicationId }) },
  );

async function seed(state = 'grace') {
  const world = await fixtures.seedExportWorld({ state });
  await adminDb.hostedApplication.update({
    where: { id: world.applicationId },
    data: {
      productionAppName: `mh-${world.applicationId}`,
      stopsAt: new Date(Date.now() + 20 * 86_400_000),
    },
  });
  return world;
}

function watchProvider() {
  return {
    destroyApp: vi.spyOn(getHostingDeployPort('fly'), 'destroyApp'),
    deleteDatabase: vi.spyOn(getDatabasePort(), 'deleteDatabase'),
  };
}

describe('POST …/hosting/applications/[applicationId]/stop', () => {
  it('stops a grace application at once for an organisation admin, before its stopsAt', async () => {
    const world = await seed();
    const watch = watchProvider();
    signInAs(world.fx.ownerId);
    const res = await stop(world.organizationId, world.applicationId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: 'stopped', applicationId: world.applicationId });
    expect(typeof body['finalExportId']).toBe('string');
    const row = await adminDb.hostedApplication.findUniqueOrThrow({
      where: { id: world.applicationId },
    });
    expect(row).toMatchObject({ state: 'handed_over', productionAppName: null });
    expect(row.handedOverAt).not.toBeNull();
    expect(watch.destroyApp).toHaveBeenCalledTimes(1);
    expect(watch.deleteDatabase).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith(
      'hosting.application-grace.notice',
      expect.objectContaining({ kind: 'stopped' }),
    );

    // Pressed again: already stopped, nothing called.
    const again = await stop(world.organizationId, world.applicationId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: 'already_stopped' });
    expect(watch.destroyApp).toHaveBeenCalledTimes(1);
  });

  it('answers 403 to a member, 404 to another organisation and a stranger, 409 outside grace — calling nothing', async () => {
    const world = await seed();
    const other = await seed();
    const live = await seed('live');
    const member = await createTestUser();
    const stranger = await createTestUser();
    await fixtures.addOrgMember(world.organizationId, member.id, 'member');
    const watch = watchProvider();

    signInAs(member.id);
    const forbidden = await stop(world.organizationId, world.applicationId);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      code: 'ORG_FORBIDDEN',
      error: 'Organisation admins only.',
    });

    signInAs(stranger.id);
    expect((await stop(world.organizationId, world.applicationId)).status).toBe(404);

    signInAs(world.fx.ownerId);
    const elsewhere = await stop(world.organizationId, other.applicationId);
    expect(elsewhere.status).toBe(404);
    expect(((await elsewhere.json()) as { code: string }).code).toBe('APPLICATION_NOT_FOUND');

    signInAs(live.fx.ownerId);
    const conflict = await stop(live.organizationId, live.applicationId);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe('APPLICATION_NOT_STOPPABLE');

    expect(watch.destroyApp).not.toHaveBeenCalled();
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect(
      (await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: world.applicationId } }))
        .state,
    ).toBe('grace');
  });

  it('answers a failed step 502 and rethrows what it does not map', async () => {
    const world = await seed();
    signInAs(world.fx.ownerId);
    vi.spyOn(hostedApplicationHandoverService, 'stopApplication').mockRejectedValueOnce(
      new ApplicationStopFailedError(world.applicationId, 'delete_database', 'NEON_DOWN'),
    );
    const failed = await stop(world.organizationId, world.applicationId);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { code: string }).code).toBe('APPLICATION_STOP_FAILED');

    const boom = new Error('boom');
    vi.spyOn(hostedApplicationHandoverService, 'stopApplication').mockRejectedValueOnce(boom);
    await expect(stop(world.organizationId, world.applicationId)).rejects.toBe(boom);
    expect(mapStopError(boom)).toBeNull();
  });

  it('answers the session gate’s own refusal', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'nope' }, { status: 401 }),
    });
    expect((await stop('org', 'app')).status).toBe(401);
  });
});
