// E2E: the remaining date surfaces open the package DatePicker and save a date
// (Story MOTIR-10551 · Subtask MOTIR-10584) — the story's verification recipe
// step 6, un-narrated. The recorded walk (`acceptance-date-picker.spec.ts`)
// owns steps 1 to 5; the package's own tests own step 7.
//
// Every date field in motir-core now renders `DatePicker` from
// `@motir/design-system`, under the root layout's `DatePickerFormatAdapter`.
// Each test below drives one surface the recorded walk does not visit, in a
// real browser over the real stack: the picker opens its calendar dialog with a
// grid, a day is picked by KEYBOARD (the grid opens focused on today, so nothing
// depends on the runner's date) or by the cell marked as today, and the date is
// saved. The expected day is always read from the page — the focused cell's
// `data-key` or the trigger text before the commit — and compared with the
// persisted row; no date literal is typed into an expectation.
//
// ── The inline list edit is not here, and why ────────────────────────────────
// The recipe names a sixth surface, the items list's inline due-date edit
// (`InlineDueCell` in `app/(authed)/items/_components/IssueInlineEdit.tsx`).
// No view renders that cell: the Due column was removed from the List and both
// Tree views (MOTIR-1307, the comment in `issueColumns.tsx`), so the editor is
// unreachable in a browser and only its import moved to the package. The run
// records that as a build-through rather than driving a surface nobody can see.
//
// ── Waits (the coding convention § E2E) ──────────────────────────────────────
// Every write is awaited on a response armed BEFORE the key or click that causes
// it, or — for the quick view, whose rail commits through a server action with
// no per-field endpoint — on a poll of the committed row. No fixed sleep.
//
// Each test seeds for itself (sign up through the UI, then the shipped
// services), so each passes alone and the file is shard-safe.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { actionWrite } from './_helpers/authoritative-signal';
import { msg } from './_helpers/i18n-walk';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { formatDate } from '@/lib/utils/datetime';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
}

/** Sign up through the real UI, then create a project through the service and
 *  pin it active (the `quick-view-edit.spec.ts` setup). */
async function seedProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await adminDb.user.findFirst({ where: { email } });
  const ws = await adminDb.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Date Surfaces',
    identifier,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: user!.id, workspaceId: ws!.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

async function mkTask(seed: Seed, title: string): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title, parentId: null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** The open calendar of a picker: a dialog named by the picker's label. */
const calendar = (page: Page, label: string): Locator =>
  page.getByRole('dialog', { name: label, exact: true });

/** A picker's trigger: the button carrying exactly its label. */
const trigger = (scope: Page | Locator, label: string): Locator =>
  scope.getByRole('button', { name: label, exact: true });

/** The day key (`YYYY-MM-DD`) of the cell that holds the grid's roving focus. */
async function focusedKey(cal: Locator): Promise<string> {
  const key = await cal.getByRole('grid').locator('button[tabindex="0"]').getAttribute('data-key');
  expect(key, 'the grid has a focused day').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return key!;
}

/** The package picker's default accessible name, read from its source — the
 *  quick-view rail passes no label of its own. */
function packageDefaultLabel(): string {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'packages/design-system/src/components/ui/DatePicker.tsx'),
    'utf8',
  );
  const match = source.match(/'aria-label':\s*ariaLabel\s*=\s*'([^']+)'/);
  expect(match, 'the package picker declares a default aria-label').not.toBeNull();
  return match![1]!;
}

/** Poll the committed due date of one item until it holds `key`. */
async function expectDueCommitted(id: string, key: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await adminDb.workItem.findUnique({ where: { id }, select: { dueDate: true } });
        return row?.dueDate ? row.dueDate.toISOString().slice(0, 10) : null;
      },
      { message: `server committed due date ${key}`, timeout: 20_000 },
    )
    .toBe(key);
}

