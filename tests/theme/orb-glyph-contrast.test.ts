import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, declaredIn, resolveValue, type ThemeContext } from './paletteCascade';

// MOTIR-3207 — the floating orb's glyph-on-gradient contrast
// (`design/ai-chat/design-notes.md` § *B*, `ai-callout-menu.mock.html` panel 9).
//
// ── WHY THIS TEST EXISTS AT ALL ─────────────────────────────────────────────
// Same hole as its sibling `brand-tile-contrast.test.ts`, one step deeper. The
// repo's ink guard (`tests/theme/inkContrastLint.test.ts`) reasons about the
// ink/surface tokens it finds named together in a `className`. Here the ink IS
// in a className (`text-(--el-accent-text)`) but the backdrop is not a token at
// all — it is a STOP inside a `radial-gradient()` in a JS style object, and the
// stop is a `color-mix()` of the ink into the fill. No className-reading guard
// can see that pair, so the orb shipped for three weeks with a white mark at
// 2.78:1 on the brightest part of its own gradient.
//
// ── THE SAMPLE POINT IS THE FIRST STOP, AND THAT IS ASSERTED, NOT ASSUMED ───
// The gradient's first stop is its lightest point by construction — it mixes
// the GLYPH's own colour into the fill — and it is centred at 33%/27%, well
// inside the 26 px glyph box in the 56 px circle. So it is where a white mark
// is closest to disappearing, and a mid-tone assertion (the orb BODY, which
// measures 4.99:1 in default dark) reads green over a failing surface. The
// suite therefore measures all three stops and asserts the first is the worst,
// so a future palette that inverts that ordering fails HERE rather than making
// the chosen sample point quietly wrong.
//
// ── AND IT ASSERTS EVERY PALETTE, NOT JUST THE DEFAULT ──────────────────────
// This is where the card that filed the defect was wrong, so it is worth
// stating. The finding measured the default pair and concluded "light has
// headroom at 32%, so prefer a theme-aware mix". Across the whole shipped
// matrix — ten `data-palette` values x both themes — FOUR contexts failed at
// 32% and one of them, `evergreen`, is a LIGHT one at 2.94:1. A
// `[data-theme='dark']` override of the stop would have left it broken. The fix
// is one global `--orb-lit-mix: 26%`, and this is the guard that makes the
// claim "all twenty clear 3:1" a fact rather than a sentence.
//
// WCAG 1.4.11 (non-text contrast) asks 3:1 for a graphical object that carries
// meaning. All 20 contexts clear it; the lowest is the default dark, at 3.09:1.
//
// NOT in scope, deliberately: the orb's `inset 0 1px 0 color-mix(…40%…)` rim.
// It is a 1 px line on the circle's top EDGE, outside the centred glyph box, so
// it is not a backdrop the mark is read against.

const ROOT = process.cwd();
const FAB = readFileSync(join(ROOT, 'components/planning/PlanWithAIFab.tsx'), 'utf8');
const MOCK = readFileSync(join(ROOT, 'design/ai-chat/ai-callout-menu.mock.html'), 'utf8');
// The OLDER sketch of the same orb (MOTIR-3217). It painted the fill, rim, glow
// and mark in three invented hexes that no token reached, so it could not
// follow a `data-palette` swap and its first stop measured 2.995:1 against the
// white mark — the very defect the asset beside it was filed to fix. Now it
// reproduces the shipped recipe by reference, and this file is what keeps it
// there: a third copy of the number is a third place for the mark to go
// illegible, and it is the copy a reader reaches for when they want the
// overview rather than the detail.
const SKETCH = readFileSync(join(ROOT, 'design/ai-chat/planning-workspace.mock.html'), 'utf8');
const NOTES = readFileSync(join(ROOT, 'design/ai-chat/design-notes.md'), 'utf8');

const { rules } = loadTokenLayer();
const MIX_TOKEN = '--orb-lit-mix';
const GLYPH_TOKEN = '--el-accent-text';

const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  (['light', 'dark'] as const).map((theme) => ({ palette, theme })),
);
const label = (ctx: ThemeContext) => `${ctx.palette}/${ctx.theme}`;

// ── Reading the recipe out of what SHIPS ────────────────────────────────────

