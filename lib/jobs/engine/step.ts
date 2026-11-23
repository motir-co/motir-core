import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';

// The `step` SHIM (Story MOTIR-3414 · Subtask MOTIR-3422) — the compatibility
// layer that lets the Postgres engine run handlers written against Inngest's
// step contract without editing a single call site.
//
// Measured on `origin/main@165f1485`: 58 `step.run` call sites across 26 files
// (and 3 `step.sleep`), all but one of them under `lib/jobs/`. **This card edits
// none of them**, which is the property to preserve and the reason this file
// implements Inngest's contract rather than a nicer one of its own.
// (MOTIR-3414's own body said 84 across 37 including services outside
// `lib/jobs/`; that was re-measured and amended on the card — planning bug
// MOTIR-3428. The corrected figure is the one above.)
//
// ===========================================================================
// `step.run(id, fn)` — the whole contract, in one sentence
// ===========================================================================
// Look up `(run_id, id)` in `job_step`. If a row exists, return its stored
// result WITHOUT executing. Otherwise execute `fn`, persist the result, return
// it. That is what makes a retried or resumed run skip the steps it already
// completed, and it is all our 24 jobs actually rely on.
//
// ⚠️ THE JSON BOUNDARY IS CROSSED ON THE FIRST EXECUTION TOO, DELIBERATELY.
// A stored result is JSON, so a `Date` returned from a step comes back as a
// STRING on replay — which is exactly how production behaves today and what the
// existing tests already account for. The tempting implementation returns the
// in-process value on the first run and the parsed value on a replay, and it is
// WRONG: it makes the shim *more faithful in-process than on resume*, so a
// handler that does `result.finishedAt.getTime()` works every time until the
// first restart and then throws in production, on a path no local test covers.
// So `roundTrip` is applied to the value we return, not only to the value we
// store. One behaviour, both paths.
//
// ⚠️ AND THE ID NAMES THE RESULT'S SHAPE, NOT ONLY ITS SUBJECT — CHANGE WHAT A
// STEP RETURNS AND YOU CHANGE ITS ID, IN THE SAME COMMIT
// (`docs/decisions/job-queue-foundation.md` §13.6). The sentence above has a
// second consequence, and only the first of the two was ever written down. A
// resumed run skips work it already did — that is documented at length. It also
// replays the result the OLD REVISION wrote into the code reading it NOW, and
// nothing sees that: the reader's static type is the new one, the value is the
// old one, and the boundary between them is JSON, so `tsc` is checking two ends
// of an interface that are a deploy apart.
//
// MOTIR-4652 replaced `resolve-target`'s `projectIds: string[]` with
// `anchorProjectId: string` and kept the id. A supervision resumed across that
// deploy, `JSON.stringify` dropped the absent field, and every code-graph
// refresh in the estate died at motir-ai's credential mint — each run writing a
// `succeeded` ledger row, because consuming a stale memo is not failing a step
// (MOTIR-5020). The window is a DEPLOY, and every deploy has one.
//
// Two remedies, and which one you may use is decided by the test below rather
// than by preference: a step that only READS may take a NEW ID, which makes the
// stale row unreadable; a step that PROVISIONS may not (a new `index-boot:` id
// bills a second container instead of re-attaching), so it keeps its id and
// NARROWS the replayed value where it is read —
// `requireCurrentIndexTarget` in `lib/services/codeGraphIndexService.ts`.
// `tests/jobs/step-result-shape-guard.test.ts` pins every step's result shape
// by id and fails on a shape that moves while its id does not.
//
// ⚠️ A STEP THAT THROWS IS NOT MEMOIZED. Persisting a failure would freeze a
// transient error permanently — the retry would "replay" the exception forever
// and the run could never recover. The `create` happens only after `fn` has
// resolved.
//
// ⚠️ A RETRY DOES NOT CLEAR THE STEP LEDGER. `jobStepRepository.deleteByRun`
// exists for teardown, not for retries: the steps a previous attempt completed
// are precisely the work a retry must NOT redo. That is the feature.
//
// ===========================================================================
// `step.sleep(id, ms)` — a durable yield, not an `await`
// ===========================================================================
// Persist a wake deadline, then throw `JobStepYield`, which the worker catches
// and turns into a re-enqueue with `run_at = deadline`. The run leaves memory
// entirely and resumes later.
//
// ⚠️ AN IN-PROCESS `await` WOULD BE SIMPLER AND WOULD WORK UNTIL THE FIRST
// DEPLOY. `ciRunnerFleet` and the hosted-agent run sleep in supervision loops that
// can run for half an hour; a sleeping supervisor held in memory vanishes when
// the worker restarts, leaving a container running with nothing watching it.
// Durability here is the requirement, not an optimisation.
//
// ⚠️ QUALIFIED (MOTIR-3482) — THE PARAGRAPH ABOVE IS RIGHT ABOUT THE
// REQUIREMENT AND WRONG ABOUT WHERE IT BINDS, so read the two together rather
// than the first alone. What must survive a restart is the SIDE EFFECT, not the
// WAIT. A supervisor that forgets it was sleeping and re-enters from the top is
// harmless — it re-attaches to the same container out of the memoized boot and
// carries on watching. A supervisor that forgets it BOOTED provisions a second
// billed container. So:
//
//   • `step.run` wraps every operation that PROVISIONS, CLAIMS or TEARS DOWN
//     something outside this process, plus any result later step ids are KEYED
//     by. The test is: IF THIS RAN A SECOND TIME, WHAT WOULD EXIST TWICE? A
//     container, a runner registration, a capacity slot, a usage row ⇒ keep the
//     step. A wait, a read, a counter, a verdict ⇒ plain `await`. If the answer
//     is not obvious, KEEP it: one `job_step` row is a bounded cost and a
//     duplicated external effect is not.
//   • A step id names the UNIT OF WORK, never a loop position — unchanged, and
//     more load-bearing afterwards, since far fewer ids carry far more.
//   • AND A RESTART FORGETS EVERYTHING YOU DROPPED, so no verdict may depend on
//     the ABSENCE of an in-memory observation. Re-derive it from the source, or
//     gate the verdict on positive evidence: after the collapse, "we have not
//     seen it start" is indistinguishable from "we have forgotten that we saw
//     it start".
//
// What makes the in-memory wait safe is the WORKER, not this file:
// `lib/jobs/engine/worker.ts` renews a 60 s lease every 20 s and states that a
// run longer than the lease is the normal case, and both
// `reclaimExpiredLeases` and `releaseClaims` REFUND the attempt — so a deploy
// mid-supervision costs a resume, never a retry budget. `docs/decisions/job-queue-foundation.md`
// §13 carries the rule, the rejected alternatives, and the per-call-site
// disposition for both supervision loops.
//
// On RESUME the sleep step's row already exists, so the shim compares its
// deadline against now: elapsed ⇒ return and let the handler continue past it;
// not yet ⇒ yield again. That second arm is what makes an early wake (a
// re-enqueue that races the clock, a lease reclaim) harmless rather than a
// silently-skipped wait.
//
// ===========================================================================
// EXPLICITLY NOT IMPLEMENTED: `waitForEvent`
// ===========================================================================
// It has ZERO real call sites. Verified on `origin/main@165f1485`: the only hit
// under `lib/` is a COMMENT inside `codeGraphRefresh.ts` quoting Inngest's
// documentation, and the three hits under `tests/` are Playwright's unrelated
// `page.waitForEvent`. Building it would be building for a consumer that does
// not exist; a later card that needs it adds it then, against a real caller.

