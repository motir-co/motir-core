import {
  FLEET_CONTAINER_SIZE,
  flyPersistentOrchestrator,
  type PersistentContainerSpec,
} from '../../src/index';
import type {
  PersistentContractHarness,
  PersistentExecBehaviour,
  PersistentExecRecord,
} from './persistentContract';

// The Fly adapter's persistent half behind the shared persistent contract
// (MOTIR-9467), against an in-memory Fly Machines and Volumes API.
//
// The API keeps apps, machines and volumes in maps and answers the endpoints the
// adapter calls the way Fly does: a GET or DELETE of a gone machine or volume is
// a 404, the machine and volume lists of an app that does not exist are a 404, a
// stop of a stopped machine (and a start of a started one) is a 412 the adapter
// must read as its end state, every transition writes an event — NEWEST FIRST,
// as the Machines API orders them — stamped from the harness clock, and an exec
// answers the arranged behaviour, unwrapping the `printf | exec` wrapper the
// adapter uses to deliver stdin. The test file installs `flyPersistentApi` as
// `fetch` and stubs the `FLY_INSTANCES_*` env.

interface StoredMachine {
  id: string;
  app: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  config: { metadata: Record<string, string>; mounts?: Array<{ volume: string; path: string }> };
  events: Array<{ type: string; status: string; timestamp: number }>;
}

interface StoredVolume {
  id: string;
  app: string;
  name: string;
  region: string;
  created_at: string;
  attached_machine_id: string | null;
}

const START = Date.parse('2026-10-24T10:00:00.000Z');

const apps = new Set<string>();
const machines = new Map<string, StoredMachine>();
const volumes = new Map<string, StoredVolume>();
const destroys: string[] = [];
const execs: PersistentExecRecord[] = [];
let sequence = 0;
let clock = START;
let failMachineCreate = false;
let execBehaviour: PersistentExecBehaviour = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOT_FOUND = () => json(404, { error: 'not found' });

function event(machine: StoredMachine, type: string, status: string): void {
  machine.events.unshift({ type, status, timestamp: clock });
}

/** The adapter's stdin wrapper: `sh -c '…printf %s "$p" | exec "$@"' sh <stdin> <argv…>`. */
function unwrap(command: string[]): { command: string[]; stdin?: string } {
  if (command[0] === 'sh' && command[2]?.includes('printf %s "$p"') && command[3] === 'sh') {
    return { command: command.slice(5), stdin: command[4] };
  }
  return { command };
}

function onMachine(
  machine: StoredMachine,
  action: string | undefined,
  method: string,
  body: Record<string, unknown>,
): Response {
  if (action === 'stop' && method === 'POST') {
    if (machine.state === 'stopped')
      return json(412, { error: 'machine is not in a stoppable state' });
    machine.state = 'stopped';
    event(machine, 'exit', 'stopped');
    return json(200, { ok: true });
  }
  if (action === 'start' && method === 'POST') {
    if (machine.state === 'started') return json(412, { error: 'machine is already started' });
    machine.state = 'started';
    event(machine, 'start', 'started');
    return json(200, { ok: true });
  }
  if (action === 'exec' && method === 'POST') {
    const sent = unwrap((body['command'] as string[]) ?? []);
    execs.push({ machineId: machine.id, ...sent });
    if (execBehaviour.hangs) return json(408, { error: 'deadline exceeded' });
    return json(200, {
      exit_code: execBehaviour.exitCode ?? 0,
      stdout: execBehaviour.stdout ?? '',
      stderr: execBehaviour.stderr ?? '',
    });
  }
  return json(400, { error: `unhandled ${method} machine ${action ?? ''}` });
}

function createMachine(app: string, body: Record<string, unknown>): Response {
  if (failMachineCreate) {
    failMachineCreate = false;
    return json(500, { error: 'machine create failed' });
  }
  sequence += 1;
  const config = body['config'] as StoredMachine['config'];
  const machine: StoredMachine = {
    id: `m${sequence}`,
    app,
    name: String(body['name']),
    state: 'started',
    region: String(body['region']),
    created_at: new Date(clock).toISOString(),
    config: {
      metadata: config.metadata ?? {},
      ...(config.mounts ? { mounts: config.mounts } : {}),
    },
    events: [],
  };
  event(machine, 'launch', 'created');
  event(machine, 'start', 'started');
  for (const mount of machine.config.mounts ?? []) {
    const volume = volumes.get(mount.volume);
    if (volume) volume.attached_machine_id = machine.id;
  }
  machines.set(machine.id, machine);
  return json(200, machine);
}

