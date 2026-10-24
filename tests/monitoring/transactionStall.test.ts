import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ErrorEvent } from '@sentry/nextjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbPool } from '@/lib/db';
import {
  BLOCK_THRESHOLD_MS,
  __forTests as watchdogForTests,
} from '@/lib/monitoring/loopBlockWatchdog';
import { PROCESS_PRESSURE_TAG } from '@/lib/monitoring/processPressure';
import { serverBeforeSend, serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import {
  STALL_TAG,
  startTransactionStallMonitor,
  stopTransactionStallMonitor,
  tagTransactionStall,
  transactionStallTags,
  transactionTimeoutHalf,
} from '@/lib/monitoring/transactionStall';

// A P2028 SAYS WHAT THE PROCESS WAS WAITING ON (MOTIR-6701).
//
// Production kept reporting transaction timeouts from code that does almost
// nothing — a primary-key read expired after 10 s — and nothing recorded could
// say whether the event loop was blocked, the pool was exhausted, or the
// database stalled. These tests RECREATE the first two conditions against the
// real Postgres and assert the tags tell them apart. Each has a CONTROL arm: a
// reading that must NOT show the effect when the condition is absent, so a tag
// that always reported "blocked" could not pass.

const TX_BUDGET_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hold the event loop synchronously — the shape of a blocking require, a
 *  synchronous parse, a CPU-bound loop. */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

/** The error a promise rejects with, or a failed assertion if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the transaction to fail with P2028, and it committed');
}

function numericTag(tags: Record<string, string>, key: string): number {
  const value = tags[key];
  expect(value, `${key} should be a number, got ${value}`).toMatch(/^\d+$/);
  return Number(value);
}

beforeEach(() => {
  stopTransactionStallMonitor();
  startTransactionStallMonitor();
});

afterAll(() => {
  stopTransactionStallMonitor();
});

describe('recognising a transaction timeout', () => {
  it('names the half from the message, through a cause chain, and ignores everything else', () => {
    const maxWait = Object.assign(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
      { code: 'P2028' },
    );
    const expired = Object.assign(
      new Error(
        'Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 10228 ms passed since the start of the transaction.',
      ),
      { code: 'P2028' },
    );
    expect(transactionTimeoutHalf(maxWait)).toBe('maxWait');
    expect(transactionTimeoutHalf(expired)).toBe('timeout');
    expect(transactionTimeoutHalf(new Error('translated', { cause: maxWait }))).toBe('maxWait');
    expect(
      transactionTimeoutHalf(Object.assign(new Error('unique'), { code: 'P2002' })),
    ).toBeNull();
    expect(transactionTimeoutHalf(new Error('boom'))).toBeNull();
    expect(transactionTimeoutHalf(undefined)).toBeNull();
    expect(transactionStallTags(new Error('boom'))).toBeNull();
  });
});

describe('the GC / heap / CPU readings (MOTIR-8264)', () => {
  it('ride on a P2028’s tag set and on nothing else', () => {
    const tags = transactionStallTags(Object.assign(new Error('x'), { code: 'P2028' }))!;
    for (const key of Object.values(PROCESS_PRESSURE_TAG)) expect(tags).toHaveProperty(key);
    expect(transactionStallTags(new Error('boom'))).toBeNull();
  });
});

describe('the blocking stack (MOTIR-8265)', () => {
  /** How long past `ms` the block may run while it waits for the capture. */
  const CAPTURE_WAIT_MS = 10_000;
  /** How often the block looks for the capture. */
  const CAPTURE_POLL_MS = 200;

  /**
   * Hold the loop in a NAMED synchronous function the capture can point at — for
   * at least `ms`, and on until the watchdog has recorded a capture of this block.
   *
   * The watchdog does not promise a capture for every block it measures: its
   * worker sees the stale heartbeat only after the threshold, then needs a few
   * inspector round trips, and on a loaded CI runner that can outlast the rest
   * of the block. Then the block reads `unmeasured` (MOTIR-9484), or the pause
   * lands on whatever ran after it (MOTIR-9498). Spinning until the capture is drained —
   * synchronously, as the read does — keeps the pause inside this function, so
   * the test asserts what the capture names rather than how fast the runner is.
   *
   * The spin looks for the capture only every CAPTURE_POLL_MS. Between looks it
   * calls nothing but `Date.now()`, so the pause lands in this frame and not in
   * the helper that looks, which would sit above it on the stack.
   */
  function blockLoopForTest(ms: number): void {
    const capturesBefore = watchdogForTests.captureCount();
    const until = Date.now() + ms;
    const giveUpAt = until + CAPTURE_WAIT_MS;
    let nextLookAt = until;
    for (;;) {
      const now = Date.now();
      if (now < nextLookAt) continue;
      if (watchdogForTests.captureCount() > capturesBefore || now >= giveUpAt) return;
      nextLookAt = Date.now() + CAPTURE_POLL_MS;
    }
  }
  // Long enough past the threshold that the capture has normally landed by the
  // first look, so the pause rarely meets the look itself on the stack.
  const BLOCK_MS = BLOCK_THRESHOLD_MS + 3000;

  it('reads `unmeasured` x3 when nothing blocked the loop — never a zero', () => {
    const tags = transactionStallTags(Object.assign(new Error('x'), { code: 'P2028' }))!;
    expect(tags[STALL_TAG.loopBlockMs]).toBe('unmeasured');
    expect(tags[STALL_TAG.loopBlockFrame]).toBe('unmeasured');
    expect(tags[STALL_TAG.loopBlockAgeS]).toBe('unmeasured');
  });

  it('names the blocking function on a real P2028, read with no await before it', async () => {
    // Warm the client first. Its first transaction instantiates Prisma's query
    // compiler, which can itself hold the loop past the threshold on a loaded
    // runner and take the window's one capture (MOTIR-9499). A fresh watchdog
    // then starts with nothing captured.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });
    stopTransactionStallMonitor();
    startTransactionStallMonitor();
    // The watchdog thread needs a moment to come up and the first heartbeat to land.
    await sleep(300);
    const err = await rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          blockLoopForTest(BLOCK_MS);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: TX_BUDGET_MS },
      ),
    );
    expect(transactionTimeoutHalf(err)).toBe('timeout');

    // Read in the very tick the rejection is handled: the capture was taken
    // during the block and must already be readable, with no sleep to wait on.
    const tags = transactionStallTags(err)!;
    expect(
      watchdogForTests.captureCount(),
      'the watchdog never captured the block',
    ).toBeGreaterThan(0);
    expect(numericTag(tags, STALL_TAG.loopBlockMs)).toBeGreaterThanOrEqual(BLOCK_MS - 100);
    expect(tags[STALL_TAG.loopBlockFrame]).toContain('blockLoopForTest');
    numericTag(tags, STALL_TAG.loopBlockAgeS);

    // The full stack rides in `contexts`, not in a tag.
    const sent = tagTransactionStall({ type: undefined }, { originalException: err });
    const context = (sent.contexts as { loop_block?: { frames: string[]; blockMs: number } })
      .loop_block!;
    expect(context.frames.length).toBeGreaterThan(0);
    expect(context.frames.length).toBeLessThanOrEqual(50);
    expect(context.frames.join('\n')).toContain('blockLoopForTest');
  }, 30_000);

  it('leaves every existing tag in place beside the new ones', async () => {
    const tags = transactionStallTags(Object.assign(new Error('x'), { code: 'P2028' }))!;
    for (const key of Object.values(STALL_TAG)) expect(tags).toHaveProperty(key);
  });
});

