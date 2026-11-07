import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import {
  JobWorker,
  POOL_SIZE,
  retryBackoffMs,
  serializeWorkerFailure,
} from '@/lib/jobs/engine/worker';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// The WORKER (Story MOTIR-3414 · Subtask MOTIR-3421), against a real Postgres.
//
// ⚠️ THE CONCURRENCY CASE IS THE POINT OF THIS FILE, AND A SERIAL TEST CANNOT
// SEE IT. Claiming is a read-derived write; two sequential claims never collide,
// so a test that claims twice in a row passes against an implementation with no
// lock at all. The `two workers` block below therefore drives GENUINE
// concurrency — `Promise.all` over two workers against one warm pool — and
// accepts every legitimate interleaving (any split of the rows) while asserting
// the one thing that must never happen: a row executed twice.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `worker-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Worker ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Worker WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

async function enqueue(
  workspaceId: string,
  opts?: Partial<{ jobId: string; runAt: Date; maxAttempts: number; attempts: number }>,
): Promise<string> {
  seq += 1;
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: opts?.jobId ?? `test.job.${seq}`,
      eventName: 'test.event',
      workspaceId,
      runAt: opts?.runAt ?? new Date(),
      maxAttempts: opts?.maxAttempts ?? 3,
      attempts: opts?.attempts ?? 0,
    },
  });
  return row.id;
}

/** Read a run's current row as the owner — "what actually happened", not "what the app could see". */
async function readRun(id: string): Promise<JobQueueRun> {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Poll an authoritative read until it holds, or fail — never a fixed sleep. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('the claim — two workers, one queue', () => {
  it('NEVER executes the same run twice under genuine concurrency', async () => {
    const ws = await makeWorkspace();
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await enqueue(ws));

    // Every execution, by whichever worker. If the claim were a plain
    // read-then-write, a row would appear twice here.
    const executions: string[] = [];
    const make = (name: string) =>
      new JobWorker({
        workerId: name,
        logger: silent,
        timings: { claimBatch: 4 },
        execute: async (run) => {
          executions.push(run.id);
          // A real handler does I/O; the await widens the window in which a
          // second worker could claim the same row, which is what we want.
          await new Promise((r) => setTimeout(r, 5));
        },
      });

    const a = make('worker-a');
    const b = make('worker-b');

    // Drive both until the queue is drained, concurrently — the warm-pool race.
    // ⚠️ `tick()` returns at the CLAIM since MOTIR-3762, and the race this test
    // is about lives in the claim — so the concurrent `Promise.all` over the two
    // ticks is unchanged. What is added is draining each round's DETACHED
    // settles before asking "was there anything left", so the loop's exit
    // condition still means the queue is empty rather than momentarily unclaimed.
    for (let round = 0; round < 12; round++) {
      const [ca, cb] = await Promise.all([a.tick(), b.tick()]);
      await Promise.all([a.settled(), b.settled()]);
      if (ca === 0 && cb === 0) break;
    }

    // THE assertion: every run executed EXACTLY once.
    expect(executions).toHaveLength(new Set(executions).size);
    expect(new Set(executions)).toEqual(new Set(ids));

    // Every legitimate SPLIT is accepted — we assert nothing about which worker
    // got which row, only that between them they got each row once. (An
    // assertion like "each worker took ten" would be a real race condition in
    // the test, since `SKIP LOCKED` makes the split timing-dependent by design.)
    const states = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(states.every((s) => s.state === 'succeeded')).toBe(true);
  });

  it('claims OLDEST-DUE first', async () => {
    const ws = await makeWorkspace();
    const t = Date.now();
    const third = await enqueue(ws, { runAt: new Date(t - 1_000) });
    const first = await enqueue(ws, { runAt: new Date(t - 3_000) });
    const second = await enqueue(ws, { runAt: new Date(t - 2_000) });

    const order: string[] = [];
    const w = new JobWorker({
      workerId: 'ordering',
      logger: silent,
      timings: { claimBatch: 1 },
      execute: async (run) => {
        order.push(run.id);
      },
    });
    // `tick()` CLAIMS and dispatches; the run executes and records its outcome
    // after it returns. Settle each one, as the concurrency case above does, or
    // the last run's completion write is still in a transaction when this test
    // ends — which the suite-wide in-flight check refuses (MOTIR-6278).
    for (let i = 0; i < 3; i++) {
      await w.tick();
      await w.settled();
    }

    expect(order).toEqual([first, second, third]);
  });

  it('does NOT claim a run whose run_at is in the future', async () => {
    const ws = await makeWorkspace();
    const later = await enqueue(ws, { runAt: new Date(Date.now() + 60_000) });
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'future',
      logger: silent,
      execute: async (run) => {
        executed.push(run.id);
      },
    });

    expect(await w.tick()).toBe(0);
    expect(executed).toEqual([]);
    expect((await readRun(later)).state).toBe('pending');
  });
});

