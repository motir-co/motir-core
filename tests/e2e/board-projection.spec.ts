// E2E: the board PROJECTION + MOVE contract through the real stack (Story 3.1 ·
// Subtask 3.1.7).
//
// @smoke — the Story-closing journey E2E for the board BACKEND. There is no
// board UI yet (the Kanban surface is Story 3.2; the full drag-drop Playwright
// journey + WIP/swimlane cases are the Epic-3 test story 3.5), so this suite
// drives the 3.1.6 API directly over real HTTP — proving the projection + move
// contract end-to-end so 3.2 can build the UI against a trusted backend.
//
// Mirrors the closing-E2E pattern of workflow-flow.spec.ts (2.2.7): real
// Postgres, the work-item `_test` transport for setup, the user's own request
// context carrying the Better-Auth session cookie (the board routes are
// ACTIVE-PROJECT scoped, so each call resolves the signed-in user's project).
//
// Per-method behaviour (grouping internals, terminal windowing, the move
// status-resolution, RLS) is covered by the 3.1.1–3.1.6 Vitest suites against a
// real DB; this spec asserts only the cross-cutting end-to-end journey and does
// NOT duplicate them.

import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createProject, createItem, transition } from './_helpers/workflow';
import { getBoard, moveCard, columnByStatus, cardIdsIn, addCustomStatus } from './_helpers/board';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import type { BoardColumnPageDto } from '@/lib/dto/boards';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The describe title carries the `board-projection` grep handle the
// verification recipe + CI select with (`pnpm test:e2e --grep board-projection`)
// and the `@smoke` tag the Story-closing E2E convention uses.
test.describe('board-projection @smoke', () => {
  test('default board projects a column per workflow status, in order, cards grouped by status, empty unmapped', async () => {
    const owner = await signUp('e2e-board-projection@example.com');
    const project = await createProject(owner, 'Board', 'BRD');

    // Three cards; two transitioned out of To Do via legal edges so the grouping
    // spans columns (todo→in_progress and todo→cancelled are default edges).
    const stay = await createItem(owner.ctx, project.id, 'stays in todo');
    const moving = await createItem(owner.ctx, project.id, 'goes in progress');
    const cancelled = await createItem(owner.ctx, project.id, 'gets cancelled');
    expect((await transition(owner.ctx, moving.id, 'in_progress')).status()).toBe(200);
    expect((await transition(owner.ctx, cancelled.id, 'cancelled')).status()).toBe(200);

    const board = await getBoard(owner.ctx);

    // ONE column per default status, in workflow order. Read from the shipped
    // workflow rather than pinned to a literal list: the default vocabulary
    // GREW (MOTIR-2425 added `Planning`), and a pinned list turns every future
    // status into a browser-lane failure that says nothing about the product.
    expect(board.columns.map((c) => c.statusKeys)).toEqual(DEFAULT_STATUSES.map((s) => [s.key]));

    // Cards land in the right column; per-column counts match.
    expect(cardIdsIn(board, 'todo')).toEqual([stay.id]);
    expect(cardIdsIn(board, 'in_progress')).toEqual([moving.id]);
    expect(cardIdsIn(board, 'cancelled')).toEqual([cancelled.id]);
    expect(columnByStatus(board, 'todo').totalCount).toBe(1);
    expect(columnByStatus(board, 'blocked').cards).toHaveLength(0);

    // No custom status added → nothing is unmapped.
    expect(board.unmappedStatuses).toEqual([]);
  });

  test('a custom status with no column mapping surfaces in unmappedStatuses, in no column', async () => {
    const owner = await signUp('e2e-board-unmapped@example.com');
    const project = await createProject(owner, 'Unmapped', 'UNM');

    const key = await addCustomStatus(owner, project.id, { key: 'qa_review', label: 'QA Review' });

    const board = await getBoard(owner.ctx);
    // Surfaced as unmapped (Jira's behaviour — never silently dropped)…
    expect(board.unmappedStatuses.map((s) => s.key)).toContain(key);
    // …and given NO column (the default columns are unchanged).
    expect(board.columns.flatMap((c) => c.statusKeys)).not.toContain(key);
    expect(board.columns).toHaveLength(DEFAULT_STATUSES.length);
  });

  test('a lane answers one page plus a cursor, and its next pages over HTTP reach every card once (MOTIR-10535)', async () => {
    test.setTimeout(120_000); // seeding the cards over HTTP is the slow part
    const owner = await signUp('e2e-board-paging@example.com');
    const project = await createProject(owner, 'Paging', 'PAG');

    const total = BOARD_PAGE_SIZE * 2 + 3; // three pages: full, full, partial
    for (let i = 0; i < total; i++) {
      await createItem(owner.ctx, project.id, `card ${i}`); // all land in To Do
    }

    const board = await getBoard(owner.ctx);
    const todo = columnByStatus(board, 'todo');
    expect(todo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todo.totalCount).toBe(total);
    expect(todo.cursor).not.toBeNull();

    const ids = todo.cards.map((c) => c.id);
    let cursor = todo.cursor;
    while (cursor) {
      const qs = new URLSearchParams({ boardId: board.boardId, cursor });
      const res = await owner.ctx.get(`/api/board/columns/${todo.id}/cards?${qs.toString()}`);
      expect(res.status()).toBe(200);
      const page = (await res.json()) as BoardColumnPageDto;
      expect(page.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      expect(page.totalCount).toBe(total);
      ids.push(...page.cards.map((c) => c.id));
      cursor = page.cursor;
    }
    // Every card exactly once, in rank order (creation order here).
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  });

  test('a legal cross-column move applies the workflow transition; the new status shows in a re-fetched projection', async () => {
    const owner = await signUp('e2e-board-move-legal@example.com');
    const project = await createProject(owner, 'MoveLegal', 'MVL');
    const card = await createItem(owner.ctx, project.id, 'movable');

    const board = await getBoard(owner.ctx);
    const inProgress = columnByStatus(board, 'in_progress'); // todo→in_progress is legal

    const res = await moveCard(owner.ctx, board.boardId, card.id, { toColumnId: inProgress.id });
    expect(res.status()).toBe(200);
    const moved = (await res.json()) as { appliedStatus: string; card: { status: string } };
    expect(moved.appliedStatus).toBe('in_progress');
    expect(moved.card.status).toBe('in_progress');

    // The board reflects it on re-fetch: gone from To Do, present in In Progress.
    const after = await getBoard(owner.ctx);
    expect(cardIdsIn(after, 'todo')).not.toContain(card.id);
    expect(cardIdsIn(after, 'in_progress')).toEqual([card.id]);
  });

  test('an illegal cross-column move returns 409 and leaves the status unchanged (the snapback contract)', async () => {
    const owner = await signUp('e2e-board-move-illegal@example.com');
    const project = await createProject(owner, 'MoveIllegal', 'MVI');
    const card = await createItem(owner.ctx, project.id, 'cannot reach done');

    const board = await getBoard(owner.ctx);
    const done = columnByStatus(board, 'done'); // todo→done has NO transition (restricted default)

    const res = await moveCard(owner.ctx, board.boardId, card.id, { toColumnId: done.id });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');

    // Status untouched: the card is still in To Do on re-fetch (3.2 snaps it back).
    const after = await getBoard(owner.ctx);
    expect(cardIdsIn(after, 'todo')).toContain(card.id);
    expect(cardIdsIn(after, 'done')).not.toContain(card.id);
  });

  test('an in-column move changes rank only — no transition, same status + column membership', async () => {
    const owner = await signUp('e2e-board-reorder@example.com');
    const project = await createProject(owner, 'Reorder', 'RDR');
    const a = await createItem(owner.ctx, project.id, 'A'); // lower position (created first)
    const b = await createItem(owner.ctx, project.id, 'B');

    const before = await getBoard(owner.ctx);
    expect(cardIdsIn(before, 'todo')).toEqual([a.id, b.id]);
    const aPosBefore = columnByStatus(before, 'todo').cards.find((c) => c.id === a.id)!.position;

    // Drop A below B (slot's upper neighbour is B, no lower neighbour) → rank only.
    const res = await moveCard(owner.ctx, before.boardId, a.id, {
      toColumnId: columnByStatus(before, 'todo').id,
      beforeId: b.id,
    });
    expect(res.status()).toBe(200);
    const moved = (await res.json()) as { appliedStatus: string; card: { status: string } };
    expect(moved.appliedStatus, 'no transition on an in-column reorder').toBe('todo');
    expect(moved.card.status).toBe('todo');

    // Order flipped, A's rank changed, A still a To Do card (membership unchanged).
    const after = await getBoard(owner.ctx);
    expect(cardIdsIn(after, 'todo')).toEqual([b.id, a.id]);
    const aPosAfter = columnByStatus(after, 'todo').cards.find((c) => c.id === a.id)!.position;
    expect(aPosAfter).not.toBe(aPosBefore);
    expect(columnByStatus(after, 'todo').totalCount).toBe(2);
  });
});
