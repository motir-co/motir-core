import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as route from '@/app/api/mcp/route';
import type { RateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import { mcpBudget } from '@/lib/rateLimit/budgets';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { __setSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { inFlightBackends } from '../helpers/inFlightWork';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';
import {
  currentWindowStart,
  headroomIsSatisfied,
  waitForWindowHeadroom,
} from '../helpers/rateLimitWindow';
import { pendingServerWork, settleServerWork } from '../helpers/serverWork';

// MOTIR-6324 — the MCP transport tests' `idle in transaction` leftovers,
// REPRODUCED deterministically, and the harness fix that removes them.
//
// THE MECHANISM. After `initialize`, the SDK client's
// `StreamableHTTPClientTransport` answers the `notifications/initialized` 202 by
// opening its optional SSE stream: a GET it starts and never awaits. In-process,
// that GET is a real route call — the token check (a `withSystemContext`
// transaction) and one `mcp:call` spent (a `$transaction` INSERT into
// `rate_limit_counter`) before the route answers 405. Nothing waits for it, so a
// test that finishes quickly ends while it is still inside one of those
// transactions, and the in-flight probe fails that test. The CI leftovers were
// the three stages of it: `BEGIN`, the counter `INSERT`, and `COMMIT`.
//
// THE REPRODUCTION. On CI the window is a few milliseconds under load. Here it is
// widened on purpose: the counter write is the REAL repository statement inside
// a real transaction, which then stays open for HOLD_MS — the same backend state
// (`idle in transaction`, the counter INSERT) the probe named in CI, held long
// enough to observe it every time.

const ENDPOINT = 'http://localhost/api/mcp';
const HOLD_MS = 1_500;

// ── THE WINDOW (MOTIR-6418) ─────────────────────────────────────────────────
// The last case counts the `mcp:call`s the connect spent, and the limiter keys
// every count on an EPOCH-aligned cell of `mcpBudget().windowMs` (60 s shipped).
// Held for HOLD_MS each, the three counted calls run SERIALLY for ~3 × HOLD_MS,
// so a connect started in the last ~4.5 s of a minute split them across two
// rows — `[1, 2]` where `[3]` was asserted, about one run in fourteen on CI,
// red on whichever unrelated PR drew the shard.
//
// So that case first buys this much of the current cell from the shared helper:
// twice the serial span the holds alone impose. Headroom rather than a full
// alignment, because aligning a 60 s window costs ~30 s on average; this costs
// (9 / 60) × 4.5 s ≈ 0.7 s.
const COUNTED_SPAN_HEADROOM_MS = HOLD_MS * 6;

/** The real counter INSERT, whose transaction then stays open for `holdMs`. */
function holdingStore(holdMs: number): RateLimitStore {
  return {
    increment: (key, windowStart, windowMs) =>
      db.$transaction(
        async (tx) => {
          const count = await rateLimitCounterRepository.increment(
            key,
            BigInt(windowStart),
            new Date(windowStart + windowMs),
            tx,
          );
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          return count;
        },
        { timeout: holdMs * 10 },
      ),
  };
}

/** The pre-fix harness: the route handler called in-process, NOT tracked. */
function untrackedRouteFetch(token: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(String(input), { ...init, headers }) as never);
  }) as unknown as typeof fetch;
}

/**
 * Wrap a fetch so the test can see which methods the SDK client sent — and, when
 * `gets` is given, keep the promise of each GET, so a test can wait for the GET
 * itself without the harness tracking it (MOTIR-9634).
 */
function recording(
  base: typeof fetch,
  methods: string[],
  gets?: Array<Promise<Response>>,
): typeof fetch {
  return ((input: unknown, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    methods.push(method);
    const res = base(input as never, init);
    if (method === 'GET') gets?.push(res);
    return res;
  }) as typeof fetch;
}

async function connectWith(fetchImpl: typeof fetch): Promise<Client> {
  const client = new Client({ name: 'sdk-sse-get-settled', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: fetchImpl }));
  return client;
}

async function fullToken(): Promise<string> {
  return (await fixtureAndToken()).token;
}

async function fixtureAndToken(): Promise<{ fx: WorkItemFixture; token: string }> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'sdk-sse-get',
    fixedGrant: [...GRANTABLE_PERMISSIONS],
  });
  return { fx, token };
}

/**
 * Connect, wait for the settled GET's 405, and return the `mcp:call` counts the
 * connect left behind — one per window row, oldest window first.
 */
