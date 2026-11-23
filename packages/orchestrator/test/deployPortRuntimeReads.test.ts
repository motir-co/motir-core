import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  LogsUnavailableError,
  OrchestratorApiError,
  ReleaseNotFoundError,
  RUNTIME_READ_NOT_BUILT,
  RuntimeHealthUnavailableError,
  createFakeHostingDeployPort,
  fakeHostingPortKey,
  type DeployReleaseInput,
  type HostingDeployPort,
  type HostingEnvironment,
  type ReleaseHandle,
  type ReleaseLogLine,
} from '../src/index';
import { IMAGE, START, awsHarness, type HostingHarness } from './contract/hostingHarnesses';

// THE PORT'S RUNTIME READS (Story MOTIR-9799 · MOTIR-12099) — `readLogs` and
// `readHealth`, held on the fake exactly as a real adapter must answer them,
// beside `deployPortContract.test.ts`. A real adapter refuses both by
// name until each target's own card builds the read.

const PRODUCTION: HostingEnvironment = { kind: 'production' };
const REPO = 'cmrepo-runtime';

function input(appRef: string, label: string): DeployReleaseInput {
  return {
    appRef,
    environment: PRODUCTION,
    artifact: { kind: 'image', ...IMAGE, ref: `${IMAGE.ref}:${label}` },
    runtime: {
      port: 3000,
      healthCheck: { path: '/api/health' },
      startCommand: 'node server.js',
      database: { kind: 'none' },
    },
    env: [{ name: 'DATABASE_URL', value: 'postgres://user:hunter2@db/app', secret: true }],
    idle: { mode: 'suspend', idleSeconds: 300 },
  };
}

function at(seconds: number): Date {
  return new Date(START + seconds * 1000);
}

function line(
  seconds: number,
  message: string,
  stream: 'app' | 'platform' = 'app',
): ReleaseLogLine {
  return { at: at(seconds), stream, message };
}

async function deployed(options: Parameters<typeof createFakeHostingDeployPort>[0] = {}): Promise<{
  fake: ReturnType<typeof createFakeHostingDeployPort>;
  handle: ReleaseHandle;
}> {
  const fake = createFakeHostingDeployPort({ start: new Date(START), ...options });
  const { appRef } = await fake.ensureApp({ repositoryId: REPO, environment: PRODUCTION });
  const handle = await fake.deploy(input(appRef, 'one'));
  return { fake, handle };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readLogs on the fake', () => {
  it('pages newest first, a cursor at a time, and the last page has none', async () => {
    const { fake, handle } = await deployed();
    fake.appendLogLines(handle.appRef, [
      line(1, 'boot'),
      line(2, 'listening on 3000'),
      line(3, 'GET /'),
      line(3, 'GET /about'),
      line(4, 'machine started', 'platform'),
    ]);

    const first = await fake.readLogs(handle, { limit: 2 });
    expect(first.lines.map((l) => l.message)).toEqual(['machine started', 'GET /about']);
    expect(first.lines[0]).toEqual({ at: at(4), stream: 'platform', message: 'machine started' });
    expect(first.cursor).not.toBeNull();

    // A line appended between two pages does not shift the next one.
    fake.appendLogLines(handle.appRef, [line(9, 'later')]);
    const second = await fake.readLogs(handle, { limit: 2, cursor: first.cursor! });
    expect(second.lines.map((l) => l.message)).toEqual(['GET /', 'listening on 3000']);

    const last = await fake.readLogs(handle, { limit: 2, cursor: second.cursor! });
    expect(last.lines.map((l) => l.message)).toEqual(['boot']);
    expect(last.cursor).toBeNull();
  });

  it('keeps only the window and the case-insensitive filter, and answers an empty log', async () => {
    const { fake, handle } = await deployed();
    expect(await fake.readLogs(handle, { limit: 10 })).toEqual({ lines: [], cursor: null });

    fake.appendLogLines(handle.appRef, [
      line(10, 'ERROR: db timeout'),
      line(20, 'request ok'),
      line(30, 'Error: retry'),
      line(40, 'error again'),
    ]);
    const page = await fake.readLogs(handle, {
      limit: 10,
      since: at(20),
      until: at(30),
      filter: 'eRRor',
    });
    expect(page.lines.map((l) => l.message)).toEqual(['Error: retry']);
    expect(page.cursor).toBeNull();

    const exact = await fake.readLogs(handle, { limit: 3, filter: 'error' });
    expect(exact.lines).toHaveLength(3);
    expect(exact.cursor).toBeNull();
  });

  it('returns every message exactly as appended: a secret value is NOT masked here', async () => {
    const { fake, handle } = await deployed();
    fake.appendLogLines(handle.appRef, [line(1, 'connecting to postgres://user:hunter2@db/app')]);
    const page = await fake.readLogs(handle, { limit: 1 });
    expect(page.lines[0]!.message).toBe('connecting to postgres://user:hunter2@db/app');
  });

  it('throws LogsUnavailableError, not a provider failure, while the logs are unavailable', async () => {
    const { fake, handle } = await deployed();
    fake.setLogsUnavailable(handle.appRef, 'log stream closed');
    const refused = await fake.readLogs(handle, { limit: 5 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LogsUnavailableError);
    expect(refused).not.toBeInstanceOf(OrchestratorApiError);
    expect(refused).toMatchObject({
      code: 'HOSTING_LOGS_UNAVAILABLE',
      target: 'fly',
      reason: 'log stream closed',
      name: 'LogsUnavailableError',
    });

    fake.setLogsUnavailable(handle.appRef, null);
    await expect(fake.readLogs(handle, { limit: 5 })).resolves.toEqual({
      lines: [],
      cursor: null,
    });
  });

  it('refuses a limit below one and a cursor it did not hand out', async () => {
    const { fake, handle } = await deployed();
    await expect(fake.readLogs(handle, { limit: 0 })).rejects.toBeInstanceOf(OrchestratorApiError);
    await expect(fake.readLogs(handle, { limit: 1.5 })).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    await expect(fake.readLogs(handle, { limit: 1, cursor: 'not-a-cursor' })).rejects.toThrow(
      /is not a log cursor/,
    );
    const wrongShape = Buffer.from(JSON.stringify({ at: 'x' })).toString('base64url');
    await expect(fake.readLogs(handle, { limit: 1, cursor: wrongShape })).rejects.toThrow(
      /is not a log cursor/,
    );
  });
});

