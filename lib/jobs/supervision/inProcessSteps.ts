// AN IN-PROCESS STEP MEMO (Story MOTIR-3778 · Subtask MOTIR-3828) — what
// `job_step` is to a job-driven supervision, for a caller driving one to
// completion inside a single call.
//
// ===========================================================================
// Why it exists, stated as the bug it fixes rather than as a capability
// ===========================================================================
// A supervision is a state machine over RUNS now: each pass re-enters the
// handler FROM THE TOP, admits, boots, does ONE poll and defers. On the job path
// that costs nothing, because `index-admit:<pid>` and `index-boot:<pid>` are
// memoized `step.run`s and a later pass replays them out of `job_step`.
//
// **The run-to-completion wrapper crosses those passes inside ONE process, where
// there is no `job_step` to replay from.** With `INLINE_STEPS` — which executes
// and memoizes nothing, correctly, for a caller that runs a step once — every
// pass re-executed the admission and the boot. Measured before this module
// existed: a supervision that polled 500 times called
// the index admission (deleted with its fleet, MOTIR-12036) **502 times**, and would have
// provisioned a container per poll had the fake not been a fake.
//
// So the wrapper wraps whatever seam it was given in this memo. The relationship
// is exactly the one `inMemorySupervisionStore` has to the durable store: same
// contract, same guarantees, a setting with no database in it.
//
// ⚠️ A THROWN STEP IS NOT MEMOIZED, and that is the step shim's rule rather than
// a choice made here (`lib/jobs/engine/step.ts`: *"persisting a failure would
// freeze a transient error permanently"*). The entry is dropped on rejection, so
// a retry re-executes.
//
// ⚠️ ONE PER CALL, never a module-level singleton. Its lifetime is the one
// supervision it is driving; sharing one across calls would hand a second
// dispatch the first one's container handle.
//
// ===========================================================================
// AND THE LOOP THAT USES IT — {@link driveSupervisionInProcess}
// ===========================================================================
// The other half of the same stand-in: the worker's claim loop, in one process.
// It lives HERE rather than at the call site for a reason that is a lint rule
// rather than taste. `eslint.config`'s `JOB_ENGINE_RESTRICTION` confines
// `@/lib/jobs/engine/*` to `lib/jobs/**`, so a SERVICE may not import
// `isJobRunDefer` — and its own comment says why that boundary is stated over
// our module graph rather than a vendor's name: *"a boundary that can be walked
// around by importing one file over is a convention, not a guard."*
//
// Re-exporting the predicate from this folder would be exactly that walk. So the
// LOOP moves instead: a service hands over a thunk and gets an outcome, and the
// deferral signal never crosses the boundary at all.

import { isJobRunDefer } from '../engine/defer';

/** The subset of `ctx.step` a supervision composes against — structurally `SupervisionSteps`. */
export interface MemoizingSteps {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
}

/** Wrap a step seam so each id executes at most once for the life of this memo. */
export function inProcessMemoSteps(inner: MemoizingSteps): MemoizingSteps {
  const memo = new Map<string, Promise<unknown>>();
  return {
    run<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
      const hit = memo.get(id);
      if (hit) return hit as Promise<T>;
      const pending = (async () => inner.run(id, fn))();
      memo.set(id, pending);
      // Drop a REJECTED entry so a retry re-executes, and attach a handler so
      // the rejection is never an unhandled one on this branch — the caller's
      // own `await` is what actually receives it.
      pending.catch(() => memo.delete(id));
      return pending;
    },
  };
}

/**
 * Invoke `attempt`, and KEEP invoking it while it DEFERS — the worker's claim
 * loop, in one process.
 *
 * ⚠️ IT IS NOT A SECOND COMPOSITION. Every ordering, every transition and the
 * suspension invariant live in `advanceSupervision`; this turns each defer back
 * into a wait, which is what the queue does for a job-driven run. Two copies of
 * a supervision loop kept in agreement by hand is the defect MOTIR-3484 spent a
 * card deleting, and this is deliberately too small to become one.
 *
 * It waits the FULL interval the defer named, from the caller's own clock, so a
 * caller that shortens its cadence through the service's options seam gets a
 * fast loop and a caller that does not gets the shipped one.
 */
export async function driveSupervisionInProcess<T>(
  attempt: () => Promise<T>,
  clock: { sleep: (ms: number) => Promise<void>; now: () => Date },
): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (!isJobRunDefer(err)) throw err;
      await clock.sleep(Math.max(0, err.resumeAt.getTime() - clock.now().getTime()));
    }
  }
}
