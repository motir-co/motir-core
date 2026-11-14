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
export const FLY_GRAPHQL = 'https://api.fly.io/graphql';

/** A deploy token the sim minted for an app, as Fly's GraphQL lists it. */
export interface SimToken {
  id: string;
  revokedAt: string | null;
}

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
    instance_id: m.version,
    created_at: '2026-10-28T00:00:00.000Z',
    config: m.config,
    events: m.events,
    checks: m.checks,
  };
}

export interface HostingFlySim {
  readonly calls: FlyCall[];
  readonly apps: Map<string, SimMachine[]>;
  /** Each app's deploy tokens, minted through `/deploy_token` (MOTIR-5775). */
  readonly tokens: Map<string, SimToken[]>;
  /** Answer a call before the simulator does; return null to pass. */
  readonly overrides: Array<(call: FlyCall) => Response | null>;
  /** The exit statuses the next one-off Machines stop with, in order (0 when
   *  empty) — what `/wait?state=stopped` answers for a command Machine. */
  readonly exitCodes: number[];
  /** How a release Machine's write settles (MOTIR-11250). Fly applies a create
   *  or update asynchronously: the Machine is `created` / `replacing` until a
   *  `/wait` lets it settle, and a write meanwhile is refused 409 "machine is
   *  replacing". `stallWaits` is how many waits answer 408 before it settles;
   *  `settleState` is the state it settles in (`started` unless a test says). */
  readonly release: { stallWaits: number; settleState: string };
  /** A `fetch` to stub globally. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A fresh simulator; `clock` stamps the events it records. */
export function createHostingFlySim(clock: () => number): HostingFlySim {
  const calls: FlyCall[] = [];
  const apps = new Map<string, SimMachine[]>();
  const tokens = new Map<string, SimToken[]>();
  const overrides: Array<(call: FlyCall) => Response | null> = [];
  const exitCodes: number[] = [];
  const release = { stallWaits: 0, settleState: 'started' };
  let seq = 0;

  const isCommand = (config: Record<string, unknown> | undefined) =>
    (config?.['metadata'] as Record<string, unknown> | undefined)?.['motir_hosting'] === 'command';
  const APPLYING = new Set(['created', 'replacing']);

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
    if (parts[2] === 'deploy_token') {
      seq += 1;
      tokens.set(app, [...(tokens.get(app) ?? []), { id: `tok-${seq}`, revokedAt: null }]);
      return flyJson(200, { token: `fly-deploy-${app}` });
    }
    if (parts[2] !== 'machines') return flyJson(500, { error: `unhandled ${call.path}` });
    const id = parts[3];
    if (!id) {
      if (call.method === 'GET') return flyJson(200, machines.map(machineBody));
      seq += 1;
      const config = call.body?.['config'] as Record<string, unknown>;
      const m: SimMachine = {
        id: `m-${seq}`,
        // A release Machine is `created` until a wait settles it; a one-off
        // command Machine runs at once.
        state: isCommand(config) ? 'started' : 'created',
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
    if (parts[4] === 'wait' && !isCommand(m.config)) {
      const query = new URLSearchParams(call.path.split('?')[1] ?? '');
      const instance = query.get('instance_id');
      if (instance && instance !== m.version) {
        return flyJson(400, { error: `instance ${instance} is not the machine's current one` });
      }
      if (APPLYING.has(m.state)) {
        if (release.stallWaits > 0) {
          release.stallWaits -= 1;
          return flyJson(408, { error: 'deadline_exceeded: machine did not reach the state' });
        }
        m.state = release.settleState;
      }
      return m.state === query.get('state')
        ? flyJson(200, { ok: true })
        : flyJson(408, { error: 'deadline_exceeded: machine did not reach the state' });
    }
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
    if (APPLYING.has(m.state)) {
      return flyJson(409, {
        error: 'aborted: machine is replacing: concurrent update in progress',
      });
    }
    const current = call.body?.['current_version'];
    if (current && current !== m.version) return flyJson(409, { error: 'version mismatch' });
    seq += 1;
    m.state = 'replacing';
    m.version = `v${seq}`;
    m.config = call.body?.['config'] as Record<string, unknown>;
    m.versions.push({ version: m.version, user_config: m.config });
    m.events.push({ type: 'start', status: 'started', timestamp: clock() });
    return flyJson(200, machineBody(m));
  }

  /** The two GraphQL calls the adapter makes: an app's tokens, and a revoke. */
  function graphql(call: FlyCall): Response {
    for (const o of overrides) {
      const res = o(call);
      if (res) return res;
    }
    const query = String(call.body?.['query']);
    const variables = (call.body?.['variables'] ?? {}) as Record<string, unknown>;
    if (query.includes('limitedAccessTokens')) {
      const app = String(variables['appName']);
      if (!apps.has(app)) {
        return flyJson(200, { data: { app: null }, errors: [{ message: 'Could not find App' }] });
      }
      return flyJson(200, {
        data: { app: { limitedAccessTokens: { nodes: tokens.get(app) ?? [] } } },
      });
    }
    if (query.includes('deleteLimitedAccessToken')) {
      const id = String((variables['input'] as Record<string, unknown>)['id']);
      const token = [...tokens.values()].flat().find((t) => t.id === id);
      if (!token) return flyJson(200, { data: null, errors: [{ message: 'token not found' }] });
      token.revokedAt = new Date(clock()).toISOString();
      return flyJson(200, { data: { deleteLimitedAccessToken: { token: id } } });
    }
    return flyJson(400, { error: 'unhandled query' });
  }

  return {
    calls,
    apps,
    tokens,
    overrides,
    exitCodes,
    release,
    async fetch(url, init) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: FlyCall = {
        path: url === FLY_GRAPHQL ? '/graphql' : url.slice(FLY_API.length),
        method: init.method ?? 'GET',
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        auth: headers['authorization'] ?? null,
      };
      calls.push(call);
      return url === FLY_GRAPHQL ? graphql(call) : simulate(call);
    },
  };
}
