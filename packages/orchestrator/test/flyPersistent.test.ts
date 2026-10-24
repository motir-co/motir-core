import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXEC_RESPONSE_GRACE_SECONDS,
  FLEET_CONTAINER_SIZE,
  INSTANCE_METADATA_KEY,
  MACHINE_CONFIG_METADATA_KEY,
  TERMINAL_KEY_ID_METADATA_KEY,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
  VOLUME_RELEASE_ATTEMPTS,
  currentRunInstants,
  flyInstancesConfig,
  flyOrchestrator,
  flyPersistentOrchestrator,
  instanceAppName,
  instanceMachineName,
  instanceVolumeName,
  isFlyInstancesConfigured,
  isMachineConfigCurrent,
  machineConfigVersionOf,
  persistentTiming,
  toFlyMachine,
  toPersistentState,
  type PersistentContainerHandle,
  type PersistentContainerSpec,
  type PersistentTerminalConfig,
} from '../src/index';

// The FLY adapter's PERSISTENT half on the wire (Story MOTIR-6860 · MOTIR-6869,
// `docs/decisions/agent-instances.md` §1–§3, §7) — what each operation turns into
// on `api.machines.dev`, against a stubbed Machines API. No database; `fetch` is
// the only fake.

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  /** The body exactly as sent — for the byte-identity pin. */
  rawBody: string | null;
  auth: string | null;
  /** The abort signal `flyRequest` armed — what a stalled answer races. */
  signal: AbortSignal | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const API = 'https://api.machines.dev/v1';
const ORG = 'org_cm1';
const APP = instanceAppName('motir-inst', ORG);

const SPEC: PersistentContainerSpec = {
  orgId: ORG,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'cmInstance1',
  image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'b'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: { MOTIR_INSTANCE_ID: 'cmInstance1' },
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
  terminal: null,
};

/** The terminal machine config (`agent-terminal.md` Q2–Q4) as the lifecycle builds it. */
const TERMINAL: PersistentTerminalConfig = {
  version: 1,
  keyId: 'kid-1',
  command: [
    'sh',
    '-c',
    'motir agent-terminal --help >/dev/null 2>&1 && exec motir agent-terminal serve; exec sleep infinity',
  ],
  env: { MOTIR_TERMINAL_KEY: 'derived-key' },
  service: {
    internalPort: 7681,
    ports: [{ port: 443, handlers: ['tls', 'http'] }],
    autostart: false,
    autostop: 'off',
  },
};

/** Fly's machine-config spelling of {@link TERMINAL}'s service. */
const FLY_SERVICE = {
  protocol: 'tcp',
  internal_port: 7681,
  ports: [{ port: 443, handlers: ['tls', 'http'] }],
  autostart: false,
  autostop: 'off',
};

const HANDLE: PersistentContainerHandle = {
  provider: 'fly',
  app: APP,
  machineId: 'm-1',
  volumeId: 'vol_1',
  region: 'iad',
  createdAt: new Date('2026-09-28T10:00:00.000Z'),
};

function flyMachine(
  state: string,
  events: Array<Record<string, unknown>> = [],
  metadata: Record<string, string> = {},
) {
  return {
    id: 'm-1',
    name: 'instance-cminstance1',
    state,
    region: 'iad',
    created_at: '2026-09-28T10:00:00.000Z',
    config: { metadata },
    events,
  };
}

beforeEach(() => {
  calls = [];
  handler = () => json(500, { error: 'no handler' });
  vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'instances-token');
  vi.stubEnv('FLY_INSTANCES_REGION', '');
  vi.stubEnv('FLY_INSTANCES_APP_PREFIX', '');
  vi.stubEnv('FLY_INSTANCES_ORG', '');
  // The fleet's variables are set to values the instance lane must NEVER use.
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fleet-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'registry.fly.io/runner@sha256:abc');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      rawBody: typeof init.body === 'string' ? init.body : null,
      auth: headers['authorization'] ?? null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    return handler(call);
  });
  persistentTiming.sleep = async () => {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the instance lane configuration (§7)', () => {
  it('reads only FLY_INSTANCES_*, with the decision’s defaults', () => {
    expect(flyInstancesConfig()).toEqual({
      token: 'instances-token',
      region: 'iad',
      appPrefix: 'motir-inst',
      org: 'motir-fleet',
    });
    vi.stubEnv('FLY_INSTANCES_REGION', 'ams');
    vi.stubEnv('FLY_INSTANCES_APP_PREFIX', 'inst');
    vi.stubEnv('FLY_INSTANCES_ORG', 'other-org');
    expect(flyInstancesConfig()).toMatchObject({
      region: 'ams',
      appPrefix: 'inst',
      org: 'other-org',
    });
  });

  it('is not configured without its own token, even when the fleet is', () => {
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', '');
    expect(isFlyInstancesConfigured()).toBe(false);
    expect(() => flyInstancesConfig()).toThrow(OrchestratorNotConfiguredError);
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'x');
    expect(isFlyInstancesConfigured()).toBe(true);
  });

  it('names one app per organisation, deterministically, and a volume Fly accepts', () => {
    expect(APP).toMatch(/^motir-inst-[0-9a-f]{16}$/);
    expect(instanceAppName('motir-inst', ORG)).toBe(APP);
    expect(instanceAppName('motir-inst', 'org_other')).not.toBe(APP);
    expect(flyPersistentOrchestrator.appNameFor(ORG)).toBe(APP);
    expect(flyPersistentOrchestrator.defaultRegion()).toBe('iad');
    const volume = instanceVolumeName('cmInstance1');
    expect(volume).toMatch(/^[a-z0-9_]{1,30}$/);
    expect(instanceMachineName('cmInstance_1')).toBe('instance-cminstance-1');
  });
});

