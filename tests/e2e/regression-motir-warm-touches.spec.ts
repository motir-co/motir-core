import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { seedWarmTouchesFixture, type WarmTouchesCard } from './_helpers/warm-touches-seed';

// MOTIR-7586 — the acceptance receipt for MOTIR-7582, "Motir's warm touches". It
// walks the story in a real browser: a reader who never chose a palette sees the
// default Motir palette with an orange Epic and a gold Design; the identity roles
// (the ink CTA, the blue link and focus ring, the brand mark) do not move; the
// progress fill is the warm orange while the editor focus stays blue; the same
// holds in dark with the dark values; and the Appearance picker round-trips
// Motir → Amethyst → Motir, surviving a reload.
//
// Every colour is read with `getComputedStyle` off a RENDERED element (through
// `toHaveCSS`, which retries until the value is true). Every wait is
// authoritative — the `data-palette` / `data-theme` attribute the server or the
// init script stamps, a radio's checked state, a PATCH's own 200 — never a sleep.
// `chapter()` / `beat()` pace the recording for a human; they never synchronise.

test.describe.configure({ timeout: 300_000 });

const APPEARANCE_URL = '/settings/account/appearance';
const ITEMS_LIST_URL = '/items?view=list';

/** The resolved values the story ships, in the `rgb()` form computed styles carry. */
const MOTIR = {
  light: {
    epic: 'rgb(214, 96, 0)', // --el-type-epic / --el-highlight #d66000
    design: 'rgb(116, 96, 25)', // --el-type-design #746019
    progress: 'rgb(214, 96, 0)', // --el-progress-fill
    editorFocus: 'rgb(21, 91, 196)', // --el-editor-focus #155bc4
    ctaFill: 'rgb(26, 29, 33)', // --el-accent #1a1d21 (unchanged)
    link: 'rgb(21, 91, 196)', // --el-link #155bc4 (unchanged)
    focusRing: 'rgb(21, 91, 196)', // --focus-ring-color (unchanged)
    // The brand glyph paints --el-accent-on-surface: #155bc4 in light (unchanged).
    brand: [21, 91, 196] as const,
  },
  dark: {
    epic: 'rgb(250, 85, 0)', // #fa5500
    design: 'rgb(255, 208, 47)', // #ffd02f
    progress: 'rgb(250, 85, 0)',
    editorFocus: 'rgb(125, 177, 255)', // #7db1ff
    ctaFill: 'rgb(237, 238, 240)', // #edeef0 (unchanged)
    link: 'rgb(125, 177, 255)', // #7db1ff (unchanged)
    focusRing: 'rgb(125, 177, 255)',
    // color-mix(in srgb, #7db1ff 82%, #edeef0) — unchanged.
    brand: [145, 188, 252] as const,
  },
} as const;

/** Amethyst is untouched by the story: Epic and Design both wear its pink #ff64c8. */
const AMETHYST_TYPE_HUE = 'rgb(255, 100, 200)';

const html = (page: Page): Locator => page.locator('html');
const palettePicker = (page: Page): Locator =>
  page.getByRole('radiogroup', { name: 'Palette', exact: true });

/** One `/items` list row, by its card's (unique) title. */
const itemRow = (page: Page, card: WarmTouchesCard): Locator =>
  page.getByRole('table', { name: 'Work Items' }).getByRole('row').filter({ hasText: card.title });

/** The Epic row's kind icon (`IssueTypeIcon`, `text-(--el-type-epic)`). */
const epicIcon = (page: Page, card: WarmTouchesCard): Locator =>
  itemRow(page, card).locator('svg[class*="--el-type-epic"]');

/** The Design leaf's type glyph inside its `WorkItemTypeChip` (`text-(--el-type-design)`). */
const designIcon = (page: Page, card: WarmTouchesCard): Locator =>
  itemRow(page, card).locator('svg[class*="--el-type-design"]');

/** The top nav's brand tile glyph (`.brand-glyph`), reached through its link's name. */
const brandGlyph = (page: Page): Locator =>
  page.getByRole('link', { name: 'Motir — go home' }).locator('svg.brand-glyph');

/** The resolved-hue chip beside a token's name in the /tokens specimen. */
const tokenChip = (page: Page, token: string): Locator =>
  page
    .getByText(token, { exact: true })
    .locator('xpath=../preceding-sibling::div[@aria-hidden="true"][1]');

/**
 * A computed colour normalised to sRGB bytes by painting it on a 1×1 canvas — for
 * a value Chromium serialises as `color(srgb …)` (a `color-mix()`), which no
 * literal `rgb()` string can match.
 */
