import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STYLE_DEFAULT_TYPE,
  STYLE_DIMENSIONS,
  STYLE_IDS,
  STYLE_REGISTRY,
  resolveStyle,
} from '@/lib/theme/styles';
import { BASE_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { TYPE_IDS } from '@/lib/theme/typography';
import { resolveAxesToApplied } from '@/lib/theme/appearance-resolution';
import { loadTokenLayer } from './paletteCascade';

// MOTIR-10675 — the integration gate for Eight new styles (MOTIR-10549).
//
// Each style card proved its own files. This suite reads the nineteen styles
// TOGETHER against the palettes, the type pairings and the two surfaces that
// list them. It reads registries and stylesheets as data and calls the
// registry-pure resolver. It renders nothing, resolves no custom-property chain
// inside a material rule and computes no contrast ratio: the ratios are
// tests/theme/stylePaletteModeContrast.test.ts, and the rendered material is
// tests/e2e/style-material-isolation.spec.ts. The picker half, which renders, is
// tests/components/stylePickerNineteen.test.tsx.
//
// Every population is derived: STYLE_IDS, PALETTE_IDS, TYPE_IDS and the
// stylesheet's own @scope preludes. The only literal counts are the composed
// nineteen and its eight-id slice. The one literal list is the eleven ids that
// shipped before the story, because "still present in their shipped order" can
// only be asserted against what shipped.

const PACKAGE_CSS = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The eleven styles that shipped before this story, in gallery order. */
const SHIPPED_STYLES = [
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
] as const;

/** The eight new styles: the ids after Retrofuturism, as the level fixed them. */
const NEW_STYLES = STYLE_IDS.slice(STYLE_IDS.indexOf('retrofuturism') + 1);

const THEMES = ['light', 'dark'] as const;

/** A colour or element-palette token. */
const COLOUR_TOKEN = /^--(?:color|el)-/;

// ── The scope-anchored material layer ────────────────────────────────────────
// A local copy of the registry suite's `SCOPE_OPEN` finder, which is scoped to
// its own `describe` and not exported. An `@scope` block nests a rule (or a
// few) inside it, so the body is found by brace MATCHING, not by a regex.

const SCOPE_OPEN = /@scope\s*\(\[data-style='([^']+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;

interface ScopedRule {
  style: string;
  selector: string;
  body: string;
}

function scopedRules(source: string): ScopedRule[] {
  const css = stripComments(source);
  const out: ScopedRule[] = [];
  SCOPE_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = SCOPE_OPEN.exec(css)) !== null) {
    let depth = 1;
    let i = open.index + open[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const inner = css.slice(open.index + open[0].length, i - 1);
    // Every `<selector> { <declarations> }` the block holds.
    let cursor = 0;
    while (cursor < inner.length) {
      const brace = inner.indexOf('{', cursor);
      if (brace === -1) break;
      let d = 1;
      let j = brace + 1;
      for (; j < inner.length && d > 0; j += 1) {
        if (inner[j] === '{') d += 1;
        else if (inner[j] === '}') d -= 1;
      }
      out.push({
        style: open[1] ?? '',
        selector: inner.slice(cursor, brace).trim(),
        body: inner.slice(brace + 1, j - 1),
      });
      cursor = j;
    }
    SCOPE_OPEN.lastIndex = i;
  }
  return out;
}

/** Declarations as [name, value] pairs, top level of a rule body. */
function declarations(body: string): [string, string][] {
  return body
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl.includes(':'))
    .map((decl) => {
      const colon = decl.indexOf(':');
      return [decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()];
    });
}

/** The bare `[data-style='<id>'] { … }` token block in a stylesheet, if any. */
function bareBlock(css: string, id: string): string | undefined {
  const re = new RegExp(`(?:^|[}\\s])\\[data-style='${id}'\\]\\s*\\{([^}]*)\\}`);
  return re.exec(stripComments(css))?.[1];
}

