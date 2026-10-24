import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  BLANK_TITLE,
  EDITED_STEP,
  TYPED_COMMAND,
  TYPED_HEADING,
  TYPED_LANGUAGE,
  TYPED_PREVIEW_PATH,
  TYPED_STEP,
  seedPersonHowToTest,
  type PersonHowToTestSeed,
} from './_helpers/person-how-to-test-seed';
import en from '@/messages/en.json';

// A PERSON WRITES AND EDITS HOW TO TEST — THE ACCEPTANCE RECEIPT
// (Story MOTIR-5450 · Subtask MOTIR-5457).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A work item with no pull request linked and nothing written on it. A person
// presses **Add how to test**, writes a heading, a step and a shell command,
// gives it a preview path, and saves. The instructions render where a run's
// would, in the same block, with *Written by Ada Lovelace* where a run's record
// reads *Written by motir run …*. They press **Edit**, everything comes back —
// the fence still labelled `sh` — they add a line, save, and *Earlier versions
// (1)* holds what they replaced. Then the two answers a demo would hide: a
// member who may read but not edit sees the instructions and no door at all,
// and a child of a story that carries the record points at its story and gets
// no door of its own.
//
// ── WHAT THE WORLD IS, AND WHY IT IS SO SMALL ───────────────────────────────
//
// ⚠️ NO PULL REQUEST, NO REPOSITORY, NO DISPATCH RUN — and that IS the story.
// `approval-gates.md` §9's 2026-09-17 amendment exists for a team that keeps its
// pull requests on the host and its work items in Motir (Yue, 2026-09-17:
// *"we don't decide how they should work"*). A seed that linked one would be
// filming the easy case.
//
// ⚠️ WHAT THIS CLIP DOES NOT SHOW, DELIBERATELY: what the block does with a
// repository once a pull request IS linked. That is MOTIR-5691 — a defect that
// predates this story on its agent half — and it is not what a person writes.
// The story is two fields (Yue, 2026-09-18: *"the user edits 2 things"*).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a role, a committed value read back after a
// reload, or the editor's own text. No timed wait anywhere in this file; the
// holds are `chapter()` / `beat()`'s, taken after the assertion.
//
// This spec links no pull request, so it takes no number block
// (`tests/e2e-pull-request-number-blocks.test.ts`).

const htt = en.github.development.howToTest;

let seed: PersonHowToTestSeed;

/** The Development card — the scope every locator below is rooted in.
 *
 *  ⚠️ NOT `page`. A page-rooted `getByTestId` can match React's OUTGOING or
 *  streamed copy of a subtree, which throws strict mode on a tree nobody put
 *  there — `tests/e2e-page-rooted-locators.test.ts` refuses new ones, because
 *  the failure it prevents is a merge-queue EJECTION rather than a red check. */
function developmentCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Development', exact: true }) });
}

/** The How-to-test PART, inside the Development card — never a section of its own. */
function howToTest(page: Page) {
  return developmentCard(page).getByRole('group', { name: htt.title, exact: true });
}

/**
 * The FORM, which REPLACES the record inside the part while it is open.
 *
 * ⚠️ Addressed by test id rather than by role, and scoped rather than
 * page-rooted: §24's accessibility note labels the form *How to test* too, so
 * while it is open the part and the form are two groups carrying one name.
 * Every call below is made while exactly one form is open.
 */
function howToTestForm(page: Page) {
  return developmentCard(page).getByTestId('how-to-test-form');
}

/** The editor's body surface — the component's own `aria-label` is the field label. */
function body(page: Page) {
  return page.getByRole('textbox', { name: htt.form.body, exact: true });
}

