import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoPreviousReleaseError,
  OrchestratorApiError,
  createFakeHostingDeployPort,
  createFlyHostingDeployPort,
  type DeployReleaseInput,
  type HostingDeployPort,
  type HostingEnvironment,
  type ReleaseUsage,
} from '../src/index';
import { createHostingFlySim, flyJson } from './contract/hostingFlySim';

// THE HOSTING DEPLOY PORT'S CONTRACT (Story MOTIR-9791 · MOTIR-9806) — one case
// list, run unchanged against every adapter. The preview and production stories
// test against the fake; this suite is what lets them trust it, because every
// assertion below holds for the Fly adapter too (driven through an in-memory
// Machines API, no network). A new adapter (serverless, AWS) joins by adding ONE
// entry to `ADAPTERS`: a port, a clock it advances, a provider failure it can
// inject, and a read of what the provider was told to run.

interface ProviderRuntime {
  readonly image: string;
  readonly port: number;
  readonly healthCheckPath: string;
}

interface HostingHarness {
  readonly port: HostingDeployPort;
  advanceSeconds(seconds: number): void;
  /** The provider refuses the next destroy (of a release or of an app) for `appRef`
   *  once, destroying nothing. */
  failNextDestroy(appRef: string, operation: 'destroy' | 'destroyApp'): void;
  /** What the provider was told to run in that app now. */
  runtimeOf(appRef: string): ProviderRuntime | null;
}

const START = Date.parse('2026-10-28T00:00:00.000Z');
const PREFIX = 'mh-';

function fakeHarness(): HostingHarness {
  const fake = createFakeHostingDeployPort({ appPrefix: PREFIX, start: new Date(START) });
  return {
    port: fake,
    advanceSeconds: (s) => fake.advanceSeconds(s),
    failNextDestroy: (_appRef, operation) => fake.failNext(operation),
    runtimeOf(appRef) {
      const live = fake.app(appRef)?.live;
      return live
        ? {
            image: live.image,
            port: live.runtime.port,
            healthCheckPath: live.runtime.healthCheck.path,
          }
        : null;
    },
  };
}

function flyHarness(): HostingHarness {
  let clock = START;
  let ids = 0;
  const sim = createHostingFlySim(() => clock);
  vi.stubGlobal('fetch', sim.fetch);
  const port = createFlyHostingDeployPort(
    {
      token: 'hosting-token',
      org: 'motir-hosting',
      region: 'iad',
      appPrefix: PREFIX,
      guardImage: 'registry.fly.io/motir-hosting-guard@sha256:guard',
      originSecretKey: 'origin-key',
    },
    { now: () => new Date(clock), newReleaseId: () => `rel-${(ids += 1)}` },
  );
  return {
    port,
    advanceSeconds: (s) => {
      clock += s * 1000;
    },
    failNextDestroy(appRef, operation) {
      const target =
        operation === 'destroy'
          ? (path: string) => path.startsWith(`/apps/${appRef}/machines/`)
          : (path: string) => path === `/apps/${appRef}`;
      let pending = true;
      sim.overrides.push((call) => {
        if (!pending || call.method !== 'DELETE' || !target(call.path)) return null;
        pending = false;
        return flyJson(503, { error: 'unavailable' });
      });
    },
    runtimeOf(appRef) {
      const config = sim.apps.get(appRef)?.[0]?.config;
      if (!config) return null;
      // The app container and the port its guard forwards to: the service
      // itself is the guard's (MOTIR-9947), never the app's.
      const containers = config['containers'] as Array<Record<string, unknown>>;
      const app = containers.find((c) => c['name'] === 'app')!;
      const guard = containers.find((c) => c['name'] === 'guard')!;
      const health = (config['checks'] as Record<string, Record<string, unknown>>)['health']!;
      return {
        image: String(app['image']),
        port: Number((guard['env'] as Record<string, string>)['MOTIR_GUARD_APP_PORT']),
        healthCheckPath: String(health['path']),
      };
    },
  };
}

const ADAPTERS: ReadonlyArray<readonly [string, () => HostingHarness]> = [
  ['fake', fakeHarness],
  ['fly', flyHarness],
];

const R = 'cmrepo1';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const IMAGE = { ref: 'docker.io/traefik/whoami', digest: 'sha256:abc' };

function release(
  appRef: string,
  environment: HostingEnvironment,
  marker: string,
): DeployReleaseInput {
  return {
    appRef,
    environment,
    artifact: { kind: 'image', ...IMAGE },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
    },
    env: [{ name: 'WHOAMI_NAME', value: marker, secret: false }],
    idle: { mode: 'suspend', idleSeconds: 300 },
  };
}

