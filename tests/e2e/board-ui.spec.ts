// E2E: the Kanban board UI — drag-drop transitions, snap-back, in-column
// reorder, and keyboard-DnD (Story 3.2 · Subtask 3.2.7, the Story-closing test).
//
// @smoke — proves the board SURFACE end-to-end through the real shell, on top of
// the 3.1 board API that board-projection.spec.ts (3.1.7) already proves at the
// HTTP layer. This spec drives the actual /boards page in a real browser:
//   - RENDER: the default columns project in workflow order, cards land in the
//     right column, per-column counts show.
//   - LEGAL MOVE: a cross-column drag applies the workflow transition (the
//     move-as-transition contract), the card lands, the count updates, and a
//     re-fetched projection shows the new status.
//   - SNAP-BACK: an illegal cross-column drag returns 409 and the card animates
//     back to its origin column — status unchanged on re-fetch.
//   - REORDER: an in-column drag changes rank only (no transition), and the new
//     order persists on reload.
//   - KEYBOARD DnD: a card moves to another column with the keyboard alone
//     (focus → Space pick up → arrow → Space drop).
//
// It mirrors the setup of board-config.spec.ts (3.6.4): a browser sign-up (the
// creator = workspace owner), one server-seeded project pinned active, work
// items created over the `_test` transport, and the board projection read back
// through the signed-in user's request context for committed-state assertions.
//
// SCOPE: this is the 3.2 board-CARD journey only. It does NOT re-drive the
// WIP-limit / swimlane / large-scale-virtualization journeys — those are the
// Epic-3 test story (3.5) and the 3.2.5 db:seed:large scale check. The reducer
// confirm/revert unit contract + the BoardCard/BoardColumn/unmapped-tray render
// branches are covered by the 3.2.x Vitest component suites (board-move /
// board-card / board-column / board-completeness); this proves them composed,
// over the real stack.

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus, cardIdsIn, boardViewportWidth } from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';

const OWNER_EMAIL = 'e2e-board-ui-owner@example.com';

// The default workflow's six columns, in projection (workflow) order, and the
// legal transitions OUT of `todo` (lib/workflows/defaultWorkflow.ts). The board
// is laid out in this order; the drag tests pick a target whose legality is
// known from this graph.
//   todo → in_progress | blocked | cancelled   (legal)
//   todo → implemented | in_review              (legal — a delivering pull request's, MOTIR-12202)
//   todo → done                                 (illegal — no transition)

// Sign-up auto-creates `<local>'s Workspace`; here we add the one project the
// board hangs off and pin it active so getActiveProject() resolves it on /boards.
// Identical shape to board-config.spec.ts's seedActiveProject.
async function seedActiveProject(
  email: string,
): Promise<{ userId: string; workspaceId: string; projectId: string }> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Board UI Demo',
    identifier: 'BUI',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

// The board card's data-testid is keyed by the work item IDENTIFIER (BUI-1, …),
// not its cuid; the projection is the source of truth for the mapping.
function cardTid(identifier: string): string {
  return `board-card-${identifier}`;
}

// Open /boards and wait for the interactive board to be present (past the
// loading skeleton). The viewport keeps EVERY default column on screen without
// horizontal scroll, so a pointer drag never has to chase a scrolling target.
//
// ⚠️ The width is ARITHMETIC (`boardViewportWidth`), not the literal 1920 it
// used to be — and MOTIR-2999 is why. Adding the `implemented` status put the
// board at 8 columns (~2.3k px), which pushed Done off a 1920 viewport and broke
// the drop-into-Done drag below with a 10s `waitForResponse` timeout: the drag
// never reached the column. That is the exact failure `boardViewportWidth`'s own
// header describes — an invariant written in a comment while the number quietly
// stopped satisfying it — so the number is derived from the status count here
// too, and the NEXT status to arrive widens the viewport rather than breaking a
// drag.
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize(boardViewportWidth());
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
}

