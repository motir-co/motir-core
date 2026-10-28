// MOTIR-9805 — the operator deploy check's step logic, driven against the fake
// hosting deploy port. Pure: no database, no network. The script
// (`scripts/hosting-deploy-check.ts`) is only argv and console around
// `runDeployCheck`, so these cases are the command's behaviour.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOY_CHECK_APP_PREFIX,
  DEPLOY_CHECK_DEFAULT_MANIFEST,
  DEPLOY_CHECK_IMAGE,
  deployCheckApp,
  DeployCheckNameRefusedError,
  fakeGuardedFetch,
  imageArtifact,
  parseDeployCheckArgs,
  runDeployCheck,
  type DeployCheckDeps,
} from '@/lib/hosting/deployCheck';
import {
  getHostingDeployPort,
  hostingOriginSecretKey,
  resetHostingFakes,
} from '@/lib/orchestrator/hosting';
import {
  createFakeHostingDeployPort,
  deriveOriginSecret,
  OrchestratorNotConfiguredError,
  type HostingDeployPort,
  type HostingDeployTarget,
} from '@/lib/orchestrator';

const INVALID_NO_PORT = 'tests/fixtures/hosting/motir.hosting.invalid-no-port.json';
const APP = 'motir-deploy-check-default';
const KEY = 'probe-origin-key';
const SECRET = deriveOriginSecret(KEY, APP);

type Block = { label: string; fields: Record<string, unknown> };

/** The fake, with the check's prefix, behind a spy that counts every port call. */
function harness(options: { target?: HostingDeployTarget; fetch?: DeployCheckDeps['fetch'] } = {}) {
  // The AWS check names its app `mh-<repositoryId>`, the AWS adapter's own name.
  const fake = createFakeHostingDeployPort(
    options.target === 'aws'
      ? { target: 'aws' }
      : {
          appPrefix: DEPLOY_CHECK_APP_PREFIX,
          ...(options.target ? { target: options.target } : {}),
        },
  );
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
  const out: Block[] = [];
  const reads: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const guarded = options.fetch ?? fakeGuardedFetch(KEY);
  const deps: DeployCheckDeps = {
    port: () => port,
    readManifest: (path) => {
      reads.push(path);
      try {
        return readFileSync(resolve(process.cwd(), path), 'utf8');
      } catch {
        return null;
      }
    },
    print: (label, fields) => out.push({ label, fields }),
    fetch: (url, init) => {
      requests.push({ url, headers: init.headers });
      return guarded(url, init);
    },
    originSecretKey: () => KEY,
  };
  const run = (...argv: string[]) => runDeployCheck(argv, deps);
  const block = (label: string) => out.findLast((b) => b.label === label)?.fields;
  return { fake, port, calls, out, reads, requests, deps, run, block };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetHostingFakes();
});

describe('deploy', () => {
  it('parses the fixture manifest, ensures the check app and deploys release 1', async () => {
    const h = harness();
    expect(await h.run('deploy')).toBe(0);
    expect(h.reads).toEqual([DEPLOY_CHECK_DEFAULT_MANIFEST]);
    expect(h.calls.slice(0, 2)).toEqual(['ensureApp', 'deploy']);
    expect(h.block('deploy')).toEqual({
      app: APP,
      release: 1,
      releaseId: 'rel-1',
      state: 'healthy',
      address: `https://${APP}.fake.invalid`,
    });
    const live = h.fake.app(APP)?.live;
    expect(live?.image).toBe(DEPLOY_CHECK_IMAGE);
    expect(live?.runtime.port).toBe(8080);
    expect(live?.env).toMatchObject({
      MOTIR_DEPLOY_CHECK_RELEASE: '1',
      WHOAMI_NAME: `${APP} release 1`,
      WHOAMI_PORT_NUMBER: '8080',
    });
  });

  it('deploys another image and another manifest when told to', async () => {
    const h = harness();
    const code = await h.run(
      'deploy',
      '--image=example.invalid/app:1',
      '--manifest',
      DEPLOY_CHECK_DEFAULT_MANIFEST,
      '--name',
      'motir-deploy-check-alt',
    );
    expect(code).toBe(0);
    expect(h.fake.app('motir-deploy-check-alt')?.live?.image).toBe('example.invalid/app:1');
  });
});

