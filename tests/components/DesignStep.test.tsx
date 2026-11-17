// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DesignStep } from '@/components/onboarding/DesignStep';
import { DEFAULT_STYLE_ID, STYLE_IDS, STYLE_REGISTRY } from '@/lib/theme/styles';
import { DEFAULT_PROJECT_PALETTE_ID } from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID } from '@/lib/theme/typography';
import type { DesignChoiceDTO } from '@/lib/dto/aiPreplan';
import { BACKGROUND_IDS, BACKGROUND_REGISTRY } from '@motir/design-system';

// The onboarding design step (Subtask 7.3.27 / MOTIR-1040). It designs the USER'S
// PROJECT: the picks scope to THIS PAGE (the section's data-* attributes) — the
// whole wizard page restyles — but NEVER touch Motir's `<html>`. Local state, no
// global `useTheme`. No jest-dom (project convention) — assertions read DOM
// attributes / text / spy calls directly.

const OTHER_STYLE = STYLE_IDS.find((id) => id !== DEFAULT_STYLE_ID)!;

function renderStep(
  props: {
    onBack?: () => void;
    onUseDesign?: (choice: DesignChoiceDTO) => void;
    initialChoice?: DesignChoiceDTO | null;
  } = {},
) {
  const onBack = props.onBack ?? vi.fn();
  const onUseDesign = props.onUseDesign ?? vi.fn();
  const { container } = renderWithIntl(
    <DesignStep onBack={onBack} onUseDesign={onUseDesign} initialChoice={props.initialChoice} />,
  );
  const page = () => container.querySelector('[data-testid="design-page"]')!;
  return { onBack, onUseDesign, page };
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-style');
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => cleanup());

describe('DesignStep (MOTIR-1040)', () => {
  it('renders the title and all four controls', () => {
    renderStep();
    expect(screen.getByText("Design your project's look")).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Style' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Palette' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Typography' })).toBeTruthy();
  });

  it('defaults the project preview to light + the default axes', () => {
    const { page } = renderStep();
    expect(page().getAttribute('data-theme')).toBe('light');
    expect(page().getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);
  });

  it('scopes a style pick to THIS PAGE — Motir (<html>) is never touched', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));

    // The wizard page restyles…
    expect(page().getAttribute('data-style')).toBe(OTHER_STYLE);
    // …but Motir's own look (the document root) is untouched.
    expect(document.documentElement.getAttribute('data-style')).toBeNull();
  });

  it('the theme control restyles only the page (dark → section, not <html>)', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(page().getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('carries data-appearance-scope alongside the axes, so the picks reach the --el-* layer', () => {
    // MOTIR-2077. Scoping the axes to this section is only half the job: `--el-*`
    // resolve their `var(--color-*)` at the element that DECLARES them, so
    // without `data-appearance-scope` re-emitting the Tier-3 layer here, every
    // token this preview renders would still be Motir's, whatever the picks say.
    // The two attributes are one mechanism — asserted together so neither can be
    // dropped alone. (theme.css's `[data-theme='light']` block documents the
    // pairing; tests/theme/forcedThemeSubtree.test.ts proves the resolution.)
    const { page } = renderStep();
    expect(page().hasAttribute('data-appearance-scope')).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(page().getAttribute('data-theme')).toBe('light');
    expect(page().hasAttribute('data-appearance-scope')).toBe(true);
  });

  it('Reset returns the project design to its defaults', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Cobalt' }));

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));

    expect(page().getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);
    expect(page().getAttribute('data-theme')).toBe('light');
    expect(page().getAttribute('data-palette')).toBe(DEFAULT_PROJECT_PALETTE_ID);
  });

  it('opens a new project on Amethyst — the project default, not Motir’s own (MOTIR-6471)', () => {
    const { page } = renderStep();
    expect(DEFAULT_PROJECT_PALETTE_ID).toBe('amethyst');
    expect(page().getAttribute('data-palette')).toBe('amethyst');
  });

  it('Use this design + Back call their callbacks', () => {
    const { onBack, onUseDesign } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Use this design' }));
    expect(onUseDesign).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('restores a saved choice from initialChoice (the saved look, not defaults) — 7.3.81', () => {
    const choice: DesignChoiceDTO = {
      styleId: OTHER_STYLE,
      paletteId: 'cobalt',
      typeId: 'grotesk',
    };
    const { page } = renderStep({ initialChoice: choice });
    expect(page().getAttribute('data-style')).toBe(OTHER_STYLE);
    expect(page().getAttribute('data-palette')).toBe('cobalt');
    expect(page().getAttribute('data-type')).toBe('grotesk');
  });

  it('hands the chosen three axes (not the Theme) to onUseDesign — 7.3.81', () => {
    const { onUseDesign } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));
    // The Theme toggle is a preview mode, NOT part of the persisted choice.
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this design' }));
    expect(onUseDesign).toHaveBeenCalledWith({
      styleId: OTHER_STYLE,
      paletteId: DEFAULT_PROJECT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      backgrounds: { landing: 'wave', login: 'wave', hero: 'wave' },
    });
  });

  it('shows no Fine-tune control (that is a separate subtask)', () => {
    renderStep();
    expect(screen.queryByRole('button', { name: /Fine-tune/ })).toBeNull();
  });
});

