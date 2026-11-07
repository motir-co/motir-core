import { randomUUID } from 'node:crypto';
import type { JobQueueRun, Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository, type JobQueueClaim } from '@/lib/repositories/jobQueueRepository';
import { isWaitWithdrawn, runObservingWaits } from '@/lib/async/waitScope';
import { isJobStepYield } from './step';
import { isJobRunDefer } from './defer';

// The WORKER (Story MOTIR-3414 · Subtask MOTIR-3421) — the process that claims
// due runs, executes them, records the outcome, and repeats.
//
// ===========================================================================
// Where it runs
// ===========================================================================
// Its OWN Fly process group, declared in `fly.toml` beside `app` — not inside
// the web process, so job load and request serving cannot contend for one event
// loop and the two scale independently. Declaring the group is this card's
// deliverable; bringing a machine up in it is `fly scale count`, an operator
// action owned by MOTIR-3425 (`fly.toml` CONFIGURES, it does not PROVISION —
// the same distinction the file's own header draws, and the one that cost
// motir-ai three days of an incident filed against the wrong service).
//
// ===========================================================================
// The claim
// ===========================================================================
// `jobQueueRepository.claimDueRuns` — `FOR UPDATE SKIP LOCKED`, with the state
// write in the same statement. Its header carries the full argument. What
// belongs HERE is what the loop does around it:
//
// ⚠️ SIDE EFFECTS RUN OUTSIDE THE CLAIMING TRANSACTION. The transaction holds
// the claim write and nothing else; the handler runs after it commits. A handler
// inside the claim would hold a row lock (and a pooled connection) for the whole
// job — minutes, for a supervisor — and Prisma cannot nest interactive
// transactions, so every service the handler calls would fail besides.
//
// ===========================================================================
// What the claim RATE is governed by (MOTIR-3762)
// ===========================================================================
// FREE CAPACITY, and not by the slowest run in flight. `tick()` used to end
// `await Promise.all(claimed.map((run) => this.settle(run)))`, so the loop could
// not claim again until the LAST of its batch settled. On 2026-08-28 that held
// four unrelated claims for thirty-five minutes behind one
// `system.code-graph-refresh`, with 139 rows pending and nothing claiming them.
// `docs/decisions/job-queue-foundation.md` §15.1 is that measurement and §15.3
// is the decision. So:
//
//   * each claimed run SETTLES INDEPENDENTLY — `tick()` returns at the claim,
//     not at the settle, and one long run cannot detain its batch-mates;
//   * in-flight work is bounded by POOL_SIZE, a number this repository sets;
//   * a tick claims AT MOST the free capacity — `claimDueRuns` takes the
//     remaining slots, never a constant — so a full pool claims nothing rather
//     than claiming into nothing;
//   * a saturated loop waits for a SLOT (`waitForSlot`) instead of backing off
//     against the queue, because "the pool is full" and "the queue is empty"
//     are different facts and only one of them is fixed by waiting longer.
//
// ⚠️ THIS IS NOT A SCHEDULER, AND §14.1's REFUSAL IS UNTOUCHED. What is bounded
// here is the WORKER's own in-flight set, after the claiming transaction has
// committed. No per-job option is added, `DefineJobOptions` gains nothing, and
// `claimDueRuns`'s statement — its predicate, its `ORDER BY run_at`, its plan —
// is unchanged. §15.2 is the distinction, with the test that settles which side
// a change is on.
//
// ===========================================================================
// A run WAITING on an in-process gate is PARKED, and leaves the pool (MOTIR-10457)
// ===========================================================================
// POOL_SIZE counts work that is RUNNING. A run that stands in an in-process
// admission line — today the three-slot CI-feedback gate
// (`lib/services/changeRequestCiFeedback.ts`) that every CI delivery of
// `system.github-webhook-delivery` passes through — holds no connection, no lock
// and no CPU while it waits, and counting it as busy is what let a burst of check
// deliveries fill the pool: three working inside the gate, seven parked in its
// line, and `email.send`, every scheduled fire and every supervisor step queued
// behind the backlog until it drained.
//
// So each settle runs inside a WAIT SCOPE (`lib/async/waitScope.ts`), and a wait
// reported through `awaitAsIdle` — the gate's line reports itself that way — moves
// the run to `parked` for exactly its extent:
//
//   * `freeCapacity` counts BUSY runs against POOL_SIZE, so a parked run's slot is
//     claimable again, and a park wakes a loop that was waiting for a slot;
//   * every claim held, parked or not, is bounded by POOL_SIZE + PARK_HEADROOM, so
//     a burst larger than any line we expect still stops the worker claiming
//     rather than taking the whole queue into memory;
//   * a parked run keeps its claim and its lease — the heartbeat renews every row
//     the worker holds — and the drain treats it like any in-flight run, up to the
//     release: see *the drain WITHDRAWS what it releases* below.
//
// ⚠️ BUSY WORK CAN OVERSHOOT POOL_SIZE BY WHAT THE GATES ADMIT, AND NO MORE. A
// parked run unparks only when its gate hands it a slot, and its own slot may
// have been claimed meanwhile, so busy runs may exceed the pool by the sum of the
// gates' limits (three today). That work is rationed by its gate — which exists
// to bound exactly what it may take — and nothing else can unpark.
//
// ⚠️ NOT A SCHEDULER, AND §14.1 IS UNTOUCHED. Nothing here picks which job runs:
// `DefineJobOptions` gains nothing and `claimDueRuns` is unchanged, so the claim
// is still by `run_at` alone. A gated run still waits in its gate's own FIFO line,
// in the order the claim reached it, which is why the fix is a park and not a
// defer: a deferred delivery returns at a time of its own, so a check's
// `in_progress` could land after its `completed` and pull the row back to
// `pending`. `docs/decisions/job-queue-foundation.md` §18 is the decision.
//
// ===========================================================================
// THE THREE WAYS A CLAIM ENDS WITHOUT THE WORK BEING FINISHED — and only one
// of them is bad (MOTIR-3825)
// ===========================================================================
// This section used to be headed "the two ways a claim ends badly" and was
// about the lease alone. There are three now, they are settled in three
// different places, and telling them apart is what `settle()` does:
//
//   * a `JobStepYield` — a `step.sleep`. The run is re-enqueued at the sleep's
//     deadline, the attempt is REFUNDED, and the handler resumes back into the
//     same place in the same loop because every earlier step replays from
//     `job_step`.
//   * a `JobRunDefer` (`./defer.ts`) — the handler has advanced ONE unit of
//     work and wants the run back at an instant it names. Same three effects on
//     the row, and a different promise to the handler: nothing is checkpointed,
//     the next pass starts at the TOP, and the handler owns whatever it needs to
//     remember in a durable row of its own
//     (`docs/decisions/job-queue-foundation.md` §16.1).
//   * a LOST LEASE — the one that is actually bad, and the only one this
//     section's remaining paragraphs are about. Nobody asked for it: the worker
//     DIED holding the row.
//
// ⚠️ THE FIRST TWO ARE INDISTINGUISHABLE AT THE ROW AND MUST NOT BE MERGED IN
// THE CODE. Both end at `rescheduleAt(..., { refundAttempt: true })`, so a
// reader who reaches for one arm to serve both is reading the effect rather than
// the contract. The contracts differ in what the HANDLER may assume on the next
// pass, `onOutcome` reports them under different names so an operator can tell a
// sleeping supervisor from an advancing one, and `./defer.ts`'s header carries
// the table.
//
// ===========================================================================
// The lease, and the way a claim ends badly
// ===========================================================================
// A claim carries a LEASE: `lease_expires_at`, renewed by a heartbeat while the
// worker is alive. It exists for the one failure a graceful shutdown cannot
// cover — the worker DIES (OOM, host loss, SIGKILL) with runs in flight. Without
// a lease those rows sit `running` forever with no live claimant; with one they
// become reclaimable.
//
//   * LEASE_MS is 60 s and RENEW_MS is 20 s — a 3× margin, so two consecutive
//     missed heartbeats are needed before a live worker is declared dead. One
//     missed beat is a GC pause or a slow query and must not cost a run.
//   * The heartbeat renews EVERY run this worker holds in one statement, scoped
//     to `claimed_by`, so a worker can only renew its own.
//   * A run legitimately longer than the lease is the normal case, not the
//     exception (the container supervisors sleep for half an hour). The
//     heartbeat is what makes a long run and a dead worker distinguishable —
//     nothing about duration alone can.
//
// ⚠️ A RECLAIM AND A DRAIN BOTH REFUND THE ATTEMPT. `claimDueRuns` spends an
// attempt at the claim, so a worker that died has already consumed one without
// the handler ever failing. Not refunding it lets a rolling deploy or a
// crash-loop exhaust a job's whole budget silently — it would dead-letter with
// no error to show an operator. A genuine handler failure is counted on the
// failure path, where there is something to record.
//
// ===========================================================================
// Waking up: backoff, and why NOTIFY is not an optimisation
// ===========================================================================
// An idle worker polls with a bounded exponential backoff (IDLE_MIN_MS →
// IDLE_MAX_MS). On its own that means a freshly emitted event waits out up to a
// full poll interval before anything runs — user-visible latency on a
// notification or an email, for no reason other than the loop's own cadence.
//
// So the worker also LISTENs on a Postgres channel the dispatcher NOTIFYs, and
// treats a notification as "wake now". `LISTEN`/`NOTIFY` is a Postgres feature
// and needs no new service — which was one of the constraints on the foundation
// decision (`docs/decisions/job-queue-foundation.md` §9).
//
// ⚠️ THE POLL IS THE CORRECTNESS PATH AND THE NOTIFY IS THE LATENCY PATH — in
// that order, deliberately. A notification is delivered at most once and only to
// a listener connected AT THE MOMENT it fires: a worker restarting, or one whose
// connection has just dropped, misses it and would otherwise never learn the run
// exists. So the poll continues at IDLE_MAX_MS regardless, and losing the
// listener degrades latency rather than losing work. A design where NOTIFY is
// load-bearing has a silent-stall failure mode; this one does not.
//
// ===========================================================================
// Graceful shutdown
// ===========================================================================
// On SIGTERM: stop claiming, let in-flight runs finish (or checkpoint, if they
// yield or defer), then RELEASE the claims so another machine can take them
// immediately. A pass that defers during the drain needs nothing special: it has
// already returned its row to `pending` with `claimed_by` null, so it leaves
// `inFlight` on its own and the unconditional release below finds nothing of its
// to release.
// A deploy is a routine event — several a day — and must not orphan work or cost
// an attempt.
//
// The drain is bounded by DRAIN_TIMEOUT_MS. Fly sends SIGKILL some seconds after
// SIGTERM, so the release must happen with time to spare: a run still going at
// the deadline is released anyway and re-run later by whoever claims it, which
// is safe precisely because the step ledger memoized everything it completed.
// That is the shim paying for itself outside its own card.
//
// ⚠️ THE DRAIN WITHDRAWS WHAT IT RELEASES (MOTIR-10462). Since MOTIR-10457 a
// drain that times out is mostly releasing PARKED runs — a burst behind the
// three-slot CI gate leaves hundreds in its line — and a released row is
// claimable by another machine the moment the release commits. A parked run left
// in the line would be admitted later, in this process, and do the work the next
// claimant may already be doing, in an order nobody keeps. So before the release
// every run still in flight is WITHDRAWN: its wait scope's signal is aborted, a
// waiter leaves its gate's line at once and is never admitted, and a run that
// reaches a gate after the release is refused at the door. A withdrawn settle
// writes NOTHING — the release's `pending`, unclaimed, attempt-refunded row is the
// state it leaves, and the next claimant runs it once. Work already past every
// gate is not interrupted: it holds what it holds, as before, and its next
// claimant resumes it from the step ledger.
//
// ⚠️ A SETTLE WRITES ONLY OVER A ROW IT STILL HOLDS (MOTIR-10466). Work already
// past every gate keeps executing after the release, and its settle used to write
// `succeeded` / a reschedule / `failed` keyed on the row's id alone — over a row
// another worker may have claimed since, which then read `succeeded` with no
// claimant while it was still executing. Every settle write is now fenced on
// `state = 'running' AND claimed_by = <this worker>`, the scope the heartbeat and
// the release have always had, and a write that is fenced out writes NOTHING: the
// pass is reported `released`, and the row is whatever its current holder or the
// release made it. A released row nobody has re-claimed stays `pending`, so its
// next claimant runs it — resuming from the step ledger — rather than a draining
// process recording work over a row it gave back. The terminal-failure hook is
// asked only while the claim is still held, so a released run is not dead-lettered
// either. The same fence covers a lease reclaimed from a worker that missed its
// heartbeats and then claimed by ANOTHER worker.
// `docs/decisions/job-queue-foundation.md` §18.7 is the decision.
//
// ⚠️ THE FENCE IS THE CLAIM, NOT THE WORKER (MOTIR-10500). A live worker that
// misses its heartbeats long enough (an event-loop stall, a slow database) has its
// lease reclaimed by its OWN next tick, which can then claim the very run it is
// still executing. Both passes carry this worker's id, so a worker-id fence let the
// first pass's settle write `succeeded` over the row the second was executing. So:
//
//   * every claim carries a FENCING TOKEN (`job_queue.claim_token`), bumped by
//     `claimDueRuns` and never lowered, and every settle write matches the token
//     its own claim returned — a pass whose claim was reclaimed writes nothing and
//     is reported `released`, whoever re-claimed the row;
//   * the in-flight bookkeeping — `inFlight`, `parked`, `withdrawals`, `settling` —
//     is keyed on the PASS (run id + token), not the run id, so the first pass's
//     `finally` cannot drop the second from the set the pool, the drain and its
//     withdrawal all read. Both passes count until each settles.
//
// Two passes of one run in one process is still possible — the lease lapsed, and
// at-least-once delivery is the contract — and the step ledger is what makes the
// second resume rather than repeat. What the token guarantees is that only the
// LIVE claim's outcome is recorded. §18.8 is the decision.