describe('release2, rollback and status', () => {
  it('status follows the serving release through release2 and rollback', async () => {
    const h = harness();
    await h.run('deploy');
    expect(await h.run('release2')).toBe(0);
    expect(h.block('release2')).toMatchObject({ releaseId: 'rel-2', release: 2 });
    expect(h.fake.app(APP)?.live?.env['MOTIR_DEPLOY_CHECK_RELEASE']).toBe('2');

    await h.run('status');
    expect(h.block('status')).toMatchObject({
      servingReleaseId: 'rel-2',
      previousReleaseId: 'rel-1',
    });

    expect(await h.run('rollback')).toBe(0);
    expect(h.block('rollback')).toMatchObject({ servingReleaseId: 'rel-1' });

    await h.run('status');
    expect(h.block('status')).toMatchObject({ servingReleaseId: 'rel-1', state: 'healthy' });
    const [summary] = await h.port.listReleases({ appRef: APP });
    expect((await h.port.describe(summary!.handle)).releaseId).toBe('rel-1');
  });

  it('release2 does not ensure the app again', async () => {
    const h = harness();
    await h.run('deploy');
    h.calls.length = 0;
    await h.run('release2');
    expect(h.calls).not.toContain('ensureApp');
  });

  it('status of an app with no release says so', async () => {
    const h = harness();
    expect(await h.run('status')).toBe(0);
    expect(h.block('status')).toEqual({ app: APP, state: 'none', servingReleaseId: null });
  });

  it('a rollback with nothing to roll back to is refused, non-zero', async () => {
    const h = harness();
    await h.run('deploy');
    expect(await h.run('rollback')).toBe(1);
    expect(h.block('refused')).toMatchObject({ error: 'HOSTING_NO_PREVIOUS_RELEASE' });
  });
});

describe('destroy', () => {
  it('prints the usage as JSON, destroys the app, and the listing is empty', async () => {
    const h = harness();
    await h.run('deploy');
    h.fake.advanceSeconds(90);
    expect(await h.run('destroy')).toBe(0);
    const usage = JSON.parse(String(h.block('destroy')?.['usage'])) as Record<string, unknown>;
    expect(usage).toMatchObject({ appRef: APP, releaseId: 'rel-1', runningSeconds: 90 });
    expect(h.calls).toContain('destroyApp');
    expect(h.fake.app(APP)).toBeUndefined();
    expect(h.block('destroyApp')).toEqual({ app: APP, usage: '[]', releases: '[]' });
    expect(await h.port.listReleases({ appRef: APP })).toEqual([]);
  });

  it('with no release it still removes the app', async () => {
    const h = harness();
    await h.port.ensureApp({ repositoryId: 'default', environment: { kind: 'production' } });
    expect(await h.run('destroy')).toBe(0);
    expect(h.calls).not.toContain('destroy');
    expect(h.block('destroy')).toMatchObject({ usage: 'none (no release)' });
    expect(h.fake.app(APP)).toBeUndefined();
  });
});

describe('all', () => {
  it('runs every step in order and leaves nothing behind', async () => {
    const h = harness();
    expect(await h.run('all')).toBe(0);
    expect(h.out.map((b) => b.label)).toEqual([
      'deploy',
      'release2',
      'rollback',
      'status',
      'probe',
      'destroy',
      'destroyApp',
    ]);
    expect(h.block('status')).toMatchObject({ servingReleaseId: 'rel-1' });
    expect(h.fake.app(APP)).toBeUndefined();
  });
});

