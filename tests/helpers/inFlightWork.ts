import { adminDb } from './adminDb';

/**
 * A backend still doing work on THIS worker's database (MOTIR-3066).
 *
 * `state` is Postgres': `active` (a statement is executing) or
 * `idle in transaction` (a transaction is open with no statement running).
 * Either one holds locks.
 */
export interface InFlightBackend {
  pid: number;
  state: string;
  query: string;
}

/**
 * Every OTHER client backend on this worker's database that is not idle.
 *
 * The suite gives each Vitest worker its own `…_test_wN` database
 * (`tests/setup/globalDb.ts`), and the worker→database mapping is one-to-one:
 * `VITEST_POOL_ID` is allocated from a fixed pool of `[1, maxWorkers]` slots and
 * `maxWorkers` is pinned to the provisioned count (`tests/helpers/parallelDb.ts`).
 * So `datname = current_database()` scopes this to the calling process, and
 * anything it returns is work THIS worker started and did not wait for.
 *
 * `backend_type = 'client backend'` drops autovacuum, which visits the worker
 * databases constantly and holds nothing the reset contends with.
 *
 * WHY THIS IS WORTH ASSERTING. `tests/helpers/db.ts`'s reset is a
 * `TRUNCATE … CASCADE`, which takes `AccessExclusiveLock` on twelve named tables
 * and every table that cascades from them, in ITS order. An abandoned read holds
 * `AccessShareLock` on the tables its own plan reached, in the PLANNER's order.
 * The two orders overlap and disagree, so the reset and the leftover deadlock —
 * `40P01`, raised against whichever of the two Postgres picks as the victim. When
 * that victim is the reset, the failure surfaces as a `beforeEach` throwing in a
 * test whose body never ran (MOTIR-3066).
 *
 * The invariant is therefore not "the truncate helpers agree on an order" — they
 * cannot agree with an arbitrary SELECT's plan. It is that **nothing else is
 * running when the reset runs**, which holds exactly when every operation a test
 * starts is awaited before that test ends.
 */
export async function inFlightBackends(): Promise<InFlightBackend[]> {
  const rows = await adminDb.$queryRawUnsafe<InFlightBackend[]>(
    `SELECT pid::int AS pid, state, left(query, 300) AS query
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY pid`,
  );
  return rows;
}

/** A one-line-per-backend rendering for an assertion message. */
export function describeInFlight(rows: InFlightBackend[]): string {
  return rows.map((r) => `  pid ${r.pid} [${r.state}] ${r.query.replace(/\s+/g, ' ')}`).join('\n');
}

/**
 * How long the suite-wide probe waits for a leftover backend to SETTLE before it
 * calls it a leak (MOTIR-10161). Bounded, and paid only by a test that ends with
 * something still non-idle: a clean test's first read is empty and returns at
 * once.
 */
export const IN_FLIGHT_SETTLE_GRACE_MS = 250;

/** How often the probe re-reads `pg_stat_activity` inside that grace. */
export const IN_FLIGHT_SETTLE_POLL_MS = 10;

/**
 * The backends still working AFTER a short, bounded wait — what the suite-wide
 * probe (`inFlightProbe.ts`) fails a test on.
 *
 * WHY A SINGLE READ IS NOT ENOUGH (MOTIR-10161). When a statement fails,
 * Postgres sends the client its `ErrorResponse` from inside the error handler,
 * THEN aborts the transaction, and only after that returns to its main loop,
 * reports `STATE_IDLE` and sends `ReadyForQuery`. The driver rejects on the
 * `ErrorResponse`, so a test whose ONE awaited statement was refused (an RLS
 * `WITH CHECK` on an INSERT, in `tenant-root-creation-rls.test.ts`) can finish
 * and reach this probe while its backend still reads `active` with the refused
 * query. On a loaded runner that window was wide enough for the read to land in
 * it, and the probe failed a test that owned no promise it could have awaited.
 *
 * WHAT THE WAIT TELLS APART. A backend finishing its abort reaches `idle`
 * within the grace and drops out of the re-read. A leaked one is still holding
 * its transaction or still running when the grace ends, and is reported exactly
 * as before — whatever its query is. Nothing is filtered by query text or by
 * state: the only thing the grace forgives is a backend that STOPPED working.
 *
 * Every re-read is the full `inFlightBackends()` read, so a backend that appears
 * during the grace (more of the test's own abandoned work) is reported too, and
 * what is returned is the last read — the state the next test's reset would
 * actually meet.
 */
export async function settledInFlightBackends(
  options: {
    graceMs?: number;
    pollMs?: number;
    read?: () => Promise<InFlightBackend[]>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<InFlightBackend[]> {
  const graceMs = options.graceMs ?? IN_FLIGHT_SETTLE_GRACE_MS;
  const pollMs = options.pollMs ?? IN_FLIGHT_SETTLE_POLL_MS;
  const read = options.read ?? inFlightBackends;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let rows = await read();
  let waited = 0;
  while (rows.length > 0 && waited < graceMs) {
    const step = Math.min(pollMs, graceMs - waited);
    await sleep(step);
    waited += step;
    rows = await read();
  }
  return rows;
}

/**
 * The probe's verdict: throws, naming every backend still working after the
 * settle grace, or returns when there is none (MOTIR-6278, MOTIR-10161). Lives
 * here rather than in `inFlightProbe.ts` so the verdict itself can be driven by
 * a test — that file only registers the hook.
 */
export async function assertNothingInFlight(
  options: Parameters<typeof settledInFlightBackends>[0] = {},
): Promise<void> {
  let leftover: InFlightBackend[];
  try {
    leftover = await settledInFlightBackends(options);
  } catch {
    // A file that opened a client but points it at no reachable database (a
    // test of the connection-failure path itself) has nothing to ask. That is
    // not a finding; a leak needs a database to leak onto.
    return;
  }
  if (leftover.length === 0) return;
  throw new Error(
    `This test ended with ${leftover.length} backend(s) of its own still working on the ` +
      `database. Await (or settle) the work that started them — a leftover like this is ` +
      `what deadlocks the NEXT test's reset (MOTIR-6278, tests/helpers/inFlightProbe.ts):\n` +
      describeInFlight(leftover),
  );
}
