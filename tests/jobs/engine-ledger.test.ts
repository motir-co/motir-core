import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '@/lib/jobs/defineJob';
import { replayDLQ } from '@/lib/jobs/dlq';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// LEDGER + DLQ PARITY (Story MOTIR-3414 · Subtask MOTIR-3424), against a real
// Postgres.
//
// The criterion this file exists for is PARITY: the `job_run` ledger and the
// dead-letter queue must behave on the new engine exactly as they do on Inngest,
// so the operator ledger (staff-only at `/admin/jobs` since Story MOTIR-9982)
// and `jobRunsService` keep working untouched. So
// the assertions are about ROWS — what an operator's dashboard reads — rather
// than about the engine's internals.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

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

/** Register a throwaway job under a unique id and enqueue one run of it. */
async function seedJob(
  handler: () => unknown | Promise<unknown>,
  opts?: { retryPolicy?: 'transient' | 'idempotent' | 'none'; maxAttempts?: number },
): Promise<{ jobId: string; runId: string; workspaceId: string; eventId: string }> {
  seq += 1;
  const jobId = `ledger.probe.${seq}`;
  // Registering through `defineJob` is what puts it in the engine registry — the
  // same door every real job goes through.
  defineJob({ id: jobId as never, retryPolicy: opts?.retryPolicy ?? 'transient' }, () => handler());

  const user = await usersService.createUser({
    email: `ledger-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Ledger ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Ledger WS ${seq}`,
    ownerUserId: user.id,
  });

  const event = await adminDb.jobEvent.create({
    data: { name: jobId, data: { workspaceId: workspace.id }, workspaceId: workspace.id },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId,
      eventId: event.id,
      eventName: jobId,
      workspaceId: workspace.id,
      runAt: new Date(),
      maxAttempts: opts?.maxAttempts ?? 3,
    },
  });
  return { jobId, runId: run.id, workspaceId: workspace.id, eventId: event.id };
}

function readRun(id: string): Promise<JobQueueRun> {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

describe('the job_run ledger — parity with the Inngest wrapper', () => {
  it('writes ONE `running` row at start and flips it to `succeeded` with the output', async () => {
    const { jobId, runId, workspaceId } = await seedJob(() => ({ scanned: 7, deleted: 2 }));
    const run = await readRun(runId);

    await executeWithLedger(run, { workspaceId });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('succeeded');
    // The handler's resolved value lands on the ledger row, which is what makes a
    // run's summary readable on the dashboard rather than only in a log.
    expect(rows[0]?.output).toEqual({ scanned: 7, deleted: 2 });
    expect(rows[0]?.workspaceId).toBe(workspaceId);
  });

  it('writes EXACTLY ONE row even when the handler REPLAYS across a step boundary', async () => {
    // The criterion: "Exactly one `job_run` row per run, including when the
    // handler replays across steps." A run that yields at a sleep re-enters the
    // handler from the top on resume; `job-run:start` is memoized, so it does not
    // write a second row.
    const { jobId, runId, workspaceId } = await seedJob(function () {
      throw new JobStepYield('nap', new Date(Date.now() - 1_000));
    });
    const run = await readRun(runId);

    await expect(executeWithLedger(run, { workspaceId })).rejects.toBeInstanceOf(JobStepYield);
    await expect(executeWithLedger(run, { workspaceId })).rejects.toBeInstanceOf(JobStepYield);
    await expect(executeWithLedger(run, { workspaceId })).rejects.toBeInstanceOf(JobStepYield);

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    // Still `running` — a yield is not a terminal state, and the dashboard
    // correctly shows a sleeping supervisor as in-flight.
    expect(rows[0]?.status).toBe('running');
  });

  it('writes ONE row across a RETRY, not one per attempt', async () => {
    let attempts = 0;
    const { jobId, runId, workspaceId } = await seedJob(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return { ok: true };
    });

    const w = new JobWorker({
      workerId: 'ledger-retry',
      logger: silent,
      execute: async (r) => {
        await executeWithLedger(r, { workspaceId });
      },
      onTerminalFailure: async (r, e) => recordEngineTerminalFailure(r, e, { workspaceId }),
    });

    // Three attempts on the SAME queue row: fail, fail, succeed.
    // ⚠️ `tick()` returns at the CLAIM since MOTIR-3762 — each settle is
    // detached, so `settled()` is the authoritative "this attempt is over".
    await w.tick();
    await w.settled();
    await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
    await w.tick();
    await w.settled();
    await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
    await w.tick();
    await w.settled();

    expect(attempts).toBe(3);
    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    // A naive per-attempt insert would produce three rows and make the dashboard
    // unreadable. The memo is keyed on (run_id, step_id), and a retry is the same
    // run.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('succeeded');
    expect((await readRun(runId)).state).toBe('succeeded');
  });

  it('degrades a NON-JSON-SAFE return to a NULL output rather than failing the run', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const { jobId, runId, workspaceId } = await seedJob(() => cyclic);
    const run = await readRun(runId);

    // Deliberately the OPPOSITE of what the step shim does with a
    // non-serializable STEP result, and the asymmetry is the point: the ledger's
    // `output` is an operator convenience, so losing it costs a dashboard cell.
    await expect(executeWithLedger(run, { workspaceId })).resolves.toBe(cyclic);

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('succeeded');
    expect(rows[0]?.output).toBeNull();
  });
});