describe('readHealth on the fake', () => {
  it('answers running from the deploy, suspended after an idle stop, running again on wake', async () => {
    const { fake, handle } = await deployed();
    expect(await fake.readHealth(handle)).toEqual({ state: 'running', since: at(0) });

    fake.advanceSeconds(60);
    fake.idleStop(handle.appRef);
    expect(await fake.readHealth(handle)).toEqual({ state: 'suspended', since: at(60) });

    fake.advanceSeconds(30);
    fake.wake(handle.appRef);
    expect(await fake.readHealth(handle)).toEqual({ state: 'running', since: at(90) });
  });

  it('answers deploying for a held AWS release and for a health set to deploying', async () => {
    const fake = createFakeHostingDeployPort({ target: 'aws', start: new Date(START) });
    const { appRef } = await fake.ensureApp({ repositoryId: REPO, environment: PRODUCTION });
    fake.setAccountReady(false);
    fake.advanceSeconds(5);
    const held = await fake.deploy({ ...input(appRef, 'one'), shape: 'function' });
    fake.advanceSeconds(5);
    expect(await fake.readHealth(held)).toEqual({ state: 'deploying', since: at(5) });

    fake.setAccountReady(true);
    const live = await fake.deploy({ ...input(appRef, 'one'), shape: 'function' });
    expect(await fake.readHealth(live)).toEqual({ state: 'running', since: at(10) });

    fake.advanceSeconds(5);
    fake.setHealth(appRef, 'deploying');
    expect(await fake.readHealth(live)).toEqual({ state: 'deploying', since: at(15) });
    fake.setHealth(appRef, 'healthy');
    expect((await fake.readHealth(live)).state).toBe('running');
  });

  it('answers exited with its code or oom_killed from setRuntimeState, until wake, deploy or rollback', async () => {
    const { fake, handle } = await deployed();
    fake.advanceSeconds(10);
    fake.setRuntimeState(handle.appRef, { state: 'exited', exitCode: 137 });
    expect(await fake.readHealth(handle)).toEqual({
      state: 'exited',
      exitCode: 137,
      since: at(10),
    });

    fake.wake(handle.appRef);
    expect((await fake.readHealth(handle)).state).toBe('running');

    fake.advanceSeconds(5);
    fake.setRuntimeState(handle.appRef, { state: 'oom_killed' });
    expect(await fake.readHealth(handle)).toEqual({ state: 'oom_killed', since: at(15) });
    const next = await fake.deploy(input(handle.appRef, 'two'));
    expect((await fake.readHealth(next)).state).toBe('running');

    fake.setRuntimeState(handle.appRef, { state: 'exited', exitCode: null });
    expect(await fake.readHealth(next)).toMatchObject({ state: 'exited', exitCode: null });
    const restored = await fake.rollback({ appRef: handle.appRef, environment: PRODUCTION });
    expect((await fake.readHealth(restored)).state).toBe('running');

    fake.setRuntimeState(handle.appRef, { state: 'oom_killed' });
    fake.setRuntimeState(handle.appRef, null);
    expect((await fake.readHealth(restored)).state).toBe('running');
  });

  it('carries the exit a running release was restarted from, until it is cleared, deployed or rolled back', async () => {
    const { fake, handle } = await deployed();
    const exit = { exitCode: 1, oomKilled: false, at: at(42) };
    fake.recordRestartedExit(handle.appRef, exit);
    expect(await fake.readHealth(handle)).toEqual({
      state: 'running',
      since: at(0),
      lastExit: exit,
    });

    // An idle wake starts a new process of the SAME release: the exit stays.
    fake.idleStop(handle.appRef);
    fake.wake(handle.appRef);
    expect(await fake.readHealth(handle)).toMatchObject({ lastExit: exit });

    fake.recordRestartedExit(handle.appRef, null);
    expect(await fake.readHealth(handle)).not.toHaveProperty('lastExit');

    fake.recordRestartedExit(handle.appRef, { exitCode: null, oomKilled: true, at: at(50) });
    const next = await fake.deploy(input(handle.appRef, 'two'));
    expect(await fake.readHealth(next)).not.toHaveProperty('lastExit');

    fake.recordRestartedExit(handle.appRef, exit);
    const restored = await fake.rollback({ appRef: handle.appRef, environment: PRODUCTION });
    expect(await fake.readHealth(restored)).not.toHaveProperty('lastExit');
  });
});

