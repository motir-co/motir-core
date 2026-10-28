// E2E: a SCHEDULED job fires on the Postgres engine, lands in the job ledger,
// and honours its declared catch-up policy across a worker restart
// (Story MOTIR-3416 · Subtask MOTIR-3473 — the story's `verification_recipe`,
// automated).
//
// ⚠️ THE PACING PROBLEM, NAMED RATHER THAN DISCOVERED. Every one of the fourteen
// shipped cadences is too slow for a spec — the fastest is once a minute — and
// the story's own criterion is that no schedule constant moves, so re-timing a
// production job to make the test convenient is out.
//
// The card offered two honest routes: register a test-only cron job on a fast
// expression, or drive one of the fourteen with the scheduler's injected clock
// advanced. **THIS SPEC TAKES NEITHER, AND THE THIRD ROUTE IS BETTER THAN BOTH.**
// A test-only job would have to live in `lib/jobs/registry.ts` — shipped
// production code carrying a fixture — and an injected clock is unreachable from
// here, because the worker is a separate PROCESS started from a bundle.
//
// What this spec does instead is note that **a scheduled job's most recent fire
// is ALREADY IN THE PAST**, always. Routing `system.attachment-gc` (`30 3 * * *`)
// onto the engine at 14:07 means its 03:30 fire is one nothing was scheduling —
// which is precisely the downtime case the story is about — and a `latest`
// disposition owes it immediately. No cadence is waited out, no constant moves,
// and the job that runs is a REAL one on its REAL schedule.
//
// ⚠️ THE `skip` HALF USED TO LIVE HERE AND NO LONGER DOES (MOTIR-3314). It needed
// its own worker — `skip` suppresses a fire from before the SCHEDULER started,
// and the lane's shared worker starts in `globalSetup`, so through it `skip` and
// `latest` are indistinguishable however long a spec waits — and it needed a
// per-minute job, so that a fire would also arrive ON its watch inside the spec's
// patience. Clustering the crons ended the second requirement for every
// production job, and moved the one `skip` job to `latest` besides. The full
// argument, and where that coverage lives now
// (`tests/jobs/engine-scheduler.test.ts`, over synthetic definitions with an
// injected clock), is at the removal site below.
//
// What survives here is the half this lane is uniquely good for: a REAL job, on
// its REAL schedule, fired by the REAL worker process, landing in the REAL
// ledger.
//
// ⚠️ NO BROWSER (Story MOTIR-9982 · MOTIR-10042). The spec used to sign up a
// platform-staff user and read the run off the tenant dashboard's System tab.
// That tab is retired — the ledger is staff-only at `/admin/jobs`, covered by
// its own specs — so nothing here opens a page: the scheduler and the worker are
// processes, and their rows are the claim.

import { expect, test } from '@playwright/test';
import { adminDb, resetDatabase, truncateJobTables } from './_helpers/db-reset';

// Every direct-DB call is `adminDb`, the owner client — post-condition
// assertions and a TRUNCATE, and `tests/rls/test-singleton-statement-guard.test.ts`
// ratchets singleton statements under `tests/e2e/**` downward.

/**
 * The `latest` pilot: a REAL job, on its REAL daily schedule, whose handler is a
 * harmless cursor-bounded sweep that returns `{ scanned, deleted, failed }` over
 * an empty table. Its most recent fire is by construction hours old.
 */
