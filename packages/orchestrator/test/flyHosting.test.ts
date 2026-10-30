import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTING_RELEASE_METADATA,
  NoPreviousReleaseError,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseRuntimeRefusedError,
  createFlyHostingDeployPort,
  deriveOriginSecret,
  flyHostingConfig,
  releaseStateOf,
  type DeployReleaseInput,
  type FlyHostingConfig,
  type HostingDeployPort,
} from '../src/index';
import {
  createHostingFlySim,
  flyJson,
  type FlyCall,
  type SimMachine,
  type SimToken,
} from './contract/hostingFlySim';

// The FLY adapter of the HOSTING DEPLOY PORT on the wire (MOTIR-5773) — what each
// operation turns into on `api.machines.dev`, against an in-memory Machines API
// that keeps apps, Machines, their config versions and events
// (`contract/hostingFlySim.ts`). `fetch` is the only fake; every request is
// recorded so a test can assert the body Fly got.

const CONFIG: FlyHostingConfig = {
  token: 'hosting-token',
  org: 'motir-hosting',
  region: 'iad',
  appPrefix: 'mh-',
  guardImage: 'registry.fly.io/motir-hosting-guard@sha256:guard1',
  originSecretKey: 'origin-key',
};
const GUARD_SECRET = deriveOriginSecret('origin-key', 'mh-cmrepo1');
const RID = 'cmrepo1';
const PROD = 'mh-cmrepo1';

let calls: FlyCall[];
let apps: Map<string, SimMachine[]>;
let clock: number;
let overrides: Array<(call: FlyCall) => Response | null>;
let tokens: Map<string, SimToken[]>;

function input(over: Partial<DeployReleaseInput> = {}): DeployReleaseInput {
  return {
    appRef: PROD,
    environment: { kind: 'production' },
    artifact: { kind: 'image', ref: 'docker.io/traefik/whoami', digest: 'sha256:abc' },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
    },
    env: [{ name: 'WHOAMI_NAME', value: 'release-1', secret: false }],
    idle: { mode: 'suspend', idleSeconds: 300 },
    ...over,
  };
}

let ids: number;
function port(): HostingDeployPort {
  return createFlyHostingDeployPort(CONFIG, {
    now: () => new Date(clock),
    newReleaseId: () => `rel-${(ids += 1)}`,
  });
}

/** The named container of a written Machine config. */
function container(config: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = (config['containers'] as Array<Record<string, unknown>>).find(
    (c) => c['name'] === name,
  );
  if (!found) throw new Error(`no ${name} container`);
  return found;
}

const writes = () =>
  calls.filter((c) => c.method === 'POST' && /\/machines(\/[^/]+)?$/.test(c.path));

