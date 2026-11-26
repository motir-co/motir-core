import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObjectStore, type ObjectStore } from '../helpers/hostedApplicationExportFixtures';

// THE DATABASE EXPORT (Story MOTIR-9800 · MOTIR-12134) over real Postgres: the
// gate refuses before any dump, a row exists only for a stored dump, a failed
// dump or upload leaves nothing behind and no credential anywhere, downloads are
// recorded, and the expiry sweep deletes the object before the row. `pg_dump` is
// a stand-in put first on PATH (tests/helpers/fakePgDump), so every outcome is
// deterministic on any runner; the real binary and a real restore are
// tests/hosting/hostedApplicationExportRestore.test.ts. The object store is the
// in-memory stand-in for `lib/blob/uploader.ts`; the database port's direct URL
// is the one other stub (`productionDatabaseService`).

const store: { current: ObjectStore } = { current: createObjectStore() };
vi.mock('@/lib/blob/uploader', () => ({
  putPrivateStream: (...a: Parameters<ObjectStore['putPrivateStream']>) =>
    store.current.putPrivateStream(...a),
  deleteAttachmentBlob: (key: string) => store.current.deleteAttachmentBlob(key),
  signedDownloadUrl: (...a: Parameters<ObjectStore['signedDownloadUrl']>) =>
    store.current.signedDownloadUrl(...a),
}));
const { getProductionMigrationEnv } = vi.hoisted(() => ({
  getProductionMigrationEnv: vi.fn(),
}));
vi.mock('@/lib/services/productionDatabaseService', () => ({
  productionDatabaseService: { getProductionMigrationEnv },
}));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => undefined) }));

