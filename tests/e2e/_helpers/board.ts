import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { workflowsService } from '@/lib/services/workflowsService';
import { signIn } from './shell-session';
import { SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD } from '../../../scripts/seedLargeBoard';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  BoardColumnDto,
  BoardColumnPageDto,
  BoardProjectionDto,
  MoveCardTarget,
} from '@/lib/dto/boards';
import type { TestUser } from './work-item-setup';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';

// Board-API helpers for the Story-3.1 closing E2E (Subtask 3.1.7), lifted into
// their own module so the Story-3.2 (Kanban UI) and 3.5 (Epic-3 test) specs can
// share them — the same lift pattern as workflow.ts / work-item-setup.ts. The
// board routes are ACTIVE-PROJECT scoped (GET /api/board, no key in the path):
// each helper drives them through the signed-in user's request context, so the
// route's getActiveProject() resolves the user's one project.

/** GET /api/board → the active project's default-board projection. */
export async function getBoard(ctx: APIRequestContext): Promise<BoardProjectionDto> {
  const res = await ctx.get('/api/board');
  expect(res.status(), 'GET /api/board').toBe(200);
  return (await res.json()) as BoardProjectionDto;
}

/**
 * The board with EVERY lane paged to its end (MOTIR-10535): `GET /api/board`
 * answers each lane's first page only, so a spec that asks "is this card on the
 * board / in this column" over a lane longer than one page reads it through
 * here. Each lane's remaining pages come from
 * `GET /api/board/columns/[id]/cards`, exactly as the scrolling board reads them;
 * the returned columns carry every card and a null cursor.
 */
export async function getFullBoard(ctx: APIRequestContext): Promise<BoardProjectionDto> {
  const board = await getBoard(ctx);
  for (const col of board.columns) {
    while (col.cursor) {
      const qs = new URLSearchParams({ boardId: board.boardId, cursor: col.cursor });
      const res = await ctx.get(`/api/board/columns/${col.id}/cards?${qs.toString()}`);
      expect(res.status(), `GET lane ${col.id} page`).toBe(200);
      const page = (await res.json()) as BoardColumnPageDto;
      col.cards.push(...page.cards);
      col.cursor = page.cursor;
      col.totalCount = page.totalCount;
      Object.assign(board.planHolds, page.planHolds);
    }
  }
  return board;
}

/**
 * POST /api/board/move — move a card. Returns the RAW response so the caller
 * asserts the status code itself (200 legal · 409 illegal-transition snapback ·
 * 422 unmapped target · 404 cross-tenant). `target` brackets the drop slot.
 */
export async function moveCard(
  ctx: APIRequestContext,
  boardId: string,
  workItemId: string,
  target: MoveCardTarget,
): Promise<APIResponse> {
  return ctx.post('/api/board/move', {
    data: { boardId, workItemId, ...target },
  });
}

/** The board column whose mapped statuses include `statusKey` (one per status on the default board). */
export function columnByStatus(board: BoardProjectionDto, statusKey: string): BoardColumnDto {
  const col = board.columns.find((c) => c.statusKeys.includes(statusKey));
  expect(col, `a column mapping status "${statusKey}"`).toBeTruthy();
  return col!;
}

/** The ordered ids of the cards currently in `statusKey`'s column. */
export function cardIdsIn(board: BoardProjectionDto, statusKey: string): string[] {
  return columnByStatus(board, statusKey).cards.map((c) => c.id);
}

/**
 * Add a custom workflow status to the project (the surface Story 2.2.5 exposes
 * in the workflow editor). Driven through `workflowsService` directly — the
 * sanctioned cross-layer reach for E2E SETUP (mirrors how work-item-setup.ts
 * creates projects via `projectsService`), since the status lands UNMAPPED on
 * the board and there is no board column for it. Returns the new status key.
 */
export async function addCustomStatus(
  user: TestUser,
  projectId: string,
  opts: { key: string; label: string; category?: StatusCategoryDto },
): Promise<string> {
  const status = await workflowsService.createStatus({
    userId: user.userId,
    workspaceId: user.workspaceId,
    projectId,
    key: opts.key,
    label: opts.label,
    category: opts.category ?? 'in_progress',
  });
  return status.key;
}