describe('the runtime reads on an app with no release', () => {
  it('throw ReleaseNotFoundError for an app never deployed, a destroyed release and an unknown app', async () => {
    const fake = createFakeHostingDeployPort({ start: new Date(START) });
    const { appRef } = await fake.ensureApp({ repositoryId: REPO, environment: PRODUCTION });
    const handle: ReleaseHandle = {
      target: 'fly',
      appRef,
      environment: PRODUCTION,
      releaseId: 'rel-none',
      providerRef: `fake-${appRef}`,
    };
    await expect(fake.readLogs(handle, { limit: 1 })).rejects.toBeInstanceOf(ReleaseNotFoundError);
    await expect(fake.readHealth(handle)).rejects.toBeInstanceOf(ReleaseNotFoundError);

    const live = await fake.deploy(input(appRef, 'one'));
    await fake.destroy(live, 'retired');
    await expect(fake.readHealth(live)).rejects.toBeInstanceOf(ReleaseNotFoundError);

    await fake.destroyApp({ appRef });
    await expect(fake.readLogs(live, { limit: 1 })).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it('the controls refuse an app that does not exist', () => {
    const fake = createFakeHostingDeployPort();
    expect(() => fake.appendLogLines('mh-missing', [line(0, 'x')])).toThrow(OrchestratorApiError);
    expect(() => fake.setLogsUnavailable('mh-missing', 'r')).toThrow(OrchestratorApiError);
    expect(() => fake.setRuntimeState('mh-missing', { state: 'oom_killed' })).toThrow(
      OrchestratorApiError,
    );
    expect(() => fake.recordRestartedExit('mh-missing', null)).toThrow(OrchestratorApiError);
  });
});

describe('the runtime reads in the call log and across processes', () => {
  it('logs both operations by app', async () => {
    const { fake, handle } = await deployed();
    await fake.readLogs(handle, { limit: 1 });
    await fake.readHealth(handle);
    expect(fake.calls.slice(-2)).toEqual([
      { operation: 'readLogs', appRef: handle.appRef },
      { operation: 'readHealth', appRef: handle.appRef },
    ]);
  });

  it('a second fake over the same state file reads the lines, the unavailability and the states, and reset clears them', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fake-hosting-runtime-')), 'hosting.json');
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, path);
    const { fake: worker, handle } = await deployed({ shareAcrossProcesses: true });
    const server = createFakeHostingDeployPort({
      start: new Date(START),
      shareAcrossProcesses: true,
    });

    worker.appendLogLines(handle.appRef, [line(1, 'from the worker')]);
    expect((await server.readLogs(handle, { limit: 1 })).lines[0]!.message).toBe('from the worker');

    worker.recordRestartedExit(handle.appRef, { exitCode: 2, oomKilled: false, at: at(3) });
    expect(await server.readHealth(handle)).toMatchObject({ lastExit: { exitCode: 2, at: at(3) } });

    worker.setRuntimeState(handle.appRef, { state: 'exited', exitCode: 3 });
    expect(await server.readHealth(handle)).toMatchObject({ state: 'exited', exitCode: 3 });

    worker.setLogsUnavailable(handle.appRef, 'gone');
    await expect(server.readLogs(handle, { limit: 1 })).rejects.toBeInstanceOf(
      LogsUnavailableError,
    );

    server.reset();
    await expect(worker.readHealth(handle)).rejects.toBeInstanceOf(ReleaseNotFoundError);
    const { appRef } = await worker.ensureApp({ repositoryId: REPO, environment: PRODUCTION });
    const again = await worker.deploy(input(appRef, 'again'));
    expect(await server.readLogs(again, { limit: 1 })).toEqual({ lines: [], cursor: null });
    expect(await server.readHealth(again)).toEqual({ state: 'running', since: at(0) });
  });

  it('reads a store written before the runtime reads as holding none of them', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fake-hosting-legacy-')), 'hosting.json');
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, path);
    const { handle } = await deployed({ shareAcrossProcesses: true });
    const key = fakeHostingPortKey('fly');
    const store = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const field of [
      'logs',
      'logsUnavailable',
      'runtimeStates',
      'restartedExits',
      'deployingSince',
      'logSequence',
    ]) {
      delete store[key]![field];
    }
    writeFileSync(path, JSON.stringify(store), 'utf8');

    const reader = createFakeHostingDeployPort({
      start: new Date(START),
      shareAcrossProcesses: true,
    });
    expect(await reader.readLogs(handle, { limit: 1 })).toEqual({ lines: [], cursor: null });
    expect((await reader.readHealth(handle)).state).toBe('running');
    reader.appendLogLines(handle.appRef, [line(1, 'first line after the upgrade')]);
    expect((await reader.readLogs(handle, { limit: 1 })).lines).toHaveLength(1);
  });
});

