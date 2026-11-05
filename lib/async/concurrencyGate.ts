import { awaitAsIdle, throwIfWithdrawn } from './waitScope';

/**
 * A FIFO limit on how many pieces of async work run at once in this module
 * instance. Work beyond the limit waits IN MEMORY — holding nothing — until a slot
 * frees, and slots are handed out in arrival order.
 *
 * WHY THIS EXISTS (MOTIR-6788). A path that opens database transactions and can be
 * entered many times at once will, at the moment it is entered N times, hold N pool
 * connections — whether or not those transactions are doing any work. A burst of
 * CI deliveries for one pull request is the measured case: every delivery queued
 * behind the same row locks INSIDE an open transaction, the pool (pg's default of
 * 10) filled with waiters, and every other route's transaction gave up after its
 * 2 s `maxWait` (P2028). Making that path queue here first, before it asks for a
 * connection, bounds what it can take from the pool to `limit`.
 *
 * It bounds connections only if each unit of work holds AT MOST ONE connection at a
 * time — a unit that opens transactions one after another. A unit that fans out
 * transactions in parallel takes up to its fan-out per slot, and the limit has to
 * be divided by that.
 *
 * The state is per module instance on purpose: a Next server builds one pg pool per
 * runtime (MOTIR-7073), and a gate that lives beside the code using a pool limits
 * exactly that pool.
 *
 * A unit waiting for a slot tells the enclosing wait scope it is idle
 * (`./waitScope.ts`), so a runner that counts its own busy work — the job worker's
 * pool — does not count a unit that is only standing in this line (MOTIR-10457).
 * A unit whose runner withdraws it leaves the line and is never started, and the
 * slot it would have taken goes to the next in line (MOTIR-10462).
 */
export interface ConcurrencyGate {
  /** Run `work` once a slot is free, releasing the slot when it settles. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Units running now. */
  readonly active: number;
  /** Units waiting for a slot. */
  readonly queued: number;
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`A concurrency gate needs a positive whole limit, got ${limit}`);
  }
  let active = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    // The slot is handed over by `release` — `active` is not decremented and
    // re-incremented in between, so no later arrival can take it out of turn.
    //
    // The wait is reported as IDLE to whoever runs this work (`./waitScope.ts`,
    // MOTIR-10457): a unit in this line holds nothing, and the job worker must
    // not count it against its pool while it stands here.
    //
    // A unit whose runner withdraws it while it waits (MOTIR-10462) LEAVES the
    // line: its turn is taken out of `waiting`, so `release` never hands a slot to
    // work that will not use it. Too late to leave — `release` has just handed it
    // the slot — it keeps the turn and `run` gives the slot straight back.
    let turn!: () => void;
    const admitted = new Promise<void>((resolve) => {
      turn = resolve;
      waiting.push(turn);
    });
    await awaitAsIdle(admitted, () => leaveLine(turn));
  }

  function leaveLine(turn: () => void): boolean {
    const at = waiting.indexOf(turn);
    /* v8 ignore next -- the race this guards needs a withdrawal queued as a
       microtask BEFORE `release` hands the turn over and run AFTER it, which no test
       can order; the slot it keeps is given back by `run`'s second
       `throwIfWithdrawn`, pinned by *gives the slot straight back* in
       `tests/async/waitScope.test.ts`. */
    if (at < 0) return false;
    waiting.splice(at, 1);
    return true;
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      // Withdrawn work never starts (MOTIR-10462): not at the door, and not once
      // admitted, whichever of the withdrawal and the admission came first.
      throwIfWithdrawn();
      await acquire();
      try {
        throwIfWithdrawn();
        return await work();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
  };
}
