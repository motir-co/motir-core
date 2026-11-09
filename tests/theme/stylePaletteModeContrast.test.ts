import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '@/lib/theme/styles';
import { BASE_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, resolveTokenInScope, type ScopeChain } from './paletteCascade';
import { contrast, flattenColorMix } from './colorMetrics';
import {
  interpolatePositions,
  parseLayers,
  parsePositionList,
  worstCanvasContrast,
  type CanvasInput,
  type InkResult,
  type Length,
  type RenderState,
  type Viewport,
} from './canvasRaster';

// MOTIR-10674 — the style × palette × mode AA contrast gate.
//
// ── What this asks ──────────────────────────────────────────────────────────
// Does TEXT still clear AA on every surface, under every registered style, in
// every registered palette, in both modes? The colour-ratio suites in this
// folder build their contexts from the palette and theme axes only; the suites
// that iterate the style axis assert structure, not a ratio. This file is the
// one place the three axes meet, and it derives all three: `STYLE_IDS`,
// `PALETTE_IDS` and the two themes. A style or palette registered later joins
// the matrix with no edit here.
//
// ── TWO readers, because the shipped resolver sees only half a style ────────
// 1. The TOKEN half goes through `paletteCascade.ts`, but ONLY on the
//    scope-chain path. `resolveToken` routes through `matchesContext`, which
//    refuses `data-style` by design ("unset in these contexts"), so a root-only
//    resolve would measure every style as the base. `resolveTokenInScope` with a
//    one-element chain carrying `data-style` + `data-palette` (+ `data-theme`
//    in dark) is the model of `<html>` as the init script writes it. The probe
//    case below proves the style axis actually reaches resolution.
// 2. The MATERIAL half is a style's own `@scope ([data-style='<id>']) to
//    ([data-style])` rules, which `parseRules` skips (it reads no at-rule but
//    `@theme`). The reader in this file walks the TOP-LEVEL `@scope` blocks of
//    the stylesheet. A block nested in `@media` is a preference arm
//    (`prefers-contrast`, `forced-colors`), not what renders by default, so it
//    is not read. The reader resolves each painted value against the same
//    context and folds `color-mix()`.
//
// ── The surface population is a PARTITION ───────────────────────────────────
// Every hook — canvas (`body` / `[data-app-shell]`), card, popover, modal,
// input, sidebar, plus the plan-with-AI pill and orb — falls in exactly one
// group:
//   UNPAINTED  the style's rules declare no fill on the hook, so the ground is
//              the palette token the emitter paints (`GROUND_TOKEN`);
//   REPAINTED  a rule whose selector IS the hook declares `background-color`
//              (or, for the canvas, a `background-image` pattern), and the
//              ground is that declaration.
// The predicate is "does an exact-hook rule declare a fill", never a list of
// styles, so a hook that moves cannot fall between two lists.
//
// One state ground sits outside the partition: a style's SELECTED-row tint
// (`:is([aria-selected='true'], [aria-current='page']):not([data-surface])`),
// measured against the four hard inks wherever a style declares one. A rule in
// an `@layer` is read as top level, since layering only lets a component's own
// utilities outrank it.
//
// ── The inks ────────────────────────────────────────────────────────────────
// The hard bar on every ground is the four roles `theme.css` documents as AA
// everywhere: `--el-text`, `--el-text-strong`, `--el-text-secondary`,
// `--el-accent-on-surface`. Two inks are deliberately outside it, with the
// stylesheet's own numbers:
//   `--el-text-muted`  AA only on the white page/card (4.54:1, by 0.04) and
//                      4.12–4.34:1 on `--el-surface` / `--el-muted` /
//                      `--el-surface-soft`. It is measured only on UNPAINTED
//                      page and card grounds, the ones it was tuned for. A
//                      repainted ground is exactly the case its declaration
//                      warns about.
//   `--el-text-faint`  2.37–2.82:1 everywhere. It is for decorative glyphs and
//                      disabled text only, so it carries no text WCAG measures.
// The hero pill's label is `--el-accent-text`, or the `color` its rule
// declares, held to 4.5:1. The orb's glyph is the same ink held to 3:1 (WCAG
// 1.4.11, a non-text graphic, the bar `orb-glyph-contrast.test.ts` uses).
//
// ── What this instrument CANNOT see ─────────────────────────────────────────
// It resolves declarations, not renders. A green here means "every pair this
// suite can resolve clears AA", never "the app is readable":
//   - a fill painted through a pseudo-element (`::before` / `::after`) or a
//     `background-image` layer on a SURFACE (Art Deco's corner marks, a chrome
//     bevel). Only the canvas pattern and the hero fills are read as images;
//   - a hero gradient layer confined by `background-size` to a band above the
//     cap height (Retrofuturism's crown, glass's streak). The label does not
//     sit on it, which is how those rows were measured when they shipped;
//   - a canvas pattern's colour BETWEEN sampled pixels. The canvas is PAINTED
//     (`canvasRaster.ts`, MOTIR-10736): every layer is stacked top to bottom at
//     sampled pixels of three viewports, still and across its animation, as a
//     browser composites it, and each hard ink is measured against the worst
//     pixel. Reading each layer ALONE over the page, which this file did until
//     then, UNDER-reports wherever two translucent washes overlap: glass's
//     bottom-right corner rendered 4.26:1 while every single-layer stop passed.
//     Checked against Chromium screenshots, the painter finds the same worst
//     pixel to within two pixels. Its ratios sit about 2% above Chromium's,
//     which dithers gradients by one level and so puts single pixels below the
//     undithered colour this file measures. A canvas layer in a form the
//     painter cannot read fails the resolve case rather than going unmeasured;
//   - an ink a component sets for itself, from a component this file does not
//     open;
//   - a selector that is not exactly the hook (descendant, pseudo-class,
//     `:where()` defaults). Tonal / Elevated's `:where([data-surface]…)` rung-1
//     default is such a rule, and its card / sidebar / header rules restate it
//     exactly.
//
// ── Failures ────────────────────────────────────────────────────────────────
// A failing row prints as `style/palette/mode · ink on ground = x.xx:1`, and
// every failing row is listed, never only the first. The 4.5:1 floor is WCAG
// 1.4.3 for normal-size text and is never lowered. A failure in a style that
// shipped before MOTIR-10549 is a defect in finished work: it is filed as a bug
// and held in `KNOWN_SHIPPED_FAILURES`, keyed by row with its ratio and the bug
// key. That map starts empty and is asserted by EQUALITY, so a fixed entry goes
// red until it is deleted and a new failure cannot hide behind an old one.

