import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintLifecycle, type LifecycleSeed } from './_helpers/sprint-lifecycle-seed';
import { actionWrite } from './_helpers/authoritative-signal';
import { htmlLang, msg, saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import { formatDate } from '@/lib/utils/datetime';

/*
 * THE DATE PICKER, MOVED INTO THE DESIGN SYSTEM — the story's acceptance walk
 * (Story MOTIR-10551 · Subtask MOTIR-10583).
 *
 * The app-bound `components/ui/DatePicker.tsx` is gone; every date field renders
 * the `@motir/design-system` picker, and the root layout's
 * `DatePickerFormatAdapter` hands it the next-intl locale and motir-core's own
 * `formatDate`. One continuous recorded test walks the story's verification
 * recipe steps 1 to 5 in the user's order: the specimen, the item page in
 * English, the create-item modal, the two sprint dialogs, and the same screens
 * after the account language is switched to Chinese through Settings.
 *
 * ── RECIPE STEPS THIS FILE DOES NOT WALK ───────────────────────────────────
 * Step 6 — the six surfaces this walk does not visit (inline edit, quick view,
 * a custom date field, the advanced filter, an automation rule, the triage
 * snooze) — is owned by MOTIR-10584 (E2E — the remaining date surfaces), an
 * un-recorded spec. Step 7 — the package picker rendered with and without the
 * provider outside motir-core — is package behaviour, owned by the package's own
 * tests (`packages/design-system/test/DatePicker.test.tsx`,
 * `datePickerFormat.test.tsx`, `datePickerBuiltContext.test.tsx`).
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Every date is picked by KEYBOARD on the grid, which opens focused on today
 * (or on the field's current value), so nothing depends on the runner's date.
 * Every expected string is computed here with `formatDate` from
 * `lib/utils/datetime.ts`, over the ISO read back from the row the UI wrote —
 * so a run straddling UTC midnight cannot disagree with itself. The specimen's
 * fixed 2026-06-04 is the only date pinned as literals (`Jun 4, 2026`,
 * `2026年6月4日`), so a drift in the formatter itself is caught too. Writes are
 * awaited on a response armed BEFORE the click or key that causes them; the
 * harness's chapter and beat holds pace the clip and never wait for state.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const SPECIMEN = '/tokens/date-picker';
const CREATED_TITLE = 'Book the venue for the launch';

let seed: LifecycleSeed;

/** A UTC `YYYY-MM-DD` key from a persisted DateTime. */
const dayKey = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

/** Today as a UTC `YYYY-MM-DD` key — the picker's own UTC date math. */
const todayKey = (): string => new Date().toISOString().slice(0, 10);

/** A picker's trigger: the button carrying exactly its label (the rail's edit
 *  toggle reads "{edit} {label}", the open calendar is a dialog, not a button). */
const trigger = (scope: Page | Locator, label: string): Locator =>
  scope.getByRole('button', { name: label, exact: true });

/** The open calendar of the picker labelled `label` (portalled to <body>). */
const calendar = (page: Page, label: string): Locator =>
  page.getByRole('dialog', { name: label, exact: true });

/** Open a picker by its trigger and wait for its calendar's focused grid. */
async function openPicker(page: Page, scope: Page | Locator, label: string): Promise<Locator> {
  await trigger(scope, label).click();
  const cal = calendar(page, label);
  await expect(cal.getByRole('grid')).toBeVisible();
  return cal;
}

/** A sprint container: <section aria-label="{name}, {state}, {count} issues">. */
const sprintRegion = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: new RegExp(`^${name},`) });

async function persistedDue(id: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id }, select: { dueDate: true } });
  expect(row?.dueDate, 'the due date the UI wrote').toBeTruthy();
  return row!.dueDate!.toISOString();
}

async function openItem(page: Page, identifier: string, lang: string): Promise<void> {
  await page.goto(`/items/${identifier}`);
  await expect(
    page.getByRole('button', {
      name: `${msg(lang, 'issueViews.edit')} ${msg(lang, 'issueViews.dueDate')}`,
      exact: true,
    }),
  ).toBeVisible({ timeout: FIRST_PAINT_MS });
}

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedSprintLifecycle('date-picker-acceptance-owner@motir.dev');
});

