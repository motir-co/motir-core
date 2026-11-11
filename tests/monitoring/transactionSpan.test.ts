import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import {
  measureTransactionAttempt,
  onTransactionMeasured,
  type TransactionMeasurement,
} from '@/lib/monitoring/transactionSpan';
import {
  clearTransactionStallPools,
  registerTransactionStallPool,
} from '@/lib/monitoring/transactionStall';
import { retryOnceBeforeBody } from '@/lib/workspaces/retryBeforeBody';

// MOTIR-8550 — the measurement every interactive transaction emits, without a
// database and without Sentry (no client ⇒ no span is ever started; listeners
// still hear every attempt). The real seam, the real pool and real spans are
// `tests/integration/monitoring/transactionSpanSeam.test.ts`.

const MAX_WAIT = 'Transaction API error: Unable to start a transaction in the given time.';
const EXPIRED =
  'Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 8241 ms passed since the start of the transaction.';

function p2028(message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2028',
    clientVersion: 'test',
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(): { seen: TransactionMeasurement[]; stop: () => void } {
  const seen: TransactionMeasurement[] = [];
  const stop = onTransactionMeasured((m) => seen.push(m));
  return { seen, stop };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  clearTransactionStallPools();
  vi.restoreAllMocks();
});

function listening() {
  const l = listen();
  stops.push(l.stop);
  return l.seen;
}

describe('the phase arithmetic', () => {
  it('puts the time before bodyStarted in WAIT and the time after it, to the settle, in HOLD', async () => {
    // The three phases sleep 40, 200 and 400 ms, so each bound sits a whole
    // neighbouring phase away from its edge: a loaded CI runner can stretch a
    // 40 ms sleep past 60 ms, but WAIT reaching 200 means it swallowed HOLD, and
    // HOLD reaching 400 means it swallowed the after-commit work.
    const seen = listening();
    await retryOnceBeforeBody(
      (bodyStarted, settled) =>
        settled(
          (async () => {
            await sleep(40);
            return bodyStarted(async () => {
              await sleep(200);
              return 'ok';
            });
          })(),
        ).then(async (value) => {
          // after-commit work: outside the hold.
          await sleep(400);
          return value;
        }),
      'workspace',
    );
    expect(seen).toHaveLength(1);
    const [m] = seen;
    expect(m!.context).toBe('workspace');
    expect(m!.attempt).toBe(1);
    expect(m!.outcome).toBe('committed');
    expect(m!.waitMs).toBeGreaterThanOrEqual(35);
    expect(m!.waitMs).toBeLessThan(200);
    expect(m!.holdMs).toBeGreaterThanOrEqual(195);
    expect(m!.holdMs).toBeLessThan(400);
  });

  it('a bare bodyStarted() still ends the wait, and an unwrapped attempt holds to its own end', async () => {
    const seen = listening();
    await retryOnceBeforeBody(async (bodyStarted) => {
      bodyStarted();
      await sleep(30);
      return 1;
    });
    expect(seen[0]!.context).toBe('unlabelled');
    expect(seen[0]!.holdMs).toBeGreaterThanOrEqual(25);
  });

  it('a body that throws is rolled_back, and the error is the caller’s', async () => {
    const seen = listening();
    const boom = new Error('boom');
    await expect(
      retryOnceBeforeBody(
        (bodyStarted, settled) =>
          settled(
            (async () =>
              bodyStarted(async () => {
                throw boom;
              }))(),
          ),
        'system',
      ),
    ).rejects.toBe(boom);
    expect(seen.map((m) => m.outcome)).toEqual(['rolled_back']);
    expect(seen[0]!.holdMs).not.toBeNull();
  });

  it('an error before the body is error_before_body, with no hold', async () => {
    const seen = listening();
    await expect(
      retryOnceBeforeBody(async () => {
        throw new Error('connect ECONNREFUSED');
      }, 'user'),
    ).rejects.toThrow('ECONNREFUSED');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.outcome).toBe('error_before_body');
    expect(seen[0]!.holdMs).toBeNull();
  });
});

describe('the retry is visible — the first attempt is recorded even when it is retried', () => {
  it.each([
    ['p2028_wait', MAX_WAIT],
    ['p2028_timeout', EXPIRED],
  ] as const)('a pre-body %s is attempt 1, then attempt 2 commits', async (outcome, message) => {
    const seen = listening();
    let calls = 0;
    const result = await retryOnceBeforeBody(async (bodyStarted) => {
      calls += 1;
      if (calls === 1) throw p2028(message);
      return bodyStarted(() => 'ok');
    }, 'workspace_service');
    expect(result).toBe('ok');
    expect(seen.map((m) => [m.attempt, m.outcome])).toEqual([
      [1, outcome],
      [2, 'committed'],
    ]);
    expect(seen[0]!.holdMs).toBeNull();
  });

  it('a P2028 after the body started is not retried, and is rolled_back', async () => {
    const seen = listening();
    await expect(
      retryOnceBeforeBody(async (bodyStarted) => {
        bodyStarted();
        throw p2028(EXPIRED);
      }),
    ).rejects.toThrow();
    expect(seen.map((m) => [m.attempt, m.outcome])).toEqual([[1, 'rolled_back']]);
  });
});

describe('pool occupancy, read when the helper asks', () => {
  it('is unmeasured — never zeros — when no pool is registered', async () => {
    const seen = listening();
    await retryOnceBeforeBody(async (bodyStarted) => bodyStarted(() => 1));
    expect(seen[0]!.pool).toBe('unmeasured');
  });

  it('sums every registered pool, with the pool count, as read BEFORE acquire', async () => {
    const a = { totalCount: 4, idleCount: 1, waitingCount: 2, options: { max: 5 } };
    const b = { totalCount: 3, idleCount: 3, waitingCount: 0, options: {} };
    registerTransactionStallPool(a);
    registerTransactionStallPool(b);
    const seen = listening();
    await retryOnceBeforeBody(async (bodyStarted) => {
      // Occupancy changing inside the attempt is not what was recorded.
      a.waitingCount = 9;
      return bodyStarted(() => 1);
    });
    expect(seen[0]!.pool).toEqual({ total: 7, idle: 4, waiting: 2, max: 15, count: 2 });
  });
});

describe('listeners', () => {
  it('a listener that throws is logged and never fails the transaction', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stops.push(
      onTransactionMeasured(() => {
        throw new Error('listener bug');
      }),
    );
    const seen = listening();
    await expect(
      measureTransactionAttempt(
        'org',
        1,
        async (bodyStarted) => bodyStarted(() => 'v'),
        () => {},
      ),
    ).resolves.toBe('v');
    expect(seen).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a listener registered from a SECOND module instance hears this one (MOTIR-7007)', async () => {
    vi.resetModules();
    const second = await import('@/lib/monitoring/transactionSpan');
    const seen: TransactionMeasurement[] = [];
    stops.push(second.onTransactionMeasured((m) => seen.push(m)));
    await measureTransactionAttempt(
      'org',
      1,
      async (bodyStarted) => bodyStarted(() => 1),
      () => {},
    );
    expect(seen).toHaveLength(1);
  });

  it('unsubscribing stops delivery', async () => {
    const { seen, stop } = listen();
    stop();
    await measureTransactionAttempt(
      'org',
      1,
      async () => 1,
      () => {},
    );
    expect(seen).toHaveLength(0);
  });
});
