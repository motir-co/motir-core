// MOTIR-12105 — a Motir repository's production logs, read through the deploy
// port and masked: against real Postgres and the port's fake. The query reaches
// the port and its order and paging come back; every production secret (saved
// before or after the release, nested, multi-line) and the production
// database's connection string are masked; a filter that matched only inside a
// secret drops the line; no release and an unreadable target are states, not
// errors; and nothing is written to a log or carried by an error.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls, ReleaseLogLine } from '@motir/orchestrator';
import { OrchestratorApiError } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  CustomerRepositoryNotDeployableError,
  InvalidLogCursorError,
  InvalidLogLimitError,
} from '@/lib/hosting/errors';
import { LOG_SECRET_MASK } from '@/lib/hosting/logMasking';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { productionLogsService as logs } from '@/lib/services/productionLogsService';
import {
  productionReleaseService,
  type ProductionReleaseDeps,
} from '@/lib/services/productionReleaseService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const M = LOG_SECRET_MASK;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const CONNECTION_STRING = /postgres(ql)?:\/\//;
const KEY = 'c'.repeat(64);

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
const WITH_DATABASE: HostingManifest = {
  ...MANIFEST,
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

let logged: string[];

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
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
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
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

async function repo(fx: WorkItemFixture, seedSource = 'initialised'): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'repo-web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource, state: 'created', hostingTarget: 'fly' },
  });
  return row.id;
}

async function goLive(repositoryId: string, manifest = MANIFEST, commitSha = SHA_A) {
  const deps: ProductionReleaseDeps = { readManifest: async () => manifest };
  const live = await productionReleaseService.deployProductionRelease(
    {
      projectRepositoryId: repositoryId,
      commitSha,
      artifactRef: `registry.fly.io/x:${commitSha}`,
      cause: 'merge',
    },
    deps,
  );
  expect(live.state).toBe('live');
  return live;
}

async function appRef(repositoryId: string): Promise<string> {
  const { appRef } = await hosting().ensureApp({
    repositoryId,
    environment: { kind: 'production' },
  });
  return appRef;
}

async function saveSecret(fx: WorkItemFixture, id: string, name: string, value: string) {
  await environmentConfigService.set(id, 'production', { name, value, isSecret: true }, fx.ctx);
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 12, minute));
const line = (minute: number, message: string, stream: 'app' | 'platform' = 'app') =>
  ({ at: at(minute), stream, message }) satisfies ReleaseLogLine;

async function setup() {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const id = await repo(fx);
  const scope = { workspaceId: fx.workspaceId, projectRepositoryId: id };
  return { fx, id, scope };
}

describe('readMaskedLines — the port read', () => {
  it('reads the current release newest first, honouring the window, filter, limit and cursor', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    const ref = await appRef(id);
    hosting().appendLogLines(ref, [
      line(1, 'boot'),
      line(2, 'GET / 200'),
      line(3, 'ERROR one'),
      line(4, 'GET /a 200', 'platform'),
      line(5, 'error two'),
      line(6, 'GET /b 500'),
    ]);
    const readLogs = vi.spyOn(hosting(), 'readLogs');

    const first = await logs.readMaskedLines(scope, { limit: 2 });
    expect(first.state).toBe('ok');
    expect(first.lines.map((l) => l.message)).toEqual(['GET /b 500', 'error two']);
    expect(first.cursor).not.toBeNull();
    const second = await logs.readMaskedLines(scope, { limit: 2, cursor: first.cursor! });
    expect(second.lines.map((l) => l.message)).toEqual(['GET /a 200', 'ERROR one']);
    expect(second.lines[0]!.stream).toBe('platform');
    expect(second.lines[0]!.at).toEqual(at(4));

    const window = await logs.readMaskedLines(scope, {
      since: at(2),
      until: at(5),
      filter: 'error',
      limit: 10,
    });
    expect(window.lines.map((l) => l.message)).toEqual(['error two', 'ERROR one']);
    expect(window.cursor).toBeNull();
    expect(readLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ appRef: ref, environment: { kind: 'production' } }),
      { since: at(2), until: at(5), filter: 'error', limit: 10 },
    );
  });

  it('clamps the limit and refuses a malformed one', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    await logs.readMaskedLines(scope, { limit: 50_000 });
    expect(readLogs.mock.calls[0]![1]).toEqual({ limit: 1000 });
    await expect(logs.readMaskedLines(scope, { limit: 0 })).rejects.toThrow(InvalidLogLimitError);
  });

  it('reads only the current release after a replacing deploy', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    const second = await goLive(id, MANIFEST, SHA_B);
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    await logs.readMaskedLines(scope, { limit: 5 });
    const row = await adminDb.hostedRelease.findUniqueOrThrow({ where: { id: second.id } });
    expect(readLogs.mock.calls[0]![0].releaseId).toBe(row.providerReleaseId);
  });
});

