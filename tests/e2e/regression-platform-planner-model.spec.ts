import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import {
  paidOrgState,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  TIERS,
} from './_helpers/billing';
import { openAiPlanningSettings, aiPlanningPanel } from './_helpers/ai-planning-settings';
import {
  seededPlannerModels,
  storedPlannerModel,
  writePlannerModelFixture,
} from './_helpers/planner-model-fixture';
import enMessages from '@/messages/en.json';

// PLATFORM ADMINS CHOOSE WHICH MODEL PLANS — THE ACCEPTANCE RECEIPT
// (Story MOTIR-7220 · Subtask MOTIR-7235). The story's verification recipe, for
// every step that needs no real model run, performed in a browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Two halves of one decision. On the CONSOLE, a superadmin picks the model for
// one audience, is made to say why, and the row says who changed it. On the
// TENANT side, the same person as an org owner finds no model anywhere: the
// project's AI planning room has no model control, and the usage page names no
// model even though motir-ai's usage answer still carries a per-model breakdown.
//
// ── PACING IS DELIBERATE ────────────────────────────────────────────────────
//
// Each `beat` is something a person can see: the three rows, the picker held
// open, the refused confirm, the reason typed, the changed row, then the two
// tenant rooms. One person holds both roles (the internal-billing receipt's
// measured reason: every extra sign-in is ~11s of clip that shows nothing).
//
// The edge states (refused, withdrawn, unreachable, operator read-only,
// unavailable, the plan review) are asserted in
// `cloud-admin-ai-planning.spec.ts`, which runs on every PR; the clip is the
// happy path a human accepts the story from.

const ui = enMessages.platformAdmin.aiPlanning;
const OWNER = 'acceptance-planner-model@example.com';
const REASON = 'Sonnet 5.5 is enough for internal orgs and halves their planning cost';
// The model ids the usage fixture reports, which the page must not name.
const USAGE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

test('a superadmin chooses the planning model, and no tenant surface names it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7220');

  await resetDatabase();
  resetBillingFixture();
  writePlannerModelFixture(seededPlannerModels());

  const seed = await seedBillingOwner(page, OWNER);
  setOrgBillingState(seed.organizationId, {
    ...paidOrgState({ tier: TIERS.pro, balance: 5200 }),
    totalSpend: 12_400,
    monthSpend: 2_800,
    perModel: USAGE_MODELS.map((model) => ({
      model,
      inputTokens: 80_000,
      outputTokens: 20_000,
      credits: 1_400,
    })),
  });
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  const main = page.getByRole('main');
  const internal = main.getByTestId('ai-planning-row-internal');

  await chapter('The console names the model each audience plans on', async () => {
    await page.goto('/admin/monitoring');
    await page.getByRole('link', { name: enMessages.platformAdmin.shell.navAiPlanning }).click();
    await expect(page).toHaveURL(/\/admin\/ai-planning$/);
    await expect(page.getByRole('heading', { name: ui.card.title })).toBeVisible();
    for (const audience of ['customer', 'meta', 'internal'] as const) {
      await expect(main.getByTestId(`ai-planning-row-${audience}`)).toContainText(
        ui.audience[audience].name,
      );
    }
    await expect(internal).toContainText(ui.changed.seeded);
    await beat();
  });

  await chapter('A superadmin picks another model for internal organisations', async () => {
    await internal
      .getByRole('combobox', { name: `${ui.pickerLabel} — ${ui.audience.internal.name}` })
      .click();
    // Held open: only offered models, grouped by provider.
    await expect(page.getByRole('option', { name: /claude-sonnet-5-5/ })).toBeVisible();
    await beat();
    await page.getByRole('option', { name: /claude-sonnet-5-5/ }).click();
    await internal.getByRole('button', { name: ui.save }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('claude-opus-5-5 → claude-sonnet-5-5');
    const confirm = dialog.getByRole('button', { name: ui.confirm.confirm });
    // THE REFUSAL FIRST: no reason, no change.
    await expect(confirm).toBeDisabled();
    await beat();
    await dialog.getByRole('textbox', { name: ui.confirm.reasonLabel }).fill(REASON);
    await expect(confirm).toBeEnabled();
    await beat();
    await confirm.click();

    // Authoritative: the server-rendered row after revalidation, then the store
    // motir-ai answers from, then the audit row — never the dialog closing.
    await expect(internal).toContainText(ui.changed.justNowByYou);
    await expect(internal.getByRole('combobox')).toContainText('claude-sonnet-5-5');
    expect(storedPlannerModel('internal')).toBe('claude-sonnet-5-5');
    expect(storedPlannerModel('customer')).toBe('claude-opus-5-5');
    expect(storedPlannerModel('meta')).toBe('claude-opus-5-5');
    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: 'ai.planner_model.set' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe(REASON);
    await beat();
  });

  await chapter('The project’s AI planning room has no model control', async () => {
    await openAiPlanningSettings(page);
    const panel = aiPlanningPanel(page);
    await expect(
      panel.getByText(enMessages.settings.aiPlanning.planner.dataPracticeCommitment),
    ).toBeVisible();
    for (const model of USAGE_MODELS) {
      await expect(main.getByText(model)).toHaveCount(0);
    }
    await expect(main.getByRole('combobox', { name: /model/i })).toHaveCount(0);
    await beat();
  });

  await chapter('Usage shows spend and runs, and names no model', async () => {
    await page.goto('/settings/organization/usage');
    await expect(main.getByText(enMessages.aiUsage.summary.balance)).toBeVisible();
    // The fixture still reports a per-model breakdown; none of it reaches the page.
    const html = await page.content();
    for (const model of USAGE_MODELS) expect(html).not.toContain(model);
    await beat();
  });
});
