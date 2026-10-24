import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { signIn } from './_helpers/shell-session';
import {
  WR_PASSWORD,
  seedWorkspaceRoles,
  type WorkspaceRolesSeed,
} from './_helpers/workspace-roles-seed';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';

// ROLES LIVE ON THE WORKSPACE — THE ACCEPTANCE RECEIPT (Story MOTIR-6168 ·
// Subtask MOTIR-6468). The story's verification recipe, in a real browser
// against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A Manager opens Workspace settings from the workspace switcher, reads every
// person's role and the migration report, and dismisses a row. They make a
// Member a Viewer — and that person finds EVERY project of the workspace read-
// only, while the Plans, Approvals and Runs rooms still show the project's
// records. The Manager authors a "Reviewer" role from Viewer, adding comments
// and leaving out the runs key, and assigns it: its holder comments but edits
// nothing, and the Runs room is gone from the rail and its address. Project
// settings no longer offer roles at all, and the old Roles address lands on the
// workspace's.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// A role change and a dismiss are Server Actions POSTed to `/settings/workspace`;
// each is armed BEFORE the press, its status asserted, and the committed row
// polled from the database before the page is reloaded to read it back. A role
// authored on the Roles page is its `POST /api/workspaces/{id}/roles` (201).
// Every control is asserted MOUNTED before it is asserted on, so no chapter can
// pass on a page that did not render.

const READ_ONLY = /— You have read-only access to this project$/;
const REVIEWER = 'Reviewer';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const main = (page: Page) => page.getByRole('main');
const picker = (page: Page, name: string) =>
  page.getByRole('combobox', { name: `Role for ${name}` });
const notice = (page: Page) =>
  main(page).getByRole('list', { name: 'Changed by the move to workspace roles' });

/** A Server Action POSTed to `pathname`, optionally told apart by a body substring. */
function serverAction(page: Page, pathname: string, needle?: string): Promise<Response> {
  return page.waitForResponse((res) => {
    const req = res.request();
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      (needle === undefined || (req.postData() ?? '').includes(needle))
    );
  });
}

async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, WR_PASSWORD);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 30_000,
  });
}

/** Workspace settings BY CLICKING the switcher's door — never by URL. */
async function openWorkspaceSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByRole('link', { name: 'Workspace settings' }).click();
  await page.waitForURL('**/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
}

async function committedRole(userId: string, workspaceId: string) {
  const row = await adminDb.workspaceMembership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { roleDefinition: true },
  });
  return row.roleDefinition?.name ?? row.workspaceRole;
}

async function userId(email: string): Promise<string> {
  return (await adminDb.user.findUniqueOrThrow({ where: { email } })).id;
}

/** Change `name`'s role through the Members picker; settle on the committed row. */
async function changeRole(
  page: Page,
  seed: WorkspaceRolesSeed,
  who: { name: string; email: string },
  option: string,
  committed: string,
): Promise<void> {
  const id = await userId(who.email);
  const control = picker(page, who.name);
  await expect(control).toBeEnabled();
  // Bring the Members list on screen — the change is what the viewer watches.
  await control.scrollIntoViewIfNeeded();
  await control.click();
  const write = serverAction(page, '/settings/workspace', id);
  // An option's name is its label then its description (`Viewer Reads every…`).
  await page.getByRole('option', { name: new RegExp(`^${option}(\\s|$)`) }).click();
  expect((await write).status(), `the role change for ${who.name}`).toBe(200);
  await expect.poll(() => committedRole(id, seed.workspaceId), { timeout: 20_000 }).toBe(committed);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `${who.name} is now a ${option} in every project of Northwind` })
      .first(),
  ).toBeVisible();
}

/** An item page read-only for its reader: fields say why, nothing offers an edit. */
async function expectReadOnlyItem(page: Page, key: string, title: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  const reasons = page.getByRole('button', { name: READ_ONLY });
  await expect(reasons.first()).toBeVisible();
  expect(await reasons.count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
}

let seed: WorkspaceRolesSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedWorkspaceRoles(`wr${Date.now().toString(36)}`);
});

