import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker, type JobWorkerOptions } from '@/lib/jobs/engine/worker';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { JobRunDefer } from '@/lib/jobs/engine/defer';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Bug MOTIR-10466 — A RUN RELEASED BY A TIMED-OUT DRAIN STILL WROTE ITS SETTLE.
//
// `shutdown()` waits `drainTimeoutMs`, then `releaseClaims` gives every run it still
// holds back to the queue: `pending`, `claimed_by` null, attempt refunded. MOTIR-10462
// withdraws a run that is PARKED on a gate at that moment. A run that is BUSY — past
// every gate — keeps executing in the draining process, and when it finished its settle
// wrote `succeeded` (or a reschedule, or `failed`) keyed on the row's id alone. If
// another worker had claimed the row in between, its `running` row read `succeeded`
// with no claimant while it was still executing.
//
// What this file pins, against real Postgres and the real worker loop:
//
//   1. whatever the busy run's pass ends in — success, a sleep, a defer, a retryable
//      or a terminal failure — its settle never changes a row another worker has
//      claimed, and the pass is reported `released`;
//   2. a terminal failure on a released row writes no dead-letter record either;
//   3. a released row that nobody has re-claimed is left exactly as the release
//      wrote it, and its next claimant runs it to `succeeded`;
//   4. the repository's three settle writes are fenced on the claim themselves.

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

/** Enqueue one due, untenanted run. */
async function enqueue(jobId: string, maxAttempts = 3): Promise<string> {
  const row = await adminDb.jobQueueRun.create({
    data: { jobId, eventName: `test.${jobId}`, runAt: new Date(Date.now() - 1_000), maxAttempts },
  });
  return row.id;
}

async function rowOf(id: string): Promise<[string, string | null, number]> {
  const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
  return [row.state, row.claimedBy, row.attempts];
}

type Outcome = Parameters<NonNullable<JobWorkerOptions['onOutcome']>>[1];

/**
 * Worker A: its one run is BUSY on `busy` (not parked on any gate) when the drain
 * releases it, and ends with `end` once the test lets it go.
 */
function busyWorker(
  busy: Promise<void>,
  end: () => void,
  extra: Partial<JobWorkerOptions> = {},
): { worker: JobWorker; outcomes: Outcome[] } {
  const outcomes: Outcome[] = [];
  const worker = new JobWorker({
    workerId: 'probe-a',
    logger: silent,
    timings: { drainTimeoutMs: 50 },
    execute: async () => {
      await busy;
      end();
    },
    onOutcome: (_run, outcome) => outcomes.push(outcome),
    ...extra,
  });
  return { worker, outcomes };
}