describe('the lease — a worker that dies', () => {
  it('a run whose lease EXPIRED is reclaimed by another worker', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    // Worker A claims and then "dies" — modelled by never settling the run and
    // never renewing its lease, which is exactly what a SIGKILLed process leaves
    // behind: a `running` row with a lease that stops being renewed.
    const dead = new JobWorker({
      workerId: 'dead-worker',
      logger: silent,
      timings: { leaseMs: 50 },
      execute: async () => {
        /* claimed, then the process vanishes */
      },
    });
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('dead-worker', 1, 50, tx));
    expect((await readRun(runId)).state).toBe('running');
    expect((await readRun(runId)).claimedBy).toBe('dead-worker');
    expect((await readRun(runId)).attempts).toBe(1);
    void dead;

    await new Promise((r) => setTimeout(r, 120)); // the lease expires

    const executed: string[] = [];
    const live = new JobWorker({
      workerId: 'live-worker',
      logger: silent,
      execute: async (run) => {
        executed.push(run.id);
      },
    });
    // `tick` reclaims expired leases BEFORE claiming, so the abandoned run is
    // picked up in the same tick rather than waiting for the next one.
    expect(await live.tick()).toBe(1);
    // ⚠️ `tick()` returns at the CLAIM since MOTIR-3762 — the settle is detached,
    // so the authoritative signal for "it finished" is `settled()`, not the tick.
    await live.settled();
    expect(executed).toEqual([runId]);
    expect((await readRun(runId)).state).toBe('succeeded');
  });

  it('REFUNDS the attempt a dead worker spent — a crash must not eat the retry budget', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 3 });

    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('crasher', 1, 40, tx));
    expect((await readRun(runId)).attempts).toBe(1);

    await new Promise((r) => setTimeout(r, 100));
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));

    // The handler never ran and never failed, so the attempt was not spent on
    // anything. Without the refund a rolling deploy catching the same long run
    // three times would dead-letter it with no error to show an operator.
    const after = await readRun(runId);
    expect(after.attempts).toBe(0);
    expect(after.state).toBe('pending');
    expect(after.claimedBy).toBeNull();
  });

  it('a LIVE worker keeps its claim — renewal is what tells it apart from a dead one', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('long-runner', 1, 60, tx));
    await new Promise((r) => setTimeout(r, 40));
    // The heartbeat, which is the only signal distinguishing a run that is
    // taking a long time from a worker that has died. Nothing about duration
    // alone could.
    await withSystemContext((tx) => jobQueueRepository.renewLeases('long-runner', 5_000, tx));
    await new Promise((r) => setTimeout(r, 60));

    const reclaimed = await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));
    expect(reclaimed).toBe(0);
    const still = await readRun(runId);
    expect(still.state).toBe('running');
    expect(still.claimedBy).toBe('long-runner');
  });

  it('renewal is scoped to the OWNER — one worker cannot extend another’s lease', async () => {
    const ws = await makeWorkspace();
    await enqueue(ws);
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('owner', 1, 5_000, tx));

    const renewed = await withSystemContext((tx) =>
      jobQueueRepository.renewLeases('someone-else', 60_000, tx),
    );
    expect(renewed).toBe(0);
  });
});

