import { describe, expect, it } from 'vitest';
import { BOARD_SWIMLANE_NO_VALUE, type BoardCardDto } from '@/lib/dto/boards';
import {
  cardsInCells,
  cellId,
  cellOfOverId,
  findCardCell,
  findCardCells,
  findCardInCells,
  laneKeyOfCard,
  moveCardBetweenCells,
  moveCardColumnInOtherLanes,
  overCardIdOf,
  parseCellId,
  placementId,
  reassignPatchForLane,
  reconcileCellCard,
  resolveCellMove,
  resolveSwimlaneDrop,
  splitDragId,
} from '@/app/(authed)/boards/_components/boardSwimlanes';
import {
  appendCellPage,
  applyCells,
  type CellPage,
  type CellPages,
} from '@/app/(authed)/boards/_components/boardCellPages';

// Pure swimlane reducers (Subtask 3.3.5; re-pointed at the per-cell state by
// MOTIR-11452) — the cross-lane move core, tested in isolation (cells-in,
// cells-out; no DOM, no dnd-kit): drop resolution, the three count dimensions a
// move touches per axis, the same-cell reorder, both independent reverts, and a
// page merged after a move.

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

const ids = (cards: BoardCardDto[]) => cards.map((c) => c.id);

const RK = 'rk';
function page(cards: BoardCardDto[], over: Partial<CellPage> = {}): CellPage {
  return { cards, totalCount: cards.length, cursor: null, state: 'complete', ...over };
}
function pagesOf(cells: Record<string, CellPage>): CellPages {
  return { readKey: RK, cells };
}
const c = (columnId: string, laneKey: string) => ({ columnId, laneKey });
const at = (pages: CellPages, columnId: string, laneKey: string) =>
  pages.cells[cellId(columnId, laneKey)]!;

// The board every case starts from: two columns (c1, c2) × two lanes (u1, u2).
//   (c1,u1) w1 w2 · 2 of 12, more to come   (c1,u2) w3 · 1 of 1
//   (c2,u1) w4    · 1 of 1                  (c2,u2) w5 · 1 of 1
function board(): CellPages {
  return pagesOf({
    [cellId('c1', 'u1')]: page(
      [
        card({ id: 'w1', key: 1, swimlaneKey: 'u1' }),
        card({ id: 'w2', key: 2, swimlaneKey: 'u1' }),
      ],
      { totalCount: 12, cursor: 'CUR-c1u1', state: 'idle' },
    ),
    [cellId('c1', 'u2')]: page([card({ id: 'w3', key: 3, swimlaneKey: 'u2' })]),
    [cellId('c2', 'u1')]: page([card({ id: 'w4', key: 4, swimlaneKey: 'u1' })]),
    [cellId('c2', 'u2')]: page([card({ id: 'w5', key: 5, swimlaneKey: 'u2' })]),
  });
}

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

  it('cellOfOverId resolves a cell id, a card id from the cells, and rejects an unknown id', () => {
    const pages = board();
    expect(cellOfOverId(pages, cellId('c9', 'u9'))).toEqual(c('c9', 'u9'));
    expect(cellOfOverId(pages, 'w3')).toEqual(c('c1', 'u2'));
    expect(cellOfOverId(pages, 'nope')).toBeNull();
  });

  it('finds a card and its cell, and lists every loaded card', () => {
    const pages = board();
    expect(findCardCell(pages, 'w4')).toEqual(c('c2', 'u1'));
    expect(findCardInCells(pages, 'w4')?.identifier).toBe('PROD-4');
    expect(findCardCell(pages, 'zz')).toBeNull();
    expect(findCardInCells(pages, 'zz')).toBeNull();
    expect(ids(cardsInCells(pages)).sort()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });

  it('overCardIdOf inserts before a hovered card and appends on a cell body', () => {
    expect(overCardIdOf('w2')).toBe('w2');
    expect(overCardIdOf(cellId('c1', 'u1'))).toBeNull();
  });
});

