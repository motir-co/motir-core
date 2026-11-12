import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminDb } from '../helpers/adminDb';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { writePlannerModelFixture } from './_helpers/planner-model-fixture';
import type { PlannerModelFixture } from '@/lib/test-planner-model-mock';
import enMessages from '@/messages/en.json';

/**
 * A COMBOBOX INSIDE `Modal.Body` SHOWS ITS WHOLE MENU (Bug MOTIR-7655).
 *
 * The in-modal Combobox renders its menu inline (the focus trap keeps it out of
 * a body portal). Inside `Modal.Body` — an `overflow-y-auto` scroll box — the
 * absolute menu used to extend the body's scroll area and be cut at its visible
 * edge: on the short *Add a model planning may use* dialog only the first few
 * candidates showed, beside a second scrollbar. The menu now lifts out of the
 * scroll box with fixed positioning.
 *
 * MOTIR-11096: the lifted menu was then still cut to the PANEL's height,
 * because the panel's centring transform made it the menu's containing block
 * and its overflow clip bounded it. The panel is now centred without a
 * transform, so the menu reaches past the panel's bottom edge, bounded only by
 * the viewport.
 *
 * ⚠️ IN THE CLOUD LANE because the dialog reads motir-ai's planning candidates,
 * which only this lane's `E2E_TEST_PLANNER_MODEL` seam answers (see
 * `cloud-admin-ai-planning.spec.ts`).
 */

test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const planning = enMessages.platformAdmin.planningList;
const lists = enMessages.platformAdmin.modelLists;

const OPUS = 'claude-opus-5-5';
const CANDIDATES = [
  'qwen3.7-plus-2026-05-26',
  'qwen3.8-flash',
  'qwen3.8-max',
  'glm-5.2',
  'kimi-k3',
  'deepseek-v4',
  'mistral-large-3',
  'gemini-3-pro',
];

/** Opus listed; eight more plannable models offered as candidates. */
function fixture(): PlannerModelFixture {
  return {
    settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
      audience,
      model: OPUS,
    })),
    offered: [
      { id: OPUS, provider: 'anthropic' },
      ...CANDIDATES.map((id) => ({ id, provider: 'openrouter' })),
    ],
    list: [{ model: OPUS }],
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  writePlannerModelFixture(fixture());
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

async function openAddModel(page: Page) {
  const email = 'e2e-combobox-modal-body@example.com';
  await signUp(page, email);
  await adminDb.user.update({ where: { email }, data: { platformRole: 'superadmin' } });
  await page.goto('/admin/ai-planning');
  await page.getByRole('main').getByRole('button', { name: lists.add }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: planning.add.title })).toBeVisible();
  await dialog.getByRole('combobox', { name: planning.add.modelLabel }).click();
  const listbox = page.getByRole('listbox', { name: planning.add.modelLabel });
  await expect(listbox).toBeVisible();
  return { dialog, listbox };
}

test('the Add-a-model picker reaches past the dialog panel, stays on screen and scrolls only its own list', async ({
  page,
}) => {
  const { dialog, listbox } = await openAddModel(page);
  await expect(listbox.getByRole('option')).toHaveCount(CANDIDATES.length);

  // The listbox is wholly on screen, opens below the trigger inside the panel,
  // and — the dialog being short — runs past the panel's bottom edge instead of
  // being cut to it (MOTIR-11096).
  await expect(listbox).toBeInViewport({ ratio: 1 });
  const d = await box(dialog);
  const l = await box(listbox);
  expect(l.y).toBeGreaterThanOrEqual(d.y);
  expect(l.x).toBeGreaterThanOrEqual(d.x);
  expect(l.y + l.height).toBeGreaterThan(d.y + d.height);
  expect(l.y + l.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  // The open menu no longer grows the dialog body a scroll area of its own.
  const bodyOverflow = await listbox.evaluate((el) => {
    let node = el.parentElement;
    while (node && getComputedStyle(node).overflowY !== 'auto') node = node.parentElement;
    return node ? node.scrollHeight - node.clientHeight : -1;
  });
  expect(bodyOverflow).toBeLessThanOrEqual(1);

  // Every option is reached by scrolling the LISTBOX itself.
  const last = listbox.getByRole('option').last();
  await listbox.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(last).toBeInViewport({ ratio: 1 });
  const o = await box(last);
  expect(o.y + o.height).toBeLessThanOrEqual(l.y + l.height + 1);

  // And picking it works — the menu closes onto the chosen value.
  const lastLabel = (await last.innerText()).trim();
  await last.click();
  await expect(listbox).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: planning.add.modelLabel })).toContainText(
    lastLabel,
  );
});

test('a picker at the top of a Modal.Body never paints its menu under the dialog header', async ({
  page,
}) => {
  const { dialog, listbox } = await openAddModel(page);
  const header = dialog.getByRole('heading', { name: planning.add.title });
  const description = dialog.getByText(planning.add.body, { exact: true });
  const h = await box(header);
  const desc = await box(description);
  const l = await box(listbox);
  // The menu opens below the header block (title + description), not over it.
  expect(l.y).toBeGreaterThanOrEqual(Math.max(h.y + h.height, desc.y + desc.height));
  // It is still the topmost thing at its own centre (nothing paints over it).
  const hit = await listbox.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (el === at || el.contains(at));
  });
  expect(hit).toBe(true);
});