describe('the real adapters refuse both reads by name until their own cards build them', () => {
  // Fly reads both since MOTIR-12102 (`flyHosting.test.ts`), serverless since
  // MOTIR-12103 (`serverlessRuntimeReads.test.ts`).
  const REAL: ReadonlyArray<readonly [string, () => HostingHarness]> = [
    ['aws', () => awsHarness('function')],
  ];

  it.each(REAL)('%s', async (name, harness) => {
    const port: HostingDeployPort = harness().port;
    const handle: ReleaseHandle = {
      target: port.target,
      appRef: 'mh-anything',
      environment: PRODUCTION,
      releaseId: 'rel-1',
      providerRef: 'anything',
    };
    const logs = await port.readLogs(handle, { limit: 10 }).catch((e: unknown) => e);
    expect(logs).toBeInstanceOf(LogsUnavailableError);
    expect(logs).toMatchObject({
      code: 'HOSTING_LOGS_UNAVAILABLE',
      target: name,
      reason: RUNTIME_READ_NOT_BUILT,
    });
    const health = await port.readHealth(handle).catch((e: unknown) => e);
    expect(health).toBeInstanceOf(RuntimeHealthUnavailableError);
    expect(health).toMatchObject({
      code: 'HOSTING_RUNTIME_HEALTH_UNAVAILABLE',
      target: name,
      reason: RUNTIME_READ_NOT_BUILT,
      name: 'RuntimeHealthUnavailableError',
    });
    expect(RUNTIME_READ_NOT_BUILT).toBe('not implemented for this target yet');
  });
});
