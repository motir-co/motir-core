import { expect, test, type Page } from '@playwright/test';
import { adminDb } from '../helpers/adminDb';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { seedBillingOwner } from './_helpers/billing';
import {
  readPlannerModelFixture,
  seededPlannerModels,
  storedPlannerModel,
  writePlannerModelFixture,
} from './_helpers/planner-model-fixture';
import { plansService } from '@/lib/services/plansService';
import type { PlannerModelFixture } from '@/lib/test-planner-model-mock';
import enMessages from '@/messages/en.json';

/**
 * AI PLANNING — the console page's states, in a browser (MOTIR-7231 smoke,
 * MOTIR-7235 states; design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10, story MOTIR-7220).
 *
 * ⚠️ IN THE CLOUD LANE ON PURPOSE. The page reads motir-ai, and only this lane
 * (and the acceptance lane) points `MOTIR_AI_URL` at the boundary host the
 * `E2E_TEST_PLANNER_MODEL` seam intercepts. The page is server rendered and its
 * write is a Server Action, so `page.route` reaches neither: each case seeds the
 * fixture file and reads back what a save wrote.
 *
 * The happy path a human watches is `regression-platform-planner-model.spec.ts`;
 * this file is the regression half, run on every PR.
 */

test.describe.configure({ timeout: 120_000 });

const ui = enMessages.platformAdmin.aiPlanning;

test.beforeEach(async () => {
  await resetDatabase();
  writePlannerModelFixture(seededPlannerModels());
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

async function signInAsStaff(
  page: Page,
  email: string,
  role: 'support' | 'operator' | 'superadmin',
) {
  await signUp(page, email);
  await adminDb.user.update({ where: { email }, data: { platformRole: role } });
}

const row = (page: Page, audience: string) =>
  page.getByRole('main').getByTestId(`ai-planning-row-${audience}`);

function withInternal(over: Partial<PlannerModelFixture['settings'][number]>): PlannerModelFixture {
  const fixture = seededPlannerModels();
  fixture.settings = fixture.settings.map((s) =>
    s.audience === 'internal' ? { ...s, ...over } : s,
  );
  return fixture;
}

/** Pick a model on the internal row and confirm with a reason. */
async function saveInternal(page: Page, model: RegExp, reason = 'Cheaper internal planning') {
  const internal = row(page, 'internal');
  await internal
    .getByRole('combobox', { name: `${ui.pickerLabel} — ${ui.audience.internal.name}` })
    .click();
  await page.getByRole('option', { name: model }).click();
  await internal.getByRole('button', { name: ui.save }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('textbox', { name: ui.confirm.reasonLabel }).fill(reason);
  await dialog.getByRole('button', { name: ui.confirm.confirm }).click();
}

test('@smoke a superadmin changes a planning model with a reason; an operator reads it; a tenant gets a 404', async ({
  page,
}) => {
  const email = 'e2e-ai-planning@example.com';
  await signUp(page, email);
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });

  expect((await page.goto('/admin/ai-planning'))?.status()).toBe(404);

  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  await page.goto('/admin/monitoring');
  await page.getByRole('link', { name: 'AI planning' }).click();
  await expect(page).toHaveURL(/\/admin\/ai-planning$/);
  await expect(page.getByRole('heading', { name: ui.card.title })).toBeVisible();

  const internal = row(page, 'internal');
  await expect(internal).toContainText(ui.changed.seeded);
  const save = internal.getByRole('button', { name: ui.save });
  await expect(save).toBeDisabled();

  await internal
    .getByRole('combobox', { name: `${ui.pickerLabel} — ${ui.audience.internal.name}` })
    .click();
  await page.getByRole('option', { name: /claude-sonnet-5-5/ }).click();
  await expect(save).toBeEnabled();
  await save.click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('claude-opus-5-5 → claude-sonnet-5-5');
  const confirm = dialog.getByRole('button', { name: ui.confirm.confirm });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole('textbox', { name: ui.confirm.reasonLabel })
    .fill('Cheaper model for internal planning');
  await confirm.click();

  // The row's own line is the revalidated server read — the authoritative signal.
  await expect(internal).toContainText(ui.changed.justNowByYou);
  await expect(
    page.getByRole('region', { name: /^Notifications/ }).getByText(ui.saved.title, { exact: true }),
  ).toBeVisible();
  expect(storedPlannerModel('internal')).toBe('claude-sonnet-5-5');
  expect(storedPlannerModel('customer')).toBe('claude-opus-5-5');

  const audit = await adminDb.platformAuditLog.findFirstOrThrow({
    where: { action: 'ai.planner_model.set' },
  });
  expect(audit.reason).toBe('Cheaper model for internal planning');

  // An operator reads the same rows, with no control to use.
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
  await page.reload();
  await expect(page.getByRole('main').getByTestId('ai-planning-read-only')).toHaveText(ui.readOnly);
  await expect(row(page, 'internal')).toContainText('claude-sonnet-5-5');
  await expect(page.getByRole('main').getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: ui.save })).toHaveCount(0);
});