const { db } = await import('@/lib/db');
const {
  ExportFailedError,
  ExportNotAllowedError,
  ExportNotFoundError,
  ExportTargetUnsupportedError,
  ProductionDatabaseUnreadableError,
} = await import('@/lib/hosting/errors');
const { sendEvent } = await import('@/lib/jobs/sendEvent');
const { OrgForbiddenError } = await import('@/lib/organizations/errors');
const { hostedApplicationExportService, exportStorageKey } =
  await import('@/lib/services/hostedApplicationExportService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

const DAY = 86_400_000;
const PASSWORD = 'pw-S3cr3t-never-logged';
/** The direct URL as the database port hands it over: with its password. */
const directUrl = `postgresql://tenant:${PASSWORD}@db.tenant.example:5432/neondb?sslmode=require`;
const realPath = process.env['PATH'];

beforeAll(() => {
  process.env['PATH'] = `${join(__dirname, '..', 'helpers', 'fakePgDump')}${delimiter}${realPath}`;
});

let logged: string[];

beforeEach(async () => {
  await truncateAuthTables();
  store.current = createObjectStore();
  getProductionMigrationEnv.mockReset();
  getProductionMigrationEnv.mockImplementation(async () => ({ DIRECT_URL: directUrl }));
  vi.mocked(sendEvent).mockClear();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  process.env['PATH'] = realPath;
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const exportsOf = (applicationId: string) =>
  adminDb.hostedApplicationExport.findMany({ where: { applicationId } });

function expectNoCredential(text: string) {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(directUrl);
}

describe('createExport', () => {
  it('stores an on-demand dump by an admin, then writes exactly one row, kept 7 days', async () => {
    const world = await fixtures.seedExportWorld();
    const before = Date.now();
    const id = await hostedApplicationExportService.createExport(
      world.applicationId,
      { kind: 'on_demand' },
      { kind: 'user', userId: world.fx.ownerId },
    );

    const key = exportStorageKey(world.fx.workspaceId, world.applicationId, id);
    const stored = store.current.objects.get(key);
    expect(stored?.bytes.subarray(0, 5).toString()).toBe('PGDMP');
    const rows = await exportsOf(world.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      kind: 'on_demand',
      requestedByUserId: world.fx.ownerId,
      storageKey: key,
      sizeBytes: BigInt(stored!.bytes.length),
    });
    const kept = rows[0]!.expiresAt.getTime() - before;
    expect(kept).toBeGreaterThanOrEqual(7 * DAY);
    expect(kept).toBeLessThan(7 * DAY + 60_000);
    for (const line of logged) expectNoCredential(line);
  });

  it('hands pg_dump the password in its environment only, never in its arguments', async () => {
    const world = await fixtures.seedExportWorld();
    const id = await hostedApplicationExportService.createExport(
      world.applicationId,
      { kind: 'final' },
      { kind: 'system' },
    );
    const key = exportStorageKey(world.fx.workspaceId, world.applicationId, id);
    const seen = JSON.parse(store.current.objects.get(key)!.bytes.subarray(5).toString()) as {
      args: string[];
      password: string | null;
      env: string[];
    };
    expect(seen.args).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--dbname=postgresql://tenant@db.tenant.example:5432/neondb?sslmode=require',
    ]);
    expect(seen.password).toBe(PASSWORD);
    expect(seen.env.sort()).toEqual(['PATH', 'PGCONNECT_TIMEOUT', 'PGPASSWORD']);
  });

  it('takes a final export for the system, kept 30 days and asked for by nobody', async () => {
    const world = await fixtures.seedExportWorld({ target: 'serverless' });
    const before = Date.now();
    const id = await hostedApplicationExportService.createExport(
      world.applicationId,
      { kind: 'final' },
      { kind: 'system' },
    );
    const row = await adminDb.hostedApplicationExport.findUniqueOrThrow({ where: { id } });
    expect(row.requestedByUserId).toBeNull();
    expect(row.kind).toBe('final');
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * DAY);
  });

  it('answers the export already recorded when asked again with the same id', async () => {
    const world = await fixtures.seedExportWorld();
    const actor = { kind: 'user' as const, userId: world.fx.ownerId };
    const opts = { kind: 'on_demand' as const, exportId: 'exp-fixed-1' };
    expect(
      await hostedApplicationExportService.createExport(world.applicationId, opts, actor),
    ).toBe('exp-fixed-1');
    getProductionMigrationEnv.mockClear();
    expect(
      await hostedApplicationExportService.createExport(world.applicationId, opts, actor),
    ).toBe('exp-fixed-1');
    expect(getProductionMigrationEnv).not.toHaveBeenCalled();
    expect(await exportsOf(world.applicationId)).toHaveLength(1);
  });

  describe('refuses before any dump, upload or row', () => {
    async function refused(
      run: (world: Awaited<ReturnType<typeof fixtures.seedExportWorld>>) => Promise<unknown>,
      opts: Parameters<typeof fixtures.seedExportWorld>[0] = {},
    ) {
      const world = await fixtures.seedExportWorld(opts);
      const error = await run(world).catch((e: unknown) => e);
      expect(getProductionMigrationEnv).not.toHaveBeenCalled();
      expect(store.current.objects.size).toBe(0);
      expect(await exportsOf(world.applicationId)).toHaveLength(0);
      return error;
    }
    const onDemand = (applicationId: string, userId: string) =>
      hostedApplicationExportService.createExport(
        applicationId,
        { kind: 'on_demand' },
        { kind: 'user', userId },
      );

    it('an organisation member who is not an admin, and a user of another organisation', async () => {
      const member = await createTestUser();
      const stranger = await createTestUser();
      expect(
        await refused(async (w) => {
          await fixtures.addOrgMember(w.organizationId, member.id, 'member');
          return onDemand(w.applicationId, member.id);
        }),
      ).toBeInstanceOf(OrgForbiddenError);
      expect(await refused((w) => onDemand(w.applicationId, stranger.id))).toBeInstanceOf(
        OrgForbiddenError,
      );
    });

    it.each(['live', 'handing_over', 'handed_over'])('an application in %s', async (state) => {
      const error = await refused((w) => onDemand(w.applicationId, w.fx.ownerId), { state });
      expect(error).toBeInstanceOf(ExportNotAllowedError);
      expect((error as InstanceType<typeof ExportNotAllowedError>).reason).toBe('not_in_grace');
    });

    it('an AWS application', async () => {
      const error = await refused((w) => onDemand(w.applicationId, w.fx.ownerId), {
        target: 'aws',
      });
      expect(error).toBeInstanceOf(ExportTargetUnsupportedError);
    });

    it('a final export asked for by a person, and an on-demand one by the system', async () => {
      const final = await refused((w) =>
        hostedApplicationExportService.createExport(
          w.applicationId,
          { kind: 'final' },
          { kind: 'user', userId: w.fx.ownerId },
        ),
      );
      expect((final as InstanceType<typeof ExportNotAllowedError>).reason).toBe(
        'final_needs_system',
      );
      const system = await refused((w) =>
        hostedApplicationExportService.createExport(
          w.applicationId,
          { kind: 'on_demand' },
          { kind: 'system' },
        ),
      );
      expect((system as InstanceType<typeof ExportNotAllowedError>).reason).toBe(
        'on_demand_needs_admin',
      );
    });

    it('an unknown application, and one reached through another organisation', async () => {
      expect(
        await hostedApplicationExportService
          .createExport('nope', { kind: 'final' }, { kind: 'system' })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(ExportNotFoundError);
      const error = await refused((w) =>
        hostedApplicationExportService.createExport(
          w.applicationId,
          { kind: 'on_demand' },
          { kind: 'user', userId: w.fx.ownerId },
          { organizationId: 'another-org' },
        ),
      );
      expect(error).toBeInstanceOf(ExportNotFoundError);
    });

    it('a stranger through a route is answered not found, not forbidden', async () => {
      const stranger = await createTestUser();
      const error = await refused((w) =>
        hostedApplicationExportService.createExport(
          w.applicationId,
          { kind: 'on_demand' },
          { kind: 'user', userId: stranger.id },
          { organizationId: w.organizationId },
        ),
      );
      expect(error).toBeInstanceOf(ExportNotFoundError);
    });
  });

  describe('a failed dump or upload leaves nothing behind', () => {
    it('pg_dump exiting non-zero: no row, the partial object deleted, no credential anywhere', async () => {
      const world = await fixtures.seedExportWorld();
      const missing = new URL(directUrl);
      missing.pathname = '/export_fail';
      getProductionMigrationEnv.mockResolvedValue({ DIRECT_URL: missing.toString() });

      const error = await hostedApplicationExportService
        .createExport(world.applicationId, { kind: 'final' }, { kind: 'system' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExportFailedError);
      expect((error as InstanceType<typeof ExportFailedError>).stage).toBe('dump');
      expect((error as InstanceType<typeof ExportFailedError>).status).not.toBe(0);
      expectNoCredential(String((error as Error).message));
      expectNoCredential(JSON.stringify(error));
      expect(await exportsOf(world.applicationId)).toHaveLength(0);
      expect(store.current.objects.size).toBe(0);
      expect(store.current.deleted).toHaveLength(1);
      for (const line of logged) expectNoCredential(line);
    });

    it('the upload failing: no row, the partial object deleted, only the status carried', async () => {
      const world = await fixtures.seedExportWorld();
      store.current.failNextUpload = 503;

      const error = await hostedApplicationExportService
        .createExport(world.applicationId, { kind: 'final' }, { kind: 'system' })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ stage: 'upload', status: 503 });
      expectNoCredential(String((error as Error).message));
      expect(await exportsOf(world.applicationId)).toHaveLength(0);
      expect(store.current.objects.size).toBe(0);
      for (const line of logged) expectNoCredential(line);
    });

    it('the database port failing: the status only, nothing dumped', async () => {
      const world = await fixtures.seedExportWorld();
      getProductionMigrationEnv.mockRejectedValue(
        new ProductionDatabaseUnreadableError(world.applicationId, 'absent'),
      );
      const error = await hostedApplicationExportService
        .createExport(world.applicationId, { kind: 'final' }, { kind: 'system' })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ stage: 'database', status: null });
      expect(store.current.objects.size).toBe(0);
    });

    it('the row write failing: the stored object is deleted again', async () => {
      const world = await fixtures.seedExportWorld();
      const { hostedApplicationExportRepository } =
        await import('@/lib/repositories/hostedApplicationExportRepository');
      vi.spyOn(hostedApplicationExportRepository, 'create').mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(
        hostedApplicationExportService.createExport(
          world.applicationId,
          { kind: 'final' },
          { kind: 'system' },
        ),
      ).rejects.toThrow('db down');
      expect(store.current.objects.size).toBe(0);
    });

    it('a delete that fails too is logged by key only, and the real failure still thrown', async () => {
      const world = await fixtures.seedExportWorld();
      store.current.failNextUpload = 500;
      vi.spyOn(store.current, 'deleteAttachmentBlob').mockRejectedValue(new Error('gone'));
      await expect(
        hostedApplicationExportService.createExport(
          world.applicationId,
          { kind: 'final' },
          { kind: 'system' },
        ),
      ).rejects.toBeInstanceOf(ExportFailedError);
      expect(logged.some((l) => l.includes('could not delete the partial export'))).toBe(true);
      for (const line of logged) expectNoCredential(line);
    });
  });
});

