// ACCEPTANCE: every onboarding screen looks and sounds like motir.co (Story
// MOTIR-8238 · MOTIR-8257).
//
// A brand-new account walks the assembled onboarding in a real browser against
// the production build, twice — once in ENGLISH in the LIGHT theme, once in
// CHINESE in the DARK theme — and the two clips are the story's receipt:
//
//   entrance → how-it-works → back → idea → discovery → a direction doc,
//   then entrance → the import door → the migrate wizard → the importer.
//
// On every screen the walk asserts what the story promises a person SEES — the
// Motir lockup (the wave-band glyph and the "Motir" wordmark), no Sparkles
// stand-in, no "Plan with AI" voice, the new headline from the run's catalogue,
// and, on the four page-shaped screens, a full-width hero instead of the old
// centred card — and what it promises does NOT change: the same steps lead to
// the same places.
//
// ⚠️ EVERY EXPECTED STRING IS READ FROM `messages/<locale>.json` AT RUN TIME
// (`_helpers/i18n-walk.ts`'s `msg`). A catalogue edit cannot turn this red; a
// screen in the wrong language does.
//
// ── DETERMINISM, BY PROCESS ──────────────────────────────────────────────────
// The app runs in its own `next start`, so every external boundary is stubbed
// on the BROWSER side (`_helpers/onboarding-stubs.ts`):
//   * motir-ai (the discovery chat + pre-plan read) — `stubDiscoveryApi`;
//   * the migrate run (start, advance, index status) — `stubMigrateRoutes`;
//   * the importer's vendors are never called: the walk only views Connect.
// The direction-doc page reads the pre-plan SERVER-side, which no browser stub
// reaches and this lane has no motir-ai mock for, so it renders its own
// unavailable state; what this walk asserts there is the page's frame — the
// brand row and the doc column — which is what the story changed.
//
// ── CLOUD POSTURE ────────────────────────────────────────────────────────────
// This lane is cloud-on, and a fresh organization reads as FREE, so discovery
// would film the AI paywall instead of the canvas. Each test therefore gives
// the new account's organization a paid AI plan in the lane's billing fixture
// (`setOrgBillingState`) right after sign-up, and asserts the canvas.
//
// ── SIGNALS ──────────────────────────────────────────────────────────────────
// Every navigation waits on a URL, a stubbed response armed before the action,
// or a first landmark within `FIRST_PAINT_MS` (CLAUDE.md). The holds inside
// `chapter()` / `beat()` are pacing for the viewer, never a wait.

import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { msg, signUpHere } from './_helpers/i18n-walk';
import { paidOrgState, setOrgBillingState } from './_helpers/billing';
import { stubDiscoveryApi, stubMigrateRoutes } from './_helpers/onboarding-stubs';
import {
  HERO_SCREENS,
  RETIRED_VOICE_ZH,
  expectFullWidthHero,
  expectHeadline,
  brandBar,
  expectLockup,
  expectNoStandInOrRetiredVoice,
  type HeroScreen,
} from './_helpers/onboarding-vibe';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';

test.describe.configure({ timeout: 240_000 });

const PASSWORD = 'onboarding-vibe-e2e-9';
const IDEA = 'A booking app for a hair salon where clients pick a stylist and a time.';

const screen = (name: HeroScreen['name']) => HERO_SCREENS.find((s) => s.name === name)!;

test.afterAll(async () => {
  await adminDb.$disconnect();
});

interface Run {
  locale: 'en' | 'zh';
  tag: string;
  theme: 'light' | 'dark';
  label: string;
}

const RUNS: Run[] = [
  { locale: 'en', tag: 'en-US', theme: 'light', label: 'English, light' },
  { locale: 'zh', tag: 'zh-CN', theme: 'dark', label: 'Chinese, dark' },
];

/** The new account's organization, given a paid AI plan so discovery shows the canvas. */
async function grantAi(email: string): Promise<{ projectId: string }> {
  const user = await adminDb.user.findFirstOrThrow({ where: { email } });
  const owner = await adminDb.organizationMembership.findFirstOrThrow({
    where: { userId: user.id, role: ORGANIZATION_ROLE.owner },
  });
  setOrgBillingState(owner.organizationId, paidOrgState());
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id, activeProjectId: { not: null } },
  });
  return { projectId: membership.activeProjectId! };
}

