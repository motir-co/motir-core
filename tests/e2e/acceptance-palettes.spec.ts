// ACCEPTANCE: four new palettes (Story MOTIR-10550 · Subtask MOTIR-10718).
//
// The story's receipt, walked in a real browser against a production build:
//
//   1. Settings → Appearance lists every registered palette in gallery order,
//      the four new ones after Candy;
//   2. each new palette is picked (PATCH 200), re-colours <html data-palette>,
//      repaints the pane's ink, and is toggled Dark then Light with the style
//      and type left where they were;
//   3. a reload keeps the last pick, so the clip rests on a persisted write;
//   4. under each new palette the five recipe styles are swept in light and in
//      dark, the palette holding while the style follows each pick;
//   5. Contrast, then Motir, then Contrast again, in both modes, back to back;
//   6. the onboarding Design step offers the same palettes and re-colours only
//      its own page, in light and dark;
//   7. an unregistered stored palette id reloads as Motir, with no script error.
//
// Every expected value is DERIVED: the palette list, its order and each name
// come from PALETTE_IDS / PALETTE_REGISTRY (the four new ids are whatever sits
// after Candy, never typed here), the style ids and labels from STYLE_REGISTRY.
// "Repainted" is read as the computed colour of a heading that carries the ink
// utility CHANGING between palettes and between modes — a repaint signal, not a
// ratio. No contrast ratio is computed here; that is
// tests/theme/stylePaletteModeContrast.test.ts.
//
// Authoritative signals: a pane pick waits on its PATCH response, armed before
// the click, then on the committed root attribute; a Design-step pick is local
// state, so it waits on the step's own section attribute. `chapter()` /
// `beat()` holds are pacing only — removing every one leaves each assertion
// unchanged.

import type { Locator, Page } from '@playwright/test';
import { STYLE_REGISTRY, type StyleId } from '../../packages/design-system/src/theme/styles';
import {
  BASE_PALETTE_ID,
  PALETTE_IDS,
  PALETTE_REGISTRY,
  type PaletteId,
} from '../../packages/design-system/src/theme/palettes';
// ↑ The modules' source, not the package: the package's `exports` offer only an
// ESM `import` condition, which Playwright's CommonJS loader cannot resolve.
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';
import { msg } from './_helpers/i18n-walk';

const USER = 'e2e-four-new-palettes@example.com';
const APPEARANCE_URL = '/settings/account/appearance';
const PALETTE_STORAGE_KEY = 'motir.theme.palette';

/** The four new palettes: the ids after Candy, as the four palette cards appended them. */
const NEW_PALETTES = PALETTE_IDS.slice(PALETTE_IDS.indexOf('candy') + 1) as PaletteId[];
const CONTRAST = 'contrast' as PaletteId;
const MOTIR = 'motir' as PaletteId;

/** The five styles the story's verification recipe names — ids checked against the registry. */
const RECIPE_STYLES = [
  'glassmorphism',
  'claymorphism',
  'tonal-elevated',
  'memphis',
  'dense-pro',
] as const satisfies readonly StyleId[];
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const html = (page: Page): Locator => page.locator('html');
const group = (scope: Page | Locator, ns: string, axis: string): Locator =>
  scope.getByRole('radiogroup', { name: msg('en', `${ns}.${axis}.name`), exact: true });

const PANE = 'settings.appearance';
const STEP = 'onboarding.design';

/** The pane's card title — `text-(--el-text)`, so it carries the palette's ink. */
const paneTitle = (page: Page): Locator =>
  page.getByRole('heading', { name: msg('en', `${PANE}.card.title`), exact: true });
const designPage = (page: Page): Locator => page.getByTestId('design-page');
/** The Design step's own title — `text-(--el-text)` inside the scoped section. */
const stepTitle = (page: Page): Locator =>
  designPage(page).getByRole('heading', { name: msg('en', `${STEP}.title`), exact: true });

const inkOf = (heading: Locator): Promise<string> =>
  heading.evaluate((el) => getComputedStyle(el).color);

/** Which radio is checked in a group — its index, read from `aria-checked`. */
async function checkedIn(radiogroup: Locator): Promise<number> {
  return radiogroup
    .getByRole('radio')
    .evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-checked') === 'true'));
}

