import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createConcurrencyGate, type ConcurrencyGate } from '@/lib/async/concurrencyGate';
import { awaitAsIdle } from '@/lib/async/waitScope';
import { JobWorker, PARK_HEADROOM, POOL_SIZE } from '@/lib/jobs/engine/worker';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Bug MOTIR-10457 — A RUN WAITING ON AN IN-PROCESS GATE HELD A WORKER POOL SLOT.
//
// Every GitHub delivery is a `system.github-webhook-delivery` run (MOTIR-10425),
// and the CI ones wait on the three-slot CI-feedback gate. The worker counted a
// run standing in that gate's line as busy, so a burst of check deliveries filled
// the pool with seven waiters beside the three that were working, and an unrelated
// run (`email.send`, a scheduled fire, a supervisor step) waited for the whole
// backlog to drain before anything claimed it.
//
// What this file pins, against real Postgres and the real worker loop:
//
//   1. a run queued on a gate is PARKED — it leaves the pool — so the worker keeps
//      claiming, and an unrelated run enqueued after the burst is claimed and
//      settled while the burst is still waiting;
//   2. the burst still ends with every run settled, in the gate's arrival order;
//   3. a run that parks wakes a loop that was waiting for a slot, at once;
//   4. what the worker holds is bounded all the same: busy work by POOL_SIZE,
//      every claim it holds by POOL_SIZE + PARK_HEADROOM.
//
// The gate here is a fresh `createConcurrencyGate`, the same primitive the
// CI-feedback consumer builds; the end-to-end burst through the real delivery job
// and the real CI gate is in `tests/github/githubWebhookInbox.test.ts`.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

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

/** Poll an authoritative read until it holds — never a fixed sleep. */
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

let seq = 0;

/** Enqueue one due, untenanted run of `jobId`, `dueMsAgo` in the past. */
async function enqueue(jobId: string, dueMsAgo: number): Promise<string> {
  seq += 1;
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId,
      eventName: `test.event.${seq}`,
      runAt: new Date(Date.now() - dueMsAgo),
      maxAttempts: 3,
    },
  });
  return row.id;
}

async function stateOf(id: string): Promise<string> {
  return (await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } })).state;
}

/**
 * A worker whose `gated.*` runs do their work behind `gate`, holding `release`
 * while they are inside it — the shape of a CI delivery inside the CI-feedback
 * consumer — and whose every other run finishes at once.
 */
function gatedWorker(
  gate: ConcurrencyGate,
  inside: Promise<void>,
  opts: {
    order?: string[];
    timings?: ConstructorParameters<typeof JobWorker>[0]['timings'];
  } = {},
): JobWorker {
  return new JobWorker({
    workerId: `gate-wait-${seq}`,
    logger: silent,
    ...(opts.timings ? { timings: opts.timings } : {}),
    execute: async (run: JobQueueRun) => {
      if (!run.jobId.startsWith('gated.')) return;
      await gate.run(async () => {
        opts.order?.push(run.jobId);
        await inside;
      });
    },
  });
}

