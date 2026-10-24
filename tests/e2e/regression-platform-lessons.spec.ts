import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  fixtureLesson,
  storedLesson,
  writePlatformLessonsFixture,
} from './_helpers/platform-lessons-fixture';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import enMessages from '@/messages/en.json';

// PLATFORM STAFF CURATE THE PLANNER'S LESSONS — THE ACCEPTANCE RECEIPT
// (Story MOTIR-1408 · Subtask MOTIR-1413).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The denied path first: a tenant owner gets the ordinary 404. Then the same
// person, made platform staff, opens Planning lessons from the console and sees
// two organisations' lessons beside a global one; opens a tenant lesson,
// switches it OFF (a reason is required), and promotes another tenant's lesson
// to GLOBAL. Each act is checked three ways: the server-rendered page after
// revalidation, the store motir-ai answers from, and the platform audit row —
// never the dialog closing.
//
// One person holds both roles (every extra sign-in is ~11s of clip that shows
// nothing). The edge states (no-op, refused, unavailable, read-only roles) are
// asserted in `tests/platform/platformLessonsService.test.ts`, which runs on
// every PR; the clip is the happy path a human accepts the story from.

const ui = enMessages.platformAdmin.lessons;
const OWNER = 'acceptance-planning-lessons@example.com';
const OFF_REASON = 'Contradicts the new sizing guide; switching off while we rewrite it';
const PROMOTE_REASON = 'Holds for every organisation; text names nobody';

test('platform staff review lessons across tenants, switch one off and promote one to global; a tenant owner is denied', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1408');

  await resetDatabase();
  resetBillingFixture();
  const seed = await seedBillingOwner(page, OWNER);

  // A SECOND tenant, so the list is cross-tenant for real: its own owner,
  // organisation, workspace and project.
  const other = await usersService.createUser({
    email: 'acceptance-lessons-other@example.com',
    password: 'not-used-in-this-walk-0',
    name: 'Other Owner',
  });
  const { workspace: otherWorkspace } = await workspacesService.createWorkspace({
    name: 'Globex',
    ownerUserId: other.id,
  });
  const otherProject = await projectsService.createProject({
    workspaceId: otherWorkspace.id,
    actorUserId: other.id,
    name: 'Launchpad',
    identifier: 'LAUN',
  });
  const ownOrg = await adminDb.organization.findUniqueOrThrow({
    where: { id: seed.organizationId },
  });
  const otherOrg = await adminDb.organization.findUniqueOrThrow({
    where: { id: otherWorkspace.organizationId },
  });

  writePlatformLessonsFixture({
    lessons: [
      fixtureLesson({
        id: 'lsn_own',
        title: 'Split stories by user value, not by layer',
        tenant: {
          coreOrganizationId: seed.organizationId,
          coreWorkspaceId: seed.workspaceId,
          coreProjectId: seed.projectId,
        },
      }),
      fixtureLesson({
        id: 'lsn_other',
        title: 'Name the acceptance test before the subtasks',
        recurrenceCount: 5,
        tenant: {
          coreOrganizationId: otherWorkspace.organizationId,
          coreWorkspaceId: otherWorkspace.id,
          coreProjectId: otherProject.id,
        },
      }),
      fixtureLesson({
        id: 'lsn_global',
        title: 'A design card blocks the code that renders it',
        mistakeType: 'planning_craft',
      }),
    ],
  });

  await chapter('The console does not exist for a tenant owner', async () => {
    const res = await page.goto('/admin/planning-lessons');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: ui.title, level: 1 })).toHaveCount(0);
    await beat();
  });

  // The owner is made platform staff; the gate reads a fresh row per request.
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  const main = page.getByRole('main');
  const row = (id: string) => main.getByTestId(`lesson-row-${id}`);

  await chapter('Two organisations’ lessons and a global one, on one list', async () => {
    await page.goto('/admin');
    await page
      .getByRole('link', { name: enMessages.platformAdmin.shell.navPlanningLessons })
      .click();
    await expect(page).toHaveURL(/\/admin\/planning-lessons$/);
    await expect(page.getByRole('heading', { name: ui.title, level: 1 })).toBeVisible();
    await expect(row('lsn_own')).toContainText(ownOrg.name);
    await expect(row('lsn_other')).toContainText(otherOrg.name);
    await expect(row('lsn_other')).toContainText('Launchpad');
    await expect(row('lsn_global')).toContainText(ui.owner.global);
    await beat();
  });

  await chapter('A lesson is switched off, with a reason', async () => {
    await row('lsn_own').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/admin\/planning-lessons\/lsn_own$/);
    await expect(main.getByTestId('lesson-injection')).toHaveAttribute('data-state', 'injected');
    await beat();

    await main.getByRole('switch', { name: ui.detail.switchLabel }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(ui.off.title);
    const confirm = dialog.getByRole('button', { name: ui.off.confirm });
    // THE REFUSAL FIRST: no reason, no change.
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox', { name: ui.reasonLabel }).fill(OFF_REASON);
    await beat();
    await confirm.click();

    // Authoritative: the re-rendered page, the store motir-ai answers from, the audit row.
    await expect(main.getByTestId('lesson-injection')).toHaveAttribute('data-state', 'off');
    expect(storedLesson('lsn_own')?.enabled).toBe(false);
    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: 'ai.lesson.disable' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetId: 'lsn_own', reason: OFF_REASON });
    await expect(main.getByTestId('lesson-history-entry')).toContainText(ui.historyAction.disable);
    await beat();
  });

  await chapter('Another organisation’s lesson is promoted to global', async () => {
    await page.goto('/admin/planning-lessons/lsn_other');
    await main.getByRole('button', { name: ui.promote.open }).click();
    await page
      .getByRole('menuitem', { name: new RegExp(ui.promote.toGlobal) })
      .first()
      .click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(ui.promote.globalTitle);
    await expect(dialog.getByTestId('lesson-promote-warning')).toContainText(otherOrg.name);
    await beat();
    await dialog.getByRole('textbox', { name: ui.reasonLabel }).fill(PROMOTE_REASON);
    await dialog.getByRole('button', { name: ui.promote.confirm }).click();

    await expect(main.getByText(ui.owner.global).first()).toBeVisible();
    expect(storedLesson('lsn_other')?.tenant).toBeNull();
    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: 'ai.lesson.promote' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetId: 'lsn_other', reason: PROMOTE_REASON });
    await expect(main.getByTestId('lesson-history-entry')).toContainText(ui.historyAction.promote);
    await beat();
  });

  await chapter('The list shows both changes', async () => {
    await page.goto('/admin/planning-lessons');
    await expect(row('lsn_own').getByTestId('lesson-injection')).toHaveAttribute(
      'data-state',
      'off',
    );
    await expect(row('lsn_other')).toContainText(ui.owner.global);
    await expect(row('lsn_other')).not.toContainText(otherOrg.name);
    await beat();
  });
});
