import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { formatViolations, WCAG_TAGS, type AxeViolation } from './_helpers/a11y';
import {
  seedRolesPermissions,
  WORKSPACE_ROLE_HEADCOUNT,
  type RolesPermissionsSeed,
} from './_helpers/roles-permissions-seed';

// Story MOTIR-2282 — Roles & permissions, end to end (Subtask MOTIR-2265).
//
// ⚠️ RE-POINTED BY STORY MOTIR-6168 (MOTIR-6466): roles live on the WORKSPACE, so
// the Roles room moved from Project settings to Workspace settings →
// `/settings/workspace/roles`. Every workspace member READS it; only a Manager
// authors. With one workspace the door is the organisation page's "Open roles"
// card (design panel 4b), and every old `/settings/project/roles/**` URL
// redirects to its workspace twin (panel 4c).
//
// The story's `verification_recipe`, automated, and the clip it is accepted on.
//
// ⚠️ EVERY ARRIVAL IS REACHED BY CLICKING, NEVER BY TYPING A URL — except the
// no-access step, where a direct navigation IS the case under test. A route can
// resolve perfectly while nothing in the interface links to it, and a drill-down
// has TWO doors to get wrong: the rail entry into the list, and the row into the
// detail. Both clicks are part of the spec so both doors are verified alongside
// the rooms.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark
// or a settled navigation. There is no bare timeout in this file.
//
// ⚠️ THIS FILE IS MOTIR-2282'S RECEIPT, AND ONLY A PULL REQUEST TOUCHING IT CAN
// RE-PUBLISH ONE. `acceptance-tests.yml` triggers on `pull_request` + a `paths:`
// filter over `tests/e2e/acceptance*.spec.ts` (MOTIR-1949, deliberate). It ALSO
// runs nightly on `main` and on a manual dispatch while the lane holds a spec
// (MOTIR-10277, which replaced MOTIR-2760's `push: main` run) — but those runs
// publish nothing by construction, so the claim this note rests on is
// unchanged: only a PR can re-publish. The uploader then narrows
// again to the specs the PR actually CHANGED (MOTIR-1937), so a run that merely
// re-records this spec publishes nothing. Both gates are correct and neither is
// reachable after the story's own PR merges — which is why a lost receipt costs a
// throwaway PR against this file to restore (MOTIR-2502). Nothing in the workflow
// notices the loss on its own.

test.describe.configure({ timeout: 180_000 });

/** The one-workspace door: the org page's fold-in card (design panel 4b). */
const openRolesDoor = (page: Page) => page.getByRole('link', { name: 'Open roles' });

/** `"10 of 28 permissions"` → `[10, 28]`, failing loudly if the row has no count. */
function parseCount(text: string): [number, number] {
  const match = text.match(/(\d+) of (\d+) permissions/);
  expect(match, `no "N of M permissions" in ${JSON.stringify(text)}`).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}
// ⚠️ SCOPED BY `data-role-row`, NOT BY ACCESSIBLE NAME: a name match on
// "Member" also matches the rail's Members row — a strict-mode violation that
// reads as a broken page. The attribute is the role's own key.
const roleRow = (page: Page, role: 'manager' | 'member' | 'viewer') =>
  page.locator(`[data-role-row="${role}"]`);
const backToList = (page: Page) => page.getByRole('link', { name: 'All roles' });

/** The list screen has landed when its own heading and all three rows are up. */
async function expectRoleList(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Roles & permissions', level: 1 })).toBeVisible();
  for (const role of ['manager', 'member', 'viewer'] as const) {
    await expect(roleRow(page, role)).toBeVisible();
  }
}

/** Open the Roles room the way a person does below the reveal — by clicking. */
async function openRolesList(page: Page): Promise<void> {
  await page.goto('/settings/organization');
  await expect(openRolesDoor(page)).toBeVisible();
  await openRolesDoor(page).click();
  await page.waitForURL('**/settings/workspace/roles');
  await expectRoleList(page);
}

async function expectNoAxeViolations(page: Page, route: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(violations, formatViolations(route, violations as AxeViolation[])).toEqual([]);
}

