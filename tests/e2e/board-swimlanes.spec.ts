// E2E: board SWIMLANES + WIP — the Story-3.3 closing journey through the real
// stack (Subtask 3.3.7).
//
// @smoke — proves the 3.3 layer Story 3.3 exists to deliver, driven end-to-end
// through the real shell on top of the proven 3.1 projection + 3.2 Kanban UI:
//   * GROUP-BY — the board re-lays into one lane per assignee-with-cards + a
//     "No assignee" catch-all (sorted last); switching to Priority / Epic / None
//     regroups / flattens (the group-by persists on the board, server-side).
//   * COLLAPSE — collapsing a lane hides its cards but keeps the header + count,
//     and the choice persists client-side across a reload.
//   * CROSS-LANE REASSIGN — dragging a card into another assignee lane reassigns
//     the assignee (NOT the board/move endpoint, the 2.5 field path) with the
//     status unchanged; dropping into the catch-all UNASSIGNS it.
//   * WIP SOFT WARNING — a per-column WIP limit below the card count shows the
//     over-limit treatment (`n/limit` + icon, not colour-alone); a drop into the
//     over-limit column still SUCCEEDS (soft, never blocked); clearing the limit
//     removes the warning; a column AT its limit is not warned.
//
// The component/unit layer is already proven by the 3.3.2–3.3.6 Vitest suites
// (board-config-service / swimlane-projection / board-swimlanes / board-column /
// board-swimlanes-render), so this spec does NOT re-assert reducers, the
// over-limit predicate, or the projection internals — it owns the cross-cutting
// end-to-end journey only. The combined drag + WIP + swimlane journey AT SCALE
// is deferred to the Epic-3 test story (Story 3.5), per the Subtask card.
//
// Setup mirrors board-config.spec.ts: the signed-up user is the workspace OWNER
// (creator = owner, finding #36); the project is created server-side
// (projectsService) + pinned active; a second member is minted so two assignee
// lanes render. Work items are created + assigned through the `_test` transport
// (the sanctioned cross-layer reach for E2E SETUP); the SWIMLANE/WIP behaviour
// itself is driven through the real board UI.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, SHELL_PASSWORD } from './_helpers/shell-session';
import { getBoard, getFullBoard, columnByStatus, waitForMoveWrite } from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import type { BoardProjectionDto } from '@/lib/dto/boards';

const OWNER_EMAIL = 'e2e-board-swimlanes-owner@example.com';
const MEMBER_EMAIL = 'e2e-board-swimlanes-member@example.com';
// The catch-all swimlane key (BOARD_SWIMLANE_NO_VALUE) — the "No assignee" /
// "No epic" lane that always sorts last.
const CATCH_ALL = '__no_value__';

interface Seeded {
  ownerId: string;
  memberId: string;
  projectId: string;
}

// Sign-up auto-creates `<local>'s Workspace`; here we add the one active project
// the board hangs off, pin it active (so getActiveProject() resolves it on every
// /boards render), and mint a SECOND workspace member so a card assigned to them
// produces a distinct assignee lane. Mirrors board-config.spec.ts's
// seedActiveProject + its non-owner-member shape.
async function seedProjectAndMember(email: string): Promise<Seeded> {
  const local = email.split('@')[0]!;
  const owner = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(owner, 'owner should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: owner!.id,
    name: 'Swimlanes Demo',
    identifier: 'SWM',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });

  // A second member, so a card assigned to them renders its own assignee lane
  // (they never sign in — they only need to be a valid assignee in the workspace).
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: SHELL_PASSWORD,
    name: 'Morgan Member',
  });
  await db.workspaceMembership.create({
    data: { userId: member.id, workspaceId: ws!.id, workspaceRole: 'member' },
  });
  // Story 6.10.4: a workspace member is also an org member (the upward invariant
  // the org access gate enforces). This member is only an assignee here, but keep
  // the fixture consistent with the invariant.
  await db.organizationMembership.create({
    data: { organizationId: ws!.organizationId, userId: member.id, role: 'member' },
  });

  return { ownerId: owner!.id, memberId: member.id, projectId: project.id };
}

/** Create a To Do work item and return its id (the `_test` transport). */
async function newItem(page: Page, projectId: string, title: string): Promise<string> {
  const { id } = await createItem(page.request, projectId, title);
  return id;
}

