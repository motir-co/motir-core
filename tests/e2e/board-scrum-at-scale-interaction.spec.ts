// E2E: the CROSS-CUTTING Scrum journey AT SCALE — the interaction + complete
// half (Story 4.7 · Subtask 4.7.3). The combined drag + swimlane + WIP +
// complete-sprint journey every per-surface Epic-4 test explicitly defers here
// (4.4.7 focused lifecycle · 4.5.4 small-scale scrum · 3.5.3 Kanban
// interaction), run against the 4.7.1 SPRINT-shaped large seed so every
// interaction exercises a genuinely at-scale, SPRINT-SCOPED board: a large
// `active` sprint spread across tall virtualized columns and many populated
// lanes, paged in as they scroll with never a "Load more" button — and closed out by a
// complete-sprint whose carry-over moves a LARGE unfinished set.
//
// Lives in its OWN file (the load-model + scope + header half, 4.7.2, owns
// `board-scrum-at-scale.spec.ts`); both carry the `board-scrum-at-scale`
// describe tag, so the 4.7.2 CI step (`pnpm test:e2e --grep
// "board(-scrum)?-at-scale"`) runs this spec too. Splitting the file avoids two
// parallel subtasks colliding on one new path — the exact 3.5.2/3.5.3 split.
//
// The board pages per lane (MOTIR-10535), so a membership assertion reads the
// board through `getFullBoard` (every lane paged to its end over the lane route)
// rather than the first-page projection.
//
// Proves the 3.2/3.3 interaction contracts and the 4.4 lifecycle STILL HOLD on
// top of the 3.8 load model COMPOSED WITH the 4.5.2 sprint scope, which no
// single-surface spec can: 4.4.7 completes a three-issue sprint, 4.5.4 renders
// a handful of cards, 3.5.3 has no sprint at all. This spec owns the at-scale
// SCRUM remainder only and does NOT re-prove the reducers / projection
// internals / single-surface journeys the owning stories already cover.
//
// What is proven here, end-to-end through the real shell over real Postgres:
//   - DRAG-AS-TRANSITION DEEP IN A VIRTUALIZED SPRINT COLUMN — a card scrolled
//     into view far below the initial row-window drags to another column; the
//     transition applies + reconciles, the card STAYS IN THE SPRINT (status
//     changed, sprintId untouched), and the per-column point pills move with it
//     (aggregates, not page sums — 4.5.2/4.5.3).
//   - ILLEGAL-MOVE SNAP-BACK (409) AT SCALE — an illegal cross-column move
//     snaps back, status + sprint unchanged (the 3.1.5 IllegalBoardMoveError).
//   - SWIMLANES RE-LAY AT SCALE, STILL SPRINT-SCOPED — group-by re-lays the
//     sprint board into bounded lanes + catch-all with NO "Load more" (3.8.5),
//     never falling back to the unscoped backlog; a collapsed lane persists.
//   - CROSS-LANE REASSIGN + DIAGONAL — the grouped field reassigns (3.3.5),
//     both diagonal writes apply, and the card stays in the sprint throughout.
//   - WIP SOFT-WARNING IS ADVISORY on the sprint-scoped counts (3.3.6).
//   - COMPLETE-SPRINT WITH A LARGE CARRY-OVER + REPORT — the WHOLE unfinished
//     set (> a report page) moves to the chosen planned sprint or the backlog
//     in ONE bounded transaction (4.4.3 — none left behind, done issues stay,
//     order preserved), the one-active slot frees, and the sprint report
//     (4.4.4) serves bounded PAGINATED lists + aggregate points + the
//     scope-change count — never a dump (finding #57).
//
// Setup mirrors board-at-scale-interaction.spec.ts (3.5.3): a browser sign-up
// (creator = workspace owner), one server-seeded project pinned active, then
// the 4.7.1 `seedLargeScrumSprint` fixture (the 3.5.1 board-shaped spread +
// the sprint dimension: an `active` sprint holding the bulk of the issues with
// a story-point spread, a backlog slice left OUTSIDE it, and a `planned`
// carry-over target). Deterministic marker cards are added through the REAL
// assign-to-sprint path (`POST /api/work-items/[id]/sprint`, 4.1.4) — which
// both places them on the sprint board AND records the 1.4.6 revision the
// report's scope-change figure (`addedAfterStart`) reads. Two setup writes go
// direct (the sanctioned E2E cross-layer reach): the committed scope-lock
// baseline `startSprint` would have stamped (the seed state-sets the sprint
// active without the 4.4 lifecycle UI, exactly as 4.5.4 does), and a
// `backlogRank` chain over the seeded issues (the board seed mints `position`,
// not ranks; the carry-over order assertions need real rank keys) — raw SQL so
// the @updatedAt-managed Done-age spread is untouched, the seed's own pattern.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import {
  getFullBoard,
  columnByStatus,
  cardIdsIn,
  expectNoLoadMore,
  expectActiveSprintScope,
  identifierOf,
  assigneeOf,
  revealDeepCard,
  pointerDragForMove,
  dragIntoCellUntil,
  setGroupBy,
  setColumnWip,
  boardViewportWidth,
} from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import {
  seedLargeScrumSprint,
  type SeedLargeScrumSprintManifest,
} from '../../scripts/seedLargeBoard';
import type { SprintReportDto } from '@/lib/dto/sprints';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';

