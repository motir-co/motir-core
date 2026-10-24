import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, seedReadyHostedCard } from './_helpers/hosted-run-seed';
import { resetHostedRunJournal, writeHostedRunFixture } from './_helpers/hosted-run-boundary';
import {
  readPlannerModelFixture,
  writePlannerModelFixture,
} from './_helpers/planner-model-fixture';
import type { PlannerModelFixture } from '@/lib/test-planner-model-mock';
import enMessages from '@/messages/en.json';

// PLATFORM ADMINS CURATE WHICH MODELS MOTIR MAY PLAN AND RUN WITH — THE
// ACCEPTANCE RECEIPT (Story MOTIR-7521 · Subtask MOTIR-7530).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Two lists and one consequence. On AI planning, a superadmin adds a model to
// the planning list with a reason, finds it offered in an audience picker, and
// is refused removing a model an audience plans on. On Hosted-run models, the
// same person removes an unused model and is refused removing one a project's
// override uses. Then, as that project's owner, the Run hosted picker no longer
// offers the removed model. Last, an operator sees both lists read-only.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// Both pages are server rendered and write through Server Actions, so motir-ai
// is answered by the two undici intercepts this lane installs, steered by their
// fixture files: `lib/test-planner-model-mock.ts` (the planning list and the
// audience settings) and `lib/test-hosted-run-mock.ts` (`/v1/agent-models`, the
// hosted-run offer). The run-model list itself is motir-core's own table, read
// back through `adminDb` as the authoritative signal for each write.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// One person holds both roles (the planner-model receipt's measured reason:
// every extra sign-in is clip that shows nothing). The unavailable states are
// the second test in this file and carry no pacing of their own.

const lists = enMessages.platformAdmin.modelLists;
const planning = enMessages.platformAdmin.planningList;
const runModels = enMessages.platformAdmin.runModels;
const aiPlanning = enMessages.platformAdmin.aiPlanning;
const shell = enMessages.platformAdmin.shell;

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const GLM = 'glm-5.2';

/** Customer plans on Sonnet; GLM is offered but not yet on the planning list. */
function plannerFixture(): PlannerModelFixture {
  return {
    settings: [
      { audience: 'customer', model: SONNET },
      { audience: 'meta', model: OPUS },
      { audience: 'internal', model: OPUS },
    ],
    offered: [
      { id: OPUS, provider: 'anthropic' },
      { id: SONNET, provider: 'anthropic' },
      { id: GLM, provider: 'z-ai' },
    ],
    list: [{ model: OPUS }, { model: SONNET }],
  };
}

/** The hosted-run offer: three models, Opus the default at every level. */
function hostedFixture() {
  writeHostedRunFixture({
    models: {
      ids: [OPUS, SONNET, GLM],
      default: OPUS,
      defaultsByDifficulty: { trivial: OPUS, low: OPUS, medium: OPUS, high: OPUS },
      providers: { [GLM]: 'z-ai' },
    },
    mayRun: true,
  });
  resetHostedRunJournal();
}

const auditOf = (action: string) => adminDb.platformAuditLog.findMany({ where: { action } });

async function confirmWithReason(page: Page, confirmLabel: string, reason: string) {
  const dialog = page.getByRole('alertdialog');
  const confirm = dialog.getByRole('button', { name: confirmLabel });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: lists.reasonLabel }).fill(reason);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  // Every confirm here closes its dialog once the action has answered. Until it
  // has, the modal hides `main` from the accessibility tree, so a `main`-scoped
  // absence would pass vacuously.
  await expect(dialog).toHaveCount(0);
}

test.describe.configure({ timeout: 120_000 });

