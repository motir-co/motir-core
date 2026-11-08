// E2E: the cross-cutting board journey AT SCALE (Story 3.5) — the combined
// load → virtualize → interact journey every per-story board test defers here.
//
// THIS FILE hosts TWO describe blocks, one per Story-3.5 subtask, both selected
// by the `board-at-scale` grep (the verification recipe runs
// `pnpm test:e2e --grep board-at-scale`):
//
//   • `board-at-scale — load model (3.5.2)`  ← THIS file
//       the board's load model proven at scale — PAGED PER LANE since
//       MOTIR-10535 (which reversed the Story-3.8 whole-set load, its cap and
//       over-cap banner, and the Done-age window): every lane opens on one page
//       with its full count, pages in as it scrolls (never a "Load more"
//       button), stays DOM-bounded by virtualization, and a Done lane pages in
//       full — aged-out cards included.
//   • `board-at-scale — interaction (3.5.3)` lives in its own file
//       (board-at-scale-interaction.spec.ts) with its own seeded tenant.
//
// It runs on the board-shaped large seed (3.5.1) at TEST scale, through the
// shipped services. The CI step that selects it with `--grep board-at-scale`
// still exports the retired cap/Done-age override envs; nothing reads them now.

import { expect, test, type Page } from '@playwright/test';
import { BoardSwimlaneGroupBy } from '@/generated/prisma/client';
import { resetDatabase, db } from './_helpers/db-reset';
import {
  getBoard,
  columnByStatus,
  columnCardNodes,
  columnTotalBadge,
  expectColumnVirtualized,
  expectNoLoadMore,
  scrollLaneToEnd,
  scrollSwimlaneColumnToEnd,
  signInBoardSeedOwnerAndOpenBoard,
} from './_helpers/board';
import { BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import type { BoardColumnPageDto, BoardProjectionDto } from '@/lib/dto/boards';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  seedLargeBoard,
  SEED_LARGE_OWNER_EMAIL,
  SEED_LARGE_OWNER_PASSWORD,
  type SeedLargeBoardManifest,
} from '../../scripts/seedLargeBoard';

// The board-shaped seed loads tens of cards over real HTTP and renders them
// (virtualized) — generous headroom for the seed in beforeAll + the per-test
// loads, well above the 30s default.
test.describe.configure({ timeout: 120_000 });

// The board-shaped seed sizing: tens of rows, one tall column many pages deep
// and far past the row window (virtualization), a Done-age spread (~half the
// terminal cards backdated weeks), and enough spread for every column +
// assignee/epic/priority lane to be populated.
const SEED_OPTS = {
  epics: 3,
  storiesPerEpic: 6,
  rootStories: 12,
  tallColumnExtra: 60,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
};

interface BigSeed {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  manifest: SeedLargeBoardManifest;
}

// Recreate the `db:seed:large` board-shaped tenant (the same owner the 3.5.1
// helper signs in as) at TEST scale, through the shipped services — the
// `seedLargeBoard` fixture is built to run against a small tenant exactly so a
// test can drive it. Pins the owner's active project so the active-project-scoped
// `/boards` route resolves it. Returns the manifest so assertions read the
// distribution instead of re-deriving it.
async function seedBigBoard(): Promise<BigSeed> {
  const owner = await usersService.createUser({
    email: SEED_LARGE_OWNER_EMAIL,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Board Seed Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Board at scale WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Board at scale',
    identifier: 'BIG',
  });
  // Six members for the assignee lanes (one bucket left unassigned by the seed).
  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await usersService.createUser({
      email: `board-at-scale-m${i}@example.com`,
      password: SEED_LARGE_OWNER_PASSWORD,
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: workspace.id });
    memberIds.push(m.id);
  }
  const manifest = await seedLargeBoard(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    SEED_OPTS,
  );
  // Pin the BIG project active so /boards resolves it on every render.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ownerId: owner.id, workspaceId: workspace.id, projectId: project.id, manifest };
}

// Switch the active swimlane group-by via the board-header Segmented control,
// waiting for the PATCH /api/board that persists it. Mirrors board-swimlanes.spec.ts.
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

// Every card of one lane, read the way the board reads it: the projection's
// first page, then every next page over the real HTTP route.
async function laneIdentifiers(
  page: Page,
  board: BoardProjectionDto,
  columnId: string,
): Promise<string[]> {
  const col = board.columns.find((c) => c.id === columnId)!;
  const ids = col.cards.map((c) => c.identifier);
  let cursor = col.cursor;
  while (cursor) {
    const qs = new URLSearchParams({ boardId: board.boardId, cursor });
    const res = await page.request.get(`/api/board/columns/${columnId}/cards?${qs.toString()}`);
    expect(res.status(), 'lane page').toBe(200);
    const next = (await res.json()) as BoardColumnPageDto;
    ids.push(...next.cards.map((c) => c.identifier));
    cursor = next.cursor;
  }
  return ids;
}

