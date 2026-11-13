import { describe, expect, it } from 'vitest';
import {
  changesSummary,
  EMPTY_CHANGES,
  expireHighlight,
  foldChanges,
  liveEdits,
  liveSlot,
  visitChangesLevel,
  type ChangesLog,
  type LiveEdit,
  type PendingArrival,
  type PendingChange,
} from '@/lib/planning/livePane';
import { planReviewItem } from '../helpers/planReview';

// THE CHANGED HIGHLIGHT (MOTIR-11185) — deriving "newly changed" cards from two
// successive live reads, and where the arrivals slot counts them.

const crumb = (levelId: string | null) => (levelId ? [{ id: levelId, label: levelId }] : []);

const e = (
  id: string,
  levelId: string | null,
  editedAt: string | null,
  over: Partial<LiveEdit> = {},
): LiveEdit => ({
  id,
  nodeId: id,
  levelId,
  trail: crumb(levelId),
  editedAt,
  highlightable: true,
  ...over,
});

const T1 = '2026-11-13T11:08:00.000Z';
const T2 = '2026-11-13T11:09:00.000Z';
const T3 = '2026-11-13T11:10:00.000Z';

const baseline = (next: readonly LiveEdit[], viewing: string | null): ChangesLog =>
  foldChanges(EMPTY_CHANGES, next, viewing);

describe('liveEdits — the plan’s cards as the change log reads them', () => {
  it('carries the edit time, the node and the level; a remove is never highlightable', () => {
    const items = [
      planReviewItem({ planItemId: 'p1', nodeId: 'p1', lastEditedAt: T1 }),
      planReviewItem({ planItemId: 'p2', nodeId: 'p2', parentNodeId: 'p1' }),
      planReviewItem({ planItemId: 'm1', nodeId: 'K-1', op: 'remove', lastEditedAt: T2 }),
    ];
    const out = liveEdits(items, 'Proposed');
    expect(out.map((x) => [x.id, x.nodeId, x.editedAt, x.highlightable])).toEqual([
      ['p1', 'p1', T1, true],
      ['p2', 'p2', null, true],
      ['m1', 'K-1', T2, false],
    ]);
    // Two cards on one level share the one trail it computed.
    expect(out[0]!.levelId).toBe(out[2]!.levelId);
    expect(out[0]!.trail).toBe(out[2]!.trail);
    expect(out[1]!.levelId).toBe('p1');
  });
});

describe('foldChanges — two reads, diffed by edit time', () => {
  it('the FIRST read is the baseline: edits that already exist highlight nothing', () => {
    const log = baseline([e('a', null, T1), e('b', 'L2', T2)], null);
    expect(log.highlights.size).toBe(0);
    expect(log.pending).toEqual([]);
  });

  it('a newer edit on the VIEWED level highlights its node; elsewhere it is pending', () => {
    let log = baseline([e('a', null, T1), e('b', 'L2', null)], null);
    log = foldChanges(log, [e('a', null, T2), e('b', 'L2', T2)], null);
    expect([...log.highlights.keys()]).toEqual(['a']);
    expect(log.pending.map((p) => [p.id, p.levelId])).toEqual([['b', 'L2']]);
  });

  it('the same edit time read again is not a change', () => {
    let log = baseline([e('a', null, T1)], null);
    log = foldChanges(log, [e('a', null, T1)], null);
    log = foldChanges(log, [e('a', null, null)], null);
    expect(log.highlights.size).toBe(0);
  });

  it('a card seen for the first time is an ARRIVAL, never a change', () => {
    let log = baseline([], null);
    log = foldChanges(log, [e('n', null, T1), e('m', 'L2', T1)], null);
    expect(log.highlights.size).toBe(0);
    expect(log.pending).toEqual([]);
    // …but its NEXT edit is one.
    log = foldChanges(log, [e('n', null, T2), e('m', 'L2', T1)], null);
    expect([...log.highlights.keys()]).toEqual(['n']);
  });

  it('two edits in quick succession RESTART one highlight rather than stacking', () => {
    let log = baseline([e('a', null, T1)], null);
    log = foldChanges(log, [e('a', null, T2)], null);
    const first = log.highlights.get('a')!;
    log = foldChanges(log, [e('a', null, T3)], null);
    expect(log.highlights.size).toBe(1);
    expect(log.highlights.get('a')).toBeGreaterThan(first);
    // The first highlight's timer then finds a newer one standing.
    expect(expireHighlight(log, 'a', first)).toBe(log);
    expect(expireHighlight(log, 'a', log.highlights.get('a')!).highlights.size).toBe(0);
  });

  it('a remove highlights nothing and stops counting', () => {
    let log = baseline([e('a', null, T1), e('b', 'L2', T1)], null);
    log = foldChanges(log, [e('a', null, T1), e('b', 'L2', T2)], null);
    expect(log.pending).toHaveLength(1);
    log = foldChanges(
      log,
      [e('a', null, T2, { highlightable: false }), e('b', 'L2', T2, { highlightable: false })],
      null,
    );
    expect(log.highlights.size).toBe(0);
    expect(log.pending).toEqual([]);
  });

  it('a pending change follows its card when it moves, and drops when it leaves', () => {
    let log = baseline([e('b', 'L2', T1), e('c', 'L3', T1)], null);
    log = foldChanges(log, [e('b', 'L2', T2), e('c', 'L3', T2)], null);
    log = foldChanges(log, [e('b', 'L4', T2)], null);
    expect(log.pending.map((p) => [p.id, p.levelId, p.trail[0]?.id])).toEqual([['b', 'L4', 'L4']]);
  });

  it('a highlight whose card left the plan is dropped', () => {
    let log = baseline([e('a', null, T1)], null);
    log = foldChanges(log, [e('a', null, T2)], null);
    log = foldChanges(log, [], null);
    expect(log.highlights.size).toBe(0);
  });

  it('a change re-read on the viewed level clears its pending entry', () => {
    let log = baseline([e('b', 'L2', T1)], null);
    log = foldChanges(log, [e('b', 'L2', T2)], null);
    log = foldChanges(log, [e('b', 'L2', T3)], 'L2');
    expect(log.pending).toEqual([]);
    expect([...log.highlights.keys()]).toEqual(['b']);
  });
});

