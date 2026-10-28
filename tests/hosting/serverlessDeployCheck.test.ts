// MOTIR-9975 — the operator deploy check on the serverless target, driven with
// `MOTIR_FLEET_ORCHESTRATOR=fake`: the fake serverless deploy port and the fake
// database port from the composition roots, a stub image builder and the
// stand-in function URL. Pure: no database, no network, no Docker.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOY_CHECK_DEFAULT_NAME,
  parseDeployCheckArgs,
  runDeployCheck,
  runDeployCheckStep,
  type DeployCheckDeps,
} from '@/lib/hosting/deployCheck';
import {
  FAKE_SERVERLESS_REGISTRY,
  fakeFunctionUrlFetch,
  fakeImageBuilder,
  SERVERLESS_DEPLOY_CHECK_APP_PREFIX,
  SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST,
  SERVERLESS_DEPLOY_CHECK_PLACEHOLDER_DIGEST,
  serverlessCheckApp,
  type ServerlessDeployCheckDeps,
} from '@/lib/hosting/serverlessDeployCheck';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import {
  createFakeHostingDeployPort,
  type DatabasePort,
  type FakeHostingControls,
  type HostingDeployPort,
} from '@/lib/orchestrator';

const APP = 'mh-deploy-check-default';

type Block = { label: string; fields: Record<string, unknown> };

/** Wrap a port so every call is recorded, and let a test replace one method. */
function counted<T extends object>(target: T, calls: string[], overrides: Partial<T> = {}): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = (
        prop in overrides ? overrides[prop as keyof T] : Reflect.get(t, prop, receiver)
      ) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

interface HarnessOptions {
  readonly port?: HostingDeployPort;
  readonly portOverrides?: Partial<HostingDeployPort>;
  readonly signedFetch?: DeployCheckDeps['fetch'];
  readonly fetch?: DeployCheckDeps['fetch'];
}

function harness(options: HarnessOptions = {}) {
  const fake = getHostingDeployPort('serverless', {
    appPrefix: SERVERLESS_DEPLOY_CHECK_APP_PREFIX,
  }) as HostingDeployPort & FakeHostingControls;
  const databases = getDatabasePort();
  const calls: string[] = [];
  const dbCalls: string[] = [];
  const port = counted(options.port ?? fake, calls, options.portOverrides);
  const databasePort = counted<DatabasePort>(databases, dbCalls);
  const out: Block[] = [];
  const built: Array<{ pushNamespace: string; label: string; digest: string }> = [];
  const stub = fakeImageBuilder(FAKE_SERVERLESS_REGISTRY);
  const urls = fakeFunctionUrlFetch(fake, () => databases);
  const serverless: ServerlessDeployCheckDeps = {
    port: () => port,
    databasePort: () => databasePort,
    signedFetch: options.signedFetch ?? urls.signed,
    buildAndPushImage: async (input) => {
      const pushed = await stub(input);
      built.push({ ...input, digest: pushed.digest });
      return pushed;
    },
    registry: () => FAKE_SERVERLESS_REGISTRY,
  };
  const deps: DeployCheckDeps = {
    port: () => {
      throw new Error('the serverless check never builds the Fly port');
    },
    readManifest: (path) => {
      try {
        return readFileSync(resolve(process.cwd(), path), 'utf8');
      } catch {
        return null;
      }
    },
    print: (label, fields) => out.push({ label, fields }),
    fetch: options.fetch ?? urls.unsigned,
    originSecretKey: () => 'unused',
    serverless,
  };
  const run = (...argv: string[]) => runDeployCheck(['--target', 'serverless', ...argv], deps);
  const block = (label: string) => out.findLast((b) => b.label === label)?.fields;
  const blocks = (label: string) => out.filter((b) => b.label === label).map((b) => b.fields);
  return { fake, databases, port, calls, dbCalls, out, built, deps, run, block, blocks };
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'No' });

beforeEach(() => {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetHostingFakes();
  resetDatabaseFakes();
});

