import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObjectStore, type ObjectStore } from '../helpers/hostedApplicationExportFixtures';

// THE END OF A GRACE WINDOW (Story MOTIR-9800 · MOTIR-12135) over real Postgres:
// `stopApplication` and the `system.hosting-application-grace-stop` sweep stop
// serving, take the final export, delete the database only once that export's
// row exists, release the addresses and record `handed_over`, keeping the row;
// a stop cut off at any step and run again finishes without repeating a
// destructive call in effect; the sweep and Stop now racing end with one
// handover; and nothing reads a credit balance. The hosting and database ports
// are the orchestrator's fakes, `pg_dump` the stand-in first on PATH
// (tests/helpers/fakePgDump), the object store the in-memory stand-in, and the
// database port's direct URL the one service stub.

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
// The organisation's credit balance, read through motir-ai: exhausted, and
// watched, so a test can assert nothing in the stop path asks for it.
const { getOrgUsage } = vi.hoisted(() => ({ getOrgUsage: vi.fn() }));
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgUsage,
}));

const { db } = await import('@/lib/db');
const {
  ApplicationNotFoundError,
  ApplicationNotStoppableError,
  ApplicationStopFailedError,
  ExportFailedError,
} = await import('@/lib/hosting/errors');
const { sendEvent } = await import('@/lib/jobs/sendEvent');
const { OrgForbiddenError } = await import('@/lib/organizations/errors');
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { getDatabasePort, resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { hostedApplicationRepository, releasedSlugOf } =
  await import('@/lib/repositories/hostedApplicationRepository');
const { hostedApplicationHandoverService, STOP_LOCK_TIMEOUT_MS } =
  await import('@/lib/services/hostedApplicationHandoverService');
const { hostedApplicationExportService } =
  await import('@/lib/services/hostedApplicationExportService');
const { hostedReleaseUsageService } = await import('@/lib/services/hostedReleaseUsageService');
const { HOSTED_APPLICATION_GRACE_STOP_CRON, hostedApplicationGraceStop } =
  await import('@/lib/jobs/definitions/hostedApplicationGraceStop');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { jobServices } = await import('@/lib/jobs/services');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

const DAY = 86_400_000;
const directUrl = 'postgresql://tenant:pw@db.tenant.example:5432/neondb?sslmode=require';
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
  getProductionMigrationEnv.mockReset();
  getProductionMigrationEnv.mockImplementation(async () => ({ DIRECT_URL: directUrl }));
  getOrgUsage.mockReset();
  getOrgUsage.mockResolvedValue({ balance: 0 });
  vi.mocked(sendEvent).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

const SYSTEM = { kind: 'system' } as const;
const application = (id: string) => adminDb.hostedApplication.findUniqueOrThrow({ where: { id } });
const finalExports = (applicationId: string) =>
  adminDb.hostedApplicationExport.findMany({ where: { applicationId, kind: 'final' } });

/** A Fly application in its grace window, serving from `mh-shop-<n>` on its own
 *  address, with a database, whose window ended (or ends) `stopsInMs` from now. */
async function seedGraceApp(opts: { stopsInMs?: number; state?: string } = {}) {
  const world = await fixtures.seedExportWorld({ state: opts.state ?? 'grace' });
  const appName = `mh-shop-${world.applicationId}`;
  await adminDb.hostedApplication.update({
    where: { id: world.applicationId },
    data: {
      productionAppName: appName,
      productionAddress: `shop-${world.applicationId}.motir.site`,
      databaseUrlCiphertext: 'v1:ciphertext',
      stopsAt: new Date(Date.now() + (opts.stopsInMs ?? -DAY)),
    },
  });
  const before = await application(world.applicationId);
  return { ...world, appName, databaseRef: before.databaseProjectId!, slug: before.slug };
}

/** Spies on the provider calls, each calling through to the fake; every
 *  `deleteDatabase` records how many final export rows existed at that moment. */
function watchProvider(applicationId?: string) {
  const port = getHostingDeployPort('fly');
  const databases = getDatabasePort();
  const realDelete = databases.deleteDatabase.bind(databases);
  const exportsAtDelete: number[] = [];
  const deleteDatabase = vi
    .spyOn(databases, 'deleteDatabase')
    .mockImplementation(async (handle) => {
      if (applicationId) exportsAtDelete.push((await finalExports(applicationId)).length);
      return realDelete(handle);
    });
  return {
    destroyApp: vi.spyOn(port, 'destroyApp'),
    ensureApp: vi.spyOn(port, 'ensureApp'),
    deleteDatabase,
    exportsAtDelete,
  };
}

/** How many of a spy's calls returned (a call made to fail did nothing). */
async function returnedCount(spy: { mock: { results: { type: string; value: unknown }[] } }) {
  const settled = await Promise.allSettled(
    spy.mock.results.map((r) => (r.type === 'return' ? r.value : Promise.reject(r.value))),
  );
  return settled.filter((r) => r.status === 'fulfilled').length;
}

/** Run the sweep's handler as the engine would, each step executed once. */
async function runSweep() {
  type Ctx = Parameters<typeof hostedApplicationGraceStop.handler>[0];
  const run = vi.fn(async (_id: string, fn: () => unknown) => fn());
  const ctx = {
    event: { name: 'system.hosting-application-grace-stop', data: {}, id: 'e' },
    runId: 'run',
    attempt: 0,
    step: { run },
  } as unknown as Ctx;
  const result = (await hostedApplicationGraceStop.handler(ctx, jobServices)) as {
    due: number;
    stopped: number;
    failed: number;
  };
  return { result, run };
}

async function expectHandedOver(world: Awaited<ReturnType<typeof seedGraceApp>>) {
  const row = await application(world.applicationId);
  expect(row).toMatchObject({
    state: 'handed_over',
    productionAppName: null,
    currentReleaseId: null,
    previousReleaseId: null,
    productionAddress: null,
    slug: releasedSlugOf(world.applicationId),
    databaseProjectId: null,
    databaseUrlCiphertext: null,
  });
  expect(row.handedOverAt).toBeInstanceOf(Date);
  const finals = await finalExports(world.applicationId);
  expect(finals).toHaveLength(1);
  const retention = finals[0]!.expiresAt.getTime() - finals[0]!.createdAt.getTime();
  expect(Math.abs(retention - 30 * DAY)).toBeLessThan(60_000);
  expect(store.current.objects.has(finals[0]!.storageKey)).toBe(true);
  expect(vi.mocked(sendEvent)).toHaveBeenCalledWith('hosting.application-grace.notice', {
    workspaceId: world.fx.workspaceId,
    applicationId: world.applicationId,
    kind: 'stopped',
    idempotencyKey: `${world.applicationId}:stopped`,
  });
  return row;
}

const stoppedNoticeKeys = () =>
  new Set(
    vi
      .mocked(sendEvent)
      .mock.calls.filter(([name]) => name === 'hosting.application-grace.notice')
      .map(([, data]) => (data as { idempotencyKey: string }).idempotencyKey),
  );

describe('the grace stop sweep', () => {
  it('is registered hourly, and its services bag carries the handover service', () => {
    expect(jobDefinitions).toContain(hostedApplicationGraceStop);
    expect(HOSTED_APPLICATION_GRACE_STOP_CRON).toBe('35 * * * *');
    expect(jobServices.hostedApplicationHandover).toBe(hostedApplicationHandoverService);
    expect(STOP_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('stops a grace application whose stopsAt has passed, keeping its row, and leaves the rest', async () => {
    const due = await seedGraceApp();
    const notYet = await seedGraceApp({ stopsInMs: 5 * DAY });
    const live = await seedGraceApp({ state: 'live' });
    const watch = watchProvider();

    const { result, run } = await runSweep();

    expect(result).toEqual({ due: 1, stopped: 1, failed: 0 });
    expect(run).toHaveBeenCalledWith('list-grace-applications-due', expect.any(Function));
    expect(run).toHaveBeenCalledWith(`grace-stop:${due.applicationId}`, expect.any(Function));
    await expectHandedOver(due);
    expect(watch.destroyApp).toHaveBeenCalledTimes(1);
    expect(watch.destroyApp).toHaveBeenCalledWith({ appRef: due.appName });
    expect(watch.deleteDatabase).toHaveBeenCalledTimes(1);
    expect(watch.deleteDatabase).toHaveBeenCalledWith({
      provider: 'neon',
      applicationRef: (await application(due.applicationId)).projectRepositoryId,
      databaseRef: due.databaseRef,
    });
    expect(stoppedNoticeKeys()).toEqual(new Set([`${due.applicationId}:stopped`]));
    for (const other of [notYet, live]) {
      const row = await application(other.applicationId);
      expect(row.state).toBe(other === live ? 'live' : 'grace');
      expect(row.productionAppName).toBe(other.appName);
      expect(await finalExports(other.applicationId)).toEqual([]);
    }
  });

  it('answers each stop in its own step: one failure blocks none of the others', async () => {
    vi.spyOn(hostedApplicationHandoverService, 'listApplicationsDueToStop').mockResolvedValue([
      'a',
      'b',
      'c',
      'd',
    ]);
    vi.spyOn(hostedApplicationHandoverService, 'stopApplication').mockImplementation(async (id) => {
      if (id === 'a') throw new ApplicationStopFailedError('a', 'final_export', 'EXPORT_FAILED');
      if (id === 'b') throw new ApplicationNotStoppableError('b', 'live');
      if (id === 'c') throw 'not an Error';
      return {
        outcome: 'stopped',
        applicationId: id,
        handedOverAt: new Date(),
        finalExportId: 'x',
      };
    });
    const { result } = await runSweep();
    expect(result).toEqual({ due: 4, stopped: 1, failed: 2 });
    expect(hostedApplicationHandoverService.stopApplication).toHaveBeenCalledWith('d', SYSTEM);
  });

  it('never stops a grace application early, even with its organisation out of credit', async () => {
    const world = await seedGraceApp({ stopsInMs: 3 * DAY });
    const watch = watchProvider();
    const { result } = await runSweep();
    expect(result).toEqual({ due: 0, stopped: 0, failed: 0 });
    const row = await application(world.applicationId);
    expect(row.state).toBe('grace');
    expect(row.productionAppName).toBe(world.appName);
    expect(row.productionAddress).not.toBeNull();
    expect(watch.destroyApp).not.toHaveBeenCalled();
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect(getOrgUsage).not.toHaveBeenCalled();

    // And once its window ends, its stop reads no balance either.
    await adminDb.hostedApplication.update({
      where: { id: world.applicationId },
      data: { stopsAt: new Date(Date.now() - 1000) },
    });
    await runSweep();
    await expectHandedOver(world);
    expect(getOrgUsage).not.toHaveBeenCalled();
  });
});

describe('stopApplication', () => {
  it('lists only grace applications whose stopsAt has passed, soonest first', async () => {
    const later = await seedGraceApp({ stopsInMs: -DAY });
    const sooner = await seedGraceApp({ stopsInMs: -2 * DAY });
    await seedGraceApp({ stopsInMs: DAY });
    expect(await hostedApplicationHandoverService.listApplicationsDueToStop()).toEqual([
      sooner.applicationId,
      later.applicationId,
    ]);
  });

  it('calls nothing on the provider for an app with neither a name nor a release', async () => {
    const world = await seedGraceApp();
    await adminDb.hostedApplication.update({
      where: { id: world.applicationId },
      data: { productionAppName: null },
    });
    const watch = watchProvider();
    // No releases and no name: nothing on the provider to remove.
    await hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM);
    expect(watch.ensureApp).not.toHaveBeenCalled();
    expect(watch.destroyApp).not.toHaveBeenCalled();
    await expectHandedOver(world);
  });

  it.each([
    ['stop_serving', 'destroyApp'],
    ['stop_serving', 'clearProductionPointers'],
    ['final_export', 'export'],
    ['delete_database', 'deleteDatabase'],
    ['delete_database', 'clearDatabase'],
    ['record', 'releaseAddresses'],
  ] as const)(
    'cut off at %s (%s fails) and run again, reaches the same end state without repeating a delete in effect',
    async (step, failing) => {
      const world = await seedGraceApp();
      const watch = watchProvider(world.applicationId);

      const boom = new Error('cut off');
      switch (failing) {
        case 'destroyApp':
          watch.destroyApp.mockRejectedValueOnce(boom);
          break;
        case 'clearProductionPointers':
          vi.spyOn(hostedApplicationRepository, 'clearProductionPointers').mockRejectedValueOnce(
            boom,
          );
          break;
        case 'export':
          store.current.failNextUpload = 503;
          break;
        case 'deleteDatabase':
          watch.deleteDatabase.mockRejectedValueOnce(boom);
          break;
        case 'clearDatabase':
          vi.spyOn(hostedApplicationRepository, 'clearDatabase').mockRejectedValueOnce(boom);
          break;
        case 'releaseAddresses':
          vi.spyOn(hostedApplicationRepository, 'releaseAddresses').mockRejectedValueOnce(boom);
          break;
      }

      const error = await hostedApplicationHandoverService
        .stopApplication(world.applicationId, SYSTEM)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApplicationStopFailedError);
      expect((error as InstanceType<typeof ApplicationStopFailedError>).step).toBe(step);
      expect((await application(world.applicationId)).state).toBe('grace');
      expect(sendEvent).not.toHaveBeenCalled();

      await hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM);
      await expectHandedOver(world);

      // Every delete saw the final export row; each provider delete returned once.
      expect(watch.exportsAtDelete.length).toBeGreaterThan(0);
      expect(watch.exportsAtDelete.every((n) => n === 1)).toBe(true);
      const destroyed = await returnedCount(watch.destroyApp);
      const deleted = await returnedCount(watch.deleteDatabase);
      // A delete whose own record failed is called again; the provider answers
      // a gone app or database with nothing, so it happened once in effect.
      expect(destroyed).toBe(failing === 'clearProductionPointers' ? 2 : 1);
      expect(deleted).toBe(failing === 'clearDatabase' ? 2 : 1);
      expect(await finalExports(world.applicationId)).toHaveLength(1);
    },
  );

  it('leaves a grace application untouched when its final export fails, and the next sweep retries it', async () => {
    const world = await seedGraceApp();
    const watch = watchProvider();
    store.current.failNextUpload = 500;
    const { result } = await runSweep();
    expect(result).toEqual({ due: 1, stopped: 0, failed: 1 });
    const row = await application(world.applicationId);
    expect(row.state).toBe('grace');
    expect(row.databaseProjectId).toBe(world.databaseRef);
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(await finalExports(world.applicationId)).toEqual([]);

    expect((await runSweep()).result).toEqual({ due: 1, stopped: 1, failed: 0 });
    await expectHandedOver(world);
    expect(watch.deleteDatabase).toHaveBeenCalledTimes(1);
  });

  it('names the export failure and requires the export row before the delete', async () => {
    const world = await seedGraceApp();
    const watch = watchProvider();
    vi.spyOn(hostedApplicationExportService, 'createExport').mockRejectedValueOnce(
      new ExportFailedError(world.applicationId, 'dump', 1),
    );
    await expect(
      hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).rejects.toMatchObject({ step: 'final_export', detail: 'EXPORT_FAILED' });
    // An export that answers without recording a row is a failure too.
    vi.spyOn(hostedApplicationExportService, 'createExport').mockResolvedValueOnce('ghost');
    await expect(
      hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).rejects.toMatchObject({ step: 'final_export', detail: 'FINAL_EXPORT_NOT_RECORDED' });
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect((await application(world.applicationId)).state).toBe('grace');
  });

  it('changes nothing and calls no provider on an application already handed over', async () => {
    const world = await seedGraceApp();
    await hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM);
    const after = await application(world.applicationId);
    const watch = watchProvider();
    vi.mocked(sendEvent).mockClear();

    const again = await hostedApplicationHandoverService.stopApplication(
      world.applicationId,
      SYSTEM,
    );
    expect(again).toMatchObject({
      outcome: 'already_stopped',
      applicationId: world.applicationId,
      handedOverAt: after.handedOverAt,
    });
    expect(await application(world.applicationId)).toEqual(after);
    expect(watch.destroyApp).not.toHaveBeenCalled();
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect(watch.ensureApp).not.toHaveBeenCalled();
    expect(await finalExports(world.applicationId)).toHaveLength(1);
    // The notice is re-enqueued under its key, which the queue collapses.
    expect(stoppedNoticeKeys()).toEqual(new Set([`${world.applicationId}:stopped`]));
  });

  it('sends no stopped notice for an application handed over without a stop (AWS)', async () => {
    const world = await fixtures.seedExportWorld({ target: 'aws', state: 'handed_over' });
    const watch = watchProvider();
    expect(
      await hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).toEqual({
      outcome: 'already_stopped',
      applicationId: world.applicationId,
      handedOverAt: null,
      finalExportId: null,
    });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(watch.destroyApp).not.toHaveBeenCalled();
  });

  it('ends a race between the sweep and Stop now with exactly one handover', async () => {
    const world = await seedGraceApp();
    const watch = watchProvider();
    const [a, b] = await Promise.all([
      runSweep().then((r) => r.result),
      hostedApplicationHandoverService.stopApplication(world.applicationId, {
        kind: 'user',
        userId: world.fx.ownerId,
      }),
    ]);
    const outcomes = [a.stopped === 1 ? 'stopped' : 'already_stopped', b.outcome].sort();
    expect(outcomes).toEqual(['already_stopped', 'stopped']);
    await expectHandedOver(world);
    expect(watch.destroyApp).toHaveBeenCalledTimes(1);
    expect(watch.deleteDatabase).toHaveBeenCalledTimes(1);
    expect(await finalExports(world.applicationId)).toHaveLength(1);
    expect(stoppedNoticeKeys()).toEqual(new Set([`${world.applicationId}:stopped`]));
  });

  it('refuses before any provider call: unknown, not in grace, and the admin gate', async () => {
    const world = await seedGraceApp({ state: 'live' });
    const watch = watchProvider();
    await expect(
      hostedApplicationHandoverService.stopApplication('nope', SYSTEM),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    await expect(
      hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).rejects.toBeInstanceOf(ApplicationNotStoppableError);

    const grace = await seedGraceApp();
    const member = await createTestUser();
    const stranger = await createTestUser();
    await fixtures.addOrgMember(grace.organizationId, member.id, 'member');
    await expect(
      hostedApplicationHandoverService.stopApplication(grace.applicationId, {
        kind: 'user',
        userId: member.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(
      hostedApplicationHandoverService.stopApplication(grace.applicationId, {
        kind: 'user',
        userId: stranger.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(
      hostedApplicationHandoverService.stopApplication(
        grace.applicationId,
        { kind: 'user', userId: stranger.id },
        { organizationId: grace.organizationId },
      ),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    await expect(
      hostedApplicationHandoverService.stopApplication(
        grace.applicationId,
        { kind: 'user', userId: grace.fx.ownerId },
        { organizationId: world.organizationId },
      ),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    expect(watch.destroyApp).not.toHaveBeenCalled();
    expect(watch.deleteDatabase).not.toHaveBeenCalled();
    expect((await application(grace.applicationId)).state).toBe('grace');
  });

  it('refuses an application that left grace while it waited for the lock', async () => {
    const world = await seedGraceApp();
    const real = hostedApplicationRepository.findTeardownById.bind(hostedApplicationRepository);
    vi.spyOn(hostedApplicationRepository, 'findTeardownById').mockImplementationOnce(
      async (id, tx) => ({ ...(await real(id, tx))!, state: 'live' }),
    );
    await expect(
      hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).rejects.toBeInstanceOf(ApplicationNotStoppableError);
    vi.spyOn(hostedApplicationRepository, 'findTeardownById').mockResolvedValueOnce(null);
    await expect(
      hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
  });

  it('settles the live release before destroying the app the releases ran on', async () => {
    const world = await seedGraceApp();
    const settle = vi
      .spyOn(hostedReleaseUsageService, 'settleReleaseUsage')
      .mockResolvedValue({ outcome: 'not_live' });
    const fakeRelease = { currentReleaseId: 'rel-1', previousReleaseId: null };
    const real = hostedApplicationRepository.findTeardownById.bind(hostedApplicationRepository);
    vi.spyOn(hostedApplicationRepository, 'findTeardownById').mockImplementationOnce(
      async (id, tx) => ({ ...(await real(id, tx))!, ...fakeRelease, productionAppName: null }),
    );
    const watch = watchProvider();
    await hostedApplicationHandoverService.stopApplication(world.applicationId, SYSTEM);
    expect(settle).toHaveBeenCalledWith('rel-1');
    expect(watch.ensureApp).toHaveBeenCalledTimes(1);
    const { appRef } = (await watch.ensureApp.mock.results[0]!.value) as { appRef: string };
    expect(watch.destroyApp).toHaveBeenCalledWith({ appRef });
    await expectHandedOver(world);
  });
});