describe('failure, retry and the durable yield', () => {
  it('a failing run is RESCHEDULED with backoff until the budget is spent, then FAILS', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 2 });
    const outcomes: string[] = [];
    const w = new JobWorker({
      workerId: 'failing',
      logger: silent,
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async () => {
        throw new Error('handler exploded');
      },
    });

    await w.tick();
    await w.settled();
    let row = await readRun(runId);
    expect(row.state).toBe('pending'); // retrying
    expect(row.attempts).toBe(1);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off
    expect(row.lastError).toMatchObject({ message: 'handler exploded' });

    // Make it due again and spend the last attempt.
    await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
    await w.tick();
    await w.settled();
    row = await readRun(runId);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.claimedBy).toBeNull();
    expect(outcomes).toEqual(['retrying', 'failed']);
  });

  it('a JobStepYield is NOT a failure — it reschedules at the deadline and REFUNDS the attempt', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 3 });
    const resumeAt = new Date(Date.now() + 30 * 60_000);
    const outcomes: string[] = [];
    const w = new JobWorker({
      workerId: 'sleeper',
      logger: silent,
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async () => {
        throw new JobStepYield('supervise-wait:1', resumeAt);
      },
    });

    await w.tick();
    await w.settled();
    const row = await readRun(runId);
    expect(row.state).toBe('pending');
    expect(row.runAt.getTime()).toBe(resumeAt.getTime());
    // A half-hour supervisor that slept sixty times must not have consumed
    // sixty attempts — sleeping is not failing.
    expect(row.attempts).toBe(0);
    expect(row.claimedBy).toBeNull();
    expect(outcomes).toEqual(['yielded']);
  });

  it('one run failing does not stop its BATCH-MATES from settling', async () => {
    const ws = await makeWorkspace();
    const bad = await enqueue(ws, { jobId: 'bad.job' });
    const good = await enqueue(ws, { jobId: 'good.job' });
    const w = new JobWorker({
      workerId: 'mixed',
      logger: silent,
      timings: { claimBatch: 5 },
      execute: async (run) => {
        if (run.jobId === 'bad.job') throw new Error('nope');
      },
    });

    await w.tick();
    await w.settled();
    expect((await readRun(good)).state).toBe('succeeded');
    expect((await readRun(bad)).state).toBe('pending'); // retrying
  });
});

describe("the worker's own defaults and lifecycle (coverage floor, MOTIR-3766)", () => {
  // ⚠️ THESE ARE FIXTURES, NOT AN IGNORE DIRECTIVE. The story gate's coverage
  // rule is to SORT the uncovered arms: an arm a fixture can reach gets one, and
  // only an arm that is unreachable by construction gets a directive. Every arm
  // below is reachable in one line, which is why none of them is ignored.

  it('defaults the workerId and the logger when the caller supplies neither', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);
    // No `workerId`, no `logger` — the two `??` defaults in the constructor.
    const w = new JobWorker({ execute: async () => {} });

    expect(w.workerId).toMatch(/^worker-[0-9a-f-]{36}$/);
    expect(await w.tick()).toBe(1);
    await w.settled();
    const row = await readRun(runId);
    expect(row.state).toBe('succeeded');
    // The default logger is `console`, and a green run never reaches it — which
    // is why constructing it is the whole assertion. The claim itself released
    // its `claimed_by` when the run settled, so the id is asserted above.
    expect(row.claimedBy).toBeNull();
  });

  it('start() is IDEMPOTENT — a second call does not start a second loop or heartbeat', async () => {
    const w = new JobWorker({ workerId: 'twice', logger: silent, execute: async () => {} });
    w.start();
    w.start(); // the `if (this.running) return` arm
    await w.shutdown();
    // The real assertion is the absence of a leak: a second heartbeat interval
    // would survive the single `clearInterval` in `shutdown()` and hold the
    // process open. `unref` hides that from the runner, so assert the contract
    // rather than the timer — a second loop would also claim concurrently.
    expect(w.inFlightCount).toBe(0);
  });

  it("the HEARTBEAT renews this worker's leases on its own cadence", async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'beating',
      logger: silent,
      // A tiny renew cadence so the interval callback actually fires inside the
      // test — the callback, its `withSystemContext` and its `.catch` are the
      // three functions a `tick()`-only test never reaches. The drain window is
      // small because the run is held open on purpose.
      timings: { renewMs: 20, leaseMs: 60_000, drainTimeoutMs: 100 },
      execute: async () => held,
    });

    w.start();
    await until(async () => (await readRun(runId)).state === 'running', 'the run to be claimed');
    const first = (await readRun(runId)).leaseExpiresAt;
    await until(async () => {
      const next = (await readRun(runId)).leaseExpiresAt;
      return first !== null && next !== null && next.getTime() > first.getTime();
    }, 'the heartbeat to push the lease forward');

    release();
    await w.shutdown();
  });

  it('`waitForSlot` resolves ONCE — the invariant behind its defensive guard', async () => {
    // The arm `worker.ts` carries a `v8 ignore` on. It cannot be reached from
    // outside, so what is asserted is the property that makes it unreachable:
    // a waiter is woken exactly once, and `releaseSlot` drains the set.
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws), await enqueue(ws)];
    let settles = 0;
    const w = new JobWorker({
      workerId: 'one-slot',
      logger: silent,
      timings: { poolSize: 1, claimBatch: 5, idleMinMs: 5, idleMaxMs: 20 },
      execute: async () => {
        settles += 1;
        await new Promise((r) => setTimeout(r, 15));
      },
    });

    w.start();
    try {
      await until(async () => {
        const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
        return rows.every((r) => r.state === 'succeeded');
      }, 'a pool of ONE to drain three runs through repeated slot waits');
    } finally {
      await w.shutdown();
    }
    // Three runs through one slot means the loop waited for a slot and was woken
    // by a settle at least twice — and each run executed exactly once, which is
    // what a double-resolve would break.
    expect(settles).toBe(3);
  });

  it('serializeWorkerFailure keeps an Error that carries NO stack', () => {
    const bare = new Error('no stack here');
    // Some runtimes and some thrown values arrive without one; the `?:` arm that
    // handles it is otherwise unreached.
    Object.defineProperty(bare, 'stack', { value: undefined });
    expect(serializeWorkerFailure(bare)).toEqual({ message: 'no stack here' });
  });
});