describe('all', () => {
  it('refuses the worker, then deploys, probes, rolls back and destroys, in order', async () => {
    const h = harness();
    expect(await h.run('all')).toBe(0);
    expect(h.out.map((b) => b.label)).toEqual([
      'refuse',
      'database',
      'image',
      'deploy',
      'probe',
      'image',
      'release2',
      'probe',
      'rollback',
      'probe',
      'status',
      'destroy',
      'destroyApp',
      'deleteDatabase',
      'destroyed',
    ]);
    expect(h.block('refuse')).toMatchObject({
      app: APP,
      error: 'HOSTING_RUNTIME_REFUSED',
      field: 'requires.backgroundWork',
      releases: 0,
      databases: 0,
    });
    expect(h.block('database')).toEqual({
      app: APP,
      provider: 'neon',
      databaseRef: 'fake-db-1',
      created: true,
      pairs: 'DATABASE_URL, DIRECT_URL',
    });
    expect(h.block('deploy')).toMatchObject({
      app: APP,
      release: 'release-1',
      releaseId: 'rel-1',
      state: 'healthy',
      env: 'DATABASE_URL, DIRECT_URL',
    });
    const probes = h.blocks('probe');
    expect(probes.map((p) => [p['release'], p['database'], p['signed'], p['unsigned']])).toEqual([
      ['release-1', 'reachable', '200 OK', '403 Forbidden'],
      ['release-2', 'reachable', '200 OK', '403 Forbidden'],
      ['release-1', 'reachable', '200 OK', '403 Forbidden'],
    ]);
    expect(new Set(probes.map((p) => p['url']))).toEqual(
      new Set([`https://${APP}.fake.invalid/health`]),
    );
    expect(probes[0]).toMatchObject({ originCredential: 'aws_sigv4' });
    expect(h.block('rollback')).toMatchObject({ servingReleaseId: 'rel-1' });
    expect(h.block('status')).toMatchObject({
      servingReleaseId: 'rel-1',
      previousReleaseId: 'rel-2',
    });
    expect(JSON.parse(String(h.block('destroy')?.['usage']))).toMatchObject({
      appRef: APP,
      releaseId: 'rel-1',
    });
    expect(JSON.parse(String(h.block('deleteDatabase')?.['usage']))).toMatchObject({
      provider: 'neon',
      applicationRef: APP,
      storageBytes: expect.any(Number),
    });
    expect(h.block('destroyed')).toEqual({ app: APP, releases: 0, databases: 0 });
    expect(h.fake.app(APP)).toBeUndefined();
    expect(await h.databases.list()).toEqual([]);
  });

  it('builds two images with two digests, and deploys each pinned with the pairs as secret env', async () => {
    const h = harness();
    const images: string[] = [];
    const deploy = h.fake.deploy.bind(h.fake);
    const spy = vi.spyOn(h.fake, 'deploy').mockImplementation(async (input) => {
      const handle = await deploy(input);
      images.push(h.fake.app(APP)!.live!.image);
      const secret = input.env.filter((v) => v.secret).map((v) => v.name);
      expect(secret).toEqual(['DATABASE_URL', 'DIRECT_URL']);
      expect(input.runtime.requires).toEqual({ websockets: false, backgroundWork: false });
      return handle;
    });
    expect(await h.run('all')).toBe(0);
    spy.mockRestore();
    expect(h.built.map((b) => [b.pushNamespace, b.label])).toEqual([
      [APP, 'release-1'],
      [APP, 'release-2'],
    ]);
    expect(h.built[0]!.digest).not.toBe(h.built[1]!.digest);
    expect(images).toEqual([
      `${FAKE_SERVERLESS_REGISTRY}/${APP}@${h.built[0]!.digest}`,
      `${FAKE_SERVERLESS_REGISTRY}/${APP}@${h.built[1]!.digest}`,
    ]);
  });

  it('prints no connection string and no pair value anywhere', async () => {
    const h = harness();
    expect(await h.run('all')).toBe(0);
    const printed = JSON.stringify(h.out);
    expect(printed).not.toContain('postgresql://');
    expect(printed).not.toContain('fake-password');
    expect(printed).not.toContain('fake.invalid/app');
  });

  it('fails when the rolled-back release answers at another address', async () => {
    let calls = 0;
    const h = harness();
    const signed = fakeFunctionUrlFetch(h.fake, () => h.databases).signed;
    const moved = harness({
      signedFetch: signed,
      portOverrides: {
        describe: async (handle) => {
          const real = await h.fake.describe(handle);
          calls += 1;
          // describe is read by deploy, probe, release2, probe, rollback, probe.
          return calls >= 6 ? { ...real, upstreamAddress: 'https://moved.fake.invalid' } : real;
        },
      },
    });
    expect(await moved.run('all')).toBe(1);
    expect(moved.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_PROBE_FAILED' });
  });
});

describe('probe', () => {
  async function deployed(options: HarnessOptions) {
    const h = harness(options);
    expect(await h.run('database')).toBe(0);
    expect(await h.run('deploy')).toBe(0);
    return h;
  }

  it('passes on any release when run alone', async () => {
    const h = await deployed({});
    expect(await h.run('probe')).toBe(0);
    expect(h.block('probe')).toMatchObject({ release: 'release-1', database: 'reachable' });
  });

  it('fails when the signed response is not 200', async () => {
    const h = await deployed({ signedFetch: async () => answer(500, { database: 'reachable' }) });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toMatchObject({ signed: '500 No', release: null, database: null });
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_PROBE_FAILED',
      message: expect.stringMatching(/signed, it answered 500/),
    });
  });

  it('fails when the release does not report its database reachable', async () => {
    const h = await deployed({
      signedFetch: async () => answer(200, { release: 'release-1', database: 'unreachable' }),
    });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/reports its database unreachable/),
    });
  });

  it('fails when the body is not JSON', async () => {
    const h = await deployed({ signedFetch: async () => new Response('<html>', { status: 200 }) });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toMatchObject({ release: null, database: null });
  });

  it('ignores body fields of the wrong type', async () => {
    const h = await deployed({
      signedFetch: async () => answer(200, { release: 2, database: true }),
    });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toMatchObject({ release: null, database: null });
  });

  it('fails when the release answering is not the one the step expects', async () => {
    const h = harness({
      signedFetch: async () => answer(200, { release: 'release-2', database: 'reachable' }),
    });
    expect(await h.run('all')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/release-2 answered where release-1 was expected/),
    });
  });

  it('fails when the unsigned request is not refused', async () => {
    const h = await deployed({ fetch: async () => answer(200, {}) });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/unsigned, it answered 200/),
    });
  });

  it('fails without calling the release when nothing is served', async () => {
    const signed = vi.fn();
    const h = harness({ signedFetch: signed });
    expect(await h.run('probe')).toBe(1);
    expect(h.block('probe')).toEqual({ app: APP, state: 'none' });
    expect(signed).not.toHaveBeenCalled();
  });
});