/** The `<html>` facts every screen carries: the language and the resolved theme. */
async function expectDocument(page: Page, run: Run): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${run.locale}`));
  await expect(page.locator('html')).toHaveAttribute('data-theme', run.theme);
}

async function expectHeroScreen(page: Page, run: Run, s: HeroScreen) {
  const where = `${s.name} (${run.label})`;
  const band = await expectHeadline(page, run.locale, s);
  await expectLockup(brandBar(page), where);
  await expectNoStandInOrRetiredVoice(
    page,
    where,
    run.locale === 'zh' ? RETIRED_VOICE_ZH : undefined,
  );
  await expectFullWidthHero(page, band, where);
  await expectDocument(page, run);
  return band;
}

for (const run of RUNS) {
  test.describe(run.label, () => {
    test.use({ locale: run.tag, colorScheme: run.theme, viewport: { width: 1280, height: 720 } });

    test(`a new sign-up walks every onboarding screen — ${run.label}`, async ({
      page,
      chapter,
      beat,
      acceptanceStory,
    }) => {
      acceptanceStory('MOTIR-8238');
      const { locale } = run;
      const t = (key: string) => msg(locale, key);
      const email = `vibe-${locale}-${Date.now()}@example.com`;
      let projectId = '';

      await resetDatabase();
      // The entrance's idea is sent as discovery's first turn; a reply alone
      // keeps the hub on screen rather than the last tier's review.
      await stubDiscoveryApi(page, { produceTiers: false });
      const migrate = await stubMigrateRoutes(page);
      // The stubbed repositories are indexed from the start, so the wizard's
      // Index step opens with its Next control enabled.
      migrate.completeIndex();

      await chapter(`The entrance — ${run.label}`, async () => {
        await page.goto('/sign-up');
        await signUpHere(page, email, PASSWORD);
        ({ projectId } = await grantAi(email));
        const band = await expectHeroScreen(page, run, screen('entrance'));
        // The idea box is the hero's control; the import door is the idea card's
        // last row, inside the hero (MOTIR-8935).
        const idea = band.getByRole('textbox', { name: t('onboarding.entrance.ideaLabel') });
        await expect(idea).toBeVisible();
        const start = band.getByRole('button', { name: t('onboarding.entrance.startCta') });
        await expect(start).toBeVisible();
        const importProject = band.getByRole('link', {
          name: t('onboarding.entrance.importProject'),
          exact: true,
        });
        await expect(importProject).toBeVisible();
        await expect(band.getByText(t('onboarding.entrance.importTitle'))).toBeVisible();
        const startBox = (await start.boundingBox())!;
        const importBox = (await importProject.boundingBox())!;
        expect(importBox.y).toBeGreaterThanOrEqual(startBox.y + startBox.height - 1);
      });

      await chapter(`How Motir works, and back — ${run.label}`, async () => {
        // The entrance opens the explainer in a NEW TAB; a new tab is not on
        // this recording, so the walk follows the same address in this one.
        const how = page.getByRole('link', {
          name: new RegExp(t('onboarding.entrance.howItWorks')),
        });
        await expect(how).toHaveAttribute('href', '/onboarding/how-it-works');
        await page.goto('/onboarding/how-it-works');
        await page.waitForURL('**/onboarding/how-it-works');
        await expectHeroScreen(page, run, screen('how-it-works'));
        for (const section of ['say', 'watch', 'decide']) {
          await expect(
            page.getByRole('heading', {
              level: 2,
              name: t(`onboarding.howItWorks.sections.${section}.title`),
              exact: true,
            }),
          ).toBeVisible();
        }
        await page.getByRole('link', { name: t('onboarding.howItWorks.back') }).click();
        await page.waitForURL((url) => url.pathname === '/onboarding');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          t('onboarding.entrance.headingDefault'),
        );
      });

      await chapter(`The idea goes into discovery — ${run.label}`, async () => {
        const box = page.getByRole('textbox', { name: t('onboarding.entrance.ideaLabel') });
        await box.fill(IDEA);
        await beat();
        if (locale === 'zh') {
          // The keyboard submit, on this run's pass of the entrance.
          await box.press('Control+Enter');
        } else {
          await page.getByRole('button', { name: t('onboarding.entrance.startCta') }).click();
        }
        await page.waitForURL('**/onboarding/discovery');
        const bar = page.getByRole('banner', { name: t('onboarding.chat.topbarLabel') });
        await expectLockup(bar, `discovery (${run.label})`);
        const canvas = page.getByRole('application', { name: t('onboarding.chat.canvas.title') });
        const rail = page.getByRole('complementary', { name: t('onboarding.chat.railLabel') });
        await expect(canvas).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(rail).toBeVisible();
        await expect(
          rail.getByRole('textbox', { name: t('onboarding.chat.composerPlaceholder') }),
        ).toBeEnabled();
        const c = (await canvas.boundingBox())!;
        const r = (await rail.boundingBox())!;
        // Side by side: the rail starts where the canvas ends, not under it.
        expect(Math.abs(c.y - r.y)).toBeLessThan(c.height);
        await expectNoStandInOrRetiredVoice(
          page,
          `discovery (${run.label})`,
          locale === 'zh' ? RETIRED_VOICE_ZH : undefined,
        );
        await expectDocument(page, run);
      });

      await chapter(`A direction doc, under the brand row — ${run.label}`, async () => {
        // The tier modal's "open full page" opens this address in a new tab.
        await page.goto('/onboarding/direction/vision');
        const row = page.locator('[data-onboarding-brand-bar]');
        await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expectLockup(row, `the direction doc (${run.label})`);
        // The doc renders in its own column, right under the brand row.
        const column = row.locator('xpath=..');
        await expect(column).toHaveClass(/max-w-\[60rem\]/);
        await expect(row.locator('xpath=following-sibling::*[1]')).toBeVisible();
        await expectNoStandInOrRetiredVoice(
          page,
          `the direction doc (${run.label})`,
          locale === 'zh' ? RETIRED_VOICE_ZH : undefined,
        );
        await expectDocument(page, run);
      });

      await chapter(`The import door opens the migrate wizard — ${run.label}`, async () => {
        await page.goto('/onboarding');
        const started = page.waitForResponse(
          (r) => r.url().endsWith('/api/onboarding/migrate') && r.request().method() === 'POST',
        );
        await page
          .getByRole('link', { name: t('onboarding.entrance.importProject'), exact: true })
          .click();
        await page.waitForURL('**/onboarding/migrate');
        // One project: the run starts on arrival and opens on Connect.
        expect((await started).status()).toBe(200);
        await expectHeroScreen(page, run, screen('migrate'));
        await expect(
          page.getByRole('navigation', { name: t('onboardingMigrate.rail.title') }),
        ).toBeVisible();
        const saveExit = page.getByRole('link', { name: t('onboardingMigrate.common.saveExit') });
        const expected =
          onboardingReturnHref(new URL(page.url()).searchParams, 'abandoned') ?? '/roadmap';
        await expect(saveExit).toHaveAttribute('href', expected);
      });

      await chapter(
        `Connect, index, then the importer opened at its own address — ${run.label}`,
        async () => {
          const advanced = () =>
            page.waitForResponse(
              (r) => r.url().includes('/advance') && r.request().method() === 'POST',
            );
          let resp = advanced();
          await page.getByRole('button', { name: t('onboardingMigrate.connect.continue') }).click();
          expect((await resp).status()).toBe(200);
          const next = page.getByRole('button', { name: t('onboardingMigrate.index.next') });
          await expect(next).toBeEnabled({ timeout: 15_000 });
          resp = advanced();
          await next.click();
          expect((await resp).status()).toBe(200);
          await expect(
            page.getByRole('heading', { name: t('onboardingMigrate.import.heading') }),
          ).toBeVisible();
          // The Import step runs the importer inline now; the importer's own page
          // is the same flow at its own address, opened here for the project.
          await page.goto(`/onboarding/import?projectId=${projectId}`);
          await page.waitForURL('**/onboarding/import**');
          await expectHeroScreen(page, run, screen('importer'));
          const steps = page.getByRole('list', { name: t('import.chrome.title') });
          await expect(steps).toBeVisible();
          await expect(steps).toContainText(t('import.steps.connect'));
        },
      );
    });
  });
}