// The per-area Backgrounds field (MOTIR-11618, design MOTIR-11615).
describe('DesignStep — Backgrounds (MOTIR-11618)', () => {
  const AREAS = ['Landing page', 'Login page', 'Hero section'] as const;
  const group = (name: string) => screen.getByRole('radiogroup', { name });
  const radios = (name: string) => Array.from(group(name).querySelectorAll('[role="radio"]'));
  const checked = (name: string) =>
    group(name).querySelector('[aria-checked="true"]')?.textContent ?? null;
  const pick = (area: string, label: string) =>
    fireEvent.click(radios(area).find((r) => r.textContent === label)!);
  const preview = (page: Element, area: string) =>
    page.querySelector(`[data-background-preview="${area}"]`)!;

  it('offers one chip row per area: the seven backgrounds in registry order, then None', () => {
    renderStep();
    expect(screen.getByText('Backgrounds')).toBeTruthy();
    expect(screen.getByText('What each page area draws behind its content.')).toBeTruthy();
    for (const area of AREAS) {
      expect(radios(area).map((r) => r.textContent)).toEqual([
        ...BACKGROUND_IDS.map((id) => BACKGROUND_REGISTRY[id].name),
        'None',
      ]);
    }
  });

  it('opens every area on the style default, the Wave', () => {
    renderStep();
    for (const area of AREAS) expect(checked(area)).toBe('Wave');
    expect(screen.getAllByText(/Redrawn for Warm Editorial\./)).toHaveLength(3);
  });

  it('leads each background chip with a still, decorative swatch, and None with a glyph', () => {
    const { page } = renderStep();
    const swatches = page().querySelectorAll('[data-background-swatch]');
    expect(swatches).toHaveLength(BACKGROUND_IDS.length * 3);
    for (const swatch of swatches) {
      expect(swatch.getAttribute('aria-hidden')).toBe('true');
      expect(swatch.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('a style-fixed background says it is the same in every style', () => {
    renderStep();
    pick('Hero section', 'Cyclic CA');
    expect(checked('Hero section')).toBe('Cyclic CA');
    expect(
      screen.getByText(/Same in every style — it follows only the palette and the theme\./),
    ).toBeTruthy();
  });

  it('a style-following background names the style it is redrawn for', () => {
    renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));
    pick('Landing page', 'Topography');
    expect(
      screen.getAllByText(new RegExp(`Redrawn for ${STYLE_REGISTRY[OTHER_STYLE].name}\\.`)),
    ).toHaveLength(3);
  });

  it('None draws nothing in its preview and says so', () => {
    const { page } = renderStep();
    pick('Login page', 'None');
    expect(screen.getByText('No background — the area shows the page colour.')).toBeTruthy();
    const login = preview(page(), 'login');
    expect(login.querySelector('canvas')).toBeNull();
    expect(login.querySelector('figcaption')?.textContent).toBe('Login page · No background');
    expect(preview(page(), 'landing').querySelector('figcaption')?.textContent).toBe(
      'Landing page · Wave',
    );
  });

  it('draws each preview behind its stand-in, gathering around it', () => {
    const { page } = renderStep();
    pick('Hero section', 'Aurora');
    const hero = preview(page(), 'hero');
    const canvas = hero.querySelector('canvas')!;
    expect(canvas.getAttribute('data-background')).toBe('aurora');
    expect(hero.querySelector('figcaption')?.textContent).toBe('Hero section · Aurora');
    const standIn = hero.querySelector('[inert]')!;
    expect(standIn.textContent).toBe('Describe your idea…');
    expect(standIn.id).not.toBe('');
    expect(preview(page(), 'landing').textContent).toContain('Plan it. Build it.');
    expect(preview(page(), 'login').textContent).toContain('Continue');
  });

  it('saves the three areas with the axes on Use this design', () => {
    const { onUseDesign } = renderStep();
    pick('Landing page', 'Topography');
    pick('Login page', 'None');
    pick('Hero section', 'Rule 110');
    fireEvent.click(screen.getByRole('button', { name: 'Use this design' }));
    expect(onUseDesign).toHaveBeenCalledWith({
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PROJECT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      backgrounds: { landing: 'topography', login: 'none', hero: 'rule110' },
    });
  });

  it('restores saved backgrounds, and a retired id falls back to the default', () => {
    renderStep({
      initialChoice: {
        styleId: DEFAULT_STYLE_ID,
        paletteId: 'cobalt',
        typeId: DEFAULT_TYPE_ID,
        backgrounds: {
          landing: 'brian',
          login: 'none',
          hero: 'retired' as never,
        },
      },
    });
    expect(checked('Landing page')).toBe("Brian's Brain");
    expect(checked('Login page')).toBe('None');
    expect(checked('Hero section')).toBe('Wave');
  });

  it('a choice saved before backgrounds existed opens every area on the default', () => {
    renderStep({
      initialChoice: { styleId: OTHER_STYLE, paletteId: 'cobalt', typeId: DEFAULT_TYPE_ID },
    });
    for (const area of AREAS) expect(checked(area)).toBe('Wave');
  });

  it('Reset to default puts every area back on the default', () => {
    renderStep();
    pick('Landing page', 'Day & Night');
    pick('Login page', 'None');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    for (const area of AREAS) expect(checked(area)).toBe('Wave');
  });
});