describe('refuse', () => {
  it('passes on the target refusing requires.backgroundWork by name, having created nothing', async () => {
    const h = harness();
    expect(await h.run('refuse')).toBe(0);
    expect(h.block('refuse')).toMatchObject({
      field: 'requires.backgroundWork',
      message: expect.stringMatching(/declare the fly target/),
      releases: 0,
      databases: 0,
    });
    expect(h.calls).toEqual(['deploy', 'listReleases']);
    expect(h.dbCalls).toEqual(['list']);
    expect(h.fake.app(APP)).toBeUndefined();
    expect(h.built).toEqual([]);
  });

  it('hands the port a placeholder in the account registry, pinned by digest', async () => {
    const h = harness();
    const spy = vi.spyOn(h.fake, 'deploy');
    await h.run('refuse');
    expect(spy.mock.calls[0]![0].artifact).toEqual({
      kind: 'image',
      ref: `${FAKE_SERVERLESS_REGISTRY}/mh-deploy-check/default/production`,
      digest: SERVERLESS_DEPLOY_CHECK_PLACEHOLDER_DIGEST,
    });
  });

  it('fails when the target does not refuse the worker by that field', async () => {
    const h = harness({ port: createFakeHostingDeployPort({ target: 'fly' }) });
    expect(await h.run('refuse')).toBe(1);
    expect(h.block('refuse')).toMatchObject({ error: 'ORCHESTRATOR_API_FAILED', field: null });
    expect(h.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_FAILED' });
  });

  it('fails when the worker deploys', async () => {
    const h = harness({ portOverrides: { deploy: async () => ({}) as never } });
    expect(await h.run('refuse')).toBe(1);
    expect(h.block('refuse')).toMatchObject({ error: 'none (deployed)', message: null });
  });

  it('fails when the app already holds a database', async () => {
    const h = harness();
    await h.run('database');
    expect(await h.run('refuse')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/already holds a release or a database/),
    });
  });
});

describe('database, image, rollback and status', () => {
  it('database finds the existing one again rather than creating a second', async () => {
    const h = harness();
    await h.run('database');
    expect(await h.run('database')).toBe(0);
    expect(h.block('database')).toMatchObject({ created: false, databaseRef: 'fake-db-1' });
    expect(await h.databases.list()).toHaveLength(1);
  });

  it('image ensures the app and pushes release 1', async () => {
    const h = harness();
    expect(await h.run('image')).toBe(0);
    expect(h.block('image')).toMatchObject({ app: APP, label: 'release-1', repository: APP });
    expect(h.calls).toEqual(['ensureApp']);
  });

  it('deploy refuses to run before the database exists', async () => {
    const h = harness();
    expect(await h.run('deploy')).toBe(1);
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_FAILED',
      message: expect.stringMatching(/has no database: run the database step/),
    });
    expect(h.built).toEqual([]);
  });

  it('rollback and status run alone against the serverless app', async () => {
    const h = harness();
    await h.run('database');
    await h.run('deploy');
    await h.run('release2');
    expect(await h.run('rollback')).toBe(0);
    expect(h.block('rollback')).toMatchObject({ app: APP, servingReleaseId: 'rel-1' });
    expect(await h.run('status')).toBe(0);
    expect(h.block('status')).toMatchObject({ app: APP, previousReleaseId: 'rel-2' });
  });
});

