// ACCEPTANCE: eight new styles (Story MOTIR-10549 · Subtask MOTIR-10676).
//
// The story's receipt, walked in a real browser against a production build:
//
//   1. Settings → Appearance lists every registered style in gallery order, the
//      eight new ones after Retrofuturism, each with its tagline as it is picked;
//   2. picking each new style saves (PATCH 200), re-styles <html data-style>,
//      applies the style's default pairing (drawn, not computed) and re-shapes
//      the app — one chapter per style, held so the re-shape can be seen;
//   3. a pinned Grotesk wins over every new style's default pairing;
//   4. a palette swap moves no shape and a style swap moves no hue, and each of
//      the four material styles re-tints its card under a second palette in
//      light and dark while the card's geometry stays put; only Memphis paints
//      the canvas;
//   5. High-Contrast draws a thick visible ring on every focused control and
//      holds every button and field to 44px, with no edge carried by a shadow;
//   6. the onboarding Design step offers every style and re-shapes only its own
//      page, writing no preference;
//   7. on /tokens the plan-with-AI pill and orb take each new style's material.
//
// Every expected value is DERIVED: the style list, its order and each name come
// from STYLE_IDS / STYLE_REGISTRY, the expected pairing from the entry's
// `defaultTypeId`, the four material styles from theme.css's own scoped rules,
// and every material and shape reading is compared against Warm Editorial in
// the same page session. No contrast ratio is read here; that is
// tests/theme/stylePaletteModeContrast.test.ts.
//
// Authoritative signals: a pick waits on its PATCH response, armed before the
// click, and on the committed root attribute; a face is polled through CDP
// (`expectDrawnIn`). `chapter()` / `beat()` holds are pacing only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  STYLE_IDS,
  STYLE_REGISTRY,
  type StyleId,
} from '../../packages/design-system/src/theme/styles';
import {
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
import { PAIRING_FACES, PAIRING_NAMES, cdpFor, expectDrawnIn } from './_helpers/font-probe';

const USER = 'e2e-eight-new-styles@example.com';
const APPEARANCE_URL = '/settings/account/appearance';
const BASE_STYLE: StyleId = 'warm-editorial';
const HIGH_CONTRAST: StyleId = 'high-contrast-accessible';
const CANVAS_STYLE: StyleId = 'memphis';
/** New styles whose hero orb is flat by design (tests/e2e/hero-ai-control-styles.spec.ts). */
const FLAT_ORB = new Set<StyleId>(['high-contrast-accessible', 'bento']);

/** The eight new styles: the ids after Retrofuturism, as the level fixed them. */
const NEW_STYLES = STYLE_IDS.slice(STYLE_IDS.indexOf('retrofuturism') + 1);

/**
 * The new styles that own a surface MATERIAL: those whose scoped rules in the
 * package stylesheet paint a `data-surface` hook other than the hero control.
 */
const MATERIAL_STYLES = (() => {
  const css = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  return NEW_STYLES.filter((id) =>
    [
      ...css.matchAll(
        new RegExp(
          `@scope \\(\\[data-style='${id}'\\]\\) to \\(\\[data-style\\]\\) \\{([^{]+)\\{`,
          'g',
        ),
      ),
    ].some(([, selector]) => selector!.includes('data-surface') && !selector!.includes('ai-cta')),
  );
})();

/** The shape-and-feel custom properties a style re-declares. */
const SHAPE_PROPS = [
  '--radius-btn',
  '--radius-card',
  '--radius-input',
  '--radius-modal',
  '--radius-badge',
  '--radius-control',
  '--spacing-btn-x',
  '--spacing-btn-y',
  '--spacing-card-padding',
  '--spacing-control-x',
  '--spacing-control-y',
  '--height-control',
  '--shadow-card',
  '--shadow-elevated',
  '--transition-duration',
  '--focus-ring-width',
] as const;

/** The palette's element tokens, as theme.css's Tier-3 base names them. */
const ELEMENT_TOKENS = (() => {
  const css = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');
  return [...new Set([...css.matchAll(/^\s*(--el-[a-z0-9-]+)\s*:/gm)].map(([, name]) => name!))];
})();

const html = (page: Page): Locator => page.locator('html');
const styleGroup = (scope: Page | Locator): Locator =>
  scope.getByRole('radiogroup', { name: msg('en', 'settings.appearance.style.name'), exact: true });
const paletteGroup = (page: Page): Locator =>
  page.getByRole('radiogroup', {
    name: msg('en', 'settings.appearance.palette.name'),
    exact: true,
  });
const typeGroup = (page: Page): Locator =>
  page.getByRole('radiogroup', { name: msg('en', 'settings.appearance.type.name'), exact: true });
const appearanceHeadline = (page: Page): Locator =>
  page
    .getByRole('main')
    .getByRole('heading', { name: msg('en', 'settings.appearance.heading'), exact: true });
const designRegion = (page: Page): Locator =>
  page.getByRole('region', { name: msg('en', 'onboarding.design.title'), exact: true });

/** Click one Appearance radio and wait on its PATCH, armed before the click. */
async function pickOn(
  page: Page,
  group: Locator,
  option: string,
  prefKey: 'styleId' | 'paletteId' | 'typeId',
  value: string,
  attr: 'data-style' | 'data-palette' | 'data-type',
): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await group.getByRole('radio', { name: option, exact: true }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { preference: Record<string, string> };
  expect(body.preference[prefKey]).toBe(value);
  await expect(html(page)).toHaveAttribute(attr, value);
}

const pickStyle = (page: Page, id: StyleId) =>
  pickOn(page, styleGroup(page), STYLE_REGISTRY[id]!.name, 'styleId', id, 'data-style');
const pickPalette = (page: Page, id: PaletteId) =>
  pickOn(page, paletteGroup(page), PALETTE_REGISTRY[id]!.name, 'paletteId', id, 'data-palette');

/** Custom properties as the browser resolves them on an element. */
async function customProps(target: Locator, names: readonly string[]) {
  return target.evaluate(
    (el, list) => {
      const s = getComputedStyle(el);
      return Object.fromEntries(list.map((name) => [name, s.getPropertyValue(name).trim()]));
    },
    [...names],
  );
}

/**
 * The rendered box of the pane itself: the selected Style chip and the card it
 * sits in. A chip alone is not enough, because a pill chip keeps its full-round
 * radius and its padding under several styles; the card's radius, padding and
 * border carry the rest of the shape axis.
 */
async function controlBox(page: Page, id: StyleId): Promise<string> {
  const chip = await styleGroup(page)
    .getByRole('radio', { name: STYLE_REGISTRY[id]!.name, exact: true })
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopLeftRadius, s.height, s.paddingTop, s.paddingLeft, s.borderTopWidth];
    });
  const card = await page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[data-surface="card"]')].find(
      (c) => c.closest('[data-style]') === document.documentElement,
    );
    if (!el) return ['no card'];
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.paddingTop, s.paddingLeft, s.borderTopWidth, s.boxShadow];
  });
  return [...chip, '|', ...card].join(' ');
}