const OWNER_EMAIL = 'e2e-scrum-at-scale-owner@example.com';
const CATCH_ALL = BOARD_SWIMLANE_NO_VALUE;

// A small-but-sprint-SHAPED distribution: ~34 cards spread across every column +
// assignee/epic/priority lane with a tall `in_progress` column (24 extras) that
// virtualizes, the bulk associated with the large `active` sprint (every 7th
// left OUTSIDE in the backlog — the scope slice), a story-point spread (every
// 4th unestimated), and a `planned` carry-over target. The numbers stay tiny
// (fast per-card service-routed seed) — the interaction + complete journey
// needs virtualization + lanes + a large carry-over, not volume. Done-age
// spread is off — paging a Done lane is 4.7.2's load-model concern.
const SCRUM_OPTS = {
  epics: 2,
  storiesPerEpic: 3,
  rootStories: 2,
  tallColumnExtra: 24,
  unassignedEvery: 4,
  doneAgedOutEvery: 0,
  backlogSliceEvery: 7,
  unestimatedEvery: 4,
};

interface ScrumScale {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
  /** The assignee pool the seed round-robins across → the assignee lanes. */
  memberIds: string[];
  manifest: SeedLargeScrumSprintManifest;
}

// Sign up (the owner), add the one active project the board hangs off + pin it,
// mint a few workspace members for the assignee lanes, then lay down the 4.7.1
// sprint-shaped large fixture over it. Mirrors board-at-scale-interaction's
// seedBoardAtScale, composing the scrum sibling; the two direct setup writes
// (committed baseline, backlogRank chain) are documented in the header.
async function seedScrumAtScale(
  page: Page,
  optsOverride: Partial<typeof SCRUM_OPTS> = {},
  memberCount = 3,
): Promise<ScrumScale> {
  await signUp(page, OWNER_EMAIL);
  const local = OWNER_EMAIL.split('@')[0]!;
  const owner = await db.user.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: owner.id,
    name: 'Scrum At-Scale Demo',
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
      email: `e2e-scrum-at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.id });
    memberIds.push(m.id);
  }

  const manifest = await seedLargeScrumSprint(
    {
      workspaceId: ws.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    { ...SCRUM_OPTS, ...optsOverride },
  );

  // The committed scope-lock baseline `startSprint` (4.4.2) would have stamped.
  // The seed state-sets the sprint `active` directly (the lifecycle UI is
  // 4.4.7's journey, not this one), so without this the report's `committed`
  // figure would be the started-unestimated `null` path — stamped here so the
  // report contrast (immutable baseline vs. live sums) is observable.
  await db.sprint.update({
    where: { id: manifest.activeSprintId },
    data: {
      committedPoints: manifest.committedPoints,
      committedIssueCount: manifest.sprintIssueCount,
    },
  });

  // A real `backlogRank` chain over the seeded issues in creation order: the
  // board-shaped seed mints `position` (board order) but never `backlogRank`,
  // and the complete-sprint journeys assert RANK semantics (the backlog branch
  // keeps ranks; the sprint branch appends preserving order). Raw SQL so the
  // @updatedAt-managed column stays untouched (the seed's own backdate pattern).
  const rows = await db.workItem.findMany({
    where: { projectId: project.id },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let rank: string | null = null;
  for (const r of rows) {
    rank = keyForAppend(rank);
    await db.$executeRaw`UPDATE "work_item" SET "backlogRank" = ${rank} WHERE id = ${r.id}`;
  }

  return {
    ownerId: owner.id,
    workspaceId: ws.id,
    projectId: project.id,
    identifier: 'BIG',
    memberIds,
    manifest,
  };
}

// Open /boards at a viewport wide enough for EVERY default column — derived
// from the shipped workflow (`boardViewportWidth`), not pinned — and wait
// past the loading skeleton for the SPRINT-SCOPED board (the scrum seed flips
// the board type, so the 4.5.3 sprint header is the scrum tell).
async function openScrumBoard(page: Page): Promise<void> {
  await page.setViewportSize(boardViewportWidth());
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sprint-header')).toBeVisible();
}

/** Create a To Do work item via the `_test` transport → its id. */
async function newItem(page: Page, projectId: string, title: string): Promise<string> {
  const { id } = await createItem(page.request, projectId, title);
  return id;
}

/** Assign an issue to a sprint through the REAL product path
 *  (`POST /api/work-items/[id]/sprint`, 4.1.4 → backlogService.assignToSprint) —
 *  places it on the sprint-scoped board AND records the 1.4.6 revision the
 *  report's `addedAfterStart` scope-change figure counts. */
async function addToSprint(page: Page, id: string, sprintId: string): Promise<void> {
  const res = await page.request.post(`/api/work-items/${id}/sprint`, { data: { sprintId } });
  expect(res.ok(), `assign ${id} → sprint ${sprintId}`).toBeTruthy();
}

/** Assign a work item to a member via the `_test` free-form patch (E2E setup). */
async function assign(page: Page, id: string, assigneeId: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}`, { data: { assigneeId } });
  expect(res.ok(), `assign ${id} → ${assigneeId}`).toBeTruthy();
}

