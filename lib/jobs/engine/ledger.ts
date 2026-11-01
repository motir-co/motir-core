import type { JobQueueRun, Prisma } from '@/generated/prisma/client';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { alertTerminalJobFailure } from '@/lib/monitoring/jobFailureAlert';
import { engineJob } from './registry';
import { buildEngineContext, UnknownEngineJobError } from './runner';
import { jobServices } from '../services';

// LEDGER + DLQ PARITY (Story MOTIR-3414 · Subtask MOTIR-3424) — the engine
// writes the same `job_run` and `job_run_dlq` rows the Inngest wrapper writes,
// so the operator ledger (staff-only at `/admin/jobs` since Story MOTIR-9982)
// reads engine runs with NO change to the service behind it or its DTOs.
//
// Nothing in this file is new bookkeeping. It reuses `jobRunsService` verbatim —
// `recordStart` / `recordSuccess` / `recordTerminalFailure` — which is the point:
// parity you get by CALLING the same code cannot drift from parity you get by
// reimplementing it.
//
// ===========================================================================
// EXACTLY ONE `job_run` ROW PER RUN, and the trick that guarantees it
// ===========================================================================
// The ledger writes go inside `step.run(...)`, so they are MEMOIZED. A run that
// yields at a `step.sleep` and resumes an hour later re-enters the handler from
// the top, finds `job-run:start` already recorded, and does not write a second
// row. Exactly the mechanism the Inngest wrapper uses, over our own step table.
//
// It also survives a RETRY. `job-run:start`'s memo is keyed on `(run_id,
// step_id)` and a retry is the same `job_queue` row, so a job that fails twice
// and succeeds on the third attempt has ONE ledger row whose `attempt` records
// where it started — not three rows, which is what a naive per-attempt insert
// would produce and what would make the dashboard unreadable.
//
// ⚠️ AND IT SURVIVES A DEFER FOR THE SAME REASON, WHICH IS A FINDING RATHER
// THAN AN OMISSION (MOTIR-3825). A `JobRunDefer` (`./defer.ts`) is a THROW, so
// `executeWithLedger` never reaches `job-run:succeeded` on a deferred pass —
// which is exactly right, because the run is not finished. The next pass
// re-enters from the top, finds `job-run:start` already memoized on
// `(run_id, step_id)`, and writes no second row. So a supervision that defers a
// hundred times and settles on the hundred-and-first leaves ONE `job_run` row,
// `succeeded`, carrying the last pass's output, and nothing in the dead-letter
// queue — the shape `docs/decisions/code-graph-index-fleet.md` §6 requires and
// `docs/decisions/job-queue-foundation.md` §16.1 relies on.
//
// **This file therefore needs no defer arm, and adding one would be a
// regression.** A `catch (err) { if (isJobRunDefer(err)) … }` here could only
// either re-throw (a no-op) or swallow (which would mark a suspended run
// succeeded and, on `system.code-graph-index`, tell every downstream reader that
// a repo has a code graph nothing built). `tests/jobs/engine-defer.test.ts`
// asserts the row counts over three passes rather than leaving them inferred
// from that reasoning.
//
// ===========================================================================
// ⚠️ WHY THE TERMINAL FAILURE IS NOT WRITTEN FROM A `catch` — READ THIS BEFORE
// SIMPLIFYING IT
// ===========================================================================
// The Inngest implementation moved the dead-letter write OUT of a try/catch and
// into Inngest's `onFailure` hook for a specific, non-obvious reason
// (PRODECT_FINDINGS #39): on the real executor, **a `step.run` scheduled from a
// catch block AFTER the terminally-failing step never executes** — the executor
// finalizes the run as failed first. So the failed/DLQ rows silently never got
// written in production, while the in-process unit harness ran the catch
// synchronously and made it look like they did. A bug visible only in production,
// with green tests.
//
// **On this engine the equivalent hook is the WORKER'S SETTLE PATH**
// (`lib/jobs/engine/worker.ts`), and it is reliable for a DIFFERENT structural
// reason worth stating rather than assuming: it is not a step at all. It is plain
// code in the claim loop, running in the worker process after the handler's
// promise rejects, outside any step machinery that could decline to schedule it.
// There is no executor between the throw and the write.
//
// **So do not "simplify" this back into a `try/catch` around the handler inside
// `executeWithLedger`.** It would appear to work — the tests here run in-process,
// exactly as the harness that hid the original bug did — and it would reintroduce
// a defect whose whole signature is that it does not reproduce where you are
// looking. The write belongs to the loop that knows the attempt budget is spent,
// and `recordEngineTerminalFailure` is that hook's body.

/**
 * The ledger's identifiers for one queued run.
 *
 * `eventId` mirrors `defineJob`'s own derivation exactly — the triggering event's
 * id, falling back to the run id when there is none (a cron run, a harness
 * event). It has to match, because `recordTerminalFailure` CORRELATES the failure
 * back to the `running` row by `(functionId, eventId)`: derive it differently on
 * the two paths and the failure writes a second row instead of flipping the
 * first.
 *
 * ⚠️ THAT SENTENCE DESCRIBED A REAL DEFECT ON THE OTHER LANE, not a hypothetical
 * one (Bug MOTIR-3683). Inngest derived it twice, in two functions, and the two
 * disagreed on cron runs — 29 stranded `running` rows and 30 failure rows keyed
 * on `''`. THIS lane is structurally safe for a reason worth naming: the value is
 * computed ONCE, here, from the `JobQueueRun` row, and both the start path and
 * the terminal-failure path call this same function on that same row. There is no
 * second derivation to drift. Keep it that way — a caller that computes its own
 * `eventId` re-opens the bug.
 */