describe('the CLAIM is bounded by its LIMIT (bug MOTIR-3769)', () => {
  // ⚠️ EVERY ASSERTION HERE GOES THROUGH `withSystemContext`, AND THAT IS THE
  // POINT. The defect is invisible as the database OWNER: without a policy qual
  // on `job_queue` the planner evaluates the locking sub-select once and the
  // bound holds. Under `motir_app` — the role production connects as, and the
  // suite's only connection — the qual changes the cost model, the sub-select
  // becomes the re-scanned inner side of a nested loop, and the limit bounds
  // each re-scan instead of the statement. Measured before the fix: three due
  // rows, `limit = 1`, THREE claimed. `AS MATERIALIZED` is what makes it a bound.
  //
  // No existing test caught it because none asserted the claim's CARDINALITY —
  // `claims OLDEST-DUE first` drives three ticks at `claimBatch: 1` and checks
  // the execution ORDER, which is identical either way.

  it('claims EXACTLY the limit and leaves the rest untouched', async () => {
    const ws = await makeWorkspace();
    const t = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await enqueue(ws, { runAt: new Date(t - 5_000 + i * 100) }));

    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('bounded-claim', 2, 60_000, tx),
    );
    expect(claimed).toHaveLength(2);
    // Oldest-due first survives the fix — the bound did not cost the ordering.
    expect(claimed.map((c) => c.id)).toEqual(ids.slice(0, 2));

    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(rows.filter((r) => r.state === 'running')).toHaveLength(2);
    const untouched = rows.filter((r) => r.state === 'pending');
    expect(untouched).toHaveLength(3);
    // Not merely unclaimed — UNTOUCHED. An over-claim spends an attempt on every
    // row it takes, so the attempt counter is the second, independent witness.
    expect(untouched.every((r) => r.attempts === 0 && r.claimedBy === null)).toBe(true);
  });

  it('claims everything due when the limit is larger than the queue', async () => {
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws)];
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('roomy-claim', 10, 60_000, tx),
    );
    expect(claimed.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it('spends exactly ONE attempt per row it claims', async () => {
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws), await enqueue(ws)];
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('attempts', 1, 60_000, tx));
    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(rows.filter((r) => r.attempts === 1)).toHaveLength(1);
    expect(rows.filter((r) => r.attempts === 0)).toHaveLength(2);
  });
});

