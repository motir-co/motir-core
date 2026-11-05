import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * WHO IS TOLD THAT A PIECE OF WORK IS WAITING, AND NOT WORKING (MOTIR-10457).
 *
 * A unit of work that queues in memory for an in-process admission limit (a
 * {@link import('./concurrencyGate').ConcurrencyGate}) holds nothing while it
 * waits: no connection, no lock, no CPU. Whoever RUNS that work may still be
 * counting it as busy. The job worker is the case that made this file: every
 * GitHub delivery is a `system.github-webhook-delivery` run, the CI ones wait on
 * the three-slot CI-feedback gate, and a run waiting there used to occupy one of
 * the worker's ten pool slots for the whole wait. A burst of check deliveries
 * then left seven runs parked in the gate's line holding seven slots, and
 * `email.send`, the scheduler's fires and the supervisors queued behind the
 * backlog.
 *
 * So the runner says, once, around the work it starts: "tell me when this is only
 * waiting" ({@link runObservingWaits}); and the code that waits says, around its
 * wait: "this is only waiting" ({@link awaitAsIdle}). The two never import each
 * other. The scope travels with the async call chain (`AsyncLocalStorage`), the
 * same mechanism `lib/monitoring/requestLabel.ts` uses for a request's label, so
 * the gate needs no parameter threaded through the services between the runner
 * and the wait.
 *
 * Outside any scope (a route handler, a script, a test calling the service
 * directly) {@link awaitAsIdle} is a plain `await`.
 */
export interface WaitObserver {
  /** The work began waiting on an in-process admission: it holds nothing now. */
  onWaitStart(): void;
  /** The wait ended — admitted, or the wait failed — and the work is running again. */
  onWaitEnd(): void;
}

const storage = new AsyncLocalStorage<WaitObserver>();

/**
 * Run `work` with `observer` told about every {@link awaitAsIdle} inside it. A
 * nested scope replaces the outer one for its own extent: the innermost runner is
 * the one that is counting.
 */
export function runObservingWaits<T>(observer: WaitObserver, work: () => Promise<T>): Promise<T> {
  return storage.run(observer, work);
}

/**
 * Await `wait`, reporting the wait to the enclosing scope's observer if there is
 * one. `onWaitEnd` runs however the wait ends, so an observer can never be left
 * believing the work is still idle.
 */
export async function awaitAsIdle<T>(wait: Promise<T>): Promise<T> {
  const observer = storage.getStore();
  if (!observer) return wait;
  observer.onWaitStart();
  try {
    return await wait;
  } finally {
    observer.onWaitEnd();
  }
}