describe('provisionPersistent', () => {
  it('ensures the org app with its own network, creates a volume, then a machine MOUNTING it — auto_destroy false', async () => {
    handler = (call) => {
      if (call.method === 'GET' && call.url === `${API}/apps/${APP}`)
        return json(404, { error: 'not found' });
      if (call.method === 'POST' && call.url === `${API}/apps`) return json(201, { id: 'app-1' });
      if (call.method === 'POST' && call.url.endsWith('/volumes')) {
        return json(200, {
          id: 'vol_1',
          name: call.body?.['name'],
          created_at: '2026-09-28T10:00:00Z',
        });
      }
      if (call.method === 'POST' && call.url.endsWith('/machines'))
        return json(200, flyMachine('created'));
      return json(500, {});
    };
    const handle = await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(handle).toMatchObject({
      provider: 'fly',
      app: APP,
      machineId: 'm-1',
      volumeId: 'vol_1',
      region: 'iad',
    });

    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      `GET /apps/${APP}`,
      'POST /apps',
      `POST /apps/${APP}/volumes`,
      `POST /apps/${APP}/machines`,
    ]);
    expect(calls[1]!.body).toEqual({ app_name: APP, org_slug: 'motir-fleet', network: APP });
    expect(calls[2]!.body).toEqual({
      name: instanceVolumeName('cmInstance1'),
      region: 'iad',
      size_gb: 10,
    });
    const config = calls[3]!.body!['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(false);
    expect(config['restart']).toEqual({ policy: 'on-failure' });
    expect(config['mounts']).toEqual([{ volume: 'vol_1', path: '/home/node' }]);
    expect(config['image']).toBe(SPEC.image);
    expect(config['guest']).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 8192 });
    expect((config['metadata'] as Record<string, string>)[INSTANCE_METADATA_KEY]).toBe(
      'cmInstance1',
    );
    expect(calls[3]!.body!['name']).toBe(instanceMachineName('cmInstance1'));
  });

  it('never uses the fleet token or the fleet app', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, { id: 'app-1' });
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
      return json(200, flyMachine('created'));
    };
    await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.auth).toBe('Bearer instances-token');
      expect(call.url).not.toContain('motir-ci-fleet');
    }
  });

  it('skips the app create when the app exists, and tolerates a concurrent create', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, { id: 'app-1' });
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
      return json(200, flyMachine('created'));
    };
    await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(calls.some((c) => c.url === `${API}/apps` && c.method === 'POST')).toBe(false);

    for (const answer of [
      json(409, { error: 'exists' }),
      json(422, { error: 'app name already taken' }),
    ]) {
      calls = [];
      handler = (call) => {
        if (call.method === 'GET') return json(404, {});
        if (call.url === `${API}/apps`) return answer.clone();
        if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
        return json(200, flyMachine('created'));
      };
      await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).resolves.toMatchObject({
        machineId: 'm-1',
      });
    }
  });

  it('throws on an app create Fly refuses, and on an app read that is neither 200 nor 404', async () => {
    handler = (call) => (call.method === 'GET' ? json(404, {}) : json(403, { error: 'forbidden' }));
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorApiError,
    );
    handler = () => json(401, { error: 'unauthorized' });
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorApiError,
    );
    expect(calls.filter((c) => c.url.endsWith('/volumes'))).toEqual([]);
  });

  it('DESTROYS THE VOLUME when the machine create fails, and names an unpullable image', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.method === 'POST' && call.url.endsWith('/volumes'))
        return json(200, { id: 'vol_9', name: 'x' });
      if (call.method === 'POST' && call.url.endsWith('/machines')) {
        return json(400, { error: 'failed to get manifest ghcr.io/x: unauthorized' });
      }
      if (call.method === 'DELETE') return json(200, {});
      return json(500, {});
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorImageUnpullableError,
    );
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${API}/apps/${APP}/volumes/vol_9`,
    });

    // A plain refusal is an API error, and a cleanup that itself fails still
    // surfaces the ORIGINAL error.
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_9', name: 'x' });
      if (call.url.endsWith('/machines')) return json(500, { error: 'capacity' });
      return json(500, { error: 'cannot delete' });
    };
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(/capacity/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses a volume or machine answer it cannot read', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes')) return json(200, { nope: true });
      return json(200, flyMachine('created'));
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /unexpected shape/,
    );
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes') && call.method === 'POST')
        return json(200, { id: 'vol_1', name: 'x' });
      if (call.url.endsWith('/machines')) return json(200, { nope: true });
      return json(200, {});
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /unexpected shape/,
    );
    handler = (call) =>
      call.method === 'GET' ? json(200, {}) : json(500, { error: 'volume quota' });
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /volume quota/,
    );
  });
});

describe('stop and start', () => {
  it('stop is a POST …/stop, and idempotent on a machine already stopped', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.stop(HANDLE);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/apps/${APP}/machines/m-1/stop` });

    handler = (call) =>
      call.method === 'POST'
        ? json(400, { error: 'machine not running' })
        : json(200, flyMachine('stopped'));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).resolves.toBeUndefined();
    handler = (call) => (call.method === 'POST' ? json(400, { error: 'x' }) : json(404, {}));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).rejects.toThrow(OrchestratorApiError);
    handler = (call) =>
      call.method === 'POST' ? json(500, { error: 'boom' }) : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).rejects.toThrow(/boom/);
  });

  it('start is a POST …/start — a cold boot — idempotent on a machine already running', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.start(HANDLE);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/apps/${APP}/machines/m-1/start`,
    });
    handler = (call) =>
      call.method === 'POST'
        ? json(400, { error: 'already started' })
        : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.start(HANDLE)).resolves.toBeUndefined();
    handler = (call) =>
      call.method === 'POST'
        ? json(503, { error: 'no capacity' })
        : json(200, flyMachine('stopped'));
    await expect(flyPersistentOrchestrator.start(HANDLE)).rejects.toThrow(/no capacity/);
  });
});

describe('describePersistent', () => {
  it('maps Fly states to the instance vocabulary, where `stopped` is NOT terminal', () => {
    expect(toPersistentState('created')).toBe('starting');
    expect(toPersistentState('starting')).toBe('starting');
    expect(toPersistentState('replacing')).toBe('starting');
    expect(toPersistentState('started')).toBe('running');
    expect(toPersistentState('stopping')).toBe('stopping');
    expect(toPersistentState('suspending')).toBe('stopping');
    expect(toPersistentState('stopped')).toBe('stopped');
    expect(toPersistentState('suspended')).toBe('stopped');
    expect(toPersistentState('destroying')).toBe('gone');
    expect(toPersistentState('destroyed')).toBe('gone');
    expect(toPersistentState('failed')).toBe('failed');
    expect(toPersistentState('something-new')).toBe('starting');
  });

  it('reports the machine’s own events oldest first, unknown types passed through (MOTIR-7396)', async () => {
    const events = [
      {
        type: 'exit',
        status: 'stopped',
        timestamp: Date.parse('2026-09-28T10:02:00Z'),
        request: { exit_event: { exit_code: 0 } },
      },
      { type: 'launch', status: 'created', timestamp: Date.parse('2026-09-28T10:00:00Z') },
      { type: 'start', status: 'started', timestamp: Date.parse('2026-09-28T10:01:00Z') },
      { type: 'brand-new-fly-type', status: 'odd', timestamp: Date.parse('2026-09-28T10:03:00Z') },
    ];
    handler = () => json(200, flyMachine('stopped', events));
    const status = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(status.events).toEqual([
      { type: 'launch', status: 'created', at: new Date('2026-09-28T10:00:00Z') },
      { type: 'start', status: 'started', at: new Date('2026-09-28T10:01:00Z') },
      { type: 'exit', status: 'stopped', at: new Date('2026-09-28T10:02:00Z'), exitCode: 0 },
      { type: 'brand-new-fly-type', status: 'odd', at: new Date('2026-09-28T10:03:00Z') },
    ]);
  });

  it('reads the CURRENT run’s start and stop — never the first start', async () => {
    const events = [
      { type: 'start', status: 'started', timestamp: Date.parse('2026-09-28T09:00:00Z') },
      { type: 'stop', status: 'stopped', timestamp: Date.parse('2026-09-28T09:30:00Z') },
      { type: 'start', status: 'started', timestamp: Date.parse('2026-09-28T12:00:00Z') },
    ];
    handler = () => json(200, flyMachine('started', events));
    const running = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(running).toMatchObject({ state: 'running', providerState: 'started', stoppedAt: null });
    expect(running.startedAt?.toISOString()).toBe('2026-09-28T12:00:00.000Z');

    handler = () =>
      json(
        200,
        flyMachine('stopped', [
          ...events,
          { type: 'exit', status: 'stopped', timestamp: Date.parse('2026-09-28T12:45:00Z') },
        ]),
      );
    const stopped = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stoppedAt?.toISOString()).toBe('2026-09-28T12:45:00.000Z');
  });

  it('reports the exit code of the CURRENT run’s exit — never a code from an earlier run (MOTIR-7336)', async () => {
    const exit = (at: string, code: number) => ({
      type: 'exit',
      status: 'stopped',
      timestamp: Date.parse(at),
      request: { exit_event: { exit_code: code, oom_killed: false, requested_stop: false } },
    });
    const earlier = [
      { type: 'start', status: 'started', timestamp: Date.parse('2026-10-02T09:00:00Z') },
      exit('2026-10-02T09:30:00Z', 137),
    ];
    // Running again after an earlier exit: no code for the run in progress.
    handler = () =>
      json(
        200,
        flyMachine('started', [
          ...earlier,
          { type: 'start', status: 'started', timestamp: Date.parse('2026-10-02T12:57:08Z') },
        ]),
      );
    expect((await flyPersistentOrchestrator.describePersistent(HANDLE)).exitCode).toBeNull();

    // The production machine: started, then the shell exited 0 two seconds later.
    handler = () =>
      json(
        200,
        flyMachine('stopped', [
          ...earlier,
          { type: 'start', status: 'started', timestamp: Date.parse('2026-10-02T12:57:08Z') },
          exit('2026-10-02T12:57:10Z', 0),
        ]),
      );
    const exited = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(exited).toMatchObject({ state: 'stopped', providerState: 'stopped', exitCode: 0 });
    expect(exited.stoppedAt?.toISOString()).toBe('2026-10-02T12:57:10.000Z');
  });

  // A gone machine describing as `gone` is a contract case.
  it('throws on a machine read that is neither 200 nor 404', async () => {
    handler = () => json(500, { error: 'down' });
    await expect(flyPersistentOrchestrator.describePersistent(HANDLE)).rejects.toThrow(
      OrchestratorApiError,
    );
  });

  it('currentRunInstants tolerates events without timestamps and a machine that never started', () => {
    const machine = toFlyMachine(
      flyMachine('stopped', [
        { type: 'start', status: 'started' },
        { type: 'stop', status: 'stopped', timestamp: Date.parse('2026-09-28T09:30:00Z') },
        { type: 'exit', status: 'stopped' },
      ]),
    )!;
    expect(currentRunInstants(machine)).toEqual({
      startedAt: null,
      stoppedAt: new Date('2026-09-28T09:30:00Z'),
    });
  });
});

describe('destroyPersistent', () => {
  it('destroys the machine, waits for it to be gone, THEN destroys the volume', async () => {
    let reads = 0;
    handler = (call) => {
      if (call.method === 'DELETE') return json(200, {});
      reads += 1;
      return reads < 3 ? json(200, flyMachine('destroying')) : json(404, {});
    };
    // `destroying` maps to gone, so the first read already releases.
    await flyPersistentOrchestrator.destroyPersistent(HANDLE);
    const order = calls.map((c) => `${c.method} ${c.url.replace(`${API}/apps/${APP}`, '')}`);
    expect(order[0]).toBe('DELETE /machines/m-1?force=true');
    expect(order.at(-1)).toBe('DELETE /volumes/vol_1');
    expect(order.indexOf('DELETE /volumes/vol_1')).toBeGreaterThan(
      order.indexOf('GET /machines/m-1'),
    );
  });

  it('never destroys the volume while the machine still exists — gives up and throws', async () => {
    handler = (call) =>
      call.method === 'DELETE' ? json(200, {}) : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(
      /did not release/,
    );
    expect(calls.filter((c) => c.url.includes('/volumes/'))).toEqual([]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(VOLUME_RELEASE_ATTEMPTS);
  });

  // A 404 on the machine and on the volume being the end state is a contract case.
  it('throws on a volume or machine delete Fly refuses with anything but 404', async () => {
    handler = (call) =>
      call.url.includes('/volumes/') ? json(500, { error: 'busy' }) : json(404, {});
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(/busy/);
    handler = () => json(500, { error: 'machine delete failed' });
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(
      /machine delete failed/,
    );
  });

  it('destroys one orphan machine or volume by id', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.destroyMachine(APP, 'm-9');
    await flyPersistentOrchestrator.destroyVolume(APP, 'vol_9');
    expect(calls.map((c) => c.url.replace(`${API}/apps/${APP}`, ''))).toEqual([
      '/machines/m-9?force=true',
      '/volumes/vol_9',
    ]);
  });
});

describe('listPersistent — the reconcile’s read', () => {
  it('lists machines with their instance id and volumes with their attachment', async () => {
    handler = (call) => {
      if (call.url.endsWith('/machines')) {
        return json(200, [
          flyMachine('stopped', [], { [INSTANCE_METADATA_KEY]: 'cmInstance1' }),
          { junk: true },
        ]);
      }
      return json(200, [
        {
          id: 'vol_1',
          name: 'home_x',
          attached_machine_id: 'm-1',
          created_at: '2026-09-28T10:00:00Z',
        },
        { id: 'vol_2', name: 'home_y', attached_machine_id: '' },
        'junk',
      ]);
    };
    const inventory = await flyPersistentOrchestrator.listPersistent(APP);
    expect(inventory.machines).toEqual([
      {
        machineId: 'm-1',
        state: 'stopped',
        instanceId: 'cmInstance1',
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      },
    ]);
    expect(inventory.volumes).toEqual([
      {
        volumeId: 'vol_1',
        name: 'home_x',
        attachedMachineId: 'm-1',
        createdAt: new Date('2026-09-28T10:00:00Z'),
      },
      { volumeId: 'vol_2', name: 'home_y', attachedMachineId: null, createdAt: null },
    ]);
  });

  // An app that does not exist listing empty, and a machine with no metadata
  // listing with no instance id, are contract cases.
  it('throws on a list Fly refuses with anything but 404', async () => {
    handler = (call) =>
      call.url.endsWith('/machines') ? json(200, {}) : json(500, { error: 'x' });
    await expect(flyPersistentOrchestrator.listPersistent(APP)).rejects.toThrow(
      OrchestratorApiError,
    );
  });
});

describe('the ephemeral path is unchanged', () => {
  it('flyOrchestrator.provision still sends auto_destroy: true and restart: no, to the FLEET app', async () => {
    handler = () => json(200, flyMachine('created'));
    await flyOrchestrator.provision({
      orgId: 'org-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      repoFullName: 'motir-projects/acme',
      workload: 'ci_runner',
      workflowJobId: 1,
      image: 'registry.fly.io/runner@sha256:abc',
      size: FLEET_CONTAINER_SIZE,
      env: {},
      timeoutSeconds: 60,
      region: 'iad',
    });
    const config = calls[0]!.body!['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(true);
    expect(config['restart']).toEqual({ policy: 'no' });
    expect(config['mounts']).toBeUndefined();
    expect(calls[0]!.url).toBe(`${API}/apps/motir-ci-fleet/machines`);
    expect(calls[0]!.auth).toBe('Bearer fleet-token');
    // MOTIR-6939: BYTE-IDENTICAL to the body before the terminal existed (captured
    // from `9f32def0e`) — no init, no services, no terminal key on a CI machine.
    expect(calls[0]!.rawBody).toBe(
      '{"name":"motir-runner-1","region":"iad","config":{"image":"registry.fly.io/runner@sha256:abc",' +
        '"guest":{"cpu_kind":"performance","cpus":2,"memory_mb":8192},"env":{},' +
        '"metadata":{"motir_fleet":"ci-runner","motir_intent_id":"1","motir_org_id":"org-1","motir_project_id":"proj-1"},' +
        '"auto_destroy":true,"restart":{"policy":"no"}}}',
    );
  });
});

describe('exec — one command inside a running machine (MOTIR-6872)', () => {
  it('POSTs the argv and a timeout, and reads the exit code and output back', async () => {
    handler = () => json(200, { exit_code: 3, stdout: 'out', stderr: 'err' });
    const result = await flyPersistentOrchestrator.exec(HANDLE, ['sh', '-c', 'exit 3'], {
      timeoutSeconds: 30,
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/apps/${APP}/machines/m-1/exec`,
      body: { command: ['sh', '-c', 'exit 3'], timeout: 30 },
      auth: 'Bearer instances-token',
    });
  });

  it('defaults the timeout, reads a body with no fields as an unknown exit, and throws on a refusal', async () => {
    handler = () => json(200, {});
    expect(await flyPersistentOrchestrator.exec(HANDLE, ['true'])).toEqual({
      exitCode: -1,
      stdout: '',
      stderr: '',
    });
    expect(calls[0]!.body).toEqual({ command: ['true'], timeout: 120 });
    // The exec API drops a `stdin` field (MOTIR-8872), so given stdin is piped in
    // by a wrapper and no `stdin` field is sent.
    await flyPersistentOrchestrator.exec(HANDLE, ['cat'], { stdin: '{"token":"t"}' });
    expect(calls[1]!.body).toEqual({
      command: [
        'sh',
        '-c',
        'p=$1; shift; printf %s "$p" | exec "$@"',
        'sh',
        '{"token":"t"}',
        'cat',
      ],
      timeout: 120,
    });
    handler = () => json(200, null);
    expect((await flyPersistentOrchestrator.exec(HANDLE, ['true'])).exitCode).toBe(-1);
    handler = () => json(412, { error: 'machine not started' });
    await expect(flyPersistentOrchestrator.exec(HANDLE, ['true'])).rejects.toThrow(
      OrchestratorApiError,
    );
  });

  // MOTIR-7347: the Machines API reads exec's argv from `command` (an array).
  // `cmd` is its legacy STRING field, and an array there is refused 400 "body is
  // missing command: json: cannot unmarshal array into Go struct field
  // machineExecRequestRaw.cmd of type string" — which every exec on production
  // answered while the tests above asserted `cmd` against this mock. So the
  // field name is pinned for every door into exec, and `cmd` may never appear.
  it('sends the argv as `command` and never as `cmd`, through every door into exec', async () => {
    handler = () => json(200, { exit_code: 0, stdout: '', stderr: '' });
    await flyPersistentOrchestrator.exec(HANDLE, ['git', 'clone', 'x']);
    await flyPersistentOrchestrator.exec(HANDLE, ['cat'], { stdin: 'secret' });
    await flyPersistentOrchestrator.checkLiveness(HANDLE, ['claude', '--version']);
    expect(calls.map((c) => c.body)).toEqual([
      { command: ['git', 'clone', 'x'], timeout: 120 },
      {
        command: ['sh', '-c', 'p=$1; shift; printf %s "$p" | exec "$@"', 'sh', 'secret', 'cat'],
        timeout: 120,
      },
      { command: ['claude', '--version'], timeout: 60 },
    ]);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty('cmd');
      expect(Array.isArray(call.body?.['command'])).toBe(true);
    }
  });
});

