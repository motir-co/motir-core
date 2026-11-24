import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTING_RELEASE_METADATA,
  NoPreviousReleaseError,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseRuntimeRefusedError,
  FLY_LOG_DEFAULT_WINDOW_MS,
  FLY_LOG_MAX_REQUESTS,
  LogsUnavailableError,
  RuntimeHealthUnavailableError,
  createFlyHostingDeployPort,
  deriveOriginSecret,
  exitCodeOf,
  flyLogInstantNs,
  readFlyLogWindow,
  type FlyLogEntry,
  runtimeHealthOf,
  toFlyLogPage,
  toFlyMachine,
  flyHostingConfig,
  releaseStateOf,
  type DeployReleaseInput,
  type FlyHostingConfig,
  type HostingDeployPort,
} from '../src/index';
import {
  createHostingFlySim,
  flyJson,
  flyLogTimestamp,
  type SimLogEntry,
  type FlyCall,
  type HostingFlySim,
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
let release: HostingFlySim['release'];
let sleeps: number[];
let logs: Map<string, SimLogEntry[]>;
let logPage: HostingFlySim['logPage'];

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
    sleep: async (ms) => {
      sleeps.push(ms);
    },
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
  sleeps = [];
  clock = Date.parse('2026-10-28T00:00:00.000Z');
  const sim = createHostingFlySim(() => clock);
  ({ calls, apps, overrides, tokens, release, logs, logPage } = sim);
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
        cmd: ['/whoami'],
        env: { WHOAMI_NAME: 'release-1' },
      },
    ]);
    // MOTIR-11956: the start argv rides `cmd`, the field Fly runs. `exec` is
    // stored but never run, and an `entrypoint` would drop the image's own.
    const app = container(config, 'app');
    expect(app).not.toHaveProperty('exec');
    expect(app).not.toHaveProperty('entrypoint');
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

  it('the fake refuses a write while an update is in flight — the 409 a caller that does not wait meets', async () => {
    await port().deploy(input());
    apps.get(PROD)![0]!.state = 'replacing';
    const res = await fetch(`https://api.machines.dev/v1/apps/${PROD}/machines/m-1`, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ config: {} }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'aborted: machine is replacing: concurrent update in progress',
    });
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

  it('rollback moves a kept pre-MOTIR-11956 `exec` argv into `cmd`, so the restored release runs its command', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input({ artifact: { kind: 'image', ref: 'img:2' } }));
    // The first version as the adapter wrote it before the fix: argv in `exec`.
    const machine = apps.get(PROD)![0]!;
    const first = machine.versions[0]!.user_config;
    const legacy = (first['containers'] as Array<Record<string, unknown>>).map((c) => {
      if (c['name'] !== 'app') return c;
      const { cmd, ...rest } = c;
      return { ...rest, exec: cmd };
    });
    machine.versions[0]!.user_config = { ...first, containers: legacy };
    await p.rollback({ appRef: PROD, environment: { kind: 'production' } });
    const app = container(apps.get(PROD)![0]!.config, 'app');
    expect(app['cmd']).toEqual(['/whoami']);
    expect(app).not.toHaveProperty('exec');
  });

  it('rollback keeps a kept version’s own `cmd` and drops a stray `exec` beside it', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input());
    const machine = apps.get(PROD)![0]!;
    const first = machine.versions[0]!.user_config;
    const both = (first['containers'] as Array<Record<string, unknown>>).map((c) =>
      c['name'] === 'app' ? { ...c, exec: ['/ignored'] } : c,
    );
    machine.versions[0]!.user_config = { ...first, containers: both };
    await p.rollback({ appRef: PROD, environment: { kind: 'production' } });
    const app = container(apps.get(PROD)![0]!.config, 'app');
    expect(app['cmd']).toEqual(['/whoami']);
    expect(app).not.toHaveProperty('exec');
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