describe('probe (MOTIR-9947)', () => {
  it('prints the status with the derived header and without it — and never the secret', async () => {
    const h = harness();
    await h.run('deploy');
    expect(await h.run('probe')).toBe(0);
    expect(h.block('probe')).toEqual({
      app: APP,
      url: `https://${APP}.fake.invalid/health`,
      originCredential: 'origin_secret',
      withSecret: '200 OK',
      withoutSecret: '403 Forbidden',
    });
    // The secret went on the wire once, under the header, and nowhere else.
    expect(h.requests.map((r) => r.headers)).toEqual([{ 'X-Motir-Origin-Secret': SECRET }, {}]);
    expect(JSON.stringify(h.out)).not.toContain(SECRET);
    expect(JSON.stringify(h.out)).not.toContain(KEY);
  });

  it('fails when the release answers without the secret — an unguarded upstream', async () => {
    const h = harness({ fetch: async () => new Response('hi', { status: 200 }) });
    await h.run('deploy');
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toMatchObject({ withSecret: '200', withoutSecret: '200' });
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_PROBE_FAILED',
      message: expect.stringMatching(/without the secret it answered 200/),
    });
  });

  it('fails when the release refuses even with the secret', async () => {
    const h = harness({ fetch: async () => new Response(null, { status: 403 }) });
    await h.run('deploy');
    expect(await h.run('probe')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/with the secret it answered 403/),
    });
  });

  // An AWS function release is reached with SigV4, not the origin secret
  // (MOTIR-10011): the probe sends no secret and stops with its refusal.
  it('fails, sending no secret, when the release has no origin-secret guard', async () => {
    const h = harness({ target: 'aws' });
    const aws = ['--target', 'aws', '--repository', 'probe1', '--shape', 'function'];
    expect(await h.run('deploy', ...aws)).toBe(0);
    expect(await h.run('probe', ...aws)).toBe(1);
    expect(h.block('probe')).toMatchObject({ originCredential: 'aws_sigv4' });
    expect(h.requests.map((r) => r.headers)).toEqual([{}, {}]);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/origin credential is aws_sigv4/),
    });
  });

  it('proves an AWS container release’s load-balancer rule as it proves Fly’s guard', async () => {
    const h = harness({ target: 'aws' });
    const aws = ['--target', 'aws', '--repository', 'probe2', '--shape', 'container'];
    expect(await h.run('deploy', ...aws)).toBe(0);
    expect(await h.run('probe', ...aws)).toBe(0);
    expect(h.block('probe')).toEqual({
      app: 'mh-probe2',
      url: 'https://mh-probe2.alb.fake.invalid/health',
      originCredential: 'origin_secret',
      withSecret: '200 OK',
      withoutSecret: '403 Forbidden',
    });
    expect(h.requests.map((r) => r.headers)).toEqual([
      { 'X-Motir-Origin-Secret': deriveOriginSecret(KEY, 'mh-probe2') },
      {},
    ]);
  });

  it('fails when nothing is served, without calling the release', async () => {
    const h = harness();
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toEqual({ app: APP, state: 'none' });
    expect(h.requests).toEqual([]);
    expect(h.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_PROBE_FAILED' });
  });

  it('fakeGuardedFetch answers as the guard: 200 for the app’s own secret only', async () => {
    const guard = fakeGuardedFetch(KEY);
    const url = `https://${APP}.fake.invalid/health`;
    expect((await guard(url, { headers: { 'X-Motir-Origin-Secret': SECRET } })).status).toBe(200);
    const other = deriveOriginSecret(KEY, 'motir-deploy-check-other');
    expect((await guard(url, { headers: { 'X-Motir-Origin-Secret': other } })).status).toBe(403);
    expect((await guard(url, { headers: {} })).status).toBe(403);
  });
});

describe('hostingOriginSecretKey', () => {
  it('reads MOTIR_HOSTING_ORIGIN_SECRET_KEY, stands in under the fake, and names it otherwise', () => {
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', ' k1 ');
    expect(hostingOriginSecretKey()).toBe('k1');
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', '');
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(hostingOriginSecretKey()).toBe('fake-origin-secret-key');
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(() => hostingOriginSecretKey()).toThrow(OrchestratorNotConfiguredError);
    expect(() => hostingOriginSecretKey()).toThrow(/MOTIR_HOSTING_ORIGIN_SECRET_KEY/);
  });
});