let big: BigSeed;

test.beforeAll(async () => {
  await resetDatabase();
  big = await seedBigBoard();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── THE SHARED-TENANT CONTRACT for this file (MOTIR-2199) ────────────────────
// Seeding happens ONCE, in `beforeAll` — deliberately, because the board-shaped
// seed is expensive and scale is this file's whole point. The cost is that this
// file's tests share ONE mutable tenant: a setting a test PERSISTS survives into
// its successors. So the READER of a shared setting establishes the value it
// needs: this hook restores the FLAT layout before every test, because
// `setGroupBy` persists `board.swimlaneGroupBy` on the board ROW and
// `gotoLoadedBoard` waits on the FLAT board's `board` testid, which a swimlaned
// board never renders. If you add a test that persists any OTHER shared setting
// (board config, column mapping, a saved filter, WIP limits), extend this hook
// rather than cleaning up at the end of the writer.
test.beforeEach(async () => {
  if (!big) return;
  await db.board.updateMany({
    where: { projectId: big.projectId },
    data: { swimlaneGroupBy: BoardSwimlaneGroupBy.none },
  });
});

test.describe('board-at-scale — load model (3.5.2)', () => {
  test('opens every lane on ONE page with its full count — no "Load more" button', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
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
      // The badge's denominator is the FULL count, however much is loaded.
      expect(await columnTotalBadge(page, col.id), `badge for ${col.name}`).toBe(col.totalCount);
    }
    const anyCol = board.columns.find((c) => c.totalCount > 0)!;
    await expect(columnCardNodes(page, anyCol.id).first()).toBeVisible();
  });

  test('pages a tall lane in as it scrolls, through the lane route, and stays DOM-bounded', async ({
    page,
  }) => {
    const pageReads: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/board\/columns\/[^/?]+\/cards\?/.test(r.url())) pageReads.push(r.url());
    });
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);

    // The seed's tall column (most cards), many pages deep.
    const tall = columnByStatus(board, big.manifest.tallStatusKey);
    expect(tall.totalCount, 'tall column is the largest').toBe(
      Math.max(...board.columns.map((c) => c.totalCount)),
    );
    expect(tall.totalCount).toBeGreaterThan(BOARD_PAGE_SIZE * 3);

    // Scrolling the lane to its end pages it in, one lane read at a time…
    await scrollLaneToEnd(page, tall.id, tall.totalCount);
    const tallReads = pageReads.filter((u) => u.includes(`/columns/${tall.id}/cards?`));
    expect(tallReads.length, 'the lane paged over its own route').toBeGreaterThanOrEqual(
      Math.ceil(tall.totalCount / BOARD_PAGE_SIZE) - 1,
    );

    // …the last card of the lane is reachable, and the column still windows.
    const ids = await laneIdentifiers(page, board, tall.id);
    await expect(page.getByRole('main').getByTestId(`board-card-${ids.at(-1)!}`)).toBeVisible();
    await expectColumnVirtualized(page, tall.id, tall.totalCount);
    await expectNoLoadMore(page);
  });

  test('pages the swimlane board from its footer row, against the page scroll', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    const board = await getBoard(page.request);
    const tall = columnByStatus(board, big.manifest.tallStatusKey);

    await expect(page.getByRole('main').getByTestId('swimlane-load-row')).toBeAttached();
    await scrollSwimlaneColumnToEnd(page, tall.id, tall.totalCount);
    await expectNoLoadMore(page);
  });

  test('pages a Done lane in FULL — the aged-out resolved cards load too', async ({ page }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);
    expect(big.manifest.terminalAgedOut, 'the seed backdated some terminal cards').toBeGreaterThan(
      0,
    );

    const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
    for (const status of statuses.filter((s) => s.category === 'done')) {
      const col = columnByStatus(board, status.key);
      const rows = await db.workItem.findMany({
        where: { projectId: big.projectId, status: status.key },
        orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
        select: { identifier: true },
      });
      expect(col.totalCount).toBe(rows.length);
      expect(await columnTotalBadge(page, col.id), `badge for ${status.key}`).toBe(rows.length);
      // Every resolved card, in recency order, no repeats — none windowed out.
      expect(await laneIdentifiers(page, board, col.id)).toEqual(rows.map((r) => r.identifier));
    }
  });
});
