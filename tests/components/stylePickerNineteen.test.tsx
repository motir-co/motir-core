// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { StylePicker } from '@/components/theme/AppearancePickers';
import { DesignStep } from '@/components/onboarding/DesignStep';
import { STYLE_IDS, STYLE_REGISTRY } from '@/lib/theme/styles';

// MOTIR-10675 — the picker half of the integration gate for Eight new styles
// (MOTIR-10549). The Appearance pane and the onboarding step both render the
// shared `StylePicker`, whose options are derived from STYLE_IDS. So once the
// eight style cards merge, both surfaces list nineteen styles with no edit to
// either. This file renders the picker and the onboarding step, and reads the
// two consumers as source to show neither carries a hand-written list. The
// registry, token-layer and resolver half is tests/theme/styleAxisIntegration.test.ts.

/** The eight new styles: the ids after Retrofuturism. */
const NEW_STYLES = STYLE_IDS.slice(STYLE_IDS.indexOf('retrofuturism') + 1);

const CONSUMERS = [
  'app/(authed)/settings/account/_components/AppearanceCard.tsx',
  'components/onboarding/DesignStep.tsx',
] as const;

beforeEach(() => {
  document.documentElement.removeAttribute('data-style');
});

afterEach(() => cleanup());

describe('StylePicker lists all nineteen styles (MOTIR-10675)', () => {
  it('derives the eight-id slice from the registry', () => {
    expect(STYLE_IDS).toHaveLength(19);
    expect(NEW_STYLES).toHaveLength(8);
  });

  it.each(NEW_STYLES)('selects and reports %s', (id) => {
    const onChange = vi.fn();
    render(<StylePicker value={id} onChange={onChange} label="Style" />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Style' })).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent?.trim())).toEqual(
      STYLE_IDS.map((styleId) => STYLE_REGISTRY[styleId].name),
    );
    const checked = radios.filter((radio) => radio.getAttribute('aria-checked') === 'true');
    expect(checked.map((radio) => radio.textContent?.trim())).toEqual([STYLE_REGISTRY[id].name]);

    // Clicking a different radio first, so the click on `id` is a real change.
    const other = NEW_STYLES.find((styleId) => styleId !== id)!;
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[other].name }));
    expect(onChange).toHaveBeenLastCalledWith(other);
  });

  it('reports each new id through onChange', () => {
    const onChange = vi.fn();
    render(<StylePicker value="warm-editorial" onChange={onChange} label="Style" />);
    for (const id of NEW_STYLES) {
      fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[id].name }));
      expect(onChange).toHaveBeenLastCalledWith(id);
    }
  });
});

describe('the onboarding DesignStep lists all nineteen (MOTIR-10675)', () => {
  it.each(NEW_STYLES)('re-shapes the wizard page to %s and leaves <html> alone', (id) => {
    const { container } = renderWithIntl(<DesignStep onBack={vi.fn()} onUseDesign={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'Style' });
    expect(within(group).getAllByRole('radio')).toHaveLength(STYLE_IDS.length);

    fireEvent.click(within(group).getByRole('radio', { name: STYLE_REGISTRY[id].name }));
    const page = container.querySelector('[data-testid="design-page"]');
    expect(page?.getAttribute('data-style')).toBe(id);
    expect(document.documentElement.getAttribute('data-style')).toBeNull();
  });
});

describe('both consumers are registry-driven', () => {
  it.each(CONSUMERS)('%s imports the shared StylePicker and names no style id', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).toMatch(
      /import\s*\{[^}]*\bStylePicker\b[^}]*\}\s*from\s*'@\/components\/theme\/AppearancePickers'/,
    );
    const literals = STYLE_IDS.filter(
      (id) => source.includes(`'${id}'`) || source.includes(`"${id}"`),
    );
    expect(literals, `${file} names style ids as literals`).toEqual([]);
  });
});
