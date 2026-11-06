// E2E: the board LOAD MODEL — paged per lane (MOTIR-10535, reversing the 3.8
// "whole bounded set" model whose review-state read overran its transaction on a
// 2,830-card board and answered 500). Drives the REAL stack (Next + Postgres)
// through the /boards surface and proves, end to end, the behaviours the
// scroll-to-load grammar of `design/boards/board.mock.html` panel 4 guarantees:
//
//   1. Each lane opens on its first page, its header reading "{loaded} of
//      {total}", and loads the next page as the user SCROLLS it — no "Load
//      more" button — until the header reads the bare total.
//   2. A tall lane stays DOM-bounded — virtualization (the 2.5.15
//      `useRowWindow`) mounts only the cards in/near the scroll viewport.
//   3. A Done lane pages like any other: an old done card is no longer windowed
//      out — it loads, after the recent ones.
//   4. A failed page leaves a focusable inline retry that loads it.
//
// Setup mirrors board-config.spec.ts (3.6.4): sign up through the real UI, then
// seed the project + work items SERVER-SIDE — projectsService for the project
// (the one sanctioned cross-layer reach for E2E setup) and a fast bulk
// `createMany` for the at-scale card sets (the same shape projection.test.ts's
// `bulkCards` uses; the paging internals — keyset order, no repeats or skips,
// filter and Visitor scoping, a query count independent of the board's size —
// are covered by the Vitest suites against a real DB).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus, columnScroller, scrollLaneToEnd } from './_helpers/board';
import { projectsService } from '@/lib/services/projectsService';
import { BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { keyForAppend } from '@/lib/workItems/positioning';

// Paging a lane to its end is many page reads over real HTTP, so give the suite
// generous headroom.
test.describe.configure({ timeout: 120_000 });

// A VALID fractional-index `position` per seeded card, chained in insertion
// order across every `bulkSeed` call in a test (MOTIR-2198). `position` MUST be
// a key the product can actually mint — the shape `lib/workItems/positioning.ts`
// produces — NOT a padded/prefixed number: `p0000001` has a 7-digit integer part
// where head `'p'` demands 17, so `generateKeyBetween` rejects it outright
// ("invalid order key: p0000001"). A board seeded with such keys still RENDERS in
// order, so nothing goes red; what it silently exercises is `keyBetweenSafe`'s
// invalid-bound TOLERANCE arm (which degrades a drop to an append) rather than
// the ordinary `keyBetween` path a real board reorder takes. The chain is global
// per test so keys stay distinct across calls — two equal keys make a drop
// between them call keyBetween(k, k), which throws.
let positionCursor: string | null = null;
const nextPosition = (): string => (positionCursor = keyForAppend(positionCursor));

test.beforeEach(async () => {
  await resetDatabase();
  positionCursor = null;
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  userId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
}

// Sign-up auto-creates `<local>'s Workspace`; add the one project the board
// hangs off and pin it active so the active-project-scoped /boards route
// resolves it on every render. Mirrors board-config.spec.ts's seedActiveProject.
async function seedActiveProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Board Load Demo',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user.id, workspaceId: ws.id, projectId: project.id, identifier };
}

// Bulk-insert `count` task cards directly in `status` (one INSERT) — the fast
// fixture for the scale assertions, keyed from `startKey` so successive calls
// don't collide. Returns the inserted identifiers in insertion (position) order.
async function bulkSeed(
  seed: Seed,
  status: string,
  count: number,
  startKey = 1,
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => {
    const key = startKey + i;
    return {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      kind: 'task' as const,
      key,
      identifier: `${seed.identifier}-${key}`,
      title: `Card ${key}`,
      status,
      reporterId: seed.userId,
      position: nextPosition(),
    };
  });
  await db.workItem.createMany({ data: rows });
  return rows.map((r) => r.identifier);
}

// The board container testid flips from `board-skeleton` to `board` once the
// projection fetch resolves; waiting on it means "the board has loaded".
async function gotoLoadedBoard(page: Page, loadTimeout = 30_000): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: loadTimeout });
}

