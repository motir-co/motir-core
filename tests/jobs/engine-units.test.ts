import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob, type DefineJobOptions } from '@/lib/jobs/defineJob';
import { CATCH_UP_POLICY_NAMES } from '@/lib/jobs/catchUp';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import {
  engineJob,
  engineJobs,
  engineScheduledJobs,
  engineSubscribers,
} from '@/lib/jobs/engine/registry';
import { buildEngineContext, runQueuedJob, UnknownEngineJobError } from '@/lib/jobs/engine/runner';
import { closeQuietly, listenForQueuedJobs, notifyQueuedJob } from '@/lib/jobs/engine/notify';
import { JOB_QUEUE_CHANNEL, JobWorker, serializeWorkerFailure } from '@/lib/jobs/engine/worker';
import { createStepApi, JobStepYield } from '@/lib/jobs/engine/step';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import '@/lib/jobs/registry';

// The story gate's COVERAGE TOP-UP (Story MOTIR-3414 · Subtask MOTIR-3426).
//
// Each subtask ships its own units as the floor; this file tops up what falls
// BETWEEN them — the repository reads nothing else happened to call, the
// registry's query surface, the runner's context construction, and the
// LISTEN/NOTIFY path, which no other test drives because it is a latency
// optimisation rather than a correctness path.

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
    email: `units-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Units ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Units WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

describe('the engine registry — the query surface the dispatcher and the scheduler read', () => {
  it('holds every REAL job, keyed by id and sorted', () => {
    const all = engineJobs();
    // 37 registered functions across 24 definition files, on origin/main. The
    // assertion is a floor rather than a literal: a story that adds a job must
    // not have to edit this test, but an EMPTY registry — the shape a missing
    // side-effect import produces — must fail it.
    expect(all.length).toBeGreaterThan(30);
    expect(all.map((d) => d.id)).toEqual([...all.map((d) => d.id)].sort());
    expect(engineJob('email.send')?.id).toBe('email.send');
    expect(engineJob('no.such.job')).toBeUndefined();
  });

  it('carries the resolved attempt BUDGET, translated from Inngest’s retry count', () => {
    // `retryPolicy: 'transient'` is 3 total attempts; Inngest's `retries` is 2.
    // The +1 translation happens once, in `defineJob`, and this pins it.
    expect(engineJob('email.send')?.maxAttempts).toBe(3);
    // `system.daily-health-check` declares `none` — exactly one attempt.
    expect(engineJob('system.daily-health-check')?.maxAttempts).toBe(1);
  });

  it('separates SUBSCRIBERS from SCHEDULED jobs — a cron job subscribes to nothing', () => {
    const scheduled = engineScheduledJobs();
    expect(scheduled.length).toBeGreaterThan(10);
    for (const s of scheduled) {
      expect(s.cron).toBeTruthy();
      // A cron job has no trigger, so it can never be pulled into a fan-out by an
      // event that happens to share its id.
      expect(s.trigger).toBeUndefined();
      expect(engineSubscribers(s.id)).toEqual([]);
    }
  });

  it('a re-registration OVERWRITES rather than duplicating', () => {
    seq += 1;
    const id = `units.rereg.${seq}`;
    defineJob({ id: id as never, retryPolicy: 'none' }, () => 'first');
    defineJob({ id: id as never, retryPolicy: 'idempotent' }, () => 'second');
    // Module re-evaluation under HMR or a test harness must not grow the table.
    expect(engineJobs().filter((d) => d.id === id)).toHaveLength(1);
    expect(engineJob(id)?.maxAttempts).toBe(5);
  });
});

describe('the catch-up disposition is DECLARED and cannot be omitted (MOTIR-3470)', () => {
  // `docs/decisions/job-queue-foundation.md` §11 is the decision; this block is
  // what makes it un-skippable. The three assertions are deliberately different
  // KINDS: one holds at compile time, one walks the real registry, and one reads
  // the record itself — so neither the code nor the document can move alone.

  it('a `cron` job that omits `catchUp` DOES NOT TYPE-CHECK', () => {
    // ⚠️ A COMPILE-LEVEL assertion, because a rule enforced only by review is not
    // enforced. `@ts-expect-error` fails the build if the line below ever STOPS
    // erroring, which is the direction that matters: it is what would happen if
    // someone gave `catchUp` a default or made it optional.
    // @ts-expect-error — a definition supplying `cron` must supply `catchUp`.
    const missingCatchUp: DefineJobOptions<'system.attachment-gc'> = {
      id: 'system.attachment-gc',
      cron: '30 3 * * *',
    };
    void missingCatchUp;

    // The mirror: the option is meaningless without a schedule, and an
    // accepted-but-ignored field is a lie.
    // @ts-expect-error — an event-triggered definition may not supply `catchUp`.
    const catchUpWithoutCron: DefineJobOptions<'email.send'> = {
      id: 'email.send',
      catchUp: 'latest',
    };
    void catchUpWithoutCron;

    // A well-formed pair compiles — otherwise the two negatives above would pass
    // against a type that rejects everything.
    const wellFormed: DefineJobOptions<'system.attachment-gc'> = {
      id: 'system.attachment-gc',
      cron: '30 3 * * *',
      catchUp: 'latest',
    };
    expect(wellFormed.catchUp).toBe('latest');
  });

  it('EVERY job in the real registry that declares a cron carries a disposition', () => {
    // Walked from `engineScheduledJobs()`, never from a transcribed list of
    // fourteen — the enumeration that was already wrong once (the count read
    // FILES, and `ciRunnerFleet.ts` declares two). A fifteenth cron job added
    // later fails HERE rather than shipping with no policy.
    const scheduled = engineScheduledJobs();
    expect(scheduled.length).toBeGreaterThan(10);
    for (const def of scheduled) {
      expect(def.cron, `${def.id} declares a cron`).toBeTruthy();
      expect(CATCH_UP_POLICY_NAMES, `${def.id} carries a known catchUp`).toContain(def.catchUp);
    }

    // And the converse: nothing event-triggered carries one, so the field can
    // never be read on a job the scheduler does not own.
    for (const def of engineJobs().filter((d) => d.cron === undefined)) {
      expect(def.catchUp, `${def.id} is event-triggered`).toBeUndefined();
    }
  });

  // ⚠️ THE THIRD ASSERTION OF THIS BLOCK LIVES IN
  // `tests/jobs/catch-up-disposition-adr.test.ts` (MOTIR-4408) — *each
  // disposition MATCHES the amendment*, which read §11.4 off disk and held the
  // registry against it. It moved because its SUBJECT is a `docs/**` file, and
  // a guard whose subject is a document has to run on the one diff shape this
  // file cannot: `ci.yml`'s `changes` job reads a documentation-only pull
  // request as `app=false` and skips the sharded Vitest job entirely, so the
  // §11.4 edit that falsifies that assertion was the one edit never to execute
  // it. The docs-guard lane runs unconditionally and has no database, and THIS
  // file needs one — `@/lib/db`, `../helpers/adminDb` and a file-scoped
  // `beforeEach` truncation — so only the assertion moved, not the file.
  //
  // The block's three assertions are still three different KINDS and still
  // check each other: one holds at compile time (above), one walks the real
  // registry (above), and one reads the record itself (there). Neither the code
  // nor the document can move alone.

  it('carries `catchUp` on the registered definition, beside the cron it qualifies', () => {
    // ⚠️ THIS ASSERTION IS INVERTED FROM WHAT IT WAS (MOTIR-3418). It read "does
    // NOT forward `catchUp` to Inngest", because the option describes a scheduler
    // the vendor did not have, and putting an unknown key into a SYNCED config
    // would have been a change to a deployed registration for no reader. There is
    // no vendor config to keep clean any more — the only registration is the
    // engine's own, and `catchUp` is a first-class member of it because the
    // engine's scheduler is the thing that reads it.
    const def = defineJob(
      { id: 'system.attachment-gc', cron: '30 3 * * *', catchUp: 'latest' },
      () => undefined,
    );
    expect(def.catchUp).toBe('latest');
    expect(def.cron).toBe('30 3 * * *');
    // 3 ATTEMPTS under the default `transient` policy — the engine counts total
    // attempts, so this is the same budget the old `retries: 2` expressed.
    expect(def.maxAttempts).toBe(3);
  });
});

describe('the runner — building the context a handler sees', () => {
  it('exposes exactly the four members handlers use, and maps attempt to ZERO-INDEXED', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'email.send',
        eventName: 'email.send',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 3,
        attempts: 2,
      },
    });

    const ctx = buildEngineContext(run, { to: 'a@example.com' });
    expect(ctx.event.name).toBe('email.send');
    expect(ctx.event.data).toEqual({ to: 'a@example.com' });
    expect(ctx.runId).toBe(run.id);
    // `job_queue.attempts` counts attempts INCLUDING the current one; Inngest's
    // `ctx.attempt` is zero-indexed. The three handlers that read it compare
    // against a retry budget, so an off-by-one here changes behaviour silently.
    expect(ctx.attempt).toBe(1);
    expect(typeof ctx.step.run).toBe('function');
    expect(typeof ctx.step.sleep).toBe('function');
  });

  it('omits the event id for a CRON run and floors the attempt at zero', async () => {
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.attachment-gc',
        eventName: 'scheduled.system.attachment-gc',
        runAt: new Date(),
        maxAttempts: 5,
        attempts: 0,
      },
    });
    const ctx = buildEngineContext(run, null);
    expect(ctx.event.id).toBeUndefined();
    // An unclaimed row has `attempts: 0`; a negative attempt would be nonsense.
    expect(ctx.attempt).toBe(0);
    expect(ctx.event.data).toEqual({});
  });

  it('REFUSES a run naming an unregistered job, with a message that says why', async () => {
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'ghost.job',
        eventName: 'ghost',
        runAt: new Date(),
        maxAttempts: 1,
      },
    });
    await expect(runQueuedJob(run, {})).rejects.toBeInstanceOf(UnknownEngineJobError);
    // The two real causes are named, because "unknown job" alone sends the reader
    // looking for a deleted definition when the usual cause is a missing import.
    await expect(runQueuedJob(run, {})).rejects.toThrow(/never imported|deleted/);
  });

  it('EXECUTES a registered job through the real handler', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const id = `units.runner.${seq}`;
    let sawServices = false;
    defineJob({ id: id as never }, (_ctx, services) => {
      sawServices = typeof services.workItems === 'object';
      return { ran: true };
    });
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: id, eventName: id, workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });

    await expect(runQueuedJob(run, { workspaceId: ws })).resolves.toEqual({ ran: true });
    // The service bag is injected, so the 4-layer rule holds for background work
    // exactly as it does on Inngest.
    expect(sawServices).toBe(true);
  });
});

describe('LISTEN / NOTIFY — the latency path', () => {
  it('delivers a notification to a listening worker', async () => {
    let woke = 0;
    const listener = await listenForQueuedJobs(() => {
      woke += 1;
    });
    try {
      expect(listener.connected).toBe(true);

      await withSystemContext(async (tx) => {
        await notifyQueuedJob((sql) => tx.$executeRawUnsafe(sql));
      });

      // Wait on the SIGNAL, not on a duration.
      for (let i = 0; i < 200 && woke === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(woke).toBeGreaterThan(0);
    } finally {
      await listener.stop();
    }
    expect(listener.connected).toBe(false);
  });

  it('stop() is idempotent — a double shutdown must not throw', async () => {
    const listener = await listenForQueuedJobs(() => {});
    await listener.stop();
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it('SURVIVES an unreachable database — degraded to polling, never a crash', async () => {
    // The property that makes NOTIFY safe to depend on for latency and not for
    // correctness: a listener that cannot connect must not take the worker with
    // it. Port 1 refuses immediately.
    const warns: unknown[] = [];
    const listener = await listenForQueuedJobs(() => {}, {
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nothing',
      logger: { info: () => {}, warn: (...a: unknown[]) => warns.push(a) },
      reconnectMs: 60_000,
    });
    try {
      expect(listener.connected).toBe(false);
      expect(warns.length).toBeGreaterThan(0);
    } finally {
      await listener.stop();
    }
  });

  it('prefers the UNPOOLED url — a transaction-mode pooler cannot hold a LISTEN', async () => {
    // MOTIR-3454. In production `DATABASE_URL` is Neon's POOLED endpoint, where
    // `LISTEN` binds to a session the pooler immediately recycles — so the
    // subscription never delivers and the engine silently loses its latency path.
    //
    // Asserted BEHAVIOURALLY rather than by spying on `pg`: point the unpooled
    // name at a port that refuses instantly and leave `DATABASE_URL` working
    // (`perWorkerDb` has already bound it to this worker's database). A listener
    // that comes up chose the pooled url, which is exactly the bug.
    vi.stubEnv('DATABASE_URL_UNPOOLED', 'postgresql://nobody:nobody@127.0.0.1:1/nothing');
    try {
      const listener = await listenForQueuedJobs(() => {}, {
        logger: { info: () => {}, warn: () => {} },
        reconnectMs: 60_000,
      });
      try {
        expect(listener.connected).toBe(false);
      } finally {
        await listener.stop();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to DATABASE_URL when no unpooled name is set — local dev and CI', async () => {
    // The other arm of the same chain, and it is not merely for coverage: with no
    // pooler in front of it, `DATABASE_URL` IS the direct connection, and CI sets
    // no `DATABASE_URL_UNPOOLED` at all (`ci.yml`'s test jobs set one variable).
    // Deleting the unpooled name must therefore leave a WORKING listener, not a
    // dead one — otherwise the production fix would cost every developer their
    // local latency path.
    vi.stubEnv('DATABASE_URL_UNPOOLED', undefined);
    try {
      const listener = await listenForQueuedJobs(() => {});
      try {
        expect(listener.connected).toBe(true);
      } finally {
        await listener.stop();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a failing NOTIFY is SWALLOWED — the poll picks the run up regardless', async () => {
    const warns: unknown[] = [];
    await expect(
      notifyQueuedJob(() => Promise.reject(new Error('connection gone')), {
        warn: (...a: unknown[]) => warns.push(a),
      }),
    ).resolves.toBeUndefined();
    // Costing latency is the whole failure mode; costing WORK would not be.
    expect(warns).toHaveLength(1);
  });

  it('names a stable channel both halves agree on', () => {
    // The listener and the dispatcher must not drift; the constant is the reason
    // they cannot.
    expect(JOB_QUEUE_CHANNEL).toBe('motir_job_queue');
  });
});

describe('the repositories — the reads nothing else happened to exercise', () => {
  it('jobEventRepository reads back, lists per tenant newest-first, and counts by name', async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const mk = (name: string, workspaceId: string | null, at: Date) =>
      adminDb.jobEvent.create({
        data: { name, data: {}, workspaceId, receivedAt: at },
      });

    // ⚠️ DISTINCT timestamps for every row. An earlier version gave two of them
    // the same `receivedAt`, and `ORDER BY received_at DESC` then leaves their
    // relative order to the planner — a test that passes or fails on which row
    // the index happens to return first.
    const t = Date.now();
    const oldest = await mk('b.event', ws, new Date(t - 30_000));
    const older = await mk('a.event', ws, new Date(t - 20_000));
    const newer = await mk('a.event', ws, new Date(t - 10_000));
    await mk('a.event', other, new Date(t));

    await withSystemContext(async (tx) => {
      expect((await jobEventRepository.findById(newer.id, tx))?.id).toBe(newer.id);
      expect(await jobEventRepository.findById('nope', tx)).toBeNull();

      const listed = await jobEventRepository.listByWorkspace(ws, 10, tx);
      // Newest first, this tenant only — the other workspace's row is absent even
      // though it is the newest of all four.
      expect(listed.map((e) => e.id)).toEqual([newer.id, older.id, oldest.id]);
      expect(listed.every((e) => e.workspaceId === ws)).toBe(true);

      // `take` is required rather than defaulted: an unbounded read of an
      // append-only log is a page that gets slower every day.
      expect(await jobEventRepository.listByWorkspace(ws, 1, tx)).toHaveLength(1);
      // Counts across tenants — it is an operational read, not a tenant surface.
      expect(await jobEventRepository.countByName('a.event', tx)).toBe(3);
      expect(await jobEventRepository.countByName('nothing', tx)).toBe(0);
    });
  });

  it('jobStepRepository lists, re-times a sleep, counts by kind and deletes a run’s steps', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: 'x', eventName: 'x', workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    const sleep = await adminDb.jobStep.create({
      data: {
        runId: run.id,
        stepId: 'nap',
        kind: 'sleep',
        sleepUntil: new Date('2026-01-01T00:00:00.000Z'),
        workspaceId: ws,
      },
    });
    await adminDb.jobStep.create({
      data: { runId: run.id, stepId: 'work', kind: 'run', result: { n: 1 }, workspaceId: ws },
    });

    await withSystemContext(async (tx) => {
      expect((await jobStepRepository.listByRun(run.id, tx)).map((s) => s.stepId)).toEqual([
        'nap',
        'work',
      ]);
      expect(await jobStepRepository.countByRunAndKind(run.id, 'sleep', tx)).toBe(1);
      expect(await jobStepRepository.countByRunAndKind(run.id, 'run', tx)).toBe(1);

      const moved = await jobStepRepository.updateSleepUntil(
        sleep.id,
        new Date('2027-01-01T00:00:00.000Z'),
        tx,
      );
      expect(moved.sleepUntil?.toISOString()).toBe('2027-01-01T00:00:00.000Z');

      // Teardown, NOT the retry path — a retry must keep the memo, which is the
      // whole point of the table.
      expect(await jobStepRepository.deleteByRun(run.id, tx)).toBe(2);
      expect(await jobStepRepository.listByRun(run.id, tx)).toEqual([]);
    });
  });

  it('jobQueueRepository reads one row and counts by state', async () => {
    const ws = await makeWorkspace();
    const a = await adminDb.jobQueueRun.create({
      data: { jobId: 'q1', eventName: 'q', workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'q2',
        eventName: 'q',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 1,
        state: 'succeeded',
      },
    });

    await withSystemContext(async (tx) => {
      expect((await jobQueueRepository.findById(a.id, tx))?.jobId).toBe('q1');
      expect(await jobQueueRepository.findById('missing', tx)).toBeNull();
      expect(await jobQueueRepository.countByState('pending', tx)).toBe(1);
      expect(await jobQueueRepository.countByState('succeeded', tx)).toBe(1);
      expect(await jobQueueRepository.countByState('failed', tx)).toBe(0);
    });
  });

  it('rescheduleAt carries a lastError and can refund an attempt', async () => {
    const ws = await makeWorkspace();
    const row = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'r1',
        eventName: 'r',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 3,
        attempts: 2,
        state: 'running',
        claimedBy: 'w',
      },
    });
    const at = new Date(Date.now() + 60_000);

    await withSystemContext(async (tx) => {
      expect(
        await jobQueueRepository.rescheduleAt(row.id, 'w', at, tx, {
          refundAttempt: true,
          lastError: { message: 'transient' },
        }),
      ).toBe(true);
      const back = await tx.jobQueueRun.findUniqueOrThrow({ where: { id: row.id } });
      expect(back.state).toBe('pending');
      expect(back.runAt.getTime()).toBe(at.getTime());
      // A sleep is not a failure, so the attempt goes back.
      expect(back.attempts).toBe(1);
      expect(back.claimedBy).toBeNull();
      expect(back.lastError).toEqual({ message: 'transient' });
    });
  });

  it('releaseClaims and reclaimExpiredLeases touch nothing when there is nothing to touch', async () => {
    // The empty case matters: both run on EVERY tick and every shutdown, so a
    // version that mis-scoped its WHERE would quietly rewrite the queue.
    await withSystemContext(async (tx) => {
      expect(await jobQueueRepository.releaseClaims('nobody', tx)).toBe(0);
      expect(await jobQueueRepository.reclaimExpiredLeases(tx)).toBe(0);
      expect(await jobQueueRepository.renewLeases('nobody', 1000, tx)).toBe(0);
    });
  });
});

describe('the branches the happy paths never reach', () => {
  it('step.run RE-READS the winner’s result when it loses the memo race', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'race',
        eventName: 'race',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });
    const step = createStepApi({ runId: run.id, workspaceId: ws });

    // ⚠️ THE WINNER MUST LAND *BETWEEN* THE LOOKUP AND THE INSERT — that is the
    // race. Seeding it beforehand takes the ordinary memo path instead and the
    // handler never runs at all, which is what an earlier version of this test
    // actually measured. Writing it from inside the handler puts it in exactly
    // the window an overlapping lease reclaim opens.
    let ran = 0;
    const got = await step.run('contended', async () => {
      ran += 1;
      await adminDb.jobStep.create({
        data: {
          runId: run.id,
          stepId: 'contended',
          kind: 'run',
          result: { by: 'winner' },
          workspaceId: ws,
        },
      });
      return { by: 'loser' };
    });

    // The loser executed, collided on the unique key, and returned the WINNER's
    // value — returning its own would let the two callers carry on with different
    // data for the rest of the run.
    expect(ran).toBe(1);
    expect(got).toEqual({ by: 'winner' });
    expect(await adminDb.jobStep.count({ where: { runId: run.id, stepId: 'contended' } })).toBe(1);
  });

  it('step.run RETHROWS a non-unique database error rather than swallowing it', async () => {
    const ws = await makeWorkspace();
    // No such run, so the FK on `run_id` fails — a real error, not a lost race.
    const step = createStepApi({ runId: 'no-such-run', workspaceId: ws });
    await expect(step.run('anything', () => ({ ok: true }))).rejects.toThrow();
  });

  it('step.sleep REFUSES a corrupt checkpoint rather than treating it as elapsed', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: 'c', eventName: 'c', workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    // A sleep row with no deadline. Reading it as "elapsed" would silently skip a
    // wait the handler asked for — a supervisor polling a container that has not
    // moved.
    await adminDb.jobStep.create({
      data: { runId: run.id, stepId: 'nap', kind: 'sleep', workspaceId: ws },
    });
    const step = createStepApi({ runId: run.id, workspaceId: ws });
    await expect(step.sleep('nap', 1000)).rejects.toThrow(/no sleep_until/);
  });

  it('step.sleep RETURNS when it loses the checkpoint race to an ALREADY-ELAPSED deadline', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: 'c2', eventName: 'c', workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    const past = new Date(Date.now() - 60_000);
    await adminDb.jobStep.create({
      data: { runId: run.id, stepId: 'nap', kind: 'sleep', sleepUntil: past, workspaceId: ws },
    });
    const step = createStepApi({ runId: run.id, workspaceId: ws });
    // The winner's deadline governs, and it has already passed — so continue
    // rather than yield.
    await expect(step.sleep('nap', 30 * 60_000)).resolves.toBeUndefined();
  });

  it('step.sleep RETHROWS a non-unique database error', async () => {
    const step = createStepApi({ runId: 'no-such-run', workspaceId: null });
    await expect(step.sleep('nap', 1000)).rejects.toThrow();
  });
});

describe('the worker loop’s own branches', () => {
  it('start() runs the loop and the lease heartbeat, and shutdown() stops both', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const executed: string[] = [];
    const row = await adminDb.jobQueueRun.create({
      data: {
        jobId: `loop.${seq}`,
        eventName: 'loop',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });

    const w = new JobWorker({
      workerId: 'loop-worker',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      timings: { idleMinMs: 10, idleMaxMs: 20, renewMs: 15, leaseMs: 5_000 },
      execute: async (r) => {
        executed.push(r.id);
      },
    });

    w.start();
    // start() is idempotent — a second call must not open a second loop or a
    // second heartbeat.
    w.start();
    for (let i = 0; i < 300 && executed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await w.shutdown();

    expect(executed).toEqual([row.id]);
    expect((await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: row.id } })).state).toBe(
      'succeeded',
    );
  });

  it('a failing CLAIM is logged and backed off, never fatal', async () => {
    // A worker that dies on a transient database error takes the whole background
    // layer down until the platform restarts it. The loop must survive one.
    const errors: unknown[] = [];
    const w = new JobWorker({
      workerId: 'unlucky',
      logger: { info: () => {}, warn: () => {}, error: (...a: unknown[]) => errors.push(a) },
      timings: { idleMinMs: 10, idleMaxMs: 10 },
      execute: async () => {},
    });
    const broken = new Error('database went away');
    const original = jobQueueRepository.claimDueRuns;
    (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = () => Promise.reject(broken);
    try {
      w.start();
      for (let i = 0; i < 200 && errors.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = original;
      await w.shutdown();
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  // MOTIR-6734: shutdown() used to clear the heartbeat and release this worker's
  // claims WITHOUT waiting for the loop's current claim or a renewal already on
  // the wire, so a claim landing after the release held rows for a stopped worker.
  // Both tests hold that query open and pin the ORDER: the release comes after it.
  function heldOpen() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    return { gate, release, started, entered };
  }

  it("shutdown() waits for the loop's claim in flight before releasing claims", async () => {
    const order: string[] = [];
    const claim = heldOpen();
    const originalClaim = jobQueueRepository.claimDueRuns;
    const originalRelease = jobQueueRepository.releaseClaims;
    (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = async () => {
      claim.entered();
      await claim.gate;
      order.push('claim settled');
      return [];
    };
    (jobQueueRepository as { releaseClaims: unknown }).releaseClaims = async (
      ...args: Parameters<typeof originalRelease>
    ) => {
      order.push('released');
      return originalRelease.apply(jobQueueRepository, args);
    };
    const w = new JobWorker({
      workerId: 'claim-in-flight',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      timings: { idleMinMs: 10, idleMaxMs: 10, renewMs: 60_000 },
      execute: async () => {},
    });
    try {
      w.start();
      await claim.started;
      const stopped = w.shutdown().then(() => order.push('shutdown returned'));
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual([]);
      claim.release();
      await stopped;
    } finally {
      (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = originalClaim;
      (jobQueueRepository as { releaseClaims: unknown }).releaseClaims = originalRelease;
      claim.release();
    }
    expect(order).toEqual(['claim settled', 'released', 'shutdown returned']);
  });

  it('shutdown() waits for a lease renewal already on the wire', async () => {
    const order: string[] = [];
    const renewal = heldOpen();
    const originalClaim = jobQueueRepository.claimDueRuns;
    const originalRenew = jobQueueRepository.renewLeases;
    const originalRelease = jobQueueRepository.releaseClaims;
    (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = async () => [];
    (jobQueueRepository as { renewLeases: unknown }).renewLeases = async () => {
      renewal.entered();
      await renewal.gate;
      order.push('renewal settled');
      return 0;
    };
    (jobQueueRepository as { releaseClaims: unknown }).releaseClaims = async (
      ...args: Parameters<typeof originalRelease>
    ) => {
      order.push('released');
      return originalRelease.apply(jobQueueRepository, args);
    };
    const w = new JobWorker({
      workerId: 'renewal-in-flight',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      timings: { idleMinMs: 10, idleMaxMs: 10, renewMs: 10 },
      execute: async () => {},
    });
    try {
      w.start();
      await renewal.started;
      const stopped = w.shutdown().then(() => order.push('shutdown returned'));
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual([]);
      renewal.release();
      await stopped;
    } finally {
      (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = originalClaim;
      (jobQueueRepository as { renewLeases: unknown }).renewLeases = originalRenew;
      (jobQueueRepository as { releaseClaims: unknown }).releaseClaims = originalRelease;
      renewal.release();
    }
    expect(order).toEqual(['renewal settled', 'released', 'shutdown returned']);
  });

  async function until(cond: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('condition never held');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('a heartbeat tick that fires while a renewal is held open starts no second renewal', async () => {
    const renewal = heldOpen();
    let calls = 0;
    const originalClaim = jobQueueRepository.claimDueRuns;
    const originalRenew = jobQueueRepository.renewLeases;
    (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = async () => [];
    (jobQueueRepository as { renewLeases: unknown }).renewLeases = async () => {
      calls += 1;
      if (calls === 1) {
        renewal.entered();
        await renewal.gate;
      }
      return 0;
    };
    const w = new JobWorker({
      workerId: 'renewal-single-flight',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      timings: { idleMinMs: 10, idleMaxMs: 10, renewMs: 10 },
      execute: async () => {},
    });
    try {
      w.start();
      await renewal.started;
      // ~10 heartbeat ticks fire while the first renewal is held open.
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(1);
      // Once it settles, the heartbeat renews again — skipped, never stopped.
      renewal.release();
      await until(() => calls >= 2);
    } finally {
      renewal.release();
      await w.shutdown();
      (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = originalClaim;
      (jobQueueRepository as { renewLeases: unknown }).renewLeases = originalRenew;
    }
  });

  it('a failed renewal does not wedge the heartbeat — the next tick renews again', async () => {
    let calls = 0;
    const warned: string[] = [];
    const originalClaim = jobQueueRepository.claimDueRuns;
    const originalRenew = jobQueueRepository.renewLeases;
    (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = async () => [];
    (jobQueueRepository as { renewLeases: unknown }).renewLeases = async () => {
      calls += 1;
      if (calls === 1) throw new Error('database went away');
      return 0;
    };
    const w = new JobWorker({
      workerId: 'renewal-failed',
      logger: { info: () => {}, warn: (msg: string) => warned.push(msg), error: () => {} },
      timings: { idleMinMs: 10, idleMaxMs: 10, renewMs: 10 },
      execute: async () => {},
    });
    try {
      w.start();
      await until(() => calls >= 2);
    } finally {
      await w.shutdown();
      (jobQueueRepository as { claimDueRuns: unknown }).claimDueRuns = originalClaim;
      (jobQueueRepository as { renewLeases: unknown }).renewLeases = originalRenew;
    }
    expect(warned).toContain('[job-worker] lease renewal failed');
  });

  it('notify() on an idle worker is a no-op rather than a throw', async () => {
    const w = new JobWorker({
      workerId: 'idle',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      execute: async () => {},
    });
    // A hint, never a claim: safe before start, after shutdown, and while busy.
    expect(() => w.notify()).not.toThrow();
    await w.shutdown();
    expect(() => w.notify()).not.toThrow();
  });
});

describe('the defensive branches — the arms that only fire when something is wrong', () => {
  it('the dispatcher reports an ALREADY-ENQUEUED subscriber instead of failing the fan-out', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');

    // Pin the event id so the SECOND dispatch collides on (event_id, job_id) —
    // which is what a dispatcher retrying its own fan-out does.
    const fixed = await adminDb.jobEvent.create({
      data: { name: 'work-item/transitioned', data: { workspaceId: ws }, workspaceId: ws },
    });
    const realCreate = jobEventRepository.create;
    (jobEventRepository as { create: unknown }).create = async () => fixed;
    try {
      const first = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });
      expect(first.enqueued).toHaveLength(subs.length);
      expect(first.alreadyEnqueued).toEqual([]);

      const second = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });
      // Reported, not thrown and not counted as new work.
      expect(second.enqueued).toEqual([]);
      expect(second.alreadyEnqueued.sort()).toEqual(subs.map((s) => s.id).sort());
      expect(second.failed).toEqual([]);
    } finally {
      (jobEventRepository as { create: unknown }).create = realCreate;
    }
  });

  it('the dispatcher stringifies a NON-Error throw rather than losing it', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');
    const realCreate = jobQueueRepository.create;
    (jobQueueRepository as { create: unknown }).create = () => Promise.reject('a bare string');
    try {
      const r = await dispatchEventToEngine(
        'work-item/transitioned',
        { workspaceId: ws },
        { logger: { warn: () => {} } },
      );
      // A thrown string is rare and is exactly when a swallowed reason costs the
      // most, so it is coerced rather than dropped. Every subscriber fails the
      // same way — the set used to be narrowed to one by the cutover switch, and
      // MOTIR-3418 removed it.
      expect(r.failed.map((f) => f.error)).toEqual(subs.map(() => 'a bare string'));
      expect(r.failed.map((f) => f.jobId).sort()).toEqual(subs.map((s) => s.id).sort());
    } finally {
      (jobQueueRepository as { create: unknown }).create = realCreate;
    }
  });

  it('the dispatcher tolerates a NULL payload', async () => {
    // Every subscriber of the event is enqueued — the set used to be narrowed by
    // the cutover switch to exactly one, and MOTIR-3418 removed it, so the
    // assertion is over the registry's own answer rather than over a routed id.
    const subs = engineSubscribers('work-item/transitioned');
    const r = await dispatchEventToEngine('work-item/transitioned', null);
    expect(r.enqueued.slice().sort()).toEqual(subs.map((s) => s.id).sort());
    const ev = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: r.eventId! } });
    expect(ev.data).toEqual({});
    expect(ev.workspaceId).toBeNull();
  });

  it('the ledger SKIPS the success write when the run’s tenant vanished mid-flight', async () => {
    seq += 1;
    const id = `units.vanished.${seq}`;
    defineJob({ id: id as never }, () => ({ ok: true }));
    // No workspace row: `recordStart` returns null rather than crashing on the FK
    // (MOTIR-1545). There is then no ledger row to flip, and dereferencing its id
    // would be the crash the guard exists to avoid.
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: id, eventName: id, workspaceId: null, runAt: new Date(), maxAttempts: 1 },
    });
    const real = jobRunsService.recordStart;
    (jobRunsService as { recordStart: unknown }).recordStart = async () => null;
    try {
      await expect(executeWithLedger(run, {})).resolves.toEqual({ ok: true });
      expect(await adminDb.jobRun.count({ where: { functionId: id } })).toBe(0);
    } finally {
      (jobRunsService as { recordStart: unknown }).recordStart = real;
    }
  });

  it('a worker built with no options gets a generated id and the real console', () => {
    // The production construction — `scripts/worker.ts` passes neither.
    const w = new JobWorker({ execute: async () => {} });
    expect(w.workerId).toMatch(/^worker-[0-9a-f-]{36}$/);
    expect(w.inFlightCount).toBe(0);
  });

  it('a step.sleep that loses the race to a FUTURE deadline yields at the WINNER’s time', async () => {
    const ws = await makeWorkspace();
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: 's', eventName: 's', workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    const winnerDeadline = new Date(Date.now() + 90 * 60_000);
    const step = createStepApi({ runId: run.id, workspaceId: ws });
    const realCreate = jobStepRepository.create;
    // The winner's checkpoint lands during our insert.
    (jobStepRepository as { create: unknown }).create = async (...args: unknown[]) => {
      (jobStepRepository as { create: unknown }).create = realCreate;
      await adminDb.jobStep.create({
        data: {
          runId: run.id,
          stepId: 'nap',
          kind: 'sleep',
          sleepUntil: winnerDeadline,
          workspaceId: ws,
        },
      });
      return (realCreate as typeof jobStepRepository.create)(
        ...(args as Parameters<typeof jobStepRepository.create>),
      );
    };
    try {
      const err = await step.sleep('nap', 1_000).then(
        () => null,
        (e: unknown) => e,
      );
      // The WINNER's deadline governs — ours was one second, theirs is ninety
      // minutes, and honouring ours would cut a wait somebody asked for.
      expect(err).toBeInstanceOf(JobStepYield);
      expect((err as JobStepYield).resumeAt.getTime()).toBe(winnerDeadline.getTime());
    } finally {
      (jobStepRepository as { create: unknown }).create = realCreate;
    }
  });
});

describe('the last uncovered arms — failure serialization, reconnection, the heartbeat', () => {
  it('the ledger serializes a NON-Error throw and preserves an error CODE', async () => {
    seq += 1;
    const bare = `units.bare.${seq}`;
    const coded = `units.coded.${seq}`;
    const mkRun = (jobId: string) =>
      adminDb.jobQueueRun.create({
        data: { jobId, eventName: jobId, runAt: new Date(), maxAttempts: 1, attempts: 1 },
      });

    // A thrown STRING. Losing it would leave an operator a dead-lettered job with
    // "[object Object]" for a reason.
    await recordEngineTerminalFailure(await mkRun(bare), 'just a string', {});
    const bareRow = await adminDb.jobRunDlq.findFirstOrThrow({ where: { functionId: bare } });
    expect(bareRow.failure).toEqual({ message: 'just a string' });

    // An Error carrying a `code` — the shape a Prisma or a fetch failure has, and
    // the field a triager filters on.
    const err = Object.assign(new Error('constraint blew up'), { code: 'P2002' });
    await recordEngineTerminalFailure(await mkRun(coded), err, null);
    const codedRow = await adminDb.jobRunDlq.findFirstOrThrow({ where: { functionId: coded } });
    expect(codedRow.failure).toMatchObject({ message: 'constraint blew up', code: 'P2002' });
    // A null payload still stores as an object, not as SQL NULL — the column is
    // NOT NULL and a replay reads it.
    expect(codedRow.eventData).toEqual({});
  });

  it('the ledger stores a NULL handler result as a NULL output', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const id = `units.nullout.${seq}`;
    defineJob({ id: id as never }, () => null);
    const run = await adminDb.jobQueueRun.create({
      data: { jobId: id, eventName: id, workspaceId: ws, runAt: new Date(), maxAttempts: 1 },
    });
    await executeWithLedger(run, { workspaceId: ws });
    const row = await adminDb.jobRun.findFirstOrThrow({ where: { functionId: id } });
    expect(row.status).toBe('succeeded');
    expect(row.output).toBeNull();
  });

  it('the listener RECONNECTS after its connection is terminated server-side', async () => {
    // The reconnect path, driven by an actual disconnection rather than by
    // calling the handler: a listener that dies on a dropped socket would take
    // the worker's whole latency path with it, silently, until someone noticed
    // jobs starting a poll interval late.
    const warns: unknown[] = [];
    let woke = 0;
    const listener = await listenForQueuedJobs(
      () => {
        woke += 1;
      },
      {
        logger: { info: () => {}, warn: (...a: unknown[]) => warns.push(a) },
        reconnectMs: 50,
      },
    );
    try {
      expect(listener.connected).toBe(true);

      // Kill the listening backend from another session — a real disconnection.
      await adminDb.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
      );

      // It notices and reports the degrade…
      for (let i = 0; i < 300 && warns.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(warns.length).toBeGreaterThan(0);

      // …and comes back on its own.
      for (let i = 0; i < 400 && !listener.connected; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(listener.connected).toBe(true);

      // And it is genuinely listening again, not merely marked connected.
      await withSystemContext(async (tx) => {
        await notifyQueuedJob((sql) => tx.$executeRawUnsafe(sql));
      });
      for (let i = 0; i < 300 && woke === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(woke).toBeGreaterThan(0);
    } finally {
      await listener.stop();
    }
  }, 30_000);

  it('is not woken by another feature’s channel — because it never subscribed to one', async () => {
    let woke = 0;
    const listener = await listenForQueuedJobs(() => {
      woke += 1;
    });
    try {
      await adminDb.$executeRawUnsafe(`NOTIFY some_other_channel`);
      await new Promise((r) => setTimeout(r, 200));
      // The isolation comes from the SUBSCRIPTION, not from a filter in the
      // handler: this client issues exactly one `LISTEN`, so Postgres never
      // delivers another channel's payload to it at all. (An in-handler
      // `msg.channel === …` test was removed for exactly that reason — coverage
      // showed its false arm was unreachable.)
      expect(woke).toBe(0);
    } finally {
      await listener.stop();
    }
  });

  it('the lease HEARTBEAT actually fires and extends this worker’s claims', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    await adminDb.jobQueueRun.create({
      data: {
        jobId: `hb.${seq}`,
        eventName: 'hb',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });
    // Claim it out of band so a row is held while the heartbeat runs.
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('hb-worker', 1, 400, tx));
    const before = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { claimedBy: 'hb-worker' },
    });

    const w = new JobWorker({
      workerId: 'hb-worker',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // Nothing is claimable (the only row is already `running`), so the loop
      // idles and the heartbeat is what we are measuring.
      timings: { renewMs: 30, leaseMs: 60_000, idleMinMs: 5_000, idleMaxMs: 5_000 },
      execute: async () => {},
    });
    w.start();
    try {
      let after = before;
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 10));
        after = await adminDb.jobQueueRun.findFirstOrThrow({ where: { claimedBy: 'hb-worker' } });
        if (after.leaseExpiresAt!.getTime() > before.leaseExpiresAt!.getTime()) break;
      }
      // The heartbeat is the ONLY thing distinguishing a long run from a dead
      // worker, so "it is wired" has to be observed, not assumed.
      expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());
    } finally {
      await w.shutdown();
    }
  }, 20_000);

  it('serializeWorkerFailure keeps a stackless Error’s message', () => {
    const e = new Error('no stack here');
    delete (e as { stack?: string }).stack;
    expect(serializeWorkerFailure(e)).toEqual({ message: 'no stack here' });
  });
});

describe('closeQuietly — the swallow with a name on it', () => {
  it('closes a healthy client', async () => {
    let ended = 0;
    await closeQuietly({
      end: async () => {
        ended += 1;
      },
    });
    expect(ended).toBe(1);
  });

  it('SWALLOWS a rejecting end() — the state the reconnect path finds', async () => {
    // `end()` rejects on a client whose socket has already errored, which is
    // exactly when the reconnect discards it. Letting that propagate would turn a
    // recovered listener into a crashed worker.
    await expect(
      closeQuietly({ end: () => Promise.reject(new Error('socket already gone')) }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when there is no client', async () => {
    await expect(closeQuietly(undefined)).resolves.toBeUndefined();
  });
});

describe('the listener’s stop-during-reconnect race', () => {
  it('a stop() lands cleanly while a reconnect is in flight, and no further attempt is made', async () => {
    // The arm that only fires when a shutdown races the retry timer — a routine
    // event during a deploy, since SIGTERM arrives whenever it arrives. A
    // reconnect that fired after stop() would open a connection nobody closes.
    const warns: unknown[] = [];
    const listener = await listenForQueuedJobs(() => {}, {
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nothing',
      logger: { info: () => {}, warn: (...a: unknown[]) => warns.push(a) },
      // Fast enough that several attempts happen inside the window below.
      reconnectMs: 5,
    });

    // Let it fail and retry a few times, so a retry is genuinely pending when we
    // stop it.
    for (let i = 0; i < 100 && warns.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(warns.length).toBeGreaterThanOrEqual(3);

    await listener.stop();
    const attemptsAtStop = warns.length;

    // Nothing more is attempted after the stop — the guard held.
    await new Promise((r) => setTimeout(r, 120));
    expect(warns.length).toBe(attemptsAtStop);
    expect(listener.connected).toBe(false);
  }, 20_000);
});
