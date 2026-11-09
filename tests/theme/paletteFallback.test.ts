import { describe, expect, it } from 'vitest';
import { BASE_PALETTE_ID, DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import {
  loadTokenLayer,
  resolveToken,
  resolveTokenInScope,
  type ScopeChain,
  type ThemeContext,
} from './paletteCascade';

// MOTIR-10834 — the palette axis falls back to its DEFAULT id at the stylesheet
// layer, as the style and type axes do.
//
// `DEFAULT_PALETTE_ID` is `motir`, but theme.css's Tier-0/Tier-3 base is
// `amethyst` (`BASE_PALETTE_ID`). Until this card the `motir` block was reached
// only by `[data-palette='motir']`, so an UNREGISTERED id, or a root with no
// data-palette at all, rendered amethyst: 291 of 308 colour properties differed
// from `motir` in light and 305 in dark, measured in Chromium on the compiled
// sheet. The `motir` block now also carries
//
//   [data-palette]:where(:not([data-palette='<id>'])…)   — every registered id
//   :root:where(:not([data-palette]))
//
// plus their dark companions. The id list is hand-written in CSS, so the first
// describe below holds it to the registry; the rest resolve the cascade model
// (`paletteCascade.ts`, which understands the `:where()` negation group) and
// assert the fallback resolves EVERY token exactly as `motir` does.

const LAYER = loadTokenLayer();
const UNKNOWN = 'not-a-registered-palette';
const THEMES = ['light', 'dark'] as const;

const FALLBACK_CHAIN =
  /^(.*)\[data-palette\]:where\(((?::not\(\[data-palette='[^']+'\]\))+)\)(.*)$/;
const idsIn = (chain: string) =>
  [...chain.matchAll(/:not\(\[data-palette='([^']+)'\]\)/g)].map((m) => m[1]!);

function motirRule(theme: 'light' | 'dark') {
  const wanted =
    theme === 'dark' ? "[data-palette='motir'][data-theme='dark']" : "[data-palette='motir']";
  const rule = LAYER.rules.find((r) => r.selectors.includes(wanted));
  if (!rule) throw new Error(`the motir ${theme} block (${wanted}) was not found`);
  return { rule, wanted };
}

/** Every custom property the motir block or the Tier-3 base declares — the population compared. */
const TOKENS = [
  ...new Set([
    ...Object.keys(LAYER.baseBlock),
    ...Object.keys(motirRule('light').rule.declarations),
    ...Object.keys(motirRule('dark').rule.declarations),
  ]),
].sort();

/** The rules with every fallback selector removed — the sheet as it was before this card. */
const RULES_WITHOUT_FALLBACK = LAYER.rules.map((rule) => ({
  ...rule,
  selectors: rule.selectors.filter((s) => !s.includes(':where(')),
}));

describe('the fallback selectors name exactly the registered palettes', () => {
  it('still has a default that differs from the base, which is what makes the fallback necessary', () => {
    expect(DEFAULT_PALETTE_ID).toBe('motir');
    expect(BASE_PALETTE_ID).not.toBe(DEFAULT_PALETTE_ID);
    expect(PALETTE_IDS as readonly string[]).not.toContain(UNKNOWN);
  });

  it.each(THEMES)(
    'the %s motir block carries the unregistered-id and missing-id selectors',
    (theme) => {
      const { rule, wanted } = motirRule(theme);
      const chains = rule.selectors.filter((s) => FALLBACK_CHAIN.test(s));
      // light: the compound form only; dark: the compound form and the descendant arm.
      expect(chains).toHaveLength(theme === 'dark' ? 2 : 1);
      for (const selector of chains) {
        const [, , chain] = FALLBACK_CHAIN.exec(selector)!;
        expect([...idsIn(chain!)].sort(), selector).toEqual([...PALETTE_IDS].sort());
      }
      const missing =
        theme === 'dark'
          ? ":root:where(:not([data-palette]))[data-theme='dark']"
          : ':root:where(:not([data-palette]))';
      expect(rule.selectors).toContain(missing);
      // Suites that read a block by the LAST line of its prelude find motir there.
      expect(rule.selectors.at(-1)).toBe(wanted);
    },
  );

  it('puts the fallback on no other rule', () => {
    const elsewhere = LAYER.rules
      .filter((r) => r !== motirRule('light').rule && r !== motirRule('dark').rule)
      .flatMap((r) => r.selectors)
      .filter((s) => FALLBACK_CHAIN.test(s) || s.includes(':where(:not([data-palette]))'));
    expect(elsewhere).toEqual([]);
  });
});

describe('an unregistered or missing palette resolves exactly as the default', () => {
  it.each(THEMES)('an unregistered id on the root, %s', (theme) => {
    const wrong: string[] = [];
    let differsFromBase = 0;
    for (const token of TOKENS) {
      const got = resolveToken(LAYER.rules, { palette: UNKNOWN, theme }, token).value;
      const want = resolveToken(LAYER.rules, { palette: DEFAULT_PALETTE_ID, theme }, token).value;
      if (got !== want) wrong.push(`${token}: ${got} ≠ ${want}`);
      const base = resolveToken(LAYER.rules, { palette: BASE_PALETTE_ID, theme }, token).value;
      if (got !== base) differsFromBase += 1;
    }
    expect(wrong).toEqual([]);
    // Not vacuous: the default really is a different palette from the base.
    expect(differsFromBase).toBeGreaterThan(100);
  });

  it.each(THEMES)('a root with no data-palette, %s', (theme) => {
    const themed: Record<string, string> = theme === 'dark' ? { 'data-theme': 'dark' } : {};
    const wrong = TOKENS.filter(
      (token) =>
        resolveTokenInScope(LAYER.rules, [{ ...themed }], token).value !==
        resolveTokenInScope(LAYER.rules, [{ ...themed, 'data-palette': DEFAULT_PALETTE_ID }], token)
          .value,
    );
    expect(wrong).toEqual([]);
  });

  it.each(THEMES)('an unregistered id on a nested scope under the base palette, %s', (theme) => {
    const root: Record<string, string> = { 'data-palette': BASE_PALETTE_ID };
    if (theme === 'dark') root['data-theme'] = 'dark';
    const chain = (palette: string): ScopeChain => [
      root,
      { 'data-appearance-scope': '', 'data-palette': palette },
    ];
    const wrong = TOKENS.filter(
      (token) =>
        resolveTokenInScope(LAYER.rules, chain(UNKNOWN), token).value !==
        resolveTokenInScope(LAYER.rules, chain(DEFAULT_PALETTE_ID), token).value,
    );
    expect(wrong).toEqual([]);
  });
});

describe('a registered palette is untouched by the fallback', () => {
  it('resolves every token in every registered context as the sheet without the fallback does', () => {
    const changed: string[] = [];
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        const ctx: ThemeContext = { palette, theme };
        for (const token of TOKENS) {
          const now = resolveToken(LAYER.rules, ctx, token).value;
          const before = resolveToken(RULES_WITHOUT_FALLBACK, ctx, token).value;
          if (now !== before) changed.push(`${palette}/${theme} ${token}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });

  it('keeps an unregistered id on the base palette once the fallback is removed (the guard can fail)', () => {
    const token = '--color-accent';
    const withoutFallback = resolveToken(
      RULES_WITHOUT_FALLBACK,
      { palette: UNKNOWN, theme: 'light' },
      token,
    ).value;
    expect(withoutFallback).toBe(
      resolveToken(LAYER.rules, { palette: BASE_PALETTE_ID, theme: 'light' }, token).value,
    );
    expect(withoutFallback).not.toBe(
      resolveToken(LAYER.rules, { palette: DEFAULT_PALETTE_ID, theme: 'light' }, token).value,
    );
  });
});
