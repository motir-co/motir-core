import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService, BOARD_ISSUE_CAP, DONE_AGE_WINDOW_DAYS } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard (Story 3.1 · Subtask 3.1.4, load model corrected by
// 3.8.2). Real Postgres (no mocks), per CLAUDE.md. createTestProject →
// createProject auto-seeds BOTH the default workflow (statuses todo / blocked /
// in_progress / in_review / done / cancelled, in that position order) AND the
// default board (3.1.2): one column per status, each mapped to its status. So
// getBoard reads a fully-seeded board with no manual row inserts.
//
// 3.8.2 retired the per-column cursor + "Load more": the board now loads the
// whole bounded set up to BOARD_ISSUE_CAP, windows terminal columns to the
// Done-age (~14d), and returns board-level `truncated`/`cap`. These tests assert
// that corrected model.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const DEFAULT_KEYS = [
  'todo',
  'blocked',
  'in_progress',
  // MOTIR-3003 — built, pull request open, CI not yet green; before `planning`
  // because slot 4 is the last board column a laptop shows in full.
  'implemented',
  'planning',
  'in_review',
  // MOTIR-5139 — a person's YES, between review and the merge.
  'approved',
  'done',
  'cancelled',
];

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Proj User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Proj WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** Create an issue (lands in `todo`) and force it into `status` (the projection
 * groups by `work_item.status`; we set it directly rather than walk the
 * transition graph — the transition path is 3.1.5's test, not this one). */
async function cardInStatus(fx: Fixture, status: string, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  if (status !== 'todo') {
    await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
  }
  return item.id;
}

/** Bulk-insert `n` cards directly in `status` with deterministic positions —
 * fast fixture for the scale/pagination assertions (keys start at 1000 to avoid
 * colliding with service-allocated keys). */
async function bulkCards(fx: Fixture, status: string, n: number): Promise<void> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  // A VALID fractional-index key per row, chained so the lexicographic position
  // sort is still the insertion order (MOTIR-2198). The old `p${padStart(4)}`
  // form sorted correctly but is a key nothing in the product can mint — head
  // `'p'` demands a 17-char integer part — so a fixture built from it seeds a
  // board state the application cannot reach.
  let position: string | null = null;
  await adminDb.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const key = 1000 + i;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${project.identifier}-${key}`,
        title: `Bulk ${i}`,
        status,
        reporterId: fx.ctx.userId,
        position: (position = keyForAppend(position)),
      };
    }),
  });
}

describe('boardsService.getBoard — projection', () => {
  it('groups cards into the right columns in workflow order, with per-column counts', async () => {
    const fx = await makeFixture('proj-group@example.com');
    await cardInStatus(fx, 'todo', 'A');
    await cardInStatus(fx, 'todo', 'B');
    await cardInStatus(fx, 'in_progress', 'C');
    await cardInStatus(fx, 'done', 'D');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.columns.map((c) => c.statusKeys[0])).toEqual(DEFAULT_KEYS);
    const byKey = new Map(board.columns.map((c) => [c.statusKeys[0], c]));
    expect(byKey.get('todo')!.totalCount).toBe(2);
    expect(byKey.get('todo')!.cards).toHaveLength(2);
    expect(byKey.get('in_progress')!.totalCount).toBe(1);
    expect(byKey.get('done')!.totalCount).toBe(1);
    expect(byKey.get('blocked')!.cards).toHaveLength(0);
    expect(byKey.get('blocked')!.cursor).toBeNull();
    expect(board.unmappedStatuses).toHaveLength(0);
    // every card carries the readiness flag (no blockers → ready)
    expect(byKey.get('todo')!.cards.every((c) => c.ready)).toBe(true);
  });

  it('surfaces a status mapped to no column in unmappedStatuses (never a column, never dropped)', async () => {
    const fx = await makeFixture('proj-unmapped@example.com');
    await workflowsService.createStatus({
      userId: fx.ctx.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'needs_triage',
      label: 'Needs Triage',
      category: 'todo',
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.unmappedStatuses.map((s) => s.key)).toEqual(['needs_triage']);
    // still the original default columns; the new status is NOT one of them
    expect(board.columns).toHaveLength(DEFAULT_KEYS.length);
    expect(board.columns.flatMap((c) => c.statusKeys)).not.toContain('needs_triage');
  });

  it('loads the WHOLE bounded column set at once — no cursor, no "Load more" (3.8.2)', async () => {
    const fx = await makeFixture('proj-wholeset@example.com');
    await bulkCards(fx, 'todo', 120); // well past the old 50-card page size

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    // The whole bounded set loads — not a 50-card first page — and there is no
    // cursor (the per-column paging is retired; the client virtualizes).
    expect(todo.totalCount).toBe(120);
    expect(todo.cards).toHaveLength(120);
    expect(todo.cursor).toBeNull();
    // A normal-sized board is not truncated.
    expect(board.truncated).toBe(false);
    expect(board.cap).toBe(BOARD_ISSUE_CAP);
  });

  it('caps the load at BOARD_ISSUE_CAP and sets truncated when the board exceeds it (3.8.2)', async () => {
    const fx = await makeFixture('proj-cap@example.com');
    await bulkCards(fx, 'todo', BOARD_ISSUE_CAP + 1); // one over the cap

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    // Full count is surfaced (the denominator), but the load is bounded by the cap.
    expect(todo.totalCount).toBe(BOARD_ISSUE_CAP + 1);
    expect(todo.cards).toHaveLength(BOARD_ISSUE_CAP);
    // Board total exceeds the cap → truncated (the 3.8.4 over-cap banner shows).
    expect(board.truncated).toBe(true);
    expect(board.cap).toBe(BOARD_ISSUE_CAP);
  }, 60_000);

  it('windows a terminal (done) column to the Done-age window; old done items are excluded but still counted (3.8.2)', async () => {
    const fx = await makeFixture('proj-doneage@example.com');
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    let donePosition: string | null = null;
    const mkDone = async (key: number, title: string) =>
      adminDb.workItem.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          kind: 'task',
          key,
          identifier: `${project.identifier}-${key}`,
          title,
          status: 'done',
          reporterId: fx.ctx.userId,
          position: (donePosition = keyForAppend(donePosition)),
        },
      });
    const recent = await mkDone(3001, 'recent done');
    const old = await mkDone(3002, 'old done');
    // Backdate the old card past the Done-age window. `updatedAt` is @updatedAt
    // (auto-managed), so it can only be moved via raw SQL — and through the ADMIN
    // client (MOTIR-2792): this is a fixture mutation, not the behaviour under test.
    await adminDb.$executeRaw`
      UPDATE "work_item"
         SET "updatedAt" = now() - (${DONE_AGE_WINDOW_DAYS + 6} || ' days')::interval
       WHERE "id" = ${old.id}`;

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;
    // The full count includes the old card (the denominator is unwindowed)...
    expect(done.totalCount).toBe(2);
    // ...but only the in-window card is loaded.
    expect(done.cards.map((c) => c.id)).toEqual([recent.id]);
  });

  it('orders a terminal (done) column by recency, not rank', async () => {
    const fx = await makeFixture('proj-terminal@example.com');
    // earlierByPosition has the EARLIER position but is touched LAST, so
    // position-order and recency-order disagree — proving the done column uses
    // recency (most-recently-updated first).
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    const earlierKey = keyForAppend(null);
    const laterKey = keyForAppend(earlierKey);
    await adminDb.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2001,
        identifier: `${project.identifier}-2001`,
        title: 'earlier position',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: earlierKey,
      },
    });
    const laterPos = await adminDb.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2002,
        identifier: `${project.identifier}-2002`,
        title: 'later position, touched last',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: laterKey,
      },
    });
    // touch the later-position card so it is the most recently updated
    await adminDb.workItem.update({ where: { id: laterPos.id }, data: { title: 'touched' } });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;
    expect(done.cards[0]!.id).toBe(laterPos.id); // recency wins over position
  });

  it('is workspace-scoped — a board read for another workspace 404s, and never leaks cards', async () => {
    const a = await makeFixture('proj-ws-a@example.com');
    const b = await makeFixture('proj-ws-b@example.com');
    await cardInStatus(a, 'todo', 'A-only');

    // B's context cannot read A's board. The project access gate (6.4.3) now
    // fronts getBoard, so a cross-workspace projectId is rejected as
    // ProjectNotFoundError (still a 404, still no existence leak — same family
    // as getProjectTree's cross-tenant read) BEFORE the board lookup.
    await expect(boardsService.getBoard(a.projectId, b.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    // B's own board sees none of A's cards.
    const boardB = await boardsService.getBoard(b.projectId, b.ctx);
    expect(boardB.columns.every((c) => c.totalCount === 0)).toBe(true);
  });

  it('marks a card with an open (non-terminal) blocker as not ready (batch readiness, finding #21)', async () => {
    const fx = await makeFixture('proj-ready@example.com');
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'blocker (todo = non-terminal)' },
      fx.ctx,
    );
    const blocked = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'blocked by the open blocker',
        links: [{ targetId: blocker.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    const cardById = new Map(todo.cards.map((c) => [c.id, c]));
    expect(cardById.get(blocked.id)!.ready).toBe(false); // open blocker → not ready
    expect(cardById.get(blocker.id)!.ready).toBe(true); // the blocker itself has none
  });

  it('carries the canvas tag-row facts: readyToStart, statusLabel, hasChildren, type, executor (MOTIR-10534)', async () => {
    const fx = await makeFixture('proj-tags@example.com');
    const planned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'story with a child' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'the child', parentId: planned.id },
      fx.ctx,
    );
    const unplanned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'childless story' },
      fx.ctx,
    );
    // An ARCHIVED child is not a child: its parent still reads unplanned.
    const archivedParent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'story whose only child is archived' },
      fx.ctx,
    );
    const gone = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'archived child',
        parentId: archivedParent.id,
      },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    const blocked = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'blocked by the planned story',
        links: [{ targetId: planned.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: blocked.id },
      data: { type: 'manual', executor: 'human' },
    });
    const started = await cardInStatus(fx, 'in_progress', 'already started');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const cards = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));

    expect(cards.get(planned.id)).toMatchObject({
      statusLabel: 'To Do',
      hasChildren: true,
      ready: true,
      readyToStart: true,
    });
    expect(cards.get(unplanned.id)).toMatchObject({ hasChildren: false, readyToStart: true });
    expect(cards.get(archivedParent.id)!.hasChildren).toBe(false);
    // Blocked: unready, so never Ready; its type and executor ride along for Manual.
    expect(cards.get(blocked.id)).toMatchObject({
      ready: false,
      readyToStart: false,
      type: 'manual',
      executor: 'human',
    });
    // Unblocked but already started: not startable, so not Ready.
    expect(cards.get(started)).toMatchObject({
      statusLabel: 'In Progress',
      ready: true,
      readyToStart: false,
    });
  });

  it('findParentIdsWithLiveChildren short-circuits an empty id set', async () => {
    const fx = await makeFixture('empty-live-children@example.com');
    const result = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findParentIdsWithLiveChildren([], fx.workspaceId, tx),
    );
    expect(result.size).toBe(0);
  });

  it('findBlockerStatesForItems short-circuits an empty id set without a query', async () => {
    // Bound even though the short-circuit returns before any client is touched
    // (MOTIR-2911): `work_item_link` is gated and this method is bindable, so an
    // unbound call here is indistinguishable — to a reader and to
    // `tests/rls/test-call-site-guard.test.ts` — from one that DOES reach the
    // singleton and silently reads nothing.
    const fx = await makeFixture('empty-blocker-states@example.com');
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockerStatesForItems([], tx),
      ),
    ).toEqual([]);
  });
});