let seed: RolesPermissionsSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedRolesPermissions(`roles-${Date.now()}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a Manager reads the role list, drills into a role, and comes back', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2282');

  await signIn(page, seed.adminEmail, seed.password);

  await chapter('Organization settings → Open roles, from the fold-in door', async () => {
    await page.goto('/settings/organization');
    await expect(openRolesDoor(page)).toBeVisible();
    await beat();

    // THE DOOR. Clicked, not typed — a page nobody can reach passes every test
    // that navigates to it directly.
    await openRolesDoor(page).click();
    await page.waitForURL('**/settings/workspace/roles');
    await expectRoleList(page);
    await beat();
  });

  await chapter('Each role says what it is, how much it holds, and who holds it', async () => {
    const manager = roleRow(page, 'manager');
    await expect(manager).toContainText('Manager');
    await expect(manager).toContainText('Built-in');
    await expect(manager).toContainText('Everything in this workspace');

    // `N of M`: the Manager holds everything, so its N and M are the same number,
    // and the other two roles hold strictly less of the SAME M.
    const [held, total] = parseCount(
      await manager.locator('text=/\\d+ of \\d+ permissions/').innerText(),
    );
    expect(held).toBe(total);
    expect(total).toBeGreaterThan(20);
    for (const role of ['member', 'viewer'] as const) {
      const row = roleRow(page, role);
      const [rowHeld, rowTotal] = parseCount(
        await row.locator('text=/\\d+ of \\d+ permissions/').innerText(),
      );
      expect(rowTotal).toBe(total);
      expect(rowHeld).toBeLessThan(total);
    }

    // THE HEADCOUNTS — the workspace's members under each role, three distinct
    // numbers so a placeholder or the wrong role's count cannot pass. Anchored
    // with a digit lookbehind: "1 member" is a substring of "21 members".
    await expect(manager).toContainText(
      new RegExp(`(?<!\\d)${WORKSPACE_ROLE_HEADCOUNT.manager} member\\b`),
    );
    await expect(roleRow(page, 'member')).toContainText(
      new RegExp(`(?<!\\d)${WORKSPACE_ROLE_HEADCOUNT.member} members\\b`),
    );
    await expect(roleRow(page, 'viewer')).toContainText(
      new RegExp(`(?<!\\d)${WORKSPACE_ROLE_HEADCOUNT.viewer} members\\b`),
    );
    await beat();

    // The level-gated grants are explained rather than hidden.
    await expect(page.getByText('Public requests')).toBeVisible();
    await expect(page.getByText('Access level', { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('Drilling into Member shows the whole model at full width', async () => {
    await roleRow(page, 'member').click();
    await page.waitForURL('**/settings/workspace/roles/member');

    await expect(page.getByRole('heading', { name: 'Member', level: 1 })).toBeVisible();
    await expect(page.getByText('Built-in · can’t be changed')).toBeVisible();

    await expect(page.getByText('Work items', { exact: true })).toBeVisible();
    await expect(page.getByText('Comments', { exact: true })).toBeVisible();
    await expect(page.getByText('Edit work items')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('work_item:edit');
    await beat();

    const heldRow = page.locator('[data-permission="work_item:edit"]');
    await expect(heldRow.getByRole('img')).toHaveAttribute('aria-label', 'Held');
    const withheld = page.locator('[data-permission="project:administer"]');
    await expect(withheld.getByRole('img')).toHaveAttribute('aria-label', 'Not held');
    await beat();
  });

  await chapter('“All roles” goes back to the list', async () => {
    await backToList(page).click();
    await page.waitForURL('**/settings/workspace/roles');
    await expectRoleList(page);
    await beat();
  });
});

// Every workspace member READS the Roles room (design panel 2d) — a role is the
// same in every project, so a person should be able to see what theirs lets
// them do. Only a Manager authors: no Create role, no Edit, no Delete.
test('a workspace Member reads both roles screens, with nothing to change', async ({ page }) => {
  await signIn(page, seed.memberEmail, seed.password);

  await page.goto('/settings/workspace/roles');
  await expectRoleList(page);
  await expect(
    page.locator('#main').getByText('Only a workspace Manager can create or change roles.'),
  ).toBeVisible();
  await expect(page.getByTestId('create-role')).toHaveCount(0);

  await page.goto('/settings/workspace/roles/viewer');
  await expect(page.getByRole('heading', { name: 'Viewer', level: 1 })).toBeVisible();
  await expect(page.getByTestId('edit-role')).toHaveCount(0);
});

test('the old project Roles URLs redirect to their workspace twins', async ({ page }) => {
  await signIn(page, seed.adminEmail, seed.password);

  await page.goto('/settings/project/roles');
  await page.waitForURL('**/settings/workspace/roles?from=project');
  await expect(
    page
      .locator('#main')
      .getByText('Roles now live on the workspace — the same role in every project.', {
        exact: false,
      }),
  ).toBeVisible();

  // `admin` moved with its meaning: the project Admin is the workspace Manager.
  await page.goto('/settings/project/roles/admin');
  await page.waitForURL('**/settings/workspace/roles/manager?from=project');
  await expect(page.getByRole('heading', { name: 'Manager', level: 1 })).toBeVisible();
});

test('both screens are free of axe violations', async ({ page }) => {
  await signIn(page, seed.adminEmail, seed.password);

  await openRolesList(page);
  await expectNoAxeViolations(page, '/settings/workspace/roles');

  await roleRow(page, 'manager').click();
  await page.waitForURL('**/settings/workspace/roles/manager');
  await expect(page.getByRole('heading', { name: 'Manager', level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, '/settings/workspace/roles/[roleKey]');
});

// NOTHING REGRESSED for a viewer: their in-place affordances are exactly what
// they were, and the Roles room reads, never writes, for them.
test('a workspace viewer keeps exactly the affordances they had before', async ({ page }) => {
  await signIn(page, seed.viewerEmail, seed.password);

  await page.goto('/boards');
  const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
  await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
  await expect(newWorkItem, 'a viewer must still not be able to create work items').toBeDisabled();

  await page.goto('/settings/workspace/roles');
  await expectRoleList(page);
  await expect(page.getByTestId('create-role')).toHaveCount(0);
});
