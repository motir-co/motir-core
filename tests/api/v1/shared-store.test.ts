import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/v1/me/route';
import { db } from '@/lib/db';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import {
  __useDefaultRateLimitStoreForTest,
  rateLimitBudget,
  type RateLimitStore,
  setRateLimitStore,
} from '@/lib/api/v1/rateLimit';
import {
  createPostgresRateLimitStore,
  DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS,
  RateLimitStoreTimeoutError,
} from '@/lib/rateLimit/postgresStore';
import {
  RATE_LIMIT_STORE_ENV,
  __resetSharedRateLimitStoreForTest,
  __setSharedRateLimitStoreForTest,
  resolveRateLimitBackend,
  sharedRateLimitStore,
} from '@/lib/rateLimit/store';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import { rateLimitService } from '@/lib/services/rateLimitService';
import { createV1Caller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../../helpers/db';
import { freezeWindowClock } from '../../helpers/frozenWindowClock';
import { ALIGNED_WINDOW_MS, currentWindowStart } from '../../helpers/rateLimitWindow';
import {
  pinSharedRateLimitStoreDeadline,
  testDeadlineRateLimitStore,
} from '../../helpers/rateLimitStore';

// `/api/v1` counts through the SHARED store (Subtask 8.5.10 — MOTIR-2037).
//
// ── What this suite exists to prove, and why its siblings cannot ─────────────
// `tests/api/v1/rate-limit.test.ts` proves the limiter's BEHAVIOUR — the
// headers, the 429, the envelope, the per-token split. It calls
// `resetRateLimitStore()` in a `beforeEach`, which pins a fresh in-process
// counter, because those assertions need an empty counter and emptiness is not
// something the shared store can hand back by swapping an object.
//
// So that suite says nothing about WHERE the tally is kept — which is the whole
// of this card. This one therefore never calls `resetRateLimitStore()`: it
// drives the shipped wrapper in the state a real process starts in, and asserts
// the counter it lands in is the shared table, one window wide across clients.
//
// ⚠️ The headline case drives TWO STORE CLIENTS. One client counting to its own
// budget proves nothing about sharing — an in-process Map passes that test
// perfectly. The defect being closed is that machine A and machine B each kept
// their own window, so the assertion has to involve two independent counters
// agreeing, which is what a second `createPostgresRateLimitStore()` stands in
// for. Fly runs `machine_count: 2` today, so this is the deployed topology, not
// a hypothetical one.
//
// ── THE STORE DEADLINE IS PINNED BY DEFAULT, AND OPTING OUT IS SAID (MOTIR-3067)
// Counting through the real store means inheriting its production deadline —
// 250 ms for one increment — and `consumeRateLimit` FAILS OPEN when that
// expires. Every case here that spends a budget and then asserts a 429, or reads
// the row back, is therefore asserting that a shared CI Postgres answered in
// under a quarter of a second. MOTIR-2658 already found that untrue for the
// atomicity batch and pinned a deadline for it; the rest of the file kept the
// default until MOTIR-3067.
//
// So `beforeEach` installs the SAME Postgres adapter with a test-time deadline,
// and the THREE cases whose subject is store RESOLUTION rather than counting
// drop back to the default explicitly, each saying why:
//
//   'writes the token’s count to the shared counter TABLE — no wiring step required'
//   'resolves the same store object the app-level limiters use'
//   'MOTIR_RATE_LIMIT_STORE=memory keeps the count in the process, writing no row'
//
// Each of those makes ONE counted call, so the deadline exposure is a twelfth of
// the atomicity batch's — and an override would answer the question they exist
// to ask. Silence is not what puts them outside the pin; these three lines are.
//
// ⚠️ THE PIN REACHES ONLY THE STORE `beforeEach` INSTALLS — a client a case
// builds for itself is outside it (MOTIR-6520). The two-client cases below each
// construct a SECOND store standing in for the other machine; a bare
// `createPostgresRateLimitStore()` there takes the production 250 ms and throws
// `RateLimitStoreTimeoutError` on a loaded runner, leaving its `INSERT … ON
// CONFLICT` still running when the test ends. So every client a case builds
// comes from `testDeadlineRateLimitStore()`, and a third one added later owes
// the same — the fail-open cases further down, whose tiny deadline IS their
// subject, are the only stores here built with an explicit `timeoutMs`.
//
// ── EVERY COUNTED CASE RUNS ON A FROZEN CLOCK (MOTIR-10807) ─────────────────
// The limiter buckets on an epoch grid read from `Date.now()`, so a case whose
// assertion depends on an ACCUMULATED count owns that count only while no grid
// boundary falls between its calls. These cases used to buy that with
// `waitForWindowBoundary` — a margin against the wall clock, which a loaded CI
// shard spent on motir-core#4081: `does NOT pool two tokens…` served its third
// request as the first of a fresh cell. Each counted case now calls
// `freezeWindowClock()` (Date only; timers stay real) right before its first
// counted call, and the one case that needs the next window moves the clock
// there itself. The fail-open cases keep the real clock: they count nothing,
// and one of them measures elapsed time.
//
// ── THE DEFAULT-DEADLINE CASES ASSERT THE ROW, NOT THE RESPONSE (MOTIR-10807)
// The two resolution cases that count through the DEFAULT store inherit its
// 250 ms deadline, and on that same shard it expired: the wrapper failed open,
// answered `x-ratelimit-remaining: 10` (the whole budget — only the fail-open
// arm says that) and moved on while its `INSERT` was still running. Whether a
// counter write answers inside 250 ms is a property of the runner, not of store
// resolution, so those cases keep every real increment the default store
// starts, settle them, and assert on the shared ROW — which the write reaches
// whichever side of the deadline it finishes on.

const ME = 'http://localhost:3000/api/v1/me';

function req(headers: Record<string, string>) {
  return new Request(ME, { headers });
}

/** The counter key the wrapper will use for this caller — its token's hash. */
function keyFor(caller: { token: string }): string {
  return tokenFingerprint(caller.token);
}

const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
  store: process.env[RATE_LIMIT_STORE_ENV],
};

