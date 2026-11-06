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
 *
 * THE RUNNER CAN ALSO WITHDRAW THE WORK (MOTIR-10462). A run parked in a gate's
 * line still holds its claim, and the worker's drain releases every claim it holds
 * so another machine can take the row at once. A run released while it waits must
 * then leave the line rather than be admitted later and do the work a second
 * machine may already be doing. So the scope may carry an `AbortSignal`: aborted,
 * a wait inside it ends with {@link WaitWithdrawnError}, the waiter leaves its line,
 * and an admission refuses to start the work ({@link throwIfWithdrawn}).
 */
export interface WaitObserver {
  /** The work began waiting on an in-process admission: it holds nothing now. */
  onWaitStart(): void;
  /** The wait ended — admitted, or the wait failed — and the work is running again. */
  onWaitEnd(): void;
  /**
   * Aborted when the runner WITHDRAWS the work (MOTIR-10462): it no longer owns the
   * right to do it, so a wait inside the scope must end now rather than be
   * admitted, and no new wait may begin. The job worker aborts it when a drain
   * releases the run's claim, because another machine may claim the row at once.
   * Absent, the work is never withdrawn.
   */
  signal?: AbortSignal;
}

/**
 * Thrown out of a wait, or out of an admission, whose scope WITHDREW the work
 * (MOTIR-10462). It is not a failure of the work — the work never started — so
 * whoever records a failure must let it pass unrecorded ({@link isWaitWithdrawn}).
 */
export class WaitWithdrawnError extends Error {
  readonly withdrawn = true as const;
  constructor() {
    super('The work was withdrawn by its runner while it waited, and was not started');
    this.name = 'WaitWithdrawnError';
  }
}

/** True when a thrown value is a {@link WaitWithdrawnError}. */
export function isWaitWithdrawn(err: unknown): err is WaitWithdrawnError {
  return err instanceof WaitWithdrawnError;
}

/**
 * Throw {@link WaitWithdrawnError} if the enclosing scope has withdrawn its work.
 * An admission calls it at the door and again once admitted, so withdrawn work is
 * never started, however the withdrawal and the admission interleave.
 */
export function throwIfWithdrawn(): void {
  if (storage.getStore()?.signal?.aborted) throw new WaitWithdrawnError();
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
 *
 * If the scope withdraws the work while it waits (MOTIR-10462), `leave` is called
 * so the waiter can take itself out of whatever line it stands in, and the wait
 * rejects with {@link WaitWithdrawnError}. `leave` answers `false` when it is too
 * late — the waiter was admitted as the withdrawal came — and the wait then ends as
 * admitted; the admitting code's own {@link throwIfWithdrawn} turns it away. A wait
 * with no line to leave passes no `leave`, and is abandoned where it stands.
 */
export async function awaitAsIdle<T>(wait: Promise<T>, leave?: () => boolean): Promise<T> {
  const observer = storage.getStore();
  if (!observer) return wait;
  observer.onWaitStart();
  try {
    return await (observer.signal ? untilWithdrawn(wait, observer.signal, leave) : wait);
  } finally {
    observer.onWaitEnd();
  }
}

/** `wait`, unless `signal` aborts first and the waiter could leave its line. */
function untilWithdrawn<T>(
  wait: Promise<T>,
  signal: AbortSignal,
  leave: (() => boolean) | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onWithdraw = (): void => {
      // Admitted as the withdrawal came: keep the turn, so the slot it was handed
      // is given back by the code that admitted it rather than lost.
      if (leave && !leave()) return;
      reject(new WaitWithdrawnError());
    };
    if (signal.aborted) onWithdraw();
    else signal.addEventListener('abort', onWithdraw, { once: true });
    wait.then(
      (value) => {
        signal.removeEventListener('abort', onWithdraw);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onWithdraw);
        reject(err);
      },
    );
  });
}
