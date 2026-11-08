// E2E: the cross-cutting SCRUM journey AT SCALE (Story 4.7) — the combined
// sprint-scoped load → virtualize → interact → complete journey every per-story
// Epic-4 test defers here. The Scrum analogue of board-at-scale.spec.ts (3.5).
//
// THIS FILE hosts the describe blocks for Story 4.7's journey subtasks, all
// selected by the `board-scrum-at-scale` grep (the verification recipe runs
// `pnpm test:e2e --grep board-scrum-at-scale`):
//
//   • `board-scrum-at-scale — load model + scope + header (4.7.2)` ← THIS
//       subtask (below): the board's load model proven on the SCRUM board,
//       scoped to the active sprint — sprint scope at scale (the backlog slice
//       absent), every lane PAGED as it scrolls since MOTIR-10535 (one page per
//       lane with its full sprint-scoped count, never a "Load more" button),
//       virtualization keeping the DOM bounded, a Done lane paging in full, the
//       sprint header's aggregate (never page-sum) points, and the
//       no-active-sprint empty state.
//   • `board-scrum-at-scale — interaction + complete (4.7.3)` ← the SIBLING
//       subtask (drag-as-transition · snap-back · swimlanes · cross-lane
//       reassign · WIP · complete-sprint carry-over + report), appended later.
//       Keep the describes independent: each owns its seeded tenants so neither
//       depends on the other's setup.
//
// What this spec does NOT re-test (the deferral boundary): the sprint-scope
// projection units + the small-scale scrum surface (4.5.4 / 4.5.2's own tests),
// the sprint state machine + the focused lifecycle E2E (4.4.7), the roll-up
// math (4.3.7), and the KANBAN at-scale journey (3.5.2 — board-at-scale.spec.ts,
// whose load-model predicates this file re-asserts only in their sprint-scoped
// form, because the sprint scope is exactly what 3.5.2 cannot cover).
//
// ── The 4.7.1 harness ────────────────────────────────────────────────────────
// The SPRINT-shaped large seed (`seedLargeScrumSprint`): the 3.5.1 board-shaped
// distribution with the board flipped to scrum, a large `active` sprint holding
// most of the issues (with a story-point spread, some NULL), a backlog slice
// left OUTSIDE the sprint, and a `planned` carry-over target. The CI step that
// selects this spec still exports the retired cap/Done-age override envs;
// nothing reads them now.

import { expect, test, type Page } from '@playwright/test';
import { BoardSwimlaneGroupBy, BoardType } from '@/generated/prisma/client';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  getBoard,
  getFullBoard,
  columnByStatus,
  columnCardNodes,
  columnTotalBadge,
  columnPointPill,
  expectActiveSprintScope,
  expectColumnVirtualized,
  expectNoLoadMore,
  gotoLoadedBoard,
  scrollLaneToEnd,
  scrollSwimlaneColumnToEnd,
  signInScrumSeedOwnerAndOpenScrumBoard,
} from './_helpers/board';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import {
  seedLargeScrumSprint,
  SEED_LARGE_OWNER_EMAIL,
  SEED_LARGE_OWNER_PASSWORD,
  type SeedLargeScrumSprintManifest,
} from '../../scripts/seedLargeBoard';

// The sprint-shaped seed loads tens of cards over real HTTP and renders them
// (virtualized) — generous headroom for the seed in beforeAll + the per-test
// loads, well above the 30s default.
test.describe.configure({ timeout: 120_000 });

// The sprint-shaped seed sizing. The board-shaped spread (93 cards — same maths
// as board-at-scale.spec.ts) is partitioned by `backlogSliceEvery: 7` into ~80
// in-sprint issues (a tall lane many pages deep) + ~13 left in the backlog (the
// scope slice). 1-in-4
// sprint issues stays unestimated (`storyPoints` NULL — the contributes-0 path);
// the rest cycle the point deck so the header totals are at scale.
const SEED_OPTS = {
  epics: 3,
  storiesPerEpic: 6,
  rootStories: 12,
  tallColumnExtra: 60,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
  backlogSliceEvery: 7,
  unestimatedEvery: 4,
};

interface BigSeed {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  manifest: SeedLargeScrumSprintManifest;
}