/** Click one pane radio and wait on its PATCH — armed before the click — then the root attribute. */
async function paneSave(
  page: Page,
  radiogroup: Locator,
  option: string,
  check: (preference: Record<string, string>) => void,
): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await radiogroup.getByRole('radio', { name: option, exact: true }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  check(((await res.json()) as { preference: Record<string, string> }).preference);
}

async function pickPalette(page: Page, id: PaletteId): Promise<void> {
  const style = await html(page).getAttribute('data-style');
  const type = await html(page).getAttribute('data-type');
  const styleChecked = await checkedIn(group(page, PANE, 'style'));
  const typeChecked = await checkedIn(group(page, PANE, 'type'));
  await paneSave(page, group(page, PANE, 'palette'), PALETTE_REGISTRY[id].name, (p) =>
    expect(p['paletteId']).toBe(id),
  );
  await expect(html(page)).toHaveAttribute('data-palette', id);
  // A palette pick moves neither the style nor the type, and their chips stay put.
  await expect(html(page)).toHaveAttribute('data-style', style!);
  await expect(html(page)).toHaveAttribute('data-type', type!);
  expect(await checkedIn(group(page, PANE, 'style'))).toBe(styleChecked);
  expect(await checkedIn(group(page, PANE, 'type'))).toBe(typeChecked);
}

async function pickStyle(page: Page, id: StyleId): Promise<void> {
  const palette = await html(page).getAttribute('data-palette');
  await paneSave(page, group(page, PANE, 'style'), STYLE_REGISTRY[id].name, (p) =>
    expect(p['styleId']).toBe(id),
  );
  await expect(html(page)).toHaveAttribute('data-style', id);
  await expect(html(page)).toHaveAttribute('data-palette', palette!);
}

async function pickTheme(page: Page, theme: Theme): Promise<void> {
  const palette = await html(page).getAttribute('data-palette');
  await paneSave(page, group(page, PANE, 'theme'), msg('en', `${PANE}.theme.${theme}`), (p) =>
    expect(p['pattern']).toBe(theme),
  );
  await expect(html(page)).toHaveAttribute('data-theme', theme);
  await expect(html(page)).toHaveAttribute('data-palette', palette!);
}