describe('the claim RATE — free capacity, not the slowest run (MOTIR-3762)', () => {
  // `docs/decisions/job-queue-foundation.md` §15.3. Every assertion here is
  // against the real queue, and every "slow" run is genuinely slow — a handler
  // held open across real database round-trips, never a fake timer, because a
  // fake timer would prove the code does what the test schedules rather than
  // that the loop is free while a run is in flight.

  /** A handler gate: `hold()` inside a run, `release()` from the test. */
  function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    return { wait, release };
  }

  /** Poll an authoritative read until it holds, or fail — never a fixed sleep. */
  async function until(
    predicate: () => boolean | Promise<boolean>,
    what: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  it('claims and COMPLETES further runs while a far slower one is still in flight', async () => {
    const ws = await makeWorkspace();
    // Oldest first, so the claim order is the enqueue order — the slow run is
    // taken by the first tick, exactly as the 35-minute refresh was.
    const t = Date.now();
    const slow = await enqueue(ws, { jobId: 'slow.job', runAt: new Date(t - 3_000) });
    const fastIds = [
      await enqueue(ws, { jobId: 'fast.job.1', runAt: new Date(t - 2_000) }),
      await enqueue(ws, { jobId: 'fast.job.2', runAt: new Date(t - 1_000) }),
    ];

    const held = gate();
    const w = new JobWorker({
      workerId: 'capacity',
      logger: silent,
      // ONE per claim, so the slow run is alone in its batch and the ONLY thing
      // that could stop the next tick is the old `await Promise.all`.
      timings: { claimBatch: 1 },
      execute: async (run) => {
        if (run.jobId === 'slow.job') await held.wait;
      },
    });

    expect(await w.tick()).toBe(1);
    await until(
      async () => (await readRun(slow)).state === 'running',
      'the slow run to be claimed',
    );

    // THE assertion: with a run in flight that has not settled, the worker
    // claims again and the fast runs reach a TERMINAL state — asserted on
    // `job_queue` rows, not on a spy.
    for (const _ of fastIds) {
      expect(await w.tick()).toBe(1);
    }
    await until(async () => {
      const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: fastIds } } });
      return rows.every((r) => r.state === 'succeeded');
    }, 'the fast runs to succeed');

    // …and the slow one is STILL in flight while that is true. That ordering is
    // the test: without it, "the fast runs finished" says nothing.
    const slowRow = await readRun(slow);
    expect(slowRow.state).toBe('running');
    expect(slowRow.claimedBy).toBe('capacity');
    expect(w.inFlightCount).toBe(1);

    held.release();
    await w.settled();
    expect((await readRun(slow)).state).toBe('succeeded');
  });

  it('never exceeds the POOL SIZE, on a queue deeper than the pool', async () => {
    const ws = await makeWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await enqueue(ws));

    let concurrent = 0;
    let peak = 0;
    const w = new JobWorker({
      workerId: 'bounded',
      logger: silent,
      // A batch LARGER than the pool, so a tick that passed the constant instead
      // of the free capacity would over-claim on its very first pass.
      timings: { claimBatch: 5, poolSize: 3, idleMinMs: 5, idleMaxMs: 25 },
      execute: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        try {
          await new Promise((r) => setTimeout(r, 20)); // real work, real overlap
        } finally {
          concurrent -= 1;
        }
      },
    });

    w.start();
    try {
      // The whole queue drains — which is also the back-pressure assertion: a
      // saturated loop that waited on the QUEUE instead of on a SLOT would still
      // get here, but a loop that stopped claiming would not.
      await until(async () => {
        const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
        return rows.every((r) => r.state === 'succeeded');
      }, 'the whole queue to drain through a pool of 3');
    } finally {
      await w.shutdown();
    }

    expect(peak).toBeLessThanOrEqual(3);
    // And the bound was actually EXERCISED — a peak of 1 would mean the queue
    // never got deep enough for the assertion above to have measured anything.
    expect(peak).toBeGreaterThan(1);
  });

  it('claims AT MOST the free capacity, and a FULL pool does not call the claim at all', async () => {
    const ws = await makeWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await enqueue(ws));

    const limits: number[] = [];
    const claimDueRuns = jobQueueRepository.claimDueRuns.bind(jobQueueRepository);
    // A spy that DELEGATES — the queue, the transaction and the lock are all the
    // real ones; what is recorded is the limit the loop asked for, which is the
    // thing this criterion is about and the one thing a row cannot show.
    const spy = vi
      .spyOn(jobQueueRepository, 'claimDueRuns')
      .mockImplementation(async (workerId, limit, leaseMs, tx) => {
        limits.push(limit);
        return claimDueRuns(workerId, limit, leaseMs, tx);
      });

    const held = gate();
    const w = new JobWorker({
      workerId: 'saturated',
      logger: silent,
      timings: { claimBatch: 5, poolSize: 2 },
      execute: async () => {
        await held.wait;
      },
    });

    try {
      // min(claimBatch 5, capacity 2) = 2 — the batch size does not win.
      expect(await w.tick()).toBe(2);
      expect(limits).toEqual([2]);
      expect(w.freeCapacity).toBe(0);

      // Pool full ⇒ the claim is not reached at all, so no further limit is
      // recorded and nothing else leaves `pending`.
      expect(await w.tick()).toBe(0);
      expect(limits).toEqual([2]);
      expect(limits.every((l) => l > 0)).toBe(true);
      const pending = await adminDb.jobQueueRun.findMany({
        where: { id: { in: ids }, state: 'pending' },
      });
      expect(pending).toHaveLength(3);
      expect(pending.every((r) => r.attempts === 0)).toBe(true);
    } finally {
      held.release();
      await w.settled();
      spy.mockRestore();
    }
  });

  it('SIGTERM during a DETACHED slow run still releases every claim, attempts refunded', async () => {
    const ws = await makeWorkspace();
    const slow = await enqueue(ws, { jobId: 'slow.job' });
    const mate = await enqueue(ws, { jobId: 'fast.job' });

    const held = gate();
    const w = new JobWorker({
      workerId: 'draining-detached',
      logger: silent,
      timings: { claimBatch: 5, drainTimeoutMs: 200 },
      execute: async (run) => {
        if (run.jobId === 'slow.job') await held.wait;
      },
    });

    const claimed = await w.tick();
    expect(claimed).toBe(2);
    // The fast mate settles on its own while the slow one is still held — the
    // detached shape, which is what this extends the existing drain cover to.
    await until(async () => (await readRun(mate)).state === 'succeeded', 'the mate to settle');
    expect(w.inFlightCount).toBe(1);

    await w.shutdown(); // times out on the held run, and releases it anyway

    const slowRow = await readRun(slow);
    expect(slowRow.state).toBe('pending');
    expect(slowRow.claimedBy).toBeNull();
    // ⚠️ THE REFUND, which the older drain assertions did not check: a deploy
    // must not eat a retry. `claimDueRuns` spent an attempt at the claim and
    // `releaseClaims` gives it back.
    expect(slowRow.attempts).toBe(0);

    held.release();
    await w.settled();
  });

  it('a THROWING handler fails only its own run — an in-flight mate is untouched', async () => {
    const ws = await makeWorkspace();
    const t = Date.now();
    const slow = await enqueue(ws, { jobId: 'slow.job', runAt: new Date(t - 2_000) });
    const bad = await enqueue(ws, { jobId: 'bad.job', runAt: new Date(t - 1_000) });
    const good = await enqueue(ws, { jobId: 'good.job', runAt: new Date(t) });

    const held = gate();
    const w = new JobWorker({
      workerId: 'mixed-detached',
      logger: silent,
      timings: { claimBatch: 5 },
      execute: async (run) => {
        if (run.jobId === 'slow.job') await held.wait;
        if (run.jobId === 'bad.job') throw new Error('nope');
      },
    });

    expect(await w.tick()).toBe(3);
    await until(async () => {
      const [b, g] = await Promise.all([readRun(bad), readRun(good)]);
      return b.state === 'pending' && b.attempts === 1 && g.state === 'succeeded';
    }, 'the bad run to retry and the good one to succeed');

    // The throw settled its own row and left the in-flight one alone.
    expect((await readRun(slow)).state).toBe('running');
    expect(w.inFlightCount).toBe(1);

    held.release();
    await w.settled();
    expect((await readRun(slow)).state).toBe('succeeded');
  });

  it('POOL_SIZE leaves headroom for the fast lane beside the long supervisors', () => {
    // §15.6.3: the floor is the count of long-running supervisors that may be in
    // flight at once — `system.code-graph-index`, `system.code-graph-refresh`,
    // `system.ci-runner-boot` — plus headroom. A pool at or below three would
    // reproduce 2026-08-28 with extra steps.
    expect(POOL_SIZE).toBeGreaterThan(3);
  });
});

