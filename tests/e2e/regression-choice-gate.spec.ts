import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  TWO_BODY,
  seedChoiceGate,
  type ChoiceGateSeed,
  type SeededChoice,
} from './_helpers/choice-gate-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';

// A PERSON PICKS ONE OF N OPTIONS, AND WHAT THEY CHOSE IS STAMPED — THE ACCEPTANCE
// RECEIPT (Story MOTIR-4914 · Subtask MOTIR-5899).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The planner declined to decide something and brought it back as a CHOICE: a
// question, why it is a choice, the options — each saying what it is BEST FOR — and
// what the pick gates. It waits on To approve. The person opens it, reads the options,
// selects one and chooses it; the card is done and the record says what was picked
// and what planning is now owed. A 4-option choice goes through the SAME port. Then
// the answers a demo would hide: a body that is not complete asks nothing and says
// why; *None of these* sends it back; somebody who may not decide sees the options
// and no controls; and the record keeps its words after the body is edited.
//
// ⚠️ PACED FOR A PERSON. The happy path's holds are `chapter()` / `beat()`'s, taken
// AFTER each assertion, long enough to read each option's best-for chip before it is
// picked. Every WAIT is authoritative — a role, a settled dialog name, the server
// action's response, a status read — never a timed sleep.

test.describe.configure({ timeout: 480_000 });

const ch = en.approvalGate.choice;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

/** The To-approve table's row for a card. */
const rowFor = (page: Page, card: SeededChoice): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier });

/** The choice overlay, by its SETTLED accessible name — the read's own answer. */
const overlayFor = (page: Page, card: SeededChoice): Locator =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: en.workbench.approvals.kind.decision_choice,
      key: card.identifier,
    }),
    exact: true,
  });

/** The item page's Choice section card. */
const choiceCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: ch.kindLabel, exact: true }) });

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Select an option row, press Choose {label}, confirm — and wait on the action. */
async function choose(dialog: Locator, page: Page, label: string) {
  // Select the ROW, as a person does — the whole row is the hit target, and the
  // radio inside it is visually hidden; the checked radio is the committed signal.
  await dialog.locator('label[data-option-id]').filter({ hasText: label }).click();
  await expect(dialog.getByRole('radio', { name: new RegExp(label) })).toBeChecked();
  await dialog.getByRole('button', { name: fill(ch.verb.choose, { label }), exact: true }).click();
  await expect(dialog.getByText(ch.confirm.title, { exact: true })).toBeVisible();
  const action = serverAction(page);
  await dialog
    .getByRole('button', { name: fill(ch.confirm.proceed, { label }), exact: true })
    .click();
  expect((await action).status()).toBe(200);
}