/** Assign a work item to a member via the `_test` free-form patch (E2E setup). */
async function assign(page: Page, id: string, assigneeId: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}`, {
    data: { assigneeId },
  });
  expect(res.ok(), `assign ${id} → ${assigneeId}`).toBeTruthy();
}

/** Resolve a card id → its board identifier (the `board-card-<identifier>` testid).
 *  On a grouped board the board passed is {@link getFullBoard}'s: its columns are
 *  built from the lane and cell pages the grid reads (MOTIR-11452). */
function identifierOf(board: BoardProjectionDto, id: string): string {
  for (const col of board.columns) {
    const card = col.cards.find((c) => c.id === id);
    if (card) return card.identifier;
  }
  throw new Error(`card ${id} not found on the board`);
}

/** Pick the active group-by dimension via the board-header group-by menu. */
async function setGroupBy(
  page: Page,
  label: 'None' | 'Assignee' | 'Epic' | 'Priority',
): Promise<void> {
  const control = page.getByRole('group', { name: 'Swimlane group by' });
  const patch = page.waitForResponse(
    (r) => r.url().endsWith('/api/board') && r.request().method() === 'PATCH',
  );
  // The group-by trigger opens the group-by menu (MOTIR-11451); the dimensions
  // are its menuitemradio rows, portaled out of the group.
  await control.getByRole('button').click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  expect((await patch).ok(), `group-by → ${label} persisted`).toBeTruthy();
}

// A real pointer drag from a board card onto a drop target, mirroring the
// activation-distance gesture board-config.spec.ts's column reorder uses: clear
// the 8px PointerSensor threshold, then step to the target's centre so dnd-kit's
// onDragOver registers the over-cell, then release. Used for both the swimlane
// cross-lane reassign (target = a `lane-cell-…`) and the flat cross-column move
// (target = a `board-column-…`).
async function dragCardOnto(page: Page, cardTestId: string, target: Locator): Promise<void> {
  const card = page.getByTestId(cardTestId);
  await card.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  // Measure BOTH after the last scroll: scrolling the target into view can move
  // the page, and a card box read before it points the press at stale pixels.
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + Math.min(to.height / 2, 36); // bias toward the top of a tall cell/column
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 24, fy, { steps: 6 }); // clear the 8px activation threshold
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty + 2, { steps: 4 }); // settle so the over-cell sticks
  await page.mouse.up();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Multi-step browser journeys plus a slow argon2 sign-up and cold route compiles
// — give them headroom over the 30s default (board-config.spec.ts uses the same).
test.describe.configure({ timeout: 90_000 });

test.describe('board-swimlanes @smoke', () => {
  test('group-by re-lays the board into assignee lanes + catch-all; Priority/Epic/None regroup or flatten', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { ownerId, memberId, projectId } = await seedProjectAndMember(OWNER_EMAIL);

    // Three To Do cards: one to the owner, one to the member, one left unassigned.
    const a = await newItem(page, projectId, 'assigned to owner');
    const b = await newItem(page, projectId, 'assigned to member');
    await newItem(page, projectId, 'left unassigned');
    await assign(page, a, ownerId);
    await assign(page, b, memberId);

    await page.goto('/boards');
    // Flat board by default (group-by none).
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('swimlane-board')).toHaveCount(0);

    // Group by Assignee → the board re-lays into lanes.
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    // One lane per assignee-with-cards (owner + member) plus the "No assignee"
    // catch-all, and the catch-all is LAST in DOM order.
    await expect(page.getByTestId(`swimlane-${ownerId}`)).toBeVisible();
    await expect(page.getByTestId(`swimlane-${memberId}`)).toBeVisible();
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible();
    const laneHeadIds = await page
      .locator('[data-testid^="swimlane-head-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(laneHeadIds.at(-1), 'the catch-all lane sorts last').toBe(`swimlane-head-${CATCH_ALL}`);
    // Each assignee lane holds its one card.
    await expect(page.getByTestId(`swimlane-count-${ownerId}`)).toHaveText('1');
    await expect(page.getByTestId(`swimlane-count-${memberId}`)).toHaveText('1');

    // Priority → all three cards default to `medium`, so a single `medium` lane
    // and NO catch-all (priority is never null).
    await setGroupBy(page, 'Priority');
    await expect(page.getByTestId('swimlane-medium')).toBeVisible();
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toHaveCount(0);

    // Epic → no card has an epic ancestor, so everything falls into the single
    // "No epic" catch-all lane.
    await setGroupBy(page, 'Epic');
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible();
    await expect(page.getByTestId(`swimlane-count-${CATCH_ALL}`)).toHaveText('3');

    // None → back to the flat board.
    await setGroupBy(page, 'None');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('swimlane-board')).toHaveCount(0);
  });

  test('collapsing a lane hides its cards (header + count kept) and persists across a reload', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { ownerId, projectId } = await seedProjectAndMember(OWNER_EMAIL);

    const card = await newItem(page, projectId, 'owned card');
    await assign(page, card, ownerId);

    await page.goto('/boards');
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    const board0 = await getBoard(page.request);
    const todoColId = columnByStatus(board0, 'todo').id;
    const ownerCell = page.getByTestId(`lane-cell-${todoColId}-${ownerId}`);
    const ownerHead = page.getByTestId(`swimlane-head-${ownerId}`);

    // Expanded to start: the lane's todo cell is mounted, the header announces
    // "Collapse".
    await expect(ownerCell).toBeVisible();
    await expect(ownerHead).toHaveAttribute('aria-expanded', 'true');

    // Collapse it (the whole header band is the operable button) → the cells
    // unmount but the header + aggregate count stay.
    await ownerHead.click();
    await expect(ownerHead).toHaveAttribute('aria-expanded', 'false');
    await expect(ownerCell).toHaveCount(0);
    await expect(page.getByTestId(`swimlane-head-${ownerId}`)).toBeVisible();
    await expect(page.getByTestId(`swimlane-count-${ownerId}`)).toHaveText('1');

    // Reload: the group-by persisted server-side (still swimlaned) AND the
    // collapse persisted client-side — the lane is still collapsed.
    await page.reload();
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(page.getByTestId(`swimlane-head-${ownerId}`)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByTestId(`lane-cell-${todoColId}-${ownerId}`)).toHaveCount(0);
  });

  // Cross-lane reassign — UN-QUARANTINED by Subtask 3.3.8. This E2E reproduced a
  // REAL product bug in the shipped 3.3.5 swimlane board: a cross-lane drag
  // intermittently crashed the board with React's "Maximum update depth
  // exceeded" inside `LaneCell` (`useRowWindow`), because the cell measured
  // against an inferred scroll-ancestor (no explicit scroll element) and its
  // content height oscillated (windowing ↔ natural-flow) under the drag-induced
  // re-renders, looping `recompute`/`setMeasured`. See PRODECT_FINDINGS #61.
  // 3.3.8 fixes it by disabling per-cell windowing in `LaneCell`
  // (`getScrollElement: () => null` → the hook's render-all degrade), so the
  // height can no longer oscillate. This test was shipped by 3.3.7 as
  // `test.fixme` (body intact + verified end-to-end while diagnosing the loop);
  // 3.3.8 flips it back to `test` as the fix's acceptance proof.
  test('a cross-lane drag reassigns the assignee with no status change; a drop into the catch-all unassigns', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { ownerId, projectId } = await seedProjectAndMember(OWNER_EMAIL);

    // One card owned (creates the owner lane) + TWO unassigned (the catch-all).
    // The second unassigned card keeps the catch-all lane non-empty after the
    // first drag empties it of `loose`, so the later drop INTO the catch-all
    // lands on a real card cell rather than the tiny empty placeholder.
    const owned = await newItem(page, projectId, 'owned card');
    const loose = await newItem(page, projectId, 'unassigned card');
    await newItem(page, projectId, 'second unassigned card');
    await assign(page, owned, ownerId);

    await page.goto('/boards');
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    const board0 = await getFullBoard(page.request);
    const todoColId = columnByStatus(board0, 'todo').id;
    const looseKey = identifierOf(board0, loose);
    const ownedKey = identifierOf(board0, owned);

    // Sanity: the unassigned card starts in the catch-all lane, the owned card in
    // the owner lane, both in To Do.
    expect(
      board0.columns.find((c) => c.id === todoColId)!.cards.find((c) => c.id === loose)!
        .swimlaneKey,
    ).toBe(CATCH_ALL);

    // Drag the unassigned card from the catch-all into the OWNER lane's To Do
    // cell → reassign to the owner, status unchanged (same To Do column). The
    // drop is waited on through its own write — nothing re-reads the board.
    const reassigned = waitForMoveWrite(page);
    await dragCardOnto(
      page,
      `board-card-${looseKey}`,
      page.getByTestId(`lane-cell-${todoColId}-${ownerId}`),
    );
    await reassigned;
    await expect
      .poll(
        async () => {
          const b = await getFullBoard(page.request);
          const card = b.columns.flatMap((c) => c.cards).find((c) => c.id === loose);
          return card?.assigneeId ?? null;
        },
        { message: 'cross-lane drag reassigned the card to the owner' },
      )
      .toBe(ownerId);
    // Status (column membership) unchanged — still in To Do.
    const afterReassign = await getFullBoard(page.request);
    expect(columnByStatus(afterReassign, 'todo').cards.map((c) => c.id)).toContain(loose);

    // Drag the owned card into the catch-all "No assignee" lane → it is unassigned.
    const unassigned = waitForMoveWrite(page);
    await dragCardOnto(
      page,
      `board-card-${ownedKey}`,
      page.getByTestId(`lane-cell-${todoColId}-${CATCH_ALL}`),
    );
    await unassigned;
    await expect
      .poll(
        async () => {
          const b = await getFullBoard(page.request);
          const card = b.columns.flatMap((c) => c.cards).find((c) => c.id === owned);
          // Distinguish "card missing" from "assigneeId === null"; a bare
          // `card?.assigneeId ?? 'X'` would turn a correct null into 'X' and make
          // `.toBeNull()` unsatisfiable.
          return card ? card.assigneeId : 'CARD_NOT_FOUND';
        },
        { message: 'a drop into the catch-all unassigned the card' },
      )
      .toBeNull();
  });

  test('WIP limit shows a SOFT over-limit warning; an over-limit drop still succeeds; clear removes it; at-limit is not warned', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedProjectAndMember(OWNER_EMAIL);

    // Three To Do cards; move two into In Progress (todo→in_progress is a legal
    // default edge) so In Progress holds 2 and To Do holds 1.
    const t1 = await newItem(page, projectId, 'todo one');
    const ip1 = await newItem(page, projectId, 'in progress one');
    const ip2 = await newItem(page, projectId, 'in progress two');
    expect((await transition(page.request, ip1, 'in_progress')).status()).toBe(200);
    expect((await transition(page.request, ip2, 'in_progress')).status()).toBe(200);

    await page.goto('/boards');
    await expect(page.getByTestId('board')).toBeVisible();

    const board0 = await getBoard(page.request);
    const inProgColId = columnByStatus(board0, 'in_progress').id;
    const t1Key = identifierOf(board0, t1);
    const wipBadge = page.getByTestId(`board-wip-${inProgColId}`);

    // Set the In Progress WIP limit to 1 (below its 2 cards) via the column [⋯]
    // menu → the SOFT over-limit warning shows (2/1, paired with the alert icon).
    await setColumnWip(page, inProgColId, '1');
    await expect(wipBadge).toBeVisible();
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText('2/1');

    // AT the limit is NOT warned: bump the limit to 2 → 2/2, no over-limit state.
    await setColumnWip(page, inProgColId, '2');
    await expect(wipBadge).toBeVisible();
    await expect(wipBadge).not.toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText('2/2');

    // Back to over-limit (1), then prove SOFT: dragging a To Do card INTO the
    // over-limit In Progress column still SUCCEEDS (todo→in_progress legal), the
    // move POST returns 200, and the warning persists at 3/1.
    await setColumnWip(page, inProgColId, '1');
    await expect(wipBadge).toHaveAttribute('data-over', 'true');

    const move = page.waitForResponse(
      (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
    );
    await dragCardOnto(
      page,
      `board-card-${t1Key}`,
      page.getByTestId(`board-column-${inProgColId}`),
    );
    expect((await move).status(), 'the soft over-limit drop is accepted, never blocked').toBe(200);
    await expect
      .poll(
        async () => {
          const b = await getBoard(page.request);
          return columnByStatus(b, 'in_progress').cards.length;
        },
        { message: 'the dragged card landed in the over-limit column (soft)' },
      )
      .toBe(3);
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText('3/1');

    // Clear the limit via the [⋯] menu → the WIP badge disappears entirely.
    await page.getByTestId(`board-column-actions-${inProgColId}`).click();
    await page.getByRole('button', { name: 'Set WIP limit' }).click();
    const cleared = page.waitForResponse(
      (r) =>
        new RegExp(`/api/board/columns/${inProgColId}$`).test(r.url()) &&
        r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Clear' }).click();
    expect((await cleared).ok(), 'clear WIP persisted').toBeTruthy();
    await expect(page.getByTestId(`board-wip-${inProgColId}`)).toHaveCount(0);
  });
});

// Set (or change) a column's WIP limit through its [⋯] menu's "Set WIP limit"
// editor, AWAITING the PATCH so the write has landed before the test asserts the
// resulting over/at-limit treatment. The editor PATCHes optimistically (a `void
// fetch`), so reading the board without this wait would race the in-flight write.
async function setColumnWip(page: Page, columnId: string, value: string): Promise<void> {
  await page.getByTestId(`board-column-actions-${columnId}`).click();
  await page.getByRole('button', { name: 'Set WIP limit' }).click();
  await page.getByTestId(`board-wip-input-${columnId}`).fill(value);
  const patch = page.waitForResponse(
    (r) =>
      new RegExp(`/api/board/columns/${columnId}$`).test(r.url()) &&
      r.request().method() === 'PATCH',
  );
  // `exact` — the board toolbar now mounts the [Saved] filter picker (6.15.3),
  // whose accessible name "Saved filters — …" substring-matches a bare "Save".
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patch).ok(), `set WIP ${value} on ${columnId} persisted`).toBeTruthy();
}