const WCAG_TEXT_MIN = 4.5;
const WCAG_GRAPHIC_MIN = 3;

/** The four inks `theme.css` documents as AA on every surface. */
const HARD_INKS = [
  '--el-text',
  '--el-text-strong',
  '--el-text-secondary',
  '--el-accent-on-surface',
];
const MUTED_INK = '--el-text-muted';

type Hook =
  | 'canvas'
  | 'card'
  | 'popover'
  | 'modal'
  | 'input'
  | 'sidebar'
  | 'selected'
  | 'pill'
  | 'orb';
const SURFACE_HOOKS = ['canvas', 'card', 'popover', 'modal', 'input', 'sidebar'] as const;
type SurfaceHook = (typeof SURFACE_HOOKS)[number];
const HOOKS: Hook[] = [...SURFACE_HOOKS, 'selected', 'pill', 'orb'];

/** The exact selectors that ARE each hook. */
const HOOK_SELECTORS: Record<Hook, string[]> = {
  canvas: ['body', '[data-app-shell]'],
  card: ["[data-surface='card']"],
  popover: ["[data-surface='popover']"],
  modal: ["[data-surface='modal']"],
  input: ["[data-surface='input']"],
  sidebar: ["[data-surface='sidebar']"],
  // A style's selected-row tint: a row, tab or nav item that paints no fill of
  // its own. Measured only where a style declares one.
  selected: [":is([aria-selected='true'], [aria-current='page']):not([data-surface])"],
  pill: ["[data-surface='ai-cta']", "[data-surface='ai-cta'][data-ai-cta='pill']"],
  orb: ["[data-surface='ai-cta']", "[data-surface='ai-cta'][data-ai-cta='orb']"],
};

/**
 * The palette token each emitter paints when no style repaints it: `Card` is
 * `bg-(--el-card)`; `Popover`, `Modal` and `Input` are `bg-(--el-page-bg)`; the
 * rail is `bg-(--el-sidebar-bg)`; the shell canvas is the page ground.
 */
const GROUND_TOKEN: Record<SurfaceHook, string> = {
  canvas: '--el-page-bg',
  card: '--el-card',
  popover: '--el-page-bg',
  modal: '--el-page-bg',
  input: '--el-page-bg',
  sidebar: '--el-sidebar-bg',
};
/** The unpainted grounds `--el-text-muted` was tuned for. */
const MUTED_GROUNDS = new Set(['--el-page-bg', '--el-card']);

/** The components' own fallbacks (PlanWithAILauncher / PlanWithAIFab). */
const PILL_FALLBACK =
  'linear-gradient(135deg, var(--el-accent), color-mix(in srgb, var(--el-accent) 86%, var(--el-highlight)))';
const ORB_FALLBACK =
  'radial-gradient(circle at 33% 27%, color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)), var(--el-accent) 56%, color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight)))';

/**
 * Shipped-style pairs measured under the floor, each with its bug. Keyed by the
 * row id `style/palette/mode · ink on hook`. Asserted by equality.
 */