/** Split on commas that sit at paren depth 0. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** The `radial-gradient(…)` call's arguments, from a string containing one. */
function gradientArgs(source: string): string[] {
  const at = source.indexOf('radial-gradient(');
  expect(at, 'a radial-gradient must be present').toBeGreaterThan(-1);
  const open = at + 'radial-gradient('.length;
  let depth = 1;
  let close = open;
  for (; close < source.length; close++) {
    if (source[close] === '(') depth++;
    else if (source[close] === ')' && --depth === 0) break;
  }
  return splitTopLevel(source.slice(open, close));
}

/**
 * `ORB_STYLE`'s `backgroundImage` RECIPE, as the component actually writes it.
 *
 * ⚠️ UNWRAPPED FROM THE `var()` SEAM (MOTIR-4743), and the assertions below are
 * unchanged by that. The declaration is now
 * `var(--plan-orb-fill, <the recipe>)`, so the style layer can give the orb each
 * style's own material — the fix for the orb rendering byte-identically under all
 * eleven styles. The RECIPE is the fallback inside it, and the recipe is what the
 * two design mocks reproduce and what `--orb-lit-mix` lives in: comparing the
 * whole declaration against a mock would be asking a design asset to carry a
 * stylesheet seam it has no style layer to use. What this file guards — that the
 * shipped recipe and both mocks are the same string, by reference to the same
 * token — is measured on exactly the same content as before.
 *
 * The seam itself is asserted in `tests/theme/aiCtaStyleSeam.test.ts`; a
 * component that dropped the `var()` and painted the recipe directly would go red
 * there, not here.
 */
function shippedGradient(): string {
  const match = /backgroundImage:\s*\n?\s*'([^']+)'/.exec(FAB);
  expect(match, 'ORB_STYLE must declare a single-quoted backgroundImage').toBeTruthy();
  const declared = match![1]!;
  const seam = /^var\(--plan-orb-fill,\s*([\s\S]*)\)$/.exec(declared);
  expect(
    seam,
    'ORB_STYLE must read the style layer’s `--plan-orb-fill` with the recipe as its fallback',
  ).toBeTruthy();
  return seam![1]!.trim();
}

/**
 * The mock's `.orb` rule `background-image`.
 *
 * Comments are stripped BEFORE the declaration is cut, not after: the comment
 * that explains the token reference contains a `;`, and a declaration read up
 * to the first semicolon would otherwise end inside the prose.
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const MOCK_CSS = stripComments(MOCK);
const SKETCH_CSS = stripComments(SKETCH);

/**
 * One rule's body, by selector.
 *
 * The selector is anchored to the start of its line (`\n\s*`) rather than
 * matched anywhere: `.palstrip .orb { … }` is a real rule in the sketch and it
 * is DECLARED FIRST, so an unanchored `\.orb\s*\{` returns the 46px strip
 * override instead of the orb itself — green, and measuring nothing.
 */
function ruleBody(css: string, selector: string, asset: string): string {
  const rule = new RegExp(
    `\\n\\s*\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`,
  ).exec(css);
  expect(rule, `${asset} must carry a \`.${selector}\` rule`).toBeTruthy();
  return rule![1]!;
}

function gradientOf(css: string, selector: string, asset: string): string {
  const declaration = /background-image:\s*([\s\S]*?);/.exec(ruleBody(css, selector, asset));
  expect(declaration, `${asset} \`.${selector}\` must set a background-image`).toBeTruthy();
  return declaration![1]!;
}

const mockGradient = () => gradientOf(MOCK_CSS, 'orb', 'ai-callout-menu.mock.html');

const normalise = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

// ── Evaluating it, per context ──────────────────────────────────────────────

type Rgb = [number, number, number];