export function ledgerIdentity(run: JobQueueRun): {
  functionId: string;
  eventId: string;
  eventName: string;
  workspaceId: string | null;
} {
  return {
    functionId: run.jobId,
    // `||`, not `??` (Bug MOTIR-3683). The nullish test asks whether the column
    // is set; the question here is whether there is an ID, and an empty string is
    // not one. On the Inngest lane that exact distinction stranded 29 runs at
    // `running` and wrote 30 unattributable failure rows. This lane derives the
    // value ONCE per run and both paths call this function, so it cannot diverge
    // the way that one did — but a `''` would still key the correlation on a
    // value every other run of the same job also carries.
    eventId: run.eventId || run.id,
    eventName: run.eventName,
    workspaceId: run.workspaceId,
  };
}

/**
 * Execute one claimed run WITH the ledger around it.
 *
 * Throws whatever the handler throws — `JobStepYield` and `JobRunDefer`
 * included. Deciding what a throw MEANS is the worker's job; swallowing it here
 * would make a failed run look successful, and swallowing a suspension would
 * make an unfinished one look finished.
 */
export async function executeWithLedger(run: JobQueueRun, eventData: unknown): Promise<unknown> {
  const def = engineJob(run.jobId);
  if (!def) throw new UnknownEngineJobError(run.jobId);

  const ctx = buildEngineContext(run, eventData);
  const identity = ledgerIdentity(run);

  // Memoized: exactly once per run, across every retry and every resume.
  const jobRun = await ctx.step.run('job-run:start', () =>
    jobRunsService.recordStart({
      workspaceId: identity.workspaceId,
      functionId: identity.functionId,
      eventName: identity.eventName,
      eventId: identity.eventId,
      // The lane, DECLARED (MOTIR-3683). It reads `engine` unconditionally now
      // that there is one — the column and its `inngest` member survive because
      // rows written before MOTIR-3418 legitimately carry it, and a historical
      // fact is not a fact to rewrite.
      lane: 'engine',
      attempt: ctx.attempt,
      idempotencyKey: (eventData as { idempotencyKey?: string } | null)?.idempotencyKey ?? null,
    }),
  );

  const result = await def.handler(ctx, jobServices);

  // `recordStart` returns null when the run's tenant vanished before the row
  // could be written (MOTIR-1545) — there is no row to flip, so skip the success
  // bookkeeping rather than dereference a null id. Same guard as `defineJob`.
  if (jobRun) {
    await ctx.step.run('job-run:succeeded', () =>
      jobRunsService.recordSuccess(jobRun.id, serializeOutput(result)),
    );
  }
  return result;
}

/**
 * THE AFTER-ALL-RETRIES-EXHAUSTED HOOK — the engine's `onFailure`.
 *
 * Writes the `failed` ledger row AND the dead-letter row, in one transaction,
 * by calling `jobRunsService.recordTerminalFailure`. Invoked by the worker's settle path when `attempts >= maxAttempts`, and
 * from nowhere else — see the header for why it is not a `catch`.
 */
export async function recordEngineTerminalFailure(
  run: JobQueueRun,
  error: unknown,
  eventData: unknown,
): Promise<void> {
  const identity = ledgerIdentity(run);
  // ⚠️ THE ALERT FIRES BEFORE THE WRITE, AND THAT ORDER IS DELIBERATE
  // (MOTIR-3606). It is synchronous, best-effort and cannot throw, so it costs
  // the write nothing — and putting it first means a ledger write that ITSELF
  // fails (a vanished tenant, a database that has gone away) still produces the
  // signal. The row is the record; the alert is the only thing that reaches a
  // person, so it must not be the half that goes missing when the database is
  // the problem.
  alertTerminalJobFailure({
    functionId: identity.functionId,
    eventName: identity.eventName,
    workspaceId: identity.workspaceId,
    attempts: run.attempts,
    engine: 'engine',
    error,
  });
  await jobRunsService.recordTerminalFailure({
    functionId: identity.functionId,
    eventId: identity.eventId,
    lane: 'engine',
    eventName: identity.eventName,
    workspaceId: identity.workspaceId,
    failure: serializeFailure(error),
    // The DLQ row stores the ORIGINAL event payload so a replay can re-emit it.
    eventData: (eventData ?? {}) as Prisma.InputJsonValue,
    // Total attempts including the first — `job_queue.attempts` already counts
    // that way, unlike a `retries` option, which counts the additional ones.
    attempts: run.attempts,
  });
}

/** Serialize an unknown thrown value into the ledger's failure shape. */
function serializeFailure(err: unknown): { message: string; stack?: string; code?: string } {
  if (err instanceof Error) {
    const failure: { message: string; stack?: string; code?: string } = { message: err.message };
    if (err.stack) failure.stack = err.stack;
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === 'string') failure.code = maybeCode;
    return failure;
  }
  return { message: String(err) };
}

/**
 * JSON-roundtrip a handler result for the ledger's `output` column.
 *
 * ⚠️ DEGRADES TO `undefined` (a NULL column) rather than failing the run, which
 * is deliberately the OPPOSITE of what the step shim does with a non-serializable
 * STEP result — and the two are different in kind. The ledger's `output` is an
 * operator convenience, so losing it costs a dashboard cell; a step's result is a
 * value the handler goes on to use, so losing it hands the next line a null it
 * never checks. Same behaviour as `defineJob`'s `serializeOutput`, which is what
 * parity requires here.
 */
function serializeOutput(result: unknown): Prisma.InputJsonValue | undefined {
  if (result === undefined || result === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}
