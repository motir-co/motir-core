import { describe, expect, it } from 'vitest';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneDto,
} from '@/lib/dto/boards';
import {
  bucketLanes,
  cellId,
  cellOfOverId,
  laneKeyOfCard,
  moveCardToColumn,
  parseCellId,
  reassignPatchForLane,
  relocateCardToCell,
  resolveCellMove,
  resolveSwimlaneDrop,
  setCardSwimlaneKey,
} from '@/app/(authed)/boards/_components/boardSwimlanes';

// Pure swimlane reducers (Subtask 3.3.5) — the bucketing + cross-lane move core,
// tested in isolation (columns-in, columns-out; no DOM, no dnd-kit) per the AC's
// "lane render + bucketing + catch-all" and "cross-lane reassign reducer (incl.
// diagonal + independent revert)".

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'todo',
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
    ...over,
  };
}

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

function lane(over: Partial<BoardSwimlaneDto> & { key: string }): BoardSwimlaneDto {
  return { label: over.key, kind: 'assignee', count: 0, ...over };
}

const ids = (cards: BoardCardDto[]) => cards.map((c) => c.id);

describe('laneKeyOfCard + cell id helpers', () => {
  it('falls back to the catch-all key when a card has no swimlaneKey', () => {
    expect(laneKeyOfCard(card({ id: 'w1', key: 1 }))).toBe(BOARD_SWIMLANE_NO_VALUE);
    expect(laneKeyOfCard(card({ id: 'w1', key: 1, swimlaneKey: 'u1' }))).toBe('u1');
  });

  it('round-trips a (column, lane) cell id and rejects a plain id', () => {
    const id = cellId('c1', 'u1');
    expect(parseCellId(id)).toEqual({ columnId: 'c1', laneKey: 'u1' });
    expect(parseCellId('justacardid')).toBeNull();
  });

  it('cellOfOverId resolves a cell id, a card id, and rejects an unknown id', () => {
    const cols = [
      column({ id: 'c1', name: 'To Do', cards: [card({ id: 'w1', key: 1, swimlaneKey: 'u1' })] }),
    ];
    expect(cellOfOverId(cols, cellId('c2', 'u2'))).toEqual({ columnId: 'c2', laneKey: 'u2' });
    expect(cellOfOverId(cols, 'w1')).toEqual({ columnId: 'c1', laneKey: 'u1' });
    expect(cellOfOverId(cols, 'nope')).toBeNull();
  });
});

describe('bucketLanes', () => {
  const cols = [
    column({
      id: 'c1',
      name: 'To Do',
      cards: [
        card({ id: 'w1', key: 1, swimlaneKey: 'u1' }),
        card({ id: 'w2', key: 2, swimlaneKey: 'u2' }),
        card({ id: 'w3', key: 3 }), // no key → catch-all
      ],
    }),
    column({ id: 'c2', name: 'Done', cards: [card({ id: 'w4', key: 4, swimlaneKey: 'u1' })] }),
  ];
  // Projection order already sorts the catch-all LAST.
  const swimlanes = [
    lane({ key: 'u1', label: 'Ana', count: 2 }),
    lane({ key: 'u2', label: 'Bea', count: 1 }),
    lane({ key: BOARD_SWIMLANE_NO_VALUE, label: 'No assignee', count: 1 }),
  ];

  it('buckets each column’s cards into the projection’s lanes, catch-all last', () => {
    const lanes = bucketLanes(cols, swimlanes);
    expect(lanes.map((l) => l.lane.key)).toEqual(['u1', 'u2', BOARD_SWIMLANE_NO_VALUE]);
    expect(ids(lanes[0]!.cellsByColumnId.get('c1')!)).toEqual(['w1']);
    expect(ids(lanes[0]!.cellsByColumnId.get('c2')!)).toEqual(['w4']);
    expect(ids(lanes[1]!.cellsByColumnId.get('c1')!)).toEqual(['w2']);
    // The keyless card lands in the catch-all lane.
    expect(ids(lanes[2]!.cellsByColumnId.get('c1')!)).toEqual(['w3']);
    expect(lanes[2]!.cellsByColumnId.get('c2')).toEqual([]);
  });

  it('drops a card whose swimlaneKey matches no lane (mid-reconcile) without crashing', () => {
    const orphan = [
      column({ id: 'c1', name: 'To Do', cards: [card({ id: 'wX', key: 9, swimlaneKey: 'gone' })] }),
    ];
    const lanes = bucketLanes(orphan, [lane({ key: 'u1', label: 'Ana', count: 0 })]);
    expect(ids(lanes[0]!.cellsByColumnId.get('c1')!)).toEqual([]);
  });
});