describe('destroy', () => {
  it('on an already-empty app prints zero usage and exits 0', async () => {
    const h = harness();
    expect(await h.run('destroy')).toBe(0);
    expect(JSON.parse(String(h.block('destroy')?.['usage']))).toEqual({
      appRef: APP,
      runningSeconds: 0,
      invocations: 0,
    });
    expect(JSON.parse(String(h.block('deleteDatabase')?.['usage']))).toEqual({
      applicationRef: APP,
      computeSeconds: 0,
      storageBytes: 0,
    });
    expect(h.calls).not.toContain('destroy');
  });

  it('exits 1 when a release is still listed afterwards', async () => {
    const h = harness({
      portOverrides: {
        listReleases: async () => [
          {
            handle: {
              target: 'serverless',
              appRef: APP,
              environment: { kind: 'production' },
              releaseId: 'rel-x',
              providerRef: 'x',
            },
            state: 'healthy',
          },
        ],
        describe: async () => ({
          state: 'healthy',
          releaseId: 'rel-x',
          previousReleaseId: null,
          upstreamAddress: null,
          originCredential: 'aws_sigv4',
        }),
        destroy: async () => ({}) as never,
      },
    });
    expect(await h.run('destroy')).toBe(1);
    expect(h.block('destroyed')).toMatchObject({ releases: 1 });
    expect(h.block('refused')).toMatchObject({
      message: expect.stringMatching(/still holds a release or a database/),
    });
  });

  it('exits 1 when the database is still listed afterwards', async () => {
    const h = harness();
    await h.run('database');
    vi.spyOn(h.databases, 'deleteDatabase').mockResolvedValue({} as never);
    expect(await h.run('destroy')).toBe(1);
    expect(h.block('destroyed')).toMatchObject({ databases: 1 });
  });
});

describe('the command line', () => {
  it('refuses a name outside the check prefix exactly as for Fly, before any port call', async () => {
    const h = harness();
    expect(await h.run('all', '--name', 'mh-tenant')).toBe(1);
    expect(h.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_NAME_REFUSED' });
    expect(h.calls).toEqual([]);
    expect(h.dbCalls).toEqual([]);
  });

  it('names the app and the database under the mh-deploy-check- prefix', () => {
    expect(serverlessCheckApp(DEPLOY_CHECK_DEFAULT_NAME)).toEqual({
      repositoryId: 'default',
      appRef: APP,
    });
    expect(serverlessCheckApp('motir-deploy-check-x').appRef).toBe('mh-deploy-check-x');
  });

  it('defaults the serverless manifest, and refuses an unknown target', () => {
    expect(parseDeployCheckArgs(['all', '--target', 'serverless']).options).toMatchObject({
      target: 'serverless',
      manifestPath: SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST,
    });
    expect(() => parseDeployCheckArgs(['all', '--target=gcp'])).toThrow(
      /--target is fly or aws or serverless/,
    );
    expect(() => parseDeployCheckArgs(['refuse'])).toThrow(
      /refuse runs with --target serverless only/,
    );
    expect(() =>
      parseDeployCheckArgs(['database', '--target', 'aws', '--repository', 'cmrepo1']),
    ).toThrow(/database runs with --target serverless only/);
  });

  it('a serverless-only step dispatched to Fly is a usage error', async () => {
    const h = harness();
    await expect(
      runDeployCheckStep('database', h.deps, {
        manifestPath: SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST,
        appName: DEPLOY_CHECK_DEFAULT_NAME,
        image: 'x',
      }),
    ).rejects.toMatchObject({ code: 'DEPLOY_CHECK_USAGE' });
  });

  it('an AWS-only step dispatched to serverless is a usage error', async () => {
    const h = harness();
    await expect(
      runDeployCheckStep('push', h.deps, {
        manifestPath: SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST,
        appName: DEPLOY_CHECK_DEFAULT_NAME,
        image: 'x',
        target: 'serverless',
      }),
    ).rejects.toThrow(/push runs with --target aws only/);
  });

  it('without the serverless dependencies the target is not configured', async () => {
    const h = harness();
    const { serverless: _unused, ...flyOnly } = h.deps;
    expect(await runDeployCheck(['status', '--target', 'serverless'], flyOnly)).toBe(1);
    expect(h.block('refused')).toMatchObject({ error: 'ORCHESTRATOR_NOT_CONFIGURED' });
  });
});

describe('the fake function URL', () => {
  it('answers 503 signed while the app has no database', async () => {
    const h = harness();
    await h.fake.ensureApp({ repositoryId: 'default', environment: { kind: 'production' } });
    const res = await fakeFunctionUrlFetch(h.fake, () => h.databases).signed(
      `https://${APP}.fake.invalid/health`,
      { headers: {} },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ database: 'unreachable' });
  });
});