describe('moveCardBetweenCells', () => {
  it('a cross-lane move: lands at the slot, both cells ±1, cursors untouched, no other cell', () => {
    const before = board();
    const next = moveCardBetweenCells(before, {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c1', 'u2'),
      overCardId: 'w3',
    });
    expect(ids(at(next, 'c1', 'u1').cards)).toEqual(['w2']);
    expect(at(next, 'c1', 'u1').totalCount).toBe(11);
    expect(at(next, 'c1', 'u1').cursor).toBe('CUR-c1u1');
    expect(at(next, 'c1', 'u1').state).toBe('idle');
    expect(ids(at(next, 'c1', 'u2').cards)).toEqual(['w1', 'w3']);
    expect(at(next, 'c1', 'u2').totalCount).toBe(2);
    // The card is stamped with its new lane.
    expect(at(next, 'c1', 'u2').cards[0]!.swimlaneKey).toBe('u2');
    // No other cell changed — by reference.
    expect(at(next, 'c2', 'u1')).toBe(at(before, 'c2', 'u1'));
    expect(at(next, 'c2', 'u2')).toBe(at(before, 'c2', 'u2'));
    expect(next.readKey).toBe(RK);
  });

  it('a drop on the cell body appends', () => {
    const next = moveCardBetweenCells(board(), {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c2', 'u1'),
      overCardId: null,
    });
    expect(ids(at(next, 'c2', 'u1').cards)).toEqual(['w4', 'w1']);
    expect(at(next, 'c2', 'u1').cards[1]!.swimlaneKey).toBe('u1');
  });

  it('a same-cell reorder moves no count and keeps every other cell', () => {
    const before = board();
    const next = moveCardBetweenCells(before, {
      cardId: 'w2',
      from: c('c1', 'u1'),
      to: c('c1', 'u1'),
      overCardId: 'w1',
    });
    expect(ids(at(next, 'c1', 'u1').cards)).toEqual(['w2', 'w1']);
    expect(at(next, 'c1', 'u1').totalCount).toBe(12);
    expect(at(next, 'c1', 'u1').cursor).toBe('CUR-c1u1');
    expect(at(next, 'c1', 'u2')).toBe(at(before, 'c1', 'u2'));
  });

  it('a same-cell move to where it already is, or onto itself, returns the state itself', () => {
    const before = board();
    expect(
      moveCardBetweenCells(before, {
        cardId: 'w1',
        from: c('c1', 'u1'),
        to: c('c1', 'u1'),
        overCardId: 'w1',
      }),
    ).toBe(before);
    expect(
      moveCardBetweenCells(before, {
        cardId: 'w2',
        from: c('c1', 'u1'),
        to: c('c1', 'u1'),
        overCardId: null,
      }),
    ).toBe(before);
  });

  it('a missing card, or a cell that does not hold it, returns the state itself', () => {
    const before = board();
    expect(
      moveCardBetweenCells(before, {
        cardId: 'zz',
        from: c('c1', 'u1'),
        to: c('c2', 'u1'),
        overCardId: null,
      }),
    ).toBe(before);
    expect(
      moveCardBetweenCells(before, {
        cardId: 'w4',
        from: c('c1', 'u1'),
        to: c('c2', 'u2'),
        overCardId: null,
      }),
    ).toBe(before);
  });

  it('a cell no page has reached keeps a null total; a moved-out cell never goes below 0', () => {
    const before = pagesOf({
      [cellId('c1', 'u1')]: page([card({ id: 'w1', key: 1, swimlaneKey: 'u1' })], {
        totalCount: 0,
      }),
    });
    const next = moveCardBetweenCells(before, {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c2', 'u2'),
      overCardId: null,
    });
    expect(at(next, 'c1', 'u1').totalCount).toBe(0);
    expect(at(next, 'c2', 'u2')).toEqual({
      cards: [expect.objectContaining({ id: 'w1', swimlaneKey: 'u2' })],
      totalCount: null,
      cursor: null,
      state: 'idle',
    });
    // From a cell with no total yet.
    const back = moveCardBetweenCells(next, {
      cardId: 'w1',
      from: c('c2', 'u2'),
      to: c('c1', 'u1'),
      overCardId: null,
    });
    expect(at(back, 'c2', 'u2').totalCount).toBeNull();
    expect(at(back, 'c1', 'u1').totalCount).toBe(1);
  });

  it('the column-axis revert returns the card to its origin column in the ACCEPTED lane', () => {
    // A diagonal (c1,u1) → (c2,u2), then the transition is refused.
    const moved = moveCardBetweenCells(board(), {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c2', 'u2'),
      overCardId: null,
    });
    const reverted = moveCardBetweenCells(moved, {
      cardId: 'w1',
      from: c('c2', 'u2'),
      to: c('c1', 'u2'),
      overCardId: 'w2', // the card it followed in the origin cell — not in this one
    });
    expect(ids(at(reverted, 'c2', 'u2').cards)).toEqual(['w5']);
    expect(at(reverted, 'c2', 'u2').totalCount).toBe(1);
    expect(ids(at(reverted, 'c1', 'u2').cards)).toEqual(['w3', 'w1']);
    expect(at(reverted, 'c1', 'u2').totalCount).toBe(2);
    expect(at(reverted, 'c1', 'u2').cards[1]!.swimlaneKey).toBe('u2');
    expect(at(reverted, 'c1', 'u1').totalCount).toBe(11);
  });

  it('the lane-axis revert returns the card to its origin lane in the ACCEPTED column, at its slot', () => {
    const moved = moveCardBetweenCells(board(), {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c1', 'u2'),
      overCardId: null,
    });
    const reverted = moveCardBetweenCells(moved, {
      cardId: 'w1',
      from: c('c1', 'u2'),
      to: c('c1', 'u1'),
      overCardId: 'w2', // back before the card it followed
    });
    expect(ids(at(reverted, 'c1', 'u1').cards)).toEqual(['w1', 'w2']);
    expect(at(reverted, 'c1', 'u1').totalCount).toBe(12);
    expect(at(reverted, 'c1', 'u1').cards[0]!.swimlaneKey).toBe('u1');
    expect(ids(at(reverted, 'c1', 'u2').cards)).toEqual(['w3']);
    expect(at(reverted, 'c1', 'u2').totalCount).toBe(1);
  });

  it('a page merged after a move never shows the landed card twice, in either lane order', () => {
    // The card was appended after the cell's last loaded card — the one its
    // cursor names — so the next page (strictly after it) can return it again.
    const moved = moveCardBetweenCells(board(), {
      cardId: 'w4',
      from: c('c2', 'u1'),
      to: c('c1', 'u1'),
      overCardId: null,
    });
    expect(at(moved, 'c1', 'u1').cursor).toBe('CUR-c1u1');
    const next = appendCellPage(moved, RK, {
      columnId: 'c1',
      laneKey: 'u1',
      cards: [
        card({ id: 'w4', key: 4, swimlaneKey: 'u1' }),
        card({ id: 'w6', key: 6, swimlaneKey: 'u1' }),
      ],
      totalCount: 13,
      cursor: null,
      planHolds: {},
    });
    expect(ids(at(next, 'c1', 'u1').cards)).toEqual(['w1', 'w2', 'w4', 'w6']);
    expect(at(next, 'c1', 'u1').totalCount).toBe(13);
  });
});