describe('the pool behind `db`', () => {
  it('is the pool the adapter would have built — same connection string, pg’s default size', () => {
    const pool = dbPool()!;
    expect(pool.options.connectionString).toBe(process.env['DATABASE_URL']);
    // pg-pool's own default; nothing here configures a size.
    expect(pool.options.max).toBe(10);
  });
});

describe('a transaction that EXPIRED mid-body (the `timeout` half)', () => {
  it('carries every tag, each numeric, from a real P2028', async () => {
    const err = await rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await sleep(TX_BUDGET_MS * 2);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: TX_BUDGET_MS },
      ),
    );
    expect((err as { code?: string }).code).toBe('P2028');

    const tags = transactionStallTags(err)!;
    expect(tags[STALL_TAG.half]).toBe('timeout');
    for (const key of [
      STALL_TAG.loopMaxMs,
      STALL_TAG.loopP99Ms,
      STALL_TAG.poolTotal,
      STALL_TAG.poolIdle,
      STALL_TAG.poolWaiting,
      STALL_TAG.poolMax,
      STALL_TAG.uptimeS,
    ]) {
      numericTag(tags, key);
    }
    expect(tags[STALL_TAG.poolMax]).toBe('10');
  }, 30_000);

  it('reports a BLOCKED event loop as a delay at least as long as the block, with no pool wait', async () => {
    const BLOCK_MS = 800;

    // CONTROL: the same reading with nothing blocked must not look like a stall.
    // (A monitor started this instant has no samples and says `unmeasured`
    // rather than claim a healthy zero — give it a few resolution ticks.)
    await sleep(100);
    const quiet = transactionStallTags(Object.assign(new Error('x'), { code: 'P2028' }))!;
    expect(numericTag(quiet, STALL_TAG.loopMaxMs)).toBeLessThan(BLOCK_MS / 2);

    const err = await rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          blockEventLoop(BLOCK_MS);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: TX_BUDGET_MS },
      ),
    );
    expect(transactionTimeoutHalf(err)).toBe('timeout');

    // Sentry builds and sends an event asynchronously after the throw; one turn
    // of the loop stands in for that, so the histogram has recorded the block.
    await sleep(50);
    const tags = transactionStallTags(err)!;
    expect(numericTag(tags, STALL_TAG.loopMaxMs)).toBeGreaterThanOrEqual(BLOCK_MS * 0.9);
    expect(tags[STALL_TAG.poolWaiting]).toBe('0');
  }, 30_000);
});

