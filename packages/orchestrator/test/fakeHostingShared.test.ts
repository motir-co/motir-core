import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_HOSTING_HOLD_LIMIT_MS,
  FAKE_HOSTING_STATE_PATH_ENV,
  OrchestratorApiError,
  createFakeHostingDeployPort,
  type DeployReleaseInput,
  type HostingEnvironment,
} from '../src/index';

// The fake hosting port's CROSS-PROCESS store (Story MOTIR-9797 · MOTIR-10040):
// two fakes over one state file stand for the E2E lane's job worker and web
// server — what one deploys, the other rolls back — and the hold sidecar keeps
// a deploy open until a third party lets it go.

const PRODUCTION: HostingEnvironment = { kind: 'production' };

function input(appRef: string, label: string): DeployReleaseInput {
  return {
    appRef,
    environment: PRODUCTION,
    artifact: { kind: 'image', ref: `img:${label}` },
    runtime: {
      port: 3000,
      healthCheck: { path: '/api/health' },
      startCommand: 'node server.js',
      database: { kind: 'none' },
    },
    env: [{ name: 'LABEL', value: label, secret: false }],
    idle: { mode: 'always_on' },
  };
}

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'fake-hosting-')), 'hosting.json');
  vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, path);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('the fake hosting port’s shared store', () => {
  it('one process deploys and another, sharing the file, rolls back', async () => {
    const worker = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const server = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const { appRef } = await worker.ensureApp({ repositoryId: 'r1', environment: PRODUCTION });
    const first = await worker.deploy(input(appRef, 'one'));
    const second = await worker.deploy(input(appRef, 'two'));
    expect(second.releaseId).not.toBe(first.releaseId);

    await server.ensureApp({ repositoryId: 'r1', environment: PRODUCTION });
    const restored = await server.rollback({ appRef, environment: PRODUCTION });
    expect(restored.releaseId).toBe(first.releaseId);
    // The other process reads the rollback back, transitions revived as dates.
    const described = await worker.describe(restored);
    expect(described.releaseId).toBe(first.releaseId);
    expect(described.previousReleaseId).toBe(second.releaseId);
    const usage = await worker.usageSince(restored, new Date('2025-12-31T00:00:00Z'));
    expect(usage).toMatchObject({ appRef, releaseId: first.releaseId, runningSeconds: 0 });
    expect(worker.app(appRef)?.transitions[0]?.at).toBeInstanceOf(Date);
  });

  it('stays in memory without the variable, or for a fake built without the option', async () => {
    const own = createFakeHostingDeployPort();
    const { appRef } = await own.ensureApp({ repositoryId: 'r2', environment: PRODUCTION });
    await own.deploy(input(appRef, 'one'));
    const shared = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    expect(await shared.listReleases({ appRef })).toEqual([]);

    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, '');
    const unset = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    await unset.ensureApp({ repositoryId: 'r2', environment: PRODUCTION });
    expect(await unset.listReleases({ appRef })).toEqual([]);
  });

  it('keeps what it has over a torn file', async () => {
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const { appRef } = await port.ensureApp({ repositoryId: 'r3', environment: PRODUCTION });
    writeFileSync(path, '{"clock":');
    await port.deploy(input(appRef, 'one'));
    expect(port.app(appRef)?.live?.image).toBe('img:one');
  });

  it('holds a named operation until the sidecar lets it go', async () => {
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const { appRef } = await port.ensureApp({ repositoryId: 'r4', environment: PRODUCTION });
    writeFileSync(`${path}.hold.json`, JSON.stringify({ held: ['deploy', 7] }));
    let settled = false;
    const deploying = port.deploy(input(appRef, 'one')).then((handle) => {
      settled = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    // Another operation is not held.
    expect(await port.listReleases({ appRef })).toEqual([]);

    writeFileSync(`${path}.hold.json`, JSON.stringify({ held: [] }));
    expect((await deploying).releaseId).toBe('rel-1');
  });

  it('holds nothing over a torn or shapeless sidecar', async () => {
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const { appRef } = await port.ensureApp({ repositoryId: 'r5', environment: PRODUCTION });
    writeFileSync(`${path}.hold.json`, '{"held":');
    await port.deploy(input(appRef, 'one'));
    writeFileSync(`${path}.hold.json`, JSON.stringify({ held: 'deploy' }));
    expect((await port.deploy(input(appRef, 'two'))).releaseId).toBe('rel-2');
  });

  it('fails a hold nobody releases at the provider, after the limit', async () => {
    vi.useFakeTimers();
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true });
    const { appRef } = await port.ensureApp({ repositoryId: 'r6', environment: PRODUCTION });
    writeFileSync(`${path}.hold.json`, JSON.stringify({ held: ['deploy'] }));
    const deploying = port.deploy(input(appRef, 'one'));
    const refused = expect(deploying).rejects.toBeInstanceOf(OrchestratorApiError);
    await vi.advanceTimersByTimeAsync(FAKE_HOSTING_HOLD_LIMIT_MS + 200);
    await refused;
    expect(port.app(appRef)?.live).toBeNull();
  });
});