describe('relocateCardToCell', () => {
  const cols = [
    column({ id: 'c1', name: 'To Do', cards: [card({ id: 'w1', key: 1, swimlaneKey: 'u1' })] }),
    column({
      id: 'c2',
      name: 'Done',
      cards: [
        card({ id: 'w2', key: 2, swimlaneKey: 'u2' }),
        card({ id: 'w3', key: 3, swimlaneKey: 'u2' }),
      ],
    }),
  ];

  it('moves the card to the target column and stamps its swimlaneKey (append)', () => {
    const next = relocateCardToCell(cols, 'w1', 'c2', 'u2', null);
    const c1 = next.find((c) => c.id === 'c1')!;
    const c2 = next.find((c) => c.id === 'c2')!;
    expect(c1.cards).toEqual([]);
    expect(ids(c2.cards)).toEqual(['w2', 'w3', 'w1']);
    expect(c2.cards.find((c) => c.id === 'w1')!.swimlaneKey).toBe('u2');
  });

  it('inserts before the hovered card when an overCardId is given', () => {
    const next = relocateCardToCell(cols, 'w1', 'c2', 'u2', 'w3');
    const c2 = next.find((c) => c.id === 'c2')!;
    expect(ids(c2.cards)).toEqual(['w2', 'w1', 'w3']);
  });

  it('is a no-op shape when the card or target column is missing', () => {
    expect(relocateCardToCell(cols, 'ghost', 'c2', 'u2', null)).toBe(cols);
    expect(relocateCardToCell(cols, 'w1', 'cZ', 'u2', null)).toBe(cols);
  });
});

describe('independent-revert reducers', () => {
  const cols = [
    column({ id: 'c1', name: 'To Do', cards: [card({ id: 'w1', key: 1, swimlaneKey: 'u2' })] }),
    column({ id: 'c2', name: 'Done', cards: [] }),
  ];

  it('setCardSwimlaneKey restores only the lane (no column move)', () => {
    const next = setCardSwimlaneKey(cols, 'w1', 'u1');
    expect(next.find((c) => c.id === 'c1')!.cards[0]!.swimlaneKey).toBe('u1');
    expect(ids(next.find((c) => c.id === 'c1')!.cards)).toEqual(['w1']);
  });

  it('moveCardToColumn restores only the column, keeping the swimlaneKey', () => {
    const moved = relocateCardToCell(cols, 'w1', 'c2', 'u3', null); // pretend a diagonal landed
    const back = moveCardToColumn(moved, 'w1', 'c1');
    expect(ids(back.find((c) => c.id === 'c1')!.cards)).toEqual(['w1']);
    expect(back.find((c) => c.id === 'c2')!.cards).toEqual([]);
    // The (separately-accepted) lane reassign survives the column revert.
    expect(back.find((c) => c.id === 'c1')!.cards[0]!.swimlaneKey).toBe('u3');
  });

  it('moveCardToColumn is a no-op when the card is already in the target column', () => {
    expect(moveCardToColumn(cols, 'w1', 'c1')).toBe(cols);
  });
});

describe('reassignPatchForLane', () => {
  it('maps a lane key to the right field patch per group-by', () => {
    expect(reassignPatchForLane('assignee', 'u1')).toEqual({ assigneeId: 'u1' });
    expect(reassignPatchForLane('assignee', BOARD_SWIMLANE_NO_VALUE)).toEqual({ assigneeId: null });
    expect(reassignPatchForLane('priority', 'high')).toEqual({ priority: 'high' });
    expect(reassignPatchForLane('epic', 'epic1')).toEqual({ parentId: 'epic1' });
    expect(reassignPatchForLane('epic', BOARD_SWIMLANE_NO_VALUE)).toEqual({ parentId: null });
    expect(reassignPatchForLane('none', 'whatever')).toEqual({});
  });
});

