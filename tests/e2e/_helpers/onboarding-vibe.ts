import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { msg } from './i18n-walk';

// The wave-band path, read from `design/brand/wave-band-24.svg` — the file
// `tests/brand/waveBand.test.ts` pins `WAVE_BAND_PATH` to byte for byte.
// `@motir/brand` itself exports ESM only, which Playwright's CommonJS
// transform cannot `require`.
const WAVE_BAND_PATH = /\sd="([^"]+)"/.exec(
  readFileSync(join(process.cwd(), 'design', 'brand', 'wave-band-24.svg'), 'utf8'),
)![1]!;

// The assertions the onboarding-vibe walk makes on EVERY screen (Story
// MOTIR-8238 · MOTIR-8257), shared by the acceptance walk
// (`regression-onboarding-vibe.spec.ts`) and the nine-language sweep
// (`onboarding-locale-sweep.spec.ts`), so the two cannot disagree about what
// "the lockup is there" means.

/** The retired AI-first voice, in English — the story's own pattern. */
export const RETIRED_VOICE_EN = /Plan with AI|Build with AI|AI[- ]?planning|AI[- ]first/i;
/** …and in Chinese, for the zh run. */
export const RETIRED_VOICE_ZH = /用 ?AI ?(规划|构建)|AI ?优先/;

/** The four page-shaped screens and the catalogue key of each one's headline. */
export const HERO_SCREENS = [
  { name: 'entrance', path: '/onboarding', headline: 'onboarding.entrance.headingDefault' },
  {
    name: 'how-it-works',
    path: '/onboarding/how-it-works',
    headline: 'onboarding.howItWorks.title',
  },
  { name: 'migrate', path: '/onboarding/migrate', headline: 'onboardingMigrate.hero.headline' },
  { name: 'importer', path: '/onboarding/import', headline: 'import.hero.headline' },
] as const;

export type HeroScreen = (typeof HERO_SCREENS)[number];

/**
 * The screen's brand bar (`OnboardingBrandBar`). Not `getByRole('banner')`: on
 * the entrance and How Motir works the bar's `<header>` sits inside the hero's
 * `<section>`, where it carries no banner role.
 */
export function brandBar(page: Page): Locator {
  return page.locator('[data-onboarding-brand-bar]').first();
}

/** The `BrandMark` lockup inside `scope`: the wave-band glyph and the "Motir" wordmark. */
export async function expectLockup(scope: Locator, where: string): Promise<void> {
  const lockup = scope.locator('.brand-lockup').first();
  await expect(lockup, `the lockup on ${where}`).toBeVisible();
  await expect(lockup.locator('svg path').first()).toHaveAttribute('d', WAVE_BAND_PATH);
  await expect(lockup.locator('.brand-word')).toHaveText('Motir');
}

/** No Sparkles stand-in anywhere on the page, and no retired voice in its text. */
export async function expectNoStandInOrRetiredVoice(
  page: Page,
  where: string,
  extra?: RegExp,
): Promise<void> {
  await expect(page.locator('svg.lucide-sparkles'), `a Sparkles icon on ${where}`).toHaveCount(0);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text, `the retired voice on ${where}`).not.toMatch(RETIRED_VOICE_EN);
  if (extra) expect(text, `the retired voice on ${where}`).not.toMatch(extra);
}

/** The hero band holding the screen's headline (a `region` named by its `h1`). */
export function heroBand(page: Page, locale: string, screen: HeroScreen): Locator {
  return page.getByRole('region', { name: msg(locale, screen.headline), exact: true });
}

/** The headline equals the catalogue value, and its band is the hero. */
export async function expectHeadline(page: Page, locale: string, screen: HeroScreen) {
  const band = heroBand(page, locale, screen);
  await expect(band.getByRole('heading', { level: 1 })).toHaveText(msg(locale, screen.headline));
  await expect(band).toHaveAttribute('data-onboarding-hero', /full|compact/);
  return band;
}

/**
 * The hero is full width and the headline sits in no centred card: the band
 * spans ≥ 90% of the viewport, and no ancestor of the `h1` carries the old
 * column's `max-w-[41.25rem]` / `max-w-[64rem]`.
 */
export async function expectFullWidthHero(page: Page, band: Locator, where: string) {
  const box = await band.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `the hero band's box on ${where}`).not.toBeNull();
  expect(box!.width, `the hero band's width on ${where}`).toBeGreaterThanOrEqual(
    viewport!.width * 0.9,
  );
  const centred = await band.getByRole('heading', { level: 1 }).evaluate((h) => {
    const hits: string[] = [];
    for (let el = h.parentElement; el; el = el.parentElement) {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('max-w-[41.25rem]') || cls.includes('max-w-[64rem]')) hits.push(cls);
    }
    return hits;
  });
  expect(centred, `a centred-card ancestor of the headline on ${where}`).toEqual([]);
}