describe('requestExport', () => {
  it('gates now and enqueues the dump keyed by the export id it answers', async () => {
    const world = await fixtures.seedExportWorld();
    const { jobId } = await hostedApplicationExportService.requestExport(
      world.applicationId,
      { kind: 'user', userId: world.fx.ownerId },
      { organizationId: world.organizationId },
    );
    expect(sendEvent).toHaveBeenCalledWith('hosting.application-export', {
      workspaceId: world.fx.workspaceId,
      applicationId: world.applicationId,
      userId: world.fx.ownerId,
      exportId: jobId,
      idempotencyKey: jobId,
    });
    expect(getProductionMigrationEnv).not.toHaveBeenCalled();
  });

  it('enqueues nothing for an application not in grace', async () => {
    const world = await fixtures.seedExportWorld({ state: 'live' });
    await expect(
      hostedApplicationExportService.requestExport(world.applicationId, {
        kind: 'user',
        userId: world.fx.ownerId,
      }),
    ).rejects.toBeInstanceOf(ExportNotAllowedError);
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe('listExports and downloadUrl', () => {
  async function seedRows(world: Awaited<ReturnType<typeof fixtures.seedExportWorld>>) {
    const base = {
      workspaceId: world.fx.workspaceId,
      applicationId: world.applicationId,
      requestedByUserId: world.fx.ownerId,
      sizeBytes: BigInt(42),
    };
    const now = Date.now();
    const old = await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        kind: 'on_demand',
        storageKey: 'k/old',
        createdAt: new Date(now - 2 * DAY),
        expiresAt: new Date(now + DAY),
      },
    });
    const fresh = await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        kind: 'final',
        requestedByUserId: null,
        storageKey: 'k/fresh',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + 29 * DAY),
      },
    });
    const expired = await adminDb.hostedApplicationExport.create({
      data: {
        ...base,
        kind: 'on_demand',
        storageKey: 'k/expired',
        createdAt: new Date(now - 8 * DAY),
        expiresAt: new Date(now - 1000),
      },
    });
    return { old, fresh, expired };
  }

  it('lists only the unexpired exports, newest first, with no storage key', async () => {
    const world = await fixtures.seedExportWorld();
    const { old, fresh } = await seedRows(world);
    const list = await hostedApplicationExportService.listExports(world.applicationId, {
      kind: 'user',
      userId: world.fx.ownerId,
    });
    expect(list.map((e) => e.id)).toEqual([fresh.id, old.id]);
    expect(list[0]).toEqual({
      id: fresh.id,
      applicationId: world.applicationId,
      kind: 'final',
      requestedByUserId: null,
      sizeBytes: '42',
      createdAt: fresh.createdAt.toISOString(),
      expiresAt: fresh.expiresAt.toISOString(),
    });
    expect(JSON.stringify(list)).not.toContain('k/');
  });

  it('refuses a listing to a member who is not an admin', async () => {
    const world = await fixtures.seedExportWorld();
    const member = await createTestUser();
    await fixtures.addOrgMember(world.organizationId, member.id, 'member');
    await expect(
      hostedApplicationExportService.listExports(world.applicationId, {
        kind: 'user',
        userId: member.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('signs a 300-second download link and records one download per call', async () => {
    const world = await fixtures.seedExportWorld();
    const { fresh } = await seedRows(world);
    const actor = { kind: 'user' as const, userId: world.fx.ownerId };
    const at = { applicationId: world.applicationId, organizationId: world.organizationId };
    const url = await hostedApplicationExportService.downloadUrl(fresh.id, actor, at);
    expect(url).toBe('https://store.test.invalid/k/fresh?ttl=300&download=true');
    await hostedApplicationExportService.downloadUrl(fresh.id, actor, at);
    const downloads = await adminDb.hostedApplicationExportDownload.findMany({
      where: { exportId: fresh.id },
    });
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toMatchObject({
      userId: world.fx.ownerId,
      workspaceId: world.fx.workspaceId,
    });
  });

  it('refuses an expired export, one of another application, and a non-admin', async () => {
    const world = await fixtures.seedExportWorld();
    const other = await fixtures.seedExportWorld();
    const { expired, fresh } = await seedRows(world);
    const owner = { kind: 'user' as const, userId: world.fx.ownerId };
    await expect(
      hostedApplicationExportService.downloadUrl(expired.id, owner, {
        applicationId: world.applicationId,
      }),
    ).rejects.toBeInstanceOf(ExportNotFoundError);
    await expect(
      hostedApplicationExportService.downloadUrl(
        fresh.id,
        { kind: 'user', userId: other.fx.ownerId },
        {
          applicationId: other.applicationId,
        },
      ),
    ).rejects.toBeInstanceOf(ExportNotFoundError);
    const member = await createTestUser();
    await fixtures.addOrgMember(world.organizationId, member.id, 'member');
    await expect(
      hostedApplicationExportService.downloadUrl(
        fresh.id,
        { kind: 'user', userId: member.id },
        {
          applicationId: world.applicationId,
        },
      ),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect(await adminDb.hostedApplicationExportDownload.count()).toBe(0);
  });
});

describe('sweepExpiredExports', () => {
  it('deletes the object, then the downloads and the row, of every export past expiry only', async () => {
    const world = await fixtures.seedExportWorld();
    const other = await fixtures.seedExportWorld({ target: 'serverless' });
    const now = Date.now();
    const row = (w: typeof world, key: string, expiresAt: number) =>
      adminDb.hostedApplicationExport.create({
        data: {
          workspaceId: w.fx.workspaceId,
          applicationId: w.applicationId,
          kind: 'on_demand',
          requestedByUserId: null,
          storageKey: key,
          sizeBytes: BigInt(1),
          expiresAt: new Date(expiresAt),
        },
      });
    const gone = await row(world, 'k/a', now - 1000);
    const goneToo = await row(other, 'k/b', now - DAY);
    const kept = await row(world, 'k/c', now + DAY);
    await adminDb.hostedApplicationExportDownload.create({
      data: { workspaceId: world.fx.workspaceId, exportId: gone.id, userId: world.fx.ownerId },
    });

    expect(await hostedApplicationExportService.sweepExpiredExports()).toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(store.current.deleted.sort()).toEqual(['k/a', 'k/b']);
    const left = await adminDb.hostedApplicationExport.findMany({ select: { id: true } });
    expect(left.map((r) => r.id)).toEqual([kept.id]);
    expect(await adminDb.hostedApplicationExportDownload.count()).toBe(0);
    expect(goneToo.id).not.toBe(kept.id);
  });

  it('finishes cleanly on a re-run after the object went but the row delete failed', async () => {
    const world = await fixtures.seedExportWorld();
    await adminDb.hostedApplicationExport.create({
      data: {
        workspaceId: world.fx.workspaceId,
        applicationId: world.applicationId,
        kind: 'final',
        requestedByUserId: null,
        storageKey: 'k/x',
        sizeBytes: BigInt(1),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const { hostedApplicationExportRepository } =
      await import('@/lib/repositories/hostedApplicationExportRepository');
    vi.spyOn(hostedApplicationExportRepository, 'deleteById').mockRejectedValueOnce(
      new Error('db down'),
    );

    expect(await hostedApplicationExportService.sweepExpiredExports()).toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(store.current.deleted).toEqual(['k/x']);
    expect(await adminDb.hostedApplicationExport.count()).toBe(1);

    expect(await hostedApplicationExportService.sweepExpiredExports()).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(store.current.deleted).toEqual(['k/x', 'k/x']);
    expect(await adminDb.hostedApplicationExport.count()).toBe(0);
  });
});
