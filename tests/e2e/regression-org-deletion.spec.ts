import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { createTestPerson } from './_helpers/testPerson';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { adminDb } from '../helpers/adminDb';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { formatDate } from '@/lib/utils/datetime';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';

// DELETING AN ORGANIZATION, CAREFULLY — THE ACCEPTANCE RECEIPT
// (Story MOTIR-6306 · Subtask MOTIR-6405; the story's Verification, cases 1, 2, 4).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
//   Olive — the Owner. Opens Delete organization, reads what goes, types the
//           name, gets the password wrong once (nothing happens), then schedules.
//   Mo    — a Member. Sees the organization closing on the page he works in:
//           the bar naming the date and Olive, the read-only note, Create
//           disabled, and a direct edit refused by the server.
//   Olive — cancels from the bar. The bar is gone and Mo can edit again.
//
// ── WAITS ────────────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal (the coding convention § E2E): the schedule's
// and the cancel's responses, the server-rendered scheduled row, and the closing
// bar's `role="status"` landmark — asserted MOUNTED before its words are read, so
// the content assertions cannot pass against a bar that is not there. A `beat()`
// only ever follows the signal; it never stands in for one.
//
// The motir-ai side (the closing call a schedule makes, the reopen a cancel
// makes) is the lane's `E2E_TEST_BILLING` boundary mock (`lib/test-billing-mock.ts`).

const OLIVE = 'acceptance-org-deletion-olive@example.com';
const MO = 'acceptance-org-deletion-mo@example.com';
const ORG_NAME = 'Northwind';

interface Tenant {
  organizationId: string;
  workspaceId: string;
  itemId: string;
  oliveName: string;
}

async function seedTenant(page: Page): Promise<Tenant> {
  await signUp(page, OLIVE);
  const olive = await adminDb.user.findFirstOrThrow({ where: { email: OLIVE } });
  const workspace = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${OLIVE.split('@')[0]!}'s Workspace` },
  });
  const organizationId = workspace.organizationId;
  await adminDb.organization.update({ where: { id: organizationId }, data: { name: ORG_NAME } });

  const mo = await createTestPerson({ email: MO, password: SHELL_PASSWORD, name: 'Mo' });
  await adminDb.organizationMembership.create({
    data: { organizationId, userId: mo.id, role: ORGANIZATION_ROLE.member },
  });
  await workspacesService.addMember({ userId: mo.id, workspaceId: workspace.id });

  // The workspace's own project (a fresh account has one) and one work item in
  // it — what Mo tries to edit.
  const project = await adminDb.project.findFirstOrThrow({
    where: { workspaceId: workspace.id },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Plan the offsite' },
    { userId: olive.id, workspaceId: workspace.id },
  );
  return {
    organizationId,
    workspaceId: workspace.id,
    itemId: item.id,
    oliveName: olive.name,
  };
}

async function signInAt(page: Page, email: string, t: Tenant) {
  await signIn(page, email, SHELL_PASSWORD);
  await pinContextCookies(page, { workspaceId: t.workspaceId, organizationId: t.organizationId });
}