/** A usage record, with a duration that is never negative. */
function expectUsage(usage: ReleaseUsage, appRef: string, releaseId: string): void {
  expect(usage).toMatchObject({ appRef, releaseId });
  expect(usage.until.getTime()).toBeGreaterThanOrEqual(usage.since.getTime());
  expect(usage.runningSeconds).toBeGreaterThanOrEqual(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(ADAPTERS)('the hosting deploy port contract — %s', (_name, make) => {
  let h: HostingHarness;
  let prod: string;

  beforeEach(async () => {
    h = make();
    prod = (await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION })).appRef;
  });

  it('deploys release A, gives an address, and describes A running with the manifest’s runtime', async () => {
    const a = await h.port.deploy(release(prod, PRODUCTION, 'A'));
    expect(a).toMatchObject({ appRef: prod, environment: PRODUCTION, releaseId: 'rel-1' });
    const description = await h.port.describe(a);
    expect(description).toMatchObject({
      state: 'healthy',
      releaseId: 'rel-1',
      previousReleaseId: null,
      // Every Fly release is reached only through its origin-secret guard.
      originCredential: 'origin_secret',
    });
    expect(description.upstreamAddress).toMatch(new RegExp(`^https://${prod}\\.`));
    expect(h.runtimeOf(prod)).toEqual({
      image: `${IMAGE.ref}@${IMAGE.digest}`,
      port: 8080,
      healthCheckPath: '/health',
    });
  });

  it('keeps a preview and production side by side; destroying the preview leaves production', async () => {
    const pr = await h.port.ensureApp({ repositoryId: R, environment: PREVIEW });
    expect(pr.appRef).toBe(`${prod}-pr7`);
    expect(pr.pushNamespace).toBe(`${prod}-pv`);
    const preview = await h.port.deploy(release(pr.appRef, PREVIEW, 'P'));
    const production = await h.port.deploy(release(prod, PRODUCTION, 'A'));

    const listed = [
      ...(await h.port.listReleases({ appRef: pr.appRef })),
      ...(await h.port.listReleases({ appRef: prod })),
    ];
    expect(listed.map((s) => [s.handle.appRef, s.handle.environment])).toEqual([
      [pr.appRef, PREVIEW],
      [prod, PRODUCTION],
    ]);

    expectUsage(await h.port.destroy(preview, 'pull_request_closed'), pr.appRef, preview.releaseId);
    expect(await h.port.destroyApp({ appRef: pr.appRef })).toEqual([]);
    expect(await h.port.listReleases({ appRef: pr.appRef })).toEqual([]);
    expect(await h.port.describe(production)).toMatchObject({
      state: 'healthy',
      releaseId: production.releaseId,
    });
  });

  it('rolls back to A after B, and refuses a second rollback with nothing earlier', async () => {
    const a = await h.port.deploy(release(prod, PRODUCTION, 'A'));
    const b = await h.port.deploy(release(prod, PRODUCTION, 'B'));
    expect(await h.port.describe(b)).toMatchObject({
      releaseId: b.releaseId,
      previousReleaseId: a.releaseId,
    });

    const back = await h.port.rollback({ appRef: prod, environment: PRODUCTION });
    expect(back.releaseId).toBe(a.releaseId);
    expect(await h.port.describe(back)).toMatchObject({
      state: 'healthy',
      releaseId: a.releaseId,
      previousReleaseId: b.releaseId,
    });

    // A rollback SWAPS the live and kept releases, so after one there is always
    // an earlier release; what has none is an app with only its first deploy.
    const other = (await h.port.ensureApp({ repositoryId: 'cmrepo2', environment: PRODUCTION }))
      .appRef;
    await h.port.deploy(release(other, PRODUCTION, 'only'));
    await expect(
      h.port.rollback({ appRef: other, environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
  });

  it('destroy returns usage for a running release and for an already-destroyed one', async () => {
    const a = await h.port.deploy(release(prod, PRODUCTION, 'A'));
    h.advanceSeconds(120);
    const usage = await h.port.destroy(a, 'retired');
    expectUsage(usage, prod, a.releaseId);
    expect(usage.runningSeconds).toBe(120);
    expect((await h.port.describe(a)).state).toBe('destroyed');

    const again = await h.port.destroy(a, 'retired');
    expectUsage(again, prod, a.releaseId);
    expect(again.runningSeconds).toBe(0);
  });

  it('a destroy the provider refuses throws the typed error and destroys nothing; the retry returns usage', async () => {
    const a = await h.port.deploy(release(prod, PRODUCTION, 'A'));
    h.advanceSeconds(30);
    h.failNextDestroy(prod, 'destroy');
    await expect(h.port.destroy(a, 'retired')).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(await h.port.describe(a)).toMatchObject({ state: 'healthy', releaseId: a.releaseId });

    const usage = await h.port.destroy(a, 'retired');
    expectUsage(usage, prod, a.releaseId);
    expect(usage.runningSeconds).toBe(30);
  });

  it('destroy app after two releases returns the usage of the one still running, and leaves list empty', async () => {
    await h.port.deploy(release(prod, PRODUCTION, 'A'));
    h.advanceSeconds(10);
    const b = await h.port.deploy(release(prod, PRODUCTION, 'B'));
    h.advanceSeconds(20);

    h.failNextDestroy(prod, 'destroyApp');
    await expect(h.port.destroyApp({ appRef: prod })).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(await h.port.listReleases({ appRef: prod })).toHaveLength(1);

    const usage = await h.port.destroyApp({ appRef: prod });
    expect(usage).toHaveLength(1);
    expectUsage(usage[0]!, prod, b.releaseId);
    expect(usage[0]!.runningSeconds).toBe(30);
    expect(await h.port.listReleases({ appRef: prod })).toEqual([]);
    expect(await h.port.destroyApp({ appRef: prod })).toEqual([]);
  });
});