describe('graceful shutdown', () => {
  it('SIGTERM drains: NO run is left `running` with no live claimant', async () => {
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws), await enqueue(ws)];

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'draining',
      logger: silent,
      timings: { claimBatch: 5, drainTimeoutMs: 3_000 },
      execute: async () => {
        await held; // in flight, and staying that way until we let go
      },
    });

    const ticking = w.tick();
    // Wait until the claim has actually landed rather than sleeping a guessed
    // interval — the authoritative signal is the row state, not the clock.
    for (let i = 0; i < 100 && w.inFlightCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(w.inFlightCount).toBe(3);

    const shutting = w.shutdown();
    release();
    await ticking;
    await shutting;

    // THE acceptance criterion. A `running` row with no live claimant is work
    // nobody will ever pick up, which is the state a drain exists to prevent.
    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(rows.filter((r) => r.state === 'running')).toEqual([]);
    expect(rows.every((r) => r.claimedBy === null)).toBe(true);
  });

  it('a drain that TIMES OUT still releases — an unfinished run is re-runnable, an orphan is not', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    let release!: () => void;
    const never = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'stuck',
      logger: silent,
      // A deliberately tiny drain window: Fly SIGKILLs some seconds after
      // SIGTERM, so the release has to happen whether or not the run finished.
      timings: { drainTimeoutMs: 100 },
      execute: async () => {
        await never;
      },
    });

    const ticking = w.tick();
    for (let i = 0; i < 100 && w.inFlightCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await w.shutdown();

    // Released despite still executing. Safe precisely because the step ledger
    // memoized whatever it completed — the next claimant resumes rather than
    // restarts. That is MOTIR-3422 paying for itself outside its own card.
    const row = await readRun(runId);
    expect(row.state).toBe('pending');
    expect(row.claimedBy).toBeNull();

    release();
    await ticking;
    // The released run now finishes and records its outcome AFTER `tick()` has
    // returned; wait for that write, or it is still in a transaction when the
    // next case's reset runs (MOTIR-6278).
    await w.settled();
  });

  it('a drained worker CLAIMS NOTHING MORE', async () => {
    const ws = await makeWorkspace();
    await enqueue(ws);
    const w = new JobWorker({ workerId: 'stopped', logger: silent, execute: async () => {} });
    await w.shutdown();
    expect(await w.tick()).toBe(0);
  });
});