// One entry per measured pair, each carrying the ratio it measured and the bug
// filed when it was recorded: MOTIR-10709 aurora. Retrofuturism (MOTIR-10708),
// glassmorphism (MOTIR-10707), cybercore-y2k (MOTIR-10710 pill and orb,
// MOTIR-10746 canvas grid) and memphis (MOTIR-10745: painting the canvas whole
// found its dot-over-hatch pixels under the floor; the pattern now takes
// 11 / 9 / 5%) clear every row and hold no entry.
const KNOWN_SHIPPED_FAILURES: Record<string, { ratio: string; bug: string }> = {
  'aurora/amber/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.95',
    bug: 'MOTIR-10709',
  },
  'aurora/amethyst/dark · --el-accent-on-surface on canvas (pattern)': {
    ratio: '4.19',
    bug: 'MOTIR-10709',
  },
  'aurora/amethyst/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '4.44',
    bug: 'MOTIR-10709',
  },
  'aurora/candy/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.81',
    bug: 'MOTIR-10709',
  },
  'aurora/candy/light · --el-text-secondary on canvas (pattern)': {
    ratio: '3.87',
    bug: 'MOTIR-10709',
  },
  'aurora/citrine/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '4.08',
    bug: 'MOTIR-10709',
  },
  'aurora/cobalt/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '4.00',
    bug: 'MOTIR-10709',
  },
  'aurora/evergreen/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.97',
    bug: 'MOTIR-10709',
  },
  'aurora/garnet/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.97',
    bug: 'MOTIR-10709',
  },
  'aurora/motir/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.98',
    bug: 'MOTIR-10709',
  },
  'aurora/motir/light · --el-text-secondary on canvas (pattern)': {
    ratio: '4.25',
    bug: 'MOTIR-10709',
  },
  'aurora/sienna/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '3.71',
    bug: 'MOTIR-10709',
  },
  'aurora/spectrum/light · --el-accent-on-surface on canvas (pattern)': {
    ratio: '4.26',
    bug: 'MOTIR-10709',
  },
};

// ── The material reader ─────────────────────────────────────────────────────

/**
 * Drop each `@layer <name> { … }` wrapper and keep its body. A layered rule is
 * still the default render (it only yields to the utilities a component sets on
 * itself), so the reader treats it as top level.
 */
