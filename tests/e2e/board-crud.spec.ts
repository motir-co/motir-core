// E2E: multiple boards per project — board CRUD + switcher + board-scoped read +
// per-board settings (Story 3.7 · Subtask 3.7.6, the Story-closing test).
//
// @smoke — proves the HEADLINE Story 3.7 delivers, driven end-to-end through the
// real shell: a project goes from its ONE auto-seeded default board to MANY, with
// a switcher that creates / renames / sets-default / deletes, threads the selected
// board through the read (`?board=<id>`, reload-safe), keeps each board's config
// independent, and opens per-board SETTINGS from the switcher manage menu.
//
//   - CREATE + SWITCH + URL: the switcher's "New board" seeds a second board with
//     default columns and makes it active; switching writes `?board=<id>` and a
//     reload keeps the selection (the 2.5.19 `?peek` pattern).
//   - PER-BOARD CONFIG ISOLATION: a group-by set on board B re-lays B into
//     swimlanes while the default board A stays flat — each board carries its own
//     config (3.3 group-by is board-scoped), and B's config survives a round-trip
//     switch.
//   - RENAME + SET-DEFAULT: a board renames in place; promoting a non-default
//     board to default moves the Default badge AND makes a fresh `/boards` visit
//     (no `?board=`) open the new default.
//   - DELETE + ISSUES SURVIVE + LAST-BOARD GUARD: deleting a board removes it (and
//     auto-promotes/switches), but the project's issues still show on the
//     remaining board (issues belong to the PROJECT, never a board); the LAST
//     board can't be deleted (the manage-menu Delete is disabled + a note).
//   - PER-BOARD SETTINGS: the switcher manage menu's "Board settings" deep-links
//     to `/settings/project/board?board=<id>` for THAT board — the settings page
//     resolves the selected board (its switcher names it), not only the default.
//
// It mirrors the setup of board-ui.spec.ts (3.2.7) / board-config.spec.ts (3.6.4):
// a browser sign-up (creator = workspace owner, finding #36, so board CRUD's
// membership gate admits the writes), one server-seeded project pinned active, and
// every CRUD action driven through the actual BoardSwitcher UI against the 3.7.3
// REST API. Committed state is read back through the signed-in user's request
// context (GET /api/boards, GET /api/board?boardId=).
//
// SCOPE: the MULTI-BOARD journey only. The CRUD service guards (last-board 409,
// promote-default, one-default invariant), the board-scoped read resolution
// (selected vs default vs cross-tenant 404), and the per-board settings-page
// `?board=` parsing are proven at the unit/service layer by the 3.7.x Vitest
// suites (board-crud-service / board-selection / default-board-flag /
// board-settings-page / components/board-switcher); this proves them composed,
// over the real stack. It does NOT re-drive the 3.2.7 drag journeys or the 3.6.4
// column-config surface.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus } from './_helpers/board';
import { createItem } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import type { BoardProjectionDto, BoardSummaryDto } from '@/lib/dto/boards';

const OWNER_EMAIL = 'e2e-board-crud-owner@example.com';

// Sign-up auto-creates a fresh user + `<local>'s Workspace`; add the one project
// the boards hang off and pin it active so getActiveProject() resolves it on
// /boards + /settings. Identical shape to board-ui.spec.ts's seedActiveProject.
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
    name: 'Board CRUD Demo',
    identifier: 'BCR',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

// The board card's data-testid is keyed by the work item IDENTIFIER (BCR-1, …).
const cardTid = (identifier: string) => `board-card-${identifier}`;

// Open /boards (wide viewport). The switcher trigger is always present once the
// board list resolves — it's the reliable "board page is interactive" signal,
// independent of the board PROJECTION's loading / empty / populated state (the
// `board` grid testid is absent on an EMPTY board, which renders BoardEmptyState
// instead of BoardDnd). Tests that assert the grid create a work item first
// (issues belong to the PROJECT, so they project on every board).
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/boards');
  await expect(page.getByTestId('board-switcher-trigger')).toBeVisible({ timeout: 15_000 });
}

// The active project's boards as the switcher sees them (BoardSummaryDto[],
// position order) — read back through the signed-in request context.
async function listBoards(page: Page): Promise<BoardSummaryDto[]> {
  const res = await page.request.get('/api/boards', {
    headers: { accept: 'application/json' },
  });
  expect(res.status(), 'GET /api/boards').toBe(200);
  return ((await res.json()) as { boards: BoardSummaryDto[] }).boards;
}