/** The closing bar — asserted mounted (its `status` landmark) before it is read. */
async function closingBar(page: Page) {
  // Role-rooted: the `status` landmark itself, found by what it says — so the
  // accessibility tree (not a stale streamed copy) is what is asserted mounted.
  const bar = page.getByRole('status').filter({ hasText: 'for deletion on' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-testid', 'organization-closing-banner');
  return bar;
}

/** The top bar's Create control — a live BUTTON only for someone who can edit;
 *  a read-only reader gets a disabled, non-button placeholder in its place. */
function createButton(page: Page) {
  return page.getByRole('button', { name: 'Create work item' });
}

function editEstimate(page: Page, itemId: string) {
  return page.request.patch(`/api/work-items/${itemId}/estimate`, { data: { points: 3 } });
}

test('an Owner schedules a deletion carefully, a Member sees it close, and the Owner takes it back', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(300_000);
  // The receipt belongs to the STORY.
  acceptanceStory('MOTIR-6306');

  await resetDatabase();
  const t = await seedTenant(page);
  let dueDate = '';

  await chapter('The Owner opens Delete organization — and sees what goes, counted', async () => {
    await pinContextCookies(page, { workspaceId: t.workspaceId, organizationId: t.organizationId });
    await page.goto('/settings/organization');
    // The org's Danger zone is anchored by its own control: a one-workspace org
    // also folds in that workspace's Danger zone, so the heading is not unique.
    await expect(page.getByRole('button', { name: 'Transfer ownership…' })).toBeEnabled();
    // Nothing is closing yet: no bar.
    await expect(page.getByTestId('organization-closing-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete organization…' }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${ORG_NAME}?` });
    await expect(dialog).toBeVisible();
    const list = dialog.getByTestId('org-deletion-consequences');
    await expect(list).toContainText('1 workspace, 1 project');
    await expect(list).toContainText('2 members');
    await expect(list).toContainText('Your subscription won’t renew.');
    await expect(dialog.getByText(/^Everything is erased on /)).toBeVisible();
    await beat();
    await beat();
  });

  await chapter('The exact name, then a wrong password — nothing is scheduled', async () => {
    const dialog = page.getByRole('dialog', { name: `Delete ${ORG_NAME}?` });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const confirm = dialog.getByRole('button', { name: 'Schedule deletion' });
    await dialog.getByLabel(`Type ${ORG_NAME} to confirm`).fill('Northwnd');
    await expect(dialog.getByText('That isn’t this organization’s name.')).toBeVisible();
    await expect(confirm).toBeDisabled();
    await beat();

    await dialog.getByLabel(`Type ${ORG_NAME} to confirm`).fill(ORG_NAME);
    await dialog.getByLabel('Your password').fill('not-the-password');
    const refused = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/organizations/${t.organizationId}/deletion`) &&
        r.request().method() === 'POST',
    );
    await confirm.click();
    expect((await refused).status()).toBe(403);
    await expect(dialog.getByRole('alert')).toContainText('That password isn’t right.');
    expect(
      await adminDb.organizationDeletionRequest.count({
        where: { organizationId: t.organizationId },
      }),
    ).toBe(0);
    await beat();
  });

  await chapter('The right password schedules — the date, and Transfer disabled', async () => {
    const dialog = page.getByRole('dialog', { name: `Delete ${ORG_NAME}?` });
    await dialog.getByLabel('Your password').fill(SHELL_PASSWORD);
    const scheduled = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/organizations/${t.organizationId}/deletion`) &&
        r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Schedule deletion' }).click();
    const response = await scheduled;
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { erasureDueAt: string };
    dueDate = formatDate(body.erasureDueAt, 'en');

    const row = page.getByRole('main').getByTestId('org-deletion-scheduled');
    await expect(row).toBeVisible();
    await expect(row).toContainText(`Scheduled for deletion on ${dueDate}`);
    await expect(page.getByRole('button', { name: 'Transfer ownership…' })).toBeDisabled();
    await expect(
      page.getByRole('main').getByText('Cancel the deletion to transfer ownership.'),
    ).toBeVisible();
    const bar = await closingBar(page);
    await expect(bar).toContainText(`${ORG_NAME} is scheduled for deletion on ${dueDate}.`);
    await beat();
    await beat();
  });

  await chapter('A Member sees the organization closing — and cannot edit', async () => {
    await signInAt(page, MO, t);
    await page.goto('/items');
    const bar = await closingBar(page);
    await expect(bar).toContainText(
      `${t.oliveName} scheduled ${ORG_NAME} for deletion on ${dueDate}.`,
    );
    await expect(bar.getByRole('link', { name: 'Download your data' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);
    await expect(page.getByRole('main').getByTestId('organization-read-only-note')).toContainText(
      `Read-only while ${ORG_NAME} closes`,
    );
    await expect(createButton(page)).toHaveCount(0);
    // The server refuses a direct write too — the UI is not the only gate.
    expect((await editEstimate(page, t.itemId)).status()).toBe(403);
    await beat();
    await beat();
  });

  await chapter('The Owner cancels from the bar — and everything returns', async () => {
    await signInAt(page, OLIVE, t);
    await page.goto('/items');
    const bar = await closingBar(page);
    await bar.getByRole('button', { name: 'Cancel deletion' }).click();
    const confirm = page.getByRole('dialog', { name: `Cancel the deletion of ${ORG_NAME}?` });
    await expect(confirm).toBeVisible();
    await beat();
    const cancelled = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/organizations/${t.organizationId}/deletion`) &&
        r.request().method() === 'DELETE',
    );
    await confirm.getByRole('button', { name: 'Cancel deletion' }).click();
    expect((await cancelled).status()).toBe(200);
    await expect(
      page
        .getByRole('region', { name: /^Notifications/ })
        .getByText(
          `Deletion cancelled. ${ORG_NAME} is back to normal, and everyone has been told.`,
        ),
    ).toBeVisible();
    await expect(page.getByTestId('organization-closing-banner')).toHaveCount(0);
    await beat();

    // …and Mo can edit again.
    await signInAt(page, MO, t);
    await page.goto('/items');
    await expect(page.getByRole('heading', { level: 1, name: 'Work Items' })).toBeVisible();
    await expect(page.getByTestId('organization-closing-banner')).toHaveCount(0);
    await expect(page.getByTestId('organization-read-only-note')).toHaveCount(0);
    await expect(createButton(page)).toBeVisible();
    expect((await editEstimate(page, t.itemId)).status()).toBe(200);
    await beat();
  });
});