function unwrapLayers(css: string): string {
  let out = '';
  let cursor = 0;
  for (const match of css.matchAll(/@layer\s+[a-z-]+\s*\{/g)) {
    if (match.index < cursor) continue;
    const open = match.index + match[0].length;
    let level = 1;
    let end = open;
    while (level > 0) {
      if (css[end] === '{') level += 1;
      else if (css[end] === '}') level -= 1;
      end += 1;
    }
    out += css.slice(cursor, match.index) + css.slice(open, end - 1);
    cursor = end;
  }
  return out + css.slice(cursor);
}

const CSS = unwrapLayers(
  (
    readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8') +
    readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8')
  ).replace(/\/\*[\s\S]*?\*\//g, ''),
);

/** Split on commas at parenthesis depth 0. */
function topLevelSplit(text: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

interface MaterialRule {
  style: string;
  selectors: string[];
  declarations: Record<string, string>;
}

/** Every rule inside a TOP-LEVEL `@scope ([data-style='<id>']) to ([data-style])` block. */
function readMaterialRules(css: string): MaterialRule[] {
  const rules: MaterialRule[] = [];
  const prelude = /@scope\s*\(\[data-style='([a-z0-9-]+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;
  let depth = 0;
  let cursor = 0;
  for (const match of css.matchAll(prelude)) {
    for (; cursor < match.index; cursor += 1) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
    }
    if (depth !== 0) continue; // nested in @media: a preference arm, not the default render
    const open = match.index + match[0].length;
    let level = 1;
    let end = open;
    while (level > 0) {
      if (css[end] === '{') level += 1;
      else if (css[end] === '}') level -= 1;
      end += 1;
    }
    const inner = css.slice(open, end - 1);
    for (const [, selector, body] of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations: Record<string, string> = {};
      for (const part of topLevelSplit(body ?? '', ';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      rules.push({
        style: match[1]!,
        selectors: topLevelSplit(selector ?? '').map((s) => s.replace(/\s+/g, ' ')),
        declarations,
      });
    }
  }
  return rules;
}

const MATERIAL = readMaterialRules(CSS);

/** The merged declarations of every rule whose selector IS one of the hook's. */
function hookDeclarations(style: string, hook: Hook): Record<string, string> {
  const wanted = HOOK_SELECTORS[hook];
  const out: Record<string, string> = {};
  for (const rule of MATERIAL) {
    if (rule.style !== style) continue;
    if (!rule.selectors.some((s) => wanted.includes(s))) continue;
    Object.assign(out, rule.declarations);
  }
  return out;
}

/** The predicate the partition is built on. */
function isRepainted(style: string, hook: SurfaceHook): boolean {
  const own = hookDeclarations(style, hook);
  if ('background-color' in own) return true;
  return hook === 'canvas' && 'background-image' in own;
}

// ── Colour evaluation ───────────────────────────────────────────────────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const KEYWORDS: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function parseHex(hex: string): Rgba | undefined {
  const h = hex.slice(1);
  const full =
    h.length === 3 || h.length === 4
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return undefined;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

/**
 * Evaluate a RESOLVED colour expression (no `var()` left). An opaque two-operand
 * `color-mix()` is folded with the shipped `flattenColorMix`; a mix with a
 * translucent operand uses CSS's premultiplied interpolation.
 */
function evaluate(expr: string): Rgba | undefined {
  const value = expr.trim().toLowerCase();
  if (value in KEYWORDS) return KEYWORDS[value];
  if (value.startsWith('#')) return parseHex(value);
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/.exec(value);
  if (!mix) return undefined;
  const flat = flattenColorMix(value);
  if (flat !== value) return parseHex(flat);
  const operands = topLevelSplit(mix[1]!).map((operand) => {
    const pct = /\s([\d.]+)%$/.exec(operand);
    return {
      colour: evaluate(pct ? operand.slice(0, pct.index) : operand),
      pct: pct ? Number(pct[1]) : undefined,
    };
  });
  const [x, y] = operands;
  if (!x?.colour || !y?.colour) return undefined;
  const p1 = x.pct ?? (y.pct !== undefined ? 100 - y.pct : 50);
  const p2 = y.pct ?? 100 - p1;
  const sum = p1 + p2;
  const [w1, w2] = [p1 / sum, p2 / sum];
  const alpha = x.colour.a * w1 + y.colour.a * w2;
  const channel = (k: 'r' | 'g' | 'b') =>
    alpha === 0 ? 0 : (x.colour![k] * x.colour!.a * w1 + y.colour![k] * y.colour!.a * w2) / alpha;
  const scale = sum < 100 ? sum / 100 : 1;
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha * scale };
}

/** Source-over composite of `top` on an opaque `ground`. */
function over(top: Rgba, ground: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + ground.r * (1 - a),
    g: top.g * a + ground.g * (1 - a),
    b: top.b * a + ground.b * (1 - a),
    a: 1,
  };
}

function toHex(c: Rgba): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// ── Contexts ────────────────────────────────────────────────────────────────

const LAYER = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;

interface Context {
  style: string;
  palette: string;
  theme: (typeof THEMES)[number];
  chain: ScopeChain;
}

const CONTEXTS: Context[] = STYLE_IDS.flatMap((style) =>
  PALETTE_IDS.flatMap((palette) =>
    THEMES.map((theme) => ({
      style,
      palette,
      theme,
      // `<html>` as the init script writes it: light is the ABSENT attribute.
      chain: [
        {
          'data-style': style,
          'data-palette': palette,
          ...(theme === 'dark' ? { 'data-theme': 'dark' } : {}),
        },
      ],
    })),
  ),
);

const label = (c: Context) => `${c.style}/${c.palette}/${c.theme}`;

/**
 * Replace every outermost `var(--name[, fallback])` in `value`. Scanned by paren
 * depth rather than matched by a regex, so a nested fallback costs linear time.
 */
function replaceVars(
  value: string,
  replace: (name: string, fallback: string | undefined) => string,
): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start === -1) break;
    out += value.slice(i, start);
    let depth = 1;
    let j = start + 4;
    for (; j < value.length && depth > 0; j += 1) {
      if (value[j] === '(') depth += 1;
      else if (value[j] === ')') depth -= 1;
    }
    const inner = value.slice(start + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    out += replace(name, comma === -1 ? undefined : inner.slice(comma + 1));
    i = j;
  }
  return out + value.slice(i);
}

/** Resolve every `var()` in `value`: the rule's own custom properties first, then the root. */
function resolveIn(ctx: Context, value: string, local: Record<string, string> = {}): string {
  let current = value;
  for (let depth = 0; depth < 16 && current.includes('var('); depth += 1) {
    current = replaceVars(current, (name, fallback) => {
      if (local[name] !== undefined) return local[name]!;
      const { value: resolved, unresolved } = resolveTokenInScope(LAYER.rules, ctx.chain, name);
      if (resolved && unresolved.length === 0) return resolved;
      return fallback !== undefined ? fallback.trim() : `UNRESOLVED(${name})`;
    });
  }
  return current.replace(/\s+/g, ' ').trim();
}

function colourIn(ctx: Context, value: string, local?: Record<string, string>): Rgba | undefined {
  return evaluate(resolveIn(ctx, value, local));
}

/** Split one gradient into its colour stops, dropping the direction / shape argument. */
function gradientStops(gradient: string): string[] {
  const inner = /^[a-z-]*gradient\(([\s\S]*)\)$/.exec(gradient.trim());
  if (!inner) return [];
  const args = topLevelSplit(inner[1]!);
  return args
    .map((arg) => arg.replace(/(\s+-?[\d.]+(%|px|deg|turn)?)+$/i, '').trim())
    .filter((arg) => evaluate(arg) !== undefined);
}

/**
 * The colour-stop LAYERS of a fill, top layer first, as CSS paints them. Layers
 * that `background-size` confines to a partial band (not `100% 100%` / `auto`)
 * are skipped; see the header.
 */