test('a Manager changes a role once and every project follows; a Reviewer role closes the Runs room; project settings hold no roles', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6168');
  test.setTimeout(300_000);
  const theo = { name: seed.memberName, email: seed.memberEmail };
  const rae = { name: seed.reviewerName, email: seed.reviewerEmail };

  await signInAs(page, seed.managerEmail);

  await chapter('Workspace settings → Members: every person’s role, and the report', async () => {
    await openWorkspaceSettings(page);
    // The role column is MOUNTED: one picker per person, the org Owner locked.
    await expect(picker(page, 'Maya Manager')).toContainText('Manager');
    await expect(picker(page, 'Maya Manager')).toBeDisabled();
    await expect(picker(page, theo.name)).toContainText('Member');
    await expect(picker(page, rae.name)).toContainText('Member');
    await picker(page, rae.name).scrollIntoViewIfNeeded();
    await beat();

    // The migration notice is MOUNTED, naming each person and why.
    await expect(notice(page)).toBeVisible();
    await expect(notice(page).getByRole('listitem')).toHaveCount(seed.report.length);
    for (const row of seed.report) {
      const item = notice(page).getByRole('listitem').filter({ hasText: row.name });
      await expect(item).toContainText(row.reasonText);
    }
    await notice(page).scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter('Dismiss a report row — it does not come back', async () => {
    const dismiss = serverAction(page, '/settings/workspace');
    await notice(page)
      .getByRole('button', { name: `Dismiss ${rae.name}` })
      .click();
    expect((await dismiss).status(), 'the dismiss').toBe(200);
    await expect
      .poll(
        () =>
          adminDb.roleMigrationReport.count({
            where: { workspaceId: seed.workspaceId, dismissedAt: null },
          }),
        { timeout: 20_000 },
      )
      .toBe(seed.report.length - 1);
    await page.reload();
    await expect(notice(page).getByRole('listitem')).toHaveCount(seed.report.length - 1);
    await expect(notice(page).getByRole('listitem').filter({ hasText: rae.name })).toHaveCount(0);
    await beat();
  });

  await chapter(`Make ${theo.name} a Viewer`, async () => {
    await changeRole(page, seed, theo, 'Viewer', 'viewer');
    await page.reload();
    await expect(picker(page, theo.name)).toContainText('Viewer');
    await picker(page, theo.name).scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter(`${theo.name}: Payments is read-only now…`, async () => {
    await signInAs(page, theo.email);
    await expectReadOnlyItem(page, seed.paymentsItemKey, seed.paymentsItemTitle);
    await beat();
  });

  await chapter('…and Plans, Approvals and Runs still show the project’s records', async () => {
    for (const [label, heading] of [
      ['Plans', 'Plans'],
      ['Approval records', 'Approval records'],
      ['Runs', 'Runs'],
    ] as const) {
      await rail(page).getByRole('link', { name: label, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      if (label === 'Plans') {
        await expect(
          main(page)
            .getByRole('list', { name: 'Planning conversations' })
            .getByRole('listitem')
            .filter({ hasText: seed.planTitle }),
        ).toHaveCount(1);
      } else if (label === 'Approval records') {
        await expect(main(page).getByTestId(/^approval-row-/)).toHaveCount(1);
      } else {
        await expect(
          main(page)
            .getByRole('row')
            .filter({ has: page.getByRole('cell') }),
        ).toHaveCount(1);
      }
      await beat();
    }
  });

  await chapter('…and so is Growth — every project at once', async () => {
    // Switch project the way a person does; the item page reads the ACTIVE one.
    const switcher = page.getByRole('button', { name: 'Switch project' });
    await switcher.click();
    const popover = page.locator('[data-state=open]').filter({ hasText: /^Projects/ });
    await expect(popover).toBeVisible();
    await popover.getByText('Growth', { exact: true }).click();
    await expect(switcher).toContainText('Growth');
    await expectReadOnlyItem(page, seed.growthItemKey, seed.growthItemTitle);
    await beat();
  });

  await chapter('Roles → New role from Viewer: add comments, leave out the runs key', async () => {
    await signInAs(page, seed.managerEmail);
    await openWorkspaceSettings(page);
    await page.getByRole('link', { name: 'Roles & permissions', exact: true }).click();
    await page.waitForURL('**/settings/workspace/roles');
    await expect(
      page.getByRole('heading', { name: 'Roles & permissions', level: 1 }),
    ).toBeVisible();
    await expect(page.locator('[data-role-row]')).toHaveCount(3);
    await beat();

    await main(page).getByTestId('create-role').click();
    await page.waitForURL('**/settings/workspace/roles/new');
    await page.getByRole('textbox', { name: 'Name' }).fill(REVIEWER);
    await page.getByRole('combobox', { name: 'Start from' }).selectOption('viewer');
    const comments = page.getByRole('checkbox', { name: 'Add comments' });
    const runs = page.getByRole('checkbox', { name: 'See every agent run' });
    await expect(comments).toHaveAttribute('aria-checked', 'false');
    await expect(runs).toHaveAttribute('aria-checked', 'true');
    await comments.click();
    await runs.click();
    await expect(comments).toHaveAttribute('aria-checked', 'true');
    await expect(runs).toHaveAttribute('aria-checked', 'false');
    await beat();

    const created = page.waitForResponse(
      (res) => /\/roles$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create role' }).click();
    expect((await created).status(), 'the role was created').toBe(201);
    await expect(page.getByRole('heading', { name: REVIEWER, level: 1 })).toBeVisible();
    await expect(page.locator('[data-permission="run:view_any"]').getByRole('img')).toHaveAttribute(
      'aria-label',
      'Not held',
    );
    await beat();
  });

  await chapter(`Members → put ${rae.name} on ${REVIEWER}`, async () => {
    await openWorkspaceSettings(page);
    await changeRole(page, seed, rae, REVIEWER, REVIEWER);
    await beat();
  });

  await chapter(`${rae.name} comments — and edits nothing`, async () => {
    await signInAs(page, rae.email);
    await expectReadOnlyItem(page, seed.paymentsItemKey, seed.paymentsItemTitle);
    await page.getByRole('button', { name: 'Add a comment…' }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('Reviewed — looks right.');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(main(page).getByText('Reviewed — looks right.')).toBeVisible({ timeout: 30_000 });
    await beat();
  });

  await chapter('The Runs room is gone — from the rail and from its address', async () => {
    // A positive control first: the rail rendered, and Plans is on it.
    await expect(rail(page).getByRole('link', { name: 'Plans', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Runs', exact: true })).toHaveCount(0);
    const response = await page.goto('/runs');
    expect(response?.status(), '/runs answers not-found').toBe(404);
    await beat();
  });

  await chapter('Project settings: no Roles row, no role column', async () => {
    await signInAs(page, seed.managerEmail);
    await page.goto('/settings/project');
    const projectRail = page.getByRole('navigation', { name: 'Project settings' });
    await expect(projectRail.getByRole('link', { name: 'Members & access' })).toBeVisible();
    await expect(projectRail.getByRole('link', { name: 'Roles & permissions' })).toHaveCount(0);
    await beat();

    await projectRail.getByRole('link', { name: 'Members & access' }).click();
    await page.waitForURL('**/settings/project/members');
    // The Members section is MOUNTED — and says where a person's role now comes from.
    await expect(main(page).getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
    await expect(
      main(page).getByText(/What each can do comes from their workspace role/),
    ).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Workspace roles →' })).toBeVisible();
    await main(page).getByRole('heading', { name: 'Members', level: 2 }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('combobox', { name: /^Role for / })).toHaveCount(0);
    await beat();
  });

  await chapter('The old Roles address lands on the workspace’s', async () => {
    await page.goto('/settings/project/roles');
    await page.waitForURL(
      (url) => url.pathname === '/settings/workspace/roles' && url.searchParams.has('from'),
    );
    await expect(
      main(page).getByText(
        'Roles now live on the workspace — the same role in every project. You were sent here from the project’s old Roles page.',
      ),
    ).toBeVisible();
    await expect(page.locator('[data-role-row]')).toHaveCount(4);
    await beat();
  });
});

test('a Member reads every role and changes none; a workspace with no report shows no notice', async ({
  page,
}) => {
  // Theo belongs to ONE workspace of the org, so for them the tier is not
  // revealed: their Members and Roles doors are the org page's fold-in.
  await signInAs(page, seed.memberEmail);
  await page.goto('/settings/organization');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 }).last()).toBeVisible();
  // Read-only: the role as text, no picker in the DOM, no report.
  await expect(main(page).getByLabel(`Role for ${seed.reviewerName}: Member`)).toBeVisible();
  await expect(page.getByRole('combobox', { name: /^Role for / })).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);

  await page.getByRole('link', { name: 'Open roles' }).click();
  await page.waitForURL('**/settings/workspace/roles');
  await expect(page.locator('[data-role-row]')).toHaveCount(3);
  await expect(
    main(page).getByText('Only a workspace Manager can create or change roles.'),
  ).toBeVisible();
  await expect(main(page).getByTestId('create-role')).toHaveCount(0);

  // The Manager, in Sales — nobody there was changed by the migration.
  await signInAs(page, seed.managerEmail);
  await pinContextCookies(page, {
    workspaceId: seed.salesWorkspaceId,
    organizationId: seed.organizationId,
  });
  await page.goto('/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
  await expect(picker(page, 'Maya Manager')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test('the only Manager cannot step down — their own role is locked, and says why', async ({
  page,
}) => {
  // A workspace whose ONLY rostered Manager is not org-managed: its org Owner
  // (who would be a Manager by their org role) is not on its roster.
  const owner = await usersService.createUser({
    email: `wr-lm-owner-${Date.now()}@example.com`,
    password: WR_PASSWORD,
    name: 'Olga Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Ops',
    ownerUserId: owner.id,
  });
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { aiIncludedSeat: true },
  });
  const { workspace: opsTwo } = await workspacesService.createWorkspace({
    name: 'Ops Two',
    ownerUserId: owner.id,
    organizationId: workspace.organizationId,
  });
  const lead = await usersService.createUser({
    email: `wr-lm-lead-${Date.now()}@example.com`,
    password: WR_PASSWORD,
    name: 'Lee Lead',
  });
  await workspacesService.addMember({ userId: lead.id, workspaceId: workspace.id });
  const other = await usersService.createUser({
    email: `wr-lm-other-${Date.now()}@example.com`,
    password: WR_PASSWORD,
    name: 'Nia Other',
  });
  await workspacesService.addMember({ userId: other.id, workspaceId: workspace.id });
  // Lee is in both of the org's workspaces, so the tier is revealed for them.
  await workspacesService.addMember({ userId: lead.id, workspaceId: opsTwo.id });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: lead.id, workspaceId: workspace.id } },
    data: { workspaceRole: 'manager' },
  });
  await adminDb.workspaceMembership.delete({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
  });

  await page.context().clearCookies();
  await signIn(page, lead.email, WR_PASSWORD);
  await pinContextCookies(page, {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
  });
  await page.goto('/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();

  // Refused BEFORE a press (design panel 1c): the only stored Manager's own
  // picker is locked, and says what unlocks it. (The server refuses the same
  // change with LastManagerError — `tests/workspaces/memberRoleRoute.test.ts`.)
  const self = picker(page, 'Lee Lead');
  await expect(self).toContainText('Manager');
  await expect(self).toBeDisabled();
  await expect(
    main(page).getByText(
      'You’re the only Manager. Make someone else a Manager before changing your own role.',
    ),
  ).toBeVisible();
  // Another person's row is operable — the lock is the last-Manager rule, not a
  // read-only page.
  await expect(picker(page, 'Nia Other')).toBeEnabled();
  expect(await committedRole(lead.id, workspace.id)).toBe('manager');
});