test.describe('a person picks one of N options, and the pick is stamped', () => {
  let seed: ChoiceGateSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedChoiceGate(Date.now().toString(36));
    await signIn(page, seed.ownerEmail, seed.password);
  });

  test('two options and four through one port; the defect, None of these, a reader who may not decide, and a record that outlives an edit', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4914');

    await chapter('The choices are waiting on To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const rows = page
        .getByRole('table', { name: en.workbench.tabs.toApprove })
        .getByTestId(/^approval-row-/);
      // Four complete choices ask; the defective one asks nothing.
      await expect(rows).toHaveCount(4, { timeout: 60_000 });
      await expect(
        rowFor(page, seed.two).getByText(
          fill(en.workbench.approvals.choiceMeta, {
            count: 2,
            question: 'Where do exported reports live once they are generated?',
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(rowFor(page, seed.defect)).toHaveCount(0);
    });
    await beat();

    await chapter(
      'Open it: the question, why it is a choice, and what each option is best for',
      async () => {
        await rowFor(page, seed.two)
          .getByRole('button', { name: en.workbench.approvals.review, exact: true })
          .click();
        const dialog = overlayFor(page, seed.two);
        await expect(dialog).toHaveCount(1, { timeout: 60_000 });
        await expect(dialog.getByText(ch.situation.better_than_your_decision)).toBeVisible();
        await expect(dialog.getByText(ch.youSaid, { exact: true })).toBeVisible();
        await expect(dialog.getByRole('radio')).toHaveCount(2);
        await expect(dialog.getByText('less to operate', { exact: true })).toBeVisible();
        await expect(dialog.getByText('more cost-effective', { exact: true })).toBeVisible();
        // Nothing is picked yet: Choose waits for a row, and says so.
        await expect(
          dialog.getByRole('button', { name: ch.verb.chooseEmpty, exact: true }),
        ).toBeDisabled();
      },
    );
    await beat();

    await chapter('Choose Managed object storage: recorded, and the card is Done', async () => {
      const dialog = overlayFor(page, seed.two);
      await choose(dialog, page, 'Managed object storage');
      await expect(dialog.getByText(ch.state.chosen, { exact: true }).first()).toBeVisible();
      // The record says what the choice gates. MOTIR-6436 (story MOTIR-6069;
      // `picked-option-planning.md`) retired the *"Follow-up planning owed"* wording
      // this receipt was recorded against, so the chapter asserts the fact it is about
      // — the gated work on the record — and not the retired sentence.
      await expect(
        dialog.getByText(
          /^What this choice gates — The report exports story — the storage adapter, the retention rule and the download page\.$/,
        ),
      ).toBeVisible();
      // The To-approve row underneath settled in the same moment.
      await page
        .getByRole('button', { name: new RegExp(`^${en.common.close}`) })
        .first()
        .click();
      await expect(
        rowFor(page, seed.two).getByText(ch.state.chosen, { exact: true }),
      ).toBeVisible();
      await page.goto(`/items/${seed.two.identifier}`);
      await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(choiceCard(page).getByText(ch.record.chose, { exact: true })).toBeVisible();
    });
    await beat();

    await chapter('Four options, through the same port: pick the third', async () => {
      await page.goto('/workbench?tab=approvals');
      await rowFor(page, seed.four)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click();
      const dialog = overlayFor(page, seed.four);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      await expect(dialog.getByRole('radio')).toHaveCount(4);
      await expect(dialog.getByText(ch.situation.two_workflows)).toBeVisible();
      await choose(dialog, page, 'Shared folder');
      await expect(dialog.getByText(ch.state.chosen, { exact: true }).first()).toBeVisible();
    });
    await beat();

    await chapter('A choice that is not complete asks nothing, and says why', async () => {
      await page.goto(`/items/${seed.defect.identifier}`);
      const card = choiceCard(page);
      await expect(card.getByText(ch.defect.title, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        card.getByText(fill(ch.defect.option_without_best_for, { label: 'PDF' })),
      ).toBeVisible();
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(card.getByRole('radio')).toHaveCount(0);
    });
    await beat();

    await chapter('None of these sends it back, and nothing moves', async () => {
      await page.goto('/workbench?tab=approvals');
      await rowFor(page, seed.none)
        .getByRole('button', { name: en.workbench.approvals.review, exact: true })
        .click();
      const dialog = overlayFor(page, seed.none);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      await expect(dialog.getByText(ch.situation.contradicts_your_decision)).toBeVisible();
      await dialog.getByRole('button', { name: ch.verb.noneOfThese, exact: true }).click();
      // A refusal SAYS WHY (MOTIR-6075) — the band asks, and only then sends.
      await dialog
        .getByLabel(en.approvalGate.reason.choice.label)
        .fill('We need the files in our own bucket.');
      const action = serverAction(page);
      await dialog
        .getByRole('button', { name: en.approvalGate.reason.choice.proceed, exact: true })
        .click();
      expect((await action).status()).toBe(200);
      await expect(dialog.getByText(ch.record.willRevise, { exact: true })).toBeVisible();
    });
    await beat();

    await chapter('Somebody who may not decide sees every option and no controls', async () => {
      await signIn(page, seed.viewerEmail, seed.password);
      await page.goto(
        `/workbench?approval=${seed.watched.identifier}&approvalKind=decision_choice`,
      );
      const dialog = overlayFor(page, seed.watched);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      await expect(dialog.getByText('Managed object storage', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Our own Postgres', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(
        dialog.getByRole('button', { name: ch.verb.noneOfThese, exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByText(fill(en.approvalGate.waitingOn, { name: 'Yue Owner' })),
      ).toBeVisible();
    });
    await beat();

    await chapter('Later, the body is edited — the record still names the pick', async () => {
      await workItemsService.updateWorkItem(
        seed.two.id,
        { descriptionMd: TWO_BODY.replace('Managed object storage', 'A CDN') },
        { userId: seed.ownerId, workspaceId: seed.workspaceId },
      );
      await signIn(page, seed.ownerEmail, seed.password);
      await page.goto(`/items/${seed.two.identifier}`);
      const card = choiceCard(page);
      await expect(card.getByText(ch.record.chose, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      // The record's own chip still reads the ORIGINAL label, though the body no longer does.
      await expect(card.getByText('Managed object storage', { exact: true })).toBeVisible();
    });
    await beat();
  });
});
