// E2E: the CROSS-CUTTING board journey AT SCALE — the interaction half (Story
// 3.5 · Subtask 3.5.3). The combined drag + swimlane + WIP journey every
// per-surface board test explicitly defers here (3.2.7 / 3.3.7 / 4.5.4), run
// against the 3.5.1 board-shaped large seed so each interaction exercises a
// genuinely AT-SCALE board: tall virtualized columns paged in as they scroll,
// many populated lanes, and never a "Load more" button anywhere.
//
// Lives in its OWN file (the load-model half, 3.5.2, owns
// `board-at-scale.spec.ts`); both carry the `board-at-scale` describe tag, so
// 3.5.2's CI step (`pnpm test:e2e --grep "board-at-scale"`) runs this spec too.
// Splitting the file avoids two parallel subtasks colliding on one new path.
//
// The board pages per lane (MOTIR-10535), so a membership assertion reads the
// board through `getFullBoard` (every lane paged to its end over the lane route)
// rather than the first-page projection.
//
// Proves the 3.2/3.3 interaction contracts STILL HOLD on top of the 3.8 load
// model (bounded load + virtualization), which the single-surface 3.2.7 / 3.3.7
// specs cannot: those run on a 1–3 card board where nothing virtualizes. This
// spec owns the at-scale remainder only and does NOT re-prove the reducers /
// projection internals / single-surface journeys the owning stories already
// cover with a handful of rows.
//
// What is proven here, end-to-end through the real shell over real Postgres:
//   - DRAG-AS-TRANSITION DEEP IN A VIRTUALIZED COLUMN — a card scrolled into view
//     far below the initial row-window (so it was never in the first render) drags
//     to another column; the transition applies + reconciles (3.2.4/3.2.5/3.8.3:
//     the dragged card stays mounted through virtualization).
//   - ILLEGAL-MOVE SNAP-BACK (409) AT SCALE — an illegal cross-column move on a
//     deep card snaps back, status unchanged (the 3.1.5 IllegalBoardMoveError 409).
//   - SWIMLANES RE-LAY AT SCALE — group-by Assignee/Epic/Priority/None re-lays the
//     board into bounded, virtualized lanes + the catch-all (last), each with NO
//     "Load more" (3.8.5); a collapsed lane persists across a reload (3.3.5).
//   - CROSS-LANE REASSIGN + DIAGONAL — a cross-lane drag reassigns the grouped
//     field (status unchanged, the 2.5 field path); a diagonal drag (different
//     column AND lane) applies BOTH the transition and the reassign (3.3.5).
//   - WIP SOFT-WARNING IS ADVISORY — a column over its WIP limit shows the soft
//     `n/limit` warning yet still ACCEPTS a dropped card; an at-limit column is
//     not warned (3.3.6; the 3.2.4 move contract untouched).
//
// Setup follows board-load.spec.ts (3.8.6) + board-swimlanes.spec.ts (3.3.7): a
// browser sign-up (creator = workspace owner, finding #36), one server-seeded
// project pinned active, then the 3.5.1 `seedLargeBoard` board-shaped fixture so
// the board renders at real-team scale. A few DETERMINISTIC marker cards are added
// over the `_test` transport for the swimlane/WIP assertions that need a known
// (column, lane) placement — they live INSIDE the at-scale board (surrounded by
// the seed's dozens of cards), so the assertion still runs at scale; only the
// dragged card is pinned, not the scale. The board behaviour itself is driven
// through the real /boards UI.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import {
  getFullBoard,
  columnByStatus,
  cardIdsIn,
  expectNoLoadMore,
  identifierOf,
  revealDeepCard,
  pointerDragForMove,
  assigneeOf,
  dragIntoCellUntil,
  setGroupBy,
  setColumnWip,
  boardViewportWidth,
} from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import { seedLargeBoard } from '../../scripts/seedLargeBoard';

const OWNER_EMAIL = 'e2e-board-at-scale-owner@example.com';
// The catch-all swimlane key (BOARD_SWIMLANE_NO_VALUE) — the "No assignee" / "No
// epic" lane that always sorts last.
const CATCH_ALL = BOARD_SWIMLANE_NO_VALUE;

// A small-but-board-SHAPED distribution: ~34 cards spread across every column +
// assignee/epic/priority lane, with a tall `in_progress` column (24 extras) that
// virtualizes and pages, so a card can be dragged from DEEP below the initial
// window. The numbers stay tiny (fast per-card service-routed seed): the
// interaction journey needs virtualization + lanes + WIP, not volume. Done-age
// spread is off — paging a Done lane is 3.5.2's load-model concern.
const BOARD_OPTS = {
  epics: 2,
  storiesPerEpic: 3,
  rootStories: 2,
  tallColumnExtra: 24,
  unassignedEvery: 4,
  doneAgedOutEvery: 0,
};