/** How long a claim is held before another worker may reclaim it. */
export const LEASE_MS = 60_000;
/** Heartbeat cadence. A 3× margin on the lease: two missed beats before a live worker looks dead. */
export const RENEW_MS = 20_000;
/** Idle poll floor and ceiling. The ceiling bounds how long a MISSED notification can cost. */
export const IDLE_MIN_MS = 250;
export const IDLE_MAX_MS = 5_000;
/** How long a drain waits for in-flight runs before releasing them anyway. */
export const DRAIN_TIMEOUT_MS = 20_000;
/**
 * How many runs one worker claims per tick — an AMORTISER for the claim
 * round-trip, and (since MOTIR-3762) not a concurrency control.
 *
 * It used to be both, because the tick awaited its whole batch. It no longer
 * does, so this bounds how much one `claimDueRuns` statement takes and nothing
 * else; {@link POOL_SIZE} is what bounds concurrent work
 * (`docs/decisions/job-queue-foundation.md` §15.6.3, which also records why
 * neither raising nor lowering this is the instrument for a long run).
 */
export const CLAIM_BATCH = 5;
/**
 * How many claimed runs this worker EXECUTES at once — the worker's own
 * in-flight pool, and the real concurrency control (§15.3).
 *
 * Not a database pool and not a per-job limit: it is a count of settles running
 * concurrently in this process. Its FLOOR is the number of long-running
 * supervisors that may legitimately be in flight at once — today
 * `system.code-graph-index`, `system.code-graph-refresh` and
 * `system.ci-runner-boot`, three — plus headroom for the fast lane, which is
 * what 2026-08-28 had none of. Ten leaves seven slots for short work while all
 * three supervisors watch containers.
 */