describe('reconcileCellCard', () => {
  it('takes the confirmed card into its cell, keeping the lane key the reassign owns', () => {
    const before = board();
    const next = reconcileCellCard(
      before,
      card({ id: 'w3', key: 3, status: 'done', swimlaneKey: 'other' }),
    );
    expect(at(next, 'c1', 'u2').cards[0]).toMatchObject({ status: 'done', swimlaneKey: 'u2' });
    expect(at(next, 'c1', 'u1')).toBe(at(before, 'c1', 'u1'));
    expect(reconcileCellCard(before, card({ id: 'zz', key: 99 }))).toBe(before);
  });
});

describe('applyCells', () => {
  it('replaces the whole map for the same identity and drops another identity’s', () => {
    const before = board();
    const next = moveCardBetweenCells(before, {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c1', 'u2'),
      overCardId: null,
    });
    expect(applyCells(before, next)).toBe(next);
    expect(applyCells(before, { ...next, readKey: 'another' })).toBe(before);
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
    // MOTIR-11585 — the leaf-only fields; the catch-all clears each.
    expect(reassignPatchForLane('type', 'design')).toEqual({ type: 'design' });
    expect(reassignPatchForLane('type', BOARD_SWIMLANE_NO_VALUE)).toEqual({ type: null });
    expect(reassignPatchForLane('difficulty', 'high')).toEqual({ difficulty: 'high' });
    expect(reassignPatchForLane('difficulty', BOARD_SWIMLANE_NO_VALUE)).toEqual({
      difficulty: null,
    });
    expect(reassignPatchForLane('executor', 'human')).toEqual({ executor: 'human' });
    expect(reassignPatchForLane('executor', BOARD_SWIMLANE_NO_VALUE)).toEqual({ executor: null });
    // Fields a drop cannot write patch nothing (the board locks their lanes).
    for (const g of ['reporter', 'kind', 'label', 'component', 'repository'] as const) {
      expect(reassignPatchForLane(g, 'x')).toEqual({});
    }
  });
});