/** The active sprint's UNFINISHED issues (status outside the done-category
 *  terminal set), in rank order — the set 4.4.3 carries over on complete. */
function unfinishedSprintRows(scale: ScrumScale) {
  return db.workItem.findMany({
    where: {
      projectId: scale.projectId,
      sprintId: scale.manifest.activeSprintId,
      status: { notIn: [...scale.manifest.terminalStatusKeys] },
      archivedAt: null,
    },
    orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
    select: { id: true, identifier: true, backlogRank: true, storyPoints: true },
  });
}

/** The active sprint's DONE-category issues — the set that stays on the
 *  completed sprint as its historical record. */
function terminalSprintRows(scale: ScrumScale) {
  return db.workItem.findMany({
    where: {
      projectId: scale.projectId,
      sprintId: scale.manifest.activeSprintId,
      status: { in: [...scale.manifest.terminalStatusKeys] },
      archivedAt: null,
    },
    select: { id: true, storyPoints: true },
  });
}

const pointsOf = (rows: { storyPoints: unknown }[]): number =>
  rows.reduce((sum, r) => sum + Number(r.storyPoints ?? 0), 0);

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Each journey signs up (slow argon2), lays down the ~34-card sprint-shaped
// seed, cold-compiles the /boards + dialog chunks, and runs a multi-step
// browser interaction — generous headroom over the 30s default.
test.describe.configure({ timeout: 120_000 });