test('refused — a model withdrawn between load and save keeps the old value', async ({ page }) => {
  await signInAsStaff(page, 'e2e-ai-planning-refused@example.com', 'superadmin');
  await page.goto('/admin/ai-planning');
  await expect(row(page, 'internal')).toContainText(ui.changed.seeded);

  // motir-ai stops offering Sonnet after the page loaded.
  const fixture = readPlannerModelFixture();
  fixture.offered = fixture.offered.filter((m) => m.id !== 'claude-sonnet-5-5');
  writePlannerModelFixture(fixture);

  await saveInternal(page, /claude-sonnet-5-5/);
  await expect(row(page, 'internal').getByRole('alert')).toContainText(
    'claude-sonnet-5-5 is no longer offered',
  );
  await expect(row(page, 'internal').getByRole('combobox')).toContainText('claude-opus-5-5');
  expect(storedPlannerModel('internal')).toBe('claude-opus-5-5');
  expect(await adminDb.platformAuditLog.count({ where: { action: 'ai.planner_model.set' } })).toBe(
    0,
  );
});

test('unreachable — the save says why and keeps the old value', async ({ page }) => {
  writePlannerModelFixture({
    ...seededPlannerModels(),
    unreachable: { 'claude-sonnet-5-5': 'the provider key was refused (401)' },
  });
  await signInAsStaff(page, 'e2e-ai-planning-unreachable@example.com', 'superadmin');
  await page.goto('/admin/ai-planning');

  await saveInternal(page, /claude-sonnet-5-5/);
  await expect(row(page, 'internal').getByRole('alert')).toHaveText(
    'Not saved: the planner could not reach claude-sonnet-5-5 — the provider key was refused.',
  );
  expect(storedPlannerModel('internal')).toBe('claude-opus-5-5');
  expect(await adminDb.platformAuditLog.count({ where: { action: 'ai.planner_model.set' } })).toBe(
    0,
  );
});

test('withdrawn and failing — a stored model’s chips, for a read-only viewer', async ({ page }) => {
  writePlannerModelFixture(
    withInternal({
      model: 'claude-opus-4-8',
      reachable: false,
      lastProbeAt: '2026-10-02T08:00:00.000Z',
      lastProbeError: null,
    }),
  );
  await signInAsStaff(page, 'e2e-ai-planning-chips@example.com', 'support');
  await page.goto('/admin/ai-planning');

  const internal = row(page, 'internal');
  await expect(internal.getByTestId('ai-planning-withdrawn')).toContainText(ui.withdrawn.chip);
  await expect(internal.getByTestId('ai-planning-withdrawn')).toContainText(
    'falls back to claude-opus-5-5 until a superadmin chooses another',
  );
  await expect(internal.getByTestId('ai-planning-failing')).toContainText(ui.failing.chip);
  await expect(page.getByRole('main').getByRole('combobox')).toHaveCount(0);
});

test('unavailable — motir-ai down renders the error card and no rows', async ({ page }) => {
  writePlannerModelFixture({ ...seededPlannerModels(), unavailable: true });
  await signInAsStaff(page, 'e2e-ai-planning-down@example.com', 'superadmin');
  await page.goto('/admin/ai-planning');

  const card = page.getByRole('main').getByTestId('ai-planning-unavailable');
  await expect(card).toContainText(ui.unavailable.title);
  await expect(page.getByRole('main').getByTestId('ai-planning-row-internal')).toHaveCount(0);

  // Retry re-reads once motir-ai is back.
  writePlannerModelFixture(seededPlannerModels());
  await card.getByRole('button', { name: ui.unavailable.retry }).click();
  await expect(row(page, 'internal')).toContainText(ui.audience.internal.name);
});

test('plan review — a native plan names no model', async ({ page }) => {
  const NATIVE = 'native-planner-model-e2e';
  const seed = await seedBillingOwner(page, 'e2e-ai-planning-review@example.com');
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const plan = await plansService.createPlan(
    seed.projectId,
    { title: 'Native plan', authorSource: 'native', authorHarness: 'Motir', authorModel: NATIVE },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: 'A generated task',
          kind: 'task',
          planningProvenance: { source: 'native', harness: 'Motir', model: NATIVE },
        },
      },
    ],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);

  // Still `planned`, so it is reviewed where a member reviews it — the planning
  // overlay (Story MOTIR-7883 · MOTIR-7887).
  const overlay = await openUndecidedPlan(page, plan.id);
  await expect(overlay.getByText('A generated task').first()).toBeVisible();
  // Includes `title` attributes and the serialised page payload.
  expect(await page.content()).not.toContain(NATIVE);
});