// Recreate the `SEED_SHAPE=scrum pnpm db:seed:large` sprint-shaped tenant (the
// same owner the at-scale helpers sign in as) at TEST scale, through the 4.7.1
// fixture — `seedLargeScrumSprint` composes the board-shaped distribution, flips
// the board to scrum, and builds the large active sprint + the backlog slice +
// the point spread + the planned carry-over target. Pins the owner's active
// project so the active-project-scoped `/boards` route resolves it.
async function seedBigScrum(): Promise<BigSeed> {
  const owner = await usersService.createUser({
    email: SEED_LARGE_OWNER_EMAIL,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Scrum Seed Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Scrum at scale WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Scrum at scale',
    identifier: 'BIG',
  });
  // Six members for the assignee lanes (one bucket left unassigned by the seed).
  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await usersService.createUser({
      email: `scrum-at-scale-m${i}@example.com`,
      password: SEED_LARGE_OWNER_PASSWORD,
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: workspace.id });
    memberIds.push(m.id);
  }
  const manifest = await seedLargeScrumSprint(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    SEED_OPTS,
  );
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ownerId: owner.id, workspaceId: workspace.id, projectId: project.id, manifest };
}

// A second, tiny SCRUM tenant whose sprint is OVERDUE (endDate in the past →
// `daysRemaining` floored to 0 → "Ended") with a CONTROLLED point spread:
//   A todo 5pts · B todo NULL · C done-category 3pts
// → committed 8 · completed 3 · remaining 5, with the NULL estimate provably
// contributing 0 (exact figures, no NaN). A separate owner keeps it fully
// isolated from the BIG seed.
interface SmallSeed {
  email: string;
  projectId: string;
  workspaceId: string;
  points: { committed: number; completed: number; remaining: number };
}
async function seedSmallScrum(): Promise<SmallSeed> {
  const email = 'scrum-at-scale-small@example.com';
  const owner = await usersService.createUser({
    email,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Small Scrum Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Small scrum WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Small scrum',
    identifier: 'SML',
  });
  // Flip the seeded default board to scrum (columns/mappings untouched) — the
  // same direct flip the 4.7.1 fixture and the 4.5.x projection tests use.
  await db.board.updateMany({ where: { projectId: project.id }, data: { type: BoardType.scrum } });
  // An ACTIVE but OVERDUE sprint: started 10 days ago, ended 2 days ago.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sprint = await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Overdue sprint',
      goal: 'Prove Ended + exact aggregate points',
      state: 'active',
      startDate: new Date(Date.now() - 10 * DAY_MS),
      endDate: new Date(Date.now() - 2 * DAY_MS),
      sequence: 1,
    },
  });
  const statuses = await workflowsService.listStatusesByProject(project.id, workspace.id);
  const todoKey = statuses.find((s) => s.category === 'todo')!.key;
  const doneKey = statuses.find((s) => s.category === 'done')!.key;
  // Controlled in-sprint issues (root tasks, direct rows — the 3.5.2 small-seed
  // pattern). Positions are VALID fractional-index keys (memory: padded numbers
  // 500 on a later move; harmless here but the sibling 4.7.3 reuses patterns).
  let pos: string | null = null;
  const rows = [
    { title: 'Estimated todo', status: todoKey, storyPoints: 5 },
    { title: 'Unestimated todo', status: todoKey, storyPoints: null },
    { title: 'Estimated done', status: doneKey, storyPoints: 3 },
  ];
  await db.workItem.createMany({
    data: rows.map((r, i) => ({
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task' as const,
      key: i + 1,
      identifier: `SML-${i + 1}`,
      title: r.title,
      status: r.status,
      reporterId: owner.id,
      position: (pos = keyForAppend(pos)),
      sprintId: sprint.id,
      storyPoints: r.storyPoints,
    })),
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    email,
    projectId: project.id,
    workspaceId: workspace.id,
    points: { committed: 8, completed: 3, remaining: 5 },
  };
}

// A third tenant whose SCRUM board has NO active sprint (only a completed one) —
// the 4.5.2 `sprint: null` path: the board area must show the no-active-sprint
// empty state + the Backlog CTA, never an empty six-column board.
interface NoSprintSeed {
  email: string;
}
async function seedNoActiveSprint(): Promise<NoSprintSeed> {
  const email = 'scrum-at-scale-nosprint@example.com';
  const owner = await usersService.createUser({
    email,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'No-sprint Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'No-sprint WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'No active sprint',
    identifier: 'NAS',
  });
  await db.board.updateMany({ where: { projectId: project.id }, data: { type: BoardType.scrum } });
  // The sprint is COMPLETED — the common post-complete state, stronger than
  // "no sprint row at all" (a completed sprint must NOT be resolved as active).
  await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Done sprint',
      state: 'complete',
      startDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      sequence: 1,
    },
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { email };
}

