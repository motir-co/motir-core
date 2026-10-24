import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { createTestPerson } from './_helpers/testPerson';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { adminDb } from '../helpers/adminDb';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { organizationDeletionService } from '@/lib/services/organizationDeletionService';
import { workspacesService } from '@/lib/services/workspacesService';

// DELETING AN ORGANIZATION — the regression half of the story's browser flow
// (Story MOTIR-6306 · Subtask MOTIR-6405, cases 3 and 5). The happy path (cases
// 1, 2 and 4) is the acceptance receipt, `regression-org-deletion.spec.ts`.
//
//   3 · an Admin of a closing org sees the bar — naming who scheduled it, with the
//       export link and NO Cancel — and no Danger zone; a member of an org that
//       is NOT closing sees no bar at all (the empty state);
//   5 · a deletion left to run erases its organization out of every former
//       member's org switcher (the terminal state), and a settings URL naming it
//       resolves to an organization they still belong to, never to the tombstone.
//
// The TIME JUMP is a real seam, not a mock the server cannot see: the spec moves
// the stored due date into the past, then presses `POST /api/_test/organizations/
// erasure-sweep`, which runs the hourly `system.organization-erasure-sweep` once
// IN THE SERVER PROCESS (this lane had no job-trigger door; it follows the monitor
// poll door's shape). This lane configures no motir-ai, so the sweep's AI step is
// skipped exactly as on a self-hosted deployment (the sweep's LIVE deps).
//
// Seeding uses the shipped services from the runner, like every seed helper here.

const OLIVE = 'org-deletion-olive@example.com';
const ADA = 'org-deletion-ada@example.com';
const MO = 'org-deletion-mo@example.com';
const NORTHWIND = 'Northwind';
const GLOBEX = 'Globex';

interface Tenant {
  oliveId: string;
  oliveName: string;
  northwind: { organizationId: string; workspaceId: string };
  globex: { organizationId: string; workspaceId: string };
}

async function seedTenant(page: Page): Promise<Tenant> {
  await signUp(page, OLIVE);
  const olive = await adminDb.user.findFirstOrThrow({ where: { email: OLIVE } });
  const home = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${OLIVE.split('@')[0]!}'s Workspace` },
  });
  await adminDb.organization.update({
    where: { id: home.organizationId },
    data: { name: NORTHWIND },
  });
  // A second organization Olive owns — the one left to run to erasure.
  const { workspace: globexWs } = await workspacesService.createWorkspace({
    name: 'Globex HQ',
    ownerUserId: olive.id,
  });
  const globexOrgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: globexWs.id } }))
    .organizationId;
  await adminDb.organization.update({ where: { id: globexOrgId }, data: { name: GLOBEX } });

  const ada = await createTestPerson({ email: ADA, password: SHELL_PASSWORD, name: 'Ada' });
  const mo = await createTestPerson({ email: MO, password: SHELL_PASSWORD, name: 'Mo' });
  await adminDb.organizationMembership.create({
    data: { organizationId: home.organizationId, userId: ada.id, role: ORGANIZATION_ROLE.admin },
  });
  await workspacesService.addMember({ userId: ada.id, workspaceId: home.id });
  for (const [organizationId, workspaceId] of [
    [home.organizationId, home.id],
    [globexOrgId, globexWs.id],
  ] as const) {
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: mo.id, role: ORGANIZATION_ROLE.member },
    });
    await workspacesService.addMember({ userId: mo.id, workspaceId });
  }
  return {
    oliveId: olive.id,
    oliveName: olive.name,
    northwind: { organizationId: home.organizationId, workspaceId: home.id },
    globex: { organizationId: globexOrgId, workspaceId: globexWs.id },
  };
}

/** Schedule through the shipped service, as the Owner — the dialog is the receipt's. */
function scheduleAsOwner(t: Tenant, organizationId: string, name: string) {
  return organizationDeletionService.scheduleOrganizationDeletion({
    organizationId,
    actorUserId: t.oliveId,
    confirmName: name,
    password: SHELL_PASSWORD,
    sessionSignedInAt: new Date(),
  });
}