describe('the composed registry (MOTIR-10675)', () => {
  it('holds nineteen ids: the eleven shipped in order, then eight new ones', () => {
    expect(STYLE_IDS).toHaveLength(19);
    expect(new Set(STYLE_IDS).size).toBe(STYLE_IDS.length);
    const missing = SHIPPED_STYLES.filter((id) => !STYLE_IDS.includes(id));
    expect(missing, `shipped styles missing: ${missing.join(', ')}`).toEqual([]);
    const shippedOrder = STYLE_IDS.filter((id) =>
      (SHIPPED_STYLES as readonly string[]).includes(id),
    );
    expect(shippedOrder).toEqual([...SHIPPED_STYLES]);
    expect(NEW_STYLES).toHaveLength(8);
    expect(NEW_STYLES.filter((id) => (SHIPPED_STYLES as readonly string[]).includes(id))).toEqual(
      [],
    );
  });

  it('gives each new style a complete entry, reported by id', () => {
    const problems: string[] = [];
    for (const id of NEW_STYLES) {
      const entry = STYLE_REGISTRY[id];
      if (entry.id !== id) problems.push(`${id}: id field is ${entry.id}`);
      for (const field of ['name', 'tagline', 'inspiration'] as const) {
        if (!entry[field]?.trim()) problems.push(`${id}: empty ${field}`);
      }
      if (!/^docs\/styles\/[a-z0-9-]+\.md$/.test(entry.designDoc)) {
        problems.push(`${id}: designDoc ${entry.designDoc} is not under docs/styles`);
      } else if (!existsSync(join(process.cwd(), entry.designDoc))) {
        problems.push(`${id}: designDoc ${entry.designDoc} does not exist`);
      }
      for (const { key } of STYLE_DIMENSIONS) {
        if (!entry.dimensions[key]?.trim()) problems.push(`${id}: empty dimension ${key}`);
      }
      if (!TYPE_IDS.includes(entry.defaultTypeId)) {
        problems.push(`${id}: defaultTypeId ${entry.defaultTypeId} is not a registered pairing`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the eight new token blocks, in the package stylesheet alone', () => {
  it('ships a bare block for every new id', () => {
    const missing = NEW_STYLES.filter((id) => bareBlock(PACKAGE_CSS, id) === undefined);
    expect(missing, `no bare [data-style] block in theme.css for: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('declares no colour, element-palette or font token in any of them', () => {
    const bleed: string[] = [];
    for (const id of NEW_STYLES) {
      for (const [name] of declarations(bareBlock(PACKAGE_CSS, id) ?? '')) {
        if (COLOUR_TOKEN.test(name) || name.startsWith('--font-')) bleed.push(`${id}: ${name}`);
      }
    }
    expect(bleed).toEqual([]);
  });
});

describe('the scope-anchored material layer of the new styles', () => {
  const { css } = loadTokenLayer();
  const RULES = scopedRules(css);
  const NEW_RULES = RULES.filter((rule) => (NEW_STYLES as string[]).includes(rule.style));

  it('anchors at least one scoped block on every new id, and none on an unknown id', () => {
    expect(RULES.length).toBeGreaterThan(0);
    const bare = NEW_STYLES.filter((id) => !RULES.some((rule) => rule.style === id));
    expect(bare, `no @scope block for: ${bare.join(', ')}`).toEqual([]);
    const strays = [...new Set(RULES.map((rule) => rule.style))].filter(
      (id) => !(STYLE_IDS as string[]).includes(id),
    );
    expect(strays, `@scope anchored on unregistered ids: ${strays.join(', ')}`).toEqual([]);
    // Each new style's hero rule, at minimum.
    const noHero = NEW_STYLES.filter(
      (id) =>
        !NEW_RULES.some(
          (rule) => rule.style === id && rule.selector.includes("[data-surface='ai-cta']"),
        ),
    );
    expect(noHero, `no hero AI-control rule for: ${noHero.join(', ')}`).toEqual([]);
  });

  it('paints only palette-derived colour and carries no hex literal (rule granularity)', () => {
    /** Values that pin no hue. */
    const HUELESS = /^(?:transparent|none|inherit|initial|unset|revert|currentColor)$/i;
    const problems: string[] = [];
    let painting = 0;
    for (const rule of NEW_RULES) {
      const where = `${rule.style} ${rule.selector}`;
      if (/#[0-9a-f]{3,8}\b/i.test(rule.body)) problems.push(`${where}: hex literal`);
      const paints = declarations(rule.body)
        .filter(([name]) => /(?:background|color)/i.test(name) && !name.startsWith('--'))
        .map(([, value]) => value)
        .filter((value) => !HUELESS.test(value));
      if (paints.length === 0) continue;
      painting += 1;
      if (!/var\(--(?:color|el)-|currentColor/i.test(rule.body)) {
        problems.push(`${where}: paints ${paints.join(', ')} with no palette token`);
      }
    }
    expect(painting).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

describe('the colour axis moves no shape', () => {
  const { paletteBlock } = loadTokenLayer();

  it('declares only colour and element-palette tokens in every palette block', () => {
    const problems: string[] = [];
    const empty: string[] = [];
    let blocks = 0;
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        const names = Object.keys(paletteBlock(palette, theme));
        blocks += 1;
        if (names.length === 0 && theme === 'light') empty.push(palette);
        for (const name of names) {
          if (!COLOUR_TOKEN.test(name)) problems.push(`${palette}/${theme}: ${name}`);
        }
      }
    }
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(blocks).toBe(PALETTE_IDS.length * THEMES.length);
    expect(problems).toEqual([]);
    // The base palette's values ARE the base layer, so its light block is empty
    // by construction; every other palette must declare something.
    expect(empty).toEqual([BASE_PALETTE_ID]);
  });

  it('declares no colour token in any style block, shipped or new', () => {
    const bleed: string[] = [];
    for (const id of STYLE_IDS) {
      for (const [name] of declarations(bareBlock(PACKAGE_CSS, id) ?? '')) {
        if (COLOUR_TOKEN.test(name)) bleed.push(`${id}: ${name}`);
      }
    }
    expect(bleed).toEqual([]);
  });
});

describe('the style axis composes with every palette and pairing', () => {
  it('resolves each style × palette cell to its own default pairing', () => {
    expect(STYLE_IDS.length).toBeGreaterThanOrEqual(19);
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    const wrong: string[] = [];
    let cells = 0;
    for (const styleId of STYLE_IDS) {
      for (const paletteId of PALETTE_IDS) {
        cells += 1;
        const applied = resolveAxesToApplied({ styleId, paletteId });
        if (
          applied.styleId !== styleId ||
          applied.paletteId !== paletteId ||
          applied.typeId !== STYLE_DEFAULT_TYPE[styleId] ||
          applied.typePinned !== false
        ) {
          wrong.push(`${styleId} × ${paletteId}: ${JSON.stringify(applied)}`);
        }
      }
    }
    expect(cells).toBe(STYLE_IDS.length * PALETTE_IDS.length);
    expect(wrong).toEqual([]);
  });

  it('keeps a pinned pairing under every style', () => {
    expect(TYPE_IDS.length).toBeGreaterThanOrEqual(2);
    const paletteId = PALETTE_IDS[PALETTE_IDS.length - 1]!;
    const wrong: string[] = [];
    let cells = 0;
    for (const styleId of STYLE_IDS) {
      for (const typeId of TYPE_IDS) {
        cells += 1;
        const applied = resolveAxesToApplied({ styleId, paletteId, typeId });
        if (
          applied.styleId !== styleId ||
          applied.paletteId !== paletteId ||
          applied.typeId !== typeId ||
          applied.typePinned !== true
        ) {
          wrong.push(`${styleId} × ${typeId}: ${JSON.stringify(applied)}`);
        }
      }
    }
    expect(cells).toBe(STYLE_IDS.length * TYPE_IDS.length);
    expect(wrong).toEqual([]);
  });

  it.each(['nope', 'default'])(
    'falls an unregistered style id (%s) back to warm-editorial',
    (stored) => {
      expect(resolveStyle(stored).id).toBe('warm-editorial');
      const paletteId = PALETTE_IDS[PALETTE_IDS.length - 1]!;
      const typeId = TYPE_IDS[TYPE_IDS.length - 1]!;
      expect(resolveAxesToApplied({ styleId: stored, paletteId, typeId })).toMatchObject({
        styleId: 'warm-editorial',
        paletteId,
        typeId,
        typePinned: true,
      });
    },
  );
});