export const POOL_SIZE = 10;
/**
 * How many claims a worker may hold BEYOND its pool while runs are parked on an
 * in-process gate (MOTIR-10457) — so every claim it holds, busy or parked, is
 * bounded by `POOL_SIZE + PARK_HEADROOM`.
 *
 * A parked run is a `JobQueueRun` row and, for a GitHub delivery, the delivery's
 * stored body (kilobytes), so the cost of a large line is memory and one heartbeat
 * statement over more rows, not connections. One push produces about two
 * deliveries per check (an 88-check workflow is ~180) and several pull requests
 * push at once, so the headroom is sized for "hundreds" with margin, and it is a
 * BOUND rather than a target: past it the worker stops claiming, which is the
 * pre-MOTIR-10457 behaviour, reached only after five hundred runs are waiting.
 */
export const PARK_HEADROOM = 500;
/** The channel the dispatcher NOTIFYs when it enqueues. */
export const JOB_QUEUE_CHANNEL = 'motir_job_queue';

/** What the worker needs in order to execute one claimed run. Supplied by the caller so the loop is testable without the registry. */
export type JobRunExecutor = (run: JobQueueRun) => Promise<void>;

export interface JobWorkerOptions {
  /**
   * Executes one claimed run. Throws to signal failure; throws a `JobStepYield`
   * to signal a durable sleep, or a `JobRunDefer` (`./defer.ts`) to signal that
   * the handler advanced one unit of work and wants the run back at an instant
   * it names. The header's *three ways a claim ends* is the difference.
   */
  execute: JobRunExecutor;
  /** Identifies this worker in `claimed_by`. Defaults to a per-process UUID. */
  workerId?: string;
  /** Overrides for the timing constants — the tests drive these; production passes none. */
  timings?: Partial<{
    leaseMs: number;
    renewMs: number;
    idleMinMs: number;
    idleMaxMs: number;
    drainTimeoutMs: number;
    claimBatch: number;
    poolSize: number;
    parkHeadroom: number;
  }>;
  /**
   * Called on every outcome of one PASS — which is not the same as every
   * outcome of a run: `retrying`, `yielded` and `deferred` all mean the row is
   * back in the queue and will be claimed again.
   *
   * ⚠️ `yielded` AND `deferred` ARE DIFFERENT AND BOTH ARE REPORTED. They have
   * identical effects on the row (see the header) and different contracts, and
   * an operator reading a stream of these is the one consumer who can tell a
   * supervisor SLEEPING from a supervisor ADVANCING. Collapsing them would
   * make a stalled chain look exactly like a healthy one.
   *
   * `withdrawn` (MOTIR-10462): the drain released this run while it waited on an
   * in-process gate, and it left without starting the work. The row is as the
   * release wrote it; the pass wrote nothing.
   */
  onOutcome?: (
    run: JobQueueRun,
    outcome:
      | 'succeeded'
      | 'failed'
      | 'retrying'
      | 'yielded'
      | 'deferred'
      | 'withdrawn'
      | 'released',
  ) => void;
  /**
   * ⚠️ THE AFTER-ALL-RETRIES-EXHAUSTED HOOK — the engine's `onFailure`
   * (MOTIR-3424). Invoked when the budget is spent, BEFORE the row is marked
   * failed, and this is where the `failed` ledger row and the dead-letter row are
   * written.
   *
   * It lives HERE, in the loop, and not in a `catch` inside the handler's own
   * execution, for the reason `lib/jobs/engine/ledger.ts` records at length:
   * Inngest's executor never runs a `step.run` scheduled from a catch block after
   * the terminally-failing step, so the equivalent code there silently never wrote
   * the rows in production while the in-process test harness made it look like it
   * did (PRODECT_FINDINGS #39). This hook is plain code in the claim loop with no
   * step machinery between the throw and the write.
   *
   * A throw from the hook itself is caught and logged — a bookkeeping failure
   * must not leave the run `running` with no live claimant, which is a strictly
   * worse state than a missing dashboard row.
   */
  onTerminalFailure?: (run: JobQueueRun, error: unknown) => Promise<void>;
  /**
   * ⚠️ THE SCHEDULER TICK (MOTIR-3471) — run at the TOP of every claim tick, so a
   * fire this enqueues is claimed in the SAME pass rather than at the next poll
   * boundary.
   *
   * It lives on the loop rather than on a timer of its own for the reason
   * `lib/jobs/engine/scheduler.ts` gives at length: a `setTimeout` chain expresses
   * a schedule as "one interval since the last tick" and skews under load, while a
   * tick driven by the poll recomputes every fire from the CLOCK and so cannot.
   * It also means the drain needs no second shutdown path — `tick()` returns early
   * once `draining` is set, so a half-enqueued tick is not a state this can reach.
   *
   * A throw is logged and swallowed: a scheduling failure must not stop the worker
   * CLAIMING, which is the strictly more important half of the loop.
   */
  onSchedulerTick?: () => Promise<void>;
  /** Structured logging sink; defaults to `console`. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * Exponential backoff for a RETRY, in ms. Doubling from one second, capped at
 * five minutes, with ±20% jitter.
 *
 * The jitter is not decoration: without it every run of a job that failed for a
 * COMMON cause (a provider outage, a database blip) retries at the same instant,
 * and the recovering dependency is hit by the whole cohort at once. That is the
 * thundering herd, and it is how a brief outage becomes a long one.
 */
export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 300_000);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * True when a thrown value DECLARES that repeating the run cannot help —
 * `retryable === false` on the error (MOTIR-5873). The worker then dead-letters
 * on this attempt instead of rescheduling onto the backoff curve.
 *
 * A duck-typed property and not a class, deliberately: the code that knows a
 * failure is hopeless (a provider adapter, e.g. `lib/email.ts`'s spent-quota
 * `EmailDeliveryError`) is outside `lib/jobs/**` and may not import the engine,
 * and the engine may not import it back. Only an explicit `false` counts — an
 * error that says nothing keeps its whole budget, so no existing job changes.
 */
