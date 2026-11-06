import { describe, expect, it } from 'vitest';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';
import {
  cardIndex,
  columnOfOverId,
  findCard,
  findCardColumnId,
  neighborsOf,
  reconcileCard,
  relocateCard,
  transferCount,
} from '@/app/(authed)/boards/_components/boardMove';

// The pure optimistic-move reducers (Subtask 3.2.4) — exercised in isolation,
// DOM-free: apply (relocate + count transfer), reconcile-on-200, and the
// revert-on-409/422 contract (a snapshot restore). These are the logic the
// dnd-kit handlers drive; testing them here proves the move maths without a
// browser or a server.

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
    statusKeys: [over.id],
    cards: [],
    totalCount: over.cards?.length ?? 0,
    cursor: null,
    ...over,
  };
}

// To Do [w1, w2, w3]  ·  In Progress [w4]  ·  Done []
function board(): BoardColumnDto[] {
  return [
    column({
      id: 'todo',
      name: 'To Do',
      totalCount: 3,
      cards: [card({ id: 'w1', key: 1 }), card({ id: 'w2', key: 2 }), card({ id: 'w3', key: 3 })],
    }),
    column({
      id: 'prog',
      name: 'In Progress',
      totalCount: 1,
      cards: [card({ id: 'w4', key: 4, status: 'in_progress' })],
    }),
    column({ id: 'done', name: 'Done', totalCount: 0, cards: [] }),
  ];
}

describe('boardMove lookups', () => {
  it('finds a card and its column', () => {
    const cols = board();
    expect(findCardColumnId(cols, 'w2')).toBe('todo');
    expect(findCardColumnId(cols, 'nope')).toBeNull();
    expect(findCard(cols, 'w4')?.identifier).toBe('PROD-4');
  });

  it('resolves an over id that is either a column or a card', () => {
    const cols = board();
    expect(columnOfOverId(cols, 'done')).toBe('done'); // a column droppable
    expect(columnOfOverId(cols, 'w4')).toBe('prog'); // a card → its column
    expect(columnOfOverId(cols, 'ghost')).toBeNull();
  });

  it('reports the rank neighbours bracketing a card', () => {
    const cols = board();
    expect(neighborsOf(cols, 'todo', 'w1')).toEqual({ beforeId: undefined, afterId: 'w2' });
    expect(neighborsOf(cols, 'todo', 'w2')).toEqual({ beforeId: 'w1', afterId: 'w3' });
    expect(neighborsOf(cols, 'todo', 'w3')).toEqual({ beforeId: 'w2', afterId: undefined });
    expect(neighborsOf(cols, 'prog', 'w4')).toEqual({ beforeId: undefined, afterId: undefined });
  });
});

describe('relocateCard', () => {
  it('moves a card to another column at the requested index', () => {
    const next = relocateCard(board(), 'w1', 'prog', 0); // w1 → top of In Progress
    expect(next.find((c) => c.id === 'todo')!.cards.map((c) => c.id)).toEqual(['w2', 'w3']);
    expect(next.find((c) => c.id === 'prog')!.cards.map((c) => c.id)).toEqual(['w1', 'w4']);
  });

  it('inserts into an empty column', () => {
    const next = relocateCard(board(), 'w4', 'done', 0);
    expect(next.find((c) => c.id === 'prog')!.cards).toHaveLength(0);
    expect(next.find((c) => c.id === 'done')!.cards.map((c) => c.id)).toEqual(['w4']);
  });

  it('reorders within a column (matches arrayMove semantics)', () => {
    // Move w1 (index 0) down to w3's index (2) → [w2, w3, w1].
    const next = relocateCard(board(), 'w1', 'todo', 2);
    expect(next.find((c) => c.id === 'todo')!.cards.map((c) => c.id)).toEqual(['w2', 'w3', 'w1']);
  });

  it('does not touch totalCount (counts move separately)', () => {
    const next = relocateCard(board(), 'w1', 'prog', 0);
    expect(next.find((c) => c.id === 'todo')!.totalCount).toBe(3);
    expect(next.find((c) => c.id === 'prog')!.totalCount).toBe(1);
  });

  it('is a no-op for an unknown card or target', () => {
    const cols = board();
    expect(relocateCard(cols, 'ghost', 'prog', 0)).toBe(cols);
    expect(relocateCard(cols, 'w1', 'ghost', 0)).toBe(cols);
  });
});