describe('readMaskedLines — masking', () => {
  it('masks nested and multi-line secrets, and one saved after the release went live', async () => {
    const { fx, id, scope } = await setup();
    await saveSecret(fx, id, 'API_TOKEN', 'tok_live_123456');
    await saveSecret(fx, id, 'TOKEN_PREFIX', 'tok_live');
    await saveSecret(fx, id, 'PRIVATE_KEY', '-----BEGIN-----\nAAAAsecretkeyline\n-----END-----');
    await environmentConfigService.set(
      id,
      'production',
      { name: 'PUBLIC_NAME', value: 'acme-shop', isSecret: false },
      fx.ctx,
    );
    await goLive(id);
    await saveSecret(fx, id, 'LATE_SECRET', 'savedafterlive');
    hosting().appendLogLines(await appRef(id), [
      line(1, 'auth with tok_live_123456 ok'),
      line(2, 'prefix tok_live only'),
      line(3, 'key AAAAsecretkeyline loaded'),
      line(4, 'late savedafterlive here'),
      line(5, 'serving acme-shop'),
    ]);

    const page = await logs.readMaskedLines(scope, { limit: 10 });
    expect(page.lines.map((l) => l.message)).toEqual([
      'serving acme-shop',
      `late ${M} here`,
      `key ${M} loaded`,
      `prefix ${M} only`,
      `auth with ${M} ok`,
    ]);
  });

  it("masks the production database's connection string and its password", async () => {
    const { id, scope } = await setup();
    await goLive(id, WITH_DATABASE);
    const app = await adminDb.hostedApplication.findFirstOrThrow({
      where: { projectRepositoryId: id },
    });
    const [database] = await productionReleaseService.productionSecretEnvironment({
      id: app.id,
      workspaceId: scope.workspaceId,
      projectRepositoryId: id,
    });
    expect(database!.name).toBe('DATABASE_URL');
    expect(database!.value).toMatch(CONNECTION_STRING);
    const password = new URL(database!.value).password;
    expect(password.length).toBeGreaterThan(0);
    hosting().appendLogLines(await appRef(id), [
      line(1, `connecting to ${database!.value}`),
      line(2, `auth failed for password ${decodeURIComponent(password)}`),
    ]);

    const page = await logs.readMaskedLines(scope, { limit: 10 });
    expect(page.lines.map((l) => l.message)).toEqual([
      `auth failed for password ${M}`,
      `connecting to ${M}`,
    ]);
    expect(JSON.stringify(page)).not.toMatch(CONNECTION_STRING);
  });

  it('drops a line the filter matched only inside a secret, and keeps a visible match', async () => {
    const { fx, id, scope } = await setup();
    await saveSecret(fx, id, 'STRIPE_KEY', 'sk_live_zebra42');
    await goLive(id);
    hosting().appendLogLines(await appRef(id), [
      line(1, 'charging with sk_live_zebra42'),
      line(2, 'zebra crossing ahead, key sk_live_zebra42'),
    ]);

    const probed = await logs.readMaskedLines(scope, { filter: 'zebra42', limit: 10 });
    expect(probed).toEqual({ state: 'ok', lines: [], cursor: null });

    const visible = await logs.readMaskedLines(scope, { filter: 'ZEBRA', limit: 10 });
    expect(visible.lines.map((l) => l.message)).toEqual([`zebra crossing ahead, key ${M}`]);
  });

  it('fails closed when the stored database value will not decrypt', async () => {
    const { id, scope } = await setup();
    await goLive(id, WITH_DATABASE);
    await adminDb.hostedApplication.updateMany({
      where: { projectRepositoryId: id },
      data: { databaseUrlCiphertext: 'not-a-ciphertext' },
    });
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    await expect(logs.readMaskedLines(scope, { limit: 10 })).rejects.toMatchObject({
      name: 'ProductionDatabaseUnreadableError',
      reason: 'undecryptable',
    });
    expect(readLogs).not.toHaveBeenCalled();
  });
});