interface Scale {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
  /** The assignee pool the seed round-robins across → the assignee lanes. */
  memberIds: string[];
}

// Sign up (the owner), add the one active project the board hangs off + pin it,
// mint a few workspace members for the assignee lanes, then lay down the 3.5.1
// board-shaped large fixture over it. Mirrors at-scale-fixture.test.ts's
// makeFixture, but the owner is a real signed-IN browser session so the journey
// drives the actual /boards surface.
async function seedBoardAtScale(
  page: Page,
  optsOverride: Partial<typeof BOARD_OPTS> = {},
  memberCount = 3,
): Promise<Scale> {
  await signUp(page, OWNER_EMAIL);
  const local = OWNER_EMAIL.split('@')[0]!;
  const owner = await db.user.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: owner.id,
    name: 'Board At-Scale Demo',
    identifier: 'BIG',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });

  // Members → one assignee lane each + the unassigned catch-all.
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const m = await usersService.createUser({
      email: `e2e-board-at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.id });
    memberIds.push(m.id);
  }

  await seedLargeBoard(
    {
      workspaceId: ws.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    { ...BOARD_OPTS, ...optsOverride },
  );

  return {
    ownerId: owner.id,
    workspaceId: ws.id,
    projectId: project.id,
    identifier: 'BIG',
    memberIds,
  };
}

// Open /boards at a viewport wide enough for EVERY default column, so a
// cross-column pointer drag never has to chase a horizontally-scrolling target.
// The width is DERIVED from the shipped workflow (`boardViewportWidth`) rather
// than pinned — a seventh status made the old 1920 too narrow and the drags
// began missing. Waits past the loading skeleton (the at-scale set is heavy).
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize(boardViewportWidth());
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
}

/** Create a To Do work item via the `_test` transport → its id. */
async function newItem(page: Page, projectId: string, title: string): Promise<string> {
  const { id } = await createItem(page.request, projectId, title);
  return id;
}

/** Assign a work item to a member via the `_test` free-form patch (E2E setup). */
async function assign(page: Page, id: string, assigneeId: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}`, { data: { assigneeId } });
  expect(res.ok(), `assign ${id} → ${assigneeId}`).toBeTruthy();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Each journey signs up (slow argon2), lays down the ~64-card board-shaped seed,
// cold-compiles the /boards + quick-view chunks, and runs a multi-step browser
// interaction — give them generous headroom over the 30s default.
test.describe.configure({ timeout: 120_000 });

test.describe('board-at-scale — interaction (3.5.3)', () => {
  test('a drag-as-transition on a card DEEP in a virtualized column applies and reconciles', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    const board = await getFullBoard(page.request);
    const inProg = columnByStatus(board, 'in_progress'); // the tall, virtualized column
    const inReview = columnByStatus(board, 'in_review'); // in_progress → in_review is legal
    expect(inProg.totalCount, 'the tall column is at scale').toBeGreaterThan(15);

    // A card reachable only by scrolling the virtualized column (never in the
    // initial render window), then drag it to the ADJACENT In Review column (a
    // legal transition). In Review is the column immediately right of In Progress,
    // so a pointer drop is unambiguous — and it proves the dragged card survives
    // virtualization (force-mounted through the drag, 3.2.5/3.8.3).
    const deepIdentifier = await revealDeepCard(page, inProg.id, inProg.totalCount);
    const deepId = inProg.cards.find((c) => c.identifier === deepIdentifier)!.id;

    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${deepIdentifier}`),
      page.getByTestId(`board-column-${inReview.id}`),
    );
    expect(res.status(), 'in_progress → in_review is a legal transition (200)').toBe(200);

    // The move reconciled to a real workflow transition: the deep card now lives in
    // In Review, gone from In Progress — proving the drag survived virtualization.
    await expect
      .poll(async () => cardIdsIn(await getFullBoard(page.request), 'in_review').includes(deepId), {
        message: 'the deep card transitioned to in_review',
        timeout: 10_000,
      })
      .toBe(true);
    const after = await getFullBoard(page.request);
    expect(cardIdsIn(after, 'in_progress')).not.toContain(deepId);
    expect(columnByStatus(after, 'in_review').totalCount).toBe(inReview.totalCount + 1);
    expect(columnByStatus(after, 'in_progress').totalCount).toBe(inProg.totalCount - 1);
    void scale;
  });

  test('an illegal cross-column move snaps back (409) with status unchanged, at scale', async ({
    page,
  }) => {
    await seedBoardAtScale(page);
    await openBoard(page);

    const board = await getFullBoard(page.request);
    // Done → Cancelled has NO workflow transition, and Cancelled is the column
    // immediately RIGHT of Done — an ADJACENT illegal pair, so the pointer drop is
    // unambiguous (In Progress has no illegal neighbour: both Blocked and In Review
    // are legal from it, and a 2-column drag latches onto the legal column between).
    const doneCol = columnByStatus(board, 'done');
    const cancelledCol = columnByStatus(board, 'cancelled');
    const doomedId = doneCol.cards[0]?.id;
    const doomedKey = doneCol.cards[0]?.identifier;
    const cancelledTargetKey = cancelledCol.cards[0]?.identifier;
    expect(doomedKey, 'the Done column has a seeded card to drag').toBeTruthy();
    expect(cancelledTargetKey, 'the Cancelled column has a seeded card to drop onto').toBeTruthy();

    // Drop onto the Cancelled CARD (not the bare column droppable): a card target
    // registers the over-column reliably and pins the destination to Cancelled.
    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${doomedKey}`),
      page.getByTestId(`board-card-${cancelledTargetKey}`),
      0.5,
    );
    expect(res.status(), 'done → cancelled is illegal (409)').toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');

    // The rejection is surfaced (a toast) and the status is untouched on re-fetch —
    // the snap-back was visual only.
    await expect(page.getByText('Move not allowed', { exact: true })).toBeVisible();
    const after = await getFullBoard(page.request);
    expect(cardIdsIn(after, 'done')).toContain(doomedId);
    expect(cardIdsIn(after, 'cancelled')).not.toContain(doomedId);
  });

  test('group-by re-lays the board into bounded virtualized lanes + catch-all with NO "Load more"; a collapsed lane persists on reload', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    // Flat at scale: NO "Load more" anywhere (the retired cursor paging, 3.8.3).
    await expectNoLoadMore(page);

    // Group by Assignee → the board re-lays into one lane per assignee-with-cards
    // plus the "No assignee" catch-all (sorted LAST), still bounded with NO "Load
    // more" anywhere in the swimlane layout (3.8.5).
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    for (const memberId of scale.memberIds) {
      await expect(page.getByTestId(`swimlane-${memberId}`)).toBeVisible();
    }
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible();
    const laneHeadIds = await page
      .locator('[data-testid^="swimlane-head-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(laneHeadIds.at(-1), 'the catch-all lane sorts last').toBe(`swimlane-head-${CATCH_ALL}`);
    await expectNoLoadMore(page);

    // Epic / Priority / None all re-lay (server-side group-by) without a paging
    // affordance ever appearing.
    await setGroupBy(page, 'Epic');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible(); // epics + root stories have no epic ancestor
    await expectNoLoadMore(page);
    await setGroupBy(page, 'Priority');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expectNoLoadMore(page);
    await setGroupBy(page, 'None');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('swimlane-board')).toHaveCount(0);

    // Collapse a populated lane under Assignee → its cells unmount, the header +
    // aggregate count stay, and the collapse persists across a reload.
    await setGroupBy(page, 'Assignee');
    const laneKey = scale.memberIds[0]!;
    const head = page.getByTestId(`swimlane-head-${laneKey}`);
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`swimlane-count-${laneKey}`)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('swimlane-board')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`swimlane-head-${laneKey}`)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('a cross-lane drag reassigns the grouped field (status unchanged); a diagonal drag applies both writes', async ({
    page,
  }) => {
    // A SHORTER tall column for the swimlane scenario: the at-scale concern for a
    // cross-lane DRAG is many populated lanes, not column height. A tall in_progress
    // cell would make each lane band hundreds of px tall, so the source lane and the
    // target lane could not both fit on screen — scrolling the target into view would
    // push the source off the top and the pickup would miss it. With a short column
    // every lane band fits, so a centre-on-cell drop lands deterministically. (The
    // tall-column virtualization scale is owned by the transition + WIP tests above.)
    // TWO members (→ m0, m1 + the catch-all = three lanes only): the fewer the
    // vertically-stacked lanes, the less a pixel-precise drop can land a lane off.
    const scale = await seedBoardAtScale(page, { tallColumnExtra: 6 }, 2);
    const [m0, m1] = scale.memberIds;

    // Deterministic marker cards placed INSIDE the at-scale board, so the (column,
    // lane) source/target slots are known and the target cells are non-empty (a
    // drop onto an empty placeholder is the finicky case — board-swimlanes #61):
    //   cross-lane:  crossSrc in (To Do, m0)         → drop on the (To Do, m1) cell
    //                crossAnchor in (To Do, m1)       keeps that target cell non-empty
    //   diagonal:    diagSrc in (To Do, m0)          → drop on the (In Progress, m1) cell
    //                diagAnchor in (In Progress, m1)  keeps that target cell non-empty
    // Both sources sit in the short To Do column (an easy drag origin); the scale is
    // supplied by the seed cards filling every other column + lane.
    const crossSrc = await newItem(page, scale.projectId, 'cross-lane source');
    const crossAnchor = await newItem(page, scale.projectId, 'cross-lane target anchor');
    const diagSrc = await newItem(page, scale.projectId, 'diagonal source');
    const diagAnchor = await newItem(page, scale.projectId, 'diagonal target anchor');
    expect((await transition(page.request, diagAnchor, 'in_progress')).status()).toBe(200);
    await assign(page, crossSrc, m0!);
    await assign(page, crossAnchor, m1!);
    await assign(page, diagSrc, m0!);
    await assign(page, diagAnchor, m1!);

    await openBoard(page);
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    const board0 = await getFullBoard(page.request);
    const todoColId = columnByStatus(board0, 'todo').id;
    const inProgColId = columnByStatus(board0, 'in_progress').id;
    const crossSrcKey = identifierOf(board0, crossSrc);
    const diagSrcKey = identifierOf(board0, diagSrc);

    // CROSS-LANE: drag crossSrc from the m0 lane into the m1 lane's To Do cell →
    // the assignee flips to m1, the status (column membership) stays To Do. The
    // m1 cell is kept non-empty by `crossAnchor` (a drop onto a bare placeholder is
    // the finicky case — board-swimlanes #61). Retried to absorb pointer-drag jitter.
    const crossOk = await dragIntoCellUntil(
      page,
      crossSrcKey,
      page.getByTestId(`lane-cell-${todoColId}-${m1}`),
      (b) => assigneeOf(b, crossSrc) === m1 && cardIdsIn(b, 'todo').includes(crossSrc),
    );
    expect(crossOk, 'cross-lane reassigned crossSrc to m1 with the status unchanged (To Do)').toBe(
      true,
    );

    // DIAGONAL: drag diagSrc from (To Do, m0) into the (In Progress, m1) cell →
    // BOTH writes apply: the transition (todo → in_progress) AND the reassign
    // (m0 → m1), each reconciled independently (3.3.5). `diagAnchor` keeps the
    // target cell non-empty.
    const diagOk = await dragIntoCellUntil(
      page,
      diagSrcKey,
      page.getByTestId(`lane-cell-${inProgColId}-${m1}`),
      (b) => cardIdsIn(b, 'in_progress').includes(diagSrc) && assigneeOf(b, diagSrc) === m1,
    );
    expect(diagOk, 'diagonal drag moved diagSrc to In Progress AND reassigned it to m1').toBe(true);
  });

  test('a WIP-over-limit column shows the soft warning yet still ACCEPTS a drop; an at-limit column is not warned', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    const board0 = await getFullBoard(page.request);
    const inProg = columnByStatus(board0, 'in_progress'); // the tall column, at scale
    const n = inProg.totalCount;
    expect(n, 'the WIP column is at scale').toBeGreaterThan(15);
    const wipBadge = page.getByTestId(`board-wip-${inProg.id}`);

    // AT the limit (n/n) is NOT warned (the predicate is strictly greater).
    await setColumnWip(page, inProg.id, String(n));
    await expect(wipBadge).toBeVisible();
    await expect(wipBadge).not.toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n}/${n}`);

    // One under (limit n-1) → the SOFT over-limit warning shows (n/(n-1) + icon).
    await setColumnWip(page, inProg.id, String(n - 1));
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n}/${n - 1}`);

    // SOFT, not blocking: drag a To Do card into the over-limit In Progress column
    // (todo → in_progress legal) → the move is ACCEPTED (200), the card lands, the
    // count climbs to n+1, and the warning persists. The 3.2.4 move contract is
    // untouched by the WIP limit.
    const todoCardId = cardIdsIn(board0, 'todo')[0]!;
    const todoCardKey = identifierOf(board0, todoCardId);
    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${todoCardKey}`),
      page.getByTestId(`board-column-${inProg.id}`),
    );
    expect(res.status(), 'the soft over-limit drop is accepted, never blocked').toBe(200);
    await expect
      .poll(
        async () => columnByStatus(await getFullBoard(page.request), 'in_progress').totalCount,
        {
          message: 'the dragged card landed in the over-limit column (soft)',
          timeout: 10_000,
        },
      )
      .toBe(n + 1);
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n + 1}/${n - 1}`);
    void scale;
  });
});
