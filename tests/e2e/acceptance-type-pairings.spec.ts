// ACCEPTANCE: four new type pairings (Story MOTIR-10548 · Subtask MOTIR-10558).
//
// The story's verification recipe, walked in a real browser against a
// production build and recorded as its receipt:
//
//   1. Settings → Appearance lists ten pairings, Marker · Rounded · Slab ·
//      Humanist after Mono-Technical;
//   2. picking each saves (PATCH 200), re-types <html data-type>, draws the
//      headline in the pairing's face and keeps body copy readable;
//   3. a fresh user on Hand-Drawn / Indie gets Marker without pinning it, and a
//      pinned Grotesk wins over it;
//   4. under each new pairing a Japanese page draws Latin in the pairing's face
//      and kana / kanji in the ja set's face, in every role;
//   5. the onboarding DesignStep lists the four and re-types only its own page;
//   6. an unknown stored type id falls back to Motir, server-side and live.
//
// ⚠️ EVERY FACE ASSERTION READS WHAT THE BROWSER DREW (`expectDrawnIn`, CDP's
// `CSS.getPlatformFontsForNode`), never the computed `font-family` string — that
// only says what the stylesheet asked for. `only` defaults to the faces named,
// so a system fallback (Georgia, Rockwell, `cursive`, the OS sans) fails it.
//
// Authoritative signals: a pick waits on its PATCH response, armed before the
// click, and on `<html data-type>` (or the DesignStep section's `data-type`); a
// language change waits on `saveAccountLanguageInSettings` and `<html lang>`; a
// face is polled through CDP. `chapter()` / `beat()` holds are pacing only.

import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { FONT_SET_REGISTRY, FONT_SET_ROLES } from '../../packages/design-system/src/theme/fontSets';
// ↑ The module's source, not the package: the package's `exports` offer only
// an ESM `import` condition, which Playwright's CommonJS loader cannot resolve.
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';
import { msg, saveAccountLanguageInSettings, type Locale } from './_helpers/i18n-walk';
import {
  DEFAULT_PAIRING,
  PAIRING_FACES,
  PAIRING_NAMES,
  cdpFor,
  expectDrawnIn,
  inject,
  registryFaces,
} from './_helpers/font-probe';

const { defaultFace } = registryFaces(FONT_SET_REGISTRY, FONT_SET_ROLES);

const USER_A = 'e2e-type-pairings-a@example.com';
const USER_B = 'e2e-type-pairings-b@example.com';
const APPEARANCE_URL = '/settings/account/appearance';
const NEW_PAIRINGS = ['marker', 'rounded', 'slab', 'humanist'] as const;
/** Pairings that keep the Inter body (display-only); the others re-type body/UI too. */
const DISPLAY_ONLY = new Set<string>(['marker', 'slab']);

const html = (page: Page): Locator => page.locator('html');
const typePicker = (scope: Page | Locator): Locator =>
  scope.getByRole('radiogroup', { name: msg('en', 'settings.appearance.type.name'), exact: true });
const appearanceHeadline = (page: Page): Locator =>
  page
    .getByRole('main')
    .getByRole('heading', { name: msg('en', 'settings.appearance.heading'), exact: true });

/**
 * The onboarding Design step's root `section[data-testid="design-page"]`, reached by its
 * region role so the accessibility tree scopes it to the live copy, not a streamed one.
 */
const designRegion = (page: Page): Locator =>
  page.getByRole('region', { name: msg('en', 'onboarding.design.title'), exact: true });

/** The raw server document's `<html …>` opening tag — what the first byte carries. */
async function serverHtmlTag(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  expect(res.ok()).toBe(true);
  const markup = await res.text();
  const open = markup.indexOf('<html');
  expect(open).toBeGreaterThanOrEqual(0);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

/** Pick one radio on Appearance and assert the PATCH 200 body and `<html>` attribute. */
async function pick(
  page: Page,
  group: string,
  option: string,
  prefKey: 'typeId' | 'styleId',
  value: string,
  attr: 'data-type' | 'data-style',
): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: group, exact: true })
    .getByRole('radio', { name: option, exact: true })
    .click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { preference: Record<string, string> };
  expect(body.preference[prefKey]).toBe(value);
  await expect(html(page)).toHaveAttribute(attr, value);
}