// MOTIR-7405: the Machines API's exec is SYNCHRONOUS — the response arrives when
// the command exits — so the request stays open for as long as the command runs.
// `flyRequest` used to abort EVERY call at ORCHESTRATOR_REQUEST_TIMEOUT_MS (30 s),
// so a clone allowed 600 s was cut off at 30 s on production ("The fly
// orchestrator did not answer within 30000ms"), while the fake adapter's bridge
// waited `timeoutSeconds + 5` and every fake-fleet test passed.
describe('exec waits as long as its command may run (MOTIR-7405)', () => {
  /** A Machines API that answers after `ms`, unless the caller hangs up first. */
  function answerAfter(ms: number, body: unknown, signal: AbortSignal | null): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json(200, body)), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gets the answer of a command that runs 35 s when it was allowed 60 s', async () => {
    handler = (call) =>
      answerAfter(35_000, { exit_code: 0, stdout: 'cloned', stderr: '' }, call.signal);

    const settled = flyPersistentOrchestrator
      .exec(HANDLE, ['git', 'clone', 'x'], { timeoutSeconds: 60 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(35_000);

    expect(await settled).toEqual({ exitCode: 0, stdout: 'cloned', stderr: '' });
    expect(calls[0]!.body).toEqual({ command: ['git', 'clone', 'x'], timeout: 60 });
  });

  it('hangs up at timeoutSeconds + the grace, and the timeout error names the deadline that applied', async () => {
    expect(EXEC_RESPONSE_GRACE_SECONDS).toBe(5);
    handler = (call) => answerAfter(35_000, { exit_code: 0 }, call.signal);

    const settled = flyPersistentOrchestrator
      .exec(HANDLE, ['git', 'clone', 'x'], { timeoutSeconds: 10 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000 - 1);
    await expect(Promise.race([settled, Promise.resolve('still pending')])).resolves.toBe(
      'still pending',
    );

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(OrchestratorTimeoutError);
    expect(err).toMatchObject({ provider: 'fly', timeoutMs: 15_000 });
    expect((err as Error).message).toContain('15000ms');
  });

  it('waits the default exec timeout + the grace when the caller names none', async () => {
    handler = (call) => answerAfter(124_000, { exit_code: 0 }, call.signal);

    const settled = flyPersistentOrchestrator.exec(HANDLE, ['true']).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(124_000);

    expect(await settled).toMatchObject({ exitCode: 0 });
    expect(calls[0]!.body).toMatchObject({ timeout: 120 });
  });

  it('every call that is not an exec still aborts at the 30-second default', async () => {
    handler = (call) => answerAfter(60_000, flyMachine('started'), call.signal);

    const settled = flyPersistentOrchestrator.describePersistent(HANDLE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_REQUEST_TIMEOUT_MS - 1);
    await expect(Promise.race([settled, Promise.resolve('still pending')])).resolves.toBe(
      'still pending',
    );

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(OrchestratorTimeoutError);
    expect(err).toMatchObject({ provider: 'fly', timeoutMs: ORCHESTRATOR_REQUEST_TIMEOUT_MS });
  });
});

