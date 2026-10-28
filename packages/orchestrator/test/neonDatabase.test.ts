import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseApplicationRefInvalidError,
  DatabaseNotFoundError,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  createNeonDatabasePort,
  neonDatabaseConfig,
} from '../src/index';
import {
  NEON_SIM_KEY,
  NEON_SIM_ORG,
  NEON_SIM_STORAGE_BYTES,
  createNeonApiSim,
  uriOf,
} from './contract/neonApiSim';
import { runDatabasePortContract } from './databasePortContract';

// MOTIR-9973 — the Neon adapter on the database port: the shared contract over a
// scripted Neon API, then what only this adapter promises — the project per
// application and its name, usage before delete, the refusals before any
// request, retries, and no connection string or key anywhere but where it
// belongs.

const START = Date.parse('2026-10-28T00:00:00.000Z');
const CONFIG = { apiKey: NEON_SIM_KEY, orgId: NEON_SIM_ORG, region: 'aws-us-east-1' };

function setup() {
  let clock = START;
  const sim = createNeonApiSim(() => clock);
  const sleep = vi.fn(async () => {});
  const port = createNeonDatabasePort(CONFIG, {
    fetch: sim.fetch,
    now: () => new Date(clock),
    sleep,
  });
  return {
    sim,
    port,
    sleep,
    advanceSeconds(seconds: number) {
      clock += seconds * 1000;
    },
  };
}