describe('resolveCellMove', () => {
  // snapshot: w1 in (c1, u1); build the post-over `current` per scenario.
  const snapshot = [
    column({
      id: 'c1',
      name: 'To Do',
      cards: [
        card({ id: 'w1', key: 1, swimlaneKey: 'u1' }),
        card({ id: 'w2', key: 2, swimlaneKey: 'u1' }),
      ],
    }),
    column({ id: 'c2', name: 'Done', cards: [card({ id: 'w3', key: 3, swimlaneKey: 'u2' })] }),
  ];

  it('detects a lane-only move (reassign)', () => {
    const current = setCardSwimlaneKey(snapshot, 'w1', 'u2');
    const move = resolveCellMove(snapshot, current, 'w1')!;
    expect(move.columnChanged).toBe(false);
    expect(move.laneChanged).toBe(true);
    expect(move.originLaneKey).toBe('u1');
    expect(move.targetLaneKey).toBe('u2');
  });

  it('detects a column-only move (transition) with cell-rank neighbours', () => {
    const current = relocateCardToCell(snapshot, 'w1', 'c2', 'u2', null); // append after w3
    const move = resolveCellMove(snapshot, current, 'w1')!;
    expect(move.columnChanged).toBe(true);
    // lane key changed too here (u1→u2) — to test a pure column move, keep the lane:
    const sameLane = relocateCardToCell(snapshot, 'w1', 'c2', 'u1', null);
    const m2 = resolveCellMove(snapshot, sameLane, 'w1')!;
    expect(m2.columnChanged).toBe(true);
    expect(m2.laneChanged).toBe(false);
  });

  it('detects a diagonal move (both axes)', () => {
    const current = relocateCardToCell(snapshot, 'w1', 'c2', 'u2', 'w3');
    const move = resolveCellMove(snapshot, current, 'w1')!;
    expect(move.columnChanged).toBe(true);
    expect(move.laneChanged).toBe(true);
    expect(move.targetColId).toBe('c2');
    expect(move.targetLaneKey).toBe('u2');
    // inserted before w3 → afterId is w3, no beforeId.
    expect(move.afterId).toBe('w3');
    expect(move.beforeId).toBeUndefined();
  });

  it('reports an in-cell rank change (no column/lane change)', () => {
    // w1 moved after w2 within the same (c1,u1) cell.
    const reordered = relocateCardToCell(snapshot, 'w1', 'c1', 'u1', null); // append → after w2
    const move = resolveCellMove(snapshot, reordered, 'w1')!;
    expect(move.columnChanged).toBe(false);
    expect(move.laneChanged).toBe(false);
    expect(move.originIndexInCell).toBe(0);
    expect(move.finalIndexInCell).toBe(1);
  });

  it('returns null when the card is missing from a side', () => {
    expect(resolveCellMove(snapshot, snapshot, 'ghost')).toBeNull();
  });
});

describe('resolveSwimlaneDrop (3.3.8 — resolve-on-drop, the loop fix)', () => {
  // The swimlane board no longer relocates live on dragOver (it looped — a
  // resizing cell re-measures, the `over` flips, and the relocate cycle never
  // settles). The move is resolved ONCE on drop from the dnd-kit `over` id. This
  // mirrors the real cross-lane reassign E2E (un-quarantined by 3.3.8).
  const snapshot = [
    column({
      id: 'c1',
      name: 'To Do',
      cards: [
        card({ id: 'w1', key: 1, swimlaneKey: 'u1' }), // assignee u1
        card({ id: 'w2', key: 2, swimlaneKey: BOARD_SWIMLANE_NO_VALUE }), // unassigned
      ],
    }),
    column({ id: 'c2', name: 'Done', cards: [card({ id: 'w3', key: 3, swimlaneKey: 'u1' })] }),
  ];

  it('resolves a cross-lane reassign when `over` is a CELL id (append)', () => {
    const resolved = resolveSwimlaneDrop(snapshot, cellId('c1', 'u2'), 'w2')!;
    expect(resolved).not.toBeNull();
    expect(resolved.move.columnChanged).toBe(false);
    expect(resolved.move.laneChanged).toBe(true);
    expect(resolved.move.originLaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);
    expect(resolved.move.targetLaneKey).toBe('u2');
    // the optimistic state has the card re-stamped into the target lane
    expect(laneKeyOfCard(resolved.relocated[0]!.cards.find((c) => c.id === 'w2')!)).toBe('u2');
  });

  it('resolves a reassign when `over` is a CARD id (insert before that card)', () => {
    // drop w2 onto w1 (in the u1 lane) → reassign to u1, inserted before w1.
    const resolved = resolveSwimlaneDrop(snapshot, 'w1', 'w2')!;
    expect(resolved.move.laneChanged).toBe(true);
    expect(resolved.move.targetLaneKey).toBe('u1');
    expect(resolved.move.afterId).toBe('w1');
  });

  it('resolves a drop into the catch-all lane (the unassign case)', () => {
    // w1 (assignee u1) dropped into the "No assignee" catch-all cell.
    const resolved = resolveSwimlaneDrop(snapshot, cellId('c1', BOARD_SWIMLANE_NO_VALUE), 'w1')!;
    expect(resolved.move.laneChanged).toBe(true);
    expect(resolved.move.originLaneKey).toBe('u1');
    expect(resolved.move.targetLaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);
  });

  it('resolves a diagonal drop (column AND lane change)', () => {
    const resolved = resolveSwimlaneDrop(snapshot, cellId('c2', BOARD_SWIMLANE_NO_VALUE), 'w1')!;
    expect(resolved.move.columnChanged).toBe(true);
    expect(resolved.move.laneChanged).toBe(true);
    expect(resolved.move.targetColId).toBe('c2');
    expect(resolved.move.targetLaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);
  });

  it('returns null when `over` resolves to neither a cell nor a card', () => {
    expect(resolveSwimlaneDrop(snapshot, 'nonexistent-id', 'w1')).toBeNull();
  });
});