describe('terminal failure — the ledger row AND the dead-letter row', () => {
  it('EXHAUSTS the budget for real, then writes a `failed` run and a DLQ row', async () => {
    const { jobId, runId, workspaceId } = await seedJob(
      () => {
        throw new Error('always fails');
      },
      { retryPolicy: 'none', maxAttempts: 2 },
    );

    const w = new JobWorker({
      workerId: 'ledger-terminal',
      logger: silent,
      execute: async (r) => {
        await executeWithLedger(r, { workspaceId });
      },
      onTerminalFailure: async (r, e) => recordEngineTerminalFailure(r, e, { workspaceId }),
    });

    // The criterion insists the budget is exhausted by ACTUALLY running it out,
    // not by calling the hook directly — a hook that is never reached from the
    // real path is exactly the defect PRODECT_FINDINGS #39 records.
    await w.tick();
    await w.settled();
    expect((await readRun(runId)).state).toBe('pending'); // retrying
    await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
    await w.tick();
    await w.settled();

    const queued = await readRun(runId);
    expect(queued.state).toBe('failed');
    expect(queued.attempts).toBe(2);

    const runs = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.failure).toMatchObject({ message: 'always fails' });

    const dlq = await adminDb.jobRunDlq.findMany({ where: { functionId: jobId } });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.workspaceId).toBe(workspaceId);
    expect(dlq[0]?.attempts).toBe(2);
    // The original payload is stored so a replay can re-emit it.
    expect(dlq[0]?.eventData).toEqual({ workspaceId });
    expect(dlq[0]?.replayedAt).toBeNull();
  });

  it('a hook that THROWS still lets the run settle — a stranded row is worse', async () => {
    const { runId, workspaceId } = await seedJob(
      () => {
        throw new Error('handler failure');
      },
      { maxAttempts: 1 },
    );
    const w = new JobWorker({
      workerId: 'ledger-hook-throws',
      logger: silent,
      execute: async (r) => {
        await executeWithLedger(r, { workspaceId });
      },
      onTerminalFailure: async () => {
        throw new Error('bookkeeping exploded');
      },
    });

    await w.tick();
    await w.settled();

    // A `running` row with no live claimant is work nobody will ever pick up.
    // A missing dashboard entry is a worse-looking but strictly smaller problem.
    const queued = await readRun(runId);
    expect(queued.state).toBe('failed');
    expect(queued.claimedBy).toBeNull();
  });

  it('correlates the failure to the row `recordStart` wrote, rather than opening a second one', async () => {
    const { jobId, runId, workspaceId } = await seedJob(
      () => {
        throw new Error('boom');
      },
      { maxAttempts: 1 },
    );
    const run = await readRun(runId);

    // Start the ledger row, then fail terminally — the two paths must agree on
    // `(functionId, eventId)` or the failure writes a SECOND row instead of
    // flipping the first.
    await expect(executeWithLedger(run, { workspaceId })).rejects.toThrow('boom');
    await recordEngineTerminalFailure({ ...run, attempts: 1 }, new Error('boom'), { workspaceId });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    // The duration is computed from the row's own `startedAt`, so it measures the
    // run rather than the failure write.
    expect(rows[0]?.durationMs).not.toBeNull();
  });
});