function fillLayers(fill: string, backgroundSize: string | undefined): string[][] {
  const layers = topLevelSplit(fill);
  const sizes = backgroundSize ? topLevelSplit(backgroundSize) : [];
  return layers
    .map((layer, index) => {
      const size = sizes[index]?.trim();
      if (size && size !== '100% 100%' && size !== 'auto' && size !== '100%') return [];
      return gradientStops(layer);
    })
    .filter((stops) => stops.length > 0);
}

/**
 * Flatten a layer stack to the grounds a label can sit on. The BOTTOM layer's
 * stops are composited over `under` (the page ground, or the rule's own opaque
 * colour). A translucent stop in a layer ABOVE is composited over every
 * bottom-layer ground it can overlap, and the worst one is kept. An opaque upper
 * stop is a ground of its own. Overlaps between two upper layers are not
 * modelled, and each upper layer is measured alone.
 */
function flattenLayers(layers: string[][], under: Rgba): (Rgba | undefined)[] {
  if (layers.length === 0) return [];
  const bottom = layers[layers.length - 1]!.map((stop) => {
    const c = evaluate(stop);
    return c && c.a < 1 ? over(c, under) : c;
  });
  const out: (Rgba | undefined)[] = [...bottom];
  const solidBottom = bottom.filter((c): c is Rgba => c !== undefined);
  for (const layer of layers.slice(0, -1)) {
    for (const stop of layer) {
      const c = evaluate(stop);
      if (!c) {
        out.push(undefined);
        continue;
      }
      if (c.a === 0) continue; // a fully transparent stop paints nothing
      if (c.a === 1) out.push(c);
      else out.push(...solidBottom.map((ground) => over(c, ground)));
    }
  }
  return out;
}

// ── The matrix ──────────────────────────────────────────────────────────────

interface Row {
  id: string;
  line: string;
  ratio: number;
  floor: number;
  style: string;
  /** For a painted canvas: the viewport, frame and pixel of the worst point. */
  where?: string;
}

interface Ground {
  hook: Hook;
  name: string;
  hex: string;
}

function groundsFor(ctx: Context): { grounds: Ground[]; unresolved: string[] } {
  const unresolved: string[] = [];
  const grounds: Ground[] = [];
  const page = colourIn(ctx, 'var(--el-page-bg)');
  if (!page) unresolved.push(`${label(ctx)} · --el-page-bg`);
  const pageRgba = page ?? KEYWORDS.white!;

  const push = (hook: Hook, name: string, colour: Rgba | undefined, under: Rgba = pageRgba) => {
    if (!colour) {
      unresolved.push(`${label(ctx)} · ${hook} ${name}`);
      return;
    }
    grounds.push({ hook, name, hex: toHex(colour.a < 1 ? over(colour, under) : colour) });
  };

  for (const hook of SURFACE_HOOKS) {
    const token = GROUND_TOKEN[hook];
    if (!isRepainted(ctx.style, hook)) {
      push(hook, token, colourIn(ctx, `var(${token})`));
      continue;
    }
    const own = hookDeclarations(ctx.style, hook);
    const base = own['background-color']
      ? colourIn(ctx, own['background-color'], own)
      : colourIn(ctx, `var(${token})`);
    push(hook, `own background-color`, base);
    // A canvas `background-image` is measured by painting it (`canvasRows`).
  }

  // The selected tint lies on the row's container, the page ground.
  const selected = hookDeclarations(ctx.style, 'selected')['background-color'];
  if (selected) push('selected', 'own background-color', colourIn(ctx, selected));

  for (const hook of ['pill', 'orb'] as const) {
    const own = hookDeclarations(ctx.style, hook);
    const seam = hook === 'pill' ? '--plan-hero-fill' : '--plan-orb-fill';
    const fill = own[seam] ?? (hook === 'pill' ? PILL_FALLBACK : ORB_FALLBACK);
    const resolvedFill = resolveIn(ctx, fill, own);
    if (resolvedFill === 'none') {
      push(
        hook,
        'own background-color',
        own['background-color'] ? colourIn(ctx, own['background-color'], own) : undefined,
      );
      continue;
    }
    const grounds = flattenLayers(fillLayers(resolvedFill, own['background-size']), pageRgba);
    if (grounds.length === 0) unresolved.push(`${label(ctx)} · ${hook} fill has no stops`);
    grounds.forEach((c, i) => push(hook, `${seam} stop ${i + 1}`, c));
  }
  return { grounds, unresolved };
}

function inkFor(ctx: Context, hook: Hook, ink: string): Rgba | undefined {
  if (hook === 'pill' || hook === 'orb') {
    const own = hookDeclarations(ctx.style, hook);
    return colourIn(ctx, own['color'] ?? 'var(--el-accent-text)', own);
  }
  return colourIn(ctx, `var(${ink})`);
}