async function signInAt(page: Page, email: string, ctx: Tenant['northwind']) {
  await signIn(page, email, SHELL_PASSWORD);
  await pinContextCookies(page, ctx);
}

/** The org menu's "Switch organization" list — every org the reader can open. */
async function switchableOrgs(page: Page) {
  await page.getByRole('button', { name: 'Organization menu' }).click();
  const menu = page.getByRole('dialog').filter({ hasText: 'Switch organization' });
  await expect(menu).toBeVisible();
  return menu;
}

test('an Admin sees the closing bar and no control; an org left to run is erased out of every switcher', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await resetDatabase();
  const t = await seedTenant(page);

  // ── The empty state: nothing is closing, so no member sees a bar. ─────────
  await signInAt(page, ADA, t.northwind);
  await page.goto('/settings/organization');
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  await expect(page.getByTestId('organization-closing-banner')).toHaveCount(0);

  // ── Case 3: Northwind closes; its Admin is told, and holds no control. ────
  const northwind = await scheduleAsOwner(t, t.northwind.organizationId, NORTHWIND);
  await page.goto('/settings/organization');
  const bar = page.getByRole('status').filter({ hasText: 'for deletion on' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-testid', 'organization-closing-banner');
  await expect(bar).toContainText(`${t.oliveName} scheduled ${NORTHWIND} for deletion on`);
  await expect(bar.getByRole('link', { name: 'Download your data' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);
  // The org settings rendered (the Admin's cards), and the Danger zone is absent.
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  // The ORG's Danger zone, by its controls — the heading also names the folded-in
  // workspace's own Danger zone, which an Admin of a one-workspace org keeps.
  await expect(page.getByRole('button', { name: 'Transfer ownership…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete organization…' })).toHaveCount(0);
  expect(northwind.status).toBe('scheduled');

  // ── Case 5: Globex is scheduled, falls due, and the sweep runs. ───────────
  const globex = await scheduleAsOwner(t, t.globex.organizationId, GLOBEX);
  await signInAt(page, MO, t.northwind);
  await page.goto('/workbench');
  // Positive control: before the sweep Mo can switch to Globex.
  const menu = await switchableOrgs(page);
  await expect(menu.getByRole('button', { name: GLOBEX })).toBeVisible();
  await page.keyboard.press('Escape');

  await adminDb.organizationDeletionRequest.update({
    where: { id: globex.id },
    data: { erasureDueAt: new Date(Date.now() - 60_000) },
  });
  const sweep = await page.request.post('/api/_test/organizations/erasure-sweep');
  expect(sweep.status()).toBe(200);
  // Northwind is closing but NOT due: exactly one org is erased.
  expect(await sweep.json()).toMatchObject({ erased: 1, failed: 0 });
  expect(
    (await adminDb.organizationDeletionRequest.findUniqueOrThrow({ where: { id: globex.id } }))
      .status,
  ).toBe('erased');

  // Mo: Globex is gone from his switcher, and its settings URL resolves to an
  // organization he still belongs to.
  await page.goto('/workbench');
  await page.getByRole('button', { name: 'Organization menu' }).click();
  // The menu opened (its popover is a dialog); with one organization left there
  // is nothing to switch to, so the whole section — Globex with it — is gone.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Switch organization', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: GLOBEX })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto(`/settings/organization?org=${t.globex.organizationId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByText(GLOBEX)).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Deleted organization')).toHaveCount(0);

  // Olive, the Owner: the same — and her remaining org is still closing.
  await signInAt(page, OLIVE, t.northwind);
  await page.goto(`/settings/organization?org=${t.globex.organizationId}`);
  await expect(page.getByRole('main').getByTestId('org-deletion-scheduled')).toBeVisible();
  await expect(page.getByRole('main').getByText(GLOBEX)).toHaveCount(0);
  expect(
    await adminDb.workspace.count({ where: { organizationId: t.globex.organizationId } }),
  ).toBe(0);
});