// A SPECIFIC board's projection (the 3.7.5 board-scoped read), so we can assert a
// freshly-created board was seeded with its own default columns.
async function boardById(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const res = await page.request.get(`/api/board?boardId=${encodeURIComponent(boardId)}`, {
    headers: { accept: 'application/json' },
  });
  expect(res.status(), `GET /api/board?boardId=${boardId}`).toBe(200);
  return (await res.json()) as BoardProjectionDto;
}

// Create a board through the actual switcher UI ("New board" → name → submit) and
// return the created board's DTO from the POST response. The switcher then
// auto-switches to it (selectBoard pushes `?board=<id>`), so we wait for the URL.
async function createBoardViaUI(
  page: Page,
  name: string,
  type: 'kanban' | 'scrum' = 'kanban',
): Promise<BoardSummaryDto> {
  await page.getByTestId('board-switcher-trigger').click();
  await page.getByTestId('board-switcher-new').click();
  await page.getByTestId('board-new-name').fill(name);
  // Kanban is preselected; pick the Scrum tile when a scrum board is requested.
  if (type === 'scrum') await page.getByTestId('board-type-scrum').click();
  const post = page.waitForResponse(
    (r) => r.url().endsWith('/api/boards') && r.request().method() === 'POST',
  );
  await page.getByTestId('board-new-submit').click();
  const res = await post;
  expect(res.status(), 'POST /api/boards (create) returns 201').toBe(201);
  const created = (await res.json()) as BoardSummaryDto;
  expect(created.type, `created board is a ${type} board`).toBe(type);
  await page.waitForURL((url) => url.searchParams.get('board') === created.id, { timeout: 10_000 });
  return created;
}

// Open the manage [⋯] flyout for a board row (the switcher menu must be open).
async function openManageMenu(page: Page, boardId: string): Promise<void> {
  await page.getByTestId(`board-switcher-manage-${boardId}`).click();
  await expect(page.getByTestId(`board-switcher-manage-menu-${boardId}`)).toBeVisible();
}

// Open a specific board with a FULL page load (the board-swimlanes pattern), so
// the projection is fully settled on that board before the test acts on its
// config — avoids the post-create client-switch re-lay race where a config write
// races the in-flight board switch.
async function gotoBoard(page: Page, boardId: string): Promise<void> {
  await page.goto(`/boards?board=${boardId}`);
  await expect(page.getByTestId('board-switcher-trigger')).toBeVisible({ timeout: 15_000 });
}

// Switch the active board through the switcher (pick row), waiting for `?board=`.
async function switchToBoard(page: Page, boardId: string): Promise<void> {
  await page.getByTestId('board-switcher-trigger').click();
  await page.getByTestId(`board-switcher-pick-${boardId}`).click();
  await page.waitForURL((url) => url.searchParams.get('board') === boardId, { timeout: 10_000 });
}

// Set the swimlane group-by via the board-header group-by menu, awaiting the
// persist PATCH (which carries the SELECTED board's id — 3.7.5). Mirrors
// board-swimlanes.spec.ts.
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

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Browser sign-up (slow argon2) + cold route compiles (boards, settings) add up;
// give the journeys headroom over the 30s default (board-ui.spec.ts uses 90s).
test.describe.configure({ timeout: 90_000 });