// ── At-scale UI helpers (Subtask 3.5.1) ─────────────────────────────────────
// Page-level (vs. the API helpers above) helpers the cross-cutting at-scale
// board specs (3.5.2 load model · 3.5.3 interaction) drive against the seeded
// board-shaped tenant. Additive — they do not touch the existing 3.1.7/3.6.4
// API helpers. They lean on the board's stable testids (`board`, `board-column-`,
// `board-card-`, `board-count-`, `board-lane-*`), the same set
// board-load.spec.ts asserts against.

/** The board container testid flips `board-skeleton` → `board` once the projection
 *  fetch resolves. Navigate to `/boards` and wait for the loaded board. The at-scale
 *  seed ships a heavy set, so the default budget is generous. */
export async function gotoLoadedBoard(page: Page, loadTimeout = 30_000): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: loadTimeout });
}

/** Sign in as the `db:seed:large` (board-shaped) tenant owner, then open the
 *  loaded board — the seed pins the owner's active project, so `/boards` resolves
 *  the BIG project. The single entry point the at-scale specs use to reach a
 *  fully-populated board over the real stack. */
export async function signInBoardSeedOwnerAndOpenBoard(
  page: Page,
  loadTimeout = 30_000,
): Promise<void> {
  await signIn(page, SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD);
  await gotoLoadedBoard(page, loadTimeout);
}

/** The mounted card-node Locator for a column (by column id) — `board-card-*`
 *  descendants of the column. Because the column virtualizes (`useRowWindow`),
 *  `.count()` is the MOUNTED (rendered) node count, NOT the column total — that
 *  is the whole point of {@link expectColumnVirtualized}. */
export function columnCardNodes(page: Page, columnId: string): Locator {
  return page.getByTestId(`board-column-${columnId}`).locator('[data-testid^="board-card-"]');
}

/** The column's count badge's FULL `totalCount` denominator, unaffected by
 *  virtualization or paging. The badge reads "{loaded} of {total}" while the lane
 *  has more pages and "{total}" once every card is loaded (MOTIR-10535), with
 *  `en` digit grouping ("2,830"), so this reads the LAST number either way. */
export async function columnTotalBadge(page: Page, columnId: string): Promise<number> {
  const text = (await page.getByTestId(`board-count-${columnId}`).textContent()) ?? '';
  const numbers = text.match(/[\d,]+/g) ?? [];
  return Number((numbers.at(-1) ?? '').replace(/,/g, ''));
}

/** Scroll a lane's own body to its end, page after page, until every card is
 *  loaded — the badge drops its "of" and reads the bare total (MOTIR-10535). The
 *  scroll is what the user does; each arrival at the bottom brings the
 *  sentinel into view and the next page in. */
export async function scrollLaneToEnd(page: Page, columnId: string, total: number): Promise<void> {
  const badge = page.getByRole('main').getByTestId(`board-count-${columnId}`);
  const scroller = columnScroller(page, columnId);
  await expect
    .poll(
      async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        return (await badge.textContent())?.trim();
      },
      { message: `lane ${columnId} pages to its full ${total}`, timeout: 60_000 },
    )
    .toBe(total.toLocaleString('en-US'));
}

/** The swimlane board's twin of {@link scrollLaneToEnd} (MOTIR-10655): bring one
 *  column's sentinel in the board's footer row into view, again and again, until
 *  the column's pinned badge reads the bare total. The swimlane grid scrolls as
 *  one, against the page, so the sentinel itself is the scroll target.
 *
 *  The scroll is a plain `scrollIntoView` on whatever sentinel is there, NEVER a
 *  Locator action on it: the sentinel exists only while its column has more
 *  (`LaneLoadFooter` renders nothing once the cursor is spent), so it unmounts the
 *  moment the LAST page lands. A `scrollIntoViewIfNeeded()` issued after that
 *  waits for an element that will never come back, the poll times out holding the
 *  badge it read one page earlier, and a lane that loaded in full reads
 *  "60 of 64". */