async function paintedRgb(locator: Locator, property: string): Promise<number[]> {
  return locator.evaluate((el, prop) => {
    const value = getComputedStyle(el).getPropertyValue(prop);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, property);
}

async function expectBrandGlyph(page: Page, rgb: readonly number[]): Promise<void> {
  const glyph = brandGlyph(page);
  await expect(glyph).toBeVisible();
  await expect
    .poll(async () => {
      const got = await paintedRgb(glyph, 'color');
      return got.every((c, i) => Math.abs(c - rgb[i]!) <= 2);
    })
    .toBe(true);
}

/** Case 1 (and its dark twin): the type hues on the rendered `/items` list. */
async function expectTypeHues(
  page: Page,
  epic: WarmTouchesCard,
  design: WarmTouchesCard,
  epicHue: string,
  designHue: string,
): Promise<void> {
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
  await expect(epicIcon(page, epic)).toBeVisible();
  await expect(epicIcon(page, epic)).toHaveCSS('color', epicHue);
  await expect(designIcon(page, design)).toBeVisible();
  await expect(designIcon(page, design)).toHaveCSS('color', designHue);
}

/** Cases 2–3 on the /tokens specimen: the ink CTA, its focus ring, the two new roles. */
async function expectSpecimen(page: Page, v: (typeof MOTIR)['light' | 'dark']): Promise<void> {
  await page.goto('/tokens');
  await expect(page.getByRole('heading', { name: 'Tokens', level: 1 })).toBeVisible();

  const cta = page.getByRole('button', { name: 'With left icon', exact: true });
  await expect(cta).toHaveAttribute('data-variant', 'primary');
  await expect(cta).toHaveCSS('background-color', v.ctaFill);

  // Reach the CTA from the KEYBOARD so `:focus-visible` holds and its ring paints.
  await cta.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(cta).toBeFocused();
  await expect
    .poll(() => cta.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain(v.focusRing);

  const progress = tokenChip(page, '--el-progress-fill');
  await progress.scrollIntoViewIfNeeded();
  await expect(progress).toHaveCSS('background-color', v.progress);
  await expect(tokenChip(page, '--el-editor-focus')).toHaveCSS('background-color', v.editorFocus);
}

/** Case 2's link: a real in-app link (`text-(--el-link)`) on the account tokens pane. */
async function expectLink(page: Page, link: string): Promise<void> {
  await page.goto('/settings/account/tokens');
  const guide = page.getByRole('link', { name: 'Read the CLI guide' });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveCSS('color', link);
}

/** Pick one option of an Appearance axis; the PATCH's 200 and `<html>` are the signal. */
async function chooseAppearance(
  page: Page,
  group: string,
  option: string,
  attr: string,
  value: string,
): Promise<void> {
  const patch = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: group, exact: true })
    .getByRole('radio', { name: option, exact: true })
    .click();
  expect((await patch).status()).toBe(200);
  await expect(html(page)).toHaveAttribute(attr, value);
  await expect(
    page
      .getByRole('radiogroup', { name: group, exact: true })
      .getByRole('radio', { name: option, exact: true }),
  ).toBeChecked();
}

test.describe('Motir keeps its ink identity and gains warm touches', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('orange Epic, gold Design, warm progress — ink CTA, blue link and focus unchanged, in light and dark', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7582');
    const email = `warm-touches-${Date.now().toString(36)}@example.com`;
    const fx = await seedWarmTouchesFixture(page, email);

    await chapter(
      'Never chose a palette: Motir, with an orange Epic and a gold Design',
      async () => {
        await page.goto(ITEMS_LIST_URL);
        await expect(html(page)).toHaveAttribute('data-palette', 'motir');
        await expect(html(page)).toHaveAttribute('data-theme', 'light');
        await expectTypeHues(page, fx.epic, fx.design, MOTIR.light.epic, MOTIR.light.design);
        await expectBrandGlyph(page, MOTIR.light.brand);
      },
    );
    await beat();

    await chapter(
      'The identity holds: ink button, blue focus ring and link — progress turns orange',
      async () => {
        await expectSpecimen(page, MOTIR.light);
        await expectLink(page, MOTIR.light.link);
      },
    );
    await beat();

    await chapter('Switch to dark in Settings › Appearance: the warm touches follow', async () => {
      await page.goto(APPEARANCE_URL);
      await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
      await chooseAppearance(page, 'Theme', 'Dark', 'data-theme', 'dark');
      await page.goto(ITEMS_LIST_URL);
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      await expect(html(page)).toHaveAttribute('data-palette', 'motir');
      await expectTypeHues(page, fx.epic, fx.design, MOTIR.dark.epic, MOTIR.dark.design);
      await expectBrandGlyph(page, MOTIR.dark.brand);
    });
    await beat();

    await chapter('Dark keeps the identity too', async () => {
      await expectSpecimen(page, MOTIR.dark);
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      await expectLink(page, MOTIR.dark.link);
    });
    await beat();

    await chapter(
      'Appearance lists Motir first and checked; Amethyst keeps its own hues',
      async () => {
        await page.goto(APPEARANCE_URL);
        await chooseAppearance(page, 'Theme', 'Light', 'data-theme', 'light');
        const radios = palettePicker(page).getByRole('radio');
        await expect(radios.nth(0)).toHaveAccessibleName('Motir');
        await expect(radios.nth(0)).toBeChecked();
        await chooseAppearance(page, 'Palette', 'Amethyst', 'data-palette', 'amethyst');
        await page.goto(ITEMS_LIST_URL);
        await expect(html(page)).toHaveAttribute('data-palette', 'amethyst');
        await expectTypeHues(page, fx.epic, fx.design, AMETHYST_TYPE_HUE, AMETHYST_TYPE_HUE);
      },
    );
    await beat();

    await chapter('Back to Motir: the warm touches return, and survive a reload', async () => {
      await page.goto(APPEARANCE_URL);
      await chooseAppearance(page, 'Palette', 'Motir', 'data-palette', 'motir');
      await page.goto(ITEMS_LIST_URL);
      await expect(html(page)).toHaveAttribute('data-palette', 'motir');
      await expectTypeHues(page, fx.epic, fx.design, MOTIR.light.epic, MOTIR.light.design);
      await beat();
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-palette', 'motir');
      await expect(html(page)).toHaveAttribute('data-theme', 'light');
      await expectTypeHues(page, fx.epic, fx.design, MOTIR.light.epic, MOTIR.light.design);
    });
    await beat();
  });
});
