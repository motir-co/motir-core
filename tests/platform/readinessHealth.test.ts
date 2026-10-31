import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Db from '@/lib/db';
import type * as ReadyRoute from '@/app/api/health/ready/route';
import type * as Readiness from '@/lib/services/readinessService';

/**
 * IS A FRESHLY STARTED PROCESS WARM ENOUGH FOR TRAFFIC? (Bug MOTIR-8231)
 *
 * The production failure was a machine 15 s old whose first webhook waited for
 * connections the pool had not opened yet. So the property under test is about a
 * FRESH PROCESS: the route answers non-200 until the pool behind `@/lib/db` holds
 * at least the warm-up's number of OPEN connections, and 200 after.
 *
 * ⚠️ A FRESH MODULE INSTANCE, BUILT THE PRODUCTION WAY. This file's own
 * `@/lib/db` has been used by whatever ran before it, and outside production that
 * module reuses a client stashed on `globalThis` — so a plain import would read a
 * pool that is already warm and pass on unfixed code. Each test clears the stash,
 * stubs `NODE_ENV=production` and re-imports the route with `vi.resetModules()`,
 * which is what a newly booted machine evaluates: a new client, a new pool with
 * nothing open, and a readiness flag that has never been set. The same shape as
 * `tests/monitoring/transactionStall.moduleInstances.test.ts`.
 *
 * ⚠️ THE POLLS MEASURE READINESS, NOT TRANSFORM TIME (Bug MOTIR-10152). The
 * warm-up's first step is `import('@/lib/services/githubWebhookService')`, the
 * webhook route's whole service graph. The first test to evaluate it used to pay
 * for TRANSFORMING that graph inside its 15 s poll — about 14 s of it on its own,
 * and past 15 s once other test files shared the CPU, so it failed with
 * `expected 503 to be 200` on unchanged code. `vi.resetModules()` empties the
 * module REGISTRY, not the transform cache, so `beforeAll` below imports the same
 * graph once, under the hook's own budget: each fresh process still EVALUATES
 * everything anew — a new client, a new pool, a readiness flag never set — and
 * the poll is left measuring the warm-up rather than the compiler.
 */

/** The cold transform of the graphs `freshProcess()` and the warm-up import. */
const TRANSFORM_BUDGET_MS = 120_000;

interface FreshProcess {
  route: typeof ReadyRoute;
  readiness: typeof Readiness;
  db: typeof Db;
}

const opened: FreshProcess[] = [];

interface LoopbackServer {
  port: number;
  /** The path of every request it received, in order. */
  requests: string[];
  close: () => Promise<void>;
}

const servers: LoopbackServer[] = [];

/**
 * A real HTTP server on loopback answering every request with `status` — the
 * stand-in for the Next server the warm-up page is rendered by (MOTIR-10142).
 */
async function loopbackServer(status: number): Promise<LoopbackServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const handle: LoopbackServer = {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            closed = true;
            server.close(() => resolve());
          }),
  };
  servers.push(handle);
  return handle;
}

async function freshProcess(env: Record<string, string> = {}): Promise<FreshProcess> {
  const stash = globalThis as { prisma?: unknown; prismaPool?: unknown };
  const saved = { prisma: stash.prisma, prismaPool: stash.prismaPool };
  delete stash.prisma;
  delete stash.prismaPool;
  vi.stubEnv('NODE_ENV', 'production');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  try {
    vi.resetModules();
    // One graph: the route, the service it calls and the `lib/db` they share.
    const route = await import('@/app/api/health/ready/route');
    const readiness = await import('@/lib/services/readinessService');
    const db = await import('@/lib/db');
    const proc = { route, readiness, db };
    opened.push(proc);
    return proc;
  } finally {
    vi.unstubAllEnvs();
    Object.assign(stash, saved);
  }
}

async function read(
  proc: FreshProcess,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await proc.route.GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  // Each fresh process built its own pool; end them so the test leaves no
  // connections behind (a planted-client run would leave `dbPool()` null).
  await Promise.all(
    opened.splice(0).map(async (p) => {
      const pool = p.db.dbPool();
      if (pool && !pool.ended) await pool.end();
    }),
  );
});

