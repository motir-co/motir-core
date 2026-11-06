import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createConcurrencyGate, type ConcurrencyGate } from '@/lib/async/concurrencyGate';
import { awaitAsIdle } from '@/lib/async/waitScope';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Bug MOTIR-10462 — A DRAIN RELEASED PARKED RUNS THAT THE GATE THEN STILL RAN.
//
// MOTIR-10457 lets the worker PARK a run waiting on an in-process gate, so it can
// hold hundreds of claims where it used to hold ten. `shutdown()` waits for the whole
// in-flight set and then releases every claim it still holds — pending again, its
// attempt refunded, claimable by another machine at once. A parked run was still in
// the gate's line when that happened, so the gate later handed it a slot and its work
// ran in the draining process while another worker could be running the same row.
//
// What this file pins, against real Postgres and the real worker loop:
//
//   1. a run parked on a gate when the drain releases its claim never starts its
//      work in that process, however the gate frees afterwards;
//   2. its queue row is left exactly as the release wrote it — pending, unclaimed,
//      attempt refunded — and the next claimant runs it ONCE;
//   3. the gate's own count stays right: a run that left the line takes no slot,
//      so the gate admits the next arrival as soon as the work inside it ends;
//   4. a run that reaches a gate AFTER its claim was released is refused at the
//      line in the same way;
//   5. a drain that does not time out cancels nothing.
//
// The end-to-end case — real deliveries through the real CI-feedback gate, the inbox
// rows left `received` — is in `tests/github/githubWebhookInbox.test.ts`.

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

/**
 * A worker whose every run does its work behind `gate`, recording the run's id in
 * `ran` the moment its work STARTS — the observable the first criterion is about.
 */
function gatedWorker(
  workerId: string,
  gate: ConcurrencyGate,
  ran: string[],
  inside: Promise<void> = Promise.resolve(),
): JobWorker {
  return new JobWorker({
    workerId,
    logger: silent,
    timings: { drainTimeoutMs: 100, idleMaxMs: 200 },
    execute: async (run: JobQueueRun) => {
      await gate.run(async () => {
        ran.push(run.id);
        await inside;
      });
    },
  });
}

/** Claim until `count` runs are parked on the gate. */
async function parkAll(w: JobWorker, count: number): Promise<void> {
  while (w.inFlightCount < count) {
    if ((await w.tick()) === 0) break;
  }
  await until(() => w.parkedCount === count, `${count} runs to park on the gate`);
}