async function pickType(page: Page, typeId: string): Promise<void> {
  await pick(
    page,
    msg('en', 'settings.appearance.type.name'),
    PAIRING_NAMES[typeId]!,
    'typeId',
    typeId,
    'data-type',
  );
}

/** Save the account's language unless the page already shows it. */
async function setAccountLanguage(page: Page, locale: Locale): Promise<void> {
  await page.goto('/settings/account/language');
  if ((await html(page).getAttribute('lang')) === locale) return;
  await saveAccountLanguageInSettings(page, locale);
}

/** One probe row per role, each forced to that role's token. */
async function roleProbe(page: Page, text: (role: string) => string): Promise<Locator> {
  return inject(
    page,
    FONT_SET_ROLES.map(
      (role) =>
        `<div data-role="${role}" style="font-family:var(--font-${role});font-size:24px">${text(role)}</div>`,
    ).join(''),
  );
}

/** A tiers-complete web pre-plan read, so the onboarding hub offers the Design step. */
async function stubCompletedPreplan(page: Page): Promise<void> {
  const ISO = '2026-11-06T00:00:00.000Z';
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

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test.describe('four new type pairings', () => {
  test.use({ locale: 'en-US' });

  test('each pairing picks, saves and draws its face; Hand-Drawn defaults to Marker; CJK and an unknown id fall back', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10548');
    test.setTimeout(900_000);
    const cdp = await cdpFor(page);

    // ── 1 ───────────────────────────────────────────────────────────────────
    await chapter('Appearance lists ten pairings, the four new ones last', async () => {
      await signUp(page, USER_A);
      await page.goto(APPEARANCE_URL);
      await expect(appearanceHeadline(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const radios = typePicker(page).getByRole('radio');
      await expect(radios).toHaveCount(10);
      for (const [i, name] of Object.values(PAIRING_NAMES).entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(name);
      }
      await typePicker(page).scrollIntoViewIfNeeded();
      await beat();
    });

    // ── 2 ───────────────────────────────────────────────────────────────────
    for (const typeId of NEW_PAIRINGS) {
      const faces = PAIRING_FACES[typeId]!;
      await chapter(`${PAIRING_NAMES[typeId]}: the headline in ${faces.serif}`, async () => {
        await pickType(page, typeId);
        await expectDrawnIn(cdp, appearanceHeadline(page), { in: [faces.serif] });
        const subtitle = page
          .getByRole('main')
          .getByText(msg('en', 'settings.appearance.subtitle'), { exact: true });
        await expectDrawnIn(cdp, subtitle, { in: [faces.sans] });
        if (DISPLAY_ONLY.has(typeId)) expect(faces.sans).toBe('Inter');
        const probe = await roleProbe(page, (role) => `${role} Hamburgefonstiv 0123`);
        for (const role of FONT_SET_ROLES) {
          await expectDrawnIn(cdp, probe.locator(`[data-role="${role}"]`), { in: [faces[role]] });
        }
        await appearanceHeadline(page).scrollIntoViewIfNeeded();
        await beat();
        await probe.evaluate((el) => el.remove());
      });
    }

    // ── 4 ───────────────────────────────────────────────────────────────────
    for (const typeId of NEW_PAIRINGS) {
      await chapter(`${PAIRING_NAMES[typeId]} on a Japanese page`, async () => {
        // A ja page's Typography lists the Japanese fonts (MOTIR-7736), so the
        // pairing is picked on an English page and the page is read in Japanese.
        await setAccountLanguage(page, 'en');
        await page.goto(APPEARANCE_URL);
        const radio = typePicker(page).getByRole('radio', {
          name: PAIRING_NAMES[typeId],
          exact: true,
        });
        if ((await radio.getAttribute('aria-checked')) !== 'true') await pickType(page, typeId);
        await setAccountLanguage(page, 'ja');
        await page.goto(APPEARANCE_URL);
        await expect(html(page)).toHaveAttribute('lang', 'ja');
        await expect(html(page)).toHaveAttribute('data-type', typeId);
        const probe = await roleProbe(
          page,
          (role) =>
            `<span data-run="latin">${role} Hamburgefonstiv</span> ` +
            `<span data-run="ja">いろはにほへと日本語の書体</span>`,
        );
        for (const role of FONT_SET_ROLES) {
          const row = probe.locator(`[data-role="${role}"]`);
          await expectDrawnIn(cdp, row.locator('[data-run="latin"]'), {
            in: [PAIRING_FACES[typeId]![role]],
          });
          await expectDrawnIn(cdp, row.locator('[data-run="ja"]'), {
            in: [defaultFace('ja', role)],
          });
        }
        await beat();
        await probe.evaluate((el) => el.remove());
      });
    }

    // ── 5 ───────────────────────────────────────────────────────────────────
    await chapter('The onboarding Design step lists the four new pairings', async () => {
      await setAccountLanguage(page, 'en');
      await page.goto('/workbench');
      await createFirstProject(page, 'Type tour');
      await stubCompletedPreplan(page);
      await page.goto('/onboarding/discovery');
      await page.getByRole('button', { name: 'Design your look' }).last().click();
      const designPage = designRegion(page);
      await expect(designPage).toBeVisible({ timeout: FIRST_PAINT_MS });
      const radios = typePicker(designPage).getByRole('radio');
      await expect(radios).toHaveCount(10);
      for (const [i, name] of Object.values(PAIRING_NAMES).entries()) {
        await expect(radios.nth(i)).toHaveAccessibleName(name);
      }
      await typePicker(designPage).scrollIntoViewIfNeeded();
      await beat();
    });

    for (const typeId of NEW_PAIRINGS) {
      await chapter(`Design step: ${PAIRING_NAMES[typeId]} re-types the example`, async () => {
        const designPage = designRegion(page);
        const before = await html(page).getAttribute('data-type');
        await typePicker(designPage)
          .getByRole('radio', { name: PAIRING_NAMES[typeId], exact: true })
          .click();
        await expect(designPage).toHaveAttribute('data-type', typeId);
        // The example window's project name is set in the headline (serif) role.
        const exampleHeadline = designPage.getByText('Acme', { exact: true });
        await expectDrawnIn(cdp, exampleHeadline, { in: [PAIRING_FACES[typeId]!.serif] });
        // The step designs the user's project, not Motir.
        expect(await html(page).getAttribute('data-type')).toBe(before);
        await beat();
      });
    }

    // ── 6 ───────────────────────────────────────────────────────────────────
    await chapter('An unknown stored type id falls back to Motir', async () => {
      const user = await adminDb.user.findUniqueOrThrow({ where: { email: USER_A } });
      await adminDb.userAppearancePreference.update({
        where: { userId: user.id },
        data: { typeId: 'nope' },
      });
      const tag = await serverHtmlTag(page.request, APPEARANCE_URL);
      expect(tag).toContain('data-type="motir"');
      expect(tag).not.toContain('data-type="nope"');
      await page.goto(APPEARANCE_URL);
      await expect(html(page)).toHaveAttribute('data-type', 'motir');
      await expectDrawnIn(cdp, appearanceHeadline(page), { in: [DEFAULT_PAIRING.serif] });
      await beat();
    });

    // ── 3 ───────────────────────────────────────────────────────────────────
    await chapter('A fresh user picks Hand-Drawn / Indie and gets Marker', async () => {
      // A second person, who has never pinned a type. The browser's own cache
      // of the first person's look goes with their session.
      await page.context().clearCookies();
      await page.evaluate(() => window.localStorage.clear());
      await signUp(page, USER_B);
      await page.goto(APPEARANCE_URL);
      await expect(appearanceHeadline(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await pick(
        page,
        msg('en', 'settings.appearance.style.name'),
        'Hand-Drawn / Indie',
        'styleId',
        'hand-drawn-indie',
        'data-style',
      );
      await expect(html(page)).toHaveAttribute('data-type', 'marker');
      const user = await adminDb.user.findUniqueOrThrow({ where: { email: USER_B } });
      const row = await adminDb.userAppearancePreference.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(row.styleId).toBe('hand-drawn-indie');
      expect(row.typeId, 'the type stays unpinned').toBeNull();
      await expectDrawnIn(cdp, appearanceHeadline(page), { in: ['Caveat'] });
      await beat();
    });

    await chapter('A pinned Grotesk wins over the Hand-Drawn default', async () => {
      await pickType(page, 'grotesk');
      await expect(html(page)).toHaveAttribute('data-style', 'hand-drawn-indie');
      await expectDrawnIn(cdp, appearanceHeadline(page), {
        in: [PAIRING_FACES.grotesk!.serif],
        never: ['Caveat'],
      });
      await beat();
    });
  });
});