async function spentOnConnect(fx: WorkItemFixture, token: string): Promise<number[]> {
  const statuses: number[] = [];
  const base = mcpRouteFetch(token);
  const observing = (async (input: unknown, init: RequestInit = {}) => {
    const res = await base(input as never, init);
    if ((init.method ?? 'GET').toUpperCase() === 'GET') statuses.push(res.status);
    return res;
  }) as typeof fetch;

  await connectWith(observing);
  await vi.waitFor(() => expect(statuses).toEqual([405]), { timeout: HOLD_MS * 4 });
  const rows = await adminDb.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count::int AS count FROM "rate_limit_counter" WHERE key = $1 ORDER BY window_start`,
    // Keyed on the presented credential since MOTIR-8601.
    rateLimitKey('mcp:call', fx.workspaceId, tokenFingerprint(token)),
  );
  return rows.map((r) => r.count);
}

/**
 * Shift `Date.now` so the current `windowMs` cell has `remainingMs` left — always
 * FORWARD, by less than one window. Restored by `vi.restoreAllMocks` in
 * `afterEach`. Built on the helper's `currentWindowStart`, not on a phase
 * expression of its own (the alignment guard forbids a second copy).
 */
function placeClockBeforeBoundary(windowMs: number, remainingMs: number): void {
  const realNow = Date.now.bind(Date);
  let target = currentWindowStart(windowMs) + windowMs - remainingMs;
  if (target <= realNow()) target += windowMs;
  const offset = target - realNow();
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
}

const counterInsertStillOpen = async (): Promise<boolean> =>
  (await inFlightBackends()).some(
    (b) => b.state === 'idle in transaction' && b.query.includes('rate_limit_counter'),
  );

beforeEach(async () => {
  await truncateAuthTables();
  __setSharedRateLimitStoreForTest(holdingStore(HOLD_MS));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the SDK client leaves its SSE-stream GET running after connect (MOTIR-6324)', () => {
  it('REPRODUCTION: with an untracked harness, connect returns while the GET is inside its rate-limit transaction', async () => {
    const methods: string[] = [];
    const gets: Array<Promise<Response>> = [];
    await connectWith(recording(untrackedRouteFetch(await fullToken()), methods, gets));

    // Connect has returned, and the client sent a GET it is not waiting for.
    await vi.waitFor(() => expect(methods).toContain('GET'), { timeout: HOLD_MS });
    // That GET is now holding the counter INSERT's transaction open — the
    // backend the probe reported in CI — and the harness has no handle on it.
    await vi.waitFor(async () => expect(await counterInsertStillOpen()).toBe(true), {
      timeout: HOLD_MS,
    });
    expect(pendingServerWork()).toBe(0);

    // This test must not leak it: wait for the GET ITSELF before ending — its
    // 405, the answer `spentOnConnect` waits for too. An empty reading of the
    // backends is not enough on its own (MOTIR-9634): the limiter spends the
    // agent's limb and then the workspace's, two held transactions one after
    // the other, so the probe can read `[]` in the gap between them and the test
    // would end while the second is opening — the `BEGIN` / counter `INSERT`
    // leftover CI reported.
    expect(gets).toHaveLength(1);
    expect((await gets[0]).status).toBe(405);
    expect(await inFlightBackends()).toEqual([]);
  });

  it('FIX: the shared harness tracks the GET, and settling it leaves no backend behind', async () => {
    const methods: string[] = [];
    await connectWith(recording(mcpRouteFetch(await fullToken()), methods));

    await vi.waitFor(() => expect(methods).toContain('GET'), { timeout: HOLD_MS });
    await vi.waitFor(async () => expect(await counterInsertStillOpen()).toBe(true), {
      timeout: HOLD_MS,
    });
    // The same GET, the same open transaction — but now the harness holds it.
    expect(pendingServerWork()).toBe(1);

    await settleServerWork();

    expect(pendingServerWork()).toBe(0);
    expect(await inFlightBackends()).toEqual([]);
  });

  it(
    'the settled GET still ran the real gates: it was answered 405 after spending one mcp:call',
    async () => {
      const { fx, token } = await fixtureAndToken();

      await waitForWindowHeadroom(mcpBudget().windowMs, COUNTED_SPAN_HEADROOM_MS);
      // initialize + notifications/initialized + the GET: three spent, none skipped.
      expect(await spentOnConnect(fx, token)).toEqual([3]);
    },
    COUNTED_SPAN_HEADROOM_MS + HOLD_MS * 8,
  );
});

// MOTIR-6418 — the case above, asserted at the phase that used to break it. The
// clock is PLACED rather than waited for: `Date.now` (which is what the limiter
// and the helper both read) is shifted so the cell has HALF a hold left when the
// connect starts — the first counted call lands in the outgoing cell and the
// other two in the next one, every run.
describe('the three mcp:calls of a connect are counted in ONE window (MOTIR-6418)', () => {
  it(
    'REPRODUCTION: started near the end of a cell with no headroom, the count splits across two rows',
    async () => {
      const { fx, token } = await fixtureAndToken();
      placeClockBeforeBoundary(mcpBudget().windowMs, HOLD_MS / 2);

      // Exactly the `[1, 2]` CI reported — the defect, not a flake of the test.
      expect(await spentOnConnect(fx, token)).toEqual([1, 2]);
    },
    HOLD_MS * 8,
  );

  it(
    'FIX: at the same phase, the headroom wait moves the connect into a cell that holds all three',
    async () => {
      const { fx, token } = await fixtureAndToken();
      const windowMs = mcpBudget().windowMs;
      placeClockBeforeBoundary(windowMs, HOLD_MS / 2);

      // The cell really is too short — so the wait below is the thing under test,
      // not a no-op that happened to pass.
      expect(headroomIsSatisfied(windowMs, COUNTED_SPAN_HEADROOM_MS)).toBe(false);
      await waitForWindowHeadroom(windowMs, COUNTED_SPAN_HEADROOM_MS);

      expect(await spentOnConnect(fx, token)).toEqual([3]);
    },
    HOLD_MS * 8,
  );
});