test.describe('a person writes How to test', () => {
  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedPersonHowToTest('acceptance');
  });

  test('add it with no pull request linked, edit it, and see who wrote it — while a reader and a child get no door', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5450');

    await chapter('A work item with nothing written on it, and a door to write it', async () => {
      await signIn(page, seed.email, seed.password);
      await page.goto(`/items/${seed.blank.identifier}`);
      await expect(page.getByRole('heading', { name: BLANK_TITLE })).toBeVisible({
        timeout: 60_000,
      });

      const part = howToTest(page);
      await expect(part).toHaveCount(1);
      // The callout says no run has written one. It STAYS when the door is shown
      // (§24, decision 2): a person writing one by hand does not make the run's
      // omission untrue.
      await expect(part.getByText(htt.missing.title, { exact: true })).toBeVisible();
      await expect(part.getByRole('button', { name: htt.add, exact: true })).toBeVisible();
      // Nothing to edit yet.
      await expect(part.getByRole('button', { name: htt.edit, exact: true })).toHaveCount(0);
    });
    await beat();

    await chapter('Two fields: the instructions, and where to open them', async () => {
      await howToTest(page).getByRole('button', { name: htt.add, exact: true }).click();
      const form = howToTestForm(page);
      await expect(form).toBeVisible();

      // ⚠️ NOTHING IN THIS FORM NAMES A REPOSITORY OR A COMMIT (§24, decision 8b).
      // Asserted on the RENDERED form, as a set: the two fields and nothing else.
      await expect(form).not.toContainText('epositor');
      await expect(form).not.toContainText('ommit');
      await expect(form.getByRole('combobox')).toHaveCount(0);

      await body(page).click();
      await page.keyboard.type(`## ${TYPED_HEADING}`);
      await page.keyboard.press('Enter');
      await page.keyboard.type(TYPED_STEP);
      await page.keyboard.press('Enter');
      // ```sh + space is the input rule — the fence carries its LANGUAGE
      // (MOTIR-5458), which is what the rendered block prints above the command.
      await page.keyboard.type('```' + TYPED_LANGUAGE + ' ');
      await page.keyboard.type(TYPED_COMMAND);
      await expect(form.getByLabel('Language')).toHaveValue(TYPED_LANGUAGE);

      await form.getByLabel(/Preview path/).fill(TYPED_PREVIEW_PATH);
      await expect(body(page)).toContainText(TYPED_STEP);
    });
    await beat();

    await chapter('Saved — and it says who wrote it', async () => {
      await howToTestForm(page).getByRole('button', { name: htt.form.save, exact: true }).click();
      await expect(howToTestForm(page)).toHaveCount(0, { timeout: 30_000 });

      // The AUTHORITATIVE read: reload, and take it from the server.
      await page.reload();
      const part = howToTest(page);
      await expect(part).toHaveCount(1, { timeout: 60_000 });
      // A person's record renders through the SAME block a run's does, and
      // differs in exactly one line (§24, panel 13f).
      await expect(part.getByText(`Written by ${seed.ownerName}`, { exact: false })).toBeVisible();
      await expect(
        part.getByRole('heading', { level: 2, name: TYPED_HEADING, exact: true }),
      ).toBeVisible();
      await expect(part.getByText(TYPED_STEP, { exact: false })).toBeVisible();
      // The fence kept its language, and the block prints it beside a copy control.
      await expect(part.getByText(TYPED_LANGUAGE, { exact: true })).toBeVisible();
      await expect(part.getByRole('button', { name: htt.code.copyAria, exact: true })).toHaveCount(
        1,
      );
      // The record exists, so the callout is gone and Edit is offered.
      await expect(part.getByText(htt.missing.title, { exact: true })).toHaveCount(0);
      await expect(part.getByRole('button', { name: htt.edit, exact: true })).toBeVisible();
    });
    await beat();

    await chapter('Edit it: everything comes back, and the old version is kept', async () => {
      await howToTest(page).getByRole('button', { name: htt.edit, exact: true }).click();
      const form = howToTestForm(page);
      await expect(form).toBeVisible();
      // The form opens FILLED IN, from the draft read — the body byte for byte,
      // the preview path, and the fence's language intact.
      await expect(body(page)).toContainText(TYPED_STEP);
      await expect(form.getByLabel(/Preview path/)).toHaveValue(TYPED_PREVIEW_PATH);
      await expect(form.getByLabel('Language')).toHaveValue(TYPED_LANGUAGE);

      // Click the STEP itself, not the editor's middle: `Control+End` lands the
      // caret inside the trailing code block, where a new line is a line of
      // shell rather than a new instruction.
      await body(page).getByText(TYPED_STEP, { exact: false }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(EDITED_STEP);
      await expect(body(page)).toContainText(EDITED_STEP);
      await form.getByRole('button', { name: htt.form.save, exact: true }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });

      await page.reload();
      const part = howToTest(page);
      await expect(part).toHaveCount(1, { timeout: 60_000 });
      await expect(part.getByText(EDITED_STEP, { exact: false })).toBeVisible();
      // What was replaced is kept, under a noun that covers BOTH author kinds
      // (§24, decision 9 — it REPLACED the shipped *Earlier runs*).
      const earlier = part.getByRole('button', { name: 'Earlier versions (1)', exact: true });
      await expect(earlier).toBeVisible();
      await earlier.click();
      await expect(part.getByText(`Written by ${seed.ownerName}`).first()).toBeVisible();
    });
    await beat();

    await chapter('A reader may read it, and may not touch it', async () => {
      await signIn(page, seed.viewerEmail, seed.viewerPassword);
      await page.goto(`/items/${seed.blank.identifier}`);
      const part = howToTest(page);
      await expect(part).toHaveCount(1, { timeout: 60_000 });
      // The instructions are theirs to read…
      await expect(part.getByText(TYPED_STEP, { exact: false })).toBeVisible();
      // …and there is NO door — not a disabled one, none. The doors are gated on
      // `work_item:edit`, which this CUSTOM role does not carry (§24, 13h).
      await expect(part.getByRole('button', { name: htt.edit, exact: true })).toHaveCount(0);
      await expect(part.getByRole('button', { name: htt.add, exact: true })).toHaveCount(0);
    });
    await beat();

    await chapter('A child points at the story it was tested as part of', async () => {
      await signIn(page, seed.email, seed.password);
      await page.goto(`/items/${seed.child.identifier}`);
      await expect(page.getByRole('heading', { name: seed.child.title })).toBeVisible({
        timeout: 60_000,
      });
      // The record belongs to the run target, and a child is not one — so it
      // repeats nothing and offers nothing (§24, decision 11).
      await expect(howToTest(page)).toHaveCount(0);
      const pointer = page.getByRole('link', { name: seed.parent.identifier, exact: true });
      await expect(pointer).toBeVisible();
      await expect(page.getByRole('button', { name: htt.add, exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: htt.edit, exact: true })).toHaveCount(0);

      await pointer.click();
      await expect(page).toHaveURL(new RegExp(`/items/${seed.parent.identifier}$`));
      await expect(howToTest(page)).toHaveCount(1, { timeout: 60_000 });
    });
    await beat();
  });
});