describe('a run parked on a gate when the drain releases it (the reported defect)', () => {
  it('never starts its work in the draining process, and its row stays as the release wrote it', async () => {
    // The gate is full from outside — the three CI deliveries a burst leaves inside it.
    const gate = createConcurrencyGate(3);
    const outside = held();
    const holders = [1, 2, 3].map(() => gate.run(() => outside.wait));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue(`gated.${i}`, 10_000 - i * 10));

    const ran: string[] = [];
    const draining = gatedWorker('drain-parked', gate, ran);
    await parkAll(draining, 5);
    expect(gate.queued).toBe(5);

    await draining.shutdown(); // times out on the parked runs and releases them

    // The release wrote the rows back: pending, unclaimed, attempt refunded.
    const released = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(released.map((r) => [r.state, r.claimedBy, r.attempts])).toEqual(
      ids.map(() => ['pending', null, 0]),
    );
    // …and the released runs left the gate's line.
    expect(gate.queued).toBe(0);
    expect(draining.inFlightCount).toBe(0);

    // The gate frees. Before the fix, its slots went to the released runs, whose work
    // then ran here while the rows were claimable by any other worker.
    outside.release();
    await Promise.all(holders);
    await draining.settled();
    expect(ran).toEqual([]);
    expect(gate.active).toBe(0);

    // Nothing in the draining process wrote the rows after the release.
    const after = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(after.map((r) => [r.state, r.claimedBy, r.attempts])).toEqual(
      ids.map(() => ['pending', null, 0]),
    );

    // The next claimant runs each of them exactly once.
    const next = gatedWorker('drain-parked-next', gate, ran);
    while ((await next.tick()) > 0) await next.settled();
    await next.settled();
    expect([...ran].sort()).toEqual([...ids].sort());
    const done = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(done.map((r) => [r.state, r.attempts])).toEqual(ids.map(() => ['succeeded', 1]));
    await next.shutdown();
  });

  it('keeps the gate admitting: a run that left the line takes no slot', async () => {
    const gate = createConcurrencyGate(1);
    const outside = held();
    const holder = gate.run(() => outside.wait);
    await enqueue('gated.only', 1_000);

    const ran: string[] = [];
    const draining = gatedWorker('drain-gate-count', gate, ran);
    await parkAll(draining, 1);
    await draining.shutdown();
    expect(gate.queued).toBe(0);

    // The holder ends: its slot is FREED, not handed to the run that left.
    outside.release();
    await holder;
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'admitted')).resolves.toBe('admitted');
    expect(ran).toEqual([]);
  });

  it('a run that was BUSY at the release and reaches a gate afterwards is refused at the line', async () => {
    // Busy work released mid-execution keeps running — the step ledger lets its next
    // claimant resume it — but it must not start a NEW unit of gated work here.
    const gate = createConcurrencyGate(1);
    const before = held();
    const ran: string[] = [];
    const id = await enqueue('busy.then-gated', 1_000);
    const w = new JobWorker({
      workerId: 'drain-busy-then-gated',
      logger: silent,
      timings: { drainTimeoutMs: 100 },
      execute: async (run: JobQueueRun) => {
        await before.wait; // busy, not parked: the drain times out on it
        await gate.run(async () => {
          ran.push(run.id);
        });
      },
    });
    expect(await w.tick()).toBe(1);
    expect(w.parkedCount).toBe(0);
    await w.shutdown();

    before.release();
    await w.settled();
    expect(ran).toEqual([]);
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
    expect([row.state, row.claimedBy, row.attempts]).toEqual(['pending', null, 0]);
  });

  it('a wait reported idle outside a gate is left the same way', async () => {
    // The worker listens to the wait scope, not to the gate: any wait reported
    // through `awaitAsIdle` ends when the drain releases the run.
    const outside = held();
    let after = false;
    const id = await enqueue('idle.waiter', 1_000);
    const w = new JobWorker({
      workerId: 'drain-idle-waiter',
      logger: silent,
      timings: { drainTimeoutMs: 100 },
      execute: async () => {
        await awaitAsIdle(outside.wait);
        after = true;
      },
    });
    expect(await w.tick()).toBe(1);
    await until(() => w.parkedCount === 1, 'the waiter to park');
    await w.shutdown();
    outside.release();
    await w.settled();
    expect(after).toBe(false);
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
    expect([row.state, row.claimedBy, row.attempts]).toEqual(['pending', null, 0]);
  });
});

describe('a drain that does not time out', () => {
  it('cancels nothing: a parked run admitted before the deadline finishes and settles', async () => {
    const gate = createConcurrencyGate(1);
    const outside = held();
    const holder = gate.run(() => outside.wait);
    const id = await enqueue('gated.finishes', 1_000);
    const ran: string[] = [];
    const w = new JobWorker({
      workerId: 'drain-in-time',
      logger: silent,
      timings: { drainTimeoutMs: 5_000 },
      execute: async (run: JobQueueRun) => {
        await gate.run(async () => {
          ran.push(run.id);
        });
      },
    });
    expect(await w.tick()).toBe(1);
    await until(() => w.parkedCount === 1, 'the run to park');

    const draining = w.shutdown();
    outside.release(); // the gate frees well inside the drain's deadline
    await holder;
    await draining;

    expect(ran).toEqual([id]);
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
    expect([row.state, row.attempts]).toEqual(['succeeded', 1]);
  });
});
