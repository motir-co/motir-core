import { NextResponse } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObjectStore, type ObjectStore } from '../helpers/hostedApplicationExportFixtures';

// The database export's three routes (Story MOTIR-9800 · MOTIR-12134) over real
// Postgres. The compliance gate is the one stub a route test needs (it has no
// cookie jar); the job queue records instead of enqueueing, and the object store
// is the in-memory stand-in. The service, the organisation-admin gate and the
// typed-error mapping are the shipped path. No route here dumps a database.

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

const { db } = await import('@/lib/db');
const { ExportFailedError } = await import('@/lib/hosting/errors');
const { mapExportError } = await import('@/lib/hosting/exportErrorResponse');
const { sendEvent } = await import('@/lib/jobs/sendEvent');
const { hostedApplicationExportService } =
  await import('@/lib/services/hostedApplicationExportService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

const exportsRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/exports/route');
const downloadRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/exports/[exportId]/download/route');

function signInAs(userId: string) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: userId, email: `${userId}@example.test` } },
  });
}

const base = (orgId: string, appId: string) =>
  `http://localhost:3000/api/organizations/${orgId}/hosting/applications/${appId}/exports`;

const create = (orgId: string, applicationId: string) =>
  exportsRoute.POST(new Request(base(orgId, applicationId), { method: 'POST' }), {
    params: Promise.resolve({ orgId, applicationId }),
  });
const list = (orgId: string, applicationId: string) =>
  exportsRoute.GET(new Request(base(orgId, applicationId)), {
    params: Promise.resolve({ orgId, applicationId }),
  });
const download = (orgId: string, applicationId: string, exportId: string) =>
  downloadRoute.GET(new Request(`${base(orgId, applicationId)}/${exportId}/download`), {
    params: Promise.resolve({ orgId, applicationId, exportId }),
  });

async function seedExport(world: Awaited<ReturnType<typeof fixtures.seedExportWorld>>) {
  return adminDb.hostedApplicationExport.create({
    data: {
      workspaceId: world.fx.workspaceId,
      applicationId: world.applicationId,
      kind: 'on_demand',
      requestedByUserId: world.fx.ownerId,
      storageKey: `hosting-exports/${world.fx.workspaceId}/${world.applicationId}/e.dump`,
      sizeBytes: BigInt(7),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  store.current = createObjectStore();
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST …/exports', () => {
  it('answers 202 with a job id for an admin of a grace application, and enqueues the export', async () => {
    const world = await fixtures.seedExportWorld();
    signInAs(world.fx.ownerId);
    const res = await create(world.organizationId, world.applicationId);
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(typeof jobId).toBe('string');
    expect(sendEvent).toHaveBeenCalledWith(
      'hosting.application-export',
      expect.objectContaining({ applicationId: world.applicationId, exportId: jobId }),
    );
  });

  it('answers 403 for a non-admin, 409 out of grace, 422 for AWS, 404 for another organisation', async () => {
    const world = await fixtures.seedExportWorld();
    const member = await createTestUser();
    await fixtures.addOrgMember(world.organizationId, member.id, 'member');
    signInAs(member.id);
    expect((await create(world.organizationId, world.applicationId)).status).toBe(403);

    const live = await fixtures.seedExportWorld({ state: 'live' });
    signInAs(live.fx.ownerId);
    expect((await create(live.organizationId, live.applicationId)).status).toBe(409);

    const aws = await fixtures.seedExportWorld({ target: 'aws' });
    signInAs(aws.fx.ownerId);
    expect((await create(aws.organizationId, aws.applicationId)).status).toBe(422);

    // An admin of `aws`'s organisation reaching `world`'s application through it.
    expect((await create(aws.organizationId, world.applicationId)).status).toBe(404);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('returns the gate’s own response when the session is not compliant', async () => {
    const refused = NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    requireCompliantSession.mockResolvedValue({ ok: false, response: refused });
    expect((await create('o', 'a')).status).toBe(401);
    expect((await list('o', 'a')).status).toBe(401);
    expect((await download('o', 'a', 'e')).status).toBe(401);
  });
});

describe('GET …/exports and …/download', () => {
  it('lists the exports with no storage key, and redirects a download to a signed link', async () => {
    const world = await fixtures.seedExportWorld();
    const row = await seedExport(world);
    signInAs(world.fx.ownerId);

    const res = await list(world.organizationId, world.applicationId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).exports.map((e: { id: string }) => e.id)).toEqual([row.id]);
    expect(text).not.toContain('hosting-exports/');

    const got = await download(world.organizationId, world.applicationId, row.id);
    expect(got.status).toBe(302);
    expect(got.headers.get('location')).toBe(
      `https://store.test.invalid/${row.storageKey}?ttl=300&download=true`,
    );
    expect(await adminDb.hostedApplicationExportDownload.count()).toBe(1);
  });

  it('applies the same gate: 403 for a non-admin, 404 through another organisation or for an unknown export', async () => {
    const world = await fixtures.seedExportWorld();
    const other = await fixtures.seedExportWorld();
    const row = await seedExport(world);
    const member = await createTestUser();
    await fixtures.addOrgMember(world.organizationId, member.id, 'member');

    signInAs(member.id);
    expect((await list(world.organizationId, world.applicationId)).status).toBe(403);
    expect((await download(world.organizationId, world.applicationId, row.id)).status).toBe(403);

    signInAs(other.fx.ownerId);
    expect((await list(other.organizationId, world.applicationId)).status).toBe(404);
    expect((await download(other.organizationId, world.applicationId, row.id)).status).toBe(404);
    signInAs(world.fx.ownerId);
    expect((await download(world.organizationId, world.applicationId, 'nope')).status).toBe(404);
    expect(await adminDb.hostedApplicationExportDownload.count()).toBe(0);
  });
});

describe('the error mapping', () => {
  it('answers 502 for a failed export, null for an error it does not know', () => {
    expect(mapExportError(new ExportFailedError('a', 'dump', 1))?.status).toBe(502);
    expect(mapExportError(new Error('boom'))).toBeNull();
  });

  it('rethrows an unmapped error from every route, so it is a 500', async () => {
    const boom = new Error('boom');
    signInAs('u');
    for (const method of ['requestExport', 'listExports', 'downloadUrl'] as const) {
      vi.spyOn(hostedApplicationExportService, method).mockRejectedValue(boom);
    }
    await expect(create('o', 'a')).rejects.toBe(boom);
    await expect(list('o', 'a')).rejects.toBe(boom);
    await expect(download('o', 'a', 'e')).rejects.toBe(boom);
    vi.restoreAllMocks();
  });
});
