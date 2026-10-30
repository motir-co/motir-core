// MOTIR-10030 — the production release service, against real Postgres, the
// deploy port's fake and the database port's fake: a commit released live and
// made current, the migration run before the deploy, every failure leaving the
// previous release serving, the environment merged with DATABASE_URL and never
// leaked, one release in flight per application, and a failed build recorded.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostingTarget } from '@/generated/prisma/client';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { environmentConfigCrypto } from '@/lib/environmentConfig/crypto';
import {
  CustomerRepositoryNotDeployableError,
  HostingManifestMissingError,
  ReleaseInProgressError,
} from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  PRODUCTION_MIGRATION_TIMEOUT_SECONDS,
  productionReleaseService as service,
  type ProductionReleaseDeps,
} from '@/lib/services/productionReleaseService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const KEY = 'cd'.repeat(32);
const CONNECTION_STRING = /postgres(ql)?:\/\//;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly', 'serverless'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};
const NO_DATABASE: HostingManifest = { ...MANIFEST, database: { kind: 'none' } };

let logged: string[];

function deps(manifest: HostingManifest = MANIFEST): ProductionReleaseDeps {
  return { readManifest: async () => manifest };
}

function hosting(target: HostingTarget = 'fly') {
  return getHostingDeployPort(target) as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

function databases() {
  return (getDatabasePort() as unknown as { databases(): unknown[] }).databases();
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  resetHostingFakes();
  resetDatabaseFakes();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message}` : String(a))).join(' '));
    });
  }
});

afterEach(() => {
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

async function repo(
  fx: WorkItemFixture,
  opts: { role?: 'web' | 'api'; target?: HostingTarget; seedSource?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'web';
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      seedSource: opts.seedSource ?? 'initialised',
      state: 'created',
      hostingTarget: opts.target ?? 'fly',
      hostingSize: 'medium',
    },
  });
  return row.id;
}

async function entry(
  fx: WorkItemFixture,
  repositoryId: string,
  name: string,
  value: string,
  secret = false,
) {
  await adminDb.environmentConfigEntry.create({
    data: {
      workspaceId: fx.workspaceId,
      projectRepositoryId: repositoryId,
      environment: 'production',
      name,
      isSecret: secret,
      value: secret ? environmentConfigCrypto.encryptToken(value) : value,
    },
  });
}

async function application(repositoryId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({
    where: { projectRepositoryId: repositoryId },
  });
}

async function releaseRow(id: string) {
  return adminDb.hostedRelease.findUniqueOrThrow({ where: { id } });
}

const release = (repositoryId: string, commitSha = SHA_A, over = {}) => ({
  projectRepositoryId: repositoryId,
  commitSha,
  artifactRef: `registry.fly.io/mh-${repositoryId}:${commitSha}`,
  cause: 'merge' as const,
  ...over,
});

describe('deployProductionRelease', () => {
  it('releases the exact commit live, makes it current and replaces the earlier one', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    const first = await service.deployProductionRelease(release(id, SHA_A), deps());
    const second = await service.deployProductionRelease(release(id, SHA_B), deps());

    expect(first.state).toBe('live');
    expect(second).toMatchObject({
      state: 'live',
      commitSha: SHA_B,
      artifactRef: `registry.fly.io/mh-${id}:${SHA_B}`,
      cause: 'merge',
    });
    expect(second.providerReleaseId).toMatch(/^rel-/);
    expect(second.liveAt).not.toBeNull();
    const app = await application(id);
    expect(app.currentReleaseId).toBe(second.id);
    expect(app.previousReleaseId).toBe(first.id);
    expect((await releaseRow(first.id)).state).toBe('replaced');

    const fake = hosting();
    const live = fake.app(`mh-${id}`)!.live!;
    expect(live.image).toBe(`registry.fly.io/mh-${id}:${SHA_B}`);
    expect(live.size).toBeUndefined();
  });

  it('runs the migration before the deploy, with the direct string, and never as a deploy', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    await service.deployProductionRelease(release(id), deps());

    const calls = hosting().calls;
    expect(calls.map((c) => c.operation)).toEqual(['ensureApp', 'runReleaseCommand', 'deploy']);
    expect(calls[1]).toMatchObject({ command: 'node migrate.js deploy', appRef: `mh-${id}` });
    expect(calls[1]!.envNames).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'DIRECT_URL', 'DATABASE_URL_UNPOOLED']),
    );
    expect(calls[2]!.envNames).not.toContain('DIRECT_URL');
    expect(PRODUCTION_MIGRATION_TIMEOUT_SECONDS).toBe(900);
  });

  it('passes the resolved environment with DATABASE_URL from the production database, creating it once', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    await entry(fx, id, 'FEATURE_X', 'on');
    await entry(fx, id, 'API_SECRET', 'shh', true);

    const first = await service.deployProductionRelease(release(id, SHA_A), deps());
    await service.deployProductionRelease(release(id, SHA_B), deps());

    expect(databases()).toHaveLength(1);
    const env = hosting().app(`mh-${id}`)!.live!.env;
    expect(env['FEATURE_X']).toBe('on');
    expect(env['API_SECRET']).toBe('shh');
    expect(env['DATABASE_URL']).toMatch(/-pooler\.fake\.invalid/);
    expect(env['DIRECT_URL']).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(CONNECTION_STRING);
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
  });

  it('creates no database and runs no migration for a manifest without one', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    const done = await service.deployProductionRelease(release(id), deps(NO_DATABASE));

    expect(done.state).toBe('live');
    expect(databases()).toHaveLength(0);
    expect(hosting().calls.map((c) => c.operation)).toEqual(['ensureApp', 'deploy']);
    expect(hosting().app(`mh-${id}`)!.live!.env['DATABASE_URL']).toBeUndefined();
  });

  it('fails the release on a failed migration, never deploys, and leaves the previous release serving', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await service.deployProductionRelease(release(id, SHA_A), deps());
    hosting().setReleaseCommandResult({ exitCode: 1, timedOut: false });

    const failed = await service.deployProductionRelease(release(id, SHA_B), deps());

    expect(failed).toMatchObject({ state: 'failed', failureReason: 'migrate: exit 1' });
    expect(hosting().calls.filter((c) => c.operation === 'deploy')).toHaveLength(1);
    expect((await application(id)).currentReleaseId).toBe(first.id);
    expect((await releaseRow(first.id)).state).toBe('live');
    expect(hosting().app(`mh-${id}`)!.live!.image).toContain(SHA_A);
  });

  it('fails the release on a migration that times out', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    hosting().setReleaseCommandResult({ exitCode: null, timedOut: true });

    const failed = await service.deployProductionRelease(release(id), deps());

    expect(failed).toMatchObject({ state: 'failed', failureReason: 'migrate: timed out' });
    expect((await application(id)).currentReleaseId).toBeNull();
  });

  it('fails the release on a deploy failure without leaking what the provider said', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await service.deployProductionRelease(release(id, SHA_A), deps());
    hosting().failNext('deploy', 'cannot reach postgresql://app:hunter2@db/app');

    const failed = await service.deployProductionRelease(release(id, SHA_B), deps());

    expect(failed).toMatchObject({
      state: 'failed',
      failureReason: 'deploy: ORCHESTRATOR_API_FAILED (HTTP 503)',
    });
    expect(JSON.stringify(failed)).not.toContain('hunter2');
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
    expect((await application(id)).currentReleaseId).toBe(first.id);
    expect((await releaseRow(first.id)).state).toBe('live');
  });

  it('names the step for a failed manifest read, a refused migration and an unsupported database', async () => {
    const fx = await workspace();
    const fly = await repo(fx);
    const missing = await service.deployProductionRelease(release(fly), {
      readManifest: async () => {
        throw new HostingManifestMissingError('motir.hosting.json');
      },
    });
    expect(missing.failureReason).toBe('manifest: HOSTING_MANIFEST_MISSING');

    const serverless = await repo(fx, { role: 'api', target: 'serverless' });
    const unsupported = await service.deployProductionRelease(release(serverless), deps());
    expect(unsupported.failureReason).toBe('migrate: HOSTING_RELEASE_COMMAND_UNSUPPORTED');
    expect(hosting('serverless').calls.filter((c) => c.operation === 'deploy')).toHaveLength(0);

    const fx2 = await workspace('BETA');
    const aws = await repo(fx2, { target: 'aws' });
    const kind = await service.deployProductionRelease(release(aws), deps());
    expect(kind.failureReason).toBe('database: PRODUCTION_DATABASE_KIND_UNSUPPORTED');
  });

  it('keeps an unnamed failure to its class name, and an unknown one to UNKNOWN', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const named = await service.deployProductionRelease(release(id, SHA_A), {
      readManifest: async () => {
        throw new TypeError('postgresql://leak');
      },
    });
    expect(named.failureReason).toBe('manifest: TypeError');
    const unknown = await service.deployProductionRelease(release(id, SHA_B), {
      readManifest: async () => {
        throw 'postgresql://leak';
      },
    });
    expect(unknown.failureReason).toBe('manifest: UNKNOWN');
  });

  it('releases a tag through the same function, with the same behaviour', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    const tagged = await service.deployProductionRelease(
      release(id, SHA_A, { cause: 'ref', ref: 'v1.2.0' }),
      deps(),
    );

    expect(tagged).toMatchObject({ state: 'live', cause: 'ref', ref: 'v1.2.0', commitSha: SHA_A });
    expect(hosting().calls.map((c) => c.operation)).toEqual([
      'ensureApp',
      'runReleaseCommand',
      'deploy',
    ]);
  });

  it('refuses a customer repository and writes no release', async () => {
    const fx = await workspace();
    const id = await repo(fx, { seedSource: 'organization' });

    await expect(service.deployProductionRelease(release(id), deps())).rejects.toBeInstanceOf(
      CustomerRepositoryNotDeployableError,
    );
    expect(await adminDb.hostedRelease.count()).toBe(0);
  });

  it('refuses a second release while one is in flight, writing nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const app = await hostedApplicationService.ensureApplication(id);
    await hostedApplicationService.createRelease({
      applicationId: app.id,
      commitSha: SHA_A,
      cause: 'merge',
    });

    await expect(
      service.deployProductionRelease(release(id, SHA_B), deps()),
    ).rejects.toBeInstanceOf(ReleaseInProgressError);
    expect(await adminDb.hostedRelease.count()).toBe(1);
  });

  it('leaves at most one release in flight under real concurrency', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    const outcomes = await Promise.allSettled([
      service.deployProductionRelease(release(id, SHA_A), deps()),
      service.deployProductionRelease(release(id, SHA_B), deps()),
    ]);

    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ReleaseInProgressError);
    }
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    expect(
      await adminDb.hostedRelease.count({ where: { state: { in: ['building', 'releasing'] } } }),
    ).toBe(0);
    const app = await application(id);
    expect(app.currentReleaseId).not.toBeNull();
  });

  it('does not block one application on another in the same project', async () => {
    const fx = await workspace();
    const web = await repo(fx);
    const api = await repo(fx, { role: 'api' });
    const webApp = await hostedApplicationService.ensureApplication(web);
    await hostedApplicationService.createRelease({
      applicationId: webApp.id,
      commitSha: SHA_A,
      cause: 'merge',
    });

    const done = await service.deployProductionRelease(release(api), deps());

    expect(done.state).toBe('live');
    expect((await application(web)).currentReleaseId).toBeNull();
  });

  it('reads the manifest through the repository access by default', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const read = vi
      .spyOn(hostedRepositoryAccessService, 'readManifestAt')
      .mockResolvedValue(NO_DATABASE);

    const done = await service.deployProductionRelease(release(id, SHA_B));

    expect(done.state).toBe('live');
    expect(read).toHaveBeenCalledWith(id, SHA_B);
  });
});

describe('recordFailedRelease', () => {
  it('records a failed build straight into failed, leaving the pointers alone', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await service.deployProductionRelease(release(id, SHA_A), deps());

    const failed = await service.recordFailedRelease(id, SHA_B, 'build: exit 2');
    const tagged = await service.recordFailedRelease(id, SHA_B, 'build: exit 3', {
      cause: 'ref',
      ref: 'v2',
    });

    expect(failed).toMatchObject({
      state: 'failed',
      commitSha: SHA_B,
      cause: 'merge',
      failureReason: 'build: exit 2',
    });
    expect(failed.endedAt).not.toBeNull();
    expect(tagged).toMatchObject({ cause: 'ref', ref: 'v2' });
    const app = await application(id);
    expect(app.currentReleaseId).toBe(live.id);
    expect(app.previousReleaseId).toBeNull();
  });
});