beforeEach(() => {
  ids = 0;
  clock = Date.parse('2026-10-28T00:00:00.000Z');
  const sim = createHostingFlySim(() => clock);
  ({ calls, apps, overrides, tokens } = sim);
  vi.stubGlobal('fetch', sim.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('flyHostingConfig', () => {
  beforeEach(() => {
    vi.stubEnv('MOTIR_HOSTING_GUARD_IMAGE', 'registry.fly.io/motir-hosting-guard@sha256:g');
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', 'k');
  });

  it('reads MOTIR_HOSTING_FLY_* with the decision’s defaults', () => {
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', 't');
    vi.stubEnv('MOTIR_HOSTING_FLY_ORG', '');
    vi.stubEnv('MOTIR_HOSTING_FLY_REGION', '');
    vi.stubEnv('MOTIR_HOSTING_FLY_APP_PREFIX', '');
    expect(flyHostingConfig()).toEqual({
      token: 't',
      org: 'motir-hosting',
      region: 'iad',
      appPrefix: 'mh-',
      guardImage: 'registry.fly.io/motir-hosting-guard@sha256:g',
      originSecretKey: 'k',
    });
    vi.stubEnv('MOTIR_HOSTING_FLY_ORG', 'o');
    vi.stubEnv('MOTIR_HOSTING_FLY_REGION', 'ams');
    vi.stubEnv('MOTIR_HOSTING_FLY_APP_PREFIX', 'motir-deploy-check-');
    expect(flyHostingConfig()).toEqual({
      token: 't',
      org: 'o',
      region: 'ams',
      appPrefix: 'motir-deploy-check-',
      guardImage: 'registry.fly.io/motir-hosting-guard@sha256:g',
      originSecretKey: 'k',
    });
  });

  it('names the token variable when it is unset', () => {
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', '');
    expect(() => flyHostingConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => flyHostingConfig()).toThrow(/MOTIR_HOSTING_FLY_API_TOKEN/);
  });

  it.each(['MOTIR_HOSTING_GUARD_IMAGE', 'MOTIR_HOSTING_ORIGIN_SECRET_KEY'])(
    'fails closed, naming %s, when the guard cannot be configured — and calls no API',
    (name) => {
      vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', 't');
      vi.stubEnv(name, ' ');
      expect(() => flyHostingConfig()).toThrow(OrchestratorNotConfiguredError);
      expect(() => flyHostingConfig()).toThrow(new RegExp(name));
      expect(calls).toEqual([]);
    },
  );
});

describe('ensureApp', () => {
  it('creates production as one app on its own network, with public addresses', async () => {
    const app = await port().ensureApp({ repositoryId: RID, environment: { kind: 'production' } });
    expect(app).toEqual({ appRef: PROD, pushNamespace: PROD });
    const creates = calls.filter((c) => c.path === '/apps' && c.method === 'POST');
    expect(creates.map((c) => c.body)).toEqual([
      { app_name: PROD, org_slug: 'motir-hosting', network: PROD },
    ]);
    expect(
      calls.filter((c) => c.path.endsWith('/ip_assignments') && c.method === 'POST'),
    ).toHaveLength(2);
    expect(calls.every((c) => c.auth === 'Bearer hosting-token')).toBe(true);
  });

  it('creates one app per preview pull request plus the shared preview image store', async () => {
    const app = await port().ensureApp({
      repositoryId: RID,
      environment: { kind: 'preview', pullRequest: 7 },
    });
    expect(app).toEqual({ appRef: 'mh-cmrepo1-pr7', pushNamespace: 'mh-cmrepo1-pv' });
    expect([...apps.keys()].sort()).toEqual(['mh-cmrepo1-pr7', 'mh-cmrepo1-pv']);
  });

  it('treats an existing app as success, created or raced', async () => {
    apps.set(PROD, []);
    await port().ensureApp({ repositoryId: RID, environment: { kind: 'production' } });
    expect(calls.filter((c) => c.path === '/apps')).toHaveLength(0);
    // A concurrent create between the read and the write: "already taken".
    overrides.push((c) =>
      c.path === '/apps/mh-cmrepo1-pr8' && c.method === 'GET' ? flyJson(404, {}) : null,
    );
    apps.set('mh-cmrepo1-pr8', []);
    await expect(
      port().ensureApp({ repositoryId: RID, environment: { kind: 'preview', pullRequest: 8 } }),
    ).resolves.toMatchObject({ appRef: 'mh-cmrepo1-pr8' });
  });
});

describe('ensurePushNamespace and revokeDeployCredentials (MOTIR-5775)', () => {
  it('creates the push namespace as an app with no Machines and no addresses, on its own network', async () => {
    const made = await port().ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    expect(made).toEqual({
      pushNamespace: 'mh-cmrepo1-pv',
      imageRepository: 'registry.fly.io/mh-cmrepo1-pv',
    });
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])).toEqual([
      [
        'POST',
        '/apps',
        { app_name: 'mh-cmrepo1-pv', org_slug: 'motir-hosting', network: 'mh-cmrepo1-pv' },
      ],
    ]);
    await expect(
      port().ensurePushNamespace({ repositoryId: RID, kind: 'production' }),
    ).resolves.toEqual({ pushNamespace: PROD, imageRepository: `registry.fly.io/${PROD}` });
  });

  it('lists the app’s tokens through GraphQL and revokes each live one, with the hosting token', async () => {
    apps.set('mh-cmrepo1-pv', []);
    tokens.set('mh-cmrepo1-pv', [
      { id: 'tok-old', revokedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'tok-a', revokedAt: null },
      { id: 'tok-b', revokedAt: null },
    ]);
    await expect(
      port().revokeDeployCredentials({ pushNamespace: 'mh-cmrepo1-pv' }),
    ).resolves.toEqual({ revoked: 2 });
    const graphql = calls.filter((c) => c.path === '/graphql');
    expect(graphql.map((c) => c.body?.['variables'])).toEqual([
      { appName: 'mh-cmrepo1-pv' },
      { input: { id: 'tok-a' } },
      { input: { id: 'tok-b' } },
    ]);
    expect(graphql.every((c) => c.auth === 'Bearer hosting-token')).toBe(true);
    expect(tokens.get('mh-cmrepo1-pv')!.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('revokes nothing for a namespace that does not exist, or one with no token list', async () => {
    await expect(port().revokeDeployCredentials({ pushNamespace: 'mh-gone-pv' })).resolves.toEqual({
      revoked: 0,
    });
    overrides.push((c) =>
      c.path === '/graphql' ? flyJson(200, { data: { app: { limitedAccessTokens: null } } }) : null,
    );
    await expect(port().revokeDeployCredentials({ pushNamespace: 'mh-x-pv' })).resolves.toEqual({
      revoked: 0,
    });
    overrides.unshift((c) => (c.path === '/graphql' ? flyJson(200, { data: null }) : null));
    await expect(port().revokeDeployCredentials({ pushNamespace: 'mh-x-pv' })).resolves.toEqual({
      revoked: 0,
    });
  });

  it('throws on a GraphQL error other than a missing app, on a refused revoke, and on a non-2xx', async () => {
    overrides.push((c) =>
      c.path === '/graphql'
        ? flyJson(200, { data: null, errors: [{ message: 'unauthorized' }, {}] })
        : null,
    );
    await expect(
      port().revokeDeployCredentials({ pushNamespace: 'mh-cmrepo1-pv' }),
    ).rejects.toThrow(/unauthorized; unknown error/);
    overrides.length = 0;
    overrides.push((c) => {
      if (c.path !== '/graphql') return null;
      return String(c.body?.['query']).includes('deleteLimitedAccessToken')
        ? flyJson(200, { data: null, errors: [{ message: 'forbidden' }] })
        : flyJson(200, {
            data: {
              app: { limitedAccessTokens: { nodes: [{ id: 'tok-1', revokedAt: null }, 'junk'] } },
            },
          });
    });
    await expect(
      port().revokeDeployCredentials({ pushNamespace: 'mh-cmrepo1-pv' }),
    ).rejects.toThrow(/forbidden/);
    overrides.unshift((c) =>
      c.path === '/graphql' ? flyJson(502, { error: 'bad gateway' }) : null,
    );
    await expect(
      port().revokeDeployCredentials({ pushNamespace: 'mh-cmrepo1-pv' }),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
  });
});

describe('mintDeployCredential', () => {
  it('mints a 90-day secret scoped to the one app it names', async () => {
    apps.set('mh-cmrepo1-pv', []);
    const credential = await port().mintDeployCredential({ pushNamespace: 'mh-cmrepo1-pv' });
    expect(credential).toEqual({
      kind: 'secret',
      pushNamespace: 'mh-cmrepo1-pv',
      value: 'fly-deploy-mh-cmrepo1-pv',
      expiresAt: new Date(clock + 90 * 86_400_000),
    });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/apps/mh-cmrepo1-pv/deploy_token', { expiry: '2160h' }],
    ]);
  });

  it('refuses a response without a token, and a refusal', async () => {
    overrides.push((c) => (c.path.endsWith('/deploy_token') ? flyJson(200, {}) : null));
    await expect(port().mintDeployCredential({ pushNamespace: PROD })).rejects.toThrow(/no token/);
    overrides.unshift((c) =>
      c.path.endsWith('/deploy_token') ? flyJson(403, { error: 'denied' }) : null,
    );
    await expect(port().mintDeployCredential({ pushNamespace: PROD })).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });
});

describe('deploy, describe, rollback', () => {
  beforeEach(() => {
    apps.set(PROD, []);
  });

  it('creates one Machine of two containers, the guard in front of the app: port, health check, digest-pinned images, idle suspend', async () => {
    const handle = await port().deploy(input());
    expect(handle).toEqual({
      target: 'fly',
      appRef: PROD,
      environment: { kind: 'production' },
      releaseId: 'rel-1',
      providerRef: 'm-1',
    });
    const create = writes()[0]!;
    expect(create.path).toBe(`/apps/${PROD}/machines`);
    expect(create.body).toMatchObject({ name: 'release', region: 'iad' });
    const config = create.body!['config'] as Record<string, unknown>;
    expect(config['containers']).toEqual([
      {
        name: 'guard',
        image: 'registry.fly.io/motir-hosting-guard@sha256:guard1',
        env: { MOTIR_GUARD_ORIGIN_SECRET: GUARD_SECRET, MOTIR_GUARD_APP_PORT: '8080' },
      },
      {
        name: 'app',
        image: 'docker.io/traefik/whoami@sha256:abc',
        exec: ['/whoami'],
        env: { WHOAMI_NAME: 'release-1' },
      },
    ]);
    // Each container runs its own image; nothing runs at the Machine level.
    expect(config).not.toHaveProperty('image');
    expect(config).not.toHaveProperty('init');
    expect(config).not.toHaveProperty('env');
    // One service, on the GUARD's port — the app's port is never a service.
    expect(config['services']).toHaveLength(1);
    expect(config).toMatchObject({
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      services: [
        {
          protocol: 'tcp',
          internal_port: 9180,
          autostop: 'suspend',
          autostart: true,
          min_machines_running: 0,
        },
      ],
      checks: { health: { type: 'http', port: 8080, path: '/health', method: 'GET' } },
      metadata: {
        motir_hosting: 'release',
        motir_release_id: 'rel-1',
        motir_environment: 'production',
      },
    });
    expect(config).not.toHaveProperty('auto_destroy');
  });

  it('derives each app’s own secret, never the key itself', async () => {
    apps.set('mh-cmrepo1-pr7', []);
    await port().deploy(
      input({ appRef: 'mh-cmrepo1-pr7', environment: { kind: 'preview', pullRequest: 7 } }),
    );
    const guard = container(writes()[0]!.body!['config'] as Record<string, unknown>, 'guard');
    const secret = (guard['env'] as Record<string, string>)['MOTIR_GUARD_ORIGIN_SECRET'];
    expect(secret).toBe(deriveOriginSecret('origin-key', 'mh-cmrepo1-pr7'));
    expect(secret).not.toBe(GUARD_SECRET);
    expect(JSON.stringify(calls)).not.toContain('origin-key');
  });

  it('refuses a release on the guard’s port by name, before any API call', async () => {
    const refusal = port().deploy(input({ runtime: { ...input().runtime, port: 9180 } }));
    await expect(refusal).rejects.toBeInstanceOf(ReleaseRuntimeRefusedError);
    await expect(refusal).rejects.toMatchObject({ field: 'port' });
    expect(writes()).toEqual([]);
  });

  it('keeps an always-on release running and sizes production from the row', async () => {
    await port().deploy(
      input({
        idle: { mode: 'always_on' },
        size: 'large',
        artifact: { kind: 'image', ref: 'img:1' },
      }),
    );
    const config = writes()[0]!.body!['config'] as Record<string, unknown>;
    const service = (config['services'] as Array<Record<string, unknown>>)[0]!;
    expect(service).toMatchObject({ autostop: 'off', min_machines_running: 1 });
    expect(config).toMatchObject({ guest: { cpus: 4, memory_mb: 4096 } });
    expect(container(config, 'app')['image']).toBe('img:1');
  });

  it('runs a preview at the preview size and records its pull request', async () => {
    apps.set('mh-cmrepo1-pr7', []);
    const handle = await port().deploy(
      input({
        appRef: 'mh-cmrepo1-pr7',
        environment: { kind: 'preview', pullRequest: 7 },
        size: 'large',
      }),
    );
    const config = writes()[0]!.body!['config'] as Record<string, unknown>;
    expect(config).toMatchObject({
      guest: { memory_mb: 512 },
      metadata: { motir_environment: 'pr-7' },
    });
    const [listed] = await port().listReleases({ appRef: 'mh-cmrepo1-pr7' });
    expect(listed!.handle).toEqual(handle);
  });

  it('refuses a bundle artifact', async () => {
    await expect(
      port().deploy(input({ artifact: { kind: 'bundle', ref: 's3://x' } })),
    ).rejects.toBeInstanceOf(ReleaseArtifactUnsupportedError);
  });

  it('a second deploy updates the one Machine in place and keeps the first as previous', async () => {
    const p = port();
    await p.deploy(input());
    const second = await p.deploy(
      input({ env: [{ name: 'WHOAMI_NAME', value: 'release-2', secret: false }] }),
    );
    expect(writes().map((c) => c.path)).toEqual([
      `/apps/${PROD}/machines`,
      `/apps/${PROD}/machines/m-1`,
    ]);
    expect(writes()[1]!.body).toMatchObject({ current_version: 'v1' });
    expect(apps.get(PROD)).toHaveLength(1);
    expect(await p.describe(second)).toEqual({
      state: 'healthy',
      releaseId: 'rel-2',
      previousReleaseId: 'rel-1',
      upstreamAddress: `https://${PROD}.fly.dev`,
      originCredential: 'origin_secret',
    });
  });

  it('rollback restores the previous release’s whole config, then swaps back', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(
      input({
        env: [{ name: 'WHOAMI_NAME', value: 'release-2', secret: false }],
        artifact: { kind: 'image', ref: 'img:2' },
      }),
    );
    const back = await p.rollback({ appRef: PROD, environment: { kind: 'production' } });
    expect(back).toMatchObject({ releaseId: 'rel-1', providerRef: 'm-1' });
    const live = apps.get(PROD)![0]!.config;
    expect(container(live, 'app')).toMatchObject({
      image: 'docker.io/traefik/whoami@sha256:abc',
      env: { WHOAMI_NAME: 'release-1' },
    });
    // Restored WITH its guard: still two containers, still only the guard's port.
    expect(container(live, 'guard')).toEqual(
      container(writes()[0]!.body!['config'] as Record<string, unknown>, 'guard'),
    );
    expect(live).toMatchObject({
      services: [{ internal_port: 9180 }],
      metadata: {
        [HOSTING_RELEASE_METADATA.releaseId]: 'rel-1',
        [HOSTING_RELEASE_METADATA.previousReleaseId]: 'rel-2',
      },
    });
    expect(await p.describe(back)).toMatchObject({
      releaseId: 'rel-1',
      previousReleaseId: 'rel-2',
    });
    expect(apps.get(PROD)).toHaveLength(1);
  });

  it('rollback runs the kept app under TODAY’s guard: a new guard image and a rotated key apply', async () => {
    await port().deploy(input());
    await port().deploy(input({ artifact: { kind: 'image', ref: 'img:2' } }));
    const rotated = createFlyHostingDeployPort(
      {
        ...CONFIG,
        guardImage: 'registry.fly.io/motir-hosting-guard@sha256:guard2',
        originSecretKey: 'rotated',
      },
      { now: () => new Date(clock), newReleaseId: () => `rel-${(ids += 1)}` },
    );
    await rotated.rollback({ appRef: PROD, environment: { kind: 'production' } });
    const live = apps.get(PROD)![0]!.config;
    expect(container(live, 'guard')).toEqual({
      name: 'guard',
      image: 'registry.fly.io/motir-hosting-guard@sha256:guard2',
      env: {
        MOTIR_GUARD_ORIGIN_SECRET: deriveOriginSecret('rotated', PROD),
        MOTIR_GUARD_APP_PORT: '8080',
      },
    });
    expect(container(live, 'app')['image']).toBe('docker.io/traefik/whoami@sha256:abc');
  });

  it('rollback refuses a kept version with no guarded app rather than restore it unguarded', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input());
    // A version written before the guard: one image, no containers.
    const machine = apps.get(PROD)![0]!;
    const first = machine.versions[0]!.user_config;
    machine.versions[0]!.user_config = { image: 'old', metadata: first['metadata'] };
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    // Containers, but a guard that names no app port.
    machine.versions[0]!.user_config = {
      ...first,
      containers: [
        { name: 'guard', env: {} },
        { name: 'app', image: 'x' },
      ],
    };
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
  });

  it('rollback with no previous release, or no release, is refused by type', async () => {
    const p = port();
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(ReleaseNotFoundError);
    await p.deploy(input());
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    // A previous release Fly no longer keeps a version of.
    await p.deploy(input());
    apps.get(PROD)![0]!.versions = [];
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
  });

  it('surfaces a refused write and a refused versions read', async () => {
    overrides.push((c) =>
      c.method === 'POST' && c.path.endsWith('/machines')
        ? flyJson(422, { error: 'bad config' })
        : null,
    );
    await expect(port().deploy(input())).rejects.toThrow(/bad config/);
    overrides.length = 0;
    const p = port();
    await p.deploy(input());
    await p.deploy(input());
    overrides.push((c) => (c.path.endsWith('/versions') ? flyJson(500, { error: 'boom' }) : null));
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
    overrides.length = 0;
    overrides.push((c) =>
      c.method === 'POST' && c.path.endsWith('/m-1') ? flyJson(200, { nope: true }) : null,
    );
    await expect(p.deploy(input())).rejects.toThrow(/unexpected shape/);
  });
});