/** Set the budget the way a deployment would. */
function budget(limit: number, windowMs: number) {
  process.env['MOTIR_API_V1_RATE_LIMIT'] = String(limit);
  process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(windowMs);
}

function restoreEnv() {
  for (const [name, saved] of [
    ['MOTIR_API_V1_RATE_LIMIT', savedEnv.limit],
    ['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS', savedEnv.window],
    [RATE_LIMIT_STORE_ENV, savedEnv.store],
  ] as const) {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // Back to the state a fresh process is in: nothing pinned here, and the
  // shared store's memo cleared so it re-reads the environment.
  __useDefaultRateLimitStoreForTest();
  __resetSharedRateLimitStoreForTest();
  // …and then the ONE thing a fresh process does not have: a deadline sized for
  // a test runner rather than a live request (MOTIR-3067). Installed AFTER the
  // reset, which drops exactly this override. The three resolution cases above
  // undo it deliberately.
  pinSharedRateLimitStoreDeadline();
  delete process.env[RATE_LIMIT_STORE_ENV];
});

afterEach(() => {
  // FIRST: everything below, and the suite-wide in-flight probe after it, may
  // read `Date`.
  vi.useRealTimers();
  vi.restoreAllMocks();
  __useDefaultRateLimitStoreForTest();
  __resetSharedRateLimitStoreForTest();
  restoreEnv();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Keep every REAL counter increment the shared store starts, so a case can wait
 * for the writes themselves rather than for the store's verdict on them.
 *
 * ⚠️ Observes, never replaces: each call runs the real service, so the store
 * under test is still the unmodified default. What it adds is the one thing the
 * fail-open arm takes away — a write that lost the deadline keeps running after
 * the wrapper has moved on, and `settle()` is how the case waits for it before
 * reading the row (and before the in-flight probe finds it, MOTIR-6278).
 */
function keepCounterWrites(): { settle: () => Promise<void> } {
  const realIncrement = rateLimitService.increment.bind(rateLimitService);
  const writes: Promise<number>[] = [];
  vi.spyOn(rateLimitService, 'increment').mockImplementation((...args) => {
    const write = realIncrement(...args);
    writes.push(write);
    return write;
  });
  return {
    settle: async () => {
      await Promise.allSettled(writes);
    },
  };
}

describe('the wrapper counts through the SHARED store by default', () => {
  it('writes the token’s count to the shared counter TABLE — no wiring step required', async () => {
    // Aligned even though only ONE request is counted: the assertion names the
    // window cell the row must be in, so a boundary crossing between the request
    // and the read would look exactly like a missing row.
    budget(10, ALIGNED_WINDOW_MS);
    // ⚠️ BACK TO THE DEFAULT, deliberately (MOTIR-3067). The claim is *no wiring
    // step required* — that a process which installs nothing still counts into
    // the shared table. `beforeEach`'s deadline pin IS a wiring step, so leaving
    // it in place would make this assertion true of the override rather than of
    // the default and prove nothing about production.
    __resetSharedRateLimitStoreForTest();
    // ⚠️ AND SO THE DEADLINE IS THE PRODUCTION 250 ms, which a loaded shard
    // misses (MOTIR-10807): the wrapper then fails open and answers the whole
    // budget as remaining, while the write is still on its way to the table. The
    // claim here is WHERE the count goes, so the case waits for the write and
    // reads the row; the header's value is the runner's speed, and
    // `rate-limit.test.ts` owns what the header says.
    const writes = keepCounterWrites();
    const caller = await createV1Caller();
    freezeWindowClock();
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    const res = await GET(req(caller.headers));
    await writes.settle();

    expect(res.status).toBe(200);
    // The row is the point: nothing in production calls `setRateLimitStore`, so
    // if the default were still the in-process Map this read would be null.
    expect(
      await rateLimitCounterRepository.findCountUnsafe(keyFor(caller), BigInt(windowStart)),
    ).toBe(1);
  });

  it('resolves the same store object the app-level limiters use', async () => {
    // One store, not two implementations of the same idea: `/api/v1` and the
    // auth / public-write / AI guards share the counter (they keep their own
    // budgets — sharing a store is not sharing a ceiling).
    budget(10, ALIGNED_WINDOW_MS);
    // Same reason as the case above (MOTIR-3067): with an override installed the
    // two surfaces would trivially resolve the same object, and the identity
    // this case asserts is one about the DEFAULTS.
    __resetSharedRateLimitStoreForTest();
    // Same 250 ms exposure as the case above (MOTIR-10807), on BOTH writes: the
    // wrapper's and the direct one below. So the case waits for the writes and
    // reads the row they share, instead of trusting a return value the deadline
    // may have replaced with a timeout.
    const writes = keepCounterWrites();
    const shared = sharedRateLimitStore();
    const caller = await createV1Caller();
    freezeWindowClock();
    const windowStart = currentWindowStart(rateLimitBudget().windowMs);

    await GET(req(caller.headers));
    // The app-level side, writing the SAME key through its own entry point,
    // continues v1's count rather than starting a second one. A timeout is the
    // deadline's verdict, not the write's: the write it abandoned still lands.
    await shared
      .increment(keyFor(caller), windowStart, rateLimitBudget().windowMs)
      .catch((err: unknown) => {
        if (!(err instanceof RateLimitStoreTimeoutError)) throw err;
      });
    await writes.settle();

    expect(
      await rateLimitCounterRepository.findCountUnsafe(keyFor(caller), BigInt(windowStart)),
    ).toBe(2);
  });
});

describe('TWO STORE CLIENTS enforce ONE window — the defect this card closes', () => {
  it('spending the budget through a SECOND client refuses the wrapper’s next request', async () => {
    // The two-machine case, made deterministic. `other` is a store client the
    // wrapper has never seen — a stand-in for the second Fly machine — and the
    // budget it spends is the budget the wrapper then finds gone.
    const LIMIT = 3;
    budget(LIMIT, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    freezeWindowClock();
    // The second machine gets the test-time deadline too — the header's pin
    // covers only the store `beforeEach` installs (MOTIR-6520).
    const other = testDeadlineRateLimitStore();
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    for (let i = 0; i < LIMIT; i++) {
      await other.increment(keyFor(caller), windowStart, ALIGNED_WINDOW_MS);
    }

    const refused = await GET(req(caller.headers));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
    // Under the old per-process counter this request was the FIRST of its
    // window and would have been served with `remaining: 2`.
    const body = (await refused.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('the two clients count into ONE row, not one row each', async () => {
    budget(10, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    freezeWindowClock();
    // The second machine gets the test-time deadline too — the header's pin
    // covers only the store `beforeEach` installs (MOTIR-6520).
    const other = testDeadlineRateLimitStore();
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    await GET(req(caller.headers));
    await other.increment(keyFor(caller), windowStart, ALIGNED_WINDOW_MS);
    await GET(req(caller.headers));

    expect(
      await rateLimitCounterRepository.findCountUnsafe(keyFor(caller), BigInt(windowStart)),
    ).toBe(3);
    // ONE row for the token's key, whichever client wrote. Counted per KEY: the
    // workspace ceiling every authenticated v1 request also spends (MOTIR-8601)
    // keeps its own row, on its own window.
    const rows = await adminDb.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "rate_limit_counter" WHERE key = $1`,
      keyFor(caller),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('does NOT pool two tokens of the same user into one budget', async () => {
    // Sharing the STORE must not blur the KEY: the fix would be worse than the
    // defect if one integration could now exhaust another's allowance.
    budget(2, ALIGNED_WINDOW_MS);
    const first = await createV1Caller();
    const second = await withTokenFor(first.user, first.workspace, { label: 'second' });
    freezeWindowClock();

    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(429);

    expect((await GET(req(second.headers))).status).toBe(200);
  });
});

describe('the shared counter stays ATOMIC and time-bounded under the wrapper', () => {
  // ── ⚠️ A 200 IS TWO DIFFERENT ANSWERS, AND THE STATUS CANNOT SEPARATE THEM ──
  // The concurrent batch below used to read only `r.status`, and a request
  // served because the counter was under budget carries the same 200 as one
  // served because the store TIMED OUT and the limiter failed open
  // (`degraded: true`, `lib/api/v1/rateLimit.ts`). So the property this case is
  // named for — the counter is atomic under concurrency — was not actually
  // asserted: a run in which the store answered NOTHING would sail through the
  // 429 count as easily as MOTIR-2658's run failed it.
  //
  // That is not hypothetical. On PR #2035, 2 of 12 concurrent increments blew
  // the shipped 250 ms deadline against a loaded CI Postgres, the store saw 10
  // of a budget of 11, and every request came back 200 — reported as
  // "expected 11 got 12", which is byte-identical to the epoch-aligned window
  // straddle (MOTIR-2101) that five cards have chased. The only thing telling
  // the two apart was two lines of stderr fifteen hundred lines up.
  //
  // Both halves of that are fixed here, and neither touches the window: the
  // batch now asserts on `degraded` FIRST so the failure names itself, and its
  // store gets a deadline generous enough that a CI hiccup is not a red PR.

  /** The failures a batch's store hit — one per DEGRADED decision it caused. */
  interface InstrumentedStore {
    store: RateLimitStore;
    degradedBy: () => string[];
  }

  /**
   * How long ONE increment gets in this section — a deliberate, generous
   * override of the shipped `DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS` through the
   * seam `createPostgresRateLimitStore` already offers (MOTIR-2658).
   *
   * The deadline is a PRODUCTION policy — the limiter must never become the
   * outage it exists to prevent — and this is not the case that proves it
   * works: "ALLOWS the request when the store HANGS" below is, at a deadline of
   * its own. Here the deadline's only possible contribution is to FIRE, and a
   * fired deadline DESTROYS the property under test, because a failed-open
   * increment never reaches the counter the batch is measuring.
   *
   * 5 s against a batch measured at 19 ms worst-of-20 (MOTIR-2224) is a ~260x
   * margin — held to the same "exceeding it means a broken machine, not bad
   * luck" standard as `ALIGNED_WINDOW_MS` itself.
   */
  const ATOMICITY_STORE_TIMEOUT_MS = 5_000;

  /**
   * The deadline the guard case pins — short enough that its hung increments
   * blow it promptly, and still ~10x the 19 ms worst-of-20 a real increment
   * costs, so the increments it does NOT hang are not degraded by accident.
   * (If a loaded runner degrades them too, the guard's assertion still fires —
   * it just observes more failures than it staged.)
   */
  const DEGRADED_STORE_TIMEOUT_MS = 200;

  /** How many of the guard case's increments hang — MOTIR-2658 saw 2 of 12. */
  const STAGED_TIMEOUTS = 2;

  /**
   * The real Postgres store, wrapped so the test can SEE the one bit the batch
   * could not: whether an increment failed and its request was therefore served
   * DEGRADED.
   *
   * `consumeRateLimit` returns `degraded: true` exactly when `increment` throws,
   * so a record of the throws IS the record of the degraded decisions — taken
   * at the same seam the wrapper catches at, with the causing error still
   * attached so the message can name it.
   */
  function instrumentedPostgresStore(timeoutMs: number): InstrumentedStore {
    const inner = createPostgresRateLimitStore({ timeoutMs });
    const failures: string[] = [];

    return {
      degradedBy: () => [...failures],
      store: {
        async increment(key, windowStart, windowMs) {
          try {
            return await inner.increment(key, windowStart, windowMs);
          } catch (err) {
            failures.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
            throw err;
          }
        },
      },
    };
  }

  /**
   * Fire N simultaneous requests against a budget of N−1 through `instrumented`
   * and assert the atomicity properties.
   *
   * Extracted so the guard case below can run the SAME assertions against a
   * deliberately-degraded store and watch them go red — a guard nobody has
   * watched fail is indistinguishable from no guard.
   */
  async function assertAtomicUnderConcurrency(instrumented: InstrumentedStore): Promise<void> {
    const N = 12;
    // ⚠️ UNCHANGED, and deliberately so (MOTIR-2658 acceptance #4): this file is
    // a correct member of the aligned set and the window is not the defect.
    budget(N - 1, ALIGNED_WINDOW_MS);
    setRateLimitStore(instrumented.store);
    const caller = await createV1Caller();
    freezeWindowClock();

    const responses = await Promise.all(Array.from({ length: N }, () => GET(req(caller.headers))));
    const statuses = responses.map((r) => r.status);

    // ⚠️ FIRST, and the ORDER is the point. Everything after this line reads a
    // status, and a degraded batch makes those counts meaningless while leaving
    // them plausible — so the reader has to be told the store gave up BEFORE
    // being handed a number that looks like a window bug.
    const degraded = instrumented.degradedBy();
    expect(
      degraded,
      `the rate-limit store FAILED OPEN during the atomicity batch — ${degraded.length} of ${N} ` +
        `increments never reached the shared counter: ${degraded.join(' · ')}. The 200/429 ` +
        `split below therefore cannot tell an ATOMIC store from one that gave up, so this run ` +
        `proves nothing either way. ⚠️ This is NOT the epoch-aligned window straddle ` +
        `(MOTIR-2101): the window here is pinned and aligned, and touching it fixes nothing. ` +
        `See MOTIR-2658`,
    ).toEqual([]);

    // The same bit read off the RESPONSE rather than the store, so the decision
    // is checked at the boundary a client sees too: the fail-open arm returns
    // the WHOLE budget as remaining, while any genuinely counted request has
    // spent at least one of it. `remaining === limit` is therefore exactly
    // `degraded`, and nothing else can produce it.
    const fullBudget = responses.filter(
      (r) => r.headers.get('x-ratelimit-remaining') === String(N - 1),
    );
    expect(
      fullBudget.length,
      `${fullBudget.length} response(s) advertised the FULL budget as remaining, which only the ` +
        `fail-open arm does — the limiter served them without counting them (MOTIR-2658)`,
    ).toBe(0);

    expect(statuses.filter((s) => s === 200)).toHaveLength(N - 1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  }

  // The property a read → compare → write store fails. A serial loop passes
  // against a broken implementation; simultaneous requests do not — and this is
  // the assertion that has to survive the move from a single-threaded Map to a
  // database several connections are hitting at once.
  it('fires N SIMULTANEOUS requests against a budget of N−1 and refuses exactly one', async () => {
    // The pin is a deadline override, NOT a different backend: the store below
    // is the one this deployment resolves by default, so the batch still runs
    // against the shared Postgres counter it is here to prove.
    expect(resolveRateLimitBackend()).toBe('postgres');
    expect(ATOMICITY_STORE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS);

    await assertAtomicUnderConcurrency(instrumentedPostgresStore(ATOMICITY_STORE_TIMEOUT_MS));
  });

  // ⚠️ The guard proven by DELIBERATELY introducing the failure — the same
  // discipline `rate-limit-window-alignment.test.ts` holds itself to, and the
  // reason it is owed here is that the assertion above replaced one that
  // silently passed through the very failure it exists to catch.
  it('goes red naming the DEGRADED store — not "a length of 11" — when the store times out', async () => {
    // ⚠️ PARTIAL degradation, on purpose: MOTIR-2658's occurrence hung 2 of 12
    // increments, not all of them, and that is the shape the old assertion
    // could not read. The remaining 10 count normally against a budget of 11,
    // so every request is served, nothing is refused, and the batch reports
    // "expected 11 got 12" — byte-identical to the epoch-aligned straddle
    // (MOTIR-2101). A guard that only hung the WHOLE store would prove the
    // assertion fires; this one proves it fires on the occurrence.
    const realIncrement = rateLimitService.increment.bind(rateLimitService);
    // ⚠️ EVERY REAL INCREMENT IS KEPT, AND SETTLED BEFORE THE CASE ENDS (MOTIR-7108).
    // On a loaded runner a real increment can lose the 200 ms deadline too — the
    // tolerance below allows exactly that — and the wrapper then fails open and
    // the batch moves on WITHOUT it. Its `INSERT … ON CONFLICT` is still running
    // on the database when the case returns, and the suite-wide in-flight probe
    // (MOTIR-6278) fails the case for it. The probe's prescribed remedy is to
    // settle the work, never to widen the probe.
    const realCalls: Promise<number>[] = [];
    let hung = 0;
    vi.spyOn(rateLimitService, 'increment').mockImplementation((...args) => {
      if (hung++ < STAGED_TIMEOUTS) return new Promise<number>(() => {});
      const call = realIncrement(...args);
      realCalls.push(call);
      return call;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = await assertAtomicUnderConcurrency(
      instrumentedPostgresStore(DEGRADED_STORE_TIMEOUT_MS),
    ).then(
      () => null,
      (err: unknown) => err as Error,
    );
    // Settled BEFORE any assertion below can throw, so a red assertion does not
    // also leave a backend behind. `allSettled`, not `all`: a rejected increment
    // must not stop the wait for its siblings.
    await Promise.allSettled(realCalls);

    expect(
      failure,
      'the atomicity case PASSED a batch the store never fully counted',
    ).not.toBeNull();
    // It names the CAUSE, and names it in the message rather than leaving it to
    // a stderr line fifteen hundred lines above the assertion.
    expect(failure?.message).toContain('FAILED OPEN');
    expect(failure?.message).toContain('RateLimitStoreTimeoutError');
    expect(failure?.message).toContain('MOTIR-2658');
    // …and it says HOW MANY of the batch went uncounted, which is what tells a
    // reader this is the fail-open arm rather than a counter that reset.
    // Tolerant of a loaded runner degrading more than the two it staged; the
    // staging is exact (verified at 2 of 12), the assertion just must not be
    // the thing that goes red when the machine is slow.
    expect(failure?.message).toMatch(/\b[1-9]\d* of 12 increments never reached/);
    // And it does NOT read as the length mismatch that sent MOTIR-2658's reader
    // to the window — the one place the cause was not.
    expect(failure?.message).not.toContain('to have a length of');
  });

  it('resets when the window rolls over — a new window is a new row', async () => {
    const ROLLOVER_WINDOW_MS = 2_000;
    budget(1, ROLLOVER_WINDOW_MS);
    const caller = await createV1Caller();
    freezeWindowClock();

    expect((await GET(req(caller.headers))).status).toBe(200);
    const refused = await GET(req(caller.headers));
    expect(refused.status).toBe(429);

    // Move the clock past the reset the response itself advertised. The
    // rollover is still the limiter's own: it reads `Date.now()`, computes the
    // next `windowStart` and writes a new row. What the move removes is the
    // chance that the two requests above straddled a boundary on their own
    // (MOTIR-10807) — a real sleep only decided where the SECOND cell began.
    const resetAtMs = Number(refused.headers.get('x-ratelimit-reset')) * 1000;
    vi.setSystemTime(resetAtMs + 100);

    expect((await GET(req(caller.headers))).status).toBe(200);
    // Two rows for one token: the old window's and the new one's. The sweep
    // (MOTIR-1165) is what eventually removes the first. Counted for the token's
    // KEY: the workspace ceiling the request also spends (MOTIR-8601) keeps rows
    // of its own on its own window.
    const rows = await adminDb.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "rate_limit_counter" WHERE key = $1`,
      keyFor(caller),
    );
    expect(rows[0]?.n).toBe(2);
  });
});

describe('a shared store in the request path still FAILS OPEN', () => {
  // Now that the counter is a dependency of every v1 request rather than a Map
  // in the same process, this arm is the difference between a degraded limiter
  // and an outage. Both shapes are forced: one that throws, one that hangs.
  it('ALLOWS the request when the store THROWS, and still emits the headers', async () => {
    budget(1, 60_000);
    setRateLimitStore({
      increment: () => Promise.reject(new Error('the database is unreachable')),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const caller = await createV1Caller();

    // Well past a budget of 1 — every one of these is served anyway.
    for (let i = 0; i < 3; i++) {
      const res = await GET(req(caller.headers));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('1');
      expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
    }
    expect(spy).toHaveBeenCalled();
  });

  it('ALLOWS the request when the store HANGS, without holding it open', async () => {
    // The case a bare `catch` cannot reach: a store that never settles never
    // throws. The deadline in `postgresStore.ts` rejects on its behalf, and the
    // wrapper's existing catch treats that like any other store failure.
    budget(1, 60_000);
    const TIMEOUT_MS = 50;
    vi.spyOn(rateLimitService, 'increment').mockReturnValue(new Promise<number>(() => {}));
    setRateLimitStore(createPostgresRateLimitStore({ timeoutMs: TIMEOUT_MS }));
    // The workspace ceiling (MOTIR-8601) counts through the SHARED store, which
    // the hung service hangs too — so it gets the same short deadline, or the
    // request waits out `beforeEach`'s generous test pin instead.
    __setSharedRateLimitStoreForTest(createPostgresRateLimitStore({ timeoutMs: TIMEOUT_MS }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const caller = await createV1Caller();

    const startedAt = Date.now();
    const res = await GET(req(caller.headers));
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('1');
    // Bounded by the deadline, not by the hung call. Generous upper bound: the
    // assertion is that it RETURNS at all, not that the timer is precise.
    expect(elapsed).toBeLessThan(5_000);
    expect(TIMEOUT_MS).toBeLessThan(DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS);
  });
});

describe('the single-instance escape hatch', () => {
  it('MOTIR_RATE_LIMIT_STORE=memory keeps the count in the process, writing no row', async () => {
    // The self-hoster running one process: per-process and shared are the same
    // thing there, and this is the arm that lets them skip the write.
    process.env[RATE_LIMIT_STORE_ENV] = 'memory';
    // This reset was already here, and it doubles as the third MOTIR-3067
    // opt-out: it drops `beforeEach`'s deadline pin, which is required — the
    // point is that the ENV picks the backend, and an override would pick it
    // first. Nothing is lost by it either, since the in-process Map has no
    // deadline to miss.
    __resetSharedRateLimitStoreForTest();
    budget(2, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    freezeWindowClock();

    expect((await GET(req(caller.headers))).status).toBe(200);
    expect((await GET(req(caller.headers))).status).toBe(200);
    // Still enforced — the ceiling is real, it is just not shared.
    expect((await GET(req(caller.headers))).status).toBe(429);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
  });
});