test('date fields render the package picker, in English and in Chinese', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10551');

  const itemA = seed.mainIssues[0]!;
  const dueLabelEn = msg('en', 'issueViews.dueDate');
  const toggleEn = `${msg('en', 'issueViews.edit')} ${dueLabelEn}`;

  await chapter('The date picker specimen: filled, open, disabled and cleared', async () => {
    await page.goto(SPECIMEN);
    await expect(page.getByRole('heading', { level: 1, name: 'Date picker' })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    // Filled date reads the specimen's fixed value in English.
    await expect(trigger(page, 'Filled date')).toHaveText('Jun 4, 2026');

    // Open date mounts open: a dialog holding a grid, with 4 June selected.
    const open = calendar(page, 'Open date');
    await expect(open.getByRole('grid')).toBeVisible();
    await expect(open.getByRole('gridcell', { selected: true })).toHaveCount(1);
    await expect(
      open
        .getByRole('gridcell', { selected: true })
        .getByRole('button', { name: 'June 4, 2026', exact: true }),
    ).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');
    await expect(open).toHaveCount(0);

    // A disabled picker opens nothing, even when clicked.
    await expect(trigger(page, 'Disabled date')).toBeDisabled();
    await trigger(page, 'Disabled date').click({ force: true });
    await expect(calendar(page, 'Disabled date')).toHaveCount(0);

    // Clear on Filled date falls back to the placeholder and drops the control.
    const filledField = trigger(page, 'Filled date').locator('xpath=..');
    await filledField.getByRole('button', { name: 'Clear date' }).click();
    await expect(trigger(page, 'Filled date')).toHaveText('Select a date');
    await expect(filledField.getByRole('button', { name: 'Clear date' })).toHaveCount(0);
    await beat();
  });

  let dueIso = '';
  await chapter('A work item’s due date, picked from its page in English', async () => {
    await signIn(page, seed.email, seed.password);
    await openItem(page, itemA.identifier, 'en');

    // The rail's toggle mounts the picker already open, on today's month.
    await page.getByRole('button', { name: toggleEn, exact: true }).click();
    const cal = calendar(page, dueLabelEn);
    await expect(cal.getByRole('grid')).toBeVisible();
    await expect(cal.locator('[aria-current="date"]')).toHaveCount(1);
    await beat();

    // Enter picks the day focus landed on (today); the write is armed first.
    const write = actionWrite(page, `/items/${itemA.identifier}`, 'dueDate');
    await page.keyboard.press('Enter');
    expect((await write).status()).toBe(200);

    dueIso = await persistedDue(itemA.id);
    await expect(
      page.getByRole('main').getByText(formatDate(dueIso, 'en'), { exact: true }).first(),
    ).toBeVisible();
    await beat();
  });

  await chapter('Creating a work item with a due date', async () => {
    await page
      .getByRole('button', { name: msg('en', 'shell.createIssue.title'), exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: msg('en', 'shell.createIssue.title') });
    await expect(modal).toBeVisible();
    await modal
      .getByRole('textbox', { name: msg('en', 'shell.createIssue.titleLabel') })
      .fill(CREATED_TITLE);

    await openPicker(page, modal, 'Due date');
    await page.keyboard.press('Enter');
    await expect(calendar(page, 'Due date')).toHaveCount(0);
    const picked = (await trigger(modal, 'Due date').textContent())?.trim() ?? '';
    await beat();

    const created = actionWrite(page, `/items/${itemA.identifier}`, CREATED_TITLE);
    await modal
      .getByRole('button', { name: msg('en', 'shell.createIssue.create'), exact: true })
      .click();
    expect((await created).status()).toBe(200);
    await expect(modal).toHaveCount(0);

    const row = await adminDb.workItem.findFirst({
      where: { title: CREATED_TITLE, projectId: seed.projectId },
      select: { identifier: true, dueDate: true },
    });
    expect(row?.dueDate, 'the created item carries the picked due date').toBeTruthy();
    const createdIso = row!.dueDate!.toISOString();
    expect(picked).toBe(formatDate(createdIso, 'en'));

    await openItem(page, row!.identifier, 'en');
    await expect(page.getByRole('main').getByText(picked, { exact: true }).first()).toBeVisible();
    await beat();
  });

  await chapter('Setting sprint dates: Edit sprint dates, then Start sprint', async () => {
    const dayAtStart = todayKey();
    await page.goto('/backlog');
    await expect(page.getByRole('main').getByTestId('backlog-count')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    // ── Edit sprint dates on the planned main sprint ────────────────────────
    const main = sprintRegion(page, seed.mainSprintName);
    await expect(main.getByText('Not started')).toBeVisible();
    await page.getByRole('main').getByTestId(`sprint-actions-${seed.mainSprintId}`).click();
    await page
      .getByRole('menuitem', { name: msg('en', 'backlog.editSprintDatesFlow.menuItem') })
      .click();
    const edit = page.getByRole('dialog', { name: 'Edit sprint dates' });
    await expect(edit).toBeVisible();

    await openPicker(page, edit, 'Start date');
    await page.keyboard.press('Enter');
    await beat();
    await openPicker(page, edit, 'End date');
    await page.keyboard.press('Enter');
    await beat();
    const editStart = (await trigger(edit, 'Start date').textContent())?.trim();
    const editEnd = (await trigger(edit, 'End date').textContent())?.trim();

    const patched = page.waitForResponse(
      (r) =>
        new RegExp(`/api/sprints/${seed.mainSprintId}$`).test(r.url()) &&
        r.request().method() === 'PATCH',
    );
    const refetched = page.waitForResponse(
      (r) =>
        /\/api\/sprints(?:\?|$)/.test(r.url()) &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await edit.getByRole('button', { name: 'Save dates' }).click();
    expect((await patched).status()).toBe(200);
    await refetched;
    await expect(main.getByText('Not started')).toHaveCount(0);

    const edited = await adminDb.sprint.findUnique({ where: { id: seed.mainSprintId } });
    const editedStart = dayKey(edited?.startDate);
    expect(editedStart).toBe(dayKey(edited?.endDate));
    expect([dayAtStart, todayKey()]).toContain(editedStart);
    expect(editStart).toBe(formatDate(edited!.startDate!.toISOString(), 'en'));
    expect(editEnd).toBe(formatDate(edited!.endDate!.toISOString(), 'en'));
    await beat();

    // ── Start sprint on the second planned sprint, Custom duration ──────────
    await sprintRegion(page, seed.secondSprintName)
      .getByRole('button', { name: msg('en', 'backlog.startSprint'), exact: true })
      .click();
    const start = page.getByRole('dialog', { name: msg('en', 'backlog.startSprintFlow.title') });
    await expect(start).toBeVisible();
    await start
      .getByRole('group', { name: msg('en', 'backlog.startSprintFlow.durationLabel') })
      .getByRole('button', { name: msg('en', 'backlog.startSprintFlow.durationCustom') })
      .click();
    const startLabel = msg('en', 'backlog.startSprintFlow.startDateLabel');
    const endLabel = msg('en', 'backlog.startSprintFlow.endDateLabel');
    await expect(trigger(start, startLabel)).toBeVisible();
    await beat();

    // Start: the grid opens on the prefilled start (today) → Enter keeps it.
    await openPicker(page, start, startLabel);
    await page.keyboard.press('Enter');
    await beat();
    // End: the grid opens on the prefilled end → one week later → Enter.
    await openPicker(page, start, endLabel);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(calendar(page, endLabel)).toHaveCount(0);
    const startText = (await trigger(start, startLabel).textContent())?.trim();
    const endText = (await trigger(start, endLabel).textContent())?.trim();
    await beat();

    const started = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/sprints/${seed.secondSprintId}/start` &&
        r.request().method() === 'POST',
    );
    await start
      .getByRole('button', { name: msg('en', 'backlog.startSprintFlow.confirm'), exact: true })
      .click();
    expect((await started).status()).toBe(200);
    await page.waitForURL('**/boards', { timeout: FIRST_PAINT_MS });

    const second = await adminDb.sprint.findUnique({ where: { id: seed.secondSprintId } });
    expect(second?.state).toBe('active');
    expect(startText).toBe(formatDate(second!.startDate!.toISOString(), 'en'));
    expect(endText).toBe(formatDate(second!.endDate!.toISOString(), 'en'));
    await beat();
  });

  await chapter('The same dates in Chinese, after switching the account language', async () => {
    await saveAccountLanguageInSettings(page, 'zh');
    await beat();

    await openItem(page, itemA.identifier, 'zh');
    expect(await htmlLang(page)).toBe('zh');
    const zhDue = formatDate(dueIso, 'zh');
    await expect(page.getByRole('main').getByText(zhDue, { exact: true }).first()).toBeVisible();
    await beat();

    // Reopen the picker: its trigger reads the same Chinese text, while the
    // calendar's own strings stay English.
    const dueLabelZh = msg('zh', 'issueViews.dueDate');
    await page
      .getByRole('button', { name: `${msg('zh', 'issueViews.edit')} ${dueLabelZh}`, exact: true })
      .click();
    const cal = calendar(page, dueLabelZh);
    await expect(cal.getByRole('grid')).toBeVisible();
    await expect(trigger(page, dueLabelZh)).toHaveText(zhDue);
    await expect(cal.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
    await expect(cal.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');

    // The specimen: Filled date in Chinese; the open calendar still English.
    await page.goto(SPECIMEN);
    await expect(trigger(page, 'Filled date')).toHaveText('2026年6月4日', {
      timeout: FIRST_PAINT_MS,
    });
    const open = calendar(page, 'Open date');
    await expect(open.getByText('June 2026', { exact: true })).toBeVisible();
    await expect(open.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
    await expect(open.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();
    await beat();
  });
});

test('under zh, an item with no due date shows the English placeholder and no Clear', async ({
  page,
}) => {
  const beta = await adminDb.workItem.findFirst({
    where: { title: 'Beta issue', projectId: seed.projectId },
    select: { identifier: true, dueDate: true },
  });
  expect(beta?.dueDate ?? null).toBeNull();

  await signIn(page, seed.email, seed.password);
  await saveAccountLanguageInSettings(page, 'zh');
  await openItem(page, beta!.identifier, 'zh');

  const label = msg('zh', 'issueViews.dueDate');
  await page
    .getByRole('button', { name: `${msg('zh', 'issueViews.edit')} ${label}`, exact: true })
    .click();
  await expect(calendar(page, label).getByRole('grid')).toBeVisible();
  await expect(trigger(page, label)).toHaveText('Select a date');
  await expect(
    trigger(page, label).locator('xpath=..').getByRole('button', { name: 'Clear date' }),
  ).toHaveCount(0);
});
