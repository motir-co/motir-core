// ACCEPTANCE: app.motir.co in eleven languages (Story MOTIR-7730 · MOTIR-7761).
//
// The assembled language journey, as a person meets it in a browser, recorded
// as the story's receipt — Verification steps 1–8:
//
//   1. a Japanese browser's first visit is in Japanese, with no cookie needed;
//      a browser asking for a language Motir does not offer gets English;
//   2. a German browser that chooses nothing signs up and its new account is
//      German — onboarding, the app and Settings → Language alike — and the
//      list offers the eleven languages, each in its own script;
//   3. choosing 한국어 in Settings turns the page Korean IN PLACE (no reload);
//   4. that saved language follows the person to a French browser, survives a
//      sign-out there, and every main surface is Korean with local dates;
//   5. a Korean choice made on a signed-out page carries through a Google
//      sign-up into the new account, though the browser asks for English.
//
// Each case is its own short test, so each clip stays inside the lane's budget
// (`playwright.acceptance.config.ts`).
//
// ⚠️ THE BROWSER'S LANGUAGE IS A CONTEXT'S `locale`, which sets both
// `Accept-Language` and `navigator.language` — the real signal the request
// config reads. No header is injected by hand. A context's language is fixed at
// creation, so a case that needs a SECOND browser opens one with
// `browser.newContext({ locale })`. Such a context is not recorded (only the
// test's own `page` is), so each test keeps its headline browser on the
// recorded `page` and says in a chapter what the second one proved.
//
// ⚠️ EVERY EXPECTED STRING IS READ FROM `messages/<locale>.json` AT RUN TIME
// (`_helpers/i18n-walk.ts`). The only literal translated text in this file is
// the eleven endonyms, which are what the story's criterion names.
//
// Authoritative signals throughout (CLAUDE.md): a language choice waits on the
// `setLocale` server-action response, armed before the click, and then on the
// re-rendered `<html lang>`; a sign-in waits on the rendered landing. The holds
// inside `chapter()` / `beat()` are pacing for the viewer, never a wait.

import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { isLandedWorkbenchUrl } from './_helpers/workbench-landing';
import {
  chooseLanguage,
  dropSessionCookie,
  localeCookie,
  localeLabel,
  locales,
  msg,
  newLocaleContext,
  saveAccountLanguageInSettings,
  seedOwnProject,
  settingsLanguageControl,
  signInHere,
  signUpHere,
  visitSurface,
  walkSurfaces,
  type Locale,
} from './_helpers/i18n-walk';

const PASSWORD = 'eleven-languages-e2e-9';

/** The eleven endonyms, in the order the language controls list them. */
const ENDONYMS = [
  'English',
  '中文',
  '日本語',
  '한국어',
  'Deutsch',
  'Français',
  'Español',
  'Italiano',
  'Nederlands',
  'Polski',
  'Português',
];

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** The signed-out language control, scoped to the `(auth)` frame's banner. */
function authLanguageControl(page: Page, lang: Locale) {
  return page.getByRole('banner').getByRole('combobox', {
    name: msg(lang, 'auth.language.label', { language: localeLabel[lang] }),
  });
}

/** The credential card's heading. */
function cardHeading(page: Page) {
  return page.getByRole('main').getByRole('heading', { level: 1 });
}

/** Open a language Combobox and check its eleven options, in order, each with its own `lang`. */
async function expectElevenOptions(page: Page, selected: Locale): Promise<void> {
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options).toHaveText(ENDONYMS);
  for (const [i, locale] of locales.entries()) {
    await expect(options.nth(i)).toHaveAttribute('lang', locale);
    await expect(options.nth(i)).toHaveAttribute('aria-selected', String(locale === selected));
  }
}

async function closeListbox(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
}

// ── 1 + 2 ───────────────────────────────────────────────────────────────────

