import { describe, expect, it } from 'vitest';
import {
  awaitAsIdle,
  isWaitWithdrawn,
  runObservingWaits,
  throwIfWithdrawn,
  WaitWithdrawnError,
  type WaitObserver,
} from '@/lib/async/waitScope';
import { createConcurrencyGate } from '@/lib/async/concurrencyGate';

// The wait scope MOTIR-10457 puts between the job worker and the CI-feedback gate:
// the runner is told when its work is only waiting, the code that waits says so,
// and neither imports the other. MOTIR-10462 adds the other direction: the runner
// can WITHDRAW the work, and a withdrawn wait leaves its line and never starts.

function recorder(): WaitObserver & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    onWaitStart: () => events.push('start'),
    onWaitEnd: () => events.push('end'),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('awaitAsIdle', () => {
  it('is a plain await outside any scope', async () => {
    await expect(awaitAsIdle(Promise.resolve(7))).resolves.toBe(7);
  });

  it('reports the start and the end of the wait to the enclosing observer', async () => {
    const observer = recorder();
    const wait = deferred<string>();
    const run = runObservingWaits(observer, async () => {
      const value = await awaitAsIdle(wait.promise);
      observer.events.push(`after:${value}`);
      return value;
    });
    await flush();
    expect(observer.events).toEqual(['start']);
    wait.resolve('ok');
    await expect(run).resolves.toBe('ok');
    expect(observer.events).toEqual(['start', 'end', 'after:ok']);
  });

  it('reports the end when the wait rejects, and passes the error through', async () => {
    const observer = recorder();
    const wait = deferred();
    const run = runObservingWaits(observer, () => awaitAsIdle(wait.promise));
    await flush();
    wait.reject(new Error('gone'));
    await expect(run).rejects.toThrow('gone');
    expect(observer.events).toEqual(['start', 'end']);
  });

  it('follows the async call chain, and the innermost scope is the one told', async () => {
    const outer = recorder();
    const inner = recorder();
    await runObservingWaits(outer, async () => {
      await new Promise((r) => setTimeout(r, 0)); // the scope survives a macrotask
      await awaitAsIdle(Promise.resolve());
      await runObservingWaits(inner, () => awaitAsIdle(Promise.resolve()));
    });
    expect(outer.events).toEqual(['start', 'end']);
    expect(inner.events).toEqual(['start', 'end']);
  });

  it('keeps concurrent scopes apart', async () => {
    const a = recorder();
    const b = recorder();
    const waitA = deferred();
    const runA = runObservingWaits(a, () => awaitAsIdle(waitA.promise));
    const runB = runObservingWaits(b, async () => 'b ran');
    await expect(runB).resolves.toBe('b ran');
    expect(b.events).toEqual([]);
    expect(a.events).toEqual(['start']);
    waitA.resolve();
    await runA;
    expect(a.events).toEqual(['start', 'end']);
  });
});

describe('the concurrency gate reports its line as idle', () => {
  it('a unit that gets a slot at once reports nothing', async () => {
    const gate = createConcurrencyGate(1);
    const observer = recorder();
    await runObservingWaits(observer, () => gate.run(async () => 'in'));
    expect(observer.events).toEqual([]);
  });

  it('a unit that queues is idle until its slot is handed over, and busy inside it', async () => {
    const gate = createConcurrencyGate(1);
    const first = deferred();
    const holder = gate.run(() => first.promise);
    const observer = recorder();
    const queued = runObservingWaits(observer, () =>
      gate.run(async () => {
        observer.events.push('inside');
      }),
    );
    await flush();
    expect(observer.events).toEqual(['start']);
    expect(gate.queued).toBe(1);
    first.resolve();
    await Promise.all([holder, queued]);
    expect(observer.events).toEqual(['start', 'end', 'inside']);
  });
});

/** A recorder whose scope can be withdrawn. */
function withdrawable(): WaitObserver & { events: string[]; withdraw: () => void } {
  const controller = new AbortController();
  return { ...recorder(), signal: controller.signal, withdraw: () => controller.abort() };
}