/** A tiers-complete web pre-plan read, so the onboarding hub offers the Design step. */
async function stubCompletedPreplan(page: Page): Promise<void> {
  const ISO = '2026-11-09T00:00:00.000Z';
  const doc = (kind: string) => ({
    kind,
    currentBody: `# ${kind}\n\nReady.`,
    currentVersion: 1,
    summary: [],
    versions: [{ version: 1, changeReason: null, changeKind: null, diff: null, createdAt: ISO }],
  });
  await page.route('**/api/ai/pre-plan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          classification: 'new_product',
          platform: 'web',
          designStarter: null,
          designChoice: null,
          validationTiming: null,
          docSkipSet: [],
          currentGate: null,
          status: 'tiers_complete',
          conversation: [],
          createdAt: ISO,
          updatedAt: ISO,
        },
        docs: ['discovery', 'vision', 'feasibility', 'validation'].map(doc),
        catalog: null,
      }),
    });
  });
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test.describe('four new palettes', () => {
  test.use({ locale: 'en-US' });

  test('each new palette is offered, picked and repaints the app, in both pickers and both modes', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10550');
    test.setTimeout(1_800_000);
    expect(NEW_PALETTES).toHaveLength(4);
    for (const id of NEW_PALETTES) expect(PALETTE_REGISTRY[id].name.trim()).not.toBe('');
    for (const id of RECIPE_STYLES) expect(STYLE_REGISTRY[id]).toBeDefined();
    const started = Date.now();

    // The ink each palette painted in each mode, for the "it repainted" reads.
    const ink: Record<string, Record<Theme, string>> = {};

    // ── 1 ───────────────────────────────────────────────────────────────────
    await chapter('Appearance lists every palette, the four new ones after Candy', async () => {
      await signUp(page, USER);
      await page.goto(APPEARANCE_URL);
      await expect(paneTitle(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const radios = group(page, PANE, 'palette').getByRole('radio');
      await expect(radios).toHaveCount(PALETTE_IDS.length);
      for (const [i, id] of PALETTE_IDS.entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(PALETTE_REGISTRY[id].name);
      }
      // Pin the mode, so every later toggle is a stored choice and not the device's.
      await pickTheme(page, 'light');
      // Start the sweep from the base palette, whose ink every new palette departs from.
      await pickPalette(page, BASE_PALETTE_ID);
      ink[BASE_PALETTE_ID] = { light: await inkOf(paneTitle(page)), dark: '' };
      await pickTheme(page, 'dark');
      ink[BASE_PALETTE_ID].dark = await inkOf(paneTitle(page));
      await pickTheme(page, 'light');
      await group(page, PANE, 'palette').scrollIntoViewIfNeeded();
      await beat();
    });

    // ── 2 ───────────────────────────────────────────────────────────────────
    let previous: PaletteId = BASE_PALETTE_ID;
    for (const id of NEW_PALETTES) {
      const name = PALETTE_REGISTRY[id].name;
      await chapter(`${name}: picked, the app repaints, then Dark and Light`, async () => {
        await pickPalette(page, id);
        await expect(page.getByRole('main').getByText(PALETTE_REGISTRY[id].tagline)).toBeVisible();
        const light = await inkOf(paneTitle(page));
        expect(light, `${id} light ink repainted from ${previous}`).not.toBe(ink[previous]!.light);
        await group(page, PANE, 'palette').scrollIntoViewIfNeeded();
        await beat();

        await pickTheme(page, 'dark');
        const dark = await inkOf(paneTitle(page));
        expect(dark, `${id} dark ink differs from its light ink`).not.toBe(light);
        expect(dark, `${id} dark ink repainted from ${previous}`).not.toBe(ink[previous]!.dark);
        await beat();

        await pickTheme(page, 'light');
        expect(await inkOf(paneTitle(page))).toBe(light);
        ink[id] = { light, dark };
        previous = id;
      });
    }

    // ── 3 ───────────────────────────────────────────────────────────────────
    const last = NEW_PALETTES.at(-1)!;
    await chapter('A reload keeps the last pick', async () => {
      await page.reload();
      await expect(paneTitle(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(html(page)).toHaveAttribute('data-palette', last);
      await expect(
        group(page, PANE, 'palette').getByRole('radio', {
          name: PALETTE_REGISTRY[last].name,
          exact: true,
        }),
      ).toBeChecked();
      await beat();
    });

    // ── 4 ───────────────────────────────────────────────────────────────────
    const baseStyle = (await html(page).getAttribute('data-style')) as StyleId;
    for (const id of NEW_PALETTES) {
      for (const theme of THEMES) {
        await chapter(
          `${PALETTE_REGISTRY[id].name} under the material styles (${theme})`,
          async () => {
            if ((await html(page).getAttribute('data-palette')) !== id) await pickPalette(page, id);
            if ((await html(page).getAttribute('data-theme')) !== theme)
              await pickTheme(page, theme);
            for (const style of RECIPE_STYLES) {
              await pickStyle(page, style);
              await expect(html(page)).toHaveAttribute('data-palette', id);
              await expect(html(page)).toHaveAttribute('data-theme', theme);
              await paneTitle(page).scrollIntoViewIfNeeded();
              await beat();
            }
            await pickStyle(page, baseStyle);
          },
        );
      }
    }
    if ((await html(page).getAttribute('data-theme')) !== 'light') await pickTheme(page, 'light');

    // ── 5 ───────────────────────────────────────────────────────────────────
    for (const theme of THEMES) {
      await chapter(`Contrast, then Motir, then Contrast again (${theme})`, async () => {
        if ((await html(page).getAttribute('data-theme')) !== theme) await pickTheme(page, theme);
        if ((await html(page).getAttribute('data-palette')) !== CONTRAST) {
          await pickPalette(page, CONTRAST);
        }
        const contrastInk = await inkOf(paneTitle(page));
        await paneTitle(page).scrollIntoViewIfNeeded();
        await beat();
        await pickPalette(page, MOTIR);
        const motirInk = await inkOf(paneTitle(page));
        expect(motirInk, `motir (${theme}) repainted from contrast`).not.toBe(contrastInk);
        await beat();
        await pickPalette(page, CONTRAST);
        const again = await inkOf(paneTitle(page));
        expect(again, `contrast (${theme}) repainted from motir`).not.toBe(motirInk);
        expect(again).toBe(contrastInk);
        await beat();
      });
    }

    // ── 6 ───────────────────────────────────────────────────────────────────
    await chapter('The onboarding Design step offers the same palettes', async () => {
      await page.goto('/workbench');
      await createFirstProject(page, 'Palette tour');
      await stubCompletedPreplan(page);
      await page.goto('/onboarding/discovery');
      await page
        .getByRole('button', { name: msg('en', 'onboarding.chat.canvas.stations.design.cta') })
        .last()
        .click();
      await expect(designPage(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(designPage(page)).toHaveAttribute('data-appearance-scope', '');
      const radios = group(designPage(page), STEP, 'palette').getByRole('radio');
      await expect(radios).toHaveCount(PALETTE_IDS.length);
      for (const [i, id] of PALETTE_IDS.entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(PALETTE_REGISTRY[id].name);
      }
      await group(designPage(page), STEP, 'palette').scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter(
      'Design step: each new palette re-colours only its page, light and dark',
      async () => {
        const region = designPage(page);
        const appPalette = await html(page).getAttribute('data-palette');
        let writes = 0;
        const count = (r: { url: () => string }) => {
          if (r.url().includes('/api/appearance-preference')) writes += 1;
        };
        page.on('request', count);
        const style = await region.getAttribute('data-style');
        const type = await region.getAttribute('data-type');
        let previousInk = await inkOf(stepTitle(page));
        for (const id of NEW_PALETTES) {
          await group(region, STEP, 'palette')
            .getByRole('radio', { name: PALETTE_REGISTRY[id].name, exact: true })
            .click();
          await expect(region).toHaveAttribute('data-palette', id);
          await expect(region).toHaveAttribute('data-style', style!);
          await expect(region).toHaveAttribute('data-type', type!);
          const light = await inkOf(stepTitle(page));
          expect(light, `${id} repainted the Design step`).not.toBe(previousInk);
          await beat();

          await group(region, STEP, 'theme')
            .getByRole('radio', { name: msg('en', `${STEP}.theme.dark`), exact: true })
            .click();
          await expect(region).toHaveAttribute('data-theme', 'dark');
          await expect(region).toHaveAttribute('data-palette', id);
          expect(await inkOf(stepTitle(page)), `${id} Design step dark ink`).not.toBe(light);
          await beat();

          await group(region, STEP, 'theme')
            .getByRole('radio', { name: msg('en', `${STEP}.theme.light`), exact: true })
            .click();
          await expect(region).toHaveAttribute('data-theme', 'light');
          previousInk = light;
          // The step's design is the project's, not the person's: <html> never moves.
          await expect(html(page)).toHaveAttribute('data-palette', appPalette!);
        }
        page.off('request', count);
        expect(writes, 'the Design step wrote an appearance preference').toBe(0);
      },
    );

    // ── 7 ───────────────────────────────────────────────────────────────────
    await chapter(
      'An unknown stored palette falls back to Motir, without a script error',
      async () => {
        const device = await browser.newContext();
        const visitor = await device.newPage();
        const errors: string[] = [];
        visitor.on('pageerror', (error) => errors.push(error.message));
        visitor.on('console', (m) => {
          // A resource that fails to load is the lane's own stubbed external hosts,
          // not the palette — the check is for a SCRIPT error reading the stored id.
          if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
            errors.push(m.text());
        });
        await visitor.goto('/sign-in');
        // The palette id only: the stored ids-version marker stays as the run found it.
        const unknown = 'not-a-registered-palette';
        expect(PALETTE_IDS as readonly string[]).not.toContain(unknown);
        await visitor.evaluate(
          ([key, value]) => localStorage.setItem(key!, value!),
          [PALETTE_STORAGE_KEY, unknown],
        );
        await visitor.reload();
        await expect(html(visitor)).toHaveAttribute('data-palette', MOTIR);
        expect(errors).toEqual([]);
        await device.close();
      },
    );

    // The lane checks no length budget (docs/decisions/acceptance-video.md), so
    // the run reports the clip it produced rather than dropping a chapter.
    const clip = `${Math.round((Date.now() - started) / 1000)}s`;
    test.info().annotations.push({ type: 'clip-length', description: clip });
    console.warn(`[acceptance] four new palettes: clip ≈ ${clip}`);
  });
});