function removeMachine(id: string): boolean {
  if (!machines.delete(id)) return false;
  for (const volume of volumes.values()) {
    if (volume.attached_machine_id === id) volume.attached_machine_id = null;
  }
  return true;
}

/** The in-memory Fly Machines and Volumes API, as a `fetch`. */
export async function flyPersistentApi(input: string | URL, init?: RequestInit): Promise<Response> {
  if (execBehaviour.unreachable && String(input).endsWith('/exec')) {
    throw new TypeError('fetch failed: connect ECONNREFUSED');
  }
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const parts = url.pathname
    .replace(/^\/v1\/apps\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  if (parts.length === 0 && method === 'POST') {
    apps.add(String(body['app_name']));
    return json(201, { ok: true });
  }
  const [app, collection, id, action] = parts as [string, string?, string?, string?];
  if (!collection) return apps.has(app) ? json(200, { name: app }) : NOT_FOUND();
  if (!apps.has(app)) return NOT_FOUND();

  if (collection === 'machines') {
    if (!id && method === 'POST') return createMachine(app, body);
    if (!id)
      return json(
        200,
        [...machines.values()].filter((m) => m.app === app),
      );
    const machine = machines.get(id);
    if (!machine || machine.app !== app) return NOT_FOUND();
    if (!action && method === 'GET') return json(200, machine);
    if (!action && method === 'DELETE') {
      removeMachine(id);
      destroys.push(`machine:${id}`);
      return json(200, { ok: true });
    }
    return onMachine(machine, action, method, body);
  }
  if (collection === 'volumes') {
    if (!id && method === 'POST') {
      sequence += 1;
      const volume: StoredVolume = {
        id: `vol_${sequence}`,
        app,
        name: String(body['name']),
        region: String(body['region']),
        created_at: new Date(clock).toISOString(),
        attached_machine_id: null,
      };
      volumes.set(volume.id, volume);
      return json(200, volume);
    }
    if (!id)
      return json(
        200,
        [...volumes.values()].filter((v) => v.app === app),
      );
    if (method === 'DELETE') {
      const volume = volumes.get(id);
      if (!volume || volume.app !== app) return NOT_FOUND();
      volumes.delete(id);
      destroys.push(`volume:${id}`);
      return json(200, { ok: true });
    }
  }
  return json(400, { error: `unhandled ${method} ${url.pathname}` });
}

const SPEC: PersistentContainerSpec = {
  orgId: 'org-contract',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'inst-contract-a',
  image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'c'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: {},
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
  terminal: null,
};

export function flyPersistentHarness(): PersistentContractHarness {
  return {
    orchestrator: flyPersistentOrchestrator,
    reset() {
      apps.clear();
      machines.clear();
      volumes.clear();
      destroys.length = 0;
      execs.length = 0;
      sequence = 0;
      clock = START;
      failMachineCreate = false;
      execBehaviour = {};
    },
    spec: (overrides = {}) => ({ ...SPEC, ...overrides }),
    advance(ms) {
      clock += ms;
    },
    failNextMachineCreate() {
      failMachineCreate = true;
    },
    setExecBehaviour(behaviour) {
      execBehaviour = behaviour;
    },
    execs: () => [...execs],
    destroyOutOfBand(handle, options = {}) {
      if (options.machine !== false) removeMachine(handle.machineId);
    },
    addUntrackedMachine(app) {
      sequence += 1;
      const machine: StoredMachine = {
        id: `m${sequence}`,
        app,
        name: 'by-hand',
        state: 'started',
        region: 'iad',
        created_at: new Date(clock).toISOString(),
        config: { metadata: {} },
        events: [],
      };
      event(machine, 'start', 'started');
      machines.set(machine.id, machine);
      return machine.id;
    },
    liveMachineIds: (app) => [...machines.values()].filter((m) => m.app === app).map((m) => m.id),
    liveVolumeIds: (app) => [...volumes.values()].filter((v) => v.app === app).map((v) => v.id),
    operationLog: () => [...destroys],
  };
}
