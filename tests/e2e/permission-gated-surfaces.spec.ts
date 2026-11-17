import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite } from './_helpers/authoritative-signal';
import {
  seedPermissionGatedUi,
  type PermissionGatedSeed,
} from './_helpers/permission-gated-ui-seed';

// E2E: Story MOTIR-6166's `## Verification`, automated (Subtask MOTIR-6178).
//
// A project VIEWER and a project MEMBER each walk the work item, its quick view
// (from the list AND from the board), the board, the backlog and the rail. The
// Viewer meets no control that writes and no door onto an empty room; the
// Member keeps every edit they had, each confirmed by the write's own response
// and by the persisted value after a reload — never by the optimistic UI.
//
// The Plans, Approvals and Runs rooms and their tabs are the rooms story's own
// E2E (MOTIR-6179); the Visitor is MOTIR-6170's.
//
// DETERMINISM (`CLAUDE.md` § E2E): every wait is a role landmark, a settled URL
// or a write's response; locators are `getByRole` or scoped to one region.

test.describe.configure({ timeout: 240_000 });

let seed: PermissionGatedSeed;

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedPermissionGatedUi('surfaces');
});

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
// Test ids are read inside the live `main` landmark, never page-rooted.
const main = (page: Page) => page.getByRole('main');
const READ_ONLY = /— You have read-only access to this project$/;

async function enterAs(page: Page, email: string) {
  await signIn(page, email, seed.password);
  await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();
}

test('a VIEWER meets no control that writes, and every disabled one says why', async ({ page }) => {
  await enterAs(page, seed.viewerEmail);

  // ── The work item page ─────────────────────────────────────────────────────
  await page.goto(`/items/${seed.itemKey}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  const reasons = page.getByRole('button', { name: READ_ONLY });
  await expect(reasons.first()).toBeVisible();
  expect(await reasons.count()).toBeGreaterThanOrEqual(6);
  // The MOTIR-4822 path: open a field picker and choose an option. The chevron
  // is disabled; pressing it opens nothing, so there is nothing to choose.
  const workType = page.getByRole('button', {
    name: 'Work type — You have read-only access to this project',
  });
  // Playwright itself refuses to press it (`aria-disabled`); FORCE the press,
  // because the criterion is that the interaction cannot be performed, and that
  // is asserted by attempting it, not by reading an attribute.
  await expect(workType).toBeDisabled();
  await workType.click({ force: true });
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('option')).toHaveCount(0);
  // No Edit door, no link or to-do add control.
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link work item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add step' })).toHaveCount(0);

  // ── The quick view, from the list ──────────────────────────────────────────
  await page.goto('/items');
  const row = main(page).getByTestId(`issue-row-${seed.itemKey}`);
  await expect(row).toBeVisible();
  await row.press('Enter');
  const fromList = page.getByRole('dialog');
  await expect(fromList).toBeVisible();
  // The peek fetches its data after the dialog opens: wait for the rail to land
  // (its first disabled chevron) before counting anything in it.
  await expect(fromList.getByRole('button', { name: READ_ONLY }).first()).toBeVisible();
  expect(await fromList.getByRole('button', { name: READ_ONLY }).count()).toBeGreaterThanOrEqual(3);
  await expect(fromList.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(fromList).toBeHidden();

  // ── The board: read-only banner, no drag, no grouping or column writes ─────
  await page.goto('/boards');
  await expect(main(page).getByTestId('board')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Read-only access — you can view this board' }),
  ).toBeVisible();
  await expect(page.getByText('boards.readOnlyBoardBanner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Column actions' })).toHaveCount(0);
  // The group-by trigger (MOTIR-11451) is inert, opens no menu, and the group
  // is the focus stop that carries the read-only reason.
  const groupBy = page.getByRole('group', { name: 'Swimlane group by' });
  await expect(groupBy.getByRole('button')).toBeDisabled();
  await expect(groupBy).toHaveAccessibleDescription('You have read-only access to this project');
  await groupBy.getByRole('button').click({ force: true });
  await expect(page.getByRole('menu', { name: 'Group by' })).toHaveCount(0);

  // …and the quick view from the board draws the same treatment.
  await page.getByRole('button', { name: new RegExp(`^Open ${seed.itemKey}:`) }).click();
  const fromBoard = page.getByRole('dialog');
  await expect(fromBoard).toBeVisible();
  await expect(fromBoard.getByRole('button', { name: READ_ONLY }).first()).toBeVisible();
  await expect(fromBoard.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ── The backlog: nothing to groom, Create disabled ─────────────────────────
  await page.goto('/backlog');
  await expect(main(page).getByTestId('create-issue-backlog')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(main(page).getByTestId('create-sprint')).toHaveCount(0);
  await expect(main(page).getByTestId(`backlog-row-actions-${seed.itemKey}`)).toHaveCount(0);
  await expect(main(page).getByTestId(`backlog-row-check-${seed.itemKey}`)).toHaveCount(0);

  // ── The rail: the one door opens on the one room a Viewer may read ─────────
  // (MOTIR-7738 · MOTIR-8830: the Translation room is a read view for anyone who
  // can browse the project; every administrative room still refuses the Viewer.)
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'href',
    '/settings/project/translation',
  );
});

test('a MEMBER keeps every edit, each confirmed by its response and the persisted value', async ({
  page,
}) => {
  await enterAs(page, seed.memberEmail);

  // ── The work item page: a field write that persists ────────────────────────
  const itemPath = `/items/${seed.itemKey}`;
  await page.goto(itemPath);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: READ_ONLY })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Priority' }).click();
  await page.getByRole('combobox', { name: 'Priority' }).click();
  const written = actionWrite(page, itemPath, 'expectedUpdatedAt');
  await page.getByRole('option', { name: 'Highest', exact: true }).click();
  expect((await written).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Highest', { exact: true }).first()).toBeVisible();

  // ── The quick view keeps its editors ───────────────────────────────────────
  await page.goto('/items');
  const row = main(page).getByTestId(`issue-row-${seed.itemKey}`);
  await expect(row).toBeVisible();
  await row.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Edit Priority', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: READ_ONLY })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ── The board: no read-only banner, cards draggable ────────────────────────
  await page.goto('/boards');
  await expect(main(page).getByTestId('board')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Read-only access — you can view this board' }),
  ).toHaveCount(0);

  // ── The backlog: every grooming control is there ───────────────────────────
  await page.goto('/backlog');
  await expect(main(page).getByTestId('create-sprint')).toBeVisible();
  await expect(main(page).getByTestId(`backlog-row-actions-${seed.itemKey}`)).toBeVisible();
  await expect(main(page).getByTestId(`backlog-row-check-${seed.itemKey}`)).toBeVisible();
  // The inline create row (the page header carries a second Create button).
  await expect(main(page).getByTestId('create-issue-backlog')).toBeEnabled();
});