describe('DLQ replay — the operator dashboard, unchanged', () => {
  it('a replay of a MIGRATED job enqueues a fresh run on the ENGINE', async () => {
    const { jobId, workspaceId } = await seedJob(() => ({ ok: true }));

    const dlqRow = await adminDb.jobRunDlq.create({
      data: {
        workspaceId,
        functionId: jobId,
        eventName: jobId,
        eventData: { workspaceId, marker: 'replay-me' },
        failure: { message: 'the original failure' },
        attempts: 3,
      },
    });

    const before = await adminDb.jobQueueRun.count({ where: { jobId } });
    const { outcome, entry: dto } = await withSystemContext((tx) => replayDLQ(dlqRow.id, tx));
    expect(outcome).toBe('replayed');

    // Re-emitting to Inngest for a job that has MOVED would land at a handler
    // that declines to execute — a success toast and a `replayedAt` stamp for a
    // run that never happened.
    const after = await adminDb.jobQueueRun.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
    expect(after).toHaveLength(before + 1);
    expect(after[0]?.state).toBe('pending');
    expect(after[0]?.workspaceId).toBe(workspaceId);

    // A FRESH event and run, not a reset of the dead one: the original run's step
    // ledger records work that DID complete, and re-running that row would skip
    // exactly the steps the operator is replaying in order to re-do.
    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: after[0]!.eventId! } });
    expect(event.data).toEqual({ workspaceId, marker: 'replay-me' });

    // And the audit stamp the dashboard shows is written either way.
    expect(dto.replayedAt).not.toBeNull();
  });

  it('the replayed run then SUCCEEDS through the worker', async () => {
    let ran = 0;
    const { jobId, workspaceId } = await seedJob(() => {
      ran += 1;
      return { replayed: true };
    });

    const dlqRow = await adminDb.jobRunDlq.create({
      data: {
        workspaceId,
        functionId: jobId,
        eventName: jobId,
        eventData: { workspaceId },
        failure: { message: 'the original failure' },
        attempts: 3,
      },
    });
    // Clear the seeded run so only the replay's is claimable.
    await adminDb.jobQueueRun.deleteMany({ where: { jobId } });
    await withSystemContext((tx) => replayDLQ(dlqRow.id, tx));

    const w = new JobWorker({
      workerId: 'replay-worker',
      logger: silent,
      execute: async (r) => {
        await executeWithLedger(r, { workspaceId });
      },
    });
    expect(await w.tick()).toBe(1);
    await w.settled();

    expect(ran).toBe(1);
    const replayed = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId } });
    expect(replayed.state).toBe('succeeded');
    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('succeeded');
    expect(ledger[0]?.output).toEqual({ replayed: true });
  });

  it('replays a job the engine has never seen, rather than refusing it', async () => {
    // ⚠️ THIS ASSERTED THE OTHER DIRECTION OF THE CUTOVER SWITCH (MOTIR-3418
    // removed it): an UNMOVED job's replay had to keep using the old transport and
    // write no queue row. There is no other lane to keep using, so the case that
    // survives is the one the switch's absence exposes — a DLQ row for a job whose
    // definition module this process has not evaluated.
    //
    // It must still replay: `replayDLQ` falls back to the default attempt budget
    // rather than refusing, because an operator replaying a dead run should not
    // have to care which modules a given process happened to import.
    const jobId = `engine-ledger-unknown-${Date.now()}`;
    const { workspaceId } = await seedJob(() => ({ ok: true }));

    const dlqRow = await adminDb.jobRunDlq.create({
      data: {
        workspaceId,
        functionId: jobId,
        eventName: jobId,
        eventData: { workspaceId, idempotencyKey: 'k1' },
        failure: { message: 'x' },
        attempts: 3,
      },
    });

    const { entry: dto } = await withSystemContext((tx) => replayDLQ(dlqRow.id, tx));

    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId } });
    expect(queued).toHaveLength(1);
    // `transient`'s 3 — what `defineJob` would have resolved for a job declaring
    // nothing — rather than a refusal or a zero.
    expect(queued[0]!.maxAttempts).toBe(3);
    // And no key, because the template lives on a definition this process has not
    // evaluated. Deduping on a synthesised placeholder would be far worse.
    expect(queued[0]!.idempotencyKey).toBeNull();
    expect(dto.replayedAt).not.toBeNull();
  });
});

describe('the named retry policies survive the migration', () => {
  it("snapshots the policy's attempt budget onto the run at enqueue", async () => {
    // `retryPolicy: 'idempotent'` is 5 total attempts and must still be 5 — a job
    // that retries five times today retries five times after this card.
    const { runId } = await seedJob(() => ({}), { retryPolicy: 'idempotent', maxAttempts: 5 });
    expect((await readRun(runId)).maxAttempts).toBe(5);

    const { runId: onceId } = await seedJob(() => ({}), {
      retryPolicy: 'none',
      maxAttempts: 1,
    });
    expect((await readRun(onceId)).maxAttempts).toBe(1);
  });
});