test.describe('first visit', () => {
  test.use({ locale: 'ja-JP' });

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('a Japanese browser is greeted in Japanese, and an unsupported language in English', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7730');

    await chapter('A Japanese browser opens the sign-in page', async () => {
      // Nothing chosen, nothing saved: the browser's language is the only signal.
      expect(await page.context().cookies(), 'no NEXT_LOCALE cookie before the visit').toEqual([]);
      await page.goto('/sign-in');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(cardHeading(page)).toHaveText(msg('ja', 'auth.welcomeBack'), {
        timeout: FIRST_PAINT_MS,
      });
      await expect(authLanguageControl(page, 'ja')).toBeVisible();
      await beat();
    });

    await chapter('The language control names every language in its own script', async () => {
      await authLanguageControl(page, 'ja').click();
      await expectElevenOptions(page, 'ja');
      await beat();
      await closeListbox(page);
    });

    await chapter(
      'A Swedish browser — a language Motir does not offer — gets English',
      async () => {
        // A second browser: its language is fixed at creation (not recorded).
        const swedish = await newLocaleContext(browser, 'sv-SE');
        const sv = await swedish.newPage();
        await sv.goto('/sign-in');
        await expect(sv.locator('html')).toHaveAttribute('lang', 'en');
        await expect(cardHeading(sv)).toHaveText(msg('en', 'auth.welcomeBack'));
        await swedish.close();
      },
    );
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

test.describe('a German sign-up', () => {
  test.use({ locale: 'de-DE' });
  const EMAIL = 'e2e-eleven-de@example.com';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('a German browser that chooses nothing signs up into a German account', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7730');

    await chapter('A German browser opens the sign-up page, choosing nothing', async () => {
      expect(await page.context().cookies(), 'no cookie, no choice').toEqual([]);
      await page.goto('/sign-up');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(cardHeading(page)).toHaveText(msg('de', 'auth.welcomeToMotir'), {
        timeout: FIRST_PAINT_MS,
      });
      await beat();
    });

    await chapter('They sign up with email and password, and onboarding is German', async () => {
      await signUpHere(page, EMAIL, PASSWORD);
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        msg('de', 'onboarding.entrance.headingDefault'),
      );
      await beat();
    });

    await chapter('The first app page is German', async () => {
      await page.goto('/workbench');
      await page.waitForURL(isLandedWorkbenchUrl);
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(
        page.getByRole('link', { name: msg('de', 'shell.nav.issues'), exact: true }),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
    });

    await chapter('Settings → Language already shows Deutsch', async () => {
      // The first Settings visit IS this check: no cookie was set, no Settings
      // page opened and no database write made before it.
      await page.goto('/settings/account/language');
      await expect(settingsLanguageControl(page, 'de')).toContainText('Deutsch', {
        timeout: FIRST_PAINT_MS,
      });
      const row = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
      expect(row.locale, 'the account language the browser seeded').toBe('de');
      await beat();
    });

    await chapter('The list offers the eleven languages, each in its own script', async () => {
      await settingsLanguageControl(page, 'de').click();
      await expectElevenOptions(page, 'de');
      await beat();
      await closeListbox(page);
    });
  });
});

// ── 4a ──────────────────────────────────────────────────────────────────────

test.describe('the in-place switch', () => {
  test.use({ locale: 'de-DE' });
  const EMAIL = 'e2e-eleven-switch@example.com';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('choosing 한국어 in Settings turns the page Korean without a reload', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7730');

    await chapter('A German account opens Settings → Language', async () => {
      await signUpHere(page, EMAIL, PASSWORD);
      await page.goto('/settings/account/language');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(settingsLanguageControl(page, 'de')).toContainText('Deutsch', {
        timeout: FIRST_PAINT_MS,
      });
      await beat();
    });

    await chapter('They choose 한국어, and the page turns Korean in place', async () => {
      // A full reload would wipe this; a refresh in place keeps it.
      await page.evaluate(() => {
        (window as unknown as { __motirLangProbe?: number }).__motirLangProbe = 1;
      });
      const url = page.url();
      // Waits on the `setLocale` response (armed before the click) and on the
      // re-rendered `<html lang="ko">`.
      await chooseLanguage(page, settingsLanguageControl(page, 'de'), 'ko');
      await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toHaveText(
        msg('ko', 'settings.language.heading'),
      );
      await expect(
        page.getByRole('link', { name: msg('ko', 'settings.account.back') }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => (window as unknown as { __motirLangProbe?: number }).__motirLangProbe,
        ),
        'the page was not reloaded',
      ).toBe(1);
      expect(page.url(), 'the URL is unchanged').toBe(url);
      await beat();
    });

    await chapter('They are still signed in, and the account holds 한국어', async () => {
      await expect(
        page.getByRole('button', { name: msg('ko', 'shell.userMenu.account') }),
      ).toBeVisible();
      await expect(settingsLanguageControl(page, 'ko')).toContainText('한국어');
      const row = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
      expect(row.locale).toBe('ko');
    });
  });
});

// ── 4b ──────────────────────────────────────────────────────────────────────

test.describe('the account follows the person', () => {
  test.use({ locale: 'fr-FR' });
  const EMAIL = 'e2e-eleven-follows@example.com';
  let seed: { itemKey: string; planId: string };

  test.beforeAll(async ({ browser }) => {
    await resetDatabase();
    // The account this test stands on, made the way case 4a makes it: a German
    // sign-up that then chooses 한국어 in Settings. Its project is then seeded
    // with the surfaces the walk opens.
    const german = await newLocaleContext(browser, 'de-DE');
    const de = await german.newPage();
    await signUpHere(de, EMAIL, PASSWORD);
    await saveAccountLanguageInSettings(de, 'ko');
    await german.close();
    seed = await seedOwnProject(EMAIL);
  });

  test('the saved language follows the person to a French browser', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7730');

    await chapter('A French browser with no cookies signs in, and the app is Korean', async () => {
      expect(await page.context().cookies(), 'nothing carried over').toEqual([]);
      await page.goto('/sign-in');
      // Nobody is known yet, so the sign-in page follows the browser.
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await signInHere(page, EMAIL, PASSWORD);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await expect(
        page.getByRole('link', { name: msg('ko', 'shell.nav.issues'), exact: true }),
      ).toBeVisible();
      await beat();
    });

    await chapter('Signed out in that browser, the sign-in page stays Korean', async () => {
      // Sign-in synced this browser's choice to the account.
      expect(await localeCookie(page.context())).toBe('ko');
      await dropSessionCookie(page.context());
      await page.goto('/sign-in');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await expect(cardHeading(page)).toHaveText(msg('ko', 'auth.welcomeBack'));
      await beat();
    });

    await chapter('Signed back in, they open the work item list', async () => {
      await signInHere(page, EMAIL, PASSWORD);
    });

    const [items, item, board, backlog, plan] = walkSurfaces(seed);
    for (const [label, surface] of [
      ['The work item list is Korean', items],
      ['A work item page is Korean, its dates in Korean form', item],
      ['The board is Korean', board],
      ['The backlog is Korean — "Motir" and "Sprint" stay as they are', backlog],
      ['A plan review is Korean', plan],
    ] as const) {
      await chapter(label, async () => {
        await visitSurface(page, surface!, 'ko');
      });
    }
  });
});

