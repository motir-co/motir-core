import { Prisma, type JobQueueRun, type JobRunState } from '@/generated/prisma/client';

/**
 * What `enqueueScheduled` did — a DISCRIMINATED result rather than a nullable
 * row, because "another worker already queued this tick" is a normal outcome of
 * a healthy system and a caller must not have to tell it apart from a failure by
 * inspecting a null (MOTIR-3469).
 */
export type EnqueueScheduledResult =
  | { outcome: 'enqueued'; run: JobQueueRun }
  | { outcome: 'already-queued' };

/**
 * ONE CLAIM of one run — what a settle write is fenced on (MOTIR-10466,
 * MOTIR-10500). `claimToken` is the value `claimDueRuns` returned for this claim;
 * the worker id alone cannot tell two claims by the same worker apart.
 */
export interface JobQueueClaim {
  id: string;
  workerId: string;
  claimToken: number;
}

/** The row is still `claim`'s: running, under the same worker and the same fencing token. */
function heldBy(claim: JobQueueClaim): Prisma.JobQueueRunWhereInput {
  return {
    id: claim.id,
    state: 'running',
    claimedBy: claim.workerId,
    claimToken: claim.claimToken,
  };
}

/** True when a thrown value is Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

// Data access for `job_queue` — the RUN table the Postgres job engine's worker
// claims from (Story MOTIR-3414 · Subtask MOTIR-3421). Single-op methods only;
// writes require `tx` (the 4-layer contract). `lib/jobs/engine/worker.ts` owns
// the transactions and the loop.
//
// Writes use the UNCHECKED create input (scalar FK) for the reason
// `jobRunRepository.create` records: the runtime writes under the system-admin
// context with no workspace context bound, and a relation `connect` issues a
// SELECT the workspace table's RLS hides.

// ⚠️ EVERY CLOCK EXPRESSION IN THIS FILE IS `(now() AT TIME ZONE 'UTC')`, NEVER
// BARE `now()` — and this is a bug that was CAUGHT rather than avoided.
//
// Prisma maps `DateTime` to `timestamp(3)` WITHOUT time zone and writes it as
// naive UTC. `now()` is a `timestamptz`, so comparing it to such a column casts
// it through the SESSION TimeZone. On this sandbox `SHOW timezone` is
// `America/Los_Angeles`, so the first version of `claimDueRuns` — written with
// bare `now()` — matched NOTHING: a row due one minute ago read as seven hours in
// the future, and every worker test failed with an empty claim.
//
// ⚠️ AND IT WOULD HAVE SHIPPED GREEN. Production's Amazon RDS instance runs UTC
// (RDS's default `timezone`, which motir-infra's parameter group leaves alone), as
// Neon did before it, where the offset is zero and the two forms agree exactly.
// So does CI. The defect is visible only
// under a non-UTC session, which is precisely why it belongs in code rather than
// in an assumption about the deployment's timezone.
//
// The rule is `(now() AT TIME ZONE 'UTC')` on BOTH SIDES of every read and every
// write, not "bind a JS Date". Binding the writer's clock is right for a
// predicate evaluated inside one process, and WRONG here: `run_at` is written by
// the dispatcher and read by the worker, and `lease_expires_at` is written by the
// worker holding a run and read by a REAPER ON ANOTHER MACHINE. Bind a JS Date
// there and the lease becomes a function of the writer's clock, so machine skew
// surfaces as a live run reaped at random — indistinguishable from a real machine
// death. The database has to be the clock; `AT TIME ZONE 'UTC'` is what makes it
// speak the column's convention.
export const jobQueueRepository = {
  /**
   * ⚠️ THE CLAIM. The single most important query in the engine, and the reason
   * it is raw SQL rather than a Prisma call: `FOR UPDATE SKIP LOCKED` is not
   * expressible through the query builder, and `CLAUDE.md` lists `$queryRaw` as
   * a legal single repository op precisely for this.
   *
   * Claiming is a READ-DERIVED WRITE — read which rows are due, then write a
   * claim based on what was read. Two workers doing that with a plain
   * read-then-write both see the same row and both run the job. Three things
   * make it safe, and all three are load-bearing:
   *
   *   1. **`FOR UPDATE`** takes a row lock, so a second transaction cannot claim
   *      a row this one is claiming.
   *   2. **`SKIP LOCKED`** makes that second worker take the NEXT row instead of
   *      BLOCKING on the first. Without it the claim is correct and serial — N
   *      workers would queue behind one row and the pool would buy nothing.
   *   3. **The state write is in the SAME statement** (`UPDATE … FROM due …`,
   *      the CTE being the locking SELECT), so there is no window between
   *      locking a row and marking it claimed. A separate UPDATE would still be
   *      correct inside one transaction, but this way the claim cannot be split
   *      by an early return or a thrown error between the two.
   *   4. **`AS MATERIALIZED` is what makes the LIMIT a BOUND** (Bug MOTIR-3769),
   *      and it is load-bearing rather than stylistic. This was written as
   *      `UPDATE … FROM ( SELECT … LIMIT n ) AS due`, and **a `LIMIT` inside a
   *      `FROM`-subquery is a planner preference, not a guarantee**: PostgreSQL
   *      may plan the subquery as the INNER, RE-SCANNED side of a nested loop,
   *      and the limit then bounds each re-scan instead of the statement. Under
   *      the RUNTIME role (`motir_app`, `rolbypassrls = false` — the role
   *      production connects as) that is exactly the plan chosen, because the
   *      policy qual on `q` changes the cost model and the join order with it:
   *      three due rows and `limit = 1` claimed **three**. As the database owner
   *      the same statement claims one, which is why every existing test was
   *      green — none of them asserted the claim's CARDINALITY. `MATERIALIZED`
   *      (PostgreSQL 12+) forces exactly one evaluation, and says out loud what
   *      the statement always meant.
   *
   * The `ORDER BY run_at` is what makes the queue fair (oldest due first) and is
   * served by an index on `run_at` with no sort — the partial
   * `job_queue_pending_run_at_idx` under the runtime role (MOTIR-8519), asserted
   * by EXPLAINs in `tests/jobs/engine-schema.test.ts` and
   * `tests/jobs/job-queue-rls-index.test.ts`.
   *
   * ⚠️ A SERIAL TEST CANNOT SEE THE DEFECT THIS PREVENTS. Two sequential claims
   * never collide; the race needs genuine concurrency against a warm pool, which
   * is what `tests/jobs/engine-worker.test.ts` drives.
   *
   * ⚠️ THE CLAIM ALSO CLOSES THE DEBOUNCE WINDOW (MOTIR-3483) — it clears
   * `debounce_key` / `debounce_first_seen_at` in the same statement, and both
   * halves of why are load-bearing. A same-key event arriving while this run
   * EXECUTES must enqueue a NEW run rather than be folded into work that has
   * already started, or a push during an index is silently dropped. And a retry
   * puts this very row back to `pending` (`rescheduleAt`), where a surviving key
   * would collide with the row that push enqueued — a unique violation on the
   * retry path, which is the worst place to discover one.
   *
   * ⚠️ Neither column is in the `RETURNING` list, deliberately: nothing the
   * worker does reads them, exactly as it reads neither `scheduled_for` nor
   * `idempotency_key`. The row this hands back is the claim's view of a run, not
   * a faithful `SELECT *`.
   */
  async claimDueRuns(
    workerId: string,
    limit: number,
    leaseMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun[]> {
    return tx.$queryRaw<JobQueueRun[]>`
      WITH due AS MATERIALIZED (
              SELECT "id"
                FROM "job_queue"
               WHERE "state" = 'pending'
                 AND "run_at" <= (now() AT TIME ZONE 'UTC')
               ORDER BY "run_at"
                 FOR UPDATE SKIP LOCKED
               LIMIT ${limit}
           )
      UPDATE "job_queue" AS q
         SET "state"            = 'running',
             "claimed_by"       = ${workerId},
             "lease_expires_at" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}::double precision),
             "attempts"         = q."attempts" + 1,
             -- THE FENCING TOKEN (MOTIR-10500): a new value for every claim,
             -- never lowered by anything, so a settle can tell THIS claim from
             -- any later one -- including a later claim by the same worker.
             "claim_token"      = q."claim_token" + 1,
             -- THE CLAIM CLOSES THE DEBOUNCE WINDOW (MOTIR-3483) -- see the
             -- doc comment above this method. A pending row carries the
             -- coalescing key; a claimed one must not.
             "debounce_key"     = NULL,
             "debounce_first_seen_at" = NULL,
             "updated_at"       = (now() AT TIME ZONE 'UTC')
        FROM due
       WHERE q."id" = due."id"
      RETURNING q."id",
                q."job_id"           AS "jobId",
                q."event_id"         AS "eventId",
                q."event_name"       AS "eventName",
                q."workspace_id"     AS "workspaceId",
                q."run_at"           AS "runAt",
                q."attempts",
                q."max_attempts"     AS "maxAttempts",
                q."state",
                q."claimed_by"       AS "claimedBy",
                q."lease_expires_at" AS "leaseExpiresAt",
                q."claim_token"      AS "claimToken",
                q."last_error"       AS "lastError",
                q."created_at"       AS "createdAt",
                q."updated_at"       AS "updatedAt"
    `;
  },

  /**
   * THE DUE BACKLOG — how many runs are claimable right now, and how long the
   * oldest of them has been waiting (Subtask MOTIR-3764).
   *
   * ⚠️ THE POINT IS WHO CAN ASK. This is a direct read of `job_queue`, so it
   * answers whether anything is CLAIMING even when nothing is: the check that
   * would otherwise report a wedged worker is itself a job, and a job engine
   * cannot be the thing that reports its own death. Nothing here enqueues, and
   * nothing here depends on a run.
   *
   * `run_at <= now()` is what makes this a backlog rather than a schedule: a
   * retry backed off for five minutes and a cron fire due tomorrow are both
   * `pending` and neither is waiting on a worker. `AT TIME ZONE 'UTC'` on both
   * sides, per this file's header — the database is the clock.
   *
   * An EMPTY queue answers `{ depth: 0, oldestRunAt: null }`, which is a
   * measurement and not an absence: `min()` over no rows is `NULL`, and the
   * caller must render that as "nothing waiting" rather than as an unread probe.
   */
  async readDueBacklog(
    tx: Prisma.TransactionClient,
  ): Promise<{ depth: number; oldestRunAt: Date | null }> {
    const rows = await tx.$queryRaw<Array<{ depth: number; oldestRunAt: Date | null }>>`
      SELECT count(*)::int      AS "depth",
             min("run_at")      AS "oldestRunAt"
        FROM "job_queue"
       WHERE "state" = 'pending'
         AND "run_at" <= (now() AT TIME ZONE 'UTC')
    `;
    return rows[0] ?? { depth: 0, oldestRunAt: null };
  },

  /**
   * RECLAIM abandoned runs: `running` rows whose lease has expired, back to
   * `pending` so a live worker can take them.
   *
   * ⚠️ THE ATTEMPT IS GIVEN BACK. `claimDueRuns` increments `attempts` at the
   * claim, so a worker that DIED mid-run has already spent one. Not refunding it
   * would let a crash-loop (an OOM, a rolling deploy catching the same long run
   * twice) exhaust a job's whole retry budget without the handler ever having
   * failed — the run would dead-letter with no error to show an operator. A
   * genuine handler failure is counted on the failure path instead, where there
   * is something to record.
   */
  async reclaimExpiredLeases(tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.$executeRaw`
      UPDATE "job_queue"
         SET "state"            = 'pending',
             "claimed_by"       = NULL,
             "lease_expires_at" = NULL,
             "attempts"         = GREATEST("attempts" - 1, 0),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "lease_expires_at" IS NOT NULL
         AND "lease_expires_at" < (now() AT TIME ZONE 'UTC')
    `;
    return r;
  },

  /**
   * Extend the lease on runs this worker still holds — the RENEWAL half of the
   * lease. A run legitimately longer than one lease period (a supervisor, a big
   * index) must not be reclaimed out from under a worker that is alive and
   * working, and a heartbeat is the only way to tell that apart from a worker
   * that died.
   *
   * Scoped to `claimed_by = workerId` so a worker can only ever renew its own.
   */
  async renewLeases(
    workerId: string,
    leaseMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "job_queue"
         SET "lease_expires_at" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}::double precision),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "claimed_by" = ${workerId}
    `;
  },

  /**
   * RELEASE the runs this worker holds, back to `pending` — the graceful-shutdown
   * path. Same attempt refund as the reclaim above, for the same reason: a
   * deploy is a routine event and must not cost a job an attempt.
   *
   * `runAt` is left where it is, so a released run is immediately claimable by
   * whichever machine is still up. That is the difference between draining and
   * dropping.
   */
  async releaseClaims(workerId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      UPDATE "job_queue"
         SET "state"            = 'pending',
             "claimed_by"       = NULL,
             "lease_expires_at" = NULL,
             "attempts"         = GREATEST("attempts" - 1, 0),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "claimed_by" = ${workerId}
    `;
  },

  /**
   * Whether `claim` is still the run's live claim — `running`, claimed by its
   * worker, under its fencing token (MOTIR-10500). The
   * worker asks before its terminal-failure hook writes a dead-letter record, so a
   * run whose claim was released mid-execution is not dead-lettered by a worker
   * that no longer holds it (MOTIR-10466). A pre-check only: the release can land
   * between this read and the write, which is why the write itself is fenced too.
   */
  async isHeldBy(claim: JobQueueClaim, tx: Prisma.TransactionClient): Promise<boolean> {
    const n = await tx.jobQueueRun.count({ where: heldBy(claim) });
    return n > 0;
  },

  /**
   * ⚠️ THE THREE SETTLE WRITES BELOW ARE FENCED ON THE CLAIM (MOTIR-10466). Each
   * one writes only while the row is still `running` AND `claimed_by` is the
   * worker settling it — the scope `renewLeases` and `releaseClaims` above have
   * always had — and answers whether it wrote.
   *
   * A settle can outlive its claim: a drain that times out releases a run that is
   * still executing (`JobWorker.shutdown()`), and a worker that misses its
   * heartbeats has its lease reclaimed. Keyed on the id alone, the late settle
   * wrote over a row it no longer held — another worker's `running` row read
   * `succeeded` with no claimant while it was still executing, and a late
   * reschedule handed it to a third. `false` means exactly that: the row is not
   * this worker's any more, and what is in it belongs to whoever holds it, or to
   * its next claimant. `docs/decisions/job-queue-foundation.md` §18.7 is the
   * decision.
   *
   * ⚠️ AND ON THE CLAIM'S FENCING TOKEN, NOT ONLY ITS WORKER (MOTIR-10500). A live
   * worker that misses its heartbeats has its lease reclaimed by its OWN next
   * tick, which can then claim the very run it is still executing: both passes
   * carry the same `claimed_by`, and only the token — bumped by every claim —
   * tells the stale pass from the one that replaced it. §18.8.
   */
  async markSucceeded(claim: JobQueueClaim, tx: Prisma.TransactionClient): Promise<boolean> {
    const r = await tx.jobQueueRun.updateMany({
      where: heldBy(claim),
      data: { state: 'succeeded', claimedBy: null, leaseExpiresAt: null },
    });
    return r.count > 0;
  },

  /**
   * Terminal failure — the retry budget is spent. `lastError` carries the final
   * failure so an operator sees WHY without reading a log, mirroring
   * `job_run.failure`. Fenced on the claim, like {@link markSucceeded}.
   */
  async markFailed(
    claim: JobQueueClaim,
    lastError: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const r = await tx.jobQueueRun.updateMany({
      where: heldBy(claim),
      data: { state: 'failed', claimedBy: null, leaseExpiresAt: null, lastError },
    });
    return r.count > 0;
  },

  /**
   * Re-enqueue for another attempt (a retry's backoff) or for a resume (a
   * `step.sleep` yield). One method for both because the row change is
   * identical — back to `pending` at a future `run_at` — and the DIFFERENCE is
   * whether `attempts` was spent, which the caller has already decided. Fenced on
   * the claim, like {@link markSucceeded}.
   */
  async rescheduleAt(
    claim: JobQueueClaim,
    runAt: Date,
    tx: Prisma.TransactionClient,
    opts?: { refundAttempt?: boolean; lastError?: Prisma.InputJsonValue },
  ): Promise<boolean> {
    const r = await tx.jobQueueRun.updateMany({
      where: heldBy(claim),
      data: {
        state: 'pending',
        runAt,
        claimedBy: null,
        leaseExpiresAt: null,
        ...(opts?.refundAttempt ? { attempts: { decrement: 1 } } : {}),
        ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      },
    });
    return r.count > 0;
  },

  /** Insert one run. The dispatcher's write (MOTIR-3423) and the tests' seed. */
  async create(
    data: Prisma.JobQueueRunUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun> {
    return tx.jobQueueRun.create({ data });
  },

  /**
   * ⚠️ INSERT ONE RUN, OR REPORT THAT ONE ALREADY EXISTS — WITHOUT RAISING
   * (MOTIR-3730). The same "a duplicate enqueue is not an error" reading
   * `dispatchEventToEngine` and {@link enqueueScheduled} already apply to their
   * own constraints, in the ONE form that is usable inside a transaction the
   * CALLER owns and goes on using.
   *
   * `createManyAndReturn` + `skipDuplicates` is Prisma's `INSERT … ON CONFLICT
   * DO NOTHING`: the violation is absorbed by Postgres and no error is ever
   * thrown, so the enclosing transaction stays healthy. The row comes back when
   * this call created it, and `null` when the unique already held.
   *
   * ⚠️ THE `try/catch` FORM CANNOT BE USED HERE, AND ITS FAILURE IS SILENT.
   * A raised `P2002` aborts the whole enclosing Postgres transaction: every
   * later statement answers `25P02 current transaction is aborted`, and a
   * `COMMIT` on an aborted transaction rolls back and reports success. The two
   * callers that DO catch it are safe only because each wraps its insert in its
   * own one-statement `withSystemContext` transaction — a property of their call
   * sites, not of the pattern. `workItemLinkRepository.createIfAbsent` records
   * the same reasoning for the same reason.
   *
   * DO NOTHING rather than an upsert: the existing row is a real pending or
   * running job, and this call has nothing better to say about it.
   *
   * ⚠️ NO CONFLICT TARGET, deliberately — `ON CONFLICT DO NOTHING` with no
   * target covers EVERY constraint on the table, which is what a caller means by
   * "already enqueued": `(event_id, job_id)`, `(job_id, scheduled_for)` and the
   * PARTIAL unique `(job_id, idempotency_key)` alike. The partial one could not
   * be named as a target through Prisma anyway — it is not in the datamodel
   * (`@@unique` takes no `WHERE`; see the index's own migration).
   */
  async createIfAbsent(
    data: Prisma.JobQueueRunCreateManyInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun | null> {
    const rows = await tx.jobQueueRun.createManyAndReturn({ data: [data], skipDuplicates: true });
    return rows[0] ?? null;
  },

  /**
   * ⚠️ THE DEBOUNCE CANDIDATE, LOCKED (MOTIR-3483) — the PENDING, unclaimed run
   * this event should coalesce into, or null when there is none.
   *
   * Raw SQL for the same reason `claimDueRuns` is: `FOR UPDATE` is not
   * expressible through the query builder, and CLAUDE.md lists `$queryRaw` as a
   * legal single repository op precisely for this. Coalescing is a READ-DERIVED
   * WRITE — read which pending row holds this key, then move its `run_at` based
   * on what was read — so the row is locked before it is read, inside the
   * caller's transaction, per the lock-before-a-contended-update contract.
   *
   * ⚠️ PLAIN `FOR UPDATE`, NOT `SKIP LOCKED`, and the difference is the point.
   * `claimDueRuns` skips a locked row because ANOTHER row will do; here there is
   * exactly one row that will do, and skipping it would insert a second pending
   * run for the same key — which is the outcome this whole mechanism exists to
   * prevent. Blocking briefly on a concurrent same-key dispatch is correct.
   *
   * It composes with the claim rather than fighting it: a worker claiming this
   * row concurrently uses `SKIP LOCKED`, so it steps over a row we hold; and if
   * the worker got there first the row is no longer `pending`, so this returns
   * null and the caller enqueues a fresh run — which is the contracted behaviour
   * for a push arriving mid-run.
   *
   * ⚠️ AND IT CANNOT COVER THE EMPTY CASE. Two concurrent FIRST arrivals for one
   * key both lock nothing and both insert; the partial unique index
   * `job_queue_job_debounce_key` is what makes that a recoverable `P2002`. A lock
   * is a lock on a row, and there is no row yet.
   */
  async findPendingDebouncedForUpdate(
    jobId: string,
    debounceKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; runAt: Date; debounceFirstSeenAt: Date | null } | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; runAt: Date; debounceFirstSeenAt: Date | null }>
    >`
      SELECT "id",
             "run_at" AS "runAt",
             "debounce_first_seen_at" AS "debounceFirstSeenAt"
        FROM "job_queue"
       WHERE "job_id"       = ${jobId}
         AND "debounce_key" = ${debounceKey}
         AND "state"        = 'pending'
         AND "claimed_by" IS NULL
       LIMIT 1
         FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * COALESCE a new arrival into the pending run this key already holds
   * (MOTIR-3483): push `run_at` forward and REPOINT the row at the newer event.
   *
   * The repoint is what makes the coalesced run carry the LATEST push rather than
   * the first — the semantics `docs/decisions/job-queue-foundation.md` §9 names,
   * and the reason the event payload lives in its own table rather than on the
   * run. `debounce_first_seen_at` is deliberately NOT touched: the deferral cap
   * is measured from the first arrival, so moving it would make a steady stream
   * able to defer forever, which is the Inngest limit MOTIR-2994 measured and
   * this implementation declines to reproduce.
   *
   * Must be called with the row already locked by
   * {@link findPendingDebouncedForUpdate}, inside the same transaction.
   */
  async coalesceDebounced(
    id: string,
    data: { runAt: Date; eventId: string; eventName: string; workspaceId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun> {
    return tx.jobQueueRun.update({
      where: { id },
      data: {
        runAt: data.runAt,
        eventId: data.eventId,
        eventName: data.eventName,
        workspaceId: data.workspaceId,
      },
    });
  },

  /**
   * ⚠️ ENQUEUE ONE SCHEDULED TICK, IDEMPOTENTLY PER `(jobId, scheduledFor)`
   * (MOTIR-3469). The scheduler's write; its first caller is MOTIR-3471.
   *
   * INSERT-IF-ABSENT, and the "if absent" is the `@@unique([jobId,
   * scheduledFor])` constraint — NOT a preceding read. A check-then-insert here
   * would be a read-derived write with a race in the middle, which is precisely
   * the shape `claimDueRuns` above exists to avoid and precisely the shape two
   * workers ticking the same minute would defeat. So a `P2002` is an EXPECTED
   * outcome and is reported as `already-queued`, exactly as
   * `dispatchEventToEngine` reads its own constraint's violation and for the same
   * reason.
   *
   * ⚠️ THE CLOCK RULE IS NOT VIOLATED BY BINDING THESE TWO DATES, AND HERE IS WHY
   * — the file header's warning is about a value one process writes and another
   * process compares AGAINST A CLOCK, which is why `lease_expires_at` must never
   * be bound in JS. Neither date here is that:
   *
   *   * `scheduledFor` is a cron FIRE INSTANT — a minute boundary derived from the
   *     expression by `previousFireAtOrBefore`, not a reading of any clock. Two
   *     workers whose clocks differ still compute the SAME instant for the same
   *     fire, so the unique dedups them; skew changes WHEN a worker notices a
   *     fire, never WHICH instant it names. It is compared only for equality,
   *     inside the index.
   *   * `runAt` is bound in JS for the same reason `rescheduleAt` and
   *     `dispatchEventToEngine` already bind theirs: Prisma writes a `DateTime`
   *     as naive UTC into `timestamp(3)`, and the only thing that ever compares
   *     it to a clock is `claimDueRuns`, which does so DATABASE-side against
   *     `(now() AT TIME ZONE 'UTC')` — the same convention, so the two agree.
   *
   * This method therefore adds no clock expression of its own, deliberately.
   */
  async enqueueScheduled(
    data: {
      jobId: string;
      scheduledFor: Date;
      eventName: string;
      runAt: Date;
      maxAttempts: number;
    },
    tx: Prisma.TransactionClient,
  ): Promise<EnqueueScheduledResult> {
    try {
      const run = await tx.jobQueueRun.create({
        data: {
          jobId: data.jobId,
          scheduledFor: data.scheduledFor,
          eventName: data.eventName,
          runAt: data.runAt,
          maxAttempts: data.maxAttempts,
          // A scheduled run has no triggering event and belongs to no tenant.
          // Both are stated rather than defaulted: `event_id` NULL is what keeps
          // the `(event_id, job_id)` unique off this row, and `workspace_id` NULL
          // is what makes it a `system.*` row under the table's RLS policy.
          eventId: null,
          workspaceId: null,
        },
      });
      return { outcome: 'enqueued', run };
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'already-queued' };
      throw err;
    }
  },

  /** Read one run by id. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobQueueRun | null> {
    return tx.jobQueueRun.findUnique({ where: { id } });
  },

  /** The ONE run a given job holds for a given event, or null when none was
   *  enqueued (Story MOTIR-4931 · MOTIR-5709). */
  async findForEventAndJob(
    eventId: string,
    jobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun | null> {
    return tx.jobQueueRun.findFirst({ where: { eventId, jobId }, orderBy: { runAt: 'desc' } });
  },

  /**
   * The NEWEST fire instant already enqueued for one job, or null when none has
   * been (MOTIR-3471). The watermark an `all` catch-up walks back to.
   *
   * It reads the QUEUE rather than the ledger deliberately: the question is "which
   * ticks have I already written a row for", not "which ticks ran". A row that was
   * enqueued and then failed has still been scheduled, and re-enqueuing it would
   * be a retry wearing a schedule's clothes.
   *
   * Served by the `(job_id, scheduled_for)` unique index, which orders on exactly
   * these two columns — so this is an index scan to one row, not a table walk.
   */
  async latestScheduledFor(jobId: string, tx: Prisma.TransactionClient): Promise<Date | null> {
    const row = await tx.jobQueueRun.findFirst({
      where: { jobId, scheduledFor: { not: null } },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true },
    });
    return row?.scheduledFor ?? null;
  },

  /** Count runs in a state — an operator/read surface and the tests' assertion handle. */
  /**
   * IS THERE STILL A LIVE QUEUE ROW BEHIND THIS LEDGER ROW? (Bug MOTIR-3683)
   *
   * The abandoned-run reap's liveness test. A ledger row and a queue row are
   * joined by what `ledgerIdentity` derives: `event_id` when the run carries one,
   * the queue row's own `id` when it does not (a cron fire). So one `eventRef`
   * has to be matched against BOTH columns — that is the same disjunction the
   * identity function is, read backwards.
   *
   * `pending` and `running` are the live states: a run sleeping at a `step.sleep`
   * or waiting out a retry backoff is `pending` with a future `run_at`, and its
   * ledger row is legitimately still `running`. Reaping that would close a run
   * that is about to resume.
   *
   * Returns 0 for every INNGEST-lane row — those never had a queue row — which is
   * correct rather than a gap: for that lane elapsed time is the only signal that
   * exists, which is exactly why the reap's threshold is generous.
   */
  async countLiveForEventRef(
    jobId: string,
    eventRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.jobQueueRun.count({
      where: {
        jobId,
        state: { in: ['pending', 'running'] },
        OR: [{ eventId: eventRef }, { id: eventRef }],
      },
    });
  },

  async countByState(state: JobRunState, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobQueueRun.count({ where: { state } });
  },

  /**
   * The SUCCEEDED rows past the retention cutoff that the queue retention pass
   * may delete, oldest first, at most `limit` (Story MOTIR-8540).
   *
   * Age is `created_at`: the unique keys a row holds were written when it was
   * created, so the dedup horizon runs from then. A run created before the cutoff
   * that only just succeeded is deletable, and that is accepted. `cutoff` is bound
   * by the caller and compared only with `created_at`, which Prisma writes as
   * naive UTC, so no database clock is read here.
   *
   * ⚠️ THE KEEP-RULE: the newest `scheduled_for` row of each job survives whatever
   * its age, because `latestScheduledFor` reads it as the scheduler's catch-up
   * watermark. "Newest" is measured over rows of ANY state, exactly as that reader
   * measures it. `docs/decisions/job-queue-retention-readers.md` lists every
   * reader this protects.
   *
   * ⚠️ WHY A PER-JOB `max()` AND NOT THE `NOT EXISTS` IT IS EQUIVALENT TO. "No
   * row of the job has a later `scheduled_for`" is exactly "`scheduled_for` is
   * at least the job's `max(scheduled_for)`". Written as a correlated `NOT EXISTS
   * (… n.scheduled_for > q.scheduled_for)`, the RLS barrier on `job_queue` makes
   * the planner probe it with a bitmap scan that fetches EVERY newer row of the
   * job for EVERY candidate, before the `LIMIT` applies: 6.8 s per batch on a
   * 100k-row table as the runtime role, growing with the backlog. The `max()` is
   * computed once per pass statement and measured 122 ms on the same table.
   *
   * No row lock, and never a `pending` or `running` row, so it cannot contend with
   * `claimDueRuns`' `FOR UPDATE SKIP LOCKED`.
   */
  async findPurgeableSucceededIds(
    cutoff: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT q."id" FROM "job_queue" q
      LEFT JOIN (
        SELECT n."job_id", max(n."scheduled_for") AS "latest"
        FROM "job_queue" n
        GROUP BY n."job_id"
      ) l ON l."job_id" = q."job_id"
      WHERE q."state" = 'succeeded'
        AND q."created_at" < ${cutoff}
        AND NOT (q."scheduled_for" IS NOT NULL AND q."scheduled_for" >= l."latest")
      ORDER BY q."created_at" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },

  /**
   * Delete the given runs — GUARDED ON THEM STILL BEING `succeeded`, so a caller
   * bug cannot delete a live or failed row. The ONLY delete `job_queue` has.
   */
  async deleteSucceededByIds(ids: string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await tx.jobQueueRun.deleteMany({
      where: { id: { in: ids }, state: 'succeeded' },
    });
    return res.count;
  },
};
