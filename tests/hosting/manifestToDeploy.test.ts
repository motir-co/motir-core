// MOTIR-9806 — the story's parse-then-deploy seam: the hosting manifest a
// repository commits becomes the runtime the deploy port runs, unchanged, and a
// manifest the parser refuses never reaches an adapter. Against the fake; the
// operator command's own refusal is MOTIR-9805's (`deployCheck.test.ts`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostingManifestInvalidError, HostingManifestMissingError } from '@/lib/hosting/errors';
import { HOSTING_MANIFEST_FILE_NAME, parseHostingManifest } from '@/lib/hosting/manifest';
import { createFakeHostingDeployPort, type HostingDeployPort } from '@motir/orchestrator';
import { imageArtifact } from '@/lib/hosting/deployCheck';
import {
  HOSTING_FIXTURE_IMAGE,
  HOSTING_FIXTURE_MANIFEST_PATH,
} from '../fixtures/hosting/fixtureImage';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const INVALID_NO_PORT = 'tests/fixtures/hosting/motir.hosting.invalid-no-port.json';

/** The fake behind a counter of every port call. */
function countedFake() {
  const fake = createFakeHostingDeployPort();
  const calls: string[] = [];
  const port = new Proxy(fake, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as HostingDeployPort;
  return { fake, port, calls };
}

/** What every caller does: parse first, then deploy what was parsed. */
async function parseThenDeploy(port: HostingDeployPort, text: string | null) {
  const manifest = parseHostingManifest(text);
  const app = await port.ensureApp({
    repositoryId: 'cmrepo1',
    environment: { kind: 'production' },
  });
  return port.deploy({
    appRef: app.appRef,
    environment: { kind: 'production' },
    artifact: imageArtifact(HOSTING_FIXTURE_IMAGE),
    runtime: manifest,
    env: [],
    idle: { mode: 'suspend', idleSeconds: 300 },
  });
}

describe('the manifest feeds the deploy port', () => {
  it('the fixture manifest deploys with its port, health path, start command and database kind as parsed', async () => {
    const { fake, port, calls } = countedFake();
    const parsed = parseHostingManifest(read(HOSTING_FIXTURE_MANIFEST_PATH));
    const handle = await parseThenDeploy(port, read(HOSTING_FIXTURE_MANIFEST_PATH));
    expect(calls.filter((c) => c === 'deploy')).toHaveLength(1);
    const runtime = fake.app(handle.appRef)?.live?.runtime;
    expect(runtime).toMatchObject({
      port: parsed.port,
      healthCheck: { path: parsed.healthCheck.path },
      startCommand: parsed.startCommand,
      database: { kind: parsed.database.kind },
    });
    expect(runtime).toMatchObject({ port: 8080, healthCheck: { path: '/health' } });
  });

  it('a manifest with port removed is refused naming port, with zero adapter calls', async () => {
    const { port, calls } = countedFake();
    const refused = parseThenDeploy(port, read(INVALID_NO_PORT));
    await expect(refused).rejects.toBeInstanceOf(HostingManifestInvalidError);
    await expect(refused).rejects.toMatchObject({ field: 'port' });
    expect(calls).toEqual([]);
  });

  it('a null manifest is refused naming the record’s file, with zero adapter calls', async () => {
    const { port, calls } = countedFake();
    const refused = parseThenDeploy(port, null);
    await expect(refused).rejects.toBeInstanceOf(HostingManifestMissingError);
    await expect(refused).rejects.toMatchObject({ fileName: HOSTING_MANIFEST_FILE_NAME });
    expect(HOSTING_MANIFEST_FILE_NAME).toBe('motir.hosting.json');
    expect(calls).toEqual([]);
  });
});