function inksFor(ctx: Context, ground: Ground): string[] {
  if (ground.hook === 'pill' || ground.hook === 'orb') return ['label ink'];
  if (ground.hook === 'selected') return HARD_INKS;
  const unpainted = !isRepainted(ctx.style, ground.hook);
  return unpainted && MUTED_GROUNDS.has(ground.name) ? [...HARD_INKS, MUTED_INK] : HARD_INKS;
}

// ── The canvas, painted ─────────────────────────────────────────────────────

/**
 * The viewports a canvas is painted at, one per aspect ratio, since a wash
 * placed in percentages lands somewhere else on each: 16:10 desktop (1440×900,
 * the MOTIR-10707 reproduction; 1280×800 is the same aspect), 16:9 wide, and
 * the 390×844 phone. Its pixel sizes are real, so a wash sized in px is too.
 */
const CANVAS_VIEWPORTS: Viewport[] = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
];
/** Frames sampled across one pass of a canvas animation (the drift is `alternate`, so one pass is all of it). */
const ANIMATION_FRAMES = 8;

/** A `@keyframes <name>` block's `background-position` frames, as `[offset, positions]`. */
function readKeyframes(name: string): [number, [Length, Length][]][] {
  const open = new RegExp(`@keyframes\\s+${name}\\s*\\{`).exec(CSS);
  if (!open) return [];
  let level = 1;
  let end = open.index + open[0].length;
  while (level > 0) {
    if (CSS[end] === '{') level += 1;
    else if (CSS[end] === '}') level -= 1;
    end += 1;
  }
  const body = CSS.slice(open.index + open[0].length, end - 1);
  const frames: [number, [Length, Length][]][] = [];
  for (const [, selector, block] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const position = /background-position\s*:([^;]*)/.exec(block ?? '');
    if (!position) continue;
    for (const offset of topLevelSplit(selector!.trim())) {
      const at =
        offset === 'from' ? 0 : offset === 'to' ? 1 : Number(offset.replace('%', '')) / 100;
      frames.push([at, parsePositionList(position[1]!)]);
    }
  }
  return frames.sort((a, b) => a[0] - b[0]);
}

/**
 * Every way the canvas is painted: still (its declared positions, which is also
 * what a reduced-motion user sees once the drift is switched off), and, when its
 * `animation` names a keyframes block that moves `background-position`, frames
 * across the whole of that animation.
 */
function renderStates(own: Record<string, string>, still: [Length, Length][]): RenderState[] {
  const states: RenderState[] = [{ name: 'still', positions: still }];
  const animation = own['animation'];
  if (!animation) return states;
  const name = animation.split(/\s+/).find((word) => readKeyframes(word).length > 0);
  if (!name) return states;
  const frames = readKeyframes(name);
  // A keyframe list that omits `from` / `to` animates from the element's own value.
  if (frames[0]![0] > 0) frames.unshift([0, still]);
  if (frames[frames.length - 1]![0] < 1) frames.push([1, still]);
  for (let i = 0; i <= ANIMATION_FRAMES; i += 1) {
    const t = i / ANIMATION_FRAMES;
    const next = frames.findIndex(([at]) => at >= t);
    const [hi, lo] = [frames[next]!, frames[Math.max(0, next - 1)]!];
    const w = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
    states.push({
      name: `${name} ${Math.round(t * 100)}%`,
      positions: interpolatePositions(lo[1], hi[1], w),
    });
  }
  return states;
}

/**
 * Everything needed to paint a style's canvas pattern in one context: its
 * ground, its layers, the viewports and frames, and the four hard inks.
 * `'none'` when the style paints no pattern; a string naming what could not be
 * read otherwise. `overrides` substitutes custom properties before resolution:
 * the regression cases below use it to paint values the stylesheet does not ship.
 */
function canvasInput(ctx: Context, overrides: Record<string, string> = {}): CanvasInput | string {
  const own = hookDeclarations(ctx.style, 'canvas');
  if (!own['background-image']) return 'none';
  const local = { ...own, ...overrides };
  const page = colourIn(ctx, 'var(--el-page-bg)', local) ?? KEYWORDS.white!;
  const base = own['background-color'] ? colourIn(ctx, own['background-color'], local) : page;
  const ground = base && base.a < 1 ? over(base, page) : (base ?? page);
  // `currentColor` on the canvas is the canvas's own text colour: `body` sets
  // `color: var(--el-page-text)` in globals.css.
  const currentColour = own['color'] ?? 'var(--el-page-text)';
  try {
    const layers = parseLayers(
      {
        image: resolveIn(
          ctx,
          own['background-image'].replace(/currentColor/gi, currentColour),
          local,
        ),
        size: own['background-size'] && resolveIn(ctx, own['background-size'], local),
        position: own['background-position'] && resolveIn(ctx, own['background-position'], local),
        repeat: own['background-repeat'],
      },
      evaluate,
    );
    const inks = HARD_INKS.map((name) => ({ name, colour: colourIn(ctx, `var(${name})`) }));
    const missing = inks.find((ink) => !ink.colour || ink.colour.a < 1);
    if (missing) return `${label(ctx)} · ${missing.name} (ink on canvas pattern)`;
    return {
      ground,
      layers,
      viewports: CANVAS_VIEWPORTS,
      states: renderStates(
        own,
        layers.map((l) => l.position),
      ),
      inks: inks.map((ink) => ({ name: ink.name, colour: ink.colour! })),
    };
  } catch (error) {
    return `${label(ctx)} · canvas pattern: ${(error as Error).message}`;
  }
}