/**
 * Thrown by `step.sleep` to hand control back to the worker. Not an error
 * condition — it is the durable-yield signal, and the worker MUST distinguish it
 * from a genuine failure: a yield re-enqueues the run at `resumeAt` and consumes
 * no attempt, while a failure consumes one.
 */
export class JobStepYield extends Error {
  readonly code = 'JOB_STEP_YIELD' as const;
  /** When the run becomes claimable again. */
  readonly resumeAt: Date;
  /** The `step.sleep` id that yielded — for the worker's log line, not for control flow. */
  readonly stepId: string;

  constructor(stepId: string, resumeAt: Date) {
    super(`Job run yielded at step "${stepId}" until ${resumeAt.toISOString()}`);
    this.name = 'JobStepYield';
    this.stepId = stepId;
    this.resumeAt = resumeAt;
  }
}

/** Narrow an unknown thrown value to the yield signal. Exported because the worker's catch is the only correct consumer. */
export function isJobStepYield(err: unknown): err is JobStepYield {
  return err instanceof JobStepYield;
}

/**
 * Thrown when a step's resolved value cannot cross the JSON boundary (a cycle, a
 * BigInt, a function).
 *
 * This is deliberately NOT the degrade-to-null that `defineJob` applies to a
 * RUN's ledger output. The two are different in kind: the ledger's `output` is
 * an operator convenience, and losing it costs a dashboard cell. A STEP's result
 * is a value the handler goes on to use, so degrading it to null would hand the
 * next line of the handler a null it never checks — and only on the replay path,
 * which is the worst possible place to discover it. Failing loudly at the step
 * that produced it names the offending step in the message.
 */
export class JobStepResultNotSerializableError extends Error {
  readonly code = 'JOB_STEP_RESULT_NOT_SERIALIZABLE' as const;
  constructor(stepId: string, cause: unknown) {
    super(
      `step.run("${stepId}") resolved a value that cannot be stored as JSON. ` +
        `A step's result crosses a JSON boundary on every replay, so it must be ` +
        `JSON-safe on the first execution too. Cause: ${String(cause)}`,
    );
    this.name = 'JobStepResultNotSerializableError';
  }
}