describe('usage and destroy', () => {
  beforeEach(() => {
    apps.set(PROD, []);
  });

  it('usageSince counts running time only, from the Machine’s events', async () => {
    const p = port();
    const handle = await p.deploy(input());
    const m = apps.get(PROD)![0]!;
    const start = clock;
    m.events = [
      { type: 'start', status: 'started', timestamp: start },
      { type: 'suspend', status: 'suspended', timestamp: start + 60_000 },
      { type: 'start', status: 'started', timestamp: start + 600_000 },
    ];
    clock = start + 660_000;
    const usage = await p.usageSince(handle, new Date(start));
    expect(usage).toMatchObject({
      target: 'fly',
      appRef: PROD,
      releaseId: 'rel-1',
      runningSeconds: 120,
    });
  });

  it('destroy returns the whole life’s usage and destroys the Machine; a gone one is destroyed', async () => {
    const p = port();
    const handle = await p.deploy(input());
    clock += 30_000;
    const usage = await p.destroy(handle, 'operator');
    expect(usage.runningSeconds).toBe(30);
    expect(usage.since).toEqual(new Date('2026-10-28T00:00:00.000Z'));
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.path === `/apps/${PROD}/machines/m-1?force=true`,
      ),
    ).toBe(true);
    expect(await p.describe(handle)).toMatchObject({
      state: 'destroyed',
      releaseId: null,
      upstreamAddress: null,
    });
    expect(await p.destroy(handle, 'operator')).toMatchObject({ runningSeconds: 0 });
    expect(await p.usageSince(handle, new Date(0))).toMatchObject({ runningSeconds: 0 });
  });

  it('describe reports a Machine Fly shows as destroyed as destroyed', async () => {
    const p = port();
    const handle = await p.deploy(input());
    apps.get(PROD)![0]!.state = 'destroyed';
    expect((await p.describe(handle)).state).toBe('destroyed');
  });

  it('a refused machine read surfaces', async () => {
    const p = port();
    const handle = await p.deploy(input());
    overrides.push((c) =>
      c.method === 'GET' && c.path.endsWith('/m-1') ? flyJson(500, { error: 'boom' }) : null,
    );
    await expect(p.describe(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('destroyApp deletes the app, treats a gone one as done, and surfaces a refusal', async () => {
    const p = port();
    await p.destroyApp({ appRef: PROD });
    expect(apps.has(PROD)).toBe(false);
    await p.destroyApp({ appRef: PROD });
    overrides.push((c) => (c.method === 'DELETE' ? flyJson(403, { error: 'denied' }) : null));
    await expect(p.destroyApp({ appRef: PROD })).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('destroyApp settles the live release’s usage before the app goes', async () => {
    const p = port();
    apps.set(PROD, []);
    await p.deploy(input());
    clock += 45_000;
    const usage = await p.destroyApp({ appRef: PROD });
    expect(usage).toEqual([expect.objectContaining({ appRef: PROD, runningSeconds: 45 })]);
    expect(apps.has(PROD)).toBe(false);
    expect(await p.listReleases({ appRef: PROD })).toEqual([]);
  });

  it('a listing Fly refuses for any reason but a gone app surfaces', async () => {
    const p = port();
    apps.set(PROD, []);
    overrides.push((c) => (c.method === 'GET' ? flyJson(500, { error: 'boom' }) : null));
    await expect(p.listReleases({ appRef: PROD })).rejects.toBeInstanceOf(OrchestratorApiError);
  });
});

describe('sparse provider bodies', () => {
  beforeEach(() => {
    apps.set(PROD, []);
  });

  it('reads a machine with no version, odd checks, undated and non-run events, and no metadata', async () => {
    const p = port();
    const handle = await p.deploy(input());
    const sparse = {
      id: 'm-1',
      state: 'started',
      region: 'iad',
      created_at: '2026-10-28T00:00:00.000Z',
      config: { metadata: { motir_hosting: 'release', motir_previous_release_id: 'rel-0' } },
      checks: [{ name: 'health' }, 'garbage'],
      events: [
        { type: 'launch', status: 'created', timestamp: clock },
        { type: 'start', status: 'started' },
        { type: 'update', status: 'updated', timestamp: clock },
      ],
    };
    overrides.push((c) =>
      c.method === 'GET' && /\/machines(\/m-1)?$/.test(c.path)
        ? flyJson(200, c.path.endsWith('/machines') ? [sparse] : sparse)
        : null,
    );
    overrides.push((c) => (c.path.endsWith('/versions') ? flyJson(200, { not: 'a list' }) : null));
    expect(await p.describe(handle)).toMatchObject({
      state: 'deploying',
      releaseId: null,
      previousReleaseId: 'rel-0',
    });
    clock += 10_000;
    expect((await p.usageSince(handle, new Date(clock - 10_000))).runningSeconds).toBe(0);
    const [listed] = await p.listReleases({ appRef: PROD });
    expect(listed!.handle).toMatchObject({ releaseId: '', environment: { kind: 'production' } });
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    // An update with no version to guard on goes out unguarded.
    await p.deploy(input());
    expect(writes().at(-1)!.body).not.toHaveProperty('current_version');
  });

  it('treats a machine body it cannot parse as gone', async () => {
    const p = port();
    const handle = await p.deploy(input());
    overrides.push((c) =>
      c.method === 'GET' && c.path.endsWith('/m-1') ? flyJson(200, { no: 'id' }) : null,
    );
    expect((await p.describe(handle)).state).toBe('destroyed');
  });

  it('defaults its clock and release ids', async () => {
    const p = createFlyHostingDeployPort(CONFIG);
    const handle = await p.deploy(input());
    expect(handle.releaseId).toMatch(/^rel-[a-z0-9]+-[a-z0-9]+$/);
    expect((await p.usageSince(handle, new Date(Date.now() + 60_000))).runningSeconds).toBe(0);
  });
});

describe('releaseStateOf', () => {
  it.each([
    ['started', ['passing'], 'healthy'],
    ['started', ['passing', 'critical'], 'unhealthy'],
    ['started', [], 'deploying'],
    ['started', ['warning'], 'deploying'],
    ['created', [], 'deploying'],
    ['replacing', [], 'deploying'],
    ['stopped', [], 'stopped'],
    ['suspended', [], 'stopped'],
    ['stopping', [], 'stopped'],
    ['destroying', [], 'destroyed'],
    ['destroyed', [], 'destroyed'],
  ])('%s with checks %j is %s', (state, checks, expected) => {
    expect(releaseStateOf(state, checks)).toBe(expected);
  });
});

describe('runReleaseCommand (MOTIR-10030)', () => {
  const command = {
    appRef: PROD,
    artifact: { kind: 'image' as const, ref: 'registry.fly.io/mh-cmrepo1', digest: 'sha256:abc' },
    command: 'node migrate/node_modules/prisma/build/index.js migrate deploy',
    env: [{ name: 'DATABASE_URL', value: 'postgresql://u:p@db/app', secret: true }],
    timeoutSeconds: 120,
  };

  beforeEach(() => {
    apps.set(PROD, []);
  });

  it('runs one never-restarted Machine of the image with no service, reads its exit status and destroys it', async () => {
    expect(await port().runReleaseCommand(command)).toEqual({ exitCode: 0, timedOut: false });

    const create = calls.find((c) => c.method === 'POST' && c.path === `/apps/${PROD}/machines`)!;
    const config = create.body!['config'] as Record<string, unknown>;
    expect(config).toMatchObject({
      image: 'registry.fly.io/mh-cmrepo1@sha256:abc',
      init: { exec: ['node', 'migrate/node_modules/prisma/build/index.js', 'migrate', 'deploy'] },
      env: { DATABASE_URL: 'postgresql://u:p@db/app' },
      restart: { policy: 'no' },
      metadata: { [HOSTING_RELEASE_METADATA.marker]: 'command' },
    });
    expect(config['services']).toBeUndefined();
    expect(
      calls.some((c) => c.method === 'GET' && /\/wait\?state=stopped&timeout=60$/.test(c.path)),
    ).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/apps/${PROD}/machines/m-1?force=true`,
    });
    expect(await port().listReleases({ appRef: PROD })).toEqual([]);
  });

  it('reports a non-zero exit', async () => {
    overrides.push((c) => {
      if (!c.path.includes('/wait')) return null;
      const m = apps.get(PROD)![0]!;
      m.state = 'stopped';
      m.events.push({
        type: 'exit',
        status: 'stopped',
        timestamp: clock,
        request: { exit_event: { exit_code: 2 } },
      });
      return flyJson(200, { ok: true });
    });
    expect(await port().runReleaseCommand(command)).toEqual({ exitCode: 2, timedOut: false });
  });

  it('keeps waiting while Fly answers 408, then times out and destroys the Machine', async () => {
    overrides.push((c) => {
      if (!c.path.includes('/wait')) return null;
      clock += 60_000;
      return flyJson(408, { error: 'deadline_exceeded' });
    });
    expect(await port().runReleaseCommand(command)).toEqual({ exitCode: null, timedOut: true });
    expect(calls.filter((c) => c.path.includes('/wait'))).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/apps/${PROD}/machines/m-1?force=true`,
    });
  });

  it('throws the typed error for a refused create, and for a failed wait after destroying the Machine', async () => {
    overrides.push((c) =>
      c.method === 'POST' && c.path === `/apps/${PROD}/machines`
        ? flyJson(422, { error: 'bad image' })
        : null,
    );
    await expect(port().runReleaseCommand(command)).rejects.toMatchObject({ status: 422 });
    overrides.length = 0;
    overrides.push((c) =>
      c.method === 'POST' && c.path === `/apps/${PROD}/machines`
        ? flyJson(200, { odd: true })
        : null,
    );
    await expect(port().runReleaseCommand(command)).rejects.toBeInstanceOf(OrchestratorApiError);
    overrides.length = 0;
    overrides.push((c) => (c.path.includes('/wait') ? flyJson(500, { error: 'boom' }) : null));
    await expect(port().runReleaseCommand(command)).rejects.toMatchObject({ status: 500 });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('reports no exit status for a Machine gone before it is read', async () => {
    overrides.push((c) =>
      c.method === 'GET' && /\/machines\/m-1$/.test(c.path)
        ? flyJson(404, { error: 'gone' })
        : null,
    );
    expect(await port().runReleaseCommand(command)).toEqual({ exitCode: null, timedOut: false });
  });

  it('refuses a bundle artifact', async () => {
    await expect(
      port().runReleaseCommand({ ...command, artifact: { kind: 'bundle', ref: 'x' } }),
    ).rejects.toBeInstanceOf(ReleaseArtifactUnsupportedError);
  });
});