test('a superadmin curates both model lists, and a project’s Run hosted picker follows', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7521');

  await resetDatabase();
  writePlannerModelFixture(plannerFixture());
  hostedFixture();

  const seed = await seedHostedRun('acceptance-model-lists@example.com', 'MLS');
  const card = await seedReadyHostedCard(seed, 'Tidy the release notes');
  // The project's own override: Sonnet for its hardest work.
  await adminDb.project.update({
    where: { id: seed.projectId },
    data: { hostedModelHigh: SONNET },
  });
  await adminDb.user.update({
    where: { id: seed.userId },
    data: { platformRole: 'superadmin' },
  });
  await signIn(page, seed.email, seed.password);

  const main = page.getByRole('main');
  const planningRow = (model: string) => main.getByTestId(`planner-model-list-row-${model}`);
  const runRow = (model: string) => main.getByTestId(`run-model-list-row-${model}`);

  await chapter('The planning list names each model and whether motir-ai offers it', async () => {
    await page.goto('/admin/monitoring');
    await page.getByRole('link', { name: shell.navAiPlanning }).click();
    await expect(page).toHaveURL(/\/admin\/ai-planning$/);
    await expect(page.getByRole('heading', { name: planning.title })).toBeVisible();
    await expect(planningRow(OPUS)).toContainText(lists.offered);
    await expect(planningRow(OPUS)).toContainText(planning.fallback);
    await expect(planningRow(SONNET)).toContainText(aiPlanning.audience.customer.name);
    await expect(planningRow(GLM)).toHaveCount(0);
    await beat();
  });

  await chapter(
    'A superadmin adds a model with a reason, and an audience can plan on it',
    async () => {
      await main.getByRole('button', { name: lists.add }).click();
      const dialog = page.getByRole('alertdialog');
      // The picker offers motir-ai's candidates — plannable and not yet listed
      // (MOTIR-7614) — so the admin picks GLM rather than typing its id.
      await dialog.getByRole('combobox', { name: planning.add.modelLabel }).click();
      await expect(page.getByRole('option', { name: new RegExp(SONNET) })).toHaveCount(0);
      await page.getByRole('option', { name: new RegExp(GLM) }).click();
      await beat();
      await confirmWithReason(page, planning.add.confirm, 'Trial GLM 5.2 for internal planning');

      // Authoritative: the server-rendered row after revalidation, the list motir-ai
      // now holds, and the audit row — never the dialog closing.
      await expect(planningRow(GLM)).toContainText(lists.added.justNowByYou);
      expect(readPlannerModelFixture().list?.map((e) => e.model)).toContain(GLM);
      const added = await auditOf('ai.planner_model_list.add');
      expect(added.map((r) => r.reason)).toEqual(['Trial GLM 5.2 for internal planning']);
      await beat();

      await main
        .getByTestId('ai-planning-row-internal')
        .getByRole('combobox', {
          name: `${aiPlanning.pickerLabel} — ${aiPlanning.audience.internal.name}`,
        })
        .click();
      await expect(page.getByRole('option', { name: new RegExp(GLM) })).toBeVisible();
      await beat();
      await page.keyboard.press('Escape');
    },
  );

  await chapter('Removing the model customers plan on is refused, naming them', async () => {
    await planningRow(SONNET)
      .getByRole('button', { name: `${lists.remove} ${SONNET}` })
      .click();
    await confirmWithReason(page, planning.remove.confirm, 'Consolidate on Opus');
    await expect(planningRow(SONNET).getByRole('alert')).toContainText(
      aiPlanning.audience.customer.name,
    );
    expect(readPlannerModelFixture().list?.map((e) => e.model)).toContain(SONNET);
    expect(await auditOf('ai.planner_model_list.remove')).toHaveLength(0);
    await beat();
  });

  await chapter('The hosted-run list: an unused model is removed', async () => {
    await page.getByRole('link', { name: shell.navRunModels }).click();
    await expect(page).toHaveURL(/\/admin\/run-models$/);
    await expect(page.getByRole('heading', { name: runModels.title, level: 1 })).toBeVisible();
    for (const model of [OPUS, SONNET, GLM]) {
      await expect(runRow(model)).toContainText(lists.added.seeded);
    }
    await expect(runRow(OPUS)).toContainText('Platform default · trivial, low, medium, high');
    await expect(runRow(SONNET)).toContainText('1 project');
    await beat();

    await runRow(GLM)
      .getByRole('button', { name: `${lists.remove} ${GLM}` })
      .click();
    await confirmWithReason(page, runModels.remove.confirm, 'Not ready for hosted runs');
    await expect(runRow(GLM)).toHaveCount(0);
    await expect(runRow(OPUS)).toBeVisible();
    const listed = await adminDb.platformRunModel.findMany({ orderBy: { model: 'asc' } });
    expect(listed.map((r) => r.model)).toEqual([OPUS, SONNET]);
    expect(await auditOf('ai.run_model_list.remove')).toHaveLength(1);
    await beat();
  });

  await chapter('A model a project uses is refused, naming the project and level', async () => {
    await runRow(SONNET)
      .getByRole('button', { name: `${lists.remove} ${SONNET}` })
      .click();
    await confirmWithReason(page, runModels.remove.confirm, 'Consolidate on Opus');
    const refusal = runRow(SONNET).getByRole('alert');
    await expect(refusal).toContainText(`(${seed.projectKey}) for high`);
    expect(await adminDb.platformRunModel.count({ where: { model: SONNET } })).toBe(1);
    await beat();
  });

  await chapter('The project’s Run hosted picker offers only the listed models', async () => {
    const models = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/hosted-runs/models' &&
        res.request().method() === 'GET',
    );
    await page.goto(`/items/${card.identifier}`);
    const body = (await (await models).json()) as { models: { id: string }[] };
    expect(body.models.map((m) => m.id).sort()).toEqual([OPUS, SONNET]);
    await main.getByRole('combobox', { name: 'Model' }).click();
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('option').filter({ hasText: GLM })).toHaveCount(0);
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('An operator reads both lists, and changes neither', async () => {
    await adminDb.user.update({ where: { id: seed.userId }, data: { platformRole: 'operator' } });
    await page.goto('/admin/run-models');
    await expect(main.getByTestId('run-model-list-read-only')).toHaveText(lists.readOnly);
    await expect(main.getByRole('button', { name: lists.add })).toHaveCount(0);
    await expect(main.getByRole('button', { name: new RegExp(`^${lists.remove}`) })).toHaveCount(0);
    await beat();
    await page.goto('/admin/ai-planning');
    await expect(main.getByTestId('planner-model-list-read-only')).toHaveText(lists.readOnly);
    await expect(main.getByRole('button', { name: lists.add })).toHaveCount(0);
    await beat();
  });
});