describe('the terminal machine config (agent-terminal.md Q2–Q4 · MOTIR-6939)', () => {
  const SHARED_V4 = { ip: '137.66.0.1', shared: true, egress: false, network: null };
  const PUBLIC_V6 = { ip: '2a09:8280:1::1', shared: false, egress: false, network: null };

  function provisionHandler(ips: unknown[]) {
    return (call: Call) => {
      if (call.method === 'GET' && call.url === `${API}/apps/${APP}`) return json(200, { id: 'a' });
      if (call.url.endsWith('/ip_assignments'))
        return call.method === 'GET' ? json(200, { ips }) : json(200, { ip: 'x' });
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
      if (call.url.endsWith('/machines')) return json(200, flyMachine('created'));
      return json(500, {});
    };
  }

  it('creates the machine with the terminal server as its MAIN process, the one public service, the key and the stamp', async () => {
    handler = provisionHandler([]);
    await flyPersistentOrchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      `GET /apps/${APP}`,
      `GET /apps/${APP}/ip_assignments`,
      `POST /apps/${APP}/ip_assignments`,
      `POST /apps/${APP}/ip_assignments`,
      `POST /apps/${APP}/volumes`,
      `POST /apps/${APP}/machines`,
    ]);
    // A shared IPv4 and an IPv6 (Q2).
    expect(calls[2]!.body).toEqual({ type: 'shared_v4' });
    expect(calls[3]!.body).toEqual({ type: 'v6' });

    const config = calls[5]!.body!['config'] as Record<string, unknown>;
    // The argv replaces the image's CMD; the image's ENTRYPOINT is left alone.
    expect(config['init']).toEqual({ cmd: TERMINAL.command });
    expect(config['services']).toEqual([FLY_SERVICE]);
    expect(config['env']).toEqual({
      MOTIR_INSTANCE_ID: 'cmInstance1',
      MOTIR_TERMINAL_KEY: 'derived-key',
    });
    expect(config['metadata']).toMatchObject({
      [INSTANCE_METADATA_KEY]: 'cmInstance1',
      [MACHINE_CONFIG_METADATA_KEY]: '1',
      [TERMINAL_KEY_ID_METADATA_KEY]: 'kid-1',
    });
    // Everything else as before: the pinned digest, the home volume, restart.
    expect(config['image']).toBe(SPEC.image);
    expect(config['mounts']).toEqual([{ volume: 'vol_1', path: '/home/node' }]);
    expect(config['restart']).toEqual({ policy: 'on-failure' });
    expect(config['auto_destroy']).toBe(false);
  });

  it('with the terminal OFF, the idle command is the main process and there is no service — and the terminal’s command wins over it (MOTIR-7336)', async () => {
    const IDLE = ['sleep', 'infinity'];
    handler = provisionHandler([]);
    await flyPersistentOrchestrator.provisionPersistent({ ...SPEC, idleCommand: IDLE });
    const off = calls.at(-1)!.body!['config'] as Record<string, unknown>;
    expect(off['init']).toEqual({ cmd: IDLE });
    expect(off['services']).toBeUndefined();
    expect(off['restart']).toEqual({ policy: 'on-failure' });

    calls = [];
    handler = provisionHandler([]);
    await flyPersistentOrchestrator.provisionPersistent({
      ...SPEC,
      terminal: TERMINAL,
      idleCommand: IDLE,
    });
    const on = calls.at(-1)!.body!['config'] as Record<string, unknown>;
    expect(on['init']).toEqual({ cmd: TERMINAL.command });

    calls = [];
    handler = provisionHandler([]);
    await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect((calls.at(-1)!.body!['config'] as Record<string, unknown>)['init']).toBeUndefined();
  });

  it('allocates the app’s addresses ONCE — a second ensure, on an app that has them, allocates nothing', async () => {
    handler = provisionHandler([SHARED_V4, PUBLIC_V6]);
    await flyPersistentOrchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    expect(calls.filter((c) => c.url.endsWith('/ip_assignments') && c.method === 'POST')).toEqual(
      [],
    );
  });

  it('never counts a private (Flycast) or egress address as the public one', async () => {
    handler = provisionHandler([
      { ip: 'fdaa:0:1::3', shared: false, egress: false, network: { name: APP, org_slug: 'o' } },
      { ip: '149.248.1.2', shared: false, egress: true, network: null },
      { ip: '2a09:1::9', shared: false, egress: true },
      { nothing: true },
    ]);
    await flyPersistentOrchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    expect(
      calls
        .filter((c) => c.url.endsWith('/ip_assignments') && c.method === 'POST')
        .map((c) => c.body),
    ).toEqual([{ type: 'shared_v4' }, { type: 'v6' }]);
  });

  it('allocates only the missing family, and a refused allocation stops the provision before any volume', async () => {
    handler = provisionHandler([SHARED_V4]);
    await flyPersistentOrchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    expect(
      calls
        .filter((c) => c.url.endsWith('/ip_assignments') && c.method === 'POST')
        .map((c) => c.body),
    ).toEqual([{ type: 'v6' }]);

    for (const refuse of ['GET', 'POST']) {
      calls = [];
      handler = (call) => {
        if (call.url.endsWith('/ip_assignments') && call.method === refuse)
          return json(403, { error: 'no' });
        return provisionHandler([])(call);
      };
      await expect(
        flyPersistentOrchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL }),
      ).rejects.toThrow(OrchestratorApiError);
      expect(calls.filter((c) => c.url.endsWith('/volumes'))).toEqual([]);
    }
  });

  it('reads a stamp as its version, and anything else as 0', () => {
    expect(machineConfigVersionOf({ [MACHINE_CONFIG_METADATA_KEY]: '3' })).toBe(3);
    expect(machineConfigVersionOf({})).toBe(0);
    expect(machineConfigVersionOf({ [MACHINE_CONFIG_METADATA_KEY]: 'v2' })).toBe(0);
    const stamp = (v: string, k?: string) => ({
      [MACHINE_CONFIG_METADATA_KEY]: v,
      ...(k ? { [TERMINAL_KEY_ID_METADATA_KEY]: k } : {}),
    });
    expect(isMachineConfigCurrent(stamp('1', 'kid-1'), TERMINAL)).toBe(true);
    expect(isMachineConfigCurrent(stamp('2'), TERMINAL)).toBe(true);
    expect(isMachineConfigCurrent(stamp('1', 'rotated'), TERMINAL)).toBe(false);
    expect(isMachineConfigCurrent(stamp('0'), TERMINAL)).toBe(false);
  });

  describe('ensureMachineConfig — a wake brings an older machine up to date (Q8)', () => {
    /** A machine created before the terminal: no init, no services, no stamp. */
    const LEGACY_CONFIG = {
      image: SPEC.image,
      guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 },
      env: { MOTIR_INSTANCE_ID: 'cmInstance1' },
      metadata: { [INSTANCE_METADATA_KEY]: 'cmInstance1', motir_org_id: ORG },
      mounts: [{ volume: 'vol_1', path: '/home/node', name: 'home_x', size_gb: 10 }],
      auto_destroy: false,
      restart: { policy: 'on-failure' },
    };

    function machineHandler(config: Record<string, unknown> | null, ips: unknown[] = []) {
      return (call: Call) => {
        if (call.method === 'GET' && call.url === `${API}/apps/${APP}/machines/m-1`)
          return config
            ? json(200, { ...flyMachine('stopped'), version: 'ver-7', config })
            : json(404, { error: 'not found' });
        if (call.url.endsWith('/ip_assignments'))
          return call.method === 'GET' ? json(200, { ips }) : json(200, {});
        if (call.method === 'POST' && call.url === `${API}/apps/${APP}/machines/m-1`)
          return json(200, flyMachine('stopped'));
        return json(500, { error: 'unexpected' });
      };
    }

    it('sends ONE update with skip_launch, the same image digest and the same /home/node mount — and never starts it', async () => {
      handler = machineHandler(LEGACY_CONFIG);
      expect(await flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).toBe('updated');
      expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
        `GET /apps/${APP}/machines/m-1`,
        `GET /apps/${APP}/ip_assignments`,
        `POST /apps/${APP}/ip_assignments`,
        `POST /apps/${APP}/ip_assignments`,
        `POST /apps/${APP}/machines/m-1`,
      ]);
      const update = calls[4]!.body!;
      expect(update['skip_launch']).toBe(true);
      expect(update['current_version']).toBe('ver-7');
      expect(update['config']).toEqual({
        ...LEGACY_CONFIG,
        init: { cmd: TERMINAL.command },
        services: [FLY_SERVICE],
        env: { MOTIR_INSTANCE_ID: 'cmInstance1', MOTIR_TERMINAL_KEY: 'derived-key' },
        metadata: {
          ...LEGACY_CONFIG.metadata,
          [MACHINE_CONFIG_METADATA_KEY]: '1',
          [TERMINAL_KEY_ID_METADATA_KEY]: 'kid-1',
        },
      });
      expect(calls.some((c) => c.url.endsWith('/start'))).toBe(false);
    });

    it('sends NO update to an up-to-date machine, nor to one a newer build stamped', async () => {
      for (const stamp of [
        { [MACHINE_CONFIG_METADATA_KEY]: '1', [TERMINAL_KEY_ID_METADATA_KEY]: 'kid-1' },
        { [MACHINE_CONFIG_METADATA_KEY]: '9' },
      ]) {
        calls = [];
        handler = machineHandler({ ...LEGACY_CONFIG, metadata: stamp });
        expect(await flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).toBe(
          'current',
        );
        expect(calls.map((c) => c.method)).toEqual(['GET']);
      }
    });

    it('rewrites a machine whose key id differs (a rotated master key), keeping an existing init field', async () => {
      handler = machineHandler(
        {
          ...LEGACY_CONFIG,
          init: { swap_size_mb: 512, cmd: ['bash', '-l'] },
          metadata: { [MACHINE_CONFIG_METADATA_KEY]: '1', [TERMINAL_KEY_ID_METADATA_KEY]: 'old' },
        },
        [SHARED_V4, PUBLIC_V6],
      );
      expect(await flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).toBe('updated');
      const update = calls.find((c) => c.method === 'POST')!;
      expect((update.body!['config'] as Record<string, unknown>)['init']).toEqual({
        swap_size_mb: 512,
        cmd: TERMINAL.command,
      });
    });

    it('throws for a machine that is gone, and on an update Fly refuses', async () => {
      handler = machineHandler(null);
      await expect(flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).rejects.toThrow(
        OrchestratorApiError,
      );
      const base = machineHandler(LEGACY_CONFIG, [SHARED_V4, PUBLIC_V6]);
      handler = (call) =>
        call.method === 'POST' && call.url.endsWith('/machines/m-1')
          ? json(409, { error: 'version mismatch' })
          : base(call);
      await expect(flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).rejects.toThrow(
        OrchestratorApiError,
      );
      handler = () => json(500, { error: 'boom' });
      await expect(flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).rejects.toThrow(
        OrchestratorApiError,
      );
    });

    it('omits current_version when the machine reports none, and tolerates a config-less body', async () => {
      handler = (call) => {
        if (call.method === 'GET' && call.url.endsWith('/machines/m-1'))
          return json(200, { id: 'm-1', state: 'stopped' });
        if (call.url.endsWith('/ip_assignments')) return json(200, {});
        return json(200, {});
      };
      expect(await flyPersistentOrchestrator.ensureMachineConfig(HANDLE, TERMINAL)).toBe('updated');
      const update = calls.find((c) => c.method === 'POST' && c.url.endsWith('/machines/m-1'))!;
      expect(update.body!['current_version']).toBeUndefined();
      expect((update.body!['config'] as Record<string, unknown>)['services']).toEqual([
        FLY_SERVICE,
      ]);
    });
  });

  it('terminalEndpoint: the org app’s public name, pinned to the one machine by fly-force-instance-id', () => {
    expect(flyPersistentOrchestrator.terminalEndpoint(HANDLE)).toEqual({
      url: `wss://${APP}.fly.dev/v1/terminal`,
      headers: { 'fly-force-instance-id': 'm-1' },
    });
    expect(calls).toEqual([]);
  });
});