export function isNonRetryableFailure(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === false
  );
}

/**
 * The in-flight key of ONE PASS — one claim of one run (MOTIR-10500). The run id
 * alone is not unique: a worker whose lease lapsed can claim its own run again
 * while the first pass is still executing, and the fencing token is what differs.
 */
export function passKeyOf(run: Pick<JobQueueRun, 'id' | 'claimToken'>): string {
  return `${run.id}#${run.claimToken}`;
}

/** Serialize an unknown thrown value for `job_queue.last_error`. Mirrors `defineJob`'s `serializeFailure`. */
export function serializeWorkerFailure(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: String(err) };
}

/**
 * One worker. Constructed, then `start()`ed; `shutdown()` drains it.
 *
 * The loop is exposed as `tick()` as well, so the tests can drive it one claim
 * at a time and assert on the outcome instead of racing a background timer.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly execute: JobRunExecutor;
  private readonly onOutcome: NonNullable<JobWorkerOptions['onOutcome']>;
  private readonly onTerminalFailure: JobWorkerOptions['onTerminalFailure'];
  private readonly onSchedulerTick: JobWorkerOptions['onSchedulerTick'];
  private readonly log: NonNullable<JobWorkerOptions['logger']>;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly idleMinMs: number;
  private readonly idleMaxMs: number;
  private readonly drainTimeoutMs: number;
  private readonly claimBatch: number;
  private readonly poolSize: number;
  private readonly parkHeadroom: number;

  /** Set by `shutdown()`; the loop stops CLAIMING the moment it is true. */
  private draining = false;
  private running = false;
  private idleDelay: number;
  private heartbeat: NodeJS.Timeout | undefined;
  /**
   * PASSES this worker has claimed and not yet settled, by {@link passKeyOf}. The
   * drain waits on these. Keyed on the pass, not the run id, because one run can
   * be claimed twice by this worker when its lease lapses (MOTIR-10500).
   */
  private readonly inFlight = new Set<string>();
  /**
   * The in-flight runs that are only WAITING on an in-process gate right now
   * (MOTIR-10457). Always a subset of {@link inFlight}; they do not count
   * against the pool. The header's *parked* section is the contract.
   */
  private readonly parked = new Set<string>();
  /**
   * How the drain WITHDRAWS each in-flight run before it releases the claim
   * (MOTIR-10462): one controller per settle, whose signal is the run's wait scope's.
   */
  private readonly withdrawals = new Map<string, AbortController>();
  /**
   * The DETACHED settle of each in-flight run, kept so {@link settled} can await
   * them. `tick()` returns at the claim now, so a caller that wants "and then
   * they all finished" has to be able to say so — which is the authoritative
   * signal a test needs in place of the old awaited `Promise.all`.
   */
  private readonly settling = new Map<string, Promise<void>>();
  /** Resolvers waiting for a slot to free. Woken by a settle, and by `shutdown()`. */
  private readonly slotWaiters = new Set<() => void>();
  /** Resolves when the idle sleep should be cut short — the NOTIFY path. */
  private wake: (() => void) | undefined;
  /** The running loop, so `shutdown()` can wait for a claim it is in the middle of. */
  private loopDone: Promise<void> | undefined;
  /** The lease renewal in flight, if any — `clearInterval` stops the next, not this one. */
  private renewing: Promise<unknown> | undefined;
  /** True while `renewing` is unsettled — the heartbeat's single-flight guard (MOTIR-6958). */
  private renewalInFlight = false;

  constructor(opts: JobWorkerOptions) {
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
    this.execute = opts.execute;
    this.onOutcome = opts.onOutcome ?? (() => {});
    this.onTerminalFailure = opts.onTerminalFailure;
    this.onSchedulerTick = opts.onSchedulerTick;
    this.log = opts.logger ?? console;
    this.leaseMs = opts.timings?.leaseMs ?? LEASE_MS;
    this.renewMs = opts.timings?.renewMs ?? RENEW_MS;
    this.idleMinMs = opts.timings?.idleMinMs ?? IDLE_MIN_MS;
    this.idleMaxMs = opts.timings?.idleMaxMs ?? IDLE_MAX_MS;
    this.drainTimeoutMs = opts.timings?.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.claimBatch = opts.timings?.claimBatch ?? CLAIM_BATCH;
    this.poolSize = Math.max(1, opts.timings?.poolSize ?? POOL_SIZE);
    this.parkHeadroom = Math.max(0, opts.timings?.parkHeadroom ?? PARK_HEADROOM);
    this.idleDelay = this.idleMinMs;
  }

  /** How many runs this worker currently holds. The drain's own condition, exposed for the tests. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** How many of the runs this worker holds are parked on an in-process gate. */
  get parkedCount(): number {
    return this.parked.size;
  }

  /**
   * How many more runs this worker may take: the pool's free BUSY slots — a
   * parked run occupies none — capped so that every claim held stays within
   * `poolSize + parkHeadroom` (MOTIR-10457).
   */
  get freeCapacity(): number {
    const busy = this.inFlight.size - this.parked.size;
    const busyRoom = this.poolSize - busy;
    const claimRoom = this.poolSize + this.parkHeadroom - this.inFlight.size;
    return Math.max(0, Math.min(busyRoom, claimRoom));
  }

  /**
   * Claim one batch and START it. Returns how many runs were CLAIMED — 0 means
   * either that the queue had nothing due or that the pool is full, which
   * {@link freeCapacity} tells apart and {@link loop} acts on differently.
   *
   * ⚠️ IT RETURNS AT THE CLAIM, NOT AT THE SETTLE (MOTIR-3762). Each claimed run
   * is settled on its own, detached, so a thirty-five-minute supervisor cannot
   * detain the four runs claimed beside it — and so the loop can claim again the
   * moment capacity frees rather than when the slowest member finishes. A caller
   * that wants "and then they all finished" awaits {@link settled}.
   *
   * Public so a test can step the loop deterministically rather than sleeping
   * against a background timer, which is the same authoritative-signal
   * discipline the E2E rule states one altitude up.
   */
  async tick(): Promise<number> {
    if (this.draining) return 0;

    // The SCHEDULER, before anything else (MOTIR-3471): a cron fire it enqueues
    // is then claimed by the very same tick. Guarded because a scheduling failure
    // must not stop the worker claiming — see the option's own comment.
    //
    // ⚠️ AND BEFORE THE CAPACITY CHECK, BECAUSE A FULL POOL MUST NOT STOP THE
    // CLOCK (MOTIR-10600). Writing a due fire is not claiming it: the fire waits
    // in `job_queue` for a slot like any other row. With the check first, ten
    // runs that held every slot also froze every cron job — the missed-close
    // replay among them — for as long as they held it (2026-11-07, 36 minutes). A
    // saturated loop re-ticks every `idleMaxMs` at most (`waitForSlot`), and a
    // tick with nothing owed writes nothing (`scheduler.ts`), so this costs one
    // bounded, idempotent pass per interval.
    if (this.onSchedulerTick) {
      try {
        await this.onSchedulerTick();
      } catch (err) {
        this.log.error('[job-worker] scheduler tick failed; continuing to claim', err);
      }
    }

    // ⚠️ CAPACITY IS CHECKED BEFORE THE RECLAIM AND THE CLAIM. A tick that cannot
    // claim should not spend two statements discovering it — and `claimDueRuns`
    // must not be called with a non-positive limit, which is what "claiming into
    // nothing" would mean.
    const capacity = this.freeCapacity;
    if (capacity <= 0) return 0;

    // Reclaim first: a run abandoned by a dead worker is due work, and doing
    // this before the claim means it is picked up in the SAME tick rather than
    // waiting for the next one.
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));

    // The claim: one transaction, holding the lock and the state write and
    // nothing else. The LIMIT is the free capacity, never a constant — the batch
    // size only bounds how much one statement takes.
    const limit = Math.min(this.claimBatch, capacity);
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns(this.workerId, limit, this.leaseMs, tx),
    );
    if (claimed.length === 0) return 0;

    for (const run of claimed) {
      const pass = passKeyOf(run);
      this.inFlight.add(pass);
      // Executed OUTSIDE the claiming transaction — see the header. DETACHED, so
      // one slow run does not hold the tick, and one run's failure cannot abort
      // its batch-mates.
      //
      // The `catch` is not decoration: `settle()` swallows a HANDLER failure, but
      // a throw from its own bookkeeping (the reschedule, the mark) would now be
      // an unhandled rejection on a detached promise — which takes the process
      // down, where before it merely failed the tick. `settle()`'s own `finally`
      // has already released the in-flight slot by the time this runs.
      const settling = this.settle(run, pass)
        .catch((err: unknown) => {
          this.log.error(`[job-worker] settle threw for run ${run.id}`, err);
        })
        .finally(() => {
          this.settling.delete(pass);
          this.releaseSlot();
        });
      this.settling.set(pass, settling);
    }
    return claimed.length;
  }

  /**
   * Resolves when every run currently in flight has settled.
   *
   * The authoritative signal that replaces the awaited `Promise.all` `tick()`
   * used to end with. It loops because a settle may finish while we are awaiting
   * another, and a caller asking "is the worker quiet?" means all of them.
   */
  async settled(): Promise<void> {
    while (this.settling.size > 0) {
      await Promise.all([...this.settling.values()]);
    }
  }

  /** Wake everything waiting for a slot. Called by a finished settle, and by the drain. */
  private releaseSlot(): void {
    if (this.slotWaiters.size === 0) return;
    for (const waiter of [...this.slotWaiters]) waiter();
  }

  /**
   * Wait until a slot frees, or until `timeoutMs` — whichever is first.
   *
   * The BACK-PRESSURE half of §15.3. A saturated worker must not back off
   * against the QUEUE: the queue is not the thing that is full, and waiting
   * longer does not empty the pool. The timeout is a floor rather than the
   * mechanism, so a lost wake-up degrades latency instead of wedging the loop —
   * the same ordering `notify()` has against the poll.
   */
  private waitForSlot(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        /* v8 ignore next -- defensive: `finish` removes itself from `slotWaiters`
           AND clears its timer in one synchronous step, and `releaseSlot` calls
           each waiter once, so no second call can reach this. The guard stays
           because the invariant is a property of THOSE two call sites rather than
           of this closure; the test *`waitForSlot` resolves ONCE* pins it. */
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.slotWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.slotWaiters.add(finish);
      if (this.draining) finish();
    });
  }

  /** Run one claimed row and record its terminal state. Never throws — a failure is an outcome, not an exception the loop should die on. */
  private async settle(run: JobQueueRun, pass: string): Promise<void> {
    const withdrawal = new AbortController();
    this.withdrawals.set(pass, withdrawal);
    // The claim this pass holds — what every settle write below is fenced on.
    const claim: JobQueueClaim = {
      id: run.id,
      workerId: this.workerId,
      claimToken: run.claimToken,
    };
    try {
      await runObservingWaits(
        {
          onWaitStart: () => this.park(pass),
          onWaitEnd: () => this.parked.delete(pass),
          signal: withdrawal.signal,
        },
        () => this.execute(run),
      );
      await this.record(run, 'succeeded', (tx) => jobQueueRepository.markSucceeded(claim, tx));
    } catch (err) {
      if (withdrawal.signal.aborted && isWaitWithdrawn(err)) {
        // RELEASED WHILE IT WAITED (MOTIR-10462). The drain gave the row back —
        // `pending`, unclaimed, attempt refunded — before this run was admitted, so
        // the work never started here and the row is the next claimant's. Writing
        // anything now would overwrite a row this worker no longer holds.
        this.onOutcome(run, 'withdrawn');
        return;
      }

      if (isJobStepYield(err)) {
        // A durable sleep. NOT a failure: the attempt is refunded and the run is
        // re-enqueued at the deadline the step recorded.
        await this.record(run, 'yielded', (tx) =>
          jobQueueRepository.rescheduleAt(claim, err.resumeAt, tx, {
            refundAttempt: true,
          }),
        );
        return;
      }

      if (isJobRunDefer(err)) {
        // THE HANDLER ADVANCED ONE UNIT OF WORK AND WANTS THE RUN BACK
        // (MOTIR-3825). Same three effects on the row as the yield above —
        // `pending` at the named instant, claim released, attempt refunded —
        // and a different contract with the handler, which is why it is its own
        // arm rather than a second `isJobStepYield` case.
        //
        // ⚠️ IT SITS BEFORE THE FAILURE PATH, and that ordering is the whole
        // safety of the primitive. Reaching the failure path would spend an
        // attempt on a suspension, and on `system.ci-runner-boot`
        // (`retryPolicy: 'none'`, a budget of exactly one) the second poll would
        // dead-letter a CI job that was fine.
        await this.record(run, 'deferred', (tx) =>
          jobQueueRepository.rescheduleAt(claim, err.resumeAt, tx, {
            refundAttempt: true,
          }),
        );
        return;
      }

      const failure = serializeWorkerFailure(err);
      // A failure that declares itself non-retryable ends the run NOW, exactly
      // as a spent budget does — the same hook, the same dead-letter row. A
      // spent provider quota is the case: retrying minutes apart only asks an
      // exhausted quota again (MOTIR-5873).
      if (run.attempts >= run.maxAttempts || isNonRetryableFailure(err)) {
        await this.failTerminally(run, claim, err, failure);
        return;
      }

      const backoff = retryBackoffMs(run.attempts);
      await this.record(run, 'retrying', (tx) =>
        jobQueueRepository.rescheduleAt(claim, new Date(Date.now() + backoff), tx, {
          lastError: failure,
        }),
      );
    } finally {
      this.parked.delete(pass);
      this.inFlight.delete(pass);
      this.withdrawals.delete(pass);
    }
  }

  /**
   * Write one settle's row change and report the pass — or, when the write was
   * FENCED OUT because this worker no longer holds the row, report it `released`
   * and write nothing (MOTIR-10466). The header's *a settle writes only over a row
   * it still holds* is the contract. Answers whether the write landed.
   */
  private async record(
    run: JobQueueRun,
    outcome: 'succeeded' | 'failed' | 'retrying' | 'yielded' | 'deferred',
    write: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ): Promise<boolean> {
    if (await withSystemContext(write)) {
      this.onOutcome(run, outcome);
      return true;
    }
    this.reportReleased(run, outcome);
    return false;
  }

  /** A pass whose claim was released before it settled: nothing written, said so once. */
  private reportReleased(run: JobQueueRun, would: string): void {
    this.log.warn(
      `[job-worker] ${run.jobId} run ${run.id} (claim ${run.claimToken}) is no longer held by ${this.workerId}; ` +
        `its ${would} pass wrote nothing and the row is its next claimant's`,
    );
    this.onOutcome(run, 'released');
  }

  /**
   * The budget is spent (or the failure declared itself hopeless). Write the ledger
   * + DLQ rows BEFORE marking the queue row failed, so an operator never sees a
   * `failed` run with no record of why — and only while this worker still holds
   * the row, so a run released mid-execution is not dead-lettered by a worker that
   * gave it back (MOTIR-10466). Its next claimant has the refunded attempt.
   */
  private async failTerminally(
    run: JobQueueRun,
    claim: JobQueueClaim,
    err: unknown,
    failure: { message: string; stack?: string },
  ): Promise<void> {
    const holds = await withSystemContext((tx) => jobQueueRepository.isHeldBy(claim, tx));
    if (!holds) {
      this.reportReleased(run, 'failed');
      return;
    }
    if (this.onTerminalFailure) {
      try {
        await this.onTerminalFailure(run, err);
      } catch (hookErr) {
        // A bookkeeping failure must not strand the run. Log it and still
        // settle the row: `running` with no live claimant is strictly worse
        // than a missing dashboard entry.
        this.log.error('[job-worker] terminal-failure hook threw', hookErr);
      }
    }
    const marked = await this.record(run, 'failed', (tx) =>
      jobQueueRepository.markFailed(claim, failure, tx),
    );
    if (marked) {
      this.log.error(`[job-worker] ${run.jobId} run ${run.id} FAILED terminally`, failure.message);
    }
  }

  /**
   * A run began waiting on an in-process gate: it leaves the busy count, and a
   * loop waiting for a slot is woken to claim into it (MOTIR-10457).
   */
  private park(pass: string): void {
    /* v8 ignore next -- defensive: `settle` is the only scope that reports, and
       it reports only while `pass` is in flight. A wait that outlives the settle
       (work the handler left running detached) must not park a pass that is gone. */
    if (!this.inFlight.has(pass)) return;
    this.parked.add(pass);
    this.releaseSlot();
  }

  /**
   * The loop. Claims until the queue is empty, then backs off — interruptibly,
   * so a NOTIFY (or a shutdown) cuts the sleep short instead of waiting it out.
   */
  private async loop(): Promise<void> {
    while (!this.draining) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (err) {
        // A claim that fails is a database problem, not a job problem. Log and
        // back off rather than exiting: a worker that dies on a transient error
        // takes the whole background layer down with it until the platform
        // restarts it.
        this.log.error('[job-worker] claim tick failed', err);
      }
      // Draining began during that tick: leave now rather than wait out a sleep
      // or a slot that shutdown's single wake already missed.
      if (this.draining) break;
      if (claimed > 0) {
        this.idleDelay = this.idleMinMs; // work found — poll eagerly again
        continue;
      }
      // ⚠️ SATURATED IS NOT IDLE (MOTIR-3762). A tick returns 0 for two reasons
      // and they want opposite responses: an empty queue is waited out with the
      // backoff, while a full pool is waited out on a SLOT. Backing off against
      // the queue here would grow the delay while the only thing that can change
      // is a settle finishing — and would then leave the freed slot idle for the
      // remainder of the sleep.
      if (this.freeCapacity === 0) {
        await this.waitForSlot(this.idleMaxMs);
        continue;
      }
      await this.sleepInterruptibly(this.idleDelay);
      this.idleDelay = Math.min(this.idleDelay * 2, this.idleMaxMs);
    }
  }

  /**
   * Sleep, unless `notify()` or `shutdown()` wakes us first.
   *
   * `finish` is idempotent because both wake paths can fire: a NOTIFY landing in
   * the same millisecond as the timer would otherwise resolve twice and clear a
   * timer that no longer exists.
   */
  private sleepInterruptibly(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      // A shutdown that began before this sleep was registered woke nothing —
      // don't sleep through it (MOTIR-6734: shutdown now waits for the loop).
      if (this.draining) finish();
    });
  }

  /**
   * Wake the loop now — the NOTIFY path, and what makes a freshly emitted event
   * start immediately rather than at the next poll boundary. Safe to call when
   * the worker is busy or stopped: it is a hint, never a claim.
   */
  notify(): void {
    this.wake?.();
  }

  /** Start the loop and the lease heartbeat. Resolves immediately; the loop runs in the background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.draining = false;
    // ⚠️ SINGLE-FLIGHT (MOTIR-6958). A tick that fires while the previous renewal
    // is still on the wire SKIPS rather than starting a second one. `renewing` is
    // one slot, so two overlapping renewals left `shutdown()` awaiting only the
    // newest — and the older could land after `releaseClaims`, the hazard
    // MOTIR-6734 closed. A skipped tick costs the lease nothing it can feel: the
    // gap between two renewals is at most RENEW_MS plus one renewal's latency,
    // against a LEASE_MS of 3× RENEW_MS.
    this.heartbeat = setInterval(() => {
      if (this.renewalInFlight) return;
      this.renewalInFlight = true;
      this.renewing = withSystemContext((tx) =>
        jobQueueRepository.renewLeases(this.workerId, this.leaseMs, tx),
      )
        .catch((err: unknown) => this.log.warn('[job-worker] lease renewal failed', err))
        .finally(() => {
          this.renewalInFlight = false;
        });
    }, this.renewMs);
    // `unref` so a heartbeat timer alone never holds the process open.
    this.heartbeat.unref?.();
    this.loopDone = this.loop();
  }

  /**
   * Drain: stop claiming, wait for in-flight runs (bounded), then WITHDRAW and
   * RELEASE whatever this worker still holds so another machine can take it at
   * once. A run withdrawn while it waits on an in-process gate never starts its
   * work here (MOTIR-10462).
   *
   * The release is unconditional — it runs whether the wait succeeded or timed
   * out. A run released mid-execution is re-run later by its next claimant, and
   * the step ledger means it resumes rather than restarts. Leaving it `running`
   * with no live claimant would be the actual failure: the acceptance criterion
   * is that no such row exists after a shutdown, and the ONLY way to guarantee
   * that is to release even the ones that did not finish in time.
   */
  async shutdown(): Promise<void> {
    this.draining = true;
    this.wake?.(); // cut any idle sleep short so the loop exits promptly
    this.releaseSlot(); // and any wait for capacity, which no settle may be about to end
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    // Wait for the loop to leave its current claim, and for a renewal already on
    // the wire (MOTIR-6734). Without this, shutdown returned while a claim query
    // was still running: a claim landing after the release below leaves rows held
    // by a worker that has stopped, until their lease runs out. The heartbeat is
    // single-flight (MOTIR-6958), so `renewing` is the ONLY renewal there can be.
    await this.loopDone;
    await this.renewing;

    // ⚠️ IT WAITS ON `inFlight`, WHICH IS STILL THE WHOLE SET (MOTIR-3762). The
    // settles are detached now, so there is no `tick()` promise left to await —
    // and that is exactly why the drain's condition was never the tick. Every
    // detached settle removes its own id here in a `finally`, so a claim held by
    // one is a claim this loop still sees, and the unconditional release below
    // still reaches it.
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.inFlight.size > 0) {
      this.log.warn(
        `[job-worker] drain timed out with ${this.inFlight.size} run(s) in flight ` +
          `(${this.parked.size} parked); withdrawing and releasing them`,
      );
      // WITHDRAW BEFORE THE RELEASE (MOTIR-10462). Aborting runs each waiter's
      // leave synchronously, so every parked run is out of its gate's line before
      // the release below makes its row claimable elsewhere, and none can be
      // admitted in between. See the header's *the drain WITHDRAWS what it releases*.
      for (const withdrawal of this.withdrawals.values()) withdrawal.abort();
    }

    const released = await withSystemContext((tx) =>
      jobQueueRepository.releaseClaims(this.workerId, tx),
    );
    if (released > 0) this.log.info(`[job-worker] released ${released} claim(s) on shutdown`);
    this.running = false;
  }
}