test.describe('board-scrum-at-scale — interaction + complete (4.7.3)', () => {
  test('a drag-as-transition DEEP in a virtualized sprint column applies, keeps the card in the sprint, and moves its points between column pills', async ({
    page,
  }) => {
    const scale = await seedScrumAtScale(page);
    await openScrumBoard(page);

    const board = await getFullBoard(page.request);
    expectActiveSprintScope(board);
    const inProg = columnByStatus(board, 'in_progress'); // the tall, virtualized column
    const inReview = columnByStatus(board, 'in_review'); // in_progress → in_review is legal
    expect(inProg.totalCount, 'the tall sprint column is at scale').toBeGreaterThan(15);

    // A card reachable only by scrolling the virtualized sprint column (never in
    // the initial render window), then drag it to the ADJACENT In Review column
    // (a legal transition) — proving drag survives virtualization + the sprint
    // scope at once (3.2.5/3.8.3 + 4.5.2).
    const deepIdentifier = await revealDeepCard(page, inProg.id, inProg.totalCount);
    const deepId = inProg.cards.find((c) => c.identifier === deepIdentifier)!.id;

    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${deepIdentifier}`),
      page.getByTestId(`board-column-${inReview.id}`),
    );
    expect(res.status(), 'in_progress → in_review is a legal transition (200)').toBe(200);
    // The grab really picked the DEEP card (a stale-box pickup grabs a
    // neighbouring row instead — the helper's stability wait prevents it; this
    // fails fast with the actual card if it ever regresses).
    const moved = (await res.json()) as { card: { id: string } };
    expect(moved.card.id, 'the drag picked the intended deep card').toBe(deepId);

    // The move reconciled to a real workflow transition…
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

    // …and the card STAYED IN THE SPRINT: still rendered on the sprint-scoped
    // board, `sprintId` untouched in the DB (status changed, scope did not).
    expectActiveSprintScope(after, { present: deepId });
    const row = await db.workItem.findUnique({ where: { id: deepId } });
    expect(row?.sprintId).toBe(scale.manifest.activeSprintId);

    // The per-column point pills reconciled from AGGREGATES: the dragged card's
    // points left the In Progress pill and joined the In Review pill, while the
    // sprint-level committed/completed/remaining figures are unchanged (In
    // Review is not a done-category status).
    const pts = Number(row?.storyPoints ?? 0);
    expect(after.sprint!.columnPoints[inReview.id]).toBe(
      board.sprint!.columnPoints[inReview.id]! + pts,
    );
    expect(after.sprint!.columnPoints[inProg.id]).toBe(
      board.sprint!.columnPoints[inProg.id]! - pts,
    );
    expect(after.sprint!.points).toEqual(board.sprint!.points);
  });

  test('an illegal cross-column move snaps back (409) with status and sprint unchanged, at scale', async ({
    page,
  }) => {
    const scale = await seedScrumAtScale(page);
    await openScrumBoard(page);

    const board = await getFullBoard(page.request);
    // Done → Cancelled has NO workflow transition, and Cancelled is the column
    // immediately RIGHT of Done — the ADJACENT illegal pair (3.5.3's rationale:
    // a 2-column drag latches onto the legal column between). Both columns hold
    // sprint-scoped seed cards.
    const doneCol = columnByStatus(board, 'done');
    const cancelledCol = columnByStatus(board, 'cancelled');
    const doomedId = doneCol.cards[0]?.id;
    const doomedKey = doneCol.cards[0]?.identifier;
    const cancelledTargetKey = cancelledCol.cards[0]?.identifier;
    expect(doomedKey, 'the Done column has a seeded sprint card to drag').toBeTruthy();
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

    // The rejection is surfaced (a toast) and the status + sprint are untouched
    // on re-fetch — the snap-back was visual only.
    await expect(page.getByText('Move not allowed', { exact: true })).toBeVisible();
    const after = await getFullBoard(page.request);
    expect(cardIdsIn(after, 'done')).toContain(doomedId);
    expect(cardIdsIn(after, 'cancelled')).not.toContain(doomedId);
    const row = await db.workItem.findUnique({ where: { id: doomedId! } });
    expect(row?.sprintId).toBe(scale.manifest.activeSprintId);
  });

  test('group-by re-lays the sprint board into bounded, SPRINT-SCOPED lanes + catch-all with NO "Load more"; a collapsed lane persists on reload', async ({
    page,
  }) => {
    const scale = await seedScrumAtScale(page);
    await openScrumBoard(page);

    // The seed's backlog slice — an issue provably OUTSIDE the active sprint.
    const outsider = await db.workItem.findFirstOrThrow({
      where: { projectId: scale.projectId, sprintId: null },
      select: { id: true },
    });

    // Flat at scale: sprint-scoped (the outsider is absent), NO "Load more"
    // anywhere (the retired cursor paging, 3.8.3).
    expectActiveSprintScope(await getFullBoard(page.request), { absent: outsider.id });
    await expectNoLoadMore(page);

    // Group by Assignee → one lane per assignee-with-cards plus the catch-all
    // (sorted LAST), still bounded with NO "Load more" (3.8.5) and STILL
    // sprint-scoped — the re-lay never falls back to the unscoped backlog.
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
    expectActiveSprintScope(await getFullBoard(page.request), { absent: outsider.id });

    // Epic / Priority / None all re-lay (server-side group-by) without a paging
    // affordance ever appearing, sprint scope intact throughout.
    await setGroupBy(page, 'Epic');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible(); // epics + root cards have no epic ancestor
    await expectNoLoadMore(page);
    await setGroupBy(page, 'Priority');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expectNoLoadMore(page);
    expectActiveSprintScope(await getFullBoard(page.request), { absent: outsider.id });
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

  test('a cross-lane drag reassigns the grouped field; a diagonal drag applies both writes — the card stays in the sprint throughout', async ({
    page,
  }) => {
    // A SHORTER tall column + TWO members, for the same drop-determinism reasons
    // board-at-scale-interaction documents (lane bands must fit on screen; fewer
    // stacked lanes → fewer pixel-precision misses). The at-scale concern for a
    // cross-lane drag is many populated lanes, supplied by the seed.
    const scale = await seedScrumAtScale(page, { tallColumnExtra: 6 }, 2);
    const [m0, m1] = scale.memberIds;
    const sprintId = scale.manifest.activeSprintId;

    // Deterministic marker cards INSIDE the at-scale sprint board (the scrum
    // board renders ONLY sprint issues, so each marker goes through the real
    // assign-to-sprint path), with known (column, lane) placement:
    //   cross-lane:  crossSrc in (To Do, m0)         → drop on the (To Do, m1) cell
    //                crossAnchor in (To Do, m1)       keeps that target cell non-empty
    //   diagonal:    diagSrc in (To Do, m0)          → drop on the (In Progress, m1) cell
    //                diagAnchor in (In Progress, m1)  keeps that target cell non-empty
    const crossSrc = await newItem(page, scale.projectId, 'cross-lane source');
    const crossAnchor = await newItem(page, scale.projectId, 'cross-lane target anchor');
    const diagSrc = await newItem(page, scale.projectId, 'diagonal source');
    const diagAnchor = await newItem(page, scale.projectId, 'diagonal target anchor');
    expect((await transition(page.request, diagAnchor, 'in_progress')).status()).toBe(200);
    for (const id of [crossSrc, crossAnchor, diagSrc, diagAnchor]) {
      await addToSprint(page, id, sprintId);
    }
    await assign(page, crossSrc, m0!);
    await assign(page, crossAnchor, m1!);
    await assign(page, diagSrc, m0!);
    await assign(page, diagAnchor, m1!);

    await openScrumBoard(page);
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    const board0 = await getFullBoard(page.request);
    const todoColId = columnByStatus(board0, 'todo').id;
    const inProgColId = columnByStatus(board0, 'in_progress').id;
    const crossSrcKey = identifierOf(board0, crossSrc);
    const diagSrcKey = identifierOf(board0, diagSrc);

    // CROSS-LANE: drag crossSrc from the m0 lane into the m1 lane's To Do cell →
    // the assignee flips to m1, the status (column membership) stays To Do.
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
    // (m0 → m1), each reconciled independently (3.3.5).
    const diagOk = await dragIntoCellUntil(
      page,
      diagSrcKey,
      page.getByTestId(`lane-cell-${inProgColId}-${m1}`),
      (b) => cardIdsIn(b, 'in_progress').includes(diagSrc) && assigneeOf(b, diagSrc) === m1,
    );
    expect(diagOk, 'diagonal drag moved diagSrc to In Progress AND reassigned it to m1').toBe(true);

    // Neither gesture touched the SPRINT: both markers still belong to the
    // active sprint (and so still render on the sprint-scoped board).
    const after = await getFullBoard(page.request);
    expectActiveSprintScope(after, { present: crossSrc });
    expectActiveSprintScope(after, { present: diagSrc });
    for (const id of [crossSrc, diagSrc]) {
      const row = await db.workItem.findUnique({ where: { id } });
      expect(row?.sprintId, `marker ${id} stayed in the sprint`).toBe(sprintId);
    }
  });

  test('a WIP-over-limit sprint column shows the soft warning yet still ACCEPTS a drop; an at-limit column is not warned', async ({
    page,
  }) => {
    await seedScrumAtScale(page);
    await openScrumBoard(page);

    const board0 = await getFullBoard(page.request);
    // The tall column's count is SPRINT-SCOPED (the 4.5.2 projection) — the WIP
    // predicate runs over the sprint counts, not the whole-project backlog.
    const inProg = columnByStatus(board0, 'in_progress');
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

    // SOFT, not blocking: drag a To Do sprint card into the over-limit In
    // Progress column (todo → in_progress legal) → the move is ACCEPTED (200),
    // the card lands, the count climbs to n+1, and the warning persists. The
    // 3.2.4 move contract is untouched by the WIP limit, sprint scope included.
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
  });

  test('complete-sprint carries the WHOLE large unfinished set to the chosen planned sprint and shows the paginated report', async ({
    page,
  }) => {
    const scale = await seedScrumAtScale(page);
    const { activeSprintId, activeSprintName, targetSprintId, targetSprintName } = scale.manifest;

    // Two deterministic SCOPE-CHANGE additions through the real assign-to-sprint
    // path AFTER the sprint started (the seed window starts 3 days back), so the
    // report's `addedAfterStart` figure — read from the 1.4.6 revision trail —
    // is observable (the seed's own raw association records no revisions).
    const extraA = await newItem(page, scale.projectId, 'scope-change addition A');
    const extraB = await newItem(page, scale.projectId, 'scope-change addition B');
    await addToSprint(page, extraA, activeSprintId);
    await addToSprint(page, extraB, activeSprintId);

    await openScrumBoard(page);

    // The expected sets, from the DB: the unfinished issues (in rank order — the
    // order the carry-over must preserve) and the done-category set that stays.
    const unfinished = await unfinishedSprintRows(scale);
    const doneRows = await terminalSprintRows(scale);
    expect(
      unfinished.length,
      'the carry-over set is LARGE (exceeds a report page)',
    ).toBeGreaterThan(10);
    expect(doneRows.length, 'done issues exist to stay behind').toBeGreaterThan(0);

    // The report PREVIEW over the real route, paged at limit=10: the lists are
    // bounded cursor pages while the counts + points stay FULL aggregates — the
    // finding-#57 "paginated, never a dump" contract bites at scale.
    const previewRes = await page.request.get(`/api/sprints/${activeSprintId}/report?limit=10`);
    expect(previewRes.status(), 'GET /api/sprints/[id]/report').toBe(200);
    const preview = (await previewRes.json()) as SprintReportDto;
    expect(preview.incomplete.items.length, 'a bounded page, not the whole set').toBe(10);
    expect(preview.incomplete.nextCursor, 'a further page exists').not.toBeNull();
    expect(preview.incomplete.totalCount).toBe(unfinished.length);
    expect(preview.completed.totalCount).toBe(doneRows.length);
    expect(preview.addedAfterStart, 'the scope-change count').toBe(2);
    // Aggregates, not page sums: committed is the immutable baseline; completed /
    // not-completed are the live full-sprint point sums.
    expect(preview.points.committed).toBe(scale.manifest.committedPoints);
    expect(preview.points.completed).toBe(pointsOf(doneRows));
    expect(preview.points.notCompleted).toBe(pointsOf(unfinished));

    // ── Complete the sprint from the scrum header (the 4.5.3 entry point over
    //    the 4.4.6 flow), choosing the seeded PLANNED carry-over target ────────
    await page.getByTestId('scrum-complete-sprint').click();
    const dialog = page.getByRole('dialog', { name: 'Complete sprint' });
    await expect(dialog).toBeVisible();
    // The chooser names the FULL aggregate incomplete count.
    await expect(dialog).toContainText(`${unfinished.length} incomplete work items`);

    await dialog.getByRole('radio', { name: /A future sprint/ }).click();
    await dialog.getByRole('combobox', { name: 'Target sprint' }).click();
    await page.getByRole('option', { name: targetSprintName }).click();
    await dialog.getByRole('button', { name: 'Complete sprint' }).click();

    // ── The sprint report renders as the success state ───────────────────────
    const report = page.getByRole('dialog', { name: new RegExp(`${activeSprintName} report`) });
    await expect(report).toBeVisible({ timeout: 30_000 });
    await expect(report).toContainText('Committed');
    await expect(report).toContainText('Completed');
    await expect(report).toContainText('Not completed');
    // The scope-change line and the bounded-list affordance (the "view all"
    // deep-link on both non-empty sections) — the report never dumps the set.
    await expect(report).toContainText('2 work items added after the sprint started');
    await expect(report.getByRole('link', { name: 'View all in Work Items' })).toHaveCount(2);
    // The pre-move snapshot marks where the carried issues went.
    await expect(report.getByText(targetSprintName).first()).toBeVisible();
    await report.getByRole('button', { name: 'Done' }).click();

    // ── Post-conditions: ONE bounded transaction moved the WHOLE set ─────────
    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: activeSprintId } }))?.state)
      .toBe('complete');
    expect(
      (await db.sprint.findUnique({ where: { id: activeSprintId } }))?.completedAt,
    ).not.toBeNull();

    // None left behind: every unfinished issue is on the target sprint…
    const moved = await db.workItem.findMany({
      where: { id: { in: unfinished.map((u) => u.id) } },
      select: { id: true, sprintId: true, backlogRank: true },
    });
    expect(moved.every((m) => m.sprintId === targetSprintId)).toBe(true);
    // …appended in their EXISTING order (the minted rank chain preserves the
    // pre-move rank order; fractional-index keys compare lexicographically)…
    const rankById = new Map(moved.map((m) => [m.id, m.backlogRank!]));
    const movedRanks = unfinished.map((u) => rankById.get(u.id)!);
    expect([...movedRanks].sort(), 'carry-over preserved the rank order').toEqual(movedRanks);
    // …the done issues stayed on the completed sprint as its record…
    const stayed = await db.workItem.findMany({
      where: { id: { in: doneRows.map((d) => d.id) } },
      select: { sprintId: true },
    });
    expect(stayed.every((s) => s.sprintId === activeSprintId)).toBe(true);
    expect(
      await db.workItem.count({
        where: {
          sprintId: activeSprintId,
          status: { notIn: [...scale.manifest.terminalStatusKeys] },
        },
      }),
    ).toBe(0);
    // …and the one-active slot is freed (a new sprint can now start).
    expect(
      await db.sprint.findFirst({ where: { projectId: scale.projectId, state: 'active' } }),
    ).toBeNull();
  });

  test('complete-sprint carry-over to the BACKLOG restores rank order over a large set', async ({
    page,
  }) => {
    const scale = await seedScrumAtScale(page);
    const { activeSprintId } = scale.manifest;
    await openScrumBoard(page);

    const unfinished = await unfinishedSprintRows(scale);
    const doneRows = await terminalSprintRows(scale);
    expect(unfinished.length, 'the carry-over set is large').toBeGreaterThan(10);
    const rankBefore = new Map(unfinished.map((u) => [u.id, u.backlogRank]));

    // Complete with the DEFAULT destination — Backlog (no chooser interaction
    // needed; the radio defaults there).
    await page.getByTestId('scrum-complete-sprint').click();
    const dialog = page.getByRole('dialog', { name: 'Complete sprint' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${unfinished.length} incomplete work items`);
    await dialog.getByRole('button', { name: 'Complete sprint' }).click();
    const report = page.getByRole('dialog', { name: /report/ });
    await expect(report).toBeVisible({ timeout: 30_000 });
    await report.getByRole('button', { name: 'Done' }).click();

    await expect
      .poll(async () => (await db.sprint.findUnique({ where: { id: activeSprintId } }))?.state)
      .toBe('complete');

    // Every unfinished issue fell back to the backlog KEEPING its rank (the
    // 4.4.3 backlog branch clears `sprintId` and writes nothing else).
    const carried = await db.workItem.findMany({
      where: { id: { in: unfinished.map((u) => u.id) } },
      select: { id: true, sprintId: true, backlogRank: true },
    });
    expect(carried.every((c) => c.sprintId === null)).toBe(true);
    for (const c of carried) {
      expect(c.backlogRank, `rank of ${c.id} unchanged`).toBe(rankBefore.get(c.id));
    }

    // The backlog read (4.1.4) serves the carried set back IN RANK ORDER,
    // merged with the seed's original backlog slice — and the done issues
    // (still on the completed sprint) are absent.
    const res = await page.request.get('/api/backlog');
    expect(res.status(), 'GET /api/backlog').toBe(200);
    const backlogPage = (await res.json()) as RankedIssuePageDto;
    const ids = backlogPage.items.map((i) => i.id);
    for (const u of unfinished) {
      expect(ids, `carried ${u.identifier} re-appears in the backlog`).toContain(u.id);
    }
    for (const d of doneRows) {
      expect(ids, 'a done issue did not return to the backlog').not.toContain(d.id);
    }
    const rankRows = await db.workItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, backlogRank: true },
    });
    const rankOf = new Map(rankRows.map((r) => [r.id, r.backlogRank ?? '']));
    const listedRanks = ids.map((id) => rankOf.get(id)!);
    expect([...listedRanks].sort(), 'the backlog page is in rank order').toEqual(listedRanks);
  });
});