// Switch the active swimlane group-by via the board-header Segmented control,
// waiting for the PATCH /api/board that persists it. Mirrors board-at-scale.spec.ts.
async function setGroupBy(
  page: Page,
  label: 'None' | 'Assignee' | 'Epic' | 'Priority',
): Promise<void> {
  const control = page.getByRole('group', { name: 'Swimlane group by' });
  const patch = page.waitForResponse(
    (r) => r.url().endsWith('/api/board') && r.request().method() === 'PATCH',
  );
  await control.getByRole('button', { name: label, exact: true }).click();
  expect((await patch).ok(), `group-by → ${label} persisted`).toBeTruthy();
}

// The terminal (category `done`) statuses of the BIG board, each with its
// IN-SPRINT cards in the Done lane's order (most recently updated first, key as
// the tiebreak) — what paging the lane to its end must reproduce exactly.
async function terminalSprintRows(big: BigSeed) {
  const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
  const out: Array<{ statusKey: string; identifiers: string[] }> = [];
  for (const s of statuses.filter((st) => st.category === 'done')) {
    const rows = await db.workItem.findMany({
      where: { projectId: big.projectId, status: s.key, sprintId: big.manifest.activeSprintId },
      orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
      select: { identifier: true },
    });
    out.push({ statusKey: s.key, identifiers: rows.map((r) => r.identifier) });
  }
  return out;
}

/** The sprint-scoped SUM of `storyPoints` (NULL → 0) for the given status keys —
 *  the DB-side aggregate the header/pill figures must equal (never a page sum). */
async function sprintPointsAggregate(big: BigSeed, statusKeys?: string[]): Promise<number> {
  const agg = await db.workItem.aggregate({
    where: {
      projectId: big.projectId,
      sprintId: big.manifest.activeSprintId,
      ...(statusKeys ? { status: { in: statusKeys } } : {}),
    },
    _sum: { storyPoints: true },
  });
  return Number(agg._sum.storyPoints ?? 0);
}

let big: BigSeed;
let small: SmallSeed;
let noSprint: NoSprintSeed;

