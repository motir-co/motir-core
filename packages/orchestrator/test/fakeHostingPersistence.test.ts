import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  OrchestratorApiError,
  armFakeHostingFailure,
  createFakeHostingDeployPort,
  emptyFakeHostingSlice,
  fakeHostingPortKey,
  fakeHostingStatePath,
  loadFakeHostingSlice,
  readFakeHostingSlice,
  readFakeHostingSnapshot,
  resetFakeHostingSnapshot,
  saveFakeHostingSlice,
  takeArmedFakeHostingFailure,
  updateFakeHostingSnapshot,
  type DeployReleaseInput,
  type HostingEnvironment,
} from '../src/index';

// The fake hosting port ACROSS PROCESSES (Story MOTIR-5766 · MOTIR-10098): two
// instances over one state file stand in for the job worker that deploys, the
// app server that reads, and the spec that arranges. Unset, the fake is the
// per-call closure it always was.

const RID = 'cmrepo1';
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const KEY = fakeHostingPortKey('fly');

function input(appRef: string): DeployReleaseInput {
  return {
    appRef,
    environment: PREVIEW,
    artifact: { kind: 'image', ref: 'img', digest: 'sha256:1' },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
    },
    env: [],
    idle: { mode: 'suspend', idleSeconds: 60 },
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-hosting-'));
  // A directory that does not exist yet: the first write must create it.
  path = join(dir, 'nested', 'state.json');
  process.env[FAKE_HOSTING_STATE_PATH_ENV] = path;
});

