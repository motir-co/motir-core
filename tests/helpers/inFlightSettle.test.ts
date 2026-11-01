import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './adminDb';
import {
  IN_FLIGHT_SETTLE_GRACE_MS,
  IN_FLIGHT_SETTLE_POLL_MS,
  assertNothingInFlight,
  inFlightBackends,
  settledInFlightBackends,
  type InFlightBackend,
} from './inFlightWork';

// The in-flight probe tells a SETTLING backend apart from a LEAKED one
// (MOTIR-10161).
//
// `tenant-root-creation-rls.test.ts` failed in the probe's `afterEach` on CI
// (run 41192171137, `Vitest (15/20)`) naming the very INSERT its one awaited
// statement had already had refused by RLS. Postgres sends `ErrorResponse`
// before it aborts the transaction and reports `idle`, so the client holds the
// error while the backend still reads `active`; a single `pg_stat_activity`
// read that lands in that window fails a test that leaked nothing.
//
// The window is microseconds on an idle box, so it cannot be hit on demand
// here. The cases below therefore pin the two halves separately: the verdict's
// LOGIC against a scripted reader (a backend that is active on the first read
// and idle on the next), and its behaviour on the REAL database for both a
// backend that stops inside the grace and one that is genuinely still working.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const row = (pid: number, state = 'active', query = 'INSERT INTO "public"."organization" …') => ({
  pid,
  state,
  query,
});

/** A reader that answers each call with the next scripted snapshot, then repeats the last. */
function scripted(...snapshots: InFlightBackend[][]) {
  let calls = 0;
  const read = async () => snapshots[Math.min(calls++, snapshots.length - 1)]!;
  return { read, calls: () => calls };
}

function recordingSleep() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => void slept.push(ms), slept };
}

describe('settledInFlightBackends — the verdict', () => {
  it('returns at once, with no wait, when the first read is empty', async () => {
    const reader = scripted([]);
    const { sleep, slept } = recordingSleep();

    expect(await settledInFlightBackends({ read: reader.read, sleep })).toEqual([]);
    expect(reader.calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  it('forgives a backend that is active on the first read and idle on the next (the refused INSERT still aborting)', async () => {
    const reader = scripted([row(2011)], []);
    const { sleep, slept } = recordingSleep();

    expect(await settledInFlightBackends({ read: reader.read, sleep })).toEqual([]);
    expect(reader.calls()).toBe(2);
    expect(slept).toEqual([IN_FLIGHT_SETTLE_POLL_MS]);
  });

  it('still reports a backend that is working when the grace ends, after waiting no longer than the grace', async () => {
    const reader = scripted([row(2011)]);
    const { sleep, slept } = recordingSleep();

    expect(
      await settledInFlightBackends({ graceMs: 25, pollMs: 10, read: reader.read, sleep }),
    ).toEqual([row(2011)]);
    // 10 + 10 + the 5 left of the grace — bounded, and the last step is clipped.
    expect(slept).toEqual([10, 10, 5]);
    expect(reader.calls()).toBe(4);
  });

  it('reports a backend that appears DURING the grace, and returns the last read rather than the first', async () => {
    const reader = scripted([row(2011)], [row(2012, 'idle in transaction', 'SELECT 1')]);
    const { sleep } = recordingSleep();

    expect(
      await settledInFlightBackends({ graceMs: 30, pollMs: 10, read: reader.read, sleep }),
    ).toEqual([row(2012, 'idle in transaction', 'SELECT 1')]);
  });

  it('defaults to a short, bounded grace', () => {
    expect(IN_FLIGHT_SETTLE_GRACE_MS).toBeGreaterThan(0);
    expect(IN_FLIGHT_SETTLE_GRACE_MS).toBeLessThanOrEqual(1000);
    expect(IN_FLIGHT_SETTLE_POLL_MS).toBeLessThan(IN_FLIGHT_SETTLE_GRACE_MS);
  });
});

describe('assertNothingInFlight — what the probe fails a test on', () => {
  it('passes a test whose backend settles inside the grace', async () => {
    const { sleep } = recordingSleep();
    await expect(
      assertNothingInFlight({ read: scripted([row(2011)], []).read, sleep }),
    ).resolves.toBeUndefined();
  });

  it('fails a test whose backend is still working, naming the pid, the state and the query', async () => {
    const { sleep } = recordingSleep();
    await expect(
      assertNothingInFlight({ graceMs: 20, pollMs: 10, read: scripted([row(2011)]).read, sleep }),
    ).rejects.toThrow(
      /1 backend\(s\)[\s\S]*pid 2011 \[active\] INSERT INTO "public"\."organization"/,
    );
  });

  it('has nothing to ask when the database cannot be read', async () => {
    const read = async (): Promise<InFlightBackend[]> => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(assertNothingInFlight({ read })).resolves.toBeUndefined();
  });
});

/** Wait until this worker's database shows a backend running `marker`; returns its pid. */
async function pidRunning(marker: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const hit = (await inFlightBackends()).find((b) => b.query.includes(marker));
    if (hit) return hit.pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no backend ever ran ${marker}`);
}

describe('on the real database', () => {
  it('does not report a backend that stops working inside the grace', async () => {
    const marker = 'motir_10161_settles';
    // A Prisma query is lazy until something subscribes to it: `.then` starts it.
    const work = db
      .$queryRawUnsafe(`SELECT pg_sleep(0.1)::text, '${marker}'`)
      .then(() => undefined);
    try {
      await pidRunning(marker);
      // The single read the probe used to make sees it…
      expect((await inFlightBackends()).some((b) => b.query.includes(marker))).toBe(true);
      // …and the settled read waits it out.
      expect(await settledInFlightBackends({ graceMs: 5000 })).toEqual([]);
    } finally {
      await work;
    }
  });

  it('STILL fails the probe on a genuinely leaked backend', async () => {
    const marker = 'motir_10161_leaks';
    const leak = db
      .$queryRawUnsafe(`SELECT pg_sleep(30)::text, '${marker}'`)
      .catch(() => undefined);
    try {
      const pid = await pidRunning(marker);
      await expect(assertNothingInFlight()).rejects.toThrow(
        new RegExp(`pid ${pid} \\[active\\] SELECT pg_sleep\\(30\\)::text, '${marker}'`),
      );
    } finally {
      // Stop the leak this case made on purpose, and wait for it, so the
      // suite-wide probe finds nothing after THIS test.
      await adminDb.$queryRawUnsafe(
        `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND pid <> pg_backend_pid()`,
      );
      await leak;
      await settledInFlightBackends({ graceMs: 2000 });
    }
  });
});
