// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useRunSetLevel } from '@/app/(authed)/runs/_components/useRunSetLevel';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';

// THE RUN SET'S SHARED READ, EVERY BRANCH DRIVEN BY THE TEST (MOTIR-10432).
//
// `useRunSetLevel` was covered only through the story gate
// (`tests/integration/runs/runOverlayParityGate.test.tsx`), which serves the read
// from real rows. There, whether the `if (live)` guard ever saw `live === false`
// depended on a read resolving AFTER its effect was torn down — a race the gate
// does not control. The lane's 100% branch floor on this file therefore went red
// at random (CI run 41962949765: 83.33% branches, every test green).
//
// So every branch here is reached by a HELD promise the test resolves itself:
// nothing below depends on timing. The transport (`fetchRoadmapLevel`) is the
// boundary replaced, exactly as `tests/components/RunCanvasPane.test.tsx` does;
// the hook under test is real.

interface Held {
  resolve: (data: RoadmapLevelData) => void;
  reject: (err: unknown) => void;
}

const held: Held[] = [];
const fetchRoadmapLevel = vi.fn();
vi.mock('@/lib/planning/roadmapClient', () => ({
  fetchRoadmapLevel: (...args: unknown[]) => fetchRoadmapLevel(...args),
}));

beforeEach(() => {
  held.length = 0;
  fetchRoadmapLevel.mockReset();
  fetchRoadmapLevel.mockImplementation(
    () =>
      new Promise<RoadmapLevelData>((resolve, reject) => {
        held.push({ resolve, reject });
      }),
  );
});
afterEach(cleanup);

type Cards = DispatchRunDto['cards'];

function cards(...ids: (string | null)[]): Cards {
  return ids.map((workItemId, position) => ({
    id: `leg_${position}`,
    key: `MOTIR-${position + 1}`,
    workItemId,
    position,
    disposition: 'running',
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    model: null,
  })) as Cards;
}

function level(...items: { id: string; title: string }[]): RoadmapLevelData {
  return {
    items: items.map((i) => ({
      ...i,
      parentId: null,
      identifier: i.id.toUpperCase(),
      kind: 'subtask',
      status: 'todo',
      statusLabel: 'To Do',
      statusCategory: 'todo',
      hasChildren: false,
    })) as RoadmapLevelData['items'],
    edges: [],
    offLevelBlockers: [],
  };
}

interface Props {
  cards: Cards;
  reloadKey: number;
}

function mount(initial: Props) {
  return renderHook((p: Props) => useRunSetLevel(p.cards, 'MOTIR', p.reloadKey), {
    initialProps: initial,
  });
}

/** Settle a held read inside an act scope, so its `.then` and the render it causes flush. */
async function settle(i: number, data: RoadmapLevelData) {
  await act(async () => {
    held[i]!.resolve(data);
  });
}

describe('useRunSetLevel', () => {
  it('reads nothing for a run with no resolvable member, and stays empty', () => {
    const { result } = mount({ cards: cards(null), reloadKey: 0 });

    expect(fetchRoadmapLevel).not.toHaveBeenCalled();
    expect(result.current.byId.size).toBe(0);
  });

  it('reads the members once, by id, and fills `byId` when the read lands while mounted', async () => {
    const { result } = mount({ cards: cards('wi_a', null, 'wi_b'), reloadKey: 0 });

    expect(fetchRoadmapLevel).toHaveBeenCalledTimes(1);
    expect(fetchRoadmapLevel).toHaveBeenCalledWith('MOTIR', null, 'project', undefined, false, [
      'wi_a',
      'wi_b',
    ]);
    expect(result.current.byId.size).toBe(0);

    await settle(0, level({ id: 'wi_a', title: 'A' }, { id: 'wi_b', title: 'B' }));

    expect([...result.current.byId.keys()]).toEqual(['wi_a', 'wi_b']);
    expect(result.current.byId.get('wi_b')?.title).toBe('B');
  });

  it('shares ONE read between callers until `reloadKey` moves', async () => {
    const { result, rerender } = mount({ cards: cards('wi_a'), reloadKey: 0 });
    const first = result.current.read();

    // The effect's own call and this one are the same memoised promise.
    expect(result.current.read()).toBe(first);
    expect(fetchRoadmapLevel).toHaveBeenCalledTimes(1);

    rerender({ cards: cards('wi_a'), reloadKey: 1 });

    expect(result.current.read()).not.toBe(first);
    expect(fetchRoadmapLevel).toHaveBeenCalledTimes(2);
  });

  it('drops a SUPERSEDED read that lands after the newer one', async () => {
    const { result, rerender } = mount({ cards: cards('wi_a'), reloadKey: 0 });

    // The dispositions move before the first read answers: a second read starts,
    // and the first effect is torn down (`live = false`).
    rerender({ cards: cards('wi_a'), reloadKey: 1 });
    expect(held).toHaveLength(2);

    await settle(1, level({ id: 'wi_a', title: 'fresh' }));
    expect(result.current.byId.get('wi_a')?.title).toBe('fresh');

    // The stale answer arrives last. Without the guard it would overwrite the
    // fresh one; with it, it is ignored.
    await settle(0, level({ id: 'wi_a', title: 'stale' }));
    expect(result.current.byId.get('wi_a')?.title).toBe('fresh');
  });

  it('writes nothing when the read lands after the component has unmounted', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = mount({ cards: cards('wi_a'), reloadKey: 0 });
    const before = result.current.byId;

    unmount();
    await settle(0, level({ id: 'wi_a', title: 'late' }));

    expect(result.current.byId).toBe(before);
    expect(result.current.byId.size).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('degrades to an empty `byId` when the read fails, without an unhandled rejection', async () => {
    const { result } = mount({ cards: cards('wi_a'), reloadKey: 0 });

    await act(async () => {
      held[0]!.reject(new Error('roadmap read failed'));
    });

    expect(result.current.byId.size).toBe(0);
  });
});