// A REAL pointer drag from one element to another, clearing the dnd-kit
// PointerSensor's 8px activation distance before settling over the target, then
// dropping. Returns the `/api/board/move` POST the drop fires (the snapshot of
// the move contract) so the caller asserts its status (200 legal · 409 illegal).
// `dropYFrac` places the drop point within the target's height — the column body
// (below its sticky header) for a cross-column drop, or a sibling card's lower
// half to insert after it for an in-column reorder.
async function pointerDrag(
  page: Page,
  from: Locator,
  to: Locator,
  dropYFrac = 0.4,
): ReturnType<Page['waitForResponse']> {
  const f = (await from.boundingBox())!;
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * dropYFrac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  // Clear the 8px activation constraint, then glide onto the target.
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.mouse.move(tx, ty, { steps: 4 });
  const move = page.waitForResponse(
    (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.mouse.up();
  return move;
}

// ONE drag gesture of the card onto `columnTestId`, AUTO-SCROLLING the
// horizontal column row when that column starts past the fold (bug-board-cannot-
// drag-from-in-review-to-done). On a laptop-width viewport the trailing columns
// (Done, Cancelled) sit off-screen; the fix scrolls the row when the dragged
// card nears the right edge, so this gesture holds the pointer at the row's
// right edge until the target is fully on screen, then drops onto it (the nudge
// loop exits immediately for an already-visible target). It is NON-THROWING and
// makes no assertion — `closestCorners` can resolve `over` to a stale element at
// release (a known dnd-kit quirk this very bug touches), so a single gesture may
// miss; `dragUntilInColumn` wraps it in the CLAUDE.md "retry the gesture until
// it commits" loop. A missed/rejected move changes nothing server-side, so
// re-dragging is safe.
async function dragGesture(
  page: Page,
  cardIdentifier: string,
  columnTestId: string,
  dropYFrac = 0.4,
): Promise<void> {
  const from = page.getByTestId(cardTid(cardIdentifier));
  const f = await from.boundingBox();
  if (!f) return; // card not mounted (e.g. transiently); the caller will retry
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  // Clear the 8px activation constraint.
  await page.mouse.move(f.x + 14, f.y + 8, { steps: 5 });

  const board = page.getByTestId('board');
  const target = page.getByTestId(columnTestId);
  const vw = page.viewportSize()!.width;
  const boardBox = (await board.boundingBox())!;
  const edgeX = boardBox.x + boardBox.width - 6;
  const midY = boardBox.y + boardBox.height / 2;
  const fullyVisible = (b: { x: number; width: number } | null) =>
    !!b && b.x >= 0 && b.x + b.width <= vw;

  // PHASE A — bring the target on screen IF it is past the fold: hold the
  // pointer at the row's right edge so the fix's edge auto-scroll advances
  // `scrollLeft`. Bounded; if the target is already fully visible this exits at
  // once and no scroll happens.
  let scrolled = false;
  for (let i = 0; i < 80; i++) {
    if (fullyVisible(await target.boundingBox())) break;
    scrolled = true;
    await page.mouse.move(edgeX - (i % 2), midY + (i % 3), { steps: 2 });
    await page.waitForTimeout(40);
  }
  if (scrolled) {
    // Move off the edge band so auto-scroll halts, then wait for `scrollLeft` to
    // settle (poll until two consecutive reads match — no fixed-timeout guess);
    // the target's box is only stable once the row stops moving.
    await page.mouse.move(boardBox.x + boardBox.width / 2, midY, { steps: 6 });
    let prevScroll = Number.NaN;
    await expect
      .poll(
        async () => {
          const cur = await board.evaluate((el) => el.scrollLeft);
          const stable = cur === prevScroll;
          prevScroll = cur;
          return stable;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  }

  // PHASE B — drop onto the (now-stable, on-screen) target. Two settling moves
  // onto its body let the live `onDragOver` relocate commit before release.
  const t = await target.boundingBox();
  if (!t) {
    await page.mouse.up();
    return;
  }
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * dropYFrac;
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.mouse.move(tx, ty, { steps: 4 });
  // Give the optimistic relocate a chance to commit before release (non-throwing
  // — if it missed, the retry wrapper re-drags).
  await target
    .getByTestId(cardTid(cardIdentifier))
    .waitFor({ state: 'visible', timeout: 2_000 })
    .catch(() => {});
  await page.mouse.up();
  await page.waitForTimeout(150); // let the move POST + reconcile settle before the next read
}

// Drag the card into `columnTestId` and KEEP RETRYING the gesture until the
// authoritative projection shows it committed to `toStatusKey` (the CLAUDE.md
// dnd discipline: verify the committed state, retry until it lands — never trust
// one drop). Returns once committed; fails loudly if it never lands.
async function dragUntilInColumn(
  page: Page,
  request: APIRequestContext,
  itemId: string,
  cardIdentifier: string,
  columnTestId: string,
  toStatusKey: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (cardIdsIn(await getBoard(request), toStatusKey).includes(itemId)) return true;
        await dragGesture(page, cardIdentifier, columnTestId);
        return cardIdsIn(await getBoard(request), toStatusKey).includes(itemId);
      },
      { timeout: 30_000, intervals: [500, 1_000, 1_500, 2_000] },
    )
    .toBe(true);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Browser sign-up (slow argon2) + several cold route compiles (boards + the
// quick-view chunk) add up; give the journeys headroom over the 30s default.
test.describe.configure({ timeout: 90_000 });

test.describe('board-ui @smoke', () => {
  test('renders the default columns in workflow order with cards grouped by status and per-column counts', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);

    const todoItem = await createItem(page.request, projectId, 'stays in todo');
    const movedItem = await createItem(page.request, projectId, 'goes in progress');
    expect((await transition(page.request, movedItem.id, 'in_progress')).status()).toBe(200);

    // Resolve column ids + card identifiers from the projection (the same data
    // the page renders), so the DOM assertions key off real ids.
    const board = await getBoard(page.request);
    const colIds = board.columns.map((c) => c.id);
    const todoCol = columnByStatus(board, 'todo');
    const inProgCol = columnByStatus(board, 'in_progress');
    const todoCard = todoCol.cards.find((c) => c.id === todoItem.id)!;
    const inProgCard = inProgCol.cards.find((c) => c.id === movedItem.id)!;

    await openBoard(page);

    // Every default column renders, in workflow order (the DOM column sequence
    // equals the projection's ordered column ids).
    // Scope to the column SECTIONs — the `board-column-` prefix also matches the
    // per-column `board-column-actions-<id>` menu button, which is not a column.
    const domColIds = await page
      .getByTestId('board')
      .locator('section[data-testid^="board-column-"]')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('board-column-', '')),
      );
    expect(domColIds).toEqual(colIds);

    // Cards land in the right column…
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(todoCard.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${inProgCol.id}`).getByTestId(cardTid(inProgCard.identifier)),
    ).toBeVisible();

    // …and the per-column total-count badges match.
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('1');
    await expect(page.getByTestId(`board-count-${inProgCol.id}`)).toHaveText('1');
  });

  test('a legal cross-column drag applies the transition — the card lands, counts update, the new status persists', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'drag me forward');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const inProgCol = columnByStatus(board, 'in_progress'); // todo → in_progress is legal
    const card = todoCol.cards.find((c) => c.id === item.id)!;

    await openBoard(page);

    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(card.identifier)),
      page.getByTestId(`board-column-${inProgCol.id}`),
    );
    expect(res.status(), 'a legal move returns 200').toBe(200);

    // The card now lives in the In Progress column in the DOM…
    await expect(
      page.getByTestId(`board-column-${inProgCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toHaveCount(0);
    // …the optimistic counts reconciled (To Do 0, In Progress 1)…
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('0');
    await expect(page.getByTestId(`board-count-${inProgCol.id}`)).toHaveText('1');

    // …and the move persisted as a real workflow transition (re-fetch).
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'in_progress')).toEqual([item.id]);
    expect(cardIdsIn(after, 'todo')).not.toContain(item.id);
  });

  test('an illegal cross-column drag snaps the card back to its origin column — status unchanged', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'cannot go back to the queue');
    // Park it at Implemented via the API. `implemented → todo` has NO transition —
    // a built card goes back through In Progress. (`todo → in_review` was this
    // test's example until MOTIR-12202 declared it, for a pull request delivering a
    // To Do card; both columns here are on screen at the default width.)
    expect((await transition(page.request, item.id, 'in_progress')).status()).toBe(200);
    expect((await transition(page.request, item.id, 'implemented')).status()).toBe(200);

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const implementedCol = columnByStatus(board, 'implemented');
    const card = implementedCol.cards.find((c) => c.id === item.id)!;

    await openBoard(page);

    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(card.identifier)),
      page.getByTestId(`board-column-${todoCol.id}`),
    );
    expect(res.status(), 'an illegal move returns 409').toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');

    // The rejection is surfaced (a toast), and the card animates BACK to
    // Implemented — it never rests in the To Do column it was dropped on. `exact`
    // keeps the toast TITLE distinct from the aria-live announcement, which embeds
    // the same phrase in a longer "Notification Move not allowed…" string.
    await expect(page.getByText('Move not allowed', { exact: true })).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${implementedCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toHaveCount(0);
    await expect(page.getByTestId(`board-count-${implementedCol.id}`)).toHaveText('1');
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('0');

    // The status is untouched on re-fetch — the snap-back was visual only.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'implemented')).toContain(item.id);
    expect(cardIdsIn(after, 'todo')).not.toContain(item.id);
  });

  test('an in-column drag reorders rank only — no transition, and the order survives a reload', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const a = await createItem(page.request, projectId, 'card A'); // created first → ranks above
    const b = await createItem(page.request, projectId, 'card B');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    expect(cardIdsIn(board, 'todo')).toEqual([a.id, b.id]);
    const aCard = todoCol.cards.find((c) => c.id === a.id)!;
    const bCard = todoCol.cards.find((c) => c.id === b.id)!;

    await openBoard(page);

    // Drag A onto B's lower half → A drops AFTER B (rank change within To Do).
    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(aCard.identifier)),
      page.getByTestId(cardTid(bCard.identifier)),
      0.85,
    );
    expect(res.status(), 'an in-column reorder returns 200').toBe(200);
    const moved = (await res.json()) as { appliedStatus: string };
    expect(moved.appliedStatus, 'no transition on a rank-only move').toBe('todo');

    // Order flipped, both cards still in To Do (membership + status unchanged),
    // count unchanged.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'todo')).toEqual([b.id, a.id]);
    expect(columnByStatus(after, 'todo').totalCount).toBe(2);

    // And the new order is durable — it persisted server-side as a rank change.
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    const reloaded = await getBoard(page.request);
    expect(cardIdsIn(reloaded, 'todo')).toEqual([b.id, a.id]);
  });

  test('a card moves to another column using the keyboard alone (pick up · arrow · drop)', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const mover = await createItem(page.request, projectId, 'keyboard mover');
    // Seed the adjacent destination column (Blocked, the next column right of To
    // Do; todo → blocked is a legal transition) with a card, so the keyboard
    // navigation has a concrete sortable target to land on rather than an empty
    // droppable.
    const anchor = await createItem(page.request, projectId, 'lives in blocked');
    expect((await transition(page.request, anchor.id, 'blocked')).status()).toBe(200);

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const moverCard = todoCol.cards.find((c) => c.id === mover.id)!;

    await openBoard(page);

    // dnd-kit narrates the drag through an `aria-live` region; the joined live
    // text is the deterministic signal that the keyboard drag has advanced (and
    // doubles as the a11y-announcement check). Polling it between key presses
    // avoids racing the next key against an async drag-state transition (a
    // back-to-back Space→Arrow fires the arrow before the pick-up is live).
    const liveText = async () =>
      (await page.locator('[role="status"]').allTextContents()).join(' ');

    // Focus the card, pick it up (Space) → wait for the pick-up announcement, move
    // one column to the right (→ Blocked) → wait for the over-Blocked
    // announcement, then drop (Space) — all with the keyboard, no pointer.
    await page.getByTestId(cardTid(moverCard.identifier)).focus();
    await page.keyboard.press('Space');
    await expect.poll(liveText).toContain(moverCard.identifier);
    await page.keyboard.press('ArrowRight');
    await expect.poll(liveText).toContain('Blocked');
    const move = page.waitForResponse(
      (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.keyboard.press('Space');
    const res = await move;
    expect(res.status(), 'the keyboard move is a legal transition (200)').toBe(200);

    // The move happened via a real transition: the card left To Do and landed in
    // the Blocked column.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'todo')).not.toContain(mover.id);
    expect(cardIdsIn(after, 'blocked')).toContain(mover.id);
  });
});