export async function scrollSwimlaneColumnToEnd(
  page: Page,
  columnId: string,
  total: number,
): Promise<void> {
  const main = page.getByRole('main');
  const badge = main.getByTestId(`board-count-${columnId}`);
  await expect
    .poll(
      async () => {
        await main.evaluate((el, id) => {
          el.querySelector(`[data-testid="board-lane-sentinel-${id}"]`)?.scrollIntoView({
            block: 'end',
          });
        }, columnId);
        return (await badge.textContent())?.trim();
      },
      { message: `swimlane column ${columnId} pages to its full ${total}`, timeout: 60_000 },
    )
    .toBe(total.toLocaleString('en-US'));
}

/** Assert a column is DOM-bounded: its mounted card-node count is > 0 but well
 *  below its full total — i.e. it virtualized rather than mounting every row.
 *  `total` is the column's full `totalCount` (from the projection / count badge). */
export async function expectColumnVirtualized(
  page: Page,
  columnId: string,
  total: number,
): Promise<void> {
  const nodes = columnCardNodes(page, columnId);
  await expect(nodes.first()).toBeVisible();
  const mounted = await nodes.count();
  expect(mounted, 'mounted card nodes').toBeGreaterThan(0);
  expect(mounted, 'mounted < total (virtualized)').toBeLessThan(total);
}

/** Assert NO "Load more" BUTTON exists anywhere on the board: a lane pages as
 *  it scrolls (MOTIR-10535, `board.mock.html` panel 4), never on a click. The
 *  failed-page retry is the one button a lane footer may show, and only after a
 *  page failed — so a healthy board shows no "load more" text at all either. */