describe('refusals before any port call', () => {
  it('an invalid manifest (port removed) prints port and its reason, with zero port calls', async () => {
    const h = harness();
    const portFactory = vi.fn(h.deps.port);
    const code = await runDeployCheck(['deploy', '--manifest', INVALID_NO_PORT], {
      ...h.deps,
      port: portFactory,
    });
    expect(code).toBe(1);
    expect(h.block('refused')).toMatchObject({
      error: 'HOSTING_MANIFEST_INVALID',
      manifest: INVALID_NO_PORT,
      field: 'port',
      reason: 'is missing',
    });
    expect(h.calls).toEqual([]);
    expect(portFactory).not.toHaveBeenCalled();
  });

  it.each(['release2', 'all'])('%s refuses the invalid manifest the same way', async (step) => {
    const h = harness();
    expect(await h.run(step, '--manifest', INVALID_NO_PORT)).toBe(1);
    expect(h.block('refused')).toMatchObject({ field: 'port' });
    expect(h.calls).toEqual([]);
  });

  it('a missing manifest path names the file, with zero port calls', async () => {
    const h = harness();
    expect(await h.run('deploy', '--manifest', 'tests/fixtures/hosting/nope.json')).toBe(1);
    expect(h.block('refused')).toEqual({
      error: 'HOSTING_MANIFEST_MISSING',
      manifest: 'tests/fixtures/hosting/nope.json',
      reason: 'no such file',
    });
    expect(h.calls).toEqual([]);
  });

  it.each(['deploy', 'release2', 'rollback', 'status', 'destroy', 'all'])(
    '%s refuses a name without the motir-deploy-check- prefix, with zero port calls',
    async (step) => {
      const h = harness();
      await h.fake.ensureApp({ repositoryId: 'x', environment: { kind: 'production' } });
      h.calls.length = 0;
      for (const name of ['mh-tenant', 'motir-deploy-check-', 'motir-deploy-check-Bad_Name']) {
        expect(await h.run(step, '--name', name)).toBe(1);
        expect(h.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_NAME_REFUSED' });
      }
      expect(h.calls).toEqual([]);
    },
  );

  it('a bad command line is refused with the usage text', async () => {
    const h = harness();
    expect(await h.run()).toBe(1);
    expect(String(h.block('refused')?.['message'])).toMatch(/Name a step[\s\S]*Usage:/);
    expect(await h.run('deploy', '--name')).toBe(1);
    expect(String(h.block('refused')?.['message'])).toMatch(/--name needs a value/);
    expect(await h.run('deploy', 'extra')).toBe(1);
    expect(String(h.block('refused')?.['message'])).toMatch(/Unknown argument: extra/);
    expect(h.calls).toEqual([]);
  });

  it('a thrown non-Error still exits non-zero', async () => {
    const h = harness();
    const code = await runDeployCheck(['status'], {
      ...h.deps,
      port: () => {
        throw 'boom';
      },
    });
    expect(code).toBe(1);
    expect(h.block('refused')).toEqual({ error: 'Error', message: 'boom' });
  });
});

describe('through the composition-root accessor', () => {
  it('with the Fly token unset, exits non-zero with the not-configured error and no network call', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = harness();
    const code = await runDeployCheck(['deploy'], {
      ...h.deps,
      port: () => getHostingDeployPort('fly', { appPrefix: DEPLOY_CHECK_APP_PREFIX }),
    });
    expect(code).toBe(1);
    expect(h.block('refused')).toMatchObject({
      error: 'ORCHESTRATOR_NOT_CONFIGURED',
      message: expect.stringMatching(/MOTIR_HOSTING_FLY_API_TOKEN/),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('the fake the accessor returns uses the check prefix', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const h = harness();
    const deps = {
      ...h.deps,
      port: () => getHostingDeployPort('fly', { appPrefix: DEPLOY_CHECK_APP_PREFIX }),
    };
    expect(await runDeployCheck(['deploy'], deps)).toBe(0);
    expect(h.block('deploy')).toMatchObject({ app: APP });
  });
});

describe('helpers', () => {
  it('deployCheckApp maps a name to its synthetic repository', () => {
    expect(deployCheckApp(APP)).toEqual({ repositoryId: 'default', appRef: APP });
    expect(() => deployCheckApp('default')).toThrow(DeployCheckNameRefusedError);
  });

  it('imageArtifact pins a digest when there is one', () => {
    expect(imageArtifact(DEPLOY_CHECK_IMAGE)).toEqual({
      kind: 'image',
      ref: 'docker.io/traefik/whoami',
      digest: DEPLOY_CHECK_IMAGE.split('@')[1],
    });
    expect(imageArtifact('a/b:1')).toEqual({ kind: 'image', ref: 'a/b:1' });
  });

  it('parseDeployCheckArgs defaults to the fixture, the default name and the record image', () => {
    expect(parseDeployCheckArgs(['status'])).toEqual({
      step: 'status',
      options: {
        manifestPath: DEPLOY_CHECK_DEFAULT_MANIFEST,
        appName: APP,
        image: DEPLOY_CHECK_IMAGE,
      },
    });
  });
});