/** Identifies the run a step API is bound to. */
export interface JobStepScope {
  /** The `job_queue` row id — the `run_id` half of the memo key. */
  runId: string;
  /** Denormalised onto every step row so the tenancy predicate needs no join. */
  workspaceId: string | null;
}

/**
 * The subset of Inngest's step API our jobs use. Structurally what the 58
 * existing call sites call, and nothing more.
 */
export interface JobStepApi {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
  sleep(id: string, duration: number | string): Promise<void>;
}

/**
 * JSON round-trip, applied to what we RETURN as well as what we store (see the
 * header). `undefined` and `null` both store as SQL NULL and read back as
 * `null`; that too is Inngest's behaviour and not a simplification.
 */
function roundTrip<T>(stepId: string, value: T): T {
  if (value === undefined || value === null) return null as T;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (err) {
    throw new JobStepResultNotSerializableError(stepId, err);
  }
}

/**
 * Parse a sleep duration into milliseconds.
 *
 * Every call site in this tree passes a NUMBER of milliseconds, which is the
 * path that matters. The string form (`'30s'`, `'5m'`, `'1h'`) is accepted
 * because Inngest's own signature accepts it and a handler written against the
 * documented API must not break on the engine swap — the shim's job is to be
 * indistinguishable, including on inputs nothing currently sends.
 */
export function parseSleepMs(duration: number | string): number {
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`step.sleep: a duration must be a finite, non-negative number of ms`);
    }
    return Math.floor(duration);
  }
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(duration.trim());
  if (!m) {
    throw new Error(
      `step.sleep: unrecognised duration "${duration}" — pass milliseconds, or a string like "30s" / "5m" / "1h".`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.floor(n * factor);
}

/** True when a thrown value is Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Build the step API for ONE run.
 *
 * `now` is injectable so the sleep tests can drive the clock without waiting on
 * it — the production caller passes nothing.
 */
export function createStepApi(scope: JobStepScope, now: () => Date = () => new Date()): JobStepApi {
  const { runId, workspaceId } = scope;

  return {
    async run<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
      // 1. The memo lookup. Its own short transaction: the handler's own work
      //    must NOT run inside a transaction we hold open, both because it may
      //    open transactions of its own (Prisma cannot nest interactive ones)
      //    and because a step can take minutes.
      const memo = await withSystemContext((tx) =>
        jobStepRepository.findByRunAndStep(runId, id, tx),
      );
      if (memo && memo.kind === 'run') {
        // Already done. The handler never learns it was skipped.
        return memo.result as T;
      }

      // 2. Execute OUTSIDE any transaction of ours. A throw propagates
      //    un-memoized, so the retry re-executes this step.
      const result = await fn();
      const stored = roundTrip(id, result);

      // 3. Persist. A concurrent writer that got here first is not an error:
      //    the run is claimed by exactly one worker, but a lease reclaim can
      //    legitimately overlap the previous claimant's last moments. The
      //    winner's value is the one both must return, or the two would diverge.
      try {
        await withSystemContext((tx) =>
          jobStepRepository.create(
            {
              runId,
              stepId: id,
              kind: 'run',
              result: stored as Prisma.InputJsonValue,
              workspaceId,
            },
            tx,
          ),
        );
        return stored;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await withSystemContext((tx) =>
          jobStepRepository.findByRunAndStep(runId, id, tx),
        );
        return (winner?.result ?? null) as T;
      }
    },

    async sleep(id: string, duration: number | string): Promise<void> {
      const memo = await withSystemContext((tx) =>
        jobStepRepository.findByRunAndStep(runId, id, tx),
      );

      if (memo && memo.kind === 'sleep') {
        const deadline = memo.sleepUntil;
        // A sleep with no deadline is a corrupt row rather than an elapsed one;
        // treating it as elapsed would silently skip the wait.
        if (!deadline) {
          throw new Error(`job_step ${memo.id} is a sleep checkpoint with no sleep_until`);
        }
        if (deadline.getTime() <= now().getTime()) return; // elapsed — continue past it
        throw new JobStepYield(id, deadline); // woke early — yield again
      }

      const deadline = new Date(now().getTime() + parseSleepMs(duration));
      try {
        await withSystemContext((tx) =>
          jobStepRepository.create(
            { runId, stepId: id, kind: 'sleep', sleepUntil: deadline, workspaceId },
            tx,
          ),
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost the race to write the checkpoint; the winner's deadline governs.
        const winner = await withSystemContext((tx) =>
          jobStepRepository.findByRunAndStep(runId, id, tx),
        );
        const won = winner?.sleepUntil;
        if (won && won.getTime() <= now().getTime()) return;
        throw new JobStepYield(id, won ?? deadline);
      }
      throw new JobStepYield(id, deadline);
    },
  };
}