// MOTIR-11250: Fly applies a Machine create or update asynchronously, and refuses
// any other write to the Machine until it has — `409 aborted: machine is
// replacing: concurrent update in progress`. The sim holds a written release
// Machine `created` / `replacing` until a `/wait` settles it, so a port that
// returned on Fly's acceptance would meet that 409 on its very next write.
describe('a release write settles before deploy and rollback return (MOTIR-11250)', () => {
  const waits = () => calls.filter((c) => /\/machines\/[^/]+\/wait\?/.test(c.path));
  const machine = () => apps.get(PROD)![0]!;

  beforeEach(() => {
    apps.set(PROD, []);
  });

  it('two back-to-back deploys to the same app both succeed, each waiting for its own instance to start', async () => {
    const p = port();
    const first = await p.deploy(input());
    expect(machine().state).toBe('started');
    const second = await p.deploy(
      input({ env: [{ name: 'WHOAMI_NAME', value: 'release-2', secret: false }] }),
    );
    expect([first.releaseId, second.releaseId]).toEqual(['rel-1', 'rel-2']);
    expect(waits().map((c) => c.path)).toEqual([
      `/apps/${PROD}/machines/m-1/wait?state=started&timeout=10&instance_id=v1`,
      `/apps/${PROD}/machines/m-1/wait?state=started&timeout=10&instance_id=v2`,
    ]);
    expect(machine()).toMatchObject({ state: 'started', version: 'v2' });
    expect(await p.describe(second)).toMatchObject({ state: 'healthy', releaseId: 'rel-2' });
    expect(sleeps).toEqual([]);
  });

  it('a rollback straight after a release succeeds, and a redeploy straight after the rollback', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input({ artifact: { kind: 'image', ref: 'img:2' } }));
    const back = await p.rollback({ appRef: PROD, environment: { kind: 'production' } });
    expect(back.releaseId).toBe('rel-1');
    expect(waits().at(-1)!.path).toBe(
      `/apps/${PROD}/machines/m-1/wait?state=started&timeout=10&instance_id=v3`,
    );
    expect(machine().state).toBe('started');
    await expect(p.deploy(input())).resolves.toMatchObject({ releaseId: 'rel-3' });
  });

  it('keeps waiting across windows that pass with the update still applying, reading the Machine between them', async () => {
    release.stallWaits = 2;
    await port().deploy(input());
    expect(waits()).toHaveLength(3);
    // Each window that ended without `started` is followed by a read of the Machine.
    const after = (i: number) => calls[calls.indexOf(waits()[i]!) + 1]!;
    expect([after(0), after(1)].map((c) => [c.method, c.path])).toEqual([
      ['GET', `/apps/${PROD}/machines/m-1`],
      ['GET', `/apps/${PROD}/machines/m-1`],
    ]);
    expect(machine().state).toBe('started');
  });

  it('returns when the update settles STOPPED rather than started, and describe reads it stopped — never deploying', async () => {
    const p = port();
    await p.deploy(input());
    release.settleState = 'stopped';
    const handle = await p.deploy(input());
    expect(machine()).toMatchObject({ state: 'stopped', version: 'v2' });
    expect((await p.describe(handle)).state).toBe('stopped');
    release.settleState = 'suspended';
    await expect(p.deploy(input())).resolves.toMatchObject({ releaseId: 'rel-3' });
  });

  it('a settled idle Machine at an OLDER instance is not the write settling', async () => {
    await port().deploy(input());
    const m = machine();
    // The write is acknowledged, but the Machine reads stopped at the old version.
    overrides.push((call) => {
      if (call.method === 'POST' && call.path === `/apps/${PROD}/machines/m-1`) {
        return flyJson(200, { id: 'm-1', state: 'replacing', instance_id: 'v9', config: {} });
      }
      if (call.path.includes('/wait?')) return flyJson(408, { error: 'deadline_exceeded' });
      return null;
    });
    m.state = 'stopped';
    await expect(port().deploy(input())).rejects.toMatchObject({
      status: 408,
      message: expect.stringContaining('did not finish applying its update within 300 s'),
    });
    expect(waits().filter((c) => c.path.includes('instance_id=v9'))).toHaveLength(30);
  });

  it('waits on the state alone when Fly’s answer names no instance', async () => {
    overrides.push((call) =>
      call.method === 'POST' && call.path === `/apps/${PROD}/machines`
        ? flyJson(200, { id: 'm-x', state: 'created', config: {} })
        : null,
    );
    apps.get(PROD)!.push({
      id: 'm-x',
      state: 'created',
      version: 'v1',
      config: {},
      versions: [],
      events: [],
      checks: [],
    });
    release.settleState = 'stopped';
    await expect(port().deploy(input())).resolves.toMatchObject({ providerRef: 'm-x' });
    expect(waits().map((c) => c.path)).toEqual([
      `/apps/${PROD}/machines/m-x/wait?state=started&timeout=10`,
    ]);
  });

  it('gives up with a bounded wait: 300 s for a deploy, 60 s for a rollback', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input({ artifact: { kind: 'image', ref: 'img:2' } }));
    const before = waits().length;
    release.stallWaits = Number.POSITIVE_INFINITY;
    await expect(p.rollback({ appRef: PROD, environment: { kind: 'production' } })).rejects.toThrow(
      'The fly orchestrator refused a call (HTTP 408: release Machine m-1 did not finish applying its update within 60 s).',
    );
    expect(waits().length - before).toBe(6);
  });

  it('retries a write Fly refuses because an earlier update is still applying, with doubling pauses', async () => {
    const p = port();
    await p.deploy(input());
    machine().state = 'replacing';
    let refusals = 0;
    overrides.push((call) => {
      if (call.method === 'POST' && call.path === `/apps/${PROD}/machines/m-1`) {
        refusals += 1;
        // The earlier update finishes after the second refusal.
        if (refusals === 3) machine().state = 'started';
      }
      return null;
    });
    await expect(p.deploy(input())).resolves.toMatchObject({ releaseId: 'rel-2' });
    expect(sleeps).toEqual([1000, 2000]);
    expect(machine()).toMatchObject({ state: 'started', version: 'v2' });
  });

  it('stops retrying once the budget is spent, and throws Fly’s refusal', async () => {
    const p = port();
    await p.deploy(input());
    await p.deploy(input({ artifact: { kind: 'image', ref: 'img:2' } }));
    machine().state = 'replacing';
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('machine is replacing'),
    });
    expect(sleeps).toEqual([1, 2, 4, 8, 8, 8, 8, 8, 8, 5].map((s) => s * 1000));
  });

  it('does not retry any other 409 — a version mismatch is a real conflict', async () => {
    const p = port();
    await p.deploy(input());
    overrides.push((call) =>
      call.method === 'POST' && call.path === `/apps/${PROD}/machines/m-1`
        ? flyJson(409, { error: 'version mismatch' })
        : null,
    );
    await expect(p.deploy(input())).rejects.toMatchObject({ status: 409 });
    expect(sleeps).toEqual([]);
  });

  it('a refused wait throws Fly’s refusal unless the Machine has settled at the written instance', async () => {
    const p = port();
    await p.deploy(input());
    overrides.push((call) =>
      call.path.includes('/wait?') ? flyJson(500, { error: 'internal' }) : null,
    );
    await expect(p.deploy(input())).rejects.toMatchObject({ status: 500 });
    // That update has since applied. Fly then refuses to wait on a Machine that
    // has already stopped at the new instance.
    machine().state = 'started';
    overrides.unshift((call) => {
      if (!call.path.includes('/wait?')) return null;
      machine().state = 'stopped';
      return flyJson(400, { error: 'machine is stopped' });
    });
    await expect(p.deploy(input())).resolves.toMatchObject({ releaseId: 'rel-3' });
  });

  it('throws when the Machine is destroyed while its update applies', async () => {
    const p = port();
    await p.deploy(input());
    overrides.push((call) => {
      if (!call.path.includes('/wait?')) return null;
      apps.set(PROD, []);
      return flyJson(408, { error: 'deadline_exceeded' });
    });
    await expect(p.deploy(input())).rejects.toThrow(
      'release Machine m-1 was destroyed while its update applied',
    );
    apps.set(PROD, [
      {
        id: 'm-1',
        state: 'destroyed',
        version: 'v1',
        config: {},
        versions: [],
        events: [],
        checks: [],
      },
    ]);
    overrides.length = 0;
    overrides.push((call) =>
      call.path.includes('/wait?')
        ? flyJson(408, { error: 'deadline_exceeded' })
        : call.method === 'POST'
          ? flyJson(200, { id: 'm-1', state: 'replacing', instance_id: 'v2', config: {} })
          : null,
    );
    await expect(p.deploy(input())).rejects.toMatchObject({ status: 404 });
  });
});