// ── 5 ───────────────────────────────────────────────────────────────────────

test.describe('a Korean choice carried into a Google sign-up', () => {
  test.use({ locale: 'en-US' });
  const EMAIL = 'e2e-eleven-google@example.com';
  const GOOGLE_IDENTITY_PATH =
    process.env['E2E_TEST_OAUTH_USER_PATH'] ?? '/tmp/motir-test-oauth-user.json';

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test('a Korean choice made signed out carries through a Google sign-up', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7730');

    // The `auth-google.spec.ts` seam: the hop to accounts.google.com is 302'd
    // straight back to Better-Auth's callback (state echoed), and the server's
    // token-exchange mock returns the identity written to the file below.
    await page.route('**/accounts.google.com/**', async (route) => {
      const url = new URL(route.request().url());
      const callback = new URL(
        url.searchParams.get('redirect_uri') ??
          new URL('/api/auth/callback/google', baseURL).toString(),
      );
      callback.searchParams.set('code', `mock-auth-code-${Date.now()}`);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.set('scope', 'openid email profile');
      await route.fulfill({ status: 302, headers: { location: callback.toString() }, body: '' });
    });

    await chapter('An English browser opens the sign-in page and types an email', async () => {
      await page.goto('/sign-in');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(cardHeading(page)).toHaveText(msg('en', 'auth.welcomeBack'), {
        timeout: FIRST_PAINT_MS,
      });
      await page
        .getByRole('main')
        .getByPlaceholder(msg('en', 'auth.emailAddress'), { exact: true })
        .fill(EMAIL);
      await beat();
    });

    await chapter('They choose 한국어 from the language control, and the email stays', async () => {
      await chooseLanguage(page, authLanguageControl(page, 'en'), 'ko');
      await expect(cardHeading(page)).toHaveText(msg('ko', 'auth.welcomeBack'));
      await expect(
        page.getByRole('main').getByPlaceholder(msg('ko', 'auth.emailAddress'), { exact: true }),
      ).toHaveValue(EMAIL);
      await expect(authLanguageControl(page, 'ko')).toBeVisible();
      expect(await localeCookie(page.context())).toBe('ko');
      await beat();
    });

    await chapter('They continue with Google, and arrive in Korean', async () => {
      await writeFile(
        GOOGLE_IDENTITY_PATH,
        JSON.stringify({
          sub: `google-sub-7761-${Date.now()}`,
          email: EMAIL,
          name: 'Eleven Languages',
          emailVerified: true,
        }),
        'utf8',
      );
      await page
        .getByRole('main')
        .getByRole('button', { name: msg('ko', 'auth.continueWithGoogle'), exact: true })
        .click();
      await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
      await expect(page.getByRole('main').getByTestId('workbench-page')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    });

    await chapter(
      'Settings → Language shows 한국어, though the browser asks for English',
      async () => {
        await page.goto('/settings/account/language');
        await expect(settingsLanguageControl(page, 'ko')).toContainText('한국어', {
          timeout: FIRST_PAINT_MS,
        });
        await settingsLanguageControl(page, 'ko').click();
        await expect(
          page.getByRole('option', { name: localeLabel.ko, exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        await beat();
        await closeListbox(page);
        const row = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
        expect(row.locale, 'the Google-created account holds the carried choice').toBe('ko');
      },
    );
  });
});
