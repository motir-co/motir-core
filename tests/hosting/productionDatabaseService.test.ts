// MOTIR-10028 — the production database, against real Postgres and the database
// port's fake: one database per application under real concurrency, the URL
// stored only encrypted and read back only through `getProductionDatabaseEnv`,
// a failed create that writes nothing and leaks nothing, and the AWS target
// refused before any provider call.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostingTarget } from '@/generated/prisma/client';
import {
  createFakeDatabasePort,
  DATABASE_DIRECT_ENV,
  OrchestratorApiError,
  type DatabasePort,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  ApplicationNotFoundError,
  ProductionDatabaseKindUnsupportedError,
  ProductionDatabaseProvisioningError,
  ProductionDatabaseUnreadableError,
} from '@/lib/hosting/errors';
import {
  databaseKindForTarget,
  PRODUCTION_DATABASE_ENV_NAME,
} from '@/lib/hosting/productionDatabase';
import { registerDatabaseAdapter, unregisterDatabaseAdapter } from '@/lib/orchestrator/database';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionDatabaseService as service } from '@/lib/services/productionDatabaseService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const KEY = 'ab'.repeat(32);
const CONNECTION_STRING = /postgres(ql)?:\/\//;

let fake: ReturnType<typeof createFakeDatabasePort>;
let creates: string[];
let failWith: unknown;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let logged: string[];

/** The fake, counting creates and failing on demand. */
function countingPort(): DatabasePort {
  return {
    ...fake,
    async createDatabase(input) {
      creates.push(input.applicationRef);
      if (failWith !== undefined) throw failWith;
      // A yield, so a concurrent caller reaches the row lock while this create
      // is in flight.
      await new Promise((r) => setTimeout(r, 20));
      return fake.createDatabase(input);
    },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  fake = createFakeDatabasePort();
  creates = [];
  failWith = undefined;
  registerDatabaseAdapter('neon', countingPort);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
    });
  }
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  unregisterDatabaseAdapter('neon');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

async function application(
  fx: WorkItemFixture,
  opts: { role?: 'web' | 'api'; target?: HostingTarget } = {},
): Promise<{ applicationId: string; repositoryId: string }> {
  const role = opts.role ?? 'web';
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource: 'initialised', state: 'created', hostingTarget: opts.target ?? 'fly' },
  });
  const app = await hostedApplicationService.ensureApplication(row.id);
  return { applicationId: app.id, repositoryId: row.id };
}

async function columnsOf(applicationId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: { databaseProjectId: true, databaseUrlCiphertext: true },
  });
}

describe('databaseKindForTarget', () => {
  it('gives the serverless and Fly targets serverless Postgres and refuses AWS', () => {
    expect(databaseKindForTarget('serverless')).toBe('serverless_postgres');
    expect(databaseKindForTarget('fly')).toBe('serverless_postgres');
    expect(() => databaseKindForTarget('aws')).toThrow(ProductionDatabaseKindUnsupportedError);
    expect(PRODUCTION_DATABASE_ENV_NAME).toBe('DATABASE_URL');
  });
});