runDatabasePortContract('neon', () => {
  const { port, advanceSeconds } = setup();
  return { port, advanceSeconds };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('neonDatabaseConfig', () => {
  it('names an unset variable and never its value', () => {
    vi.stubEnv('MOTIR_HOSTING_NEON_API_KEY', '');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', 'org-x');
    expect(() => neonDatabaseConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => neonDatabaseConfig()).toThrow(/set MOTIR_HOSTING_NEON_API_KEY/);
    vi.stubEnv('MOTIR_HOSTING_NEON_API_KEY', 'napi_value_must_not_show');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', '');
    const error = (() => {
      try {
        neonDatabaseConfig();
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a refusal');
    })();
    expect(error.message).toMatch(/MOTIR_HOSTING_NEON_ORG_ID/);
    expect(error.message).not.toContain('napi_value_must_not_show');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', NEON_SIM_ORG);
    expect(neonDatabaseConfig()).toEqual({
      apiKey: 'napi_value_must_not_show',
      orgId: NEON_SIM_ORG,
      region: 'aws-us-east-1',
    });
  });
});

describe('the Neon adapter', () => {
  it('creates one project per application, named mh-<ref>, and a second create sends no POST', async () => {
    const { port, sim } = setup();
    const first = await port.createDatabase({ applicationRef: 'r1-production' });
    expect(first.handle).toEqual({
      provider: 'neon',
      applicationRef: 'r1-production',
      databaseRef: 'proj-1',
    });
    const project = sim.projects.get('proj-1')!;
    expect(first.env).toEqual([
      { name: 'DATABASE_URL', value: uriOf(project, true), secret: true },
      { name: 'DIRECT_URL', value: uriOf(project, false), secret: true },
    ]);
    const post = sim.calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({
      project: {
        name: 'mh-r1-production',
        org_id: NEON_SIM_ORG,
        region_id: 'aws-us-east-1',
        branch: { database_name: 'app', role_name: 'app' },
      },
    });
    const posts = sim.calls.length;
    const second = await port.createDatabase({ applicationRef: 'r1-production', region: 'x' });
    expect(second).toEqual(first);
    expect(sim.calls.slice(posts).some((c) => c.method === 'POST')).toBe(false);
    expect(sim.live()).toHaveLength(1);

    await port.createDatabase({ applicationRef: 'r2', region: 'aws-eu-central-1' });
    expect(sim.projects.get('proj-2')!.regionId).toBe('aws-eu-central-1');
  });

  it('deletes with usage, leaves the organisation empty, and a second delete is zero', async () => {
    const { port, sim, advanceSeconds } = setup();
    const { handle } = await port.createDatabase({ applicationRef: 'r1' });
    advanceSeconds(600);
    const usage = await port.deleteDatabase(handle);
    expect(usage).toEqual({
      provider: 'neon',
      applicationRef: 'r1',
      since: new Date(START),
      until: new Date(START + 600_000),
      computeSeconds: 600,
      storageBytes: NEON_SIM_STORAGE_BYTES,
    });
    expect(sim.live()).toEqual([]);
    expect(await port.list()).toEqual([]);
    expect(await port.deleteDatabase(handle)).toMatchObject({ computeSeconds: 0, storageBytes: 0 });
  });

  it('a failed usage read throws and sends no delete, leaving the project', async () => {
    const { port, sim } = setup();
    const { handle } = await port.createDatabase({ applicationRef: 'r1' });
    sim.failNext((c) => c.url.pathname.endsWith('/consumption_history/v2/projects'), 403, {
      code: 'FORBIDDEN',
      message: 'not on this plan',
    });
    await expect(port.deleteDatabase(handle)).rejects.toMatchObject({
      name: 'OrchestratorApiError',
      provider: 'neon',
      status: 403,
    });
    sim.failNext((c) => c.url.pathname.endsWith('/branches'), 400);
    await expect(port.deleteDatabase(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(sim.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(sim.live()).toHaveLength(1);
  });

  it('refuses a ref with no valid project name before any request', async () => {
    const { port, sim } = setup();
    for (const ref of ['', ' r1', 'R1', 'r1-', 'r_1', 'a'.repeat(201)]) {
      await expect(port.createDatabase({ applicationRef: ref })).rejects.toBeInstanceOf(
        DatabaseApplicationRefInvalidError,
      );
    }
    expect(sim.calls).toEqual([]);
  });

  it('a handle whose project is another application’s is not found', async () => {
    const { port } = setup();
    const a = await port.createDatabase({ applicationRef: 'r1' });
    await port.createDatabase({ applicationRef: 'r2' });
    const crossed = { ...a.handle, applicationRef: 'r2' };
    await expect(port.connectionEnv(crossed)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    expect(await port.deleteDatabase(crossed)).toMatchObject({ computeSeconds: 0 });
    expect(await port.list()).toHaveLength(2);
  });

  it('reads usage by the hour, the day or the month, by the window’s age', async () => {
    const { port, sim, advanceSeconds } = setup();
    const { handle } = await port.createDatabase({ applicationRef: 'r1' });
    advanceSeconds(100 * 86_400);
    const asked = () => sim.calls.filter((c) => c.url.pathname.includes('consumption')).at(-1)!.url;
    await port.usageSince(handle, new Date(START + 99 * 86_400_000));
    expect(asked().searchParams.get('granularity')).toBe('hourly');
    await port.usageSince(handle, new Date(START + 80 * 86_400_000));
    expect(asked().searchParams.get('granularity')).toBe('daily');
    expect(asked().searchParams.get('from')).toBe('2027-01-16T00:00:00.000Z');
    await port.usageSince(handle, new Date(START + 10 * 86_400_000));
    expect(asked().searchParams.get('granularity')).toBe('monthly');
    expect(asked().searchParams.get('from')).toBe('2026-11-01T00:00:00.000Z');
    expect(asked().searchParams.get('to')).toBe('2027-03-01T00:00:00.000Z');
    expect(asked().searchParams.get('project_ids')).toBe('proj-1');
  });

  it('retries a read through 423, 429, 5xx and a dropped connection, never a create', async () => {
    const { port, sim, sleep } = setup();
    let dropped = false;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!dropped && String(input).includes('connection_uri')) {
        dropped = true;
        throw new TypeError('fetch failed');
      }
      return sim.fetch(input, init);
    }) as typeof fetch;
    const retrying = createNeonDatabasePort(CONFIG, { fetch: flaky, sleep });
    sim.failNext((c) => c.method === 'GET' && c.url.pathname.endsWith('/projects'), 423);
    sim.failNext((c) => c.method === 'GET' && c.url.pathname.endsWith('/projects'), 429);
    sim.failNext((c) => c.method === 'GET' && c.url.pathname.endsWith('/projects'), 502);
    const { handle } = await retrying.createDatabase({ applicationRef: 'r1' });
    expect(sleep).toHaveBeenCalledTimes(4);

    sim.failNext((c) => c.method === 'POST', 503);
    await expect(port.createDatabase({ applicationRef: 'r9' })).rejects.toMatchObject({
      status: 503,
    });
    expect(sim.calls.filter((c) => c.method === 'POST')).toHaveLength(2);

    for (let i = 0; i < 4; i += 1) sim.failNext((c) => c.url.pathname.endsWith('/proj-1'), 500);
    await expect(port.connectionEnv(handle)).rejects.toMatchObject({ status: 500 });

    const down = createNeonDatabasePort(CONFIG, {
      fetch: (async () => {
        throw new TypeError('getaddrinfo ENOTFOUND');
      }) as typeof fetch,
      sleep,
    });
    await expect(down.list()).rejects.toThrow(
      'The neon orchestrator could not be reached (request failed).',
    );
  });

  it('uses the global fetch, the wall clock and a real backoff by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(START);
    const sim = createNeonApiSim(() => Date.now());
    vi.stubGlobal('fetch', sim.fetch);
    const port = createNeonDatabasePort(CONFIG);
    sim.failNext((c) => c.method === 'GET', 503);
    const listing = port.list();
    await vi.runAllTimersAsync();
    expect(await listing).toEqual([]);
    const gone = { provider: 'neon' as const, applicationRef: 'r1', databaseRef: 'proj-9' };
    expect(await port.deleteDatabase(gone)).toMatchObject({ since: new Date(START + 500) });
  });

  it('lists every page of the organisation’s mh- projects and nothing else', async () => {
    const { port, sim } = setup();
    for (let n = 1; n <= 101; n += 1) {
      sim.projects.set(`p${n}`, {
        id: `p${n}`,
        name: `mh-app${n}`,
        orgId: NEON_SIM_ORG,
        regionId: 'aws-us-east-1',
        createdAt: START,
        password: 'x',
        deleted: false,
      });
    }
    sim.projects.set('other', { ...sim.projects.get('p1')!, id: 'other', name: 'not-ours-mh-x' });
    sim.projects.set('foreign', { ...sim.projects.get('p1')!, id: 'foreign', orgId: 'org-else' });
    const listed = await port.list();
    expect(listed).toHaveLength(101);
    expect(listed[100]).toEqual({
      handle: { provider: 'neon', applicationRef: 'app101', databaseRef: 'p101' },
    });
  });

  it('fails typed on answers missing what it needs, and on a project that outlives its delete', async () => {
    const { port, sim } = setup();
    sim.failNext((c) => c.method === 'POST', 201, { project: {} });
    await expect(port.createDatabase({ applicationRef: 'r1' })).rejects.toThrow(
      /project create returned no project/,
    );
    const { handle } = await port.createDatabase({ applicationRef: 'r2' });
    sim.failNext((c) => c.url.pathname.endsWith('/connection_uri'), 200, {});
    await expect(port.connectionEnv(handle)).rejects.toThrow(/returned no URI/);
    sim.failNext((c) => c.method === 'DELETE', 200, {});
    await expect(port.deleteDatabase(handle)).rejects.toThrow(/still present after delete/);
    // A project with no creation time is settled from now.
    sim.failNext(
      (c) => c.method === 'GET' && c.url.pathname.endsWith(`/${handle.databaseRef}`),
      200,
      {
        project: { id: handle.databaseRef, name: 'mh-r2' },
      },
    );
    expect(await port.deleteDatabase(handle)).toMatchObject({ computeSeconds: 0 });
    // Sparse history and branch answers count as nothing measured.
    const { handle: h3 } = await port.createDatabase({ applicationRef: 'r3' });
    sim.failNext((c) => c.url.pathname.includes('consumption'), 200, {
      projects: [
        {
          periods: [
            {
              consumption: [
                {
                  metrics: [
                    { metric_name: 'other', value: 9 },
                    { metric_name: 'compute_unit_seconds' },
                  ],
                },
                {},
              ],
            },
            {},
          ],
        },
        {},
      ],
    });
    sim.failNext((c) => c.url.pathname.endsWith('/branches'), 200, {});
    expect(await port.usageSince(h3, new Date(START))).toMatchObject({
      computeSeconds: 0,
      storageBytes: 0,
    });
    sim.failNext((c) => c.url.pathname.includes('consumption'), 200, {});
    sim.failNext((c) => c.url.pathname.endsWith('/branches'), 200, {
      branches: [{ primary: true }],
    });
    expect(await port.usageSince(h3, new Date(START))).toMatchObject({ computeSeconds: 0 });
    // A deleted-but-recoverable project is gone to the port.
    sim.failNext((c) => c.method === 'GET' && c.url.pathname.endsWith(`/${h3.databaseRef}`), 200, {
      project: { id: h3.databaseRef, name: 'mh-r3', deleted_at: '2026-10-28T00:00:00Z' },
    });
    await expect(port.connectionEnv(h3)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    sim.failNext((c) => c.method === 'GET' && c.url.pathname.endsWith('/projects'), 200, {});
    expect(await port.list()).toEqual([]);
  });

  it('puts no connection string or key in any handle, usage, list entry or error', async () => {
    const { port, sim, advanceSeconds } = setup();
    const a = await port.createDatabase({ applicationRef: 'r1' });
    const b = await port.createDatabase({ applicationRef: 'r2' });
    const secrets = [...a.env, ...b.env].map((pair) => pair.value);
    advanceSeconds(30);
    const errors: unknown[] = [];
    // Error bodies that quote a connection string, and a code that is not one.
    sim.failNext((c) => c.url.pathname.endsWith('/connection_uri'), 500);
    sim.failNext((c) => c.url.pathname.endsWith('/connection_uri'), 500);
    sim.failNext((c) => c.url.pathname.endsWith('/connection_uri'), 500);
    sim.failNext((c) => c.url.pathname.endsWith('/connection_uri'), 500, {
      code: `bad ${secrets[0]}`,
      message: secrets[0],
    });
    await port.connectionEnv(a.handle).catch((e: unknown) => errors.push(e));
    sim.failNext((c) => c.url.pathname.includes('consumption'), 400);
    await port.deleteDatabase(a.handle).catch((e: unknown) => errors.push(e));
    await port
      .connectionEnv({ ...a.handle, databaseRef: 'proj-gone' })
      .catch((e: unknown) => errors.push(e));
    const returned = [
      a.handle,
      b.handle,
      await port.list(),
      await port.usageSince(b.handle, new Date(START)),
      await port.deleteDatabase(a.handle),
    ];
    expect(errors).toHaveLength(3);
    expect((errors[0] as OrchestratorApiError).message).toBe(
      'The neon orchestrator refused a call (HTTP 500).',
    );
    const text = [
      ...returned.map((v) => JSON.stringify(v)),
      ...errors.map((e) => `${(e as Error).message} ${JSON.stringify(e)}`),
    ].join('\n');
    for (const secret of [...secrets, NEON_SIM_KEY]) expect(text).not.toContain(secret);
    // The key travels only in the Authorization header.
    for (const call of sim.calls) {
      expect(call.url.toString()).not.toContain(NEON_SIM_KEY);
      expect(call.body ?? '').not.toContain(NEON_SIM_KEY);
      expect(call.headers['authorization']).toBe(`Bearer ${NEON_SIM_KEY}`);
    }
  });
});
