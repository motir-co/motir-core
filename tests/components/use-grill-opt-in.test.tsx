// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { GrillOptInSession } from '@/components/planning/useGrillOptIn';

// THE GRILL ME SWITCH, READ FROM THE SESSION (Story MOTIR-11799 · Subtask MOTIR-11801).
// The hook shows the session's STORED value, writes a change through the session's door
// (optimistic, sequence-guarded, falling back to the stored value on a refusal), and
// holds a choice made before the session existed — in `sessionStorage`, so a reload
// keeps it — until the first session adopts it. The door is mocked at its client.

const store = vi.hoisted(() => vi.fn());
vi.mock('@/lib/planning/planChangeClient', () => ({ setPlanChangeGrillMe: store }));

const { useGrillOptIn } = await import('@/components/planning/useGrillOptIn');

const PENDING_KEY = 'motir.grillMe.pending';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const render = (session: GrillOptInSession | null) =>
  renderHook(({ s }: { s: GrillOptInSession | null }) => useGrillOptIn(s), {
    initialProps: { s: session },
  });

beforeEach(() => {
  window.sessionStorage.clear();
  store.mockReset();
  store.mockImplementation(async (id: string, on: boolean) => ({ id, grillMe: on }));
});

afterEach(() => {
  cleanup();
});

describe('a session', () => {
  it("shows the session's stored value, so a reload or another tab shows it on", () => {
    expect(render({ id: 's1', grillMe: true }).result.current.on).toBe(true);
    expect(render({ id: 's1', grillMe: false }).result.current.on).toBe(false);
    // A hand-built thread with no value reads off.
    expect(render({ id: 's1' }).result.current.on).toBe(false);
  });

  it('turning it on stores it on the session and shows it at once', async () => {
    const view = render({ id: 's1', grillMe: false });
    await act(async () => {
      view.result.current.setOn(true);
    });
    expect(store).toHaveBeenCalledWith('s1', true);
    expect(view.result.current.on).toBe(true);
    // Nothing is kept in the browser once a session exists.
    expect(window.sessionStorage.length).toBe(0);
  });

  it('a refused write falls back to the stored value', async () => {
    store.mockRejectedValueOnce(new Error('403'));
    const view = render({ id: 's1', grillMe: false });
    await act(async () => {
      view.result.current.setOn(true);
    });
    expect(view.result.current.on).toBe(false);
  });

  it('only the latest of two quick changes is applied', async () => {
    const first = deferred<{ grillMe: boolean }>();
    const second = deferred<{ grillMe: boolean }>();
    store.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render({ id: 's1', grillMe: false });

    act(() => view.result.current.setOn(true));
    act(() => view.result.current.setOn(false));
    await act(async () => {
      second.resolve({ grillMe: false });
      await second.promise;
    });
    await act(async () => {
      first.resolve({ grillMe: true });
      await first.promise;
    });
    expect(view.result.current.on).toBe(false);

    // A stale refusal is ignored too.
    const third = deferred<{ grillMe: boolean }>();
    const fourth = deferred<{ grillMe: boolean }>();
    store.mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise);
    act(() => view.result.current.setOn(true));
    act(() => view.result.current.setOn(true));
    await act(async () => {
      fourth.resolve({ grillMe: true });
      third.reject(new Error('lost'));
      await fourth.promise;
      await third.promise.catch(() => {});
    });
    expect(view.result.current.on).toBe(true);
  });

  it("follows the session's value again once its read agrees, so another tab's change shows", async () => {
    const view = render({ id: 's1', grillMe: false });
    await act(async () => {
      view.result.current.setOn(true);
    });
    view.rerender({ s: { id: 's1', grillMe: true } });
    expect(view.result.current.on).toBe(true);
    // Another tab switched it off; this tab's next read says so.
    view.rerender({ s: { id: 's1', grillMe: false } });
    expect(view.result.current.on).toBe(false);
  });

  it('a different session shows its own value', async () => {
    const view = render({ id: 's1', grillMe: false });
    await act(async () => {
      view.result.current.setOn(true);
    });
    view.rerender({ s: { id: 's2', grillMe: false } });
    expect(view.result.current.on).toBe(false);
  });
});

describe('before the session exists', () => {
  it('holds the choice locally and writes nothing to the server', async () => {
    const view = render(null);
    expect(view.result.current.on).toBe(false);
    await act(async () => {
      view.result.current.setOn(true);
    });
    expect(view.result.current.on).toBe(true);
    expect(store).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBe('on');
    act(() => view.result.current.setOn(false));
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a reload of the tab keeps the choice', () => {
    window.sessionStorage.setItem(PENDING_KEY, 'on');
    expect(render(null).result.current.on).toBe(true);
  });

  it('the session the first message created, already on, is adopted with no second write', async () => {
    const view = render(null);
    act(() => view.result.current.setOn(true));
    await act(async () => {
      view.rerender({ s: { id: 's1', grillMe: true } });
    });
    expect(view.result.current.on).toBe(true);
    expect(store).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a first session that came back off is switched on, once', async () => {
    const view = render(null);
    act(() => view.result.current.setOn(true));
    await act(async () => {
      view.rerender({ s: { id: 's1', grillMe: false } });
    });
    expect(view.result.current.on).toBe(true);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith('s1', true);
    await act(async () => {
      view.rerender({ s: { id: 's1', grillMe: false } });
    });
    expect(store).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a first session with the switch left off stays off', async () => {
    const view = render(null);
    await act(async () => {
      view.rerender({ s: { id: 's1', grillMe: false } });
    });
    expect(view.result.current.on).toBe(false);
    expect(store).not.toHaveBeenCalled();
  });

  it('a rail closed before any session existed does not hand its choice on', () => {
    const view = render(null);
    act(() => view.result.current.setOn(true));
    view.unmount();
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(render(null).result.current.on).toBe(false);
  });

  it('storage that throws still gives a working switch', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const view = render(null);
      expect(view.result.current.on).toBe(false);
      act(() => view.result.current.setOn(true));
      expect(view.result.current.on).toBe(true);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