// Regression for bug-board-cannot-drag-from-in-review-to-done. The default
// workflow's trailing columns render PAST the horizontal fold on a laptop-width
// viewport. Before the fix, dragging a card toward an off-screen column did
// nothing — the row never scrolled, so the off-screen column never became the
// drop target and the move silently snapped back with no `POST /api/board/move`.
// The user hit this on the `in_review → done` edge, In Review being the last
// on-screen column and Done the first off-screen one.
test.describe('board-ui auto-scroll to off-screen columns @smoke', () => {
  // ⚠️ MEASURED, NOT PINNED (MOTIR-2425). This was `const NARROW = 1500`, a
  // number chosen when the default workflow had six columns and In Review was
  // the fourth — it ended at ~1472, so 1500 put Done just past the fold.
  // Adding `planning` made In Review the FIFTH column and pushed its right edge
  // to roughly 1780, so at 1500 the source card would itself have been
  // off-screen and the drag would have failed for a reason that has nothing to
  // do with the bug under test.
  //
  // A recalibrated literal would only survive until the next status. So the
  // width is now derived from the layout it depends on: render wide, measure
  // where In Review actually ends, and shrink to just past it. The test's claim
  // — "the LAST ON-SCREEN column drags into the FIRST OFF-SCREEN one" — is then
  // true by construction at whatever width the board happens to need.
  const WIDE = 2600;
  const GUTTER = 24;

  /**
   * Open the board at a width where `sourceStatus`'s column is the last one
   * fully on screen. Returns that width so the callers can assert against it.
   */
  async function openNarrowBoard(page: Page, sourceColumnId: string): Promise<number> {
    await page.setViewportSize({ width: WIDE, height: 1080 });
    await page.goto('/boards');
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });

    const sourceBox = await page.getByTestId(`board-column-${sourceColumnId}`).boundingBox();
    expect(sourceBox, 'the source column has a box at full width').not.toBeNull();
    const narrow = Math.ceil(sourceBox!.x + sourceBox!.width) + GUTTER;

    await page.setViewportSize({ width: narrow, height: 1080 });
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    return narrow;
  }

  test('a card drags from the last on-screen column into the OFF-SCREEN Done column — the row auto-scrolls and the move commits', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'review to done');
    // Park it in In Review (the last on-screen column) via the API.
    expect((await transition(page.request, item.id, 'in_progress')).status()).toBe(200);
    expect((await transition(page.request, item.id, 'in_review')).status()).toBe(200);

    const board = await getBoard(page.request);
    const inReviewCol = columnByStatus(board, 'in_review');
    const doneCol = columnByStatus(board, 'done');
    const card = inReviewCol.cards.find((c) => c.id === item.id)!;

    const narrow = await openNarrowBoard(page, inReviewCol.id);

    // Preconditions, BOTH of them: In Review is fully reachable (the card has to
    // be grabbable) and Done is genuinely off-screen (otherwise the test never
    // exercises the auto-scroll path the bug is about). The first used to be
    // implicit in the pinned width, which is how a status added elsewhere could
    // have turned this into an unexplained drag failure.
    const inReviewBox = await page.getByTestId(`board-column-${inReviewCol.id}`).boundingBox();
    expect(inReviewBox, 'In Review column has a box').not.toBeNull();
    expect(
      inReviewBox!.x + inReviewBox!.width,
      'In Review is fully on screen — the card must be grabbable',
    ).toBeLessThanOrEqual(narrow);

    const doneBox = await page.getByTestId(`board-column-${doneCol.id}`).boundingBox();
    expect(doneBox, 'Done column has a box').not.toBeNull();
    expect(
      (doneBox!.x ?? 0) + (doneBox!.width ?? 0),
      'Done column starts off-screen at laptop width',
    ).toBeGreaterThan(narrow);

    // Drag In Review → the off-screen Done column. Auto-scroll brings Done in;
    // the move commits to `done` (verified against the authoritative projection,
    // retrying the gesture until it lands).
    await dragUntilInColumn(
      page,
      page.request,
      item.id,
      card.identifier,
      `board-column-${doneCol.id}`,
      'done',
    );

    // The card lands in Done in the DOM, and left In Review.
    await expect(
      page.getByTestId(`board-column-${doneCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toBeVisible();
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'done')).toContain(item.id);
    expect(cardIdsIn(after, 'in_review')).not.toContain(item.id);

    // …and it survives a reload (committed server-side, not just optimistic).
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    const reloaded = await getBoard(page.request);
    expect(cardIdsIn(reloaded, 'done')).toContain(item.id);
  });

  test('the full forward path drags edge-by-edge — todo → in_progress → in_review → done — each transition commits', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'walks the lifecycle');

    const board = await getBoard(page.request);
    const colId = (key: string) => columnByStatus(board, key).id;
    // The board card's testid keys off the work item IDENTIFIER (BUI-N), which
    // the projection carries — createItem returns only { id, status }.
    const ident = columnByStatus(board, 'todo').cards.find((c) => c.id === item.id)!.identifier;

    // Same width rule as above: In Review is the last column fully on screen,
    // so the final edge of the walk is the one that has to auto-scroll.
    await openNarrowBoard(page, colId('in_review'));

    // Each forward edge of the default workflow, dragged in turn on the SAME
    // card. The last one (in_review → done) targets the off-screen column and
    // exercises auto-scroll; the earlier ones are on-screen. Each edge verifies
    // the card committed to the target status (and lands in its DOM column)
    // before moving to the next.
    const edges: Array<[from: string, to: string]> = [
      ['todo', 'in_progress'],
      ['in_progress', 'in_review'],
      ['in_review', 'done'],
    ];
    for (const [, toKey] of edges) {
      await dragUntilInColumn(
        page,
        page.request,
        item.id,
        ident,
        `board-column-${colId(toKey)}`,
        toKey,
      );
      await expect(
        page.getByTestId(`board-column-${colId(toKey)}`).getByTestId(cardTid(ident)),
      ).toBeVisible();
    }

    // Final committed state: the card is in Done after the whole forward walk.
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    expect(cardIdsIn(await getBoard(page.request), 'done')).toContain(item.id);
  });
});

// Regression for the terminal-column rank 500. The Done/Cancelled columns are
// displayed ranked by RECENCY (most-recently-resolved first), not by
// `position` — so two display-adjacent Done cards can be position-INVERTED
// (the upper one's `position` sorts AFTER the lower one's). Dropping a card
// between them made `boardsService.moveCard` call keyBetween(prev, next) with
// prev > next, which threw ("prev >= next") → the move API 500'd and the board
// showed the generic "Move not allowed" toast. The fix brackets the bounds by
// their actual key order before keyBetween.
test.describe('board-ui drop into a recency-ordered Done column @smoke', () => {
  test('a card drops between two position-inverted Done cards — the move commits, not 500', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);

    // Two cards resolved to Done IN CREATION ORDER, so their `doneAt` recency is
    // the REVERSE of their `position` (created first = smaller position, but
    // resolved first = older = lower in the recency-ranked column). The Done
    // column therefore shows them position-inverted.
    const first = await createItem(page.request, projectId, 'done first (older)');
    const second = await createItem(page.request, projectId, 'done second (newer)');
    for (const it of [first, second]) {
      expect((await transition(page.request, it.id, 'in_progress')).status()).toBe(200);
      expect((await transition(page.request, it.id, 'in_review')).status()).toBe(200);
      expect((await transition(page.request, it.id, 'done')).status()).toBe(200);
    }
    // The mover, parked in In Review (in_review → done is a legal transition).
    const mover = await createItem(page.request, projectId, 'mover');
    expect((await transition(page.request, mover.id, 'in_progress')).status()).toBe(200);
    expect((await transition(page.request, mover.id, 'in_review')).status()).toBe(200);

    const board = await getBoard(page.request);
    const doneCol = columnByStatus(board, 'done');
    const moverCard = columnByStatus(board, 'in_review').cards.find((c) => c.id === mover.id)!;
    // The two Done cards in DISPLAY order; assert they are position-inverted so
    // the test actually exercises the inverted-neighbour path.
    const doneDisplay = doneCol.cards;
    expect(doneDisplay.length).toBe(2);
    expect(doneDisplay[0]!.position > doneDisplay[1]!.position).toBe(true);

    await openBoard(page); // wide enough for every column — Done is on screen

    // Drop the mover onto the LOWER HALF of the top Done card, so it inserts
    // BETWEEN the two display cards — i.e. between two position-inverted
    // neighbours (the case that used to 500).
    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(moverCard.identifier)),
      page.getByTestId(cardTid(doneDisplay[0]!.identifier)),
      0.85,
    );
    expect(res.status(), 'the drop into Done commits (200), not 500').toBe(200);

    // It landed in Done and persisted as a real transition.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'done')).toContain(mover.id);
    expect(cardIdsIn(after, 'in_review')).not.toContain(mover.id);
  });
});
