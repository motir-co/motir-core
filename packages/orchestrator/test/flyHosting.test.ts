import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTING_RELEASE_METADATA,
  NoPreviousReleaseError,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  createFlyHostingDeployPort,
  flyHostingConfig,
  releaseStateOf,
  type DeployReleaseInput,
  type FlyHostingConfig,
  type HostingDeployPort,
} from '../src/index';

// The FLY adapter of the HOSTING DEPLOY PORT on the wire (MOTIR-5773) — what each
// operation turns into on `api.machines.dev`, against an in-memory Machines API
// that keeps apps, Machines, their config versions and events. `fetch` is the
// only fake; every request is recorded so a test can assert the body Fly got.

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

interface SimMachine {
  id: string;
  state: string;
  version: string;
  config: Record<string, unknown>;
  versions: Array<{ version: string; user_config: Record<string, unknown> }>;
  events: Array<{ type: string; status: string; timestamp: number }>;
  checks: Array<{ name: string; status: string }>;
}

const API = 'https://api.machines.dev/v1';
const CONFIG: FlyHostingConfig = {
  token: 'hosting-token',
  org: 'motir-hosting',
  region: 'iad',
  appPrefix: 'mh-',
};
const RID = 'cmrepo1';
const PROD = 'mh-cmrepo1';

let calls: Call[];
let apps: Map<string, SimMachine[]>;
let seq: number;
let clock: number;
let overrides: Array<(call: Call) => Response | null>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function machineBody(m: SimMachine) {
  return {
    id: m.id,
    name: 'release',
    state: m.state,
    region: 'iad',
    version: m.version,
    created_at: '2026-10-28T00:00:00.000Z',
    config: m.config,
    events: m.events,
    checks: m.checks,
  };
}

function simulate(call: Call): Response {
  for (const o of overrides) {
    const res = o(call);
    if (res) return res;
  }
  const parts = call.path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  // ['apps'] · ['apps', app] · ['apps', app, 'machines', id?, 'versions'?]
  if (parts.length === 1 && call.method === 'POST') {
    const name = String(call.body?.['app_name']);
    if (apps.has(name)) return json(422, { error: 'app name already taken' });
    apps.set(name, []);
    return json(201, { id: name });
  }
  const app = parts[1]!;
  const machines = apps.get(app);
  if (parts.length === 2) {
    if (call.method === 'GET')
      return machines ? json(200, { name: app }) : json(404, { error: 'not found' });
    if (call.method === 'DELETE') {
      if (!machines) return json(404, { error: 'not found' });
      apps.delete(app);
      return json(202, {});
    }
  }
  if (!machines) return json(404, { error: 'app not found' });
  if (parts[2] === 'ip_assignments') return json(200, call.method === 'GET' ? { ips: [] } : {});
  if (parts[2] === 'deploy_token') return json(200, { token: `fly-deploy-${app}` });
  if (parts[2] !== 'machines') return json(500, { error: `unhandled ${call.path}` });
  const id = parts[3];
  if (!id) {
    if (call.method === 'GET') return json(200, machines.map(machineBody));
    seq += 1;
    const config = call.body?.['config'] as Record<string, unknown>;
    const m: SimMachine = {
      id: `m-${seq}`,
      state: 'started',
      version: `v${seq}`,
      config,
      versions: [{ version: `v${seq}`, user_config: config }],
      events: [{ type: 'start', status: 'started', timestamp: clock }],
      checks: [{ name: 'health', status: 'passing' }],
    };
    machines.push(m);
    return json(200, machineBody(m));
  }
  const m = machines.find((x) => x.id === id);
  if (!m) return json(404, { error: 'machine not found' });
  if (parts[4] === 'versions') return json(200, [...m.versions].reverse());
  if (call.method === 'GET') return json(200, machineBody(m));
  if (call.method === 'DELETE') {
    machines.splice(machines.indexOf(m), 1);
    return json(200, { ok: true });
  }
  const current = call.body?.['current_version'];
  if (current && current !== m.version) return json(409, { error: 'version mismatch' });
  seq += 1;
  m.version = `v${seq}`;
  m.config = call.body?.['config'] as Record<string, unknown>;
  m.versions.push({ version: m.version, user_config: m.config });
  m.events.push({ type: 'start', status: 'started', timestamp: clock });
  return json(200, machineBody(m));
}

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