test.describe('board-crud @smoke', () => {
  test('the switcher creates a second board with default columns, makes it active, and the ?board= selection survives a reload', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    // One issue so every board (default + created) is non-empty and renders the
    // BoardDnd grid (`board` testid) rather than the empty state.
    await createItem(page.request, projectId, 'a project issue');
    await openBoard(page);

    // One board to start: the auto-seeded default (3.1 + 3.7.2 backfill).
    const before = await listBoards(page);
    expect(before).toHaveLength(1);
    const defaultBoard = before[0]!;
    expect(defaultBoard.isDefault).toBe(true);
    const defaultColumns = (await getBoard(page.request)).columns.length;
    expect(defaultColumns).toBeGreaterThan(0);

    // Create a second board through the UI → it appears + becomes active.
    const triage = await createBoardViaUI(page, 'Triage');
    expect(triage.isDefault, 'a new board is NON-default').toBe(false);
    // The trigger now names the active (Triage) board, WITHOUT a Default badge.
    await expect(page.getByTestId('board-switcher-trigger')).toContainText('Triage');
    await expect(page.getByTestId('board-switcher-active-default')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();

    // Two boards now; the default is unchanged; Triage was seeded its OWN default
    // columns off the workflow (same count as the default board → 3.1 bootstrap).
    const after = await listBoards(page);
    expect(after).toHaveLength(2);
    expect(after.filter((b) => b.isDefault)).toHaveLength(1);
    expect(after.find((b) => b.isDefault)!.id).toBe(defaultBoard.id);
    expect((await boardById(page, triage.id)).columns).toHaveLength(defaultColumns);

    // Switch back to the default board → `?board=<defaultId>`, Default badge shows.
    await switchToBoard(page, defaultBoard.id);
    await expect(page.getByTestId('board-switcher-trigger')).toContainText(defaultBoard.name);
    await expect(page.getByTestId('board-switcher-active-default')).toBeVisible();

    // Reload keeps the selection (URL-addressable, reload-safe).
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).searchParams.get('board')).toBe(defaultBoard.id);
    await expect(page.getByTestId('board-switcher-trigger')).toContainText(defaultBoard.name);
  });

  test('the switcher creates a SCRUM board (type picker selectable) and it renders the Scrum surface — the "Epic 4" seam is gone', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    await seedActiveProject(OWNER_EMAIL);
    await openBoard(page);

    // The New-board type picker offers Scrum as a real, enabled option (the old
    // disabled "Epic 4" seam was re-opened once Story 4.5 shipped). Selecting it
    // creates a server-side scrum board.
    const sprintBoard = await createBoardViaUI(page, 'Sprint board', 'scrum');
    expect(sprintBoard.type).toBe('scrum');

    // It's persisted as scrum (read back through the request context)…
    const boards = await listBoards(page);
    expect(boards.find((b) => b.id === sprintBoard.id)?.type).toBe('scrum');

    // …and renders the 4.5 Scrum surface: a freshly-created scrum board has no
    // active sprint, so it shows the "No active sprint" empty state (with a
    // Backlog CTA), NOT a bare Kanban grid.
    await gotoBoard(page, sprintBoard.id);
    await expect(page.getByText('No active sprint', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: 'Go to Backlog' })).toBeVisible();
  });

  test('each board carries its own config — a group-by on board B leaves the default board flat, and survives a round-trip switch', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    // One card so a grouped board renders concrete lanes (the catch-all at least).
    await createItem(page.request, projectId, 'an issue on the project');
    await openBoard(page);

    const defaultBoard = (await listBoards(page))[0]!;
    const triage = await createBoardViaUI(page, 'Triage');

    // Land on board B with a FULL load (not the post-create client switch) so the
    // projection is fully settled on Triage before we change its config — the
    // board-swimlanes.spec pattern. (A group-by fired mid-switch would PATCH the
    // board whose projection is still mounted, not the one the URL selects.)
    await gotoBoard(page, triage.id);
    // Group board B (Triage) by Assignee → it re-lays into swimlanes.
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    // The default board A is UNAFFECTED — open it (full load) and it's still flat.
    await gotoBoard(page, defaultBoard.id);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('swimlane-board')).toHaveCount(0);

    // Back to board B → its group-by persisted (still swimlaned): per-board config.
    await gotoBoard(page, triage.id);
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
  });

  test('a board renames in place, and promoting a non-default board to default moves the badge + opens on a fresh visit', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    // One issue so the fresh-visit board grid renders (non-empty board).
    await createItem(page.request, projectId, 'a project issue');
    await openBoard(page);

    const defaultBoard = (await listBoards(page))[0]!;
    const triage = await createBoardViaUI(page, 'Triage');

    // Rename Triage → "Sprint Triage" via the manage menu's Rename modal.
    await page.getByTestId('board-switcher-trigger').click();
    await openManageMenu(page, triage.id);
    await page.getByTestId(`board-switcher-rename-${triage.id}`).click();
    await page.getByTestId('board-rename-name').fill('Sprint Triage');
    const renamePatch = page.waitForResponse(
      (r) => r.url().endsWith(`/api/boards/${triage.id}`) && r.request().method() === 'PATCH',
    );
    await page.getByTestId('board-rename-submit').click();
    expect((await renamePatch).ok(), 'rename PATCH persisted').toBeTruthy();
    await expect(page.getByTestId('board-switcher-trigger')).toContainText('Sprint Triage');

    // Promote Triage to default via the manage menu's Set-as-default.
    await page.getByTestId('board-switcher-trigger').click();
    await openManageMenu(page, triage.id);
    const defaultPatch = page.waitForResponse(
      (r) => r.url().endsWith(`/api/boards/${triage.id}`) && r.request().method() === 'PATCH',
    );
    await page.getByTestId(`board-switcher-setdefault-${triage.id}`).click();
    expect((await defaultPatch).ok(), 'set-default PATCH persisted').toBeTruthy();

    // One default, and it's Triage now (the one-default invariant held server-side).
    const boards = await listBoards(page);
    expect(boards.filter((b) => b.isDefault)).toHaveLength(1);
    expect(boards.find((b) => b.isDefault)!.id).toBe(triage.id);
    expect(boards.find((b) => b.id === defaultBoard.id)!.isDefault).toBe(false);

    // A fresh `/boards` visit (no `?board=`) opens the NEW default (Sprint Triage).
    await page.goto('/boards');
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('board-switcher-trigger')).toContainText('Sprint Triage');
    await expect(page.getByTestId('board-switcher-active-default')).toBeVisible();
  });

  test('deleting a board removes it but keeps the project issues on the remaining board; the last board cannot be deleted', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    // Two issues on the PROJECT (boards never own issues).
    await createItem(page.request, projectId, 'survives the delete one');
    await createItem(page.request, projectId, 'survives the delete two');
    await openBoard(page);

    const defaultBoard = (await listBoards(page))[0]!;
    // Capture the project's card identifiers as the default board projects them.
    const projection = await getBoard(page.request);
    const todoCol = columnByStatus(projection, 'todo');
    const cardIdentifiers = todoCol.cards.map((c) => c.identifier);
    expect(cardIdentifiers).toHaveLength(2);

    // Create Triage (becomes active), then delete it from the switcher.
    const triage = await createBoardViaUI(page, 'Triage');
    await page.getByTestId('board-switcher-trigger').click();
    await openManageMenu(page, triage.id);
    await page.getByTestId(`board-switcher-delete-${triage.id}`).click();
    const del = page.waitForResponse(
      (r) => r.url().endsWith(`/api/boards/${triage.id}`) && r.request().method() === 'DELETE',
    );
    await page.getByTestId('board-delete-confirm').click();
    expect((await del).ok(), 'DELETE /api/boards/[id] succeeded').toBeTruthy();

    // Triage is gone; only the default board remains, and it auto-became active.
    const remaining = await listBoards(page);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(defaultBoard.id);
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });

    // The project's issues SURVIVED — they still project on the remaining board.
    for (const identifier of cardIdentifiers) {
      await expect(page.getByTestId(cardTid(identifier))).toBeVisible();
    }

    // The LAST board cannot be deleted — the manage-menu Delete is disabled + a note.
    await page.getByTestId('board-switcher-trigger').click();
    await openManageMenu(page, defaultBoard.id);
    await expect(page.getByTestId(`board-switcher-delete-${defaultBoard.id}`)).toBeDisabled();
    await expect(page.getByTestId('board-switcher-lastboard-note')).toBeVisible();
  });

  test('the manage menu’s "Board settings" deep-links to the SELECTED board’s config page, and the settings switcher re-targets', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    await seedActiveProject(OWNER_EMAIL);
    await openBoard(page);

    const defaultBoard = (await listBoards(page))[0]!;
    const triage = await createBoardViaUI(page, 'Triage');

    // Open the Board-settings item for Triage → it deep-links to that board.
    await page.getByTestId('board-switcher-trigger').click();
    await openManageMenu(page, triage.id);
    await page.getByTestId(`board-switcher-settings-${triage.id}`).click();
    await page.waitForURL(
      (url) =>
        url.pathname === '/settings/project/board' && url.searchParams.get('board') === triage.id,
      { timeout: 15_000 },
    );

    // The settings page is scoped to Triage — its (switch-only) switcher names it.
    const settingsTrigger = page.getByTestId('board-switcher-trigger');
    await expect(settingsTrigger).toBeVisible({ timeout: 15_000 });
    await expect(settingsTrigger).toContainText('Triage');
    // It's the settings VARIANT: switch-only, no New / per-row manage affordance.
    await settingsTrigger.click();
    await expect(page.getByTestId('board-switcher-new')).toHaveCount(0);
    await expect(page.getByTestId(`board-switcher-manage-${triage.id}`)).toHaveCount(0);

    // Switching in the settings switcher re-targets WHICH board is configured.
    await page.getByTestId(`board-switcher-pick-${defaultBoard.id}`).click();
    await page.waitForURL(
      (url) =>
        url.pathname === '/settings/project/board' &&
        url.searchParams.get('board') === defaultBoard.id,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('board-switcher-trigger')).toContainText(defaultBoard.name);
  });
});
