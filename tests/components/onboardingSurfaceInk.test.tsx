// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  DEFAULT_INKS,
  findInkContrastFailures,
  formatRenderedFinding,
  measuredInkSites,
  type Theme,
} from '../helpers/renderedInkContrast';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import enMessages from '@/messages/en.json';

// MOTIR-8256 (Story MOTIR-8238's integration gate), case 3 — the restyled
// onboarding surface, measured in EVERY palette × theme. The two design cards
// (MOTIR-8250, MOTIR-8251) drew the default Motir palette only and named each
// element's `--el-*` role so that this run would have something to read: the
// render-time ink guard (`renderedInkContrast`, MOTIR-4251) resolves each ink's
// surface from the composed DOM and measures the pair in the palette asked for.
//
// Every case also asserts the mount MEASURED something (`measuredInkSites`), so
// a refactor that stops rendering the text cannot pass as clean.
//
// The Wave (`<Background>`) is a canvas: `aria-hidden`, no text, so it carries no ink to
// measure. It is asserted `aria-hidden` and otherwise left alone.
//
// The migrate wizard and the importer: their frame is covered — the wizard bar,
// the compact hero with the `onboardingMigrate.hero` / `import.hero` strings and
// a work section — rather than the fetch-driven panels, which their own suites
// (`migrateWizardOnePage.test.tsx`) drive. Contrast is measured in English:
// ink roles do not change by locale.

const { startPlanningAction } = vi.hoisted(() => ({
  startPlanningAction: vi.fn(async (_form: FormData) => {}),
}));
vi.mock('@/app/(onboarding)/onboarding/actions', () => ({ startPlanningAction }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => ({ user: { id: 'u1', email: 'a@example.com', name: 'A' } })),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/onboarding',
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

import {
  OnboardingBrandBar,
  OnboardingHero,
  OnboardingSection,
  OnboardingWizardBar,
  OnboardingWorkBand,
} from '@/components/onboarding/layout';
import { OnboardingTopBar } from '@/components/onboarding/OnboardingTopBar';
import { OnboardingEntrance } from '@/components/onboarding/OnboardingEntrance';
import OnboardingHowItWorksPage from '@/app/(onboarding)/onboarding/how-it-works/page';

afterEach(() => {
  cleanup();
});

const THEMES: readonly Theme[] = ['light', 'dark'];

/**
 * The inks measured: the guard's defaults (muted, faint, secondary) AND the body
 * and accent inks. Those clear AA in the base palette, but this run is about the
 * OTHER palettes, where nothing has measured them on these surfaces before.
 */
const INKS = [
  ...DEFAULT_INKS,
  '--el-text',
  '--el-text-strong',
  '--el-accent-on-surface',
  '--el-danger-on-surface',
  '--el-link',
] as const;

/** Mount `ui` once, then sweep it in every palette × theme. */
function sweep(ui: ReactElement) {
  const { container } = renderWithIntl(ui);
  const roots = [container, document.body];
  expect(measuredInkSites(roots, { inks: INKS }).length).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const palette of PALETTE_IDS) {
    for (const theme of THEMES) {
      for (const f of findInkContrastFailures(roots, { palette, theme, inks: INKS })) {
        failures.push(formatRenderedFinding(f));
      }
    }
  }
  return { container, failures };
}

const migrate = enMessages.onboardingMigrate;
const importer = enMessages.import;

const SURFACES: Array<[string, () => ReactElement | Promise<ReactElement>]> = [
  [
    'OnboardingBrandBar with a trailing control',
    () => (
      <OnboardingBrandBar lead={<span className="text-sm text-(--el-text-secondary)">· Flow</span>}>
        <span className="text-sm text-(--el-text-secondary)">control</span>
      </OnboardingBrandBar>
    ),
  ],
  [
    'OnboardingHero with a control child',
    () => (
      <OnboardingHero headline="Vibe the project" lede="Say what you are building." controlId="c">
        <input aria-label="idea" />
      </OnboardingHero>
    ),
  ],
  [
    'OnboardingSection',
    () => <OnboardingSection title="Say it" lede="Tell Motir what you are building." />,
  ],
  [
    'OnboardingTopBar',
    () => (
      <OnboardingTopBar
        projectName="Quiet Harbor"
        stepLabel="Setting your direction"
        onExit={() => {}}
      />
    ),
  ],
  ['OnboardingEntrance, default', () => <OnboardingEntrance carriedIdea={null} />],
  [
    'OnboardingEntrance, carried idea',
    () => <OnboardingEntrance carriedIdea="A leave tracker for a small team" />,
  ],
  ['the how-it-works page', () => OnboardingHowItWorksPage()],
  [
    'the migrate wizard frame',
    () => (
      <>
        <OnboardingWizardBar flowName={migrate.brandBar.flowName} userInitial="Y">
          <span className="text-sm text-(--el-text-secondary)">{migrate.common.saveExit}</span>
        </OnboardingWizardBar>
        <OnboardingHero
          headline={migrate.hero.headline}
          lede={migrate.hero.lede}
          compact
          brandBar={false}
        />
        <OnboardingWorkBand>
          <p className="text-sm text-(--el-text-secondary)">{migrate.connect.body}</p>
        </OnboardingWorkBand>
      </>
    ),
  ],
  [
    'the importer frame',
    () => (
      <>
        <OnboardingWizardBar flowName={importer.chrome.title} userInitial="Y" />
        <OnboardingHero
          headline={importer.hero.headline}
          lede={importer.hero.lede}
          compact
          brandBar={false}
        />
        <OnboardingWorkBand>
          <p className="text-sm text-(--el-text-secondary)">{importer.chrome.title}</p>
        </OnboardingWorkBand>
      </>
    ),
  ],
];

describe('the restyled onboarding surface clears AA in every palette and theme', () => {
  it('measures a real palette list', () => {
    expect(PALETTE_IDS.length).toBeGreaterThan(1);
  });

  for (const [name, make] of SURFACES) {
    it(name, async () => {
      const { container, failures } = sweep(await make());
      expect(failures, failures.join('\n')).toEqual([]);
      // The waves canvas, where drawn, is decorative and carries no text.
      for (const canvas of Array.from(container.querySelectorAll('canvas'))) {
        expect(canvas.closest('[aria-hidden="true"]')).not.toBeNull();
      }
    });
  }
});