describe('ensureProductionDatabase', () => {
  it('creates one database, stores it encrypted and hands back the pooled string', async () => {
    const fx = await workspace();
    const { applicationId, repositoryId } = await application(fx);

    const ensured = await service.ensureProductionDatabase(applicationId);

    expect(ensured.created).toBe(true);
    expect(creates).toEqual([repositoryId]);
    const held = fake.databases()[0]!;
    expect(held.handle.applicationRef).toBe(repositoryId);
    const pooled = (await fake.connectionEnv(held.handle)).find((p) => p.name === 'DATABASE_URL')!;

    const columns = await columnsOf(applicationId);
    expect(columns.databaseProjectId).toBe(held.handle.databaseRef);
    expect(ensured.databaseProjectId).toBe(held.handle.databaseRef);
    expect(columns.databaseUrlCiphertext).toMatch(/^v1\./);
    expect(columns.databaseUrlCiphertext).not.toContain(pooled.value);
    expect(columns.databaseUrlCiphertext).not.toMatch(CONNECTION_STRING);

    expect(await service.getProductionDatabaseEnv(applicationId)).toEqual({
      DATABASE_URL: pooled.value,
    });
  });

  it('keeps the URL out of the application DTO', async () => {
    const fx = await workspace();
    const { applicationId, repositoryId } = await application(fx);
    await service.ensureProductionDatabase(applicationId);
    const { databaseUrlCiphertext } = await columnsOf(applicationId);
    const { DATABASE_URL } = await service.getProductionDatabaseEnv(applicationId);

    const dto = await hostedApplicationService.getApplicationForRepository(
      fx.workspaceId,
      repositoryId,
    );

    expect(dto!.hasDatabase).toBe(true);
    const json = JSON.stringify(dto);
    expect(json).not.toContain(DATABASE_URL);
    expect(json).not.toContain(databaseUrlCiphertext!);
    expect(json).not.toMatch(CONNECTION_STRING);
  });

  it('is a no-op the second time', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    const first = await service.ensureProductionDatabase(applicationId);
    const stored = await columnsOf(applicationId);

    const second = await service.ensureProductionDatabase(applicationId);

    expect(second).toEqual({ databaseProjectId: first.databaseProjectId, created: false });
    expect(creates).toHaveLength(1);
    expect(await columnsOf(applicationId)).toEqual(stored);
  });

  it('makes one database for two concurrent first releases', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);

    const outcomes = await Promise.all([
      service.ensureProductionDatabase(applicationId),
      service.ensureProductionDatabase(applicationId),
    ]);

    expect(creates).toHaveLength(1);
    expect(fake.databases()).toHaveLength(1);
    expect(outcomes.map((o) => o.created).sort()).toEqual([false, true]);
    expect(new Set(outcomes.map((o) => o.databaseProjectId)).size).toBe(1);
    const [a, b] = await Promise.all([
      service.getProductionDatabaseEnv(applicationId),
      service.getProductionDatabaseEnv(applicationId),
    ]);
    expect(a).toEqual(b);
  });

  it('writes nothing and leaks nothing when the create fails, and a retry succeeds', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    const leak = 'postgresql://app:hunter2@db-pooler.example.invalid/app';
    const err = new Error(`create failed for ${leak}`) as Error & { code: string };
    err.code = `boom ${leak}`;
    failWith = err;

    const thrown = await service.ensureProductionDatabase(applicationId).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProductionDatabaseProvisioningError);
    const failure = thrown as ProductionDatabaseProvisioningError;
    expect(failure.status).toBeNull();
    expect(failure.causeCode).toBe('UNKNOWN');
    const serialised = `${failure.message} ${failure.stack} ${JSON.stringify(failure)}`;
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toMatch(CONNECTION_STRING);
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
    expect(await columnsOf(applicationId)).toEqual({
      databaseProjectId: null,
      databaseUrlCiphertext: null,
    });

    failWith = undefined;
    const retried = await service.ensureProductionDatabase(applicationId);
    expect(retried.created).toBe(true);
    expect(fake.databases()).toHaveLength(1);
  });

  it("passes a provider failure's status and code, and nothing else", async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    failWith = new OrchestratorApiError('neon', 503, 'postgresql://leaked@x/y');

    const thrown = (await service
      .ensureProductionDatabase(applicationId)
      .catch((e: unknown) => e)) as ProductionDatabaseProvisioningError;

    expect(thrown).toBeInstanceOf(ProductionDatabaseProvisioningError);
    expect(thrown.status).toBe(503);
    expect(thrown.causeCode).toBe('ORCHESTRATOR_API_FAILED');
    expect(thrown.message).not.toMatch(CONNECTION_STRING);
  });

  it('refuses a port answer with no pooled string', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    registerDatabaseAdapter('neon', () => ({
      ...countingPort(),
      async createDatabase(input) {
        const created = await fake.createDatabase(input);
        return { ...created, env: created.env.filter((p) => p.name !== 'DATABASE_URL') };
      },
    }));

    await expect(service.ensureProductionDatabase(applicationId)).rejects.toMatchObject({
      causeCode: 'DATABASE_URL_MISSING',
    });
    expect(await columnsOf(applicationId)).toEqual({
      databaseProjectId: null,
      databaseUrlCiphertext: null,
    });
  });

  it('refuses the AWS target before any port call', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx, { target: 'aws' });

    await expect(service.ensureProductionDatabase(applicationId)).rejects.toBeInstanceOf(
      ProductionDatabaseKindUnsupportedError,
    );
    expect(creates).toEqual([]);
  });

  it('refuses an unknown application', async () => {
    await expect(service.ensureProductionDatabase('nope')).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
    expect(creates).toEqual([]);
  });

  it('gives two applications in one project their own databases', async () => {
    const fx = await workspace();
    const web = await application(fx);
    const api = await application(fx, { role: 'api', target: 'serverless' });

    await service.ensureProductionDatabase(web.applicationId);
    const apiBefore = await columnsOf(api.applicationId);
    expect(apiBefore).toEqual({ databaseProjectId: null, databaseUrlCiphertext: null });
    await service.ensureProductionDatabase(api.applicationId);
    const webAfter = await columnsOf(web.applicationId);

    expect(creates).toEqual([web.repositoryId, api.repositoryId]);
    const webEnv = await service.getProductionDatabaseEnv(web.applicationId);
    const apiEnv = await service.getProductionDatabaseEnv(api.applicationId);
    expect(webEnv.DATABASE_URL).not.toBe(apiEnv.DATABASE_URL);
    expect(await columnsOf(web.applicationId)).toEqual(webAfter);
    expect(webAfter.databaseProjectId).not.toBe(
      (await columnsOf(api.applicationId)).databaseProjectId,
    );
  });
});