describe('withdrawing the work (MOTIR-10462)', () => {
  it('ends a wait with WaitWithdrawnError, after asking the waiter to leave its line', async () => {
    const observer = withdrawable();
    const wait = deferred<string>();
    const left: string[] = [];
    const run = runObservingWaits(observer, () =>
      awaitAsIdle(wait.promise, () => {
        left.push('left');
        return true;
      }),
    );
    await flush();
    observer.withdraw();
    await expect(run).rejects.toBeInstanceOf(WaitWithdrawnError);
    expect(left).toEqual(['left']);
    expect(observer.events).toEqual(['start', 'end']);
    wait.resolve('too late'); // the abandoned wait settling later changes nothing
  });

  it('abandons a wait with no line to leave', async () => {
    const observer = withdrawable();
    const run = runObservingWaits(observer, () => awaitAsIdle(new Promise(() => {})));
    await flush();
    observer.withdraw();
    await expect(run).rejects.toSatisfy(isWaitWithdrawn);
  });

  it('refuses a wait that begins after the withdrawal', async () => {
    const observer = withdrawable();
    observer.withdraw();
    let left = false;
    await expect(
      runObservingWaits(observer, () =>
        awaitAsIdle(new Promise(() => {}), () => {
          left = true;
          return true;
        }),
      ),
    ).rejects.toBeInstanceOf(WaitWithdrawnError);
    expect(left).toBe(true);
  });

  it('keeps a turn the waiter could not leave — it was admitted as the withdrawal came', async () => {
    const observer = withdrawable();
    const wait = deferred<string>();
    const run = runObservingWaits(observer, () => awaitAsIdle(wait.promise, () => false));
    await flush();
    observer.withdraw();
    wait.resolve('admitted');
    await expect(run).resolves.toBe('admitted');
  });

  it('passes the value and the error of an unwithdrawn wait through', async () => {
    const observer = withdrawable();
    await expect(
      runObservingWaits(observer, () => awaitAsIdle(Promise.resolve('ok'))),
    ).resolves.toBe('ok');
    await expect(
      runObservingWaits(observer, () => awaitAsIdle(Promise.reject(new Error('gone')))),
    ).rejects.toThrow('gone');
    // A withdrawal after both waits ended reaches neither.
    observer.withdraw();
    expect(observer.events).toEqual(['start', 'end', 'start', 'end']);
  });

  it('throwIfWithdrawn throws only inside a withdrawn scope', async () => {
    expect(() => throwIfWithdrawn()).not.toThrow();
    const observer = withdrawable();
    await runObservingWaits(observer, async () => {
      expect(() => throwIfWithdrawn()).not.toThrow();
    });
    observer.withdraw();
    await runObservingWaits(observer, async () => {
      expect(() => throwIfWithdrawn()).toThrow(WaitWithdrawnError);
    });
    expect(isWaitWithdrawn(new Error('other'))).toBe(false);
  });
});

describe('the concurrency gate honours a withdrawal (MOTIR-10462)', () => {
  it('a withdrawn unit leaves the line, never runs, and its slot goes to the next', async () => {
    const gate = createConcurrencyGate(1);
    const holderDone = deferred();
    const holder = gate.run(() => holderDone.promise);
    const observer = withdrawable();
    let ran = false;
    const withdrawn = runObservingWaits(observer, () =>
      gate.run(async () => {
        ran = true;
      }),
    );
    const next = gate.run(async () => 'next ran');
    await flush();
    expect(gate.queued).toBe(2);

    observer.withdraw();
    await expect(withdrawn).rejects.toBeInstanceOf(WaitWithdrawnError);
    expect(gate.queued).toBe(1);

    holderDone.resolve();
    await holder;
    await expect(next).resolves.toBe('next ran');
    expect(ran).toBe(false);
    expect(gate.active).toBe(0);
  });

  it('refuses withdrawn work at the door, even with a slot free', async () => {
    const gate = createConcurrencyGate(1);
    const observer = withdrawable();
    observer.withdraw();
    let ran = false;
    await expect(
      runObservingWaits(observer, () =>
        gate.run(async () => {
          ran = true;
        }),
      ),
    ).rejects.toBeInstanceOf(WaitWithdrawnError);
    expect(ran).toBe(false);
    expect(gate.active).toBe(0);
  });

  it('gives the slot straight back when the withdrawal lands as the unit is admitted', async () => {
    // `onWaitEnd` runs after the turn was handed over and before the work starts —
    // exactly the window a withdrawal can land in once the unit has its slot.
    const gate = createConcurrencyGate(1);
    const holderDone = deferred();
    const holder = gate.run(() => holderDone.promise);
    const controller = new AbortController();
    let ran = false;
    const admitted = runObservingWaits(
      { onWaitStart: () => {}, onWaitEnd: () => controller.abort(), signal: controller.signal },
      () =>
        gate.run(async () => {
          ran = true;
        }),
    );
    await flush();
    holderDone.resolve();
    await holder;
    await expect(admitted).rejects.toBeInstanceOf(WaitWithdrawnError);
    expect(ran).toBe(false);
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'free')).resolves.toBe('free');
  });
});
