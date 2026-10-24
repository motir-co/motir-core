// The onboarding vibe, in the nine newer languages (Story MOTIR-8238 ·
// MOTIR-8257).
//
// The acceptance walk (`regression-onboarding-vibe.spec.ts`) films English and
// Chinese. This sweep is the regression half for the other nine: one account,
// switched into each language in turn, visits the four page-shaped onboarding
// screens — the entrance, How Motir works, the migrate wizard and the importer —
// and on each one asserts that
//
//   * the document is in that language (`<html lang>`);
//   * the Motir lockup is in the top bar, and no Sparkles stand-in is anywhere;
//   * the headline is the catalogue's value for that language, and that value
//     is not the English one — unless it is the brand phrase motir.co keeps in
//     English everywhere (`KEEP_ENGLISH_HEADLINES` below, the same allowance
//     `tests/i18n/onboardingVoice.test.ts` grants);
//   * the retired English AI-first voice appears nowhere on the page.
//
// ⚠️ EVERY EXPECTED STRING IS READ FROM `messages/<locale>.json` AT RUN TIME.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
// The language is the account's SAVED language (`user.locale`), which outranks
// both the cookie and the browser (`lib/i18n/resolveLocale.ts`) and is read per
// request, so each test sets it and opens a fresh context with the stored
// session — no sign-in per language. The migrate run is stubbed on the browser
// side (`_helpers/onboarding-stubs.ts`), so nothing here waits on motir-ai. Every
// navigation waits on its URL and the headline; there is no fixed timeout.

import { expect, test, type BrowserContext } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { htmlLang, msg, NEW_LOCALES, signUpHere } from './_helpers/i18n-walk';
import { stubMigrateRoutes } from './_helpers/onboarding-stubs';
import {
  HERO_SCREENS,
  expectHeadline,
  brandBar,
  expectLockup,
  expectNoStandInOrRetiredVoice,
  type HeroScreen,
} from './_helpers/onboarding-vibe';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

/** Headlines every language keeps in English: the brand phrase, by design. */
const KEEP_ENGLISH_HEADLINES: ReadonlySet<string> = new Set(['onboarding.entrance.headingDefault']);

const EMAIL = `locale-sweep-${Date.now()}@example.com`;
const PASSWORD = 'onboarding-sweep-e2e-9';

let storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
let userId = '';
let projectId = '';

test.beforeAll(async ({ browser }) => {
  await resetDatabase();
  const context = await browser.newContext({ locale: 'en-US' });
  await signUpHere(await context.newPage(), EMAIL, PASSWORD);
  storageState = await context.storageState();
  await context.close();
  const user = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
  userId = user.id;
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId, activeProjectId: { not: null } },
  });
  projectId = membership.activeProjectId!;
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

function pathOf(screen: HeroScreen): string {
  return screen.name === 'importer' ? `${screen.path}?projectId=${projectId}` : screen.path;
}

for (const locale of NEW_LOCALES) {
  test(`every onboarding hero speaks ${locale}`, async ({ browser }) => {
    await adminDb.user.update({ where: { id: userId }, data: { locale } });
    const context = await browser.newContext({ locale, storageState });
    const page = await context.newPage();
    await stubMigrateRoutes(page);

    for (const screen of HERO_SCREENS) {
      const where = `${screen.name} (${locale})`;
      await page.goto(pathOf(screen));
      await page.waitForURL((url) => url.pathname === screen.path);
      await expectHeadline(page, locale, screen);
      expect(await htmlLang(page), `the document language on ${where}`).toMatch(
        new RegExp(`^${locale}`),
      );
      await expectLockup(brandBar(page), where);
      await expectNoStandInOrRetiredVoice(page, where);

      const headline = msg(locale, screen.headline);
      if (KEEP_ENGLISH_HEADLINES.has(screen.headline)) {
        expect(headline, `the brand phrase on ${where}`).toBe(msg('en', screen.headline));
      } else {
        expect(headline, `the headline on ${where} is still English`).not.toBe(
          msg('en', screen.headline),
        );
      }
    }

    await context.close();
  });
}