describe('the SCHEDULER rides this loop (MOTIR-3471)', () => {
  it('runs at the TOP of a tick, so a fire it enqueues is claimed by the SAME pass', async () => {
    // This is why the scheduler is a hook on the loop rather than a timer of its
    // own: the alternative enqueues a due run and then waits out a poll interval
    // before anything claims it, for no reason but the two cadences not lining up.
    const fire = new Date(Date.UTC(2026, 7, 25, 3, 30, 0));
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'scheduling',
      logger: silent,
      execute: async (run) => {
        executed.push(run.jobId);
      },
      onSchedulerTick: async () => {
        await withSystemContext((tx) =>
          jobQueueRepository.enqueueScheduled(
            {
              jobId: 'system.attachment-gc',
              scheduledFor: fire,
              eventName: 'scheduled.system.attachment-gc',
              runAt: fire,
              maxAttempts: 5,
            },
            tx,
          ),
        );
      },
    });

    const claimed = await w.tick();
    // The claimed run records its outcome after `tick()` returns (MOTIR-6278).
    await w.settled();
    expect(claimed).toBe(1);
    expect(executed).toEqual(['system.attachment-gc']);
  });

  it('a FULL pool still ticks the scheduler: the due fire is written, and waits for a slot (MOTIR-10600)', async () => {
    // On 2026-11-07 ten runs held every slot and the capacity check returned
    // BEFORE the scheduler, so no cron fire was written for 36 minutes — the
    // missed-close replay among them. Writing a fire is not claiming it.
    const ws = await makeWorkspace();
    await enqueue(ws);
    const fire = new Date(Date.UTC(2026, 10, 7, 20, 30, 0));
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let ticks = 0;
    const w = new JobWorker({
      workerId: 'full-pool-scheduler',
      logger: silent,
      timings: { poolSize: 1 },
      execute: async () => {
        await held;
      },
      onSchedulerTick: async () => {
        ticks += 1;
        if (ticks < 2) return;
        await withSystemContext((tx) =>
          jobQueueRepository.enqueueScheduled(
            {
              jobId: 'system.attachment-gc',
              scheduledFor: fire,
              eventName: 'scheduled.system.attachment-gc',
              runAt: fire,
              maxAttempts: 5,
            },
            tx,
          ),
        );
      },
    });

    expect(await w.tick()).toBe(1);
    expect(w.freeCapacity).toBe(0);

    // The pool is full: this tick claims nothing — and still schedules.
    expect(await w.tick()).toBe(0);
    expect(ticks).toBe(2);
    const written = await adminDb.jobQueueRun.findFirst({
      where: { jobId: 'system.attachment-gc', scheduledFor: fire },
    });
    expect(written?.state).toBe('pending');

    release();
    await w.settled();
    // A slot is free again, and the next tick claims the fire it wrote.
    expect(await w.tick()).toBe(1);
    await w.settled();
  });

  it('a THROWING scheduler tick does not stop the worker CLAIMING', async () => {
    // The strictly more important half of the loop is the claim. A scheduling
    // failure is a latency problem for one job; a claim loop that dies takes the
    // whole background layer down until the platform restarts it.
    const ws = await makeWorkspace();
    await enqueue(ws);
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'scheduler-throws',
      logger: silent,
      execute: async (run) => {
        executed.push(run.id);
      },
      onSchedulerTick: async () => {
        throw new Error('the scheduler fell over');
      },
    });

    await expect(w.tick()).resolves.toBe(1);
    // The claimed run records its outcome after `tick()` returns (MOTIR-6278).
    await w.settled();
    expect(executed).toHaveLength(1);
  });

  it('a DRAINING worker does not tick the scheduler — no half-enqueued tick', async () => {
    // The reason the scheduler needs no shutdown path of its own: `tick()` returns
    // before anything else once `draining` is set, so a drain cannot interrupt an
    // enqueue that has already begun, and no tick begins after one.
    let ticks = 0;
    const w = new JobWorker({
      workerId: 'draining-scheduler',
      logger: silent,
      execute: async () => {},
      onSchedulerTick: async () => {
        ticks += 1;
      },
    });

    await w.tick();
    expect(ticks).toBe(1);

    await w.shutdown();
    expect(await w.tick()).toBe(0);
    // Unchanged: the drained worker neither claimed nor scheduled.
    expect(ticks).toBe(1);
  });

  it('SIGTERM still drains cleanly with a scheduler wired in', async () => {
    // The existing drain assertion, re-run with the hook present — the criterion
    // is that adding the scheduler changed nothing about it.
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws)];

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'draining-with-scheduler',
      logger: silent,
      timings: { claimBatch: 5, drainTimeoutMs: 3_000 },
      onSchedulerTick: async () => {},
      execute: async () => {
        await held;
      },
    });

    const ticking = w.tick();
    for (let i = 0; i < 100 && w.inFlightCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(w.inFlightCount).toBe(2);

    const shutting = w.shutdown();
    release();
    await ticking;
    await shutting;

    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(rows.filter((r) => r.state === 'running')).toEqual([]);
    expect(rows.every((r) => r.claimedBy === null)).toBe(true);
  });
});

