import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  OrchestratorApiError,
  createFakeHostingDeployPort,
  type DeployReleaseInput,
  type HostingEnvironment,
} from '../src/index';

// A configurable fake UPSTREAM (Story MOTIR-5766 · MOTIR-10100): a lane points a
// ready preview's fake release at a stand-in it runs. The override moves where
// the release ANSWERS and nothing else — not its state, not its credential.

const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const STAND_IN = 'http://127.0.0.1:4599';

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
    idle: { mode: 'always_on' },
    // The AWS shape, which every other target ignores (the held-release case runs on `aws`).
    shape: 'container',
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-upstream-'));
  path = join(dir, 'state.json');
  process.env[FAKE_HOSTING_STATE_PATH_ENV] = path;
});

afterEach(() => {
  delete process.env[FAKE_HOSTING_STATE_PATH_ENV];
  rmSync(dir, { recursive: true, force: true });
});

async function deployed(
  port = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' }),
  rid = 'cmr1',
) {
  const { appRef } = await port.ensureApp({ repositoryId: rid, environment: PREVIEW });
  const handle = await port.deploy(input(appRef));
  return { port, appRef, handle };
}

describe('setUpstream on the fake hosting port', () => {
  it('crosses instances over one store, both ways', async () => {
    const { port: a, appRef, handle } = await deployed();
    a.setUpstream(appRef, STAND_IN);
    const b = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    expect((await b.describe(handle)).upstreamAddress).toBe(STAND_IN);
    b.setUpstream(appRef, 'http://127.0.0.1:4600');
    expect((await a.describe(handle)).upstreamAddress).toBe('http://127.0.0.1:4600');
  });

  it('moves the address and nothing else', async () => {
    const { port, appRef, handle } = await deployed();
    const before = await port.describe(handle);
    const listed = await port.listReleases({ appRef });
    port.setUpstream(appRef, STAND_IN);
    const after = await port.describe(handle);
    expect(after).toEqual({ ...before, upstreamAddress: STAND_IN });
    expect(after.originCredential).toBe('origin_secret');
    expect(await port.listReleases({ appRef })).toEqual(listed);
  });

  it('null restores the template address for that app only', async () => {
    const { port, appRef, handle } = await deployed();
    const other = await deployed(port, 'cmr2');
    port.setUpstream(appRef, STAND_IN);
    port.setUpstream(other.appRef, 'http://127.0.0.1:4601');
    port.setUpstream(appRef, null);
    expect((await port.describe(handle)).upstreamAddress).toBe(`https://${appRef}.fake.invalid`);
    expect((await port.describe(other.handle)).upstreamAddress).toBe('http://127.0.0.1:4601');
  });

  it('stores the origin, dropping a path and a query', async () => {
    const { port, appRef, handle } = await deployed();
    port.setUpstream(appRef, 'http://127.0.0.1:4599/invoices?x=1');
    expect((await port.describe(handle)).upstreamAddress).toBe(STAND_IN);
  });

  it('refuses a value that is not an absolute http(s) URL, and an unknown app', async () => {
    const { port, appRef, handle } = await deployed();
    port.setUpstream(appRef, STAND_IN);
    const stored = readFileSync(path, 'utf8');
    for (const bad of ['127.0.0.1:4599', 'ftp://x', 'javascript:alert(1)']) {
      expect(() => port.setUpstream(appRef, bad)).toThrow(OrchestratorApiError);
      expect(() => port.setUpstream(appRef, bad)).toThrow(appRef);
    }
    expect(readFileSync(path, 'utf8')).toBe(stored);
    expect((await port.describe(handle)).upstreamAddress).toBe(STAND_IN);
    expect(() => port.setUpstream('mh-nope', STAND_IN)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('survives a deploy made by another instance', async () => {
    const { port: a, appRef } = await deployed();
    a.setUpstream(appRef, STAND_IN);
    const b = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    const next = await b.deploy(input(appRef));
    expect((await a.describe(next)).upstreamAddress).toBe(STAND_IN);
    const fresh = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });
    const described = await fresh.describe(next);
    expect(described.releaseId).toBe(next.releaseId);
    expect(described.upstreamAddress).toBe(STAND_IN);
  });

  it('never gives a held release an address', async () => {
    const port = createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'aws' });
    const { appRef } = await port.ensureApp({ repositoryId: 'cmr1', environment: PREVIEW });
    port.setAccountReady(false);
    const held = await port.deploy(input(appRef));
    port.setUpstream(appRef, STAND_IN);
    expect(await port.describe(held)).toMatchObject({
      state: 'waiting_for_account',
      upstreamAddress: null,
    });
  });

  it('takes effect in one process and writes no file with the seam off', async () => {
    delete process.env[FAKE_HOSTING_STATE_PATH_ENV];
    const { port, appRef, handle } = await deployed();
    port.setUpstream(appRef, STAND_IN);
    expect((await port.describe(handle)).upstreamAddress).toBe(STAND_IN);
    expect(existsSync(path)).toBe(false);
  });
});