export async function expectNoLoadMore(page: Page): Promise<void> {
  await expect(page.getByText(/load more/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);
}

// ── At-scale SCRUM helpers (Subtask 4.7.1) ──────────────────────────────────
// The Scrum analogue of the 3.5.1 at-scale helpers above, for the cross-cutting
// Scrum journey specs (4.7.2 load model + scope + header · 4.7.3 interaction +
// complete). They drive the SPRINT-shaped seed (`SEED_SHAPE=scrum`,
// scripts/seed-large.ts → seedLargeScrumSprint), which flips the BIG project's
// board to scrum and gives it a large `active` sprint. Additive — they do not
// touch the 3.5.1 board helpers. The page helpers lean on the SAME stable board
// testids the kanban specs use, plus the scrum header surface defined by the
// `design/boards/scrum.mock.html` (4.5.1) mockup that Story 4.5.3 builds:
// `sprint-header`, a `points-summary` carrying the committed/completed/remaining
// figures in its aria-label, and a per-column `board-points-<columnId>` pill.

/** Sign in as the sprint-shaped seed's tenant owner and open the loaded Scrum
 *  board. The scrum seed reuses the SAME tenant owner as the board seed (it
 *  composes `seedLargeBoard`), with the project's board flipped to scrum + a
 *  large active sprint — so `/boards` renders the sprint-scoped board. The single
 *  entry point the Scrum at-scale specs use to reach a fully-populated active
 *  sprint over the real stack. */
export async function signInScrumSeedOwnerAndOpenScrumBoard(
  page: Page,
  loadTimeout = 30_000,
): Promise<void> {
  await signIn(page, SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD);
  await gotoLoadedBoard(page, loadTimeout);
}

/** The sprint header's committed / completed / remaining story points, parsed
 *  from the `points-summary` aria-label inside `[data-testid="sprint-header"]`
 *  (the 4.5.1 design: `aria-label="Story points: 34 committed, 12 completed, 22
 *  remaining"`). The figures come from the 4.5.2 bounded aggregates, so they
 *  reflect the WHOLE sprint — not a loaded page's sum. */
export async function readSprintHeaderPoints(
  page: Page,
): Promise<{ committed: number; completed: number; remaining: number }> {
  const summary = page
    .getByTestId('sprint-header')
    .locator('[aria-label*="committed"][aria-label*="completed"]');
  const label = (await summary.getAttribute('aria-label')) ?? '';
  const num = (word: string): number => {
    const m = label.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+${word}`, 'i'));
    expect(m, `"${word}" figure in sprint-header aria-label "${label}"`).toBeTruthy();
    return Number(m![1]);
  };
  return { committed: num('committed'), completed: num('completed'), remaining: num('remaining') };
}

/** A column's per-column story-point pill value (`board-points-<columnId>`, the
 *  scrum-only addition to the column header in the 4.5.1 design). Distinct from
 *  {@link columnTotalBadge} (the issue COUNT). */
export async function columnPointPill(page: Page, columnId: string): Promise<number> {
  const text = await page.getByTestId(`board-points-${columnId}`).textContent();
  return Number((text ?? '').replace(/[^\d.]/g, ''));
}

/** Every card id currently mounted on the board, across all columns — the basis
 *  for an "is / isn't in the active sprint scope" assertion over the projection
 *  (the scrum board renders ONLY the active sprint's issues, so an id present
 *  here is in scope; an out-of-sprint id is absent). Works off the API
 *  projection {@link getBoard}, so it is independent of virtualization. */
export function allBoardCardIds(board: BoardProjectionDto): string[] {
  return board.columns.flatMap((c) => c.cards.map((card) => card.id));
}

/** Assert the projection is a scrum board scoped to an active sprint: `sprint`
 *  is non-null, and an optional in-sprint id IS rendered while an optional
 *  out-of-sprint id is absent (the seed leaves a backlog slice outside the
 *  sprint). */
export function expectActiveSprintScope(
  board: BoardProjectionDto,
  opts: { present?: string; absent?: string } = {},
): void {
  expect(board.sprint, 'scrum board has an active sprint summary').not.toBeNull();
  const ids = new Set(allBoardCardIds(board));
  if (opts.present) expect(ids.has(opts.present), `in-sprint ${opts.present} on board`).toBe(true);
  if (opts.absent) expect(ids.has(opts.absent), `out-of-sprint ${opts.absent} absent`).toBe(false);
}

// ── At-scale interaction helpers (lifted from board-at-scale-interaction.spec.ts,
// Subtask 3.5.3) ─────────────────────────────────────────────────────────────
// The pointer-drag / swimlane / WIP gestures the at-scale interaction journeys
// drive. Originally written for 3.2.7 (board-ui) / 3.3.7 (board-swimlanes),
// copied into the 3.5.3 spec, and lifted HERE for the third consumer — the
// at-scale Scrum interaction journey (4.7.3) — per the module's lift pattern.

/** Resolve a card id → its board identifier (the `board-card-<identifier>` testid). */
export function identifierOf(board: BoardProjectionDto, id: string): string {
  for (const col of board.columns) {
    const card = col.cards.find((c) => c.id === id);
    if (card) return card.identifier;
  }
  throw new Error(`card ${id} not found on the board`);
}

/** The committed assignee of a card id (scans the projection); null if unassigned
 *  or the card is not found. A single read — the retry helper polls with it. */
export function assigneeOf(board: BoardProjectionDto, id: string): string | null {
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === id);
  return card ? card.assigneeId : null;
}

// The column's internal scroll viewport (the `.col-body` overflow-y-auto div in
// BoardColumn) — the element `useRowWindow` windows against. Setting its scrollTop
// fires the scroll event the hook listens to, so the window recomputes.
export function columnScroller(page: Page, columnId: string): Locator {
  return page.getByTestId(`board-column-${columnId}`).locator('div.overflow-y-auto').first();
}

/** Scroll a virtualized column far enough that a card NOT in its initial row-window
 *  mounts, and return that deep card's identifier. Proves the at-scale precondition
 *  the drag tests need: a card reachable only by scrolling (virtualization), not by
 *  paging. Asserts the column virtualized first (mounted ≪ total). */
export async function revealDeepCard(page: Page, columnId: string, total: number): Promise<string> {
  await expectColumnVirtualized(page, columnId, total);
  const nodes = columnCardNodes(page, columnId);
  const testidsOf = async () =>
    (await nodes.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).filter(
      Boolean,
    );
  const initial = new Set(await testidsOf());

  // Scroll roughly to the middle of the stack, then poll until a card that was NOT
  // in the initial window has mounted and laid out.
  const scroller = columnScroller(page, columnId);
  await scroller.evaluate((el) => {
    el.scrollTop = Math.floor(el.scrollHeight * 0.55);
  });

  let deepTestId = '';
  await expect
    .poll(
      async () => {
        const now = await testidsOf();
        const fresh = now.find((tid) => !initial.has(tid));
        if (fresh) deepTestId = fresh;
        return Boolean(fresh);
      },
      { message: 'a card below the initial window mounted after scrolling', timeout: 10_000 },
    )
    .toBe(true);

  const identifier = deepTestId.replace('board-card-', '');
  await expect(page.getByTestId(deepTestId)).toBeVisible();
  return identifier;
}

/** A REAL pointer drag from one element onto another, clearing dnd-kit's 8px
 *  PointerSensor activation distance before settling over the target, then
 *  dropping. Returns the `/api/board/move` POST the drop fires so the caller can
 *  assert its status (200 legal · 409 illegal). `dropYFrac` places the drop within
 *  the target's height. Lifted from board-ui.spec.ts (3.2.7). */
export async function pointerDragForMove(
  page: Page,
  from: Locator,
  to: Locator,
  dropYFrac = 0.4,
): ReturnType<Page['waitForResponse']> {
  // Settle BOTH into view BEFORE measuring (the dragCardOntoCell rule below):
  // scrolling the target after capturing the source box invalidates the source
  // coords whenever the target scroll shifts the page — on the scrum board the
  // sprint header above the columns makes exactly that happen, and the pickup
  // grabs the card a row off. Then wait for the source box to be STABLE across
  // two reads: a virtualized column re-windows asynchronously after a
  // programmatic scroll, shifting rows between a too-early measure and the grab.
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  let f = (await from.boundingBox())!;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(100);
    const next = (await from.boundingBox())!;
    const stable = next.x === f.x && next.y === f.y;
    f = next;
    if (stable) break;
  }
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * dropYFrac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 }); // clear the 8px activation
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 }); // settle so the over-target sticks
  const move = page.waitForResponse(
    (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.mouse.up();
  return move;
}

/** A real pointer drag from a board card onto a swimlane LANE CELL (the
 *  `lane-cell-<col>-<lane>` droppable that owns the reassign), mirroring the
 *  activation-distance gesture board-swimlanes.spec.ts uses; the caller polls
 *  committed state (a swimlane reassign goes through the field path, not
 *  /api/board/move, so there is no single response to await). Drops at the cell's
 *  CENTRE: the board resolves the over via dnd-kit `closestCenter`, which keys off
 *  the dragged card's centre, so a centre-on-cell drop pins the destination
 *  (lane, column) cell. Dropping onto a CARD inside another lane only re-sorts;
 *  the lane-cell droppable is what triggers the cross-lane reassign. */
export async function dragCardOntoCell(
  page: Page,
  cardTestId: string,
  target: Locator,
): Promise<void> {
  const card = page.getByTestId(cardTestId);
  // Settle BOTH into view BEFORE measuring — capturing the source box and THEN
  // scrolling the target would invalidate the source coords. Source + target
  // lanes are adjacent + short here, so both fit on screen.
  //
  // ⚠️ THE SOURCE IS SCROLLED LAST, AND THE ORDER IS THE FIX (MOTIR-2427).
  // Scrolling the source first and the target second left the source under the
  // STICKY HEADER: its box was still accurate, so nothing looked wrong, but the
  // centre landed on the app chrome and `mouse.down()` grabbed the header
  // instead of the card. Every retry recomputed the identical bad point, so a
  // 4× retry loop failed 4× the same way — a silent mis-press, never a missed
  // drop. (Read off the trace: pickup y = 24 under a ~64px header, four
  // byte-identical attempts.) Pressing the wrong element is the failure that
  // cannot recover, so the PICKUP gets the last scroll and the drop tolerates
  // the drift.
  await target.scrollIntoViewIfNeeded();
  await card.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  // Fail LOUDLY rather than pressing chrome. The premise of this helper is that
  // both cells fit on screen at once; when a layout change breaks it, the test
  // that says so is worth more than a drag that silently does nothing.
  const viewport = page.viewportSize();
  if (viewport) {
    const header = 64;
    if (fy < header || fy > viewport.height) {
      throw new Error(
        `drag pickup (${fx}, ${fy}) is outside the usable viewport (header ${header}, height ${viewport.height}) — ` +
          'the source card is not fully on screen, so the press would land on the app chrome',
      );
    }
  }
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 24, fy, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 });
  await page.waitForTimeout(80); // let dnd-kit's onDragOver settle on the target cell
  await page.mouse.up();
}

/** Drag a card onto a lane cell and RETRY until the committed projection satisfies
 *  `predicate`, or the attempts run out. dnd-kit pointer drags onto one of several
 *  vertically-stacked lane cells are pixel-sensitive — an occasional drop lands a
 *  lane off; re-dragging the same card (now wherever it landed) onto the target
 *  cell converges. Returns whether the predicate held. The reassign/transition is
 *  idempotent, so a repeat drop that already succeeded is a no-op. */
export async function dragIntoCellUntil(
  page: Page,
  srcCardKey: string,
  target: Locator,
  predicate: (board: BoardProjectionDto) => boolean,
  attempts = 4,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await dragCardOntoCell(page, `board-card-${srcCardKey}`, target);
    for (let poll = 0; poll < 10; poll++) {
      if (predicate(await getBoard(page.request))) return true;
      await page.waitForTimeout(100);
    }
  }
  return false;
}

/** Pick the active group-by dimension via the board-header Segmented control,
 *  awaiting the PATCH so the server-side persistence has landed. From
 *  board-swimlanes.spec.ts (3.3.7). */
export async function setGroupBy(
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

/** Set a column's WIP limit through its [⋯] menu's "Set WIP limit" editor, awaiting
 *  the PATCH so the write has landed before asserting the over/at-limit treatment.
 *  From board-swimlanes.spec.ts (3.3.7). */
export async function setColumnWip(page: Page, columnId: string, value: string): Promise<void> {
  await page.getByTestId(`board-column-actions-${columnId}`).click();
  await page.getByRole('button', { name: 'Set WIP limit' }).click();
  await page.getByTestId(`board-wip-input-${columnId}`).fill(value);
  const patch = page.waitForResponse(
    (r) =>
      new RegExp(`/api/board/columns/${columnId}$`).test(r.url()) &&
      r.request().method() === 'PATCH',
  );
  // `exact` — the board toolbar now mounts the [Saved] filter picker (6.15.3),
  // whose accessible name "Saved filters — apply, star, or search" substring-
  // matches a bare "Save", so a non-exact match resolves 2 elements.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patch).ok(), `set WIP ${value} on ${columnId} persisted`).toBeTruthy();
}

/**
 * A viewport wide enough that EVERY default column fits with no horizontal
 * scrolling — DERIVED from the shipped workflow, never pinned (MOTIR-2427).
 *
 * ⚠️ Why this is not a number. The at-scale drag specs pinned 1920 with the
 * comment "wide enough for all six default columns (6 × 18rem ≈ 1728px) so a
 * cross-column pointer drag never has to chase a horizontally-scrolling
 * target". `Planning` (MOTIR-2425) made it SEVEN — 7 × 18rem = 2016px — so the
 * board began scrolling horizontally and the pointer drags started missing, in
 * exactly the way that comment said the width existed to prevent. The invariant
 * was written down and the number quietly stopped satisfying it.
 *
 * Expressed as the arithmetic instead, so the next status to arrive widens the
 * viewport rather than breaking a drag.
 */
export function boardViewportWidth(columns: number = DEFAULT_STATUSES.length): {
  width: number;
  height: number;
} {
  const COLUMN_PX = 288; // 18rem at the 16px root the app ships
  const CHROME_PX = 280; // sidebar + page gutters, with slack
  return { width: Math.max(1920, columns * COLUMN_PX + CHROME_PX), height: 1080 };
}
