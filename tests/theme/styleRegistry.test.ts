import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE_ID,
  STYLE_DIMENSIONS,
  STYLE_IDS,
  STYLE_REGISTRY,
  isStyleId,
  resolveStyle,
} from '@/lib/theme/styles';
import { isTypeId } from '@/lib/theme/typography';

// Subtask 7.3.32 — the named-style registry is the single source of truth for
// the `data-style` axis: the runtime contract, the `/tokens` toggle, the init
// script's validation list, and every later "Style: …" subtask read from it.
// This suite pins the contract the foundation must hold: the two existing
// styles are registered, the style→DESIGN.md mapping resolves to a real file,
// each style is total over the feel-bearing dimensions, and the style axis is
// kept disjoint from the colour (palette) axis in globals.css.

// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS =
  readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8') +
  readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

describe('style registry', () => {
  it('registers the styles in gallery order (Warm Editorial + Soft / Playful + Swiss / Minimal-Flat + Neo-Brutalism + Glassmorphism + Cybercore / Y2K + Aurora + 3D / Immersive + Neumorphism + Hand-Drawn / Indie + Retrofuturism)', () => {
    expect(STYLE_IDS).toEqual([
      'warm-editorial',
      'soft-playful',
      'swiss-minimal-flat',
      'neo-brutalism',
      'glassmorphism',
      'cybercore-y2k',
      'aurora',
      '3d-immersive',
      'neumorphism',
      'hand-drawn-indie',
      'retrofuturism',
    ]);
    expect(STYLE_REGISTRY['warm-editorial'].name).toBe('Warm Editorial');
    expect(STYLE_REGISTRY['soft-playful'].name).toBe('Soft / Playful');
    expect(STYLE_REGISTRY['swiss-minimal-flat'].name).toBe('Swiss / Minimal-Flat');
    expect(STYLE_REGISTRY['neo-brutalism'].name).toBe('Neo-Brutalism');
    expect(STYLE_REGISTRY['glassmorphism'].name).toBe('Glassmorphism');
    expect(STYLE_REGISTRY['cybercore-y2k'].name).toBe('Cybercore / Y2K');
    expect(STYLE_REGISTRY['aurora'].name).toBe('Aurora');
    expect(STYLE_REGISTRY['3d-immersive'].name).toBe('3D / Immersive');
    expect(STYLE_REGISTRY['neumorphism'].name).toBe('Neumorphism');
    expect(STYLE_REGISTRY['hand-drawn-indie'].name).toBe('Hand-Drawn / Indie');
    expect(STYLE_REGISTRY['retrofuturism'].name).toBe('Retrofuturism');
  });

  it('keeps every entry self-consistent (key === id) and STYLE_IDS in sync', () => {
    expect(STYLE_IDS).toEqual(Object.keys(STYLE_REGISTRY));
    for (const id of STYLE_IDS) {
      expect(STYLE_REGISTRY[id].id).toBe(id);
    }
  });

  it('resolves the default to a registered style', () => {
    expect(STYLE_IDS).toContain(DEFAULT_STYLE_ID);
    expect(DEFAULT_STYLE_ID).toBe('warm-editorial');
  });

  it('characterizes every feel-bearing dimension for every style (totality)', () => {
    const dimensionKeys = STYLE_DIMENSIONS.map((d) => d.key);
    for (const id of STYLE_IDS) {
      const dims = STYLE_REGISTRY[id].dimensions;
      expect(Object.keys(dims).sort()).toEqual([...dimensionKeys].sort());
      for (const key of dimensionKeys) {
        expect(dims[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('maps every style to a DESIGN.md that exists on disk', () => {
    for (const id of STYLE_IDS) {
      const doc = STYLE_REGISTRY[id].designDoc;
      expect(doc).toBe(`docs/styles/${id}.md`);
      expect(existsSync(join(process.cwd(), doc))).toBe(true);
    }
  });
});

describe('isStyleId / resolveStyle', () => {
  it('accepts registered ids and rejects unknown / legacy values', () => {
    expect(isStyleId('warm-editorial')).toBe(true);
    expect(isStyleId('soft-playful')).toBe(true);
    // The pre-7.3.32 display-style values are no longer valid style ids.
    expect(isStyleId('default')).toBe(false);
    expect(isStyleId('soft')).toBe(false);
    expect(isStyleId('')).toBe(false);
    expect(isStyleId(null)).toBe(false);
    expect(isStyleId(undefined)).toBe(false);
  });

  it('resolves a stale / unknown value to the default style', () => {
    expect(resolveStyle('default').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle('nope').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle('soft-playful').id).toBe('soft-playful');
  });
});

describe('runtime contract in globals.css', () => {
  it('ships a [data-style] block for every style, including the Tier-0 default', () => {
    for (const id of STYLE_IDS) {
      expect(GLOBALS_CSS).toContain(`[data-style='${id}']`);
    }
  });

  it('keeps the default style block at parity with every Tier-0 shape/feel token', () => {
    const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const tier0 = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1];
    const base = css.match(/\[data-style='warm-editorial'\]\s*\{([^}]*)\}/)?.[1];
    expect(tier0).toBeDefined();
    expect(base).toBeDefined();

    const shapeToken =
      /^--(?:radius|shadow|spacing|height|transition)-(?!.*-color)|^--(?:hover|active)-scale$|^--focus-ring-(?:width|offset)$/;
    const declarations = (body: string) =>
      new Map(
        [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
          .filter(([, name]) => shapeToken.test(name ?? ''))
          .map(([, name, value]) => [name, value?.trim()]),
      );

    expect(declarations(base ?? '')).toEqual(declarations(tier0 ?? ''));
  });

  it('keeps the style axis disjoint from colour AND type — no colour or font token in a [data-style] token block', () => {
    // Extract each bare `[data-style='…'] { … }` TOKEN block and assert it sets
    // only shape/feel tokens, never a `--color-*` / `--el-*` colour token (the
    // independent data-palette axis) NOR a `--font-*` role token (the
    // independent data-type axis, 7.3.53 — type used to live here and moved out).
    // Scope-anchored material rules (`@scope ([data-style='id']) to
    // ([data-style]) { [data-surface] { … } }`, MOTIR-3997) are NOT token
    // blocks and are checked separately below.
    // Strip CSS comments first so a comment that merely MENTIONS a token (e.g.
    // "sets no --font-* token") can't be mistaken for a real declaration.
    const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /\[data-style='[^']+'\]\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    let blocksChecked = 0;
    while ((match = blockRe.exec(css)) !== null) {
      const body = match[1];
      blocksChecked += 1;
      expect(body).not.toMatch(/--color-/);
      expect(body).not.toMatch(/--el-/);
      expect(body).not.toMatch(/--font-/);
    }
    expect(blocksChecked).toBeGreaterThanOrEqual(STYLE_IDS.length - 1);
  });
});

describe('style → type axis integration (7.3.53)', () => {
  it('every style declares a valid defaultTypeId (a registered type pairing)', () => {
    for (const id of STYLE_IDS) {
      expect(isTypeId(STYLE_REGISTRY[id].defaultTypeId)).toBe(true);
    }
  });

  it('preserves the migrated styles’ out-of-the-box type feel', () => {
    // The per-style `--font-serif` overrides moved to the data-type axis; the
    // styles keep their look via defaultTypeId (zero visual regression).
    expect(STYLE_REGISTRY['swiss-minimal-flat'].defaultTypeId).toBe('motir-sans');
    expect(STYLE_REGISTRY['neo-brutalism'].defaultTypeId).toBe('motir-mono');
    expect(STYLE_REGISTRY['cybercore-y2k'].defaultTypeId).toBe('motir-mono');
    // Retrofuturism ships the wide geometric grotesque as its retro-display read.
    expect(STYLE_REGISTRY['retrofuturism'].defaultTypeId).toBe('grotesk');
    // Hand-Drawn / Indie ships the hand-lettered Marker pairing (MOTIR-10553).
    expect(STYLE_REGISTRY['hand-drawn-indie'].defaultTypeId).toBe('marker');
    // Styles that never overrode type stay on the base pairing.
    expect(STYLE_REGISTRY['warm-editorial'].defaultTypeId).toBe('motir');
    expect(STYLE_REGISTRY['glassmorphism'].defaultTypeId).toBe('motir');
  });
});

describe('surface-material layer in globals.css (the 7.3.35 contract extension)', () => {
  // A SURFACE-MATERIAL style (glassmorphism, and later cybercore / aurora / …)
  // may own its surface — translucency, a gradient canvas, frosted
  // backdrop-blur, light borders — that the shape-only token block cannot
  // express. It does so via STYLE-SCOPED component rules (distinct from the
  // bare token block, which stays colour-free above). To keep the style axis
  // disjoint from the palette axis, that material MUST be PALETTE-DERIVED:
  // every colour comes from `color-mix()` / `var(--color-*|--el-*)` over the
  // ACTIVE palette — NEVER a raw hue. So a palette swap re-tints the glass; a
  // style swap leaves hues be.

  // ⚠️ MOTIR-3997 MOVED THE ANCHOR, so this finder reads the @scope PRELUDE.
  // The material layer used to ship as descendant rules
  // (`[data-style='id'] <selector> { … }`), found here by the text regex
  // `/\[data-style='[^']+'\]\s+[^{};]+\{/`. A descendant combinator does not
  // stop at a nested `data-style`, so every one of them matched straight
  // through a scoped `StyleVignette` tile; they now ship as
  //
  //   @scope ([data-style='id']) to ([data-style]) { <selector> { … } }
  //
  // where `to (…)` is a scoping LIMIT — the nearest `[data-style]` descendant
  // and its subtree leave the scope. See
  // docs/decisions/scoped-preview-isolation.md. The old regex matches NONE of
  // the rewritten rules, which is why the parser had to land in the same
  // commit as the rewrite.
  const SCOPE_OPEN = /@scope\s*\(\[data-style='([^']+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;

  /**
   * Every scope-anchored material rule in the token layer, as
   * `{ style, selector, body }`.
   *
   * Hand-scanned rather than regexed end-to-end: a `@scope` block nests one
   * rule inside it, so the population needs brace MATCHING — a `([^}]*)` body
   * would stop at the inner rule's own closing brace and silently under-count.
   * Comments are stripped first so a comment mentioning a hex or a `}` cannot
   * be read as a declaration (the token-block check above strips them for the
   * same reason).
   */
  function scopedMaterialRules(source: string): { style: string; body: string }[] {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: { style: string; body: string }[] = [];
    SCOPE_OPEN.lastIndex = 0;
    let open: RegExpExecArray | null;
    while ((open = SCOPE_OPEN.exec(css)) !== null) {
      // Walk to the `@scope` block's matching close brace.
      let depth = 1;
      let i = open.index + open[0].length;
      for (; i < css.length && depth > 0; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
      }
      const inner = css.slice(open.index + open[0].length, i - 1);
      // The block holds exactly one rule: `<selector> { <declarations> }`.
      const brace = inner.indexOf('{');
      if (brace === -1) continue;
      out.push({
        style: open[1] ?? '',
        body: inner.slice(brace + 1, inner.lastIndexOf('}')),
      });
      SCOPE_OPEN.lastIndex = i;
    }
    return out;
  }

  const MATERIAL_RULES = scopedMaterialRules(GLOBALS_CSS);

  it('anchors every material rule in a `@scope … to ([data-style])` block (69 at MOTIR-3997)', () => {
    // A RATCHET, and the number is the point. A material rule authored as a
    // plain descendant in future is not merely unscoped — it is invisible to
    // the finder above, so the palette-derivation assertion below would stop
    // seeing it while staying green. The floor is what turns "uncounted" into
    // a failure. Raise it when the layer legitimately grows; never lower it
    // without saying which rule left the scope and why.
    expect(MATERIAL_RULES.length).toBeGreaterThanOrEqual(69);
    for (const rule of MATERIAL_RULES) {
      expect(isStyleId(rule.style)).toBe(true);
    }
  });

  it('derives every material colour from the active palette — color-mix/var, never a raw hue', () => {
    // ⚠️ WIDENED AT MOTIR-4253, ON THE RECORD — a rule that REMOVES a colour is
    // not a rule that paints one.
    //
    // The membership test below matches `border-right-color` and
    // `background-color` through its `color` arm, which is right: those DO paint
    // a colour-bearing surface, usually. But 3D / Immersive's shell chrome takes
    // a colour AWAY — the rail's shared edge goes `border-right-color:
    // transparent` because a floating panel has a shadow instead of an edge, and
    // the top bar's fill goes `background-color: transparent` so the immersive
    // atmosphere runs under the lid. Both were REQUIRED to name a palette token
    // they have no use for, by a proxy that reads the PROPERTY and never the
    // VALUE.
    //
    // So the value test moved onto the values, and the guarantee is strictly
    // stronger rather than weaker: a rule that paints ANY hue at all — via a
    // token, a `color-mix`, an `rgb()` or a hex — still has to derive it from
    // the palette, and the hex ban below still runs on EVERY rule in the
    // population including the hueless ones. What is exempted is exactly the set
    // of rules that pin no hue by construction, and the floor on
    // `paletteAsserted` is what stops that exemption from quietly swallowing the
    // population it was carved out of.
    /** Values that pin NO hue — they remove colour rather than paint it. */
    const HUELESS = /^(?:transparent|none|inherit|initial|unset|revert|currentColor)$/i;

    let materialRulesChecked = 0;
    let paletteAsserted = 0;
    for (const rule of MATERIAL_RULES) {
      const body = rule.body;
      // Only assert on rules that actually paint a colour-bearing surface.
      if (!/(?:background|background-color|background-image|border-color|color)\s*:/.test(body)) {
        continue;
      }
      materialRulesChecked += 1;

      // The colour-bearing declarations WITH their values. The property pattern
      // is deliberately as loose as the membership test above, so splitting on
      // the value cannot narrow the population being examined.
      const paints = [...body.matchAll(/([\w-]*(?:background|color)[\w-]*)\s*:\s*([^;]+)/gi)]
        .map(([, , value]) => value!.trim())
        .filter((value) => !HUELESS.test(value));

      if (paints.length > 0) {
        paletteAsserted += 1;
        // Palette-derived: the rule must take its colour from the active palette —
        // either a palette token (`var(--color-*|--el-*)`, e.g. glassmorphism's
        // frosted surfaces + washes) or `currentColor` (the inherited palette hue,
        // e.g. cybercore-y2k's glow grid). Both pin NO hue of their own.
        expect(body, `[data-style='${rule.style}'] paints ${paints.join(', ')}`).toMatch(
          /var\(--(?:color|el)-|currentColor/i,
        );
      }
      // …and must NOT hardcode a raw hue (a hex colour literal). Shadow ink
      // (rgba(15,15,15,…)) lives in the token block, not in a material rule.
      // Unconditional: a hueless rule has no excuse for a hex either.
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    // Glassmorphism ships the canvas + frosted card/popover/modal/sidebar/input
    // material rules; guard that the matcher actually found them. This is a
    // PROPER SUBSET of MATERIAL_RULES — 32 of the 69 at MOTIR-3997 paint a
    // colour-bearing property at all, the rest carrying only shadow, radius,
    // transform or transition — so the 69 ratchet lives on the population above
    // and this floor stays where it was.
    expect(materialRulesChecked).toBeGreaterThanOrEqual(4);
    // And the palette assertion must still REACH most of that population. A
    // widening whose exemption grew to cover everything would leave the test
    // above green with nothing derived, which is the failure mode of the change
    // itself rather than of the stylesheet.
    expect(paletteAsserted).toBeGreaterThanOrEqual(4);
  });
});