/**
 * The first card surface the APP's style reaches, with its paint and geometry.
 * A preview scoped under its own `data-style` is skipped: the material layer's
 * `@scope … to ([data-style])` limit keeps the app's style out of it.
 */
async function cardSurface(page: Page) {
  const read = await page.evaluate(() => {
    const card = [...document.querySelectorAll<HTMLElement>('[data-surface="card"]')].find(
      (el) => el.closest('[data-style]') === document.documentElement,
    );
    if (!card) return null;
    const s = getComputedStyle(card);
    return {
      paint: [s.backgroundColor, s.backgroundImage, s.borderTopColor, s.boxShadow].join(' | '),
      geometry: [
        s.borderTopLeftRadius,
        s.borderTopWidth,
        s.paddingTop,
        s.paddingLeft,
        card.getBoundingClientRect().height,
      ].join(' | '),
    };
  });
  expect(read, 'no [data-surface="card"] hook on this route; /workbench ships one').not.toBeNull();
  return read!;
}

/** The page-level background images: the root, the body and the shell root. */
async function canvasImages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [document.documentElement, document.body, document.querySelector('[data-app-shell]')]
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .map((el) => getComputedStyle(el).backgroundImage)
      .filter((image) => image !== 'none'),
  );
}

/** A tiers-complete web pre-plan read, so the onboarding hub offers the Design step. */
async function stubCompletedPreplan(page: Page): Promise<void> {
  const ISO = '2026-11-08T00:00:00.000Z';
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

/** The /tokens hero controls' resolved material, as one comparable string each. */
async function heroMaterial(page: Page): Promise<{ pill: string; orb: string; orbImage: string }> {
  return page.evaluate(() => {
    const read = (which: string) => {
      const el = document.querySelector<HTMLElement>(`[data-ai-cta="${which}"]`);
      if (!el) throw new Error(`no [data-ai-cta="${which}"] on /tokens`);
      const s = getComputedStyle(el);
      return {
        image: s.backgroundImage,
        all: [
          s.backgroundImage,
          s.backgroundColor,
          `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
          s.borderTopLeftRadius,
          s.boxShadow,
        ].join(' | '),
      };
    };
    const orb = read('orb');
    return { pill: read('pill').all, orb: orb.all, orbImage: orb.image };
  });
}

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test.describe('eight new styles', () => {
  test.use({ locale: 'en-US' });

  test('each new style is offered, picked and re-shapes the app, in both pickers', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10549');
    test.setTimeout(1_200_000);
    expect(NEW_STYLES).toHaveLength(8);
    expect(MATERIAL_STYLES.length, 'the new styles that paint a surface material').toBe(4);
    expect(ELEMENT_TOKENS.length).toBeGreaterThan(20);
    const cdp = await cdpFor(page);
    const started = Date.now();

    let baseShape: Record<string, string> = {};
    let baseBox = '';

    // ── 1 ───────────────────────────────────────────────────────────────────
    await chapter('Appearance lists every style, the eight new ones last', async () => {
      await signUp(page, USER);
      await page.goto(APPEARANCE_URL);
      await expect(appearanceHeadline(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const radios = styleGroup(page).getByRole('radio');
      await expect(radios).toHaveCount(STYLE_IDS.length);
      for (const [i, id] of STYLE_IDS.entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(STYLE_REGISTRY[id]!.name);
      }
      if ((await html(page).getAttribute('data-style')) !== BASE_STYLE) {
        await pickStyle(page, BASE_STYLE);
      }
      expect(await canvasImages(page), 'Warm Editorial paints no canvas').toEqual([]);
      baseShape = await customProps(html(page), SHAPE_PROPS);
      baseBox = await controlBox(page, BASE_STYLE);
      await styleGroup(page).scrollIntoViewIfNeeded();
      await beat();
    });

    // ── 2 ───────────────────────────────────────────────────────────────────
    for (const id of NEW_STYLES) {
      const entry = STYLE_REGISTRY[id]!;
      await chapter(`${entry.name}: the app re-shapes`, async () => {
        await pickStyle(page, id);
        await expect(page.getByRole('main').getByText(entry.tagline)).toBeVisible();
        await expect(html(page)).toHaveAttribute('data-type', entry.defaultTypeId);
        await expectDrawnIn(cdp, appearanceHeadline(page), {
          in: [PAIRING_FACES[entry.defaultTypeId]!.serif],
        });
        const shape = await customProps(html(page), SHAPE_PROPS);
        const moved = SHAPE_PROPS.filter((name) => shape[name] !== baseShape[name]);
        expect(moved.length, `${id} resolves Warm Editorial's shape`).toBeGreaterThan(0);
        expect(await controlBox(page, id), `${id}'s chip and card keep the base box`).not.toBe(
          baseBox,
        );
        const canvas = await canvasImages(page);
        if (id === CANVAS_STYLE)
          expect(canvas.length, `${id} paints its canvas`).toBeGreaterThan(0);
        else expect(canvas, `${id} paints no canvas`).toEqual([]);
        await styleGroup(page).scrollIntoViewIfNeeded();
        await beat();
      });
    }

    // ── 3 ───────────────────────────────────────────────────────────────────
    await chapter('A pinned Grotesk wins over every new style', async () => {
      await pickOn(page, typeGroup(page), PAIRING_NAMES.grotesk!, 'typeId', 'grotesk', 'data-type');
      const defaults = [
        ...new Set(NEW_STYLES.map((id) => PAIRING_FACES[STYLE_REGISTRY[id]!.defaultTypeId]!.serif)),
      ].filter((face) => face !== PAIRING_FACES.grotesk!.serif);
      for (const id of NEW_STYLES) {
        await pickStyle(page, id);
        await expect(html(page)).toHaveAttribute('data-type', 'grotesk');
        await expectDrawnIn(cdp, appearanceHeadline(page), {
          in: [PAIRING_FACES.grotesk!.serif],
          never: defaults,
        });
      }
      await appearanceHeadline(page).scrollIntoViewIfNeeded();
      await beat();
    });

    // ── 4 ───────────────────────────────────────────────────────────────────
    await chapter('A second palette with a pinned type: the style still re-shapes', async () => {
      const active = await html(page).getAttribute('data-palette');
      const second = PALETTE_IDS.find((p) => p !== active)!;
      await pickPalette(page, second);
      await pickStyle(page, BASE_STYLE);
      const before = await customProps(html(page), [...SHAPE_PROPS, ...ELEMENT_TOKENS]);
      const id = NEW_STYLES[0]!;
      await pickStyle(page, id);
      await expect(html(page)).toHaveAttribute('data-palette', second);
      await expect(html(page)).toHaveAttribute('data-type', 'grotesk');
      const after = await customProps(html(page), [...SHAPE_PROPS, ...ELEMENT_TOKENS]);
      expect(SHAPE_PROPS.filter((name) => after[name] !== before[name]).length).toBeGreaterThan(0);
      expect(ELEMENT_TOKENS.filter((name) => after[name] !== before[name])).toEqual([]);
      await beat();
    });

    await chapter('Under every style, the palette resolves byte-identical', async () => {
      await pickStyle(page, BASE_STYLE);
      const base = await customProps(html(page), ELEMENT_TOKENS);
      for (const id of STYLE_IDS) {
        if (id === BASE_STYLE) continue;
        await pickStyle(page, id);
        const tokens = await customProps(html(page), ELEMENT_TOKENS);
        const moved = ELEMENT_TOKENS.filter((name) => tokens[name] !== base[name]);
        expect(moved, `${id} moved palette tokens`).toEqual([]);
      }
      await beat();
    });

    for (const theme of ['light', 'dark'] as const) {
      await chapter(`The material styles re-tint under a second palette (${theme})`, async () => {
        if (theme === 'dark') {
          const saved = page.waitForResponse(
            (r) =>
              r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
          );
          await page
            .getByRole('radiogroup', {
              name: msg('en', 'settings.appearance.theme.name'),
              exact: true,
            })
            .getByRole('radio', { name: msg('en', 'settings.appearance.theme.dark'), exact: true })
            .click();
          expect((await saved).status()).toBe(200);
          await expect(html(page)).toHaveAttribute('data-theme', 'dark');
        }
        for (const id of MATERIAL_STYLES) {
          await pickStyle(page, id);
          const current = (await html(page).getAttribute('data-palette'))!;
          const other = PALETTE_IDS.find((p) => p !== current)!;
          const before = await cardSurface(page);
          await pickPalette(page, other);
          const after = await cardSurface(page);
          expect(after.paint, `${id} (${theme}) card did not re-tint`).not.toBe(before.paint);
          expect(after.geometry, `${id} (${theme}) card moved`).toBe(before.geometry);
        }
        await appearanceHeadline(page).scrollIntoViewIfNeeded();
        await beat();
      });
    }

    // ── 5 ───────────────────────────────────────────────────────────────────
    await chapter('High-Contrast: a thick ring on every focused control', async () => {
      await pickStyle(page, HIGH_CONTRAST);
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      const seen: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.press('Tab');
        const ring = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          // A scoped preview keeps its own style, so it is not the app's ring.
          if (el.closest('[data-style]') !== document.documentElement) return null;
          const s = getComputedStyle(el);
          return {
            label: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}`,
            width: parseFloat(s.outlineWidth),
            style: s.outlineStyle,
            colour: s.outlineColor,
            background: s.backgroundColor,
          };
        });
        if (!ring) continue;
        seen.push(ring.label);
        expect(ring.style, `${ring.label} has no outline`).not.toBe('none');
        expect(ring.width, `${ring.label} outline`).toBeGreaterThanOrEqual(2);
        expect(ring.colour, `${ring.label} ring matches its own fill`).not.toBe(ring.background);
      }
      expect(seen.length).toBeGreaterThan(5);
      await beat();
    });

    await chapter('High-Contrast: 44px targets and no edge on a shadow', async () => {
      const report = await page.evaluate(() => {
        // Visible, and under the APP's style rather than a scoped preview's.
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            getComputedStyle(el).visibility !== 'hidden' &&
            el.closest('[data-style]') === document.documentElement
          );
        };
        const small = [
          ...document.querySelectorAll(
            'button, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
          ),
        ]
          .filter(visible)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width < 44 || r.height < 44)
          .map(({ el, r }) => `${el.outerHTML.slice(0, 80)} ${r.width}x${r.height}`);
        const shadowed = [...document.querySelectorAll('[data-surface]')]
          .filter(visible)
          .filter((el) => getComputedStyle(el).boxShadow !== 'none')
          .map((el) => el.getAttribute('data-surface'));
        const controls = document.querySelectorAll('button').length;
        return { small, shadowed, controls };
      });
      expect(report.controls).toBeGreaterThan(0);
      expect(report.small, 'controls under 44px').toEqual([]);
      expect(report.shadowed, 'surfaces whose edge is a shadow').toEqual([]);
      await beat();
    });

    // ── 6 ───────────────────────────────────────────────────────────────────
    await chapter('The onboarding Design step offers every style', async () => {
      await page.goto('/workbench');
      await createFirstProject(page, 'Style tour');
      await stubCompletedPreplan(page);
      await page.goto('/onboarding/discovery');
      await page.getByRole('button', { name: 'Design your look' }).last().click();
      const designPage = designRegion(page);
      await expect(designPage).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(designPage).toHaveAttribute('data-appearance-scope', /.*/);
      const radios = styleGroup(designPage).getByRole('radio');
      await expect(radios).toHaveCount(STYLE_IDS.length);
      for (const [i, id] of STYLE_IDS.entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(STYLE_REGISTRY[id]!.name);
      }
      await styleGroup(designPage).scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter('Design step: each new style re-shapes only the example', async () => {
      const designPage = designRegion(page);
      const appStyle = await html(page).getAttribute('data-style');
      let writes = 0;
      const count = (r: { url: () => string }) => {
        if (r.url().includes('/api/appearance-preference')) writes += 1;
      };
      page.on('request', count);
      await styleGroup(designPage)
        .getByRole('radio', { name: STYLE_REGISTRY[BASE_STYLE]!.name, exact: true })
        .click();
      await expect(designPage).toHaveAttribute('data-style', BASE_STYLE);
      const base = await customProps(designPage, SHAPE_PROPS);
      for (const id of NEW_STYLES) {
        await styleGroup(designPage)
          .getByRole('radio', { name: STYLE_REGISTRY[id]!.name, exact: true })
          .click();
        await expect(designPage).toHaveAttribute('data-style', id);
        const shape = await customProps(designPage, SHAPE_PROPS);
        expect(
          SHAPE_PROPS.filter((name) => shape[name] !== base[name]).length,
          `${id} did not re-shape the example`,
        ).toBeGreaterThan(0);
        expect(await html(page).getAttribute('data-style')).toBe(appStyle);
        await beat();
      }
      page.off('request', count);
      expect(writes, 'the Design step wrote an appearance preference').toBe(0);
    });

    // ── 7 ───────────────────────────────────────────────────────────────────
    await chapter('On /tokens the hero pill and orb take each style', async () => {
      await page.goto('/tokens');
      await expect(page.locator('[data-ai-cta="pill"]')).toBeVisible({ timeout: FIRST_PAINT_MS });
      const setStyle = async (id: StyleId) => {
        await page.getByRole('button', { name: STYLE_REGISTRY[id]!.name, exact: true }).click();
        await expect(html(page)).toHaveAttribute('data-style', id);
      };
      await setStyle(BASE_STYLE);
      const base = await heroMaterial(page);
      expect(base.orbImage).toContain('radial-gradient');
      for (const id of NEW_STYLES) {
        await setStyle(id);
        const hero = await heroMaterial(page);
        expect(hero.pill, `${id}'s pill has the base material`).not.toBe(base.pill);
        expect(hero.orb, `${id}'s orb has the base material`).not.toBe(base.orb);
        // The new styles whose record draws a flat orb, as the hero spec's
        // FLAT_ORB set lists them: no lit sphere, whatever the flat fill is.
        if (FLAT_ORB.has(id)) {
          expect(hero.orbImage, `${id}'s orb is flat`).not.toContain('radial-gradient');
        } else expect(hero.orbImage, `${id}'s orb`).toContain('radial-gradient');
      }
      await page.locator('[data-ai-cta="pill"]').scrollIntoViewIfNeeded();
      await beat();
    });

    // The lane states its length budget in prose and checks none, so the run
    // reports the clip it produced rather than dropping a chapter to fit.
    const clip = `${Math.round((Date.now() - started) / 1000)}s`;
    test.info().annotations.push({ type: 'clip-length', description: clip });
    console.warn(`[acceptance] eight new styles: clip ≈ ${clip}`);
  });
});