beforeAll(async () => {
  // Transform-only warm-up of the modules a fresh process loads (see the header):
  // nothing here is read by a test, and every test re-evaluates them from scratch.
  await import('@/lib/services/githubWebhookService');
  await import('@/app/api/health/ready/route');
}, TRANSFORM_BUDGET_MS);

describe('GET /api/health/ready', () => {
  it('answers 503 on a fresh process, and 200 only once the pool holds the warm-up connections open', async () => {
    const proc = await freshProcess();
    const pool = proc.db.dbPool()!;
    const warm = proc.readiness.WARM_CONNECTIONS;
    expect(warm).toBeGreaterThan(1);
    // A freshly booted process has opened nothing — the precondition of the bug.
    expect(pool.totalCount).toBe(0);

    const first = await read(proc);
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ state: 'warming', warmConnections: warm });
    expect(first.body['openConnections']).toBeLessThan(warm);

    // Fly polls on an interval; so does this. Every answer before the 200 is a
    // 503, and the 200 arrives with the pool holding the warm-up's connections.
    let last = first;
    await expect
      .poll(
        async () => {
          last = await read(proc);
          if (last.status !== 200) expect(last.status).toBe(503);
          return last.status;
        },
        { timeout: 15_000, interval: 50 },
      )
      .toBe(200);
    expect(pool.totalCount).toBeGreaterThanOrEqual(warm);
    expect(last.body).toMatchObject({ state: 'ready', warmConnections: warm });
    expect(last.body['openConnections']).toBeGreaterThanOrEqual(warm);
  }, 30_000);

  it('stays 200 once ready, even after the pool lets its idle connections go', async () => {
    // `pg.Pool` closes a connection idle for 10 s. Re-checking the count would
    // pull a healthy machine out of rotation whenever its traffic paused.
    const proc = await freshProcess();
    await expect.poll(async () => (await read(proc)).status, { timeout: 15_000 }).toBe(200);
    const pool = proc.db.dbPool()!;
    await pool.end();
    expect(pool.totalCount).toBe(0);
    expect((await read(proc)).status).toBe(200);
  }, 30_000);

  it('keeps answering 503 while the database cannot be reached, and retries on the next check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Port 1 on loopback refuses at once, so every warm-up attempt fails fast.
    const proc = await freshProcess({ DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/none' });

    expect((await read(proc)).status).toBe(503);
    await expect.poll(() => error.mock.calls.length, { timeout: 15_000 }).toBeGreaterThan(0);
    // The failed attempt is over; the next check starts another rather than
    // reporting ready on a warm-up that never connected.
    expect((await read(proc)).status).toBe(503);
    await expect.poll(() => error.mock.calls.length, { timeout: 15_000 }).toBeGreaterThan(1);
    expect((await read(proc)).body).toMatchObject({ state: 'warming' });
  }, 40_000);

  it('renders the page warm-up over loopback on PORT before it answers 200 (MOTIR-10142)', async () => {
    // A stand-in for the page runtime, on loopback where the warm-up looks for it.
    const page = await loopbackServer(200);
    const proc = await freshProcess();
    vi.stubEnv('PORT', String(page.port));

    expect((await read(proc)).status).toBe(503);
    await expect.poll(async () => (await read(proc)).status, { timeout: 15_000 }).toBe(200);
    // One render of the warm-up page, finished before the first 200 was answered.
    expect(page.requests).toEqual([proc.readiness.PAGE_WARM_UP_PATH]);
  }, 30_000);

  it('goes ready anyway when the warm-up page answers an error, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = await loopbackServer(500);
    const proc = await freshProcess();
    vi.stubEnv('PORT', String(page.port));

    await expect.poll(async () => (await read(proc)).status, { timeout: 15_000 }).toBe(200);
    expect(page.requests).toEqual([proc.readiness.PAGE_WARM_UP_PATH]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered 500; pages stay cold'));
  }, 30_000);

  it('goes ready anyway when nothing answers on loopback, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A port that was just listening and is closed now: the connection is refused.
    const closed = await loopbackServer(200);
    await closed.close();
    const proc = await freshProcess();
    vi.stubEnv('PORT', String(closed.port));

    await expect.poll(async () => (await read(proc)).status, { timeout: 15_000 }).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be rendered; pages stay cold'),
      expect.anything(),
    );
  }, 30_000);

  it('is never cached', async () => {
    const proc = await freshProcess();
    const res = await proc.route.GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