describe('resolveCellMove', () => {
  const snapshot = board();

  it('detects a lane-only move (reassign) and the card it followed', () => {
    const current = moveCardBetweenCells(snapshot, {
      cardId: 'w1',
      from: c('c1', 'u1'),
      to: c('c1', 'u2'),
      overCardId: null,
    });
    const m = resolveCellMove(snapshot, current, 'w1')!;
    expect(m).toMatchObject({
      originColId: 'c1',
      originLaneKey: 'u1',
      targetColId: 'c1',
      targetLaneKey: 'u2',
      columnChanged: false,
      laneChanged: true,
      originNextId: 'w2',
      beforeId: 'w3',
      afterId: undefined,
    });
  });

  it('detects a column-only move (transition) with cell-rank neighbours', () => {
    const current = moveCardBetweenCells(snapshot, {
      cardId: 'w2',
      from: c('c1', 'u1'),
      to: c('c2', 'u1'),
      overCardId: 'w4',
    });
    const m = resolveCellMove(snapshot, current, 'w2')!;
    expect(m.columnChanged).toBe(true);
    expect(m.laneChanged).toBe(false);
    expect(m.beforeId).toBeUndefined();
    expect(m.afterId).toBe('w4');
    expect(m.originNextId).toBeNull();
  });

  it('reports an in-cell rank change', () => {
    const current = moveCardBetweenCells(snapshot, {
      cardId: 'w2',
      from: c('c1', 'u1'),
      to: c('c1', 'u1'),
      overCardId: 'w1',
    });
    const m = resolveCellMove(snapshot, current, 'w2')!;
    expect([m.columnChanged, m.laneChanged]).toEqual([false, false]);
    expect([m.originIndexInCell, m.finalIndexInCell]).toEqual([1, 0]);
  });

  it('returns null when the card is missing from a side', () => {
    expect(resolveCellMove(snapshot, pagesOf({}), 'w1')).toBeNull();
  });
});

describe('resolveSwimlaneDrop (3.3.8 — resolve-on-drop, the loop fix)', () => {
  const snapshot = board();

  it('resolves a cross-lane reassign when `over` is a CELL id (append)', () => {
    const r = resolveSwimlaneDrop(snapshot, cellId('c1', 'u2'), 'w1')!;
    expect(r.move).toMatchObject({ columnChanged: false, laneChanged: true, targetLaneKey: 'u2' });
    expect(ids(at(r.cells, 'c1', 'u2').cards)).toEqual(['w3', 'w1']);
  });

  it('resolves a drop on a CARD to that card’s cell, inserting before it', () => {
    const r = resolveSwimlaneDrop(snapshot, 'w5', 'w1')!;
    expect(r.move).toMatchObject({ targetColId: 'c2', targetLaneKey: 'u2' });
    expect(r.move.columnChanged && r.move.laneChanged).toBe(true);
    expect(ids(at(r.cells, 'c2', 'u2').cards)).toEqual(['w1', 'w5']);
  });

  it('resolves a drop into the catch-all lane (the unassign case)', () => {
    const r = resolveSwimlaneDrop(snapshot, cellId('c1', BOARD_SWIMLANE_NO_VALUE), 'w1')!;
    expect(r.move.targetLaneKey).toBe(BOARD_SWIMLANE_NO_VALUE);
    expect(at(r.cells, 'c1', BOARD_SWIMLANE_NO_VALUE).cards[0]!.swimlaneKey).toBe(
      BOARD_SWIMLANE_NO_VALUE,
    );
  });

  it('a drop back on itself changes nothing', () => {
    const r = resolveSwimlaneDrop(snapshot, 'w2', 'w2')!;
    expect(r.move.columnChanged || r.move.laneChanged).toBe(false);
    expect(r.move.originIndexInCell).toBe(r.move.finalIndexInCell);
    expect(r.cells).toBe(snapshot);
  });

  it('returns null when `over` resolves to neither a cell nor a card, or the card is in no cell', () => {
    expect(resolveSwimlaneDrop(snapshot, 'nonexistent-id', 'w1')).toBeNull();
    expect(resolveSwimlaneDrop(snapshot, cellId('c1', 'u1'), 'zz')).toBeNull();
  });
});

