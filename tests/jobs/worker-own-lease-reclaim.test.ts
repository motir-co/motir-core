import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker, passKeyOf, type JobWorkerOptions } from '@/lib/jobs/engine/worker';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { JobRunDefer } from '@/lib/jobs/engine/defer';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Bug MOTIR-10500 — A WORKER THAT LOSES ITS OWN LEASE RE-CLAIMS THE SAME RUN.
//
// MOTIR-10466 fenced every settle write on `state = 'running' AND claimed_by =
// <workerId>`. That shuts out a late settle over a row ANOTHER worker claimed, and
// it cannot tell two claims by the SAME worker apart. A live worker that misses its
// heartbeats until its lease lapses has the lease reclaimed by its own next tick,
// which then claims the very run it is still executing:
//
//   * the first pass's settle passed the fence and wrote `succeeded` / a reschedule /
//     `failed` over the row the second pass was executing;
//   * `inFlight`, `parked`, `withdrawals` and `settling` were keyed on the run id, so
//     the first settle's `finally` dropped the second pass from `inFlight` and the
//     drain neither waited for nor withdrew it.
//
// Reproduced on `origin/main` @ `9ec1c00` (MOTIR-10466 merged) with this file's first
// case before the fix: the row read `succeeded` / null while handler 2 was still
// executing, and `inFlightCount` read 0.
//
// What this file pins, against real Postgres and the real worker loop:
//
//   1. whatever the stale pass ends in — success, a sleep, a defer, a retryable or a
//      terminal failure — it never changes the row its own worker re-claimed, and is
//      reported `released`; the dead-letter hook does not run for it;
//   2. both passes count in flight until each settles, so the pool sees both;
//   3. the drain waits for, withdraws and releases the second pass after the first
//      has settled;
//   4. the repository's settle writes are fenced on the claim's TOKEN, not only its
//      worker, and every claim — including a re-claim by the same worker — takes a
//      new one.

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LEASE_MS = 50;
/** Long enough past LEASE_MS that the reclaim sees the lease lapsed. */
const LAPSE_MS = 150;