/** Paint a style's canvas pattern and measure each hard ink against its worst pixel. */
function canvasRows(ctx: Context, overrides: Record<string, string> = {}): InkResult[] | string {
  const input = canvasInput(ctx, overrides);
  return typeof input === 'string' ? input : worstCanvasContrast(input);
}

function buildMatrix(): { rows: Row[]; unresolved: string[]; expected: number } {
  const rows: Row[] = [];
  const unresolved: string[] = [];
  let expected = 0;
  for (const ctx of CONTEXTS) {
    const { grounds, unresolved: missing } = groundsFor(ctx);
    unresolved.push(...missing);
    for (const ground of grounds) {
      const inks = inksFor(ctx, ground);
      expected += inks.length;
      for (const ink of inks) {
        const colour = inkFor(ctx, ground.hook, ink);
        if (!colour || colour.a < 1) {
          unresolved.push(`${label(ctx)} · ${ink} (ink on ${ground.hook})`);
          continue;
        }
        const ratio = contrast(toHex(colour), ground.hex);
        const floor = ground.hook === 'orb' ? WCAG_GRAPHIC_MIN : WCAG_TEXT_MIN;
        const id = `${label(ctx)} · ${ink} on ${ground.hook} (${ground.name})`;
        rows.push({
          id,
          line: `${id} = ${ratio.toFixed(2)}:1`,
          ratio,
          floor,
          style: ctx.style,
        });
      }
    }
    const painted = canvasRows(ctx);
    if (typeof painted === 'string') {
      if (painted !== 'none') unresolved.push(painted);
      continue;
    }
    expected += HARD_INKS.length;
    for (const { ink, ratio, where } of painted) {
      const id = `${label(ctx)} · ${ink} on canvas (pattern)`;
      rows.push({
        id,
        line: `${id} = ${ratio.toFixed(2)}:1`,
        ratio,
        floor: WCAG_TEXT_MIN,
        style: ctx.style,
        where,
      });
    }
  }
  return { rows, unresolved, expected };
}

const MATRIX = buildMatrix();

