// Acceptance E2E — setting the planning TARGET four ways (Subtask MOTIR-6900,
// Story MOTIR-6894): by a bare number, by a multi-word title, from the Search
// control and from `@`, and Set / Remove target on a canvas card.
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`) —
// the lane where the planning overlay mounts at all. `acceptanceStory()` pins
// the clip to the story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person on the planning surface picks what to plan the ways they already
// look for work: they type the NUMBER they say out loud, a PHRASE from the
// title (the old picker stopped at the first space), they reach for a visible
// SEARCH control rather than a bare `@`, and they point at the CARD that is
// already in front of them on the canvas. Each way lands in the same target
// tray, and the canvas never moves out from under them.
//
// The clip is PACED: typing is slow enough to read, and each step holds after
// the assertion that proved it.
//
// ── WHAT THIS SPEC PROVES, AND WHAT PROVES THE REST ─────────────────────────
//
// Here: the story's recipe steps 1–6 in a browser, plus the popover's states.
// Elsewhere, deliberately: step 7 (the item page's link picker finding a bare
// number) and every other consumer of the shared search are ruled on against
// the real database by `tests/integration/planning/targetSettingStoryGate.test.tsx`.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every search assertion waits on
// the `mention-search` response for THAT query; every add or remove asserts the
// tray's rendered chips after the change. `beat()` and the chapter hold are
// PACING only, each taken after the assertion that already proved the state.
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningTargetTree, PLANNING_TARGET_PASSWORD } from './_helpers/planning-target-seed';

test.describe.configure({ timeout: 240_000 });

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const searchControl = (page: Page) =>
  rail(page).getByRole('button', { name: 'Search work items to plan' });
const searchPopover = (page: Page) => rail(page).getByTestId('target-search-popup');
const searchField = (page: Page) => rail(page).getByTestId('planning-target-search-field');
const options = (page: Page) =>
  searchPopover(page)
    .getByRole('listbox', { name: 'Work items to plan around' })
    .getByRole('option');
const tray = (page: Page) => rail(page).getByTestId('planning-target-tray');
const chip = (page: Page, key: string) =>
  tray(page).locator(`[data-testid="planning-target-chip"][data-target-key="${key}"]`);
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const breadcrumb = (page: Page) => workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
const canvasNode = (page: Page, title: string) =>
  workspace(page)
    .getByTestId('planning-canvas')
    .locator('[data-node-id]')
    .filter({ hasText: title });

const overlayOpen = (url: URL) => url.searchParams.has('plan');

/** The shared search's response for EXACTLY `query` — the authoritative signal
 *  that the rows on screen are this query's. Armed BEFORE the typing. */
const searchResponse = (page: Page, query: string) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/work-items/mention-search') &&
      new URL(r.url()).searchParams.get('q') === query &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

/** Keys on the tray, in pick order. */
async function trayKeys(page: Page): Promise<string[]> {
  return tray(page)
    .getByTestId('planning-target-chip')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-target-key') ?? ''));
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('setting the planning target — by number, by a phrase, from Search and `@`, and from the canvas', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6894');

  const email = `planning-target-${Date.now()}@example.com`;
  const seed = await seedPlanningTargetTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_TARGET_PASSWORD);

  // ── STEP 1 ────────────────────────────────────────────────────────────────
  await chapter(
    'Open the epic’s Plan with AI — a Search control sits in the composer',
    async () => {
      await page.goto(`/items/${seed.epicKey}`);
      await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await entrance(page).click();
      await page.waitForURL(overlayOpen);
      await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      // The surface opens inside the epic, whose children are the cards below.
      await expect(canvasNode(page, seed.numberedTitle)).toBeVisible({ timeout: FIRST_PAINT_MS });

      // Asserted before it is used, so a build without it cannot pass.
      await expect(searchControl(page)).toBeVisible();
      await expect(searchControl(page)).toHaveAttribute('data-testid', 'planning-target-trigger');
      await searchControl(page).hover();
      await expect(page.getByRole('tooltip')).toContainText('Search work items to plan');
      await beat();
    },
  );

  // ── STEP 2 ────────────────────────────────────────────────────────────────
  const number = seed.numberedKey.split('-')[1]!;
  await chapter(`Search a bare number — ${number} finds ${seed.numberedKey} first`, async () => {
    await searchControl(page).click();
    await expect(searchPopover(page)).toBeVisible();
    await expect(searchField(page)).toBeFocused();

    const answered = searchResponse(page, number);
    await searchField(page).pressSequentially(number, { delay: 180 });
    await answered;
    await expect(options(page).first()).toContainText(seed.numberedKey);
    await beat();

    await searchField(page).press('Enter');
    await expect(chip(page, seed.numberedKey)).toBeVisible();
    await expect(searchPopover(page)).toHaveCount(0);
    expect(await trayKeys(page)).toEqual([seed.epicKey, seed.numberedKey]);
    await beat();
  });

  // ── STEP 3 ────────────────────────────────────────────────────────────────
  await chapter('Search a phrase — the search keeps going after the space', async () => {
    const [first, second] = seed.phraseQuery.split(' ') as [string, string];
    await searchControl(page).click();

    const firstWord = searchResponse(page, first);
    await searchField(page).pressSequentially(first, { delay: 150 });
    await firstWord;
    await beat();

    const phrase = searchResponse(page, seed.phraseQuery);
    await searchField(page).pressSequentially(` ${second}`, { delay: 150 });
    await phrase;
    await expect(options(page).first()).toContainText(seed.phraseTitle);
    await expect(searchField(page)).toHaveValue(seed.phraseQuery);
    await beat();

    await page.keyboard.press('Escape');
    await expect(searchPopover(page)).toHaveCount(0);
  });

  // ── STEP 4 ────────────────────────────────────────────────────────────────
  await chapter('Type @ in the message — the same search opens, and no @ is left', async () => {
    await composer(page).click();
    await composer(page).pressSequentially('Split this into ', { delay: 60 });
    await composer(page).press('@');

    await expect(searchPopover(page)).toBeVisible();
    await expect(searchField(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('Split this into ');
    await beat();

    await page.keyboard.press('Escape');
    await expect(searchPopover(page)).toHaveCount(0);
    // Esc closed the SEARCH, not the planning surface.
    await expect(workspace(page)).toBeVisible();
    await expect(composer(page)).toBeFocused();
    await beat();
  });

  // ── STEP 5 ────────────────────────────────────────────────────────────────
  await chapter(`Select ${seed.storyKey} on the canvas — Set as target`, async () => {
    const card = canvasNode(page, seed.storyTitle);
    const crumbBefore = await breadcrumb(page).locator('[aria-current="page"]').textContent();
    await card.click();

    const actions = workspace(page).getByTestId('planning-canvas');
    await expect(actions.getByTestId('view-button')).toBeVisible();
    await expect(actions.getByTestId('drill-button')).toBeVisible();
    const toggle = actions.getByTestId('target-toggle-button');
    await expect(toggle).toHaveText('Set as target');
    await beat();

    await toggle.click();
    await expect(chip(page, seed.storyKey)).toBeVisible();
    await expect(card.getByTestId('planning-target-node')).toBeVisible();
    // The canvas did not move: the same level, the same crumb.
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(crumbBefore ?? '');
    await expect(canvasNode(page, seed.numberedTitle)).toBeVisible();
    await beat();
  });

  // ── STEP 6 ────────────────────────────────────────────────────────────────
  await chapter('The same card now reads Remove target', async () => {
    const toggle = workspace(page)
      .getByTestId('planning-canvas')
      .getByTestId('target-toggle-button');
    await expect(toggle).toHaveText('Remove target');
    await toggle.click();
    await expect(chip(page, seed.storyKey)).toHaveCount(0);
    expect(await trayKeys(page)).toEqual([seed.epicKey, seed.numberedKey]);
    await beat();
  });

  // ── STEP 7 — the states ───────────────────────────────────────────────────
  await chapter('The search’s states — too short, no match, already a target', async () => {
    await searchControl(page).click();

    // Below the minimum: a hint, and no request is made for it.
    await searchField(page).pressSequentially('1', { delay: 150 });
    await expect(searchPopover(page)).toContainText('Keep typing to search work items…');
    await beat();

    const nothing = searchResponse(page, 'quokka ledger');
    await searchField(page).fill('quokka ledger');
    await nothing;
    await expect(searchPopover(page)).toContainText('No work items match “quokka ledger”.');
    await beat();

    const again = searchResponse(page, number);
    await searchField(page).fill(number);
    await again;
    const already = options(page).filter({ hasText: seed.numberedKey });
    await expect(already).toHaveAttribute('aria-disabled', 'true');
    await expect(already).toContainText('Target');
    // A pointer press — the row is `aria-disabled`, which Playwright's `click`
    // would (rightly) wait on forever; the press is what a person's click sends.
    await already.dispatchEvent('mousedown');
    // Nothing was added twice.
    expect(await trayKeys(page)).toEqual([seed.epicKey, seed.numberedKey]);
    await beat();
  });
});