describe('getProductionDatabaseEnv', () => {
  it('refuses an application with no database', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);

    await expect(service.getProductionDatabaseEnv(applicationId)).rejects.toMatchObject({
      constructor: ProductionDatabaseUnreadableError,
      reason: 'absent',
    });
  });

  it('refuses a ciphertext that fails the auth-tag check', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    await service.ensureProductionDatabase(applicationId);
    const { databaseUrlCiphertext } = await columnsOf(applicationId);
    const parts = databaseUrlCiphertext!.split('.');
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[2] = tag.toString('base64url');
    await adminDb.hostedApplication.update({
      where: { id: applicationId },
      data: { databaseUrlCiphertext: parts.join('.') },
    });

    await expect(service.getProductionDatabaseEnv(applicationId)).rejects.toMatchObject({
      constructor: ProductionDatabaseUnreadableError,
      reason: 'undecryptable',
    });
  });

  it('refuses an unknown application', async () => {
    await expect(service.getProductionDatabaseEnv('nope')).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });
});

describe('getProductionMigrationEnv (MOTIR-10030)', () => {
  it('hands back the direct string, which is not the pooled one, read from the provider', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    await service.ensureProductionDatabase(applicationId);

    const migration = await service.getProductionMigrationEnv(applicationId);
    const runtime = await service.getProductionDatabaseEnv(applicationId);

    expect(migration.DIRECT_URL).toMatch(CONNECTION_STRING);
    expect(migration.DIRECT_URL).not.toBe(runtime.DATABASE_URL);
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
  });

  it('refuses an application with no database, and an unknown one', async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);

    await expect(service.getProductionMigrationEnv(applicationId)).rejects.toMatchObject({
      constructor: ProductionDatabaseUnreadableError,
      reason: 'absent',
    });
    await expect(service.getProductionMigrationEnv('nope')).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });

  it("passes a provider failure's status and code, and refuses an answer with no direct string", async () => {
    const fx = await workspace();
    const { applicationId } = await application(fx);
    await service.ensureProductionDatabase(applicationId);
    registerDatabaseAdapter('neon', () => ({
      ...countingPort(),
      async connectionEnv() {
        throw new OrchestratorApiError('neon', 503, 'postgresql://leaked@x/y');
      },
    }));

    await expect(service.getProductionMigrationEnv(applicationId)).rejects.toMatchObject({
      constructor: ProductionDatabaseProvisioningError,
      status: 503,
    });

    registerDatabaseAdapter('neon', () => ({
      ...countingPort(),
      async connectionEnv(handle) {
        const pairs = await fake.connectionEnv(handle);
        return pairs.filter((p) => p.name !== DATABASE_DIRECT_ENV);
      },
    }));
    await expect(service.getProductionMigrationEnv(applicationId)).rejects.toMatchObject({
      constructor: ProductionDatabaseUnreadableError,
      reason: 'absent',
    });
  });
});