test.describe('board-load @smoke', () => {
  test('a lane opens on its first page and loads the rest as it scrolls — no "Load more"', async ({
    page,
  }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-normal@example.com', 'BLN');
    await bulkSeed(seed, 'todo', 64, 1);
    await bulkSeed(seed, 'in_progress', 4, 1001);

    await gotoLoadedBoard(page);

    // The projection answers ONE page per lane, with the full count and a cursor.
    const board = await getBoard(page.request);
    const todo = columnByStatus(board, 'todo');
    expect(todo.totalCount).toBe(64);
    expect(todo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(todo.cursor).not.toBeNull();

    // The header reads "{loaded} of 64" while the lane has more; a lane that fits
    // in one page reads its bare total.
    const inProgress = columnByStatus(board, 'in_progress');
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText(/^\d+ of 64$/);
    await expect(page.getByTestId(`board-count-${inProgress.id}`)).toHaveText('4');

    // (1) NO "Load more" button — scrolling the lane is the only affordance.
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);

    // Scrolling the lane to its bottom pages it in, to the last card.
    await scrollLaneToEnd(page, todo.id, 64);
    await expect(page.getByTestId(`board-lane-footer-${todo.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`board-card-${seed.identifier}-64`)).toBeAttached();
  });

  test('keeps a tall lane DOM-bounded — virtualized, not every card mounted', async ({ page }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-tall@example.com', 'BLT');
    const TALL = 200;
    await bulkSeed(seed, 'todo', TALL, 1);

    await gotoLoadedBoard(page);

    const board = await getBoard(page.request);
    const todo = columnByStatus(board, 'todo');
    expect(todo.totalCount).toBe(TALL);
    // The header denominator is the FULL count...
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText(/ of 200$/);

    // ...and, paged all the way in, the column still windows: only the cards
    // in/near the scroll viewport mount, far below the full set.
    await scrollLaneToEnd(page, todo.id, TALL);
    const mounted = page
      .getByTestId(`board-column-${todo.id}`)
      .locator('[data-testid^="board-card-"]');
    await expect(mounted.first()).toBeVisible();
    const mountedCount = await mounted.count();
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThan(80); // genuinely DOM-bounded, not "most"
  });

  test('a Done lane pages like any other — an old done card loads, after the recent ones', async ({
    page,
  }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-doneage@example.com', 'BLD');
    const [recentId, oldId] = await bulkSeed(seed, 'done', 2, 1);
    // Backdate the OLD done card a month: the retired Done-age window would have
    // dropped it from the board. `updatedAt` is @updatedAt (auto-managed), so it
    // can only be moved via raw SQL.
    await db.$executeRaw`
      UPDATE "work_item"
         SET "updatedAt" = now() - interval '30 days'
       WHERE "identifier" = ${oldId!} AND "projectId" = ${seed.projectId}`;

    await gotoLoadedBoard(page);

    const board = await getBoard(page.request);
    const done = columnByStatus(board, 'done');
    expect(done.cards.map((c) => c.identifier)).toEqual([recentId, oldId]);
    const doneCol = page.getByTestId(`board-column-${done.id}`);
    await expect(doneCol.getByTestId(`board-card-${recentId}`)).toBeVisible();
    await expect(doneCol.getByTestId(`board-card-${oldId}`)).toBeVisible();
    await expect(page.getByTestId(`board-count-${done.id}`)).toHaveText('2');
  });

  test('a failed page leaves a focusable inline retry that loads it', async ({ page }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-retry@example.com', 'BLR');
    await bulkSeed(seed, 'todo', 14, 1);

    // The first page read fails; every later one goes through.
    let failed = false;
    await page.route('**/api/board/columns/*/cards?*', async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 500, body: '{}' });
        return;
      }
      await route.continue();
    });

    await gotoLoadedBoard(page);
    const todo = columnByStatus(await getBoard(page.request), 'todo');
    await columnScroller(page, todo.id).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    const retry = page.getByTestId(`board-lane-retry-${todo.id}`);
    await expect(retry).toBeVisible();
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText('10 of 14');
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText('14');
    await expect(retry).toHaveCount(0);
  });
});