describe('transferCount', () => {
  it('moves one unit of count across columns', () => {
    const next = transferCount(board(), 'todo', 'prog');
    expect(next.find((c) => c.id === 'todo')!.totalCount).toBe(2);
    expect(next.find((c) => c.id === 'prog')!.totalCount).toBe(2);
  });

  it('is a no-op for an in-column move', () => {
    const cols = board();
    expect(transferCount(cols, 'todo', 'todo')).toBe(cols);
  });

  it('floors a column count at zero', () => {
    const cols = [column({ id: 'a', name: 'A', totalCount: 0, cards: [] })];
    const next = transferCount(cols, 'a', 'a'); // same → unchanged
    expect(next).toBe(cols);
    const two = [
      column({ id: 'a', name: 'A', totalCount: 0, cards: [] }),
      column({ id: 'b', name: 'B', totalCount: 5, cards: [] }),
    ];
    expect(transferCount(two, 'a', 'b').find((c) => c.id === 'a')!.totalCount).toBe(0);
  });
});

describe('optimistic move → confirm vs revert', () => {
  // A cross-column move (w1: To Do → In Progress, dropped above w4): apply
  // optimistically (relocate + count transfer), then either reconcile the
  // server card (200) or restore the snapshot (409 / 422).
  function applyMove() {
    const snapshot = board();
    const relocated = relocateCard(snapshot, 'w1', 'prog', 0);
    const optimistic = transferCount(relocated, 'todo', 'prog');
    return { snapshot, optimistic };
  }

  it('applies optimistically (card moved, counts transferred)', () => {
    const { optimistic } = applyMove();
    expect(findCardColumnId(optimistic, 'w1')).toBe('prog');
    expect(cardIndex(optimistic, 'prog', 'w1')).toBe(0);
    expect(optimistic.find((c) => c.id === 'todo')!.totalCount).toBe(2);
    expect(optimistic.find((c) => c.id === 'prog')!.totalCount).toBe(2);
    // Neighbours sent to the move API: dropped above w4 → afterId is w4.
    expect(neighborsOf(optimistic, 'prog', 'w1')).toEqual({ beforeId: undefined, afterId: 'w4' });
  });

  it('reconciles to the server card on 200 (confirmed status + position, kept in place)', () => {
    const { optimistic } = applyMove();
    const serverCard = card({
      id: 'w1',
      key: 1,
      status: 'in_progress', // the resolved target status
      position: 'a0V', // the authoritative rank between neighbours
      ready: false, // server says it's now blocked
    });
    const confirmed = reconcileCard(optimistic, serverCard);
    const reconciled = findCard(confirmed, 'w1')!;
    expect(reconciled.status).toBe('in_progress');
    expect(reconciled.position).toBe('a0V');
    expect(reconciled.ready).toBe(false);
    // Still in the target column at the dropped index; counts unchanged.
    expect(cardIndex(confirmed, 'prog', 'w1')).toBe(0);
    expect(confirmed.find((c) => c.id === 'prog')!.totalCount).toBe(2);
  });

  it('reverts to the snapshot on a rejected move (409 / 422)', () => {
    const { snapshot, optimistic } = applyMove();
    // The snap-back is simply restoring the pre-drag snapshot — w1 is back in To
    // Do at its original index and both counts are restored.
    expect(optimistic).not.toEqual(snapshot);
    expect(findCardColumnId(snapshot, 'w1')).toBe('todo');
    expect(cardIndex(snapshot, 'todo', 'w1')).toBe(0);
    expect(snapshot.find((c) => c.id === 'todo')!.totalCount).toBe(3);
    expect(snapshot.find((c) => c.id === 'prog')!.totalCount).toBe(1);
  });
});

describe('reconcileCard', () => {
  it('is a no-op when the card id is absent', () => {
    const cols = board();
    expect(reconcileCard(cols, card({ id: 'ghost', key: 9 }))).toBe(cols);
  });
});