beforeEach(async () => {
  await truncateJobRuns();
});
afterEach(async () => {
  await truncateJobRuns();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A promise the test releases. */
function held(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}

async function enqueue(jobId: string, maxAttempts = 3): Promise<string> {
  const row = await adminDb.jobQueueRun.create({
    data: { jobId, eventName: `test.${jobId}`, runAt: new Date(Date.now() - 1_000), maxAttempts },
  });
  return row.id;
}

async function rowOf(id: string): Promise<[string, string | null, number]> {
  const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
  return [row.state, row.claimedBy, row.claimToken];
}

/** Resolve once `predicate` holds — the authoritative signal, never a fixed sleep. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const lapse = (): Promise<void> => new Promise((r) => setTimeout(r, LAPSE_MS));

type Outcome = Parameters<NonNullable<JobWorkerOptions['onOutcome']>>[1];

/**
 * One worker, `same`, whose every pass runs to a hold the test controls and then
 * ends with the ending queued for that pass (nothing queued ⇒ it succeeds). No
 * `start()`, so no heartbeat: the lease lapses exactly as it does for a stalled
 * event loop.
 */
function stalledWorker(extra: Partial<JobWorkerOptions> = {}) {
  const outcomes: Outcome[] = [];
  const holds: Array<{ wait: Promise<void>; release: () => void }> = [];
  const endings: Array<() => void> = [];
  const warnings: string[] = [];
  const worker = new JobWorker({
    workerId: 'same',
    logger: { ...silent, warn: (msg: string) => warnings.push(msg) },
    timings: { leaseMs: LEASE_MS, renewMs: 1_000_000, drainTimeoutMs: 50 },
    execute: async () => {
      const pass = holds.length;
      const h = held();
      holds.push(h);
      await h.wait;
      endings[pass]?.();
    },
    onOutcome: (_run, outcome) => outcomes.push(outcome),
    ...extra,
  });
  return { worker, outcomes, holds, endings, warnings };
}

/** Claim the run, let the lease lapse, and claim it AGAIN with the same worker. */
async function twoPasses(w: ReturnType<typeof stalledWorker>, id: string): Promise<void> {
  expect(await w.worker.tick()).toBe(1);
  expect(await rowOf(id)).toEqual(['running', 'same', 1]);
  await lapse();
  expect(await w.worker.tick()).toBe(1);
  // The reclaim and the re-claim were this worker's own: same claimant, new token.
  expect(await rowOf(id)).toEqual(['running', 'same', 2]);
  await until(() => w.holds.length === 2, 'both handlers to be executing');
  expect(w.worker.inFlightCount).toBe(2);
}

const PASS_ENDINGS: Array<[string, () => void]> = [
  ['succeeds', () => {}],
  [
    'yields a durable sleep',
    () => {
      throw new JobStepYield('probe-sleep', new Date(Date.now() + 60_000));
    },
  ],
  [
    'defers',
    () => {
      throw new JobRunDefer(new Date(Date.now() + 60_000), 'probe-defer');
    },
  ],
  [
    'fails with budget left',
    () => {
      throw new Error('transient');
    },
  ],
  [
    'fails terminally',
    () => {
      throw Object.assign(new Error('hopeless'), { retryable: false });
    },
  ],
];

describe('a worker that re-claims its OWN run after its lease lapsed (the reported defect)', () => {
  it.each(PASS_ENDINGS)(
    'the stale pass never changes the row when it %s, and the live pass still counts',
    async (_name, end) => {
      const id = await enqueue('same.reclaim');
      let hookCalls = 0;
      const w = stalledWorker({
        onTerminalFailure: async () => {
          hookCalls += 1;
        },
      });
      w.endings[0] = end;
      await twoPasses(w, id);

      // Handler 1 ends. Before the fix its settle passed the worker-id fence and
      // wrote over the row handler 2 is executing, and its `finally` took handler 2
      // out of `inFlight`.
      w.holds[0]!.release();
      await until(() => w.outcomes.length === 1, 'the stale pass to settle');
      await until(() => w.worker.inFlightCount < 2, 'the stale pass to leave inFlight');
      expect(w.outcomes).toEqual(['released']);
      expect(hookCalls).toBe(0);
      expect(await rowOf(id)).toEqual(['running', 'same', 2]);
      expect(w.worker.inFlightCount).toBe(1);
      expect(w.warnings.join('\n')).toContain('(claim 1) is no longer held by same');

      // Handler 2 — the live claim — is the one whose settle lands.
      w.holds[1]!.release();
      await w.worker.settled();
      expect(w.outcomes).toEqual(['released', 'succeeded']);
      expect(await rowOf(id)).toEqual(['succeeded', null, 2]);
      expect(w.worker.inFlightCount).toBe(0);
      await w.worker.shutdown();
    },
  );

  it('the live pass settles normally even when the STALE pass is the one still running', async () => {
    // The other order: handler 2 finishes first and owns the row's outcome; handler 1's
    // late settle must not overwrite it, and must not have been counted out early.
    const id = await enqueue('same.order');
    const w = stalledWorker();
    w.endings[1] = () => {
      throw new JobRunDefer(new Date(Date.now() + 60_000), 'live-defer');
    };
    await twoPasses(w, id);

    w.holds[1]!.release();
    await until(() => w.outcomes.length === 1, 'the live pass to settle');
    await until(() => w.worker.inFlightCount < 2, 'the live pass to leave inFlight');
    expect(w.outcomes).toEqual(['deferred']);
    expect(w.worker.inFlightCount).toBe(1);
    expect(await rowOf(id)).toEqual(['pending', null, 2]);

    w.holds[0]!.release();
    await w.worker.settled();
    expect(w.outcomes).toEqual(['deferred', 'released']);
    expect(await rowOf(id)).toEqual(['pending', null, 2]);
    await w.worker.shutdown();
  });

  it('both passes hold pool capacity until each settles', async () => {
    const id = await enqueue('same.capacity');
    const w = stalledWorker({ timings: { leaseMs: LEASE_MS, renewMs: 1_000_000, poolSize: 2 } });
    await twoPasses(w, id);
    expect(w.worker.freeCapacity).toBe(0);

    w.holds[0]!.release();
    await until(() => w.worker.inFlightCount < 2, 'the stale pass to settle');
    expect(w.worker.freeCapacity).toBe(1);

    w.holds[1]!.release();
    await w.worker.settled();
    expect(w.worker.freeCapacity).toBe(2);
    await w.worker.shutdown();
  });

  it('the drain still waits for, withdraws and releases the live pass once the stale one settled', async () => {
    const id = await enqueue('same.drain');
    const w = stalledWorker();
    await twoPasses(w, id);

    w.holds[0]!.release();
    await until(() => w.worker.inFlightCount < 2, 'the stale pass to settle');

    // Before the fix `inFlight` read 0 here, so the drain neither waited nor said so.
    await w.worker.shutdown();
    expect(w.warnings.some((m) => m.includes('drain timed out with 1 run(s) in flight'))).toBe(
      true,
    );
    expect(await rowOf(id)).toEqual(['pending', null, 2]);

    // The live pass ends after the release: its claim is gone, so it writes nothing.
    w.holds[1]!.release();
    await w.worker.settled();
    expect(w.outcomes).toEqual(['released', 'released']);
    expect(await rowOf(id)).toEqual(['pending', null, 2]);
  });
});

describe('the settle writes are fenced on the claim TOKEN (jobQueueRepository)', () => {
  it('every claim takes a new token, and a reclaim never lowers it', async () => {
    const id = await enqueue('token.monotonic');
    const claim = (by: string) =>
      withSystemContext((tx) => jobQueueRepository.claimDueRuns(by, 1, LEASE_MS, tx));

    const [first] = await claim('w');
    expect(first!.claimToken).toBe(1);
    await lapse();
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));
    expect(await rowOf(id)).toEqual(['pending', null, 1]);

    const [second] = await claim('w');
    expect(second!.claimToken).toBe(2);
    await withSystemContext((tx) => jobQueueRepository.releaseClaims('w', tx));
    const [third] = await claim('other');
    expect(third!.claimToken).toBe(3);
  });

  it('writes nothing under a stale token from the same worker, and lands under the live one', async () => {
    const id = await enqueue('token.fence');
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('w', 1, LEASE_MS, tx));
    await lapse();
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('w', 1, 60_000, tx));

    const stale = { id, workerId: 'w', claimToken: 1 };
    const live = { id, workerId: 'w', claimToken: 2 };
    const at = new Date(Date.now() + 60_000);
    await withSystemContext(async (tx) => {
      expect(await jobQueueRepository.isHeldBy(stale, tx)).toBe(false);
      expect(await jobQueueRepository.markSucceeded(stale, tx)).toBe(false);
      expect(await jobQueueRepository.markFailed(stale, { message: 'x' }, tx)).toBe(false);
      expect(await jobQueueRepository.rescheduleAt(stale, at, tx, { refundAttempt: true })).toBe(
        false,
      );
    });
    expect(await rowOf(id)).toEqual(['running', 'w', 2]);

    await withSystemContext(async (tx) => {
      expect(await jobQueueRepository.isHeldBy(live, tx)).toBe(true);
      expect(await jobQueueRepository.markSucceeded(live, tx)).toBe(true);
    });
    expect(await rowOf(id)).toEqual(['succeeded', null, 2]);
  });
});

describe('passKeyOf', () => {
  it('tells two claims of one run apart, and two runs under one token apart', () => {
    expect(passKeyOf({ id: 'r1', claimToken: 1 })).not.toBe(passKeyOf({ id: 'r1', claimToken: 2 }));
    expect(passKeyOf({ id: 'r1', claimToken: 1 })).not.toBe(passKeyOf({ id: 'r2', claimToken: 1 }));
    expect(passKeyOf({ id: 'r1', claimToken: 1 })).toBe(passKeyOf({ id: 'r1', claimToken: 1 }));
  });
});