/** Worker B: holds the row `running` until the test lets it finish. */
function claimingWorker(finish: Promise<void>): { worker: JobWorker; ran: string[] } {
  const ran: string[] = [];
  const worker = new JobWorker({
    workerId: 'probe-b',
    logger: silent,
    execute: async (run: JobQueueRun) => {
      ran.push(run.id);
      await finish;
    },
  });
  return { worker, ran };
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

describe('a BUSY run released by a timed-out drain (the reported defect)', () => {
  it.each(PASS_ENDINGS)(
    'never changes the row another worker claimed when its pass %s',
    async (_name, end) => {
      const id = await enqueue('busy.released');
      const busy = held();
      let hookCalls = 0;
      const a = busyWorker(busy.wait, end, {
        onTerminalFailure: async () => {
          hookCalls += 1;
        },
      });

      // 1. A claims the run; its handler is busy, not parked.
      expect(await a.worker.tick()).toBe(1);
      expect(a.worker.parkedCount).toBe(0);

      // 2. The drain times out and releases it.
      await a.worker.shutdown();
      expect(await rowOf(id)).toEqual(['pending', null, 0]);

      // 3. B claims it and is executing.
      const bFinish = held();
      const b = claimingWorker(bFinish.wait);
      expect(await b.worker.tick()).toBe(1);
      expect(await rowOf(id)).toEqual(['running', 'probe-b', 1]);

      // 4. A's handler ends. Before the fix this wrote over B's row.
      busy.release();
      await a.worker.settled();
      expect(await rowOf(id)).toEqual(['running', 'probe-b', 1]);
      expect(a.outcomes).toEqual(['released']);
      expect(hookCalls).toBe(0);

      // B's own settle is the one that lands.
      bFinish.release();
      await b.worker.settled();
      expect(b.ran).toEqual([id]);
      expect(await rowOf(id)).toEqual(['succeeded', null, 1]);
      await b.worker.shutdown();
    },
  );

  it('leaves a row nobody re-claimed as the release wrote it, and its next claimant runs it', async () => {
    const id = await enqueue('busy.unclaimed');
    const busy = held();
    const a = busyWorker(busy.wait, () => {});
    expect(await a.worker.tick()).toBe(1);
    await a.worker.shutdown();

    busy.release();
    await a.worker.settled();
    // The released run's completed pass wrote nothing: the row is the next claimant's.
    expect(await rowOf(id)).toEqual(['pending', null, 0]);
    expect(a.outcomes).toEqual(['released']);

    const next = claimingWorker(Promise.resolve());
    expect(await next.worker.tick()).toBe(1);
    await next.worker.settled();
    expect(next.ran).toEqual([id]);
    expect(await rowOf(id)).toEqual(['succeeded', null, 1]);
    await next.worker.shutdown();
  });

  it('a claim lost DURING the terminal-failure hook writes no failed row over the release', async () => {
    // The hook runs before the mark, so a release can land between the two. The mark
    // is fenced, so the row stays as the release wrote it.
    const id = await enqueue('busy.hook-race', 1);
    const outcomes: Outcome[] = [];
    const worker = new JobWorker({
      workerId: 'probe-hook',
      logger: silent,
      execute: async () => {
        throw new Error('spent');
      },
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      onTerminalFailure: async () => {
        await withSystemContext((tx) => jobQueueRepository.releaseClaims('probe-hook', tx));
      },
    });
    expect(await worker.tick()).toBe(1);
    await worker.settled();
    expect(await rowOf(id)).toEqual(['pending', null, 0]);
    expect(outcomes).toEqual(['released']);
    await worker.shutdown();
  });

  it('a run that still holds its claim settles exactly as before', async () => {
    const id = await enqueue('held.settles');
    const outcomes: Outcome[] = [];
    const worker = new JobWorker({
      workerId: 'probe-held',
      logger: silent,
      execute: async () => {},
      onOutcome: (_run, outcome) => outcomes.push(outcome),
    });
    expect(await worker.tick()).toBe(1);
    await worker.settled();
    expect(await rowOf(id)).toEqual(['succeeded', null, 1]);
    expect(outcomes).toEqual(['succeeded']);
    await worker.shutdown();
  });
});

describe('the settle writes are fenced on the claim (jobQueueRepository)', () => {
  async function claimed(by: string): Promise<string> {
    const id = await enqueue(`fence.${by}`);
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns(by, 1, 60_000, tx));
    return id;
  }

  it('writes over a row this worker holds', async () => {
    const a = await claimed('w-a');
    expect(await withSystemContext((tx) => jobQueueRepository.markSucceeded(a, 'w-a', tx))).toBe(
      true,
    );
    expect(await rowOf(a)).toEqual(['succeeded', null, 1]);
  });

  it('writes nothing over a row another worker holds, or one no worker holds', async () => {
    const id = await claimed('w-other');
    const at = new Date(Date.now() + 60_000);
    await withSystemContext(async (tx) => {
      expect(await jobQueueRepository.markSucceeded(id, 'w-me', tx)).toBe(false);
      expect(await jobQueueRepository.markFailed(id, 'w-me', { message: 'x' }, tx)).toBe(false);
      expect(
        await jobQueueRepository.rescheduleAt(id, 'w-me', at, tx, { refundAttempt: true }),
      ).toBe(false);
    });
    expect(await rowOf(id)).toEqual(['running', 'w-other', 1]);

    await withSystemContext((tx) => jobQueueRepository.releaseClaims('w-other', tx));
    await withSystemContext(async (tx) => {
      // Released: `claimed_by` is null and the state `pending`, so even its former
      // holder no longer writes over it.
      expect(await jobQueueRepository.markSucceeded(id, 'w-other', tx)).toBe(false);
    });
    expect(await rowOf(id)).toEqual(['pending', null, 0]);
  });
});