describe('a transaction that could not START (the `maxWait` half)', () => {
  it('reports an EXHAUSTED pool — waiting > 0 and every connection out', async () => {
    const max = dbPool()!.options.max!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    // Hold every connection in the pool inside an open transaction.
    const holders = Array.from({ length: max }, () =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          started += 1;
          await gate;
        },
        { timeout: 20_000, maxWait: 20_000 },
      ),
    );
    try {
      await vi.waitFor(() => expect(started).toBe(max), { timeout: 10_000 });

      // CONTROL: before anyone queues, nothing is waiting.
      const before = transactionStallTags(Object.assign(new Error('x'), { code: 'P2028' }))!;
      expect(before[STALL_TAG.poolWaiting]).toBe('0');

      const err = await rejectionOf(
        db.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: TX_BUDGET_MS }),
      );
      const tags = transactionStallTags(err)!;
      expect(tags[STALL_TAG.half]).toBe('maxWait');
      expect(numericTag(tags, STALL_TAG.poolWaiting)).toBeGreaterThan(0);
      expect(numericTag(tags, STALL_TAG.poolTotal)).toBe(max);
      expect(tags[STALL_TAG.poolIdle]).toBe('0');
    } finally {
      release();
      await Promise.allSettled(holders);
      // ⚠️ THE REJECTED TRANSACTION IS STILL RUNNING HERE (MOTIR-6886). Prisma
      // throws P2028 when `maxWait` fires but does not cancel the pending
      // `pool.connect()`: it chains a fire-and-forget `BEGIN` → `ROLLBACK` →
      // release onto it, which runs once a holder hands its connection over.
      // Nobody awaits that chain, so the in-flight probe could catch its
      // backend `idle in transaction` on `BEGIN`. The adapter releases the
      // connection only after `ROLLBACK` returns, so a pool with no waiter and
      // every connection idle means that backend has finished.
      const pool = dbPool()!;
      await vi.waitFor(
        () => {
          expect(pool.waitingCount).toBe(0);
          expect(pool.idleCount).toBe(pool.totalCount);
        },
        { timeout: 10_000 },
      );
    }
  }, 60_000);
});

describe('the Node runtimes’ beforeSend (app server and job worker)', () => {
  const event = (): ErrorEvent => ({ type: undefined, tags: { existing: 'kept' } });

  it('is the one the options builder hands BOTH runtimes', () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    try {
      // `scripts/worker.ts` and `sentry.server.config.ts` both init from this.
      expect(serverSentryInitOptions()!.beforeSend).toBe(serverBeforeSend);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('tags a P2028 event and keeps the tags it already had', () => {
    const p2028 = Object.assign(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
      { code: 'P2028' },
    );
    const sent = serverBeforeSend(event(), { originalException: p2028 })!;
    expect(sent.tags).toMatchObject({ existing: 'kept', [STALL_TAG.half]: 'maxWait' });
  });

  it('the job worker’s options carry the blocking-stack tags too (MOTIR-8265)', () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    try {
      const options = serverSentryInitOptions()!;
      const p2028 = Object.assign(new Error('x'), { code: 'P2028' });
      const sent = options.beforeSend!(event(), { originalException: p2028 }) as ErrorEvent;
      for (const key of [
        STALL_TAG.loopBlockMs,
        STALL_TAG.loopBlockFrame,
        STALL_TAG.loopBlockAgeS,
      ]) {
        expect(sent.tags).toHaveProperty([key]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes any other event through untouched', () => {
    const original = event();
    expect(serverBeforeSend(original, { originalException: new Error('boom') })).toBe(original);
  });
});

describe('the tags reach the monitor — over the wire, not merely into an object', () => {
  let received: string[] = [];
  let server: Server;
  let dsn: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"deadbeef"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    dsn = `http://publickey@127.0.0.1:${port}/1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    received = [];
    vi.unstubAllEnvs();
  });

  it('a captured real P2028 is POSTed carrying the stall tags', async () => {
    vi.stubEnv('SENTRY_DSN', dsn);
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({ ...serverSentryInitOptions()!, defaultIntegrations: false });

    const err = await rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await sleep(TX_BUDGET_MS * 2);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: TX_BUDGET_MS },
      ),
    );
    Sentry.captureException(err);
    await Sentry.flush(5_000);

    const envelope = received.join('\n');
    expect(envelope).toContain(`"${STALL_TAG.half}":"timeout"`);
    expect(envelope).toContain(`"${STALL_TAG.poolWaiting}":`);
    expect(envelope).toContain(`"${STALL_TAG.loopMaxMs}":`);
    await Sentry.close(2_000);
  }, 30_000);
});