// MOTIR-11585 — a multi-value grouping (label, component, repository) renders one
// card in several lanes, so each rendering's drag id is a PLACEMENT id naming its
// lane; a column move moves every rendering.
describe('multi-value placements', () => {
  // w1 carries two labels (l1, l2); w2 only l1.
  //   (c1,l1) w1 w2   (c1,l2) w1   (c2,l1) —   (c2,l2) —
  function tagged(): CellPages {
    return pagesOf({
      [cellId('c1', 'l1')]: page([
        card({ id: 'w1', key: 1, swimlaneKey: 'l1' }),
        card({ id: 'w2', key: 2, swimlaneKey: 'l1' }),
      ]),
      [cellId('c1', 'l2')]: page([card({ id: 'w1', key: 1, swimlaneKey: 'l2' })]),
      [cellId('c2', 'l1')]: page([]),
      [cellId('c2', 'l2')]: page([]),
    });
  }

  it('round-trips a placement id, and a plain id carries no lane', () => {
    expect(placementId('w1', 'l2')).toBe('w1@@l2');
    expect(splitDragId('w1@@l2')).toEqual({ cardId: 'w1', laneKey: 'l2' });
    expect(splitDragId('w1')).toEqual({ cardId: 'w1', laneKey: null });
    expect(overCardIdOf('w1@@l2')).toBe('w1');
  });

  it('finds the rendering a placement id names, and every cell a card renders in', () => {
    const pages = tagged();
    expect(findCardCell(pages, placementId('w1', 'l2'))).toEqual(c('c1', 'l2'));
    expect(findCardCell(pages, placementId('w1', 'l1'))).toEqual(c('c1', 'l1'));
    expect(findCardCell(pages, placementId('w2', 'l2'))).toBeNull();
    expect(findCardCells(pages, 'w1')).toEqual([c('c1', 'l1'), c('c1', 'l2')]);
    expect(findCardInCells(pages, placementId('w1', 'l2'))!.id).toBe('w1');
    expect(cellOfOverId(pages, placementId('w1', 'l2'))).toEqual(c('c1', 'l2'));
  });

  it('a column drop of one rendering resolves in its own lane', () => {
    const r = resolveSwimlaneDrop(tagged(), cellId('c2', 'l2'), placementId('w1', 'l2'))!;
    expect(r.move).toMatchObject({
      originLaneKey: 'l2',
      targetColId: 'c2',
      targetLaneKey: 'l2',
      columnChanged: true,
      laneChanged: false,
    });
    expect(ids(at(r.cells, 'c2', 'l2').cards)).toEqual(['w1']);
    // The other rendering is still where it was until the column follow-up runs.
    expect(ids(at(r.cells, 'c1', 'l1').cards)).toEqual(['w1', 'w2']);
  });

  it('a drop on another lane’s card resolves the move under the target lane', () => {
    const r = resolveSwimlaneDrop(tagged(), placementId('w2', 'l1'), placementId('w1', 'l2'))!;
    expect(r.move).toMatchObject({ targetLaneKey: 'l1', laneChanged: true });
  });

  it('moves every other rendering to the new column, appended, and leaves the dragged lane', () => {
    const moved = resolveSwimlaneDrop(tagged(), cellId('c2', 'l2'), placementId('w1', 'l2'))!.cells;
    const next = moveCardColumnInOtherLanes(moved, {
      cardId: 'w1',
      fromColumnId: 'c1',
      toColumnId: 'c2',
      exceptLaneKey: 'l2',
    });
    expect(ids(at(next, 'c1', 'l1').cards)).toEqual(['w2']);
    expect(ids(at(next, 'c2', 'l1').cards)).toEqual(['w1']);
    expect(at(next, 'c2', 'l1').totalCount).toBe(1);
    expect(ids(at(next, 'c2', 'l2').cards)).toEqual(['w1']);
    // Its revert, with the columns swapped, takes every rendering back.
    const back = moveCardColumnInOtherLanes(next, {
      cardId: 'w1',
      fromColumnId: 'c2',
      toColumnId: 'c1',
      exceptLaneKey: 'none-dragged',
    });
    expect(ids(at(back, 'c1', 'l1').cards)).toEqual(['w2', 'w1']);
    expect(ids(at(back, 'c1', 'l2').cards)).toEqual(['w1']);
    expect(findCardCells(back, 'w1').every((a) => a.columnId === 'c1')).toBe(true);
  });

  it('reconciles a confirmed card into every lane it renders in, each keeping its lane key', () => {
    const next = reconcileCellCard(tagged(), card({ id: 'w1', key: 1, title: 'Renamed' }));
    expect(at(next, 'c1', 'l1').cards[0]).toMatchObject({ title: 'Renamed', swimlaneKey: 'l1' });
    expect(at(next, 'c1', 'l2').cards[0]).toMatchObject({ title: 'Renamed', swimlaneKey: 'l2' });
  });
});