const writes = () =>
  calls.filter((c) => c.method === 'POST' && /\/machines(\/[^/]+)?$/.test(c.path));

beforeEach(() => {
  calls = [];
  apps = new Map();
  seq = 0;
  ids = 0;
  clock = Date.parse('2026-10-28T00:00:00.000Z');
  overrides = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      path: url.slice(API.length),
      method: init.method ?? 'GET',
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: headers['authorization'] ?? null,
    };
    calls.push(call);
    return simulate(call);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('flyHostingConfig', () => {
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
    });
    vi.stubEnv('MOTIR_HOSTING_FLY_ORG', 'o');
    vi.stubEnv('MOTIR_HOSTING_FLY_REGION', 'ams');
    vi.stubEnv('MOTIR_HOSTING_FLY_APP_PREFIX', 'motir-deploy-check-');
    expect(flyHostingConfig()).toEqual({
      token: 't',
      org: 'o',
      region: 'ams',
      appPrefix: 'motir-deploy-check-',
    });
  });

  it('names the token variable when it is unset', () => {
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', '');
    expect(() => flyHostingConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => flyHostingConfig()).toThrow(/MOTIR_HOSTING_FLY_API_TOKEN/);
  });
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
      c.path === '/apps/mh-cmrepo1-pr8' && c.method === 'GET' ? json(404, {}) : null,
    );
    apps.set('mh-cmrepo1-pr8', []);
    await expect(
      port().ensureApp({ repositoryId: RID, environment: { kind: 'preview', pullRequest: 8 } }),
    ).resolves.toMatchObject({ appRef: 'mh-cmrepo1-pr8' });
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
    overrides.push((c) => (c.path.endsWith('/deploy_token') ? json(200, {}) : null));
    await expect(port().mintDeployCredential({ pushNamespace: PROD })).rejects.toThrow(/no token/);
    overrides.unshift((c) =>
      c.path.endsWith('/deploy_token') ? json(403, { error: 'denied' }) : null,
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

  it('creates one Machine from the manifest: port, health check, digest-pinned image, idle suspend', async () => {
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
    expect(config).toMatchObject({
      image: 'docker.io/traefik/whoami@sha256:abc',
      init: { exec: ['/whoami'] },
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      env: { WHOAMI_NAME: 'release-1' },
      services: [
        {
          protocol: 'tcp',
          internal_port: 8080,
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
    expect(config).toMatchObject({ image: 'img:1', guest: { cpus: 4, memory_mb: 4096 } });
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
      originCredential: 'none',
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
    expect(live).toMatchObject({
      image: 'docker.io/traefik/whoami@sha256:abc',
      env: { WHOAMI_NAME: 'release-1' },
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
        ? json(422, { error: 'bad config' })
        : null,
    );
    await expect(port().deploy(input())).rejects.toThrow(/bad config/);
    overrides.length = 0;
    const p = port();
    await p.deploy(input());
    await p.deploy(input());
    overrides.push((c) => (c.path.endsWith('/versions') ? json(500, { error: 'boom' }) : null));
    await expect(
      p.rollback({ appRef: PROD, environment: { kind: 'production' } }),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
    overrides.length = 0;
    overrides.push((c) =>
      c.method === 'POST' && c.path.endsWith('/m-1') ? json(200, { nope: true }) : null,
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
      c.method === 'GET' && c.path.endsWith('/m-1') ? json(500, { error: 'boom' }) : null,
    );
    await expect(p.describe(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('destroyApp deletes the app, treats a gone one as done, and surfaces a refusal', async () => {
    const p = port();
    await p.destroyApp({ appRef: PROD });
    expect(apps.has(PROD)).toBe(false);
    await p.destroyApp({ appRef: PROD });
    overrides.push((c) => (c.method === 'DELETE' ? json(403, { error: 'denied' }) : null));
    await expect(p.destroyApp({ appRef: PROD })).rejects.toBeInstanceOf(OrchestratorApiError);
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
        ? json(200, c.path.endsWith('/machines') ? [sparse] : sparse)
        : null,
    );
    overrides.push((c) => (c.path.endsWith('/versions') ? json(200, { not: 'a list' }) : null));
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
      c.method === 'GET' && c.path.endsWith('/m-1') ? json(200, { no: 'id' }) : null,
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