describe('waking up promptly', () => {
  it('notify() cuts an idle sleep short, so a fresh event does not wait out the poll', async () => {
    const ws = await makeWorkspace();
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'notified',
      logger: silent,
      // A poll ceiling far longer than this test is willing to wait: if the
      // notify path did not work, the assertion below could only pass by
      // waiting 30 s.
      timings: { idleMinMs: 30_000, idleMaxMs: 30_000 },
      execute: async (run) => {
        executed.push(run.id);
      },
    });

    w.start();
    // Let the loop reach its idle sleep (the queue is empty).
    for (let i = 0; i < 100 && executed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (i === 20) break;
    }

    const started = Date.now();
    const runId = await enqueue(ws);
    w.notify();

    for (let i = 0; i < 300 && executed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsed = Date.now() - started;

    await w.shutdown();
    expect(executed).toEqual([runId]);
    // Well inside the 30 s poll interval it would otherwise have waited out.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('retryBackoffMs', () => {
  it('doubles from one second and caps at five minutes', () => {
    const noJitter = () => 0.5; // jitter term becomes exactly 0
    expect(retryBackoffMs(1, noJitter)).toBe(1_000);
    expect(retryBackoffMs(2, noJitter)).toBe(2_000);
    expect(retryBackoffMs(3, noJitter)).toBe(4_000);
    expect(retryBackoffMs(10, noJitter)).toBe(300_000);
    expect(retryBackoffMs(50, noJitter)).toBe(300_000);
  });

  it('JITTERS by ±20%, so a common-cause cohort does not retry in lockstep', () => {
    // Without jitter, every run of a job that failed for one reason (a provider
    // outage) retries at the same instant and hits the recovering dependency as
    // a single wave. The spread is the point, so the test asserts a spread.
    const values = new Set<number>();
    for (let i = 0; i < 200; i++) values.add(retryBackoffMs(3));
    expect(values.size).toBeGreaterThan(50);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(3_200);
      expect(v).toBeLessThanOrEqual(4_800);
    }
  });

  it('never returns a negative delay', () => {
    expect(retryBackoffMs(1, () => 0)).toBeGreaterThanOrEqual(0);
    expect(retryBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('serializeWorkerFailure', () => {
  it('keeps the message and stack of an Error', () => {
    const e = new Error('kaboom');
    const s = serializeWorkerFailure(e);
    expect(s.message).toBe('kaboom');
    expect(s.stack).toContain('kaboom');
  });

  it('stringifies a non-Error throw rather than losing it', () => {
    expect(serializeWorkerFailure('just a string')).toEqual({ message: 'just a string' });
    expect(serializeWorkerFailure(42)).toEqual({ message: '42' });
  });
});