test.beforeAll(async () => {
  await resetDatabase();
  big = await seedBigScrum();
  small = await seedSmallScrum();
  noSprint = await seedNoActiveSprint();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Reset both tenants' boards to the FLAT layout before every test. `setGroupBy`
// PERSISTS the swimlane group-by on the board row (PATCH /api/board), so a test
// that switches to Assignee would otherwise leak swimlanes into the next test —
// whose `gotoLoadedBoard` waits on the flat board's `board` testid and times
// out. This beforeEach keeps every test here order- and retry-independent
// instead. (The kanban twin, board-at-scale.spec.ts, HAD exactly this leak —
// retry-masked, so CI stayed green while it failed every first attempt; it now
// carries the same hook, under the shared-tenant contract stated there.
// MOTIR-2199.)
test.beforeEach(async () => {
  if (!big || !small) return;
  await db.board.updateMany({
    where: { projectId: { in: [big.projectId, small.projectId] } },
    data: { swimlaneGroupBy: BoardSwimlaneGroupBy.none },
  });
});

test.describe('board-scrum-at-scale — load model + scope + header (4.7.2)', () => {
  test('renders ONLY the active sprint — the backlog slice is absent, counts are sprint-scoped', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    // Every lane paged to its end, so "on the board" means the whole sprint.
    const board = await getFullBoard(page.request);

    // The projection took the 4.5.2 scrum path: type scrum, the seeded active
    // sprint resolved (never the unscoped backlog masquerading as a sprint).
    expect(board.type).toBe('scrum');
    expect(board.sprint?.id, 'the seeded active sprint scopes the board').toBe(
      big.manifest.activeSprintId,
    );

    // A representative in-sprint issue IS on the board; a backlog-slice issue
    // (left OUTSIDE the sprint by the seed) is ABSENT — the scope filter holds
    // over a large set. Projection-level (every lane paged in full), so
    // independent of virtualization: the out-of-sprint card's absence is the
    // SCOPE filter, never a page the read did not reach.
    const inSprint = await db.workItem.findFirst({
      where: {
        projectId: big.projectId,
        sprintId: big.manifest.activeSprintId,
        status: { not: big.manifest.tallStatusKey },
      },
      select: { id: true },
    });
    const outOfSprint = await db.workItem.findFirst({
      where: {
        projectId: big.projectId,
        sprintId: null,
        status: { not: big.manifest.tallStatusKey },
      },
      select: { id: true },
    });
    expect(outOfSprint, 'the seed left a backlog slice outside the sprint').toBeTruthy();
    expectActiveSprintScope(board, { present: inSprint!.id, absent: outOfSprint!.id });

    // Every column's totalCount is the SPRINT-scoped count (the backlog slice is
    // not in any denominator), and the whole board sums to the sprint set.
    for (const col of board.columns) {
      const dbCount = await db.workItem.count({
        where: {
          projectId: big.projectId,
          sprintId: big.manifest.activeSprintId,
          status: { in: col.statusKeys },
        },
      });
      expect(col.totalCount, `sprint-scoped total for ${col.name}`).toBe(dbCount);
    }
    expect(
      board.columns.reduce((n, c) => n + c.totalCount, 0),
      'the column totals sum to the sprint set, not the project',
    ).toBe(big.manifest.sprintIssueCount);
  });

  test('opens every sprint lane on ONE page with its full sprint count — no "Load more" button', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    await expectNoLoadMore(page);

    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated`).toBeGreaterThan(0);
      expect(col.cards.length, `${col.name} first page`).toBe(
        Math.min(col.totalCount, BOARD_PAGE_SIZE),
      );
      expect(col.cursor === null, `${col.name} cursor iff more`).toBe(
        col.totalCount <= BOARD_PAGE_SIZE,
      );
      expect(await columnTotalBadge(page, col.id), `badge for ${col.name}`).toBe(col.totalCount);
    }
    const anyCol = board.columns.find((c) => c.totalCount > 0)!;
    await expect(columnCardNodes(page, anyCol.id).first()).toBeVisible();
  });

  test('pages a tall sprint lane in as it scrolls, and stays DOM-bounded', async ({ page }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    const tall = columnByStatus(board, big.manifest.tallStatusKey);
    expect(tall.totalCount, 'tall column is the largest').toBe(
      Math.max(...board.columns.map((c) => c.totalCount)),
    );
    expect(tall.totalCount).toBeGreaterThan(BOARD_PAGE_SIZE * 3);

    await scrollLaneToEnd(page, tall.id, tall.totalCount);
    const full = await getFullBoard(page.request);
    const lastId = columnByStatus(full, big.manifest.tallStatusKey).cards.at(-1)!.identifier;
    await expect(page.getByRole('main').getByTestId(`board-card-${lastId}`)).toBeVisible();
    await expectColumnVirtualized(page, tall.id, tall.totalCount);
    await expectNoLoadMore(page);
  });

  test('pages a Done sprint lane in FULL — the aged-out resolved cards load too', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);
    expect(big.manifest.terminalAgedOut, 'the seed backdated some terminal cards').toBeGreaterThan(
      0,
    );
    const full = await getFullBoard(page.request);

    for (const term of await terminalSprintRows(big)) {
      const col = columnByStatus(board, term.statusKey);
      expect(col.totalCount).toBe(term.identifiers.length);
      expect(await columnTotalBadge(page, col.id), `badge for ${term.statusKey}`).toBe(
        term.identifiers.length,
      );
      expect(
        columnByStatus(full, term.statusKey).cards.map((c) => c.identifier),
        `${term.statusKey} pages every in-sprint card in recency order`,
      ).toEqual(term.identifiers);
    }
  });

  test('sprint header points come from bounded aggregates over the WHOLE sprint — never page sums', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);
    const sprint = board.sprint!;

    // The header figures equal the DB-side sprint-scoped aggregates (NULL → 0)…
    const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
    const doneKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
    const committed = await sprintPointsAggregate(big);
    const completed = await sprintPointsAggregate(big, doneKeys);
    expect(committed, 'manifest committed matches the DB aggregate').toBe(
      big.manifest.committedPoints,
    );
    expect(sprint.points.committed).toBe(committed);
    expect(sprint.points.completed).toBe(completed);
    expect(sprint.points.remaining).toBe(committed - completed);

    // …and STRICTLY exceed the sum over the loaded first pages: lanes have more
    // pages, so estimated sprint issues exist beyond the loaded set — a page sum
    // could never reproduce the aggregate. This is the finding-#57 proof that
    // the figures are SUM aggregates, not client sums.
    const loadedSum = board.columns
      .flatMap((c) => c.cards)
      .reduce((n, card) => n + (card.storyPoints ?? 0), 0);
    expect(board.columns.some((c) => c.cursor !== null)).toBe(true);
    expect(committed, 'aggregate exceeds any loaded-page sum').toBeGreaterThan(loadedSum);

    // The per-column point pills (4.5.3) each equal the column's sprint-scoped
    // aggregate (`SprintSummaryDto.columnPoints`), at scale. The map is TOTAL
    // over the columns (a column with no estimated sprint issues carries 0 and
    // renders a "0 pts" pill — the estimated-sprint gate is board-level), so the
    // equality holds for every column.
    for (const col of board.columns) {
      const colAggregate = await sprintPointsAggregate(big, col.statusKeys);
      expect(sprint.columnPoints[col.id], `columnPoints for ${col.name}`).toBe(colAggregate);
      expect(await columnPointPill(page, col.id), `point pill for ${col.name}`).toBe(colAggregate);
    }
  });

  test('header shows exact figures with NULL→0 (no NaN) and "Ended" for an overdue sprint', async ({
    page,
  }) => {
    // The controlled small tenant: committed 8 (5 + 3; the NULL estimate
    // contributes 0, not NaN) · completed 3 (the done-category issue) ·
    // remaining 5 — exact numbers, readable from the header aria-label.
    await signIn(page, small.email, SEED_LARGE_OWNER_PASSWORD);
    await gotoLoadedBoard(page);
    const board = await getBoard(page.request);
    expect(board.sprint?.points).toEqual(small.points);

    const header = page.getByTestId('sprint-header');
    await expect(header).toBeVisible();
    const summary = header.locator('[aria-label*="committed"][aria-label*="completed"]');
    await expect(summary).toHaveAttribute(
      'aria-label',
      `Story points: ${small.points.committed} committed, ${small.points.completed} completed, ${small.points.remaining} remaining`,
    );
    await expect(header.getByText(/NaN/)).toHaveCount(0);

    // The sprint's endDate is in the past → `daysRemaining` floored at 0 → the
    // header reads "Ended" (the peach chip), never a negative day count.
    expect(board.sprint?.daysRemaining).toBe(0);
    await expect(header.getByText('Ended', { exact: true })).toBeVisible();
    await expect(header.getByText(/-\d+ days?/)).toHaveCount(0);
  });

  test('shows the no-active-sprint empty state + Backlog CTA for a completed sprint — not an empty board', async ({
    page,
  }) => {
    await signIn(page, noSprint.email, SEED_LARGE_OWNER_PASSWORD);
    await page.goto('/boards');

    // The 4.5.2 `sprint: null` path on a scrum board: the EmptyState replaces
    // the board (no six-column shell, no sprint header), with the Backlog CTA.
    await expect(page.getByRole('heading', { name: 'No active sprint' })).toBeVisible();
    const cta = page.getByRole('link', { name: 'Go to Backlog' });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/backlog');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.getByTestId('sprint-header')).toHaveCount(0);

    // The projection agrees: scrum board, sprint null (the completed sprint was
    // not resolved as active).
    const board = await getBoard(page.request);
    expect(board.type).toBe('scrum');
    expect(board.sprint).toBeNull();
  });

  test('pages the swimlane sprint board from its footer row, over the lane route', async ({
    page,
  }) => {
    const pageReads: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/board\/columns\/[^/?]+\/cards\?/.test(r.url())) pageReads.push(r.url());
    });
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    const board = await getBoard(page.request);
    const tall = columnByStatus(board, big.manifest.tallStatusKey);

    await expect(page.getByRole('main').getByTestId('swimlane-load-row')).toBeAttached();
    await scrollSwimlaneColumnToEnd(page, tall.id, tall.totalCount);
    expect(pageReads.some((u) => u.includes(`/columns/${tall.id}/cards?`))).toBe(true);
    await expectNoLoadMore(page);
  });
});