function parseHex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${value}`);
  const hex = m[1]!;
  return [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16)) as Rgb;
}

/**
 * Evaluate a colour expression that is either a hex or
 * `color-mix(in srgb, <a> <pct>, <b>)`, recursively.
 *
 * The mix is computed in CONTINUOUS sRGB and NOT quantised to 8 bits — that is
 * what a browser interpolates before it paints, and it is the arithmetic the
 * design asset's own numbers were taken with (rounding each channel first moves
 * the default light ratio from 3.32 to 3.31, which would put the asset and this
 * guard into a disagreement that means nothing).
 */
function evaluate(expression: string): Rgb {
  const value = expression.trim();
  if (value.startsWith('#')) return parseHex(value);
  const mix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/.exec(value);
  if (!mix) throw new Error(`unsupported colour expression: ${value}`);
  const [first, second] = splitTopLevel(mix[1]!);
  const withPercent = /^(.*?)\s+([\d.]+)%$/.exec(first!.trim());
  if (!withPercent || second === undefined) {
    throw new Error(`unsupported color-mix arguments: ${value}`);
  }
  const weight = Number(withPercent[2]) / 100;
  const a = evaluate(withPercent[1]!);
  const b = evaluate(second);
  return a.map((channel, i) => weight * channel + (1 - weight) * b[i]!) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Every colour stop of the shipped gradient, resolved in one context. */
function stopsIn(ctx: ThemeContext): { glyph: Rgb; stops: Rgb[] } {
  const declarations = declaredIn(rules, ctx);
  const expand = (value: string) => {
    const { value: resolved, unresolved } = resolveValue(value, declarations);
    expect(unresolved, `${label(ctx)}: ${value}`).toEqual([]);
    return resolved;
  };
  // Drop the shape argument (`circle at 33% 27%`) and each stop's POSITION —
  // the colour is what is measured.
  const [, ...stopArgs] = gradientArgs(expand(shippedGradient()));
  const stops = stopArgs.map((stop) => evaluate(stop.replace(/\s+[\d.]+%$/, '')));
  return { glyph: parseHex(expand(`var(${GLYPH_TOKEN})`)), stops };
}

const MEASURED = new Map(CONTEXTS.map((ctx) => [label(ctx), stopsIn(ctx)]));
const firstStopRatio = (key: string) => {
  const { glyph, stops } = MEASURED.get(key)!;
  return contrast(glyph, stops[0]!);
};

describe('the floating orb’s glyph (MOTIR-3207)', () => {
  it('reads the lit-sphere mix from a token — no percentage inlined in the component', () => {
    // The fix is one number, and this is what keeps it ONE number. A literal
    // back in this string is how the app and the asset below drift apart.
    const gradient = shippedGradient();
    expect(gradient).toContain(`var(${MIX_TOKEN})`);
    const [, firstStop] = gradientArgs(gradient);
    expect(firstStop, 'the first stop must not carry its own percentage').not.toMatch(/\d+%/);
  });

  it('declares the token once, in the design system’s recipe-knob block', () => {
    const theme = readFileSync(join(ROOT, 'packages/design-system/theme.css'), 'utf8');
    const declarations = theme.match(new RegExp(`${MIX_TOKEN}\\s*:`, 'g')) ?? [];
    expect(declarations, `${MIX_TOKEN} is declared exactly once`).toHaveLength(1);
    // It is NOT an `--el-*` token on purpose: the Tier-3 layer is a colour
    // contract whose every member aliases a Tier-0 `--color-*` and is asserted
    // palette-DEPENDENT (`paletteTokenCoverage`). This is a palette-invariant
    // scalar, so it would fail both halves.
    expect(MIX_TOKEN.startsWith('--el-')).toBe(false);
  });

  it('is reproduced in the mock by REFERENCE — the number is not copied into it', () => {
    // `design/ai-chat/ai-callout-menu.mock.html` panel 9 draws the orb with its
    // own copy of the recipe. That copy may reproduce the SHAPE; it must not
    // reproduce the contrast number, or the asset can show a passing orb while
    // the app ships a failing one.
    expect(normalise(mockGradient())).toBe(normalise(shippedGradient()));
    expect(mockGradient()).toContain(`var(${MIX_TOKEN})`);
  });

  it('resolves every stop in every palette × theme context', () => {
    // Guards the guard: an expression this evaluator silently skipped would
    // make every assertion below vacuous.
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * 2);
    expect(MEASURED.size).toBe(CONTEXTS.length);
    for (const [key, { stops }] of MEASURED) {
      expect(stops, key).toHaveLength(3);
    }
  });

  it('samples the FIRST stop because it is the worst — in every context', () => {
    // The justification for the sample point, asserted rather than asserted-in-
    // prose. The first stop mixes the glyph's own colour into the fill, so it
    // is the lightest point of a gradient whose other two stops move AWAY from
    // the glyph. A palette that inverted this would make the gate below measure
    // the wrong pixel silently.
    const inverted = [...MEASURED.entries()]
      .map(([key, { glyph, stops }]) => ({
        key,
        ratios: stops.map((stop) => contrast(glyph, stop)),
      }))
      .filter(({ ratios }) => ratios.some((ratio) => ratio < ratios[0]! - 1e-9));
    expect(
      inverted.map(({ key, ratios }) => `${key}: ${ratios.map((r) => r.toFixed(2)).join(' / ')}`),
      'the first stop must stay the lowest-contrast stop, or the sample point is wrong',
    ).toEqual([]);
  });

  it('clears WCAG 1.4.11’s 3:1 for the graphic in EVERY palette and theme', () => {
    const failing = [...MEASURED.keys()]
      .map((key) => ({ key, ratio: firstStopRatio(key) }))
      .filter(({ ratio }) => ratio < 3);

    expect(
      failing.map(({ key, ratio }) => `${key}: ${ratio.toFixed(2)}:1 at the gradient's first stop`),
      'the mark must stay legible on the lit part of its own orb under every palette',
    ).toEqual([]);
  });

  it('keeps the knob a ceiling — 32% is still the value that fails', () => {
    // Mixing the glyph's colour into its backdrop is monotonic, so lowering
    // `--orb-lit-mix` is always safe and only raising it can break the bar.
    // Re-deriving the OLD value's failures pins the regression this card fixed:
    // if a later change made 32% pass, the defect's cause moved and the number
    // chosen here is no longer the thing keeping the orb legible.
    const declarations = declaredIn(rules, { palette: BASE_PALETTE_ID, theme: 'dark' });
    const raised = { ...declarations, [MIX_TOKEN]: '32%' };
    const gradient = resolveValue(shippedGradient(), raised).value;
    const [, firstStop] = gradientArgs(gradient);
    const glyph = parseHex(resolveValue(`var(${GLYPH_TOKEN})`, raised).value);
    expect(contrast(glyph, evaluate(firstStop!.replace(/\s+[\d.]+%$/, '')))).toBeCloseTo(2.78, 2);
  });

  it('is reproduced in the OLDER sketch by reference too — both of its copies', () => {
    // `planning-workspace.mock.html` sheet 4 draws the same orb twice: `.fab`
    // (the floating button on the faux page) and `.orb` (the anatomy close-up +
    // the palette strip). Both used to carry the literal
    // `radial-gradient(circle at 33% 27%, #9c81ff, #5645d4 58%, #4733bd)`,
    // which reached no token at all — so `--orb-lit-mix` could move and this
    // sheet would keep painting the pre-MOTIR-3207 orb, at 2.995:1 (MOTIR-3217).
    for (const selector of ['fab', 'orb'] as const) {
      const gradient = gradientOf(SKETCH_CSS, selector, 'planning-workspace.mock.html');
      expect(normalise(gradient), `.${selector}`).toBe(normalise(shippedGradient()));
      expect(gradient, `.${selector}`).toContain(`var(${MIX_TOKEN})`);
    }
  });

  it('paints the sketch’s orb — fill, rim, glow and mark — with no raw hex', () => {
    // The other half of MOTIR-3217, and the half a gradient comparison alone
    // does not cover: an asset can read the token for its fill and still freeze
    // its halo and its glyph to the default palette, which is what made the
    // sheet's own closing note ("`--el-*` palette-derived colour") false.
    // Every rule the orb is made of is checked, not just the one that carries
    // the measured stop.
    const ORB_RULES = ['fab', 'orb', 'fab::before', 'orb::before', 'fab .spark', 'mlogo path'];
    const offenders = ORB_RULES.flatMap((selector) => {
      const body = ruleBody(SKETCH_CSS, selector, 'planning-workspace.mock.html');
      return (body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((hex) => `.${selector}: ${hex}`);
    });
    expect(
      offenders,
      'a raw hue here cannot follow a `data-palette` swap — route it through `--el-*`',
    ).toEqual([]);
  });

  it('agrees with the design asset — 3.77:1 light, 3.09:1 dark, both recorded', () => {
    // The asset half of the card: `design-notes.md` § B and the mock's panel 9
    // record the orb's numbers, and a recorded number that no longer describes
    // the app is the drift this pins. Derived here, grepped there — never the
    // other way round.
    const light = firstStopRatio(`${BASE_PALETTE_ID}/light`);
    const dark = firstStopRatio(`${BASE_PALETTE_ID}/dark`);
    expect(light).toBeCloseTo(3.77, 2);
    expect(dark).toBeCloseTo(3.09, 2);

    for (const [name, asset] of [
      ['design-notes.md § B', NOTES],
      ['ai-callout-menu.mock.html panel 9', MOCK],
      ['planning-workspace.mock.html sheet 4', SKETCH],
    ] as const) {
      expect(asset, `${name} records the light ratio`).toContain(`${light.toFixed(2)}:1`);
      expect(asset, `${name} records the dark ratio`).toContain(`${dark.toFixed(2)}:1`);
    }
  });
});