describe('style × palette × mode AA contrast gate (MOTIR-10674)', () => {
  it('derives the matrix from the three axes, and the derivation is not vacuous', () => {
    expect(STYLE_IDS.length).toBeGreaterThanOrEqual(11);
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(PALETTE_IDS).toContain(BASE_PALETTE_ID);
    expect(CONTEXTS.length).toBeGreaterThanOrEqual(20);
    expect(CONTEXTS.length).toBe(STYLE_IDS.length * PALETTE_IDS.length * THEMES.length);
    expect(MATERIAL.length, 'top-level @scope rules read').toBeGreaterThan(50);
  });

  it('reaches the STYLE axis through resolveTokenInScope (resolveToken refuses data-style)', () => {
    // Dense / Pro's own block sets --radius-card: 6px over the 12px Tier-0 base.
    const ctx = CONTEXTS.find((c) => c.style === 'dense-pro' && c.theme === 'light')!;
    expect(
      resolveTokenInScope(LAYER.rules, ctx.chain, '--radius-card').value,
      'resolveTokenInScope with a data-style chain must see the style block — do not swap in resolveToken',
    ).toBe('6px');
  });

  it('resolves every ink and every ground to a hex in every context, before any ratio', () => {
    expect(MATRIX.unresolved).toEqual([]);
    for (const row of MATRIX.rows) expect(Number.isFinite(row.ratio)).toBe(true);
  });

  it('partitions every hook of every style into exactly one group', () => {
    for (const style of STYLE_IDS) {
      const repainted = SURFACE_HOOKS.filter((h) => isRepainted(style, h));
      const unpainted = SURFACE_HOOKS.filter((h) => !isRepainted(style, h));
      expect([...repainted, ...unpainted].sort()).toEqual([...SURFACE_HOOKS].sort());
      expect(repainted.filter((h) => unpainted.includes(h))).toEqual([]);
    }
    // The control: the four material styles repaint, the token-only ones do not.
    expect(isRepainted('tonal-elevated', 'popover')).toBe(true);
    expect(isRepainted('claymorphism', 'card')).toBe(true);
    expect(isRepainted('memphis', 'canvas')).toBe(true);
    expect(isRepainted('dense-pro', 'card')).toBe(false);
    expect(HOOKS).toHaveLength(9);
    // The selected-row tint is a measured pair (MOTIR-10549 review): Art Deco
    // declares one, in the components layer the reader unwraps.
    expect(hookDeclarations('art-deco', 'selected')['background-color']).toBeDefined();
    expect(
      MATRIX.rows.some((r) => r.id.startsWith('art-deco/') && r.id.includes(' on selected ')),
    ).toBe(true);
  });

  it('records a well-shaped ratio row for every measured pair', () => {
    expect(MATRIX.rows.length).toBe(MATRIX.expected);
    const shape = /^[a-z0-9-]+\/[a-z0-9-]+\/(light|dark) · .+ on .+ = \d+\.\d{2}:1$/;
    const malformed = MATRIX.rows.filter((r) => !shape.test(r.line)).map((r) => r.line);
    expect(malformed).toEqual([]);
  });

  it('every pair clears its floor, except the keyed shipped failures', () => {
    const failing = MATRIX.rows.filter((r) => r.ratio < r.floor);
    const known = Object.fromEntries(
      failing
        .filter((r) => r.id in KNOWN_SHIPPED_FAILURES)
        .map((r) => [r.id, { ratio: r.ratio.toFixed(2), bug: KNOWN_SHIPPED_FAILURES[r.id]!.bug }]),
    );
    const unexplained = failing
      .filter((r) => !(r.id in KNOWN_SHIPPED_FAILURES))
      .map((r) => (r.where ? `${r.line} (worst at ${r.where})` : r.line));
    expect(unexplained, `pairs under the floor:\n${unexplained.join('\n')}`).toEqual([]);
    // Equality, so a pair that now passes must be deleted from the map.
    expect(known).toEqual(KNOWN_SHIPPED_FAILURES);
  });

  // MOTIR-10736 / MOTIR-10737: the measurements that found the blind spot, as
  // regression cases. Each paints a value the stylesheet does not ship, through
  // the same resolver and painter as the matrix, and fails where the browser
  // fails while every layer measured ALONE clears the floor: the overlap is
  // what is being measured.
  const ctxOf = (id: string) => CONTEXTS.find((c) => label(c) === id)!;
  const inkRatio = (rows: InkResult[] | string, ink: string) => {
    if (typeof rows === 'string') throw new Error(rows);
    return rows.find((r) => r.ink === ink)!.ratio;
  };
  const eachLayerAlone = (input: CanvasInput | string, ink: string) => {
    if (typeof input === 'string') throw new Error(input);
    return input.layers.map((layer) =>
      inkRatio(worstCanvasContrast({ ...input, layers: [layer] }), ink),
    );
  };

  it('paints overlapping canvas washes together: aurora at 15% / 15% fails where its ribbons overlap', () => {
    // MOTIR-10709's rendered sweep: 3.86:1 in Chromium (sienna light), green
    // under the per-layer reading this file used to do.
    const ctx = ctxOf('aurora/sienna/light');
    const overrides = { '--aurora-wash': '15%', '--aurora-wash-soft': '15%' };
    const painted = inkRatio(canvasRows(ctx, overrides), '--el-accent-on-surface');
    expect(painted).toBeLessThan(WCAG_TEXT_MIN);
    expect(painted).toBeGreaterThan(3.8);
    for (const alone of eachLayerAlone(canvasInput(ctx, overrides), '--el-accent-on-surface')) {
      expect(alone).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    }
  });

  it('paints overlapping canvas washes together: glassmorphism at 16% fails in its bottom-right corner', () => {
    // MOTIR-10707's rendered sweep: 4.26:1 at (1224,854) in Chromium (motir
    // light), where the --el-link wash and the second --el-accent wash overlap.
    const ctx = ctxOf('glassmorphism/motir/light');
    const overrides = { '--glass-wash': '16%' };
    const rows = canvasRows(ctx, overrides);
    const painted = inkRatio(rows, '--el-accent-on-surface');
    expect(painted).toBeLessThan(WCAG_TEXT_MIN);
    expect(painted).toBeGreaterThan(4.2);
    expect(typeof rows !== 'string' && rows[3]!.where).toMatch(
      /^1440x900 still at \(12\d\d,8\d\d\)$/,
    );
    for (const alone of eachLayerAlone(canvasInput(ctx, overrides), '--el-accent-on-surface')) {
      expect(alone).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    }
  });

  it('paints a canvas animation across its frames, not only at rest', () => {
    const own = hookDeclarations('aurora', 'canvas');
    const states = renderStates(own, []);
    expect(states[0]!.name).toBe('still');
    expect(states).toHaveLength(ANIMATION_FRAMES + 2);
    expect(states.at(-1)!.name).toBe('aurora-drift 100%');
    // The last frame is the `to` keyframe, verbatim.
    expect(states.at(-1)!.positions[0]).toEqual([
      { px: 0, pct: 100 },
      { px: 0, pct: 40 },
    ]);
    expect(renderStates(hookDeclarations('glassmorphism', 'canvas'), [])).toHaveLength(1);
  });

  it('reads --orb-lit-mix from its one declaration and never redeclares it', () => {
    expect([...CSS.matchAll(/--orb-lit-mix\s*:/g)]).toHaveLength(1);
  });
});