afterEach(() => {
  delete process.env[FAKE_HOSTING_STATE_PATH_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const pair = () => [
  createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' }),
  createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' }),
];

describe('the fake hosting port over a shared state file', () => {
  it('a release one instance deploys is listed and described by a fresh one, both ways', async () => {
    const [a, b] = pair();
    const { appRef } = await b!.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const handle = await b!.deploy(input(appRef));
    expect(existsSync(path)).toBe(true);

    const fresh = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    const [listed] = await fresh.listReleases({ appRef });
    expect(listed?.handle.releaseId).toBe(handle.releaseId);
    const described = await fresh.describe(handle);
    expect(described.releaseId).toBe(handle.releaseId);
    expect(described.upstreamAddress).not.toBeNull();
    expect(described.state).toBe('healthy');

    const other = await a!.ensureApp({
      repositoryId: 'cmrepo2',
      environment: PREVIEW,
    });
    const second = await a!.deploy(input(other.appRef));
    expect((await b!.describe(second)).releaseId).toBe(second.releaseId);
    expect((await b!.listReleases({ appRef: other.appRef }))[0]?.handle.releaseId).toBe(
      second.releaseId,
    );
  });

  it('carries health, idle stop, wake, the clock and minted credentials across', async () => {
    const [a, b] = pair();
    const { appRef, pushNamespace } = await b!.ensureApp({
      repositoryId: RID,
      environment: PREVIEW,
    });
    const handle = await b!.deploy(input(appRef));
    const since = b!.now();

    b!.setHealth(appRef, 'unhealthy');
    b!.idleStop(appRef);
    expect((await a!.describe(handle)).state).toBe('stopped');
    b!.wake(appRef);
    expect((await a!.describe(handle)).state).toBe('unhealthy');

    b!.advanceSeconds(600);
    expect(a!.now().getTime() - since.getTime()).toBe(600_000);
    const usage = await a!.usageSince(handle, since);
    expect(usage.runningSeconds).toBe(600);
    expect(a!.app(appRef)?.transitions[0]?.at).toBeInstanceOf(Date);

    await b!.mintDeployCredential({ pushNamespace });
    expect(a!.mintedFor).toEqual([pushNamespace]);
    expect(a!.liveCredentials(pushNamespace)).toBe(1);
    await b!.ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    expect(a!.pushNamespaces()).toEqual([pushNamespace]);
    expect(await a!.revokeDeployCredentials({ pushNamespace })).toEqual({ revoked: 1 });
    expect(b!.liveCredentials(pushNamespace)).toBe(0);

    a!.setAccountReady(false);
    expect(readFakeHostingSnapshot(KEY)?.accountReady).toBe(false);
  });

  it('consumes an armed failure from the sidecar exactly once', async () => {
    const [a, b] = pair();
    a!.failNext('destroy');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.failures.json`)).toBe(true);

    const { appRef } = await b!.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const handle = await b!.deploy(input(appRef));
    const refused = b!.destroy(handle, 'pull_request_closed');
    await expect(refused).rejects.toBeInstanceOf(OrchestratorApiError);
    await expect(refused).rejects.toMatchObject({ status: 503 });
    expect(await a!.listReleases({ appRef })).toHaveLength(1);

    const usage = await b!.destroy(handle, 'pull_request_closed');
    expect(usage.releaseId).toBe(handle.releaseId);
    expect(await a!.listReleases({ appRef })).toEqual([]);
    const sidecar = JSON.parse(readFileSync(`${path}.failures.json`, 'utf8'));
    expect(sidecar[KEY]).toEqual({});
  });

  it('suffixes release ids with the pid and continues the stored sequence', async () => {
    const [a, b] = pair();
    const { appRef } = await a!.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const first = await a!.deploy(input(appRef));
    expect(first.releaseId).toContain(String(process.pid));
    const second = await b!.deploy(input(appRef));
    expect(second.releaseId).not.toBe(first.releaseId);
    expect((await a!.describe(second)).previousReleaseId).toBe(first.releaseId);
  });

  it('reset() empties the shared slice and disarms the sidecar', async () => {
    const [a, b] = pair();
    const { appRef, pushNamespace } = await a!.ensureApp({
      repositoryId: RID,
      environment: PREVIEW,
    });
    await a!.deploy(input(appRef));
    await a!.mintDeployCredential({ pushNamespace });
    a!.failNext('destroyApp');
    expect(b!.app(appRef)).toBeDefined();
    a!.reset();
    // An instance that had loaded the app forgets it too: nothing stored is empty.
    expect(b!.app(appRef)).toBeUndefined();

    const fresh = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    expect(fresh.app(appRef)).toBeUndefined();
    expect(await fresh.listReleases({ appRef })).toEqual([]);
    expect(fresh.mintedFor).toEqual([]);
    expect(await fresh.destroyApp({ appRef })).toEqual([]);
  });

  it('a torn store or sidecar never throws from inside an operation', async () => {
    const [a] = pair();
    const { appRef } = await a!.ensureApp({ repositoryId: RID, environment: PREVIEW });
    writeFileSync(path, '{"fly:": {"apps": ', 'utf8');
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    const made = await port.ensureApp({ repositoryId: RID, environment: PREVIEW });
    expect(made.appRef).toBe(appRef);
    const handle = await port.deploy(input(appRef));
    expect(JSON.parse(readFileSync(path, 'utf8'))[KEY].apps[appRef].live.releaseId).toBe(
      handle.releaseId,
    );

    writeFileSync(`${path}.failures.json`, '{"fly:": ', 'utf8');
    await expect(port.destroy(handle, 'pull_request_closed')).resolves.toMatchObject({
      releaseId: handle.releaseId,
    });
    await expect(port.destroyApp({ appRef })).resolves.toBeDefined();
  });

  it('keeps two port keys in disjoint slices', async () => {
    const fly = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    const narrowed = createFakeHostingDeployPort({
      shareAcrossProcesses: true,
      target: 'fly',
      appPrefix: 'motir-check-',
    });
    const mine = await fly.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const theirs = await narrowed.ensureApp({ repositoryId: RID, environment: PREVIEW });
    expect(narrowed.app(mine.appRef)).toBeUndefined();
    expect(fly.app(theirs.appRef)).toBeUndefined();
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(['fly:', 'fly:motir-check-']);
  });
});

describe('the store API', () => {
  it('reads, updates and resets a slice for a process holding only the file', () => {
    expect(fakeHostingStatePath()).toBe(path);
    expect(readFakeHostingSnapshot(KEY)).toBeNull();
    expect(readFakeHostingSlice(KEY)).toBeNull();
    const updated = updateFakeHostingSnapshot(KEY, (slice) => {
      slice.mintedFor.push('mh-x-pv');
    });
    expect(updated.mintedFor).toEqual(['mh-x-pv']);
    expect(readFakeHostingSnapshot(KEY)?.mintedFor).toEqual(['mh-x-pv']);
    saveFakeHostingSlice('aws:', emptyFakeHostingSlice());
    resetFakeHostingSnapshot(KEY);
    expect(loadFakeHostingSlice(KEY)).toBeNull();
    expect(loadFakeHostingSlice('aws:')).not.toBeNull();
    writeFileSync(path, '{', 'utf8');
    expect(readFakeHostingSlice(KEY)).toBe('torn');
    expect(loadFakeHostingSlice(KEY)).toBeNull();
  });

  it('arms and takes failures per key, and resets them with the slice', () => {
    expect(takeArmedFakeHostingFailure(KEY, 'destroy')).toBeNull();
    armFakeHostingFailure(KEY, 'destroy', 'boom');
    armFakeHostingFailure('aws:', 'destroy', 'other');
    expect(takeArmedFakeHostingFailure(KEY, 'destroyApp')).toBeNull();
    expect(takeArmedFakeHostingFailure(KEY, 'destroy')).toBe('boom');
    expect(takeArmedFakeHostingFailure(KEY, 'destroy')).toBeNull();
    armFakeHostingFailure(KEY, 'destroyApp', 'again');
    resetFakeHostingSnapshot(KEY);
    expect(takeArmedFakeHostingFailure(KEY, 'destroyApp')).toBeNull();
    expect(takeArmedFakeHostingFailure('aws:', 'destroy')).toBe('other');
  });

  it('refuses a key or an operation that would address the prototype', () => {
    saveFakeHostingSlice(KEY, emptyFakeHostingSlice());
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(() => saveFakeHostingSlice(bad, emptyFakeHostingSlice())).toThrow(/not a fake/);
      expect(() => readFakeHostingSlice(bad)).toThrow(/not a fake/);
      expect(() => resetFakeHostingSnapshot(bad)).toThrow(/not a fake/);
      expect(() => armFakeHostingFailure(bad, 'destroy', 'x')).toThrow(/not a fake/);
      expect(() => takeArmedFakeHostingFailure(bad, 'destroy')).toThrow(/not a fake/);
      expect(() => armFakeHostingFailure(KEY, bad as 'destroy', 'x')).toThrow(/not a fake/);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('touches no file with the seam off', () => {
    delete process.env[FAKE_HOSTING_STATE_PATH_ENV];
    expect(fakeHostingStatePath()).toBeNull();
    saveFakeHostingSlice(KEY, emptyFakeHostingSlice());
    armFakeHostingFailure(KEY, 'destroy', 'x');
    resetFakeHostingSnapshot(KEY);
    expect(takeArmedFakeHostingFailure(KEY, 'destroy')).toBeNull();
    expect(loadFakeHostingSlice(KEY)).toBeNull();
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });
});

describe('the fake hosting port with the seam off', () => {
  it('is per instance, unsuffixed and writes nothing', async () => {
    delete process.env[FAKE_HOSTING_STATE_PATH_ENV];
    const [a, b] = pair();
    const { appRef } = await a!.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const handle = await a!.deploy(input(appRef));
    expect(handle.releaseId).toMatch(/^rel-\d+$/);
    expect(b!.app(appRef)).toBeUndefined();
    expect(await b!.listReleases({ appRef })).toEqual([]);
    a!.failNext('destroy');
    await expect(a!.destroy(handle, 'pull_request_closed')).rejects.toMatchObject({ status: 503 });
    a!.reset();
    expect(a!.app(appRef)).toBeUndefined();
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });
});