describe('moveImage — an agent moved to a newer image on the same machine and volume (MOTIR-6950)', () => {
  const NEW_IMAGE = 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'c'.repeat(64);
  /** A machine as MOTIR-6939 leaves it: the terminal process, service, env and stamp. */
  const CURRENT_CONFIG = {
    image: SPEC.image,
    guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 },
    env: { MOTIR_INSTANCE_ID: 'cmInstance1', MOTIR_TERMINAL_KEY: 'derived-key' },
    init: { cmd: TERMINAL.command },
    services: [FLY_SERVICE],
    metadata: {
      [INSTANCE_METADATA_KEY]: 'cmInstance1',
      motir_org_id: ORG,
      [MACHINE_CONFIG_METADATA_KEY]: '1',
      [TERMINAL_KEY_ID_METADATA_KEY]: 'kid-1',
    },
    mounts: [{ volume: 'vol_1', path: '/home/node', name: 'home_x', size_gb: 10 }],
    auto_destroy: false,
    restart: { policy: 'on-failure' },
    // A field Motir does not model: a read-modify-write keeps it.
    dns: { skip_registration: false },
  };

  function machineHandler(state: string, config: Record<string, unknown> | null = CURRENT_CONFIG) {
    return (call: Call) => {
      if (call.method === 'GET' && call.url === `${API}/apps/${APP}/machines/m-1`)
        return config
          ? json(200, { ...flyMachine(state), version: 'ver-9', config })
          : json(404, { error: 'not found' });
      if (call.method === 'POST' && call.url === `${API}/apps/${APP}/machines/m-1`)
        return json(200, flyMachine(state));
      return json(500, { error: 'unexpected' });
    };
  }

  it('moves a RUNNING machine with ONE update: only config.image changes, and the launch is not skipped', async () => {
    handler = machineHandler('started');
    await flyPersistentOrchestrator.moveImage(HANDLE, NEW_IMAGE, { launch: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      `GET /apps/${APP}/machines/m-1`,
      `POST /apps/${APP}/machines/m-1`,
    ]);
    const update = calls[1]!.body!;
    expect(update['config']).toEqual({ ...CURRENT_CONFIG, image: NEW_IMAGE });
    expect(update).not.toHaveProperty('skip_launch');
    expect(update['current_version']).toBe('ver-9');
    // Every field but the image is byte-identical to what Fly returned.
    const sent = { ...(update['config'] as Record<string, unknown>) };
    delete sent['image'];
    const read: Record<string, unknown> = { ...CURRENT_CONFIG };
    delete read['image'];
    expect(JSON.stringify(sent)).toBe(JSON.stringify(read));
    expect(calls.some((c) => c.url.endsWith('/start'))).toBe(false);
  });

  it('moves a STOPPED machine with the same single update and skip_launch, and never starts it', async () => {
    handler = machineHandler('stopped');
    await flyPersistentOrchestrator.moveImage(HANDLE, NEW_IMAGE, { launch: false });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const update = calls[1]!.body!;
    expect(update['skip_launch']).toBe(true);
    expect((update['config'] as Record<string, unknown>)['mounts']).toEqual(CURRENT_CONFIG.mounts);
    expect((update['config'] as Record<string, unknown>)['image']).toBe(NEW_IMAGE);
    expect(calls.some((c) => c.url.endsWith('/start'))).toBe(false);
  });

  it('surfaces a refused update as OrchestratorApiError with the provider detail, and sends no second request', async () => {
    const base = machineHandler('started');
    handler = (call) =>
      call.method === 'POST' && call.url.endsWith('/machines/m-1')
        ? json(409, { error: 'version mismatch' })
        : base(call);
    const err = await flyPersistentOrchestrator
      .moveImage(HANDLE, NEW_IMAGE, { launch: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect((err as Error).message).toContain('version mismatch');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('throws for a machine that is gone, sending no update', async () => {
    handler = machineHandler('started', null);
    await expect(
      flyPersistentOrchestrator.moveImage(HANDLE, NEW_IMAGE, { launch: true }),
    ).rejects.toThrow(OrchestratorApiError);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('omits current_version when the machine reports none', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json(200, { id: 'm-1', state: 'started', config: CURRENT_CONFIG })
        : json(200, flyMachine('started'));
    await flyPersistentOrchestrator.moveImage(HANDLE, NEW_IMAGE, { launch: true });
    expect(calls[1]!.body).not.toHaveProperty('current_version');
  });

  it('describePersistent names the image the machine config carries, and null once it is gone', async () => {
    handler = () => json(200, { ...flyMachine('started'), config: { image: NEW_IMAGE } });
    expect((await flyPersistentOrchestrator.describePersistent(HANDLE)).image).toBe(NEW_IMAGE);
    handler = () => json(200, flyMachine('started'));
    expect((await flyPersistentOrchestrator.describePersistent(HANDLE)).image).toBeNull();
    handler = () => json(404, { error: 'not found' });
    expect((await flyPersistentOrchestrator.describePersistent(HANDLE)).image ?? null).toBeNull();
  });
});

describe('checkLiveness — is the coding agent alive on the new image? (MOTIR-6950)', () => {
  const LIVENESS = ['claude', '--version'];

  it('answers alive for exit 0, running the command through exec with the 60-second bound', async () => {
    handler = () => json(200, { exit_code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' });
    expect(await flyPersistentOrchestrator.checkLiveness(HANDLE, LIVENESS)).toEqual({
      alive: true,
    });
    expect(calls[0]).toMatchObject({
      url: `${API}/apps/${APP}/machines/m-1/exec`,
      body: { command: LIVENESS, timeout: 60 },
    });
  });

  it('answers not alive with the exit code and the last line printed, never a throw', async () => {
    handler = () => json(200, { exit_code: 127, stdout: '', stderr: 'sh: claude: not found\n' });
    expect(
      await flyPersistentOrchestrator.checkLiveness(HANDLE, LIVENESS, { timeoutSeconds: 5 }),
    ).toEqual({
      alive: false,
      reason: 'exit',
      exitCode: 127,
      detail: 'claude --version exited 127 (sh: claude: not found)',
    });
    expect(calls[0]!.body).toMatchObject({ timeout: 5 });
  });

  it('answers timeout for the provider’s 408, and unreachable for any other refusal', async () => {
    handler = () => json(408, { error: 'deadline exceeded' });
    expect(await flyPersistentOrchestrator.checkLiveness(HANDLE, LIVENESS)).toMatchObject({
      alive: false,
      reason: 'timeout',
    });
    handler = () => json(412, { error: 'machine not started' });
    const answer = await flyPersistentOrchestrator.checkLiveness(HANDLE, LIVENESS);
    expect(answer).toMatchObject({ alive: false, reason: 'unreachable' });
    expect(answer.alive === false && answer.detail).toContain('machine not started');
  });
});