describe('a burst waiting on an in-process gate (the observed starvation)', () => {
  it('an unrelated run is claimed and settled while the burst waits, and the burst still drains', async () => {
    const gate = createConcurrencyGate(3);
    const inside = held();
    const order: string[] = [];
    // The burst: more gated runs than the pool has slots, all due before the
    // unrelated run, so the claim order (by `run_at`) reaches every one of them
    // first — the queue a push leaves behind.
    const burst: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      burst.push(await enqueue(`gated.${String(i).padStart(2, '0')}`, 10_000 - i * 10));
    }
    const unrelated = await enqueue('email.send', 1_000);

    const w = gatedWorker(gate, inside.wait, { order, timings: { idleMaxMs: 200 } });
    w.start();
    try {
      // THE assertion: the unrelated run settles while every gated run is still
      // waiting or inside the gate — none of them has finished.
      await until(
        async () => (await stateOf(unrelated)) === 'succeeded',
        'the unrelated run to be claimed and settled while the gate is held',
        3_000,
      );
      expect(gate.active).toBe(3);
      expect(gate.queued).toBe(11);
      expect(w.parkedCount).toBe(11);
      const running = await adminDb.jobQueueRun.count({
        where: { id: { in: burst }, state: 'running' },
      });
      expect(running).toBe(14);
    } finally {
      inside.release();
    }

    await until(
      async () =>
        (await adminDb.jobQueueRun.count({ where: { id: { in: burst }, state: 'succeeded' } })) ===
        14,
      'every gated run to settle once the gate opens',
    );
    // The gate still hands its slots out in arrival order, and arrival is claim order.
    expect(order).toEqual([...order].sort());
    expect(order).toHaveLength(14);
    expect(w.parkedCount).toBe(0);
    await w.shutdown();
  });

  it('a run that parks wakes a loop waiting for a slot, without waiting out the poll', async () => {
    // A pool of ONE and a claim batch of one, with the gate already full: the
    // first claim takes the gated run, and the loop then waits for a slot with a
    // ceiling of a minute. Only the park can wake it inside this test's seconds.
    const gate = createConcurrencyGate(1);
    const outside = held();
    const holder = gate.run(() => outside.wait);
    const inside = held();
    const gated = await enqueue('gated.only', 5_000);
    const unrelated = await enqueue('email.send', 1_000);
    const w = gatedWorker(gate, inside.wait, {
      timings: { poolSize: 1, claimBatch: 1, idleMinMs: 60_000, idleMaxMs: 60_000 },
    });
    w.start();
    try {
      await until(
        async () => (await stateOf(unrelated)) === 'succeeded',
        'the unrelated run to settle in the parked run’s slot, not after a minute',
        3_000,
      );
      expect(w.parkedCount).toBe(1);
      expect(await stateOf(gated)).toBe('running');
    } finally {
      outside.release();
      inside.release();
      await holder;
    }
    await until(async () => (await stateOf(gated)) === 'succeeded', 'the gated run to settle');
    expect(w.parkedCount).toBe(0);
    await w.shutdown();
  });
});

describe('what the worker holds stays bounded', () => {
  it('claims are bounded by the pool plus the park headroom, busy runs by the pool', async () => {
    const gate = createConcurrencyGate(1);
    const inside = held();
    // Pool 2, headroom 3: at most 5 claims in hand, of which at most 2 are busy.
    for (let i = 0; i < 8; i += 1) await enqueue(`gated.${i}`, 10_000 - i * 10);
    const w = gatedWorker(gate, inside.wait, { timings: { poolSize: 2, parkHeadroom: 3 } });
    try {
      let claimed = 0;
      for (let pass = 0; pass < 6; pass += 1) {
        claimed += await w.tick();
        await new Promise((r) => setTimeout(r, 20)); // let each claimed run reach the gate
      }
      // One inside the gate (busy), four parked in its line — then the cap.
      expect(claimed).toBe(5);
      expect(w.inFlightCount).toBe(5);
      expect(w.parkedCount).toBe(4);
      expect(w.freeCapacity).toBe(0);
      expect(await adminDb.jobQueueRun.count({ where: { state: 'pending' } })).toBe(3);
    } finally {
      inside.release();
    }
    await w.settled();
    // …and once they drain, the rest are claimed as before.
    while ((await w.tick()) > 0) await w.settled();
    expect(await adminDb.jobQueueRun.count({ where: { state: 'succeeded' } })).toBe(8);
  });

  it('a run that is not waiting stays busy: the pool still bounds real work', async () => {
    const inside = held();
    for (let i = 0; i < 4; i += 1) await enqueue(`busy.${i}`, 1_000);
    const w = new JobWorker({
      workerId: 'gate-wait-busy',
      logger: silent,
      timings: { poolSize: 2 },
      execute: () => inside.wait,
    });
    try {
      expect(await w.tick()).toBe(2);
      expect(w.parkedCount).toBe(0);
      expect(w.freeCapacity).toBe(0);
      expect(await w.tick()).toBe(0);
    } finally {
      inside.release();
    }
    await w.settled();
  });

  it('a wait outside the gate, reported idle, parks the run the same way', async () => {
    // The worker listens to the wait scope, not to the gate: anything that waits
    // through `awaitAsIdle` leaves the pool while it waits.
    const outside = held();
    const run = await enqueue('idle.waiter', 1_000);
    const w = new JobWorker({
      workerId: 'gate-wait-idle',
      logger: silent,
      timings: { poolSize: 1 },
      execute: () => awaitAsIdle(outside.wait),
    });
    expect(await w.tick()).toBe(1);
    await until(() => w.parkedCount === 1, 'the waiter to park');
    expect(w.freeCapacity).toBe(1);
    outside.release();
    await w.settled();
    expect(w.parkedCount).toBe(0);
    expect(await stateOf(run)).toBe('succeeded');
  });

  it('ships a park headroom far above the pool, so a burst of hundreds parks', () => {
    expect(PARK_HEADROOM).toBeGreaterThanOrEqual(POOL_SIZE * 10);
  });
});
