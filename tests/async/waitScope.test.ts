import { describe, expect, it } from 'vitest';
import { awaitAsIdle, runObservingWaits, type WaitObserver } from '@/lib/async/waitScope';
import { createConcurrencyGate } from '@/lib/async/concurrencyGate';

// The wait scope MOTIR-10457 puts between the job worker and the CI-feedback gate:
// the runner is told when its work is only waiting, the code that waits says so,
// and neither imports the other.

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