describe('readMaskedLines — the non-happy states', () => {
  it('is no_release with no application', async () => {
    const { scope } = await setup();
    expect(await logs.readMaskedLines(scope, { limit: 10 })).toEqual({
      state: 'no_release',
      lines: [],
      cursor: null,
    });
  });

  it('is no_release when the current release is not live, or has no handle', async () => {
    const { id, scope } = await setup();
    const live = await goLive(id);
    await adminDb.hostedRelease.update({
      where: { id: live.id },
      data: { providerRef: null },
    });
    expect((await logs.readMaskedLines(scope, { limit: 10 })).state).toBe('no_release');
    await adminDb.hostedRelease.update({ where: { id: live.id }, data: { state: 'failed' } });
    expect((await logs.readMaskedLines(scope, { limit: 10 })).state).toBe('no_release');
  });

  it('is no_release when the application has no current release', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    await adminDb.hostedApplication.updateMany({
      where: { projectRepositoryId: id },
      data: { currentReleaseId: null },
    });
    expect((await logs.readMaskedLines(scope, { limit: 10 })).state).toBe('no_release');
  });

  it('is no_release when the target holds no live release', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    await hosting().destroyApp({ appRef: await appRef(id) });
    expect((await logs.readMaskedLines(scope, { limit: 10 })).state).toBe('no_release');
  });

  it('is unavailable, with nothing logged, when the target cannot answer', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    hosting().setLogsUnavailable(await appRef(id), 'postgres://u:hunter2@db rate limited');
    expect(await logs.readMaskedLines(scope, { limit: 10 })).toEqual({
      state: 'unavailable',
      lines: [],
      cursor: null,
    });
    expect(logged.join('\n')).not.toMatch(/hunter2|postgres/);
  });

  it('is unavailable when the target refuses the app read', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    vi.spyOn(hosting(), 'ensureApp').mockRejectedValueOnce(
      new OrchestratorApiError('fly', 503, 'upstream secret words'),
    );
    expect((await logs.readMaskedLines(scope, { limit: 10 })).state).toBe('unavailable');
  });

  it('turns a refused cursor into InvalidLogCursorError, without the provider words', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    const err = await logs
      .readMaskedLines(scope, { limit: 10, cursor: 'garbage' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidLogCursorError);
    expect((err as Error).message).not.toMatch(/garbage/);
  });

  it('rethrows what it does not know', async () => {
    const { id, scope } = await setup();
    await goLive(id);
    vi.spyOn(hosting(), 'readLogs').mockRejectedValueOnce(new TypeError('bug'));
    await expect(logs.readMaskedLines(scope, { limit: 10 })).rejects.toThrow(TypeError);
  });
});

describe('readProductionLogs — the actor read', () => {
  it('answers a member the masked page with ISO instants', async () => {
    const { fx, id } = await setup();
    await saveSecret(fx, id, 'SECRET', 'swordfish');
    await goLive(id);
    hosting().appendLogLines(await appRef(id), [line(1, 'pw swordfish')]);
    expect(
      await logs.readProductionLogs({
        projectKey: 'ACME',
        projectRepositoryId: id,
        actor: fx.ctx,
        query: { limit: 10 },
      }),
    ).toEqual({
      state: 'ok',
      cursor: null,
      lines: [{ at: at(1).toISOString(), stream: 'app', message: `pw ${M}` }],
    });
  });

  it('refuses an unknown, a customer and an unbrowsable repository before the port', async () => {
    const { fx, id } = await setup();
    await goLive(id);
    const customer = await (async () => {
      const row = await projectRepoSetService.addRow(
        fx.projectId,
        { role: 'api', name: 'customer-api' },
        fx.ctx,
      );
      await adminDb.projectRepo.update({
        where: { id: row.id },
        data: { seedSource: 'organization', state: 'created' },
      });
      return row.id;
    })();
    const readLogs = vi.spyOn(hosting(), 'readLogs');
    const ensureApp = vi.spyOn(hosting(), 'ensureApp');
    const read = (projectRepositoryId: string) =>
      logs.readProductionLogs({
        projectKey: 'ACME',
        projectRepositoryId,
        actor: fx.ctx,
        query: { limit: 10 },
      });

    await expect(read('nope')).rejects.toThrow(ProjectRepoNotFoundError);
    await expect(read(customer)).rejects.toThrow(CustomerRepositoryNotDeployableError);

    vi.spyOn(projectAccessService, 'getPermissions').mockResolvedValueOnce(new Set());
    await expect(read(id)).rejects.toThrow(ProjectNotFoundError);
    expect(readLogs).not.toHaveBeenCalled();
    expect(ensureApp).not.toHaveBeenCalled();
  });
});