// ── The runtime reads (MOTIR-12102) ─────────────────────────────────────────

/** A release app with one started release Machine, as a deploy leaves it. */
async function deployed(): Promise<{
  p: HostingDeployPort;
  handle: Awaited<ReturnType<HostingDeployPort['deploy']>>;
}> {
  const p = port();
  await p.ensureApp({ repositoryId: RID, environment: { kind: 'production' } });
  const handle = await p.deploy(input());
  return { p, handle };
}

const MIN = 60_000;
let logSeq: number;
/** Append a line to the app's recorded stream. */
function logAt(ms: number, message: string, provider = 'app', extraNs = 0): void {
  logSeq += 1;
  const list = logs.get(PROD) ?? [];
  list.push({ id: `l${logSeq}`, timestamp: flyLogTimestamp(ms, extraNs), message, provider });
  logs.set(PROD, list);
}
const logCalls = () => calls.filter((c) => c.path.startsWith('/api/v1/apps/'));

describe('readLogs (MOTIR-12102)', () => {
  beforeEach(() => {
    logSeq = 0;
  });

  it('reads the app’s lines newest first, with both streams, through Fly’s logs API', async () => {
    const { p, handle } = await deployed();
    const t0 = clock;
    clock = t0 + 10 * MIN;
    logAt(t0 + 1 * MIN, 'booting', 'runner');
    logAt(t0 + 2 * MIN, 'listening on 8080');
    logAt(t0 + 3 * MIN, 'GET / 200');

    const page = await p.readLogs(handle, { limit: 10 });

    expect(page).toEqual({
      lines: [
        { at: new Date(t0 + 3 * MIN), stream: 'app', message: 'GET / 200' },
        { at: new Date(t0 + 2 * MIN), stream: 'app', message: 'listening on 8080' },
        { at: new Date(t0 + 1 * MIN), stream: 'platform', message: 'booting' },
      ],
      cursor: null,
    });
    const first = logCalls()[0]!;
    expect(first.method).toBe('GET');
    expect(first.auth).toBe('Bearer hosting-token');
    expect(first.path).toMatch(/^\/api\/v1\/apps\/mh-cmrepo1\/logs\?next_token=\d+$/);
    expect(logCalls().every((c) => !c.path.includes('instance'))).toBe(true);
  });

  it('honours since, until and the filter, passing since as a nanosecond next_token', async () => {
    const { p, handle } = await deployed();
    const t0 = clock;
    clock = t0 + 60 * MIN;
    logAt(t0 + 1 * MIN, 'ERROR before the window');
    logAt(t0 + 10 * MIN, 'error at since');
    logAt(t0 + 20 * MIN, 'fine');
    logAt(t0 + 30 * MIN, 'Error inside');
    logAt(t0 + 40 * MIN, 'error at until');
    logAt(t0 + 50 * MIN, 'error after the window');

    const since = new Date(t0 + 10 * MIN);
    const page = await p.readLogs(handle, {
      since,
      until: new Date(t0 + 40 * MIN),
      filter: 'ERROR',
      limit: 10,
    });

    expect(page.lines.map((l) => l.message)).toEqual([
      'error at until',
      'Error inside',
      'error at since',
    ]);
    expect(page.cursor).toBeNull();
    // The oldest slice reaches `since`: its token is one nanosecond before it.
    const tokens = logCalls().map((c) =>
      new URLSearchParams(c.path.split('?')[1]).get('next_token'),
    );
    expect(tokens).toContain(String(BigInt(since.getTime()) * 1_000_000n - 1n));
  });

  it('pages to older lines with the cursor, across Fly pages and lines in one instant', async () => {
    const { p, handle } = await deployed();
    const t0 = clock;
    clock = t0 + 60 * MIN;
    logPage.size = 3;
    for (let i = 0; i < 12; i += 1) logAt(t0 + i * MIN, `line ${i}`);
    // Three lines in one nanosecond-identical instant straddle a page edge.
    for (const n of ['a', 'b', 'c']) logAt(t0 + 30 * MIN, `same ${n}`, 'app', 5);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 10; round += 1) {
      const page = await p.readLogs(handle, { limit: 4, ...(cursor ? { cursor } : {}) });
      seen.push(...page.lines.map((l) => l.message));
      if (!page.cursor) break;
      cursor = page.cursor;
    }

    expect(seen).toEqual([
      'same c',
      'same b',
      'same a',
      ...Array.from({ length: 12 }, (_, i) => `line ${11 - i}`),
    ]);
  });

  it('reads a burst’s newest lines when a slice overflows its pages, and the window by default', async () => {
    const { p, handle } = await deployed();
    const t0 = clock;
    clock = t0 + 4 * MIN;
    logPage.size = 2;
    // 60 lines in the newest five minutes: more than one slice's ten pages.
    for (let i = 0; i < 60; i += 1) logAt(t0 + i * 3000, `burst ${i}`);
    logAt(clock - FLY_LOG_DEFAULT_WINDOW_MS - MIN, 'older than the default window');

    const page = await p.readLogs(handle, { limit: 3 });

    expect(page.lines.map((l) => l.message)).toEqual(['burst 59', 'burst 58', 'burst 57']);
    expect(page.cursor).not.toBeNull();
  });

  it('answers what it has and a cursor to the rest once its request budget is spent', async () => {
    const { p, handle } = await deployed();
    const t0 = clock;
    clock = t0 + 24 * 60 * MIN;
    logPage.size = 1;
    for (let i = 0; i < 300; i += 1) logAt(clock - i * 10_000, `tick ${i}`);

    const page = await p.readLogs(handle, { limit: 500 });

    expect(logCalls()).toHaveLength(FLY_LOG_MAX_REQUESTS);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines.length).toBeLessThan(300);
    expect(page.lines[0]!.message).toBe('tick 0');
    expect(page.cursor).not.toBeNull();
    calls.length = 0;
    const next = await p.readLogs(handle, { limit: 500, cursor: page.cursor! });
    const oldest = page.lines[page.lines.length - 1]!.at.getTime();
    expect(next.lines.every((l) => l.at.getTime() < oldest)).toBe(true);
  });

  it('answers an empty page when nothing in the window matches', async () => {
    const { p, handle } = await deployed();
    logAt(clock - MIN, 'hello');
    expect(await p.readLogs(handle, { limit: 5, filter: 'nope' })).toEqual({
      lines: [],
      cursor: null,
    });
    logs.clear();
    expect(await p.readLogs(handle, { limit: 5 })).toEqual({ lines: [], cursor: null });
  });

  it.each([401, 404, 429, 500, 503])(
    'is LogsUnavailableError when Fly answers %s',
    async (status) => {
      const { p, handle } = await deployed();
      overrides.push((c) =>
        c.path.startsWith('/api/v1/apps/') ? flyJson(status, { error: 'secret detail' }) : null,
      );
      const error = await p.readLogs(handle, { limit: 5 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LogsUnavailableError);
      expect(error).toMatchObject({ target: 'fly', reason: `Fly answered HTTP ${status}` });
      expect(String((error as Error).message)).not.toContain('secret detail');
    },
  );

  it('is LogsUnavailableError when the body is not a log document, or the request fails or times out', async () => {
    const { p, handle } = await deployed();
    overrides.push((c) =>
      c.path.startsWith('/api/v1/apps/') ? flyJson(200, { not: 'logs' }) : null,
    );
    await expect(p.readLogs(handle, { limit: 5 })).rejects.toBeInstanceOf(LogsUnavailableError);

    overrides.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.includes('/logs?')) throw new TypeError('socket hang up');
      return createHostingFlySimFetch(url, init);
    });
    await expect(p.readLogs(handle, { limit: 5 })).rejects.toMatchObject({
      reason: 'the request failed',
    });

    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
        url.includes('/logs?')
          ? new Promise((_, reject) =>
              init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            )
          : createHostingFlySimFetch(url, init),
      );
      const pending = p.readLogs(handle, { limit: 5 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toMatchObject({ reason: 'the request timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a release-less app, a bad limit and a foreign cursor', async () => {
    const p = port();
    const handle = {
      target: 'fly' as const,
      appRef: PROD,
      environment: { kind: 'production' as const },
      releaseId: 'rel-1',
      providerRef: 'm-1',
    };
    await expect(p.readLogs(handle, { limit: 5 })).rejects.toBeInstanceOf(ReleaseNotFoundError);
    const { p: live, handle: h } = await deployed();
    await expect(live.readLogs(h, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(live.readLogs(h, { limit: 5, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      status: 400,
    });
    overrides.push((c) =>
      c.path.endsWith('/machines') && c.method === 'GET' ? flyJson(503, { error: 'x' }) : null,
    );
    await expect(live.readLogs(h, { limit: 5 })).rejects.toBeInstanceOf(LogsUnavailableError);
  });
});

/** The sim's own fetch, for a test that wraps it. */
let simFetch: HostingFlySim['fetch'];
function createHostingFlySimFetch(url: string, init: RequestInit): Promise<Response> {
  return simFetch(url, init);
}
beforeEach(() => {
  simFetch = (globalThis as unknown as { fetch: HostingFlySim['fetch'] }).fetch;
});

describe('readFlyLogWindow at the narrowest slice', () => {
  const NOW = new Date('2026-11-23T10:00:00.000Z');
  const ns = (offsetNs: bigint) => BigInt(NOW.getTime()) * 1_000_000n + offsetNs;
  // 100 lines inside ONE millisecond, a page of one line each: no slice can be
  // narrowed below a second, so the budget runs out inside it.
  const dense: FlyLogEntry[] = Array.from({ length: 100 }, (_, i) => ({
    id: `d${String(i).padStart(3, '0')}`,
    atNs: ns(BigInt(i)),
    message: `dense ${i}`,
    provider: 'app',
  }));
  const fetchPage = async (_app: string, token: string) => {
    const next = dense.find((e) => e.atNs > BigInt(token));
    return next
      ? { entries: [next], nextToken: String(next.atNs) }
      : { entries: [], nextToken: token };
  };

  it('answers the older part it read rather than a page that never moves', async () => {
    const page = await readFlyLogWindow(PROD, { limit: 5 }, NOW, fetchPage);
    expect(page.lines.map((l) => l.message)).toEqual([
      'dense 38',
      'dense 37',
      'dense 36',
      'dense 35',
      'dense 34',
    ]);
    expect(page.cursor).not.toBeNull();
  });

  it('keeps a slice it could not finish for the cursor once it has lines in hand', async () => {
    const newest: FlyLogEntry = { id: 'n', atNs: ns(0n), message: 'newest', provider: 'app' };
    // The same burst, ten seconds older than the newest line.
    const burst = dense.map((e) => ({ ...e, atNs: e.atNs - 10_000_000_000n }));
    const stream = [...burst, newest];
    const page = await readFlyLogWindow(PROD, { limit: 5 }, NOW, async (_a, token) => {
      const next = stream.find((e) => e.atNs > BigInt(token));
      return next
        ? { entries: [next], nextToken: String(next.atNs) }
        : { entries: [], nextToken: token };
    });
    expect(page.lines.map((l) => l.message)).toEqual(['newest']);
    expect(page.cursor).not.toBeNull();
  });
});

describe('the Fly log parsers', () => {
  it('reads RFC 3339 with nanosecond digits, and refuses anything else', () => {
    expect(flyLogInstantNs('2026-11-23T10:00:00.123456789Z')).toBe(
      BigInt(Date.parse('2026-11-23T10:00:00Z')) * 1_000_000n + 123_456_789n,
    );
    expect(flyLogInstantNs('2026-11-23T11:00:00+01:00')).toBe(
      BigInt(Date.parse('2026-11-23T10:00:00Z')) * 1_000_000n,
    );
    expect(flyLogInstantNs('yesterday')).toBeNull();
    expect(flyLogInstantNs(42)).toBeNull();
    expect(flyLogInstantNs('2026-13-45T10:00:00Z')).toBeNull();
  });

  it('keeps dated lines, keys an id-less line by its instant and text, and refuses a non-document', () => {
    expect(toFlyLogPage({ data: 'x' })).toBeNull();
    expect(toFlyLogPage(null)).toBeNull();
    expect(
      toFlyLogPage({
        data: [
          { attributes: { timestamp: '2026-11-23T10:00:00Z', message: 'm' } },
          { id: 'x', attributes: { timestamp: 'bad' } },
          { id: 'y' },
          'garbage',
        ],
        meta: {},
      }),
    ).toEqual({
      entries: [
        {
          id: `${BigInt(Date.parse('2026-11-23T10:00:00Z')) * 1_000_000n}:m`,
          atNs: BigInt(Date.parse('2026-11-23T10:00:00Z')) * 1_000_000n,
          message: 'm',
          provider: '',
        },
      ],
      nextToken: null,
    });
  });
});

// Recorded Machine event logs, in the Machines API's shape (`events[]`, epoch-ms
// timestamps, `request.exit_event` as fly-go's `MachineExitEvent`,
// superfly/fly-go@6c5db230): one per runtime state.
const T = Date.parse('2026-11-23T09:00:00.000Z');
const at = (s: number) => T + s * 1000;
function recorded(state: string, events: Array<Record<string, unknown>>) {
  const machine = toFlyMachine({
    id: 'm-1',
    state,
    created_at: '2026-11-23T08:00:00.000Z',
    updated_at: '2026-11-23T09:30:00.000Z',
    events: [...events].reverse(), // Fly lists the newest first
  });
  if (!machine) throw new Error('not a machine');
  return machine;
}
const exitEvent = (s: number, exit: Record<string, unknown>) => ({
  type: 'exit',
  status: 'stopped',
  source: 'flyd',
  timestamp: at(s),
  request: { exit_event: { exit_code: 0, guest_exit_code: 0, ...exit } },
});
const ev = (type: string, status: string, s: number) => ({
  type,
  status,
  source: 'flyd',
  timestamp: at(s),
});

describe('runtimeHealthOf over recorded Machine event logs (MOTIR-12102)', () => {
  it('running with no lastExit after a clean deploy', () => {
    expect(
      runtimeHealthOf(recorded('started', [ev('launch', 'created', 0), ev('start', 'started', 2)])),
    ).toEqual({ state: 'running', since: new Date(at(2)) });
  });

  it('running with the exit Fly restarted it from — and only since the release', () => {
    const machine = recorded('started', [
      ev('launch', 'created', 0),
      ev('start', 'started', 1),
      exitEvent(5, { exit_code: 9, restarting: true }), // the old release's crash
      ev('update', 'replacing', 10),
      exitEvent(11, { exit_code: 143, requested_stop: true }),
      ev('start', 'started', 12),
      exitEvent(20, { exit_code: 137, oom_killed: true, restarting: true }),
      ev('start', 'started', 21),
    ]);
    expect(runtimeHealthOf(machine)).toEqual({
      state: 'running',
      since: new Date(at(21)),
      lastExit: { exitCode: 137, oomKilled: true, at: new Date(at(20)) },
    });
  });

  it('running after an autostop and wake carries no lastExit', () => {
    const machine = recorded('started', [
      ev('launch', 'created', 0),
      ev('start', 'started', 1),
      ev('suspend', 'suspending', 100),
      exitEvent(101, { requested_stop: true }),
      ev('start', 'started', 200),
    ]);
    expect(runtimeHealthOf(machine)).toEqual({ state: 'running', since: new Date(at(200)) });
  });

  it.each(['created', 'starting', 'replacing', 'updating'])('deploying while %s', (state) => {
    const machine = recorded(state, [ev('launch', 'created', 0), ev('update', 'replacing', 30)]);
    expect(runtimeHealthOf(machine)).toEqual({ state: 'deploying', since: new Date(at(30)) });
  });

  it('suspended by autostop (suspend), and stopped by autostop (a requested stop)', () => {
    expect(
      runtimeHealthOf(
        recorded('suspended', [
          ev('launch', 'created', 0),
          ev('start', 'started', 1),
          ev('suspend', 'suspending', 50),
        ]),
      ),
    ).toEqual({ state: 'suspended', since: new Date(at(50)) });
    expect(
      runtimeHealthOf(
        recorded('stopped', [
          ev('launch', 'created', 0),
          ev('start', 'started', 1),
          ev('stop', 'stopping', 60),
          exitEvent(61, { exit_code: 143, requested_stop: true }),
        ]),
      ),
    ).toEqual({ state: 'suspended', since: new Date(at(60)) });
  });

  it('exited with its code when the process stopped on its own', () => {
    expect(
      runtimeHealthOf(
        recorded('stopped', [
          ev('launch', 'created', 0),
          ev('start', 'started', 1),
          exitEvent(70, { exit_code: 3 }),
        ]),
      ),
    ).toEqual({ state: 'exited', exitCode: 3, since: new Date(at(70)) });
  });

  it('oom_killed when the exit event says the kernel killed it', () => {
    expect(
      runtimeHealthOf(
        recorded('stopped', [
          ev('launch', 'created', 0),
          ev('start', 'started', 1),
          exitEvent(80, { exit_code: 137, oom_killed: true }),
        ]),
      ),
    ).toEqual({ state: 'oom_killed', since: new Date(at(80)) });
  });

  it('a failed Machine is exited; with no events every since falls back', () => {
    expect(runtimeHealthOf(recorded('failed', [ev('launch', 'created', 0)]))).toEqual({
      state: 'exited',
      exitCode: null,
      since: new Date(at(0)),
    });
    expect(runtimeHealthOf(recorded('stopped', []))).toEqual({
      state: 'suspended',
      since: new Date('2026-11-23T08:00:00.000Z'),
    });
    expect(runtimeHealthOf(recorded('started', []))).toEqual({
      state: 'running',
      since: new Date('2026-11-23T08:00:00.000Z'),
    });
    const bare = toFlyMachine({ id: 'm', state: 'mystery' })!;
    expect(runtimeHealthOf(bare)).toEqual({ state: 'deploying', since: new Date(0) });
  });

  it('parses the exit flags beside the code, and exitCodeOf is unchanged', () => {
    const machine = recorded('stopped', [exitEvent(5, { exit_code: 137, oom_killed: true })]);
    expect(machine.events[0]).toMatchObject({
      type: 'exit',
      exitCode: 137,
      oomKilled: true,
      requestedStop: false,
      restarting: false,
    });
    expect(exitCodeOf(machine)).toBe(137);
    expect(recorded('started', [ev('start', 'started', 1)]).events[0]).toMatchObject({
      exitCode: null,
      oomKilled: false,
    });
  });
});

describe('readHealth (MOTIR-12102)', () => {
  it('reads the release Machine and classifies it', async () => {
    const { p, handle } = await deployed();
    expect(await p.readHealth(handle)).toMatchObject({ state: 'running' });
    const m = apps.get(PROD)![0]!;
    m.state = 'stopped';
    m.events.push({
      type: 'exit',
      status: 'stopped',
      timestamp: clock + 5000,
      request: { exit_event: { exit_code: 137, oom_killed: true } },
    });
    expect(await p.readHealth(handle)).toEqual({
      state: 'oom_killed',
      since: new Date(clock + 5000),
    });
  });

  it('is ReleaseNotFoundError for a gone Machine, and RuntimeHealthUnavailableError when Fly cannot answer', async () => {
    const { p, handle } = await deployed();
    overrides.push((c) => (c.path.endsWith('/machines/m-1') ? flyJson(500, { error: 'x' }) : null));
    const error = await p.readHealth(handle).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeHealthUnavailableError);
    expect(error).toMatchObject({ reason: 'Fly answered HTTP 500' });
    overrides.length = 0;
    apps.get(PROD)![0]!.state = 'destroyed';
    await expect(p.readHealth(handle)).rejects.toBeInstanceOf(ReleaseNotFoundError);
    apps.set(PROD, []);
    await expect(p.readHealth(handle)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it('reads a failure inside the bounded fetch as unavailable', async () => {
    const { p, handle } = await deployed();
    vi.stubGlobal('fetch', async () => {
      throw new OrchestratorNotConfiguredError('boom');
    });
    // A non-Fly failure in the bounded fetch is wrapped as an API error by it,
    // so the read is still typed as unavailable.
    await expect(p.readHealth(handle)).rejects.toBeInstanceOf(RuntimeHealthUnavailableError);
  });
});