test('with motir-ai down, both lists show the error card with Retry and no rows', async ({
  page,
}) => {
  await resetDatabase();
  writePlannerModelFixture({ ...plannerFixture(), unavailable: true });
  writeHostedRunFixture({ models: { status: 503 }, mayRun: true });
  const seed = await seedHostedRun('acceptance-model-lists-down@example.com', 'MLD');
  await adminDb.user.update({
    where: { id: seed.userId },
    data: { platformRole: 'superadmin' },
  });
  await signIn(page, seed.email, seed.password);
  const main = page.getByRole('main');

  await page.goto('/admin/ai-planning');
  const planningDown = main.getByTestId('planner-model-list-unavailable');
  await expect(planningDown).toContainText(planning.unavailable.title);
  await expect(planningDown.getByRole('button', { name: lists.retry })).toBeVisible();
  await expect(main.getByTestId(/^planner-model-list-row-/)).toHaveCount(0);

  await page.goto('/admin/run-models');
  const runDown = main.getByTestId('run-model-list-unavailable');
  await expect(runDown).toContainText(runModels.unavailable.title);
  await expect(runDown.getByRole('button', { name: lists.retry })).toBeVisible();
  await expect(main.getByTestId(/^run-model-list-row-/)).toHaveCount(0);
  // Never initialised from a question motir-ai did not answer.
  expect(await adminDb.platformRunModelList.count()).toBe(0);
});