describe('visitChangesLevel — Go there lands on the card lit', () => {
  it('lights the changes pending on the visited level, in change order', () => {
    let log = baseline([e('b', 'L2', T1), e('c', 'L2', T1), e('d', 'L3', T1)], null);
    log = foldChanges(log, [e('c', 'L2', T2), e('b', 'L2', T2), e('d', 'L3', T2)], null);
    const visited = visitChangesLevel(log, 'L2');
    expect(visited.viewing).toBe('L2');
    expect(visited.pending.map((p) => p.id)).toEqual(['d']);
    expect(visited.highlights.get('c')!).toBeLessThan(visited.highlights.get('b')!);
  });

  it('a level with nothing pending only records where the reader stands', () => {
    const log = baseline([e('a', null, T1)], null);
    const visited = visitChangesLevel(log, 'L9');
    expect(visited).toEqual({ ...log, viewing: 'L9' });
  });
});

describe('changesSummary', () => {
  const p = (id: string, levelId: string | null, seq: number): PendingChange => ({
    id,
    nodeId: id,
    levelId,
    trail: crumb(levelId),
    seq,
  });

  it('counts the changes, their levels and the latest', () => {
    const s = changesSummary([p('a', 'L1', 2), p('b', 'L2', 5), p('c', 'L1', 3)]);
    expect(s).toMatchObject({ count: 3, levels: 2, latest: { id: 'b' } });
  });

  it('a card still pending as an ARRIVAL is counted there only', () => {
    expect(changesSummary([p('a', 'L1', 1)], new Set(['a']))).toBeNull();
    expect(changesSummary([])).toBeNull();
  });
});

describe('liveSlot — changes counted separately from arrivals', () => {
  const arr = (levelId: string | null, count = 1, levels = 1) => ({
    count,
    levels,
    latest: { id: 'x', levelId, trail: crumb(levelId), seq: 1 } satisfies PendingArrival,
  });
  const chg = (levelId: string | null, count = 1, levels = 1) => ({
    count,
    levels,
    latest: { id: 'y', nodeId: 'y', levelId, trail: crumb(levelId), seq: 1 },
  });

  it('arrivals and changes on ONE level read as one sentence', () => {
    expect(liveSlot(arr('L1', 2), [], chg('L1', 3))).toMatchObject({
      key: 'newAndChangedIn',
      arrived: 2,
      changed: 3,
      trail: [{ id: 'L1' }],
    });
  });

  it('otherwise arrivals keep the slot', () => {
    expect(liveSlot(arr('L1'), [], chg('L2'))).toMatchObject({ key: 'arrivedIn' });
    expect(liveSlot(arr('L1', 2, 2), [], chg('L1'))).toMatchObject({ key: 'arrivedAcross' });
  });

  it('with no arrivals the changes take it, ahead of the in-flight state', () => {
    const drafting = [{ nodeId: 'q', kind: 'drafting' as const, trail: crumb('L5') }];
    expect(liveSlot(null, drafting, chg('L2', 2))).toMatchObject({
      key: 'changedIn',
      count: 2,
      trail: [{ id: 'L2' }],
    });
    expect(liveSlot(null, [], chg('L2', 3, 2))).toMatchObject({ key: 'changedAcross', count: 3 });
    expect(liveSlot(null, drafting, null)).toMatchObject({ key: 'draftingIn' });
  });
});