const CATCH_UP_JOB = 'system.attachment-gc';
test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test.afterEach(async () => {
  // Clear the lane's shared routing — a spec that leaves a job routed hands the
  // next one a server behaving differently from the one it was written against.
  // (The spec-private WORKER teardown that stood here went with the `skip`
  // scenario below; nothing in this file starts one any more.)
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── scenarios ──────────────────────────────────────────────────────────────

test('@smoke a SCHEDULED job fires on the engine and its run lands in the ledger', async () => {
  test.setTimeout(120_000);

  // The daily sweep runs on the engine because the engine is the only lane there
  // is — MOTIR-3418 retired Inngest, and `lib/jobs/engine/ledger.ts` writes
  // `lane: 'engine'` unconditionally. (This comment used to describe a mid-spec
  // `routeJobsToEngine(CATCH_UP_JOB)` call routing the job through a file
  // override; that helper went with the switch it drove and the comment
  // outlived it. Corrected under Bug MOTIR-3738, whose own root-cause analysis
  // was written from it.) Its 03:30 fire has already passed with nothing
  // scheduling it, so a `latest` disposition owes exactly that fire, now.

  // ── the tick enqueued the MISSED fire ────────────────────────────────────
  // The authoritative signal is the committed row, never a sleep.
  await expect
    .poll(async () => adminDb.jobQueueRun.count({ where: { jobId: CATCH_UP_JOB } }), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(1);

  const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: CATCH_UP_JOB } });
  // A scheduled run: no triggering event, no tenant, and a fire instant that is
  // a real 03:30 UTC boundary in the PAST — the tick did not invent "now".
  expect(queued.eventId).toBeNull();
  expect(queued.workspaceId).toBeNull();
  expect(queued.eventName).toBe(`scheduled.${CATCH_UP_JOB}`);
  expect(queued.scheduledFor).not.toBeNull();
  expect(queued.scheduledFor!.getTime()).toBeLessThan(Date.now());
  expect(queued.scheduledFor!.getUTCHours()).toBe(3);
  expect(queued.scheduledFor!.getUTCMinutes()).toBe(30);

  // ── the worker claimed it and the handler ran ────────────────────────────
  // Polled BY ID — the row asserted just above — rather than by `jobId` again
  // (Bug MOTIR-3738). Re-selecting by the job id lets some other run for the
  // same job answer for this one, which is the defect the ledger read below
  // carries in full.
  await expect
    .poll(
      async () =>
        (await adminDb.jobQueueRun.findUnique({ where: { id: queued.id } }))?.state ?? 'missing',
      { timeout: 60_000, intervals: [500] },
    )
    .toBe('succeeded');

  // ── the LEDGER carries the scheduled provenance three consumers read ─────
  // ⚠️ NAME THE ROW — DO NOT TAKE THE FIRST ONE (Bug MOTIR-3738). The two reads
  // above are single-valued by CONSTRAINT: `job_queue` carries
  // `@@unique([jobId, scheduledFor])` and `@@unique([eventId, jobId])`, so one
  // fire of one job is one row. **`job_run` carries no uniqueness whatsoever** —
  // every index on it is non-unique — so `findFirst({ where: { functionId } })`
  // is a pick from a set whose size nothing guarantees. It fails against a
  // correct product, and it would equally PASS against a broken one whenever
  // some other row happened to read `succeeded`.
  //
  // And polling it would NOT fix it. `JobWorker.settle` awaits `execute()` —
  // which awaits the `job-run:succeeded` step — BEFORE `markSucceeded` flips the
  // queue row, so a queue row reading `succeeded` proves THIS run's ledger row
  // already committed `succeeded`. A `running` row read here is therefore a
  // DIFFERENT row, and a different row never moves.
  //
  // The determinate key is the one the writer used: `ledgerIdentity()`
  // (`lib/jobs/engine/ledger.ts`) records `eventId: run.eventId || run.id` and
  // the lane it wrote. A scheduled run has no triggering event — asserted above —
  // so the ledger row's `event_id` is the QUEUE ROW's id.
  const ledgerEventId = queued.eventId || queued.id;
  const ledgerRows = await adminDb.jobRun.findMany({
    where: { functionId: CATCH_UP_JOB },
    orderBy: { startedAt: 'desc' },
  });
  const forThisRun = ledgerRows.filter(
    (row) => row.lane === 'engine' && row.eventId === ledgerEventId,
  );
  // A second row for this function is NAMED here rather than silently picked:
  // the message enumerates every row the table held, so the next reader sees
  // which run answered instead of a bare `"running" !== "succeeded"`.
  expect(
    forThisRun,
    `expected exactly ONE engine-lane job_run row for queue run ${queued.id}; job_run held ` +
      JSON.stringify(
        ledgerRows.map((row) => ({
          id: row.id,
          lane: row.lane,
          eventId: row.eventId,
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
        })),
      ),
  ).toHaveLength(1);
  const ledger = forThisRun[0]!;
  expect(ledger.eventName).toBe(`scheduled.${CATCH_UP_JOB}`);
  expect(ledger.status).toBe('succeeded');

  // ⚠️ THE RECIPE'S "OPEN THE PAGE AND SEE IT" STEP STOOD HERE (MOTIR-3473),
  // and its page is retired (Story MOTIR-9982 · MOTIR-10042): it read this run
  // off the tenant dashboard's System tab, which is staff-only at `/admin/jobs`
  // now and covered by that surface's own specs. The ledger row asserted above
  // is the run an operator sees there.
});

// ⚠️ THE `skip` SCENARIO WAS REMOVED HERE (MOTIR-3314), AND ITS COVERAGE MOVED
// RATHER THAN VANISHED. It routed `system.ci-runner-provision-sweep` — then the
// only `skip` job, and the only one on `* * * * *` — onto a private worker and
// asserted that a fire from before the restart was not enqueued, with a control
// waiting out one real minute boundary to prove the scheduler was alive at all.
//
// Clustering the crons ended BOTH of its premises, and neither by accident:
//
//   * no job is per-minute any more, so the control — "a fire that happens ON
//     this scheduler's watch MUST be enqueued", polled for 90 s — cannot be
//     satisfied by any production schedule; the nearest fire is up to 30 minutes
//     out. That break comes from the CADENCE alone and would have happened
//     whatever the disposition;
//   * and `skip`'s rationale ("the next fire is at most 60 seconds away") went
//     with it, so that job is `latest` and no job declares `skip` at all.
//
// The header above rejected a test-only job as "shipped production code carrying
// a fixture", and that judgement still holds — so this lane cannot express the
// `skip` half any more. It does not need to: `tests/jobs/engine-scheduler.test.ts`
// covers both directions over SYNTHETIC definitions with an injected clock —
// "`skip` enqueues NOTHING for a fire from before the scheduler started" AND its
// control, "`skip` DOES enqueue a fire that happens while the scheduler is
// watching". That is the better tier for a SCHEDULER CAPABILITY, because it does
// not depend on which dispositions the product happens to use this month; what
// this lane uniquely proved was the real worker PROCESS, and the `latest`
// scenario above still proves that.

// ⚠️ A SCENARIO STOOD HERE AND ITS SUBJECT IS GONE (MOTIR-3418).
//
// "a scheduled job NOT routed to the engine produces no engine rows at all": with
// the routing cleared it waited out one full scheduler tick (8 s, chosen against
// the worker's own `IDLE_MAX_MS` of 5 s) and asserted `scheduled_for` was null on
// every queue row and the System tab read "No job runs yet". It was the guard
// protecting every cron the production cutover had not moved, and the reason the
// switch defaulted to the old lane.
//
// A registered cron is scheduled now, full stop — there is nothing for it to be
// left alone in favour of. The positive scenarios above still prove the real
// worker PROCESS turns a cron expression into a run, which is what this lane
// uniquely contributed; the scheduler's own dispositions are covered over
// synthetic definitions with an injected clock in
// `tests/jobs/engine-scheduler.test.ts`, which is the better tier for them.