test('quick view: the rail’s Due date opens the picker inside the peek and saves the day', async ({
  page,
}) => {
  const seed = await seedProject(page, 'dp-quick-view@example.com', 'DPQ');
  const task = await mkTask(seed, 'Plan the quick-view date');

  await page.goto('/items');
  const row = page.getByRole('main').getByTestId(`issue-row-${task.identifier}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const peekRead = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await row.press('Enter');
  expect((await peekRead).status()).toBe(200);
  const peek = page.getByRole('dialog').first();
  await expect(peek).toBeVisible();

  const dueLabel = msg('en', 'issueViews.dueDate');
  await peek
    .getByRole('button', {
      name: msg('en', 'issueViews.quickViewEditField', { field: dueLabel }),
      exact: true,
    })
    .click();
  const label = packageDefaultLabel();
  await trigger(peek, label).click();
  const cal = calendar(page, label);
  await expect(cal.getByRole('grid')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  const key = await focusedKey(cal);
  await page.keyboard.press('Enter');
  await expectDueCommitted(task.id, key);

  await expect(peek).toBeVisible();
  await expect(
    peek.getByText(formatDate(`${key}T00:00:00.000Z`, 'en'), { exact: true }).first(),
  ).toBeVisible();
  await expect(peek.getByText(msg('en', 'issueViews.noDueDate'), { exact: true })).toHaveCount(0);
});

test('custom date field: the rail card opens a calendar named by the field and stores today', async ({
  page,
}) => {
  const seed = await seedProject(page, 'dp-custom-field@example.com', 'DPC');
  const task = await mkTask(seed, 'Hold a go-live date');
  const field = await customFieldsService.createField({
    key: seed.projectKey,
    actorUserId: seed.ctx.userId,
    ctx: seed.ctx,
    label: 'Go-live',
    fieldType: 'date',
  });

  await page.goto(`/items/${task.identifier}`);
  await expect(page.getByRole('heading', { name: 'Hold a go-live date' })).toBeVisible({
    timeout: 30_000,
  });
  // An empty field sits behind the "show more fields" disclosure.
  await page.getByRole('button', { name: /^Show more fields/ }).click();
  const toggle = page.getByRole('button', {
    name: `${msg('en', 'issueViews.edit')} Go-live`,
    exact: true,
  });
  await toggle.click();

  const cal = calendar(page, 'Go-live');
  await expect(cal.getByRole('grid')).toBeVisible();
  const today = cal.locator('button[aria-current="date"]');
  await expect(today).toHaveCount(1);
  const key = (await today.getAttribute('data-key'))!;
  expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const write = actionWrite(page, `/items/${task.identifier}`, field.id);
  await today.click();
  expect((await write).status()).toBe(200);

  const card = toggle.locator('..').locator('..');
  await expect(card).toContainText(formatDate(`${key}T00:00:00.000Z`, 'en'));
  const stored = await adminDb.customFieldValue.findFirst({
    where: { workItemId: task.id, fieldId: field.id },
    select: { valueDate: true },
  });
  expect(stored?.valueDate?.toISOString().slice(0, 10)).toBe(key);
});

test('advanced filter: Due on or after a picked day keeps only the later item', async ({
  page,
}) => {
  const seed = await seedProject(page, 'dp-filter@example.com', 'DPF');
  const earlier = await mkTask(seed, 'Due ten days ago');
  const later = await mkTask(seed, 'Due in ten days');
  // Ten-day margins either side of today: correct even if the run straddles
  // UTC midnight. The only runner-clock values in this file, and they seed.
  const DAY_MS = 86_400_000;
  const midnight = (offsetDays: number) =>
    new Date(
      `${new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
  await adminDb.workItem.update({ where: { id: earlier.id }, data: { dueDate: midnight(-10) } });
  await adminDb.workItem.update({ where: { id: later.id }, data: { dueDate: midnight(10) } });

  await page.goto('/items?view=list');
  await expect(page.getByRole('main').getByTestId(`issue-row-${later.identifier}`)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Advanced' }).click();
  const builder = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(builder).toBeVisible();

  await builder.getByRole('button', { name: 'Add condition' }).click();
  const row = builder.getByRole('group', { name: 'Condition 1' });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Due', exact: true }).click();
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page
    .getByRole('option', { name: msg('en', 'issueViews.advancedOpOnOrAfter'), exact: true })
    .click();

  const label = msg('en', 'issueViews.advancedPickDateAria', { field: 'Due' });
  await trigger(row, label).click();
  const cal = calendar(page, label);
  await expect(cal.getByRole('grid')).toBeVisible();
  const key = await focusedKey(cal);
  await page.keyboard.press('Enter');
  await expect(cal).toHaveCount(0);
  await expect(trigger(row, label)).toHaveText(formatDate(`${key}T00:00:00.000Z`, 'en'));

  await page.keyboard.press('Escape');
  await expect(builder).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '1 work item matches',
  );
  await expect(page.getByRole('main').getByTestId(`issue-row-${later.identifier}`)).toBeVisible();
  await expect(page.getByRole('main').getByTestId(`issue-row-${earlier.identifier}`)).toHaveCount(
    0,
  );
});

test('automation rule: Set field → Due date stores the day picked in the rule editor', async ({
  page,
}) => {
  const seed = await seedProject(page, 'dp-automation@example.com', 'DPA');
  const ruleName = 'Date the new work';

  await page.goto('/settings/project/automation');
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Create rule' }).click();
  await page.getByRole('textbox', { name: 'Rule name' }).fill(ruleName);
  await page.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('combobox', { name: 'Action type' }).click();
  await page.getByRole('option', { name: 'Set field' }).click();
  await page.getByRole('combobox', { name: 'Field to set' }).click();
  await page.getByRole('option', { name: 'Due date', exact: true }).click();

  const label = msg('en', 'settings.automation.editor.dueDateAria');
  await trigger(page, label).click();
  const cal = calendar(page, label);
  await expect(cal.getByRole('grid')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  const key = await focusedKey(cal);
  await page.keyboard.press('Enter');
  await expect(cal).toHaveCount(0);
  await expect(trigger(page, label)).toHaveText(formatDate(`${key}T00:00:00.000Z`, 'en'));

  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('button', { name: `Actions for ${ruleName}` })).toBeVisible();

  const rule = await adminDb.automationRule.findFirstOrThrow({
    where: { projectId: seed.projectId, name: ruleName },
    select: { actions: true },
  });
  expect(JSON.stringify(rule.actions)).toContain(key);
});

test('triage snooze: the Pick a date picker snoozes to the end of the picked local day', async ({
  page,
}) => {
  await seedProject(page, 'dp-snooze@example.com', 'DPS');
  const title = 'Snooze me to a picked day';

  // Submit a bug through the Report widget, awaiting the intake POST.
  await page.goto('/items');
  await page.getByRole('button', { name: 'Report' }).first().click();
  const report = page.getByRole('dialog', { name: 'Report something' });
  await expect(report).toBeVisible();
  await report.getByLabel('Title').fill(title);
  const submitted = page.waitForResponse(
    (r) => r.url().includes('/triage/submissions') && r.request().method() === 'POST',
  );
  await report.getByRole('button', { name: 'Submit' }).click();
  const submission = await submitted;
  expect(submission.status()).toBe(201);
  const { id } = (await submission.json()) as { id: string };
  await expect(report).toBeHidden();

  // Open it in the triage inbox.
  await page.goto('/triage');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: msg('en', 'triage.actions.snooze'), exact: true }).click();
  const label = msg('en', 'triage.snoozePopover.pickDateAria');
  await trigger(page, label).click();
  const cal = calendar(page, label);
  await expect(cal.getByRole('grid')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const key = await focusedKey(cal);

  const snoozed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/work-items/${id}/triage/snooze` &&
      r.request().method() === 'POST',
  );
  await page.keyboard.press('Enter');
  const res = await snoozed;
  expect(res.status()).toBe(200);
  const body = JSON.parse(res.request().postData() ?? '{}') as { snoozedUntil?: string };
  expect(body.snoozedUntil).toBeTruthy();

  // The instant is the END of the picked day in the browser's own time zone.
  const localKey = await page.evaluate((iso) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, body.snoozedUntil!);
  expect(localKey).toBe(key);

  const row = await adminDb.workItem.findUnique({ where: { id }, select: { snoozedUntil: true } });
  expect(row?.snoozedUntil?.toISOString()).toBe(new Date(body.snoozedUntil!).toISOString());

  // Snoozed reads as "out of the active queue until then" (triageService's
  // snoozeTriageItem): a fresh read of the inbox no longer lists it.
  await page.goto('/triage');
  await expect(page.getByRole('heading', { level: 1, name: 'Triage' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
});
