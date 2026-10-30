// An in-memory Fly Machines API for the HOSTING adapter (MOTIR-5773 · MOTIR-9806):
// apps, their Machines, each Machine's config versions, events and checks. Shared
// by the adapter's wire tests (`flyHosting.test.ts`) and the deploy port contract
// suite (`deployPortContract.test.ts`), so both drive the same stub. `fetch` is the
// only fake; every request is recorded, and an override answers a call first.

export interface FlyCall {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

export interface SimMachine {
  id: string;
  state: string;
  version: string;
  config: Record<string, unknown>;
  versions: Array<{ version: string; user_config: Record<string, unknown> }>;
  events: Array<{
    type: string;
    status: string;
    timestamp: number;
    request?: { exit_event: { exit_code: number } };
  }>;
  checks: Array<{ name: string; status: string }>;
}

export const FLY_API = 'https://api.machines.dev/v1';

export function flyJson(status: number, body: unknown): Response {
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

export interface HostingFlySim {
  readonly calls: FlyCall[];
  readonly apps: Map<string, SimMachine[]>;
  /** Answer a call before the simulator does; return null to pass. */
  readonly overrides: Array<(call: FlyCall) => Response | null>;
  /** The exit statuses the next one-off Machines stop with, in order (0 when
   *  empty) — what `/wait?state=stopped` answers for a command Machine. */
  readonly exitCodes: number[];
  /** A `fetch` to stub globally. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A fresh simulator; `clock` stamps the events it records. */
export function createHostingFlySim(clock: () => number): HostingFlySim {
  const calls: FlyCall[] = [];
  const apps = new Map<string, SimMachine[]>();
  const overrides: Array<(call: FlyCall) => Response | null> = [];
  const exitCodes: number[] = [];
  let seq = 0;

  function simulate(call: FlyCall): Response {
    for (const o of overrides) {
      const res = o(call);
      if (res) return res;
    }
    const parts = call.path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
    // ['apps'] · ['apps', app] · ['apps', app, 'machines', id?, 'versions'?]
    if (parts.length === 1 && call.method === 'POST') {
      const name = String(call.body?.['app_name']);
      if (apps.has(name)) return flyJson(422, { error: 'app name already taken' });
      apps.set(name, []);
      return flyJson(201, { id: name });
    }
    const app = parts[1]!;
    const machines = apps.get(app);
    if (parts.length === 2) {
      if (call.method === 'GET')
        return machines ? flyJson(200, { name: app }) : flyJson(404, { error: 'not found' });
      if (call.method === 'DELETE') {
        if (!machines) return flyJson(404, { error: 'not found' });
        apps.delete(app);
        return flyJson(202, {});
      }
    }
    if (!machines) return flyJson(404, { error: 'app not found' });
    if (parts[2] === 'ip_assignments')
      return flyJson(200, call.method === 'GET' ? { ips: [] } : {});
    if (parts[2] === 'deploy_token') return flyJson(200, { token: `fly-deploy-${app}` });
    if (parts[2] !== 'machines') return flyJson(500, { error: `unhandled ${call.path}` });
    const id = parts[3];
    if (!id) {
      if (call.method === 'GET') return flyJson(200, machines.map(machineBody));
      seq += 1;
      const config = call.body?.['config'] as Record<string, unknown>;
      const m: SimMachine = {
        id: `m-${seq}`,
        state: 'started',
        version: `v${seq}`,
        config,
        versions: [{ version: `v${seq}`, user_config: config }],
        events: [{ type: 'start', status: 'started', timestamp: clock() }],
        checks: [{ name: 'health', status: 'passing' }],
      };
      machines.push(m);
      return flyJson(200, machineBody(m));
    }
    const m = machines.find((x) => x.id === id);
    if (!m) return flyJson(404, { error: 'machine not found' });
    if (parts[4] === 'versions') return flyJson(200, [...m.versions].reverse());
    if (parts[4] === 'wait') {
      // The command runs to its end at once: the Machine stops with the next
      // queued exit status.
      m.state = 'stopped';
      m.events.push({
        type: 'exit',
        status: 'stopped',
        timestamp: clock(),
        request: { exit_event: { exit_code: exitCodes.shift() ?? 0 } },
      });
      return flyJson(200, { ok: true });
    }
    if (call.method === 'GET') return flyJson(200, machineBody(m));
    if (call.method === 'DELETE') {
      machines.splice(machines.indexOf(m), 1);
      return flyJson(200, { ok: true });
    }
    const current = call.body?.['current_version'];
    if (current && current !== m.version) return flyJson(409, { error: 'version mismatch' });
    seq += 1;
    m.version = `v${seq}`;
    m.config = call.body?.['config'] as Record<string, unknown>;
    m.versions.push({ version: m.version, user_config: m.config });
    m.events.push({ type: 'start', status: 'started', timestamp: clock() });
    return flyJson(200, machineBody(m));
  }

  return {
    calls,
    apps,
    overrides,
    exitCodes,
    async fetch(url, init) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: FlyCall = {
        path: url.slice(FLY_API.length),
        method: init.method ?? 'GET',
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        auth: headers['authorization'] ?? null,
      };
      calls.push(call);
      return simulate(call);
    },
  };
}
