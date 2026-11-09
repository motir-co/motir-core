import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_PALETTE_ID,
  DEFAULT_PALETTE_ID,
  PALETTE_IDS,
  PALETTE_REGISTRY,
  resolvePalette,
} from '@/lib/theme/palettes';
import { resolveAxesToApplied } from '@/lib/theme/appearance-resolution';
import { DEFAULT_STYLE_ID, STYLE_IDS, defaultTypeForStyle } from '@/lib/theme/styles';
import { THEME_DEFAULTS } from '@/lib/theme/types';
import {
  declaredIn,
  loadTokenLayer,
  resolveTokenInScope,
  resolveValue,
  type ScopeChain,
  type ThemeContext,
} from './paletteCascade';

// MOTIR-10717 — the integration gate for MOTIR-10550's four new palettes.
//
// Each palette card (MOTIR-10713 … 10716) shipped one registry entry, one light
// block plus its two-selector dark companion, a doc, a swatch and its id in the
// three suites that pin the id list — and could assert only its own row. This
// suite is the SET: the claims no single palette card can make, because each
// needs every palette in view at once.
//
//   1. The four ids are the registry's tail after the shipped ten, in any order.
//   2. The ten shipped palettes resolve exactly as they did in a tree that had
//      only ten (a recorded fixture, so a cascade-order leak from a new block is
//      caught even though every per-palette suite measures only its own block).
//   3. Every registered id round-trips AND an unregistered one still collapses.
//   4. No module-local exception list gained a new-palette entry. Those lists
//      cannot be imported, so they are read from their declaring source, and
//      every read asserts it FOUND its declaration — a rename fails loudly.
//   5. Each new id reaches the shipped resolver under every style and mode.
//
// Every guard below is written so it cannot pass vacuously: a parse that finds
// nothing, a fixture compared against the tree it came from, or a round-trip a
// collapse-everything resolver would satisfy are each checked for.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The ten palettes that shipped before MOTIR-10550, in their shipped order. */
const SHIPPED_TEN = [
  'motir',
  'amethyst',
  'cobalt',
  'evergreen',
  'spectrum',
  'amber',
  'sienna',
  'garnet',
  'citrine',
  'candy',
] as const;

/** DERIVED, never a literal: whatever the four palette cards appended. */
const NEW_IDS = PALETTE_IDS.slice(SHIPPED_TEN.length);
const THEMES = ['light', 'dark'] as const;

const SHEETS = ['app/globals.css', 'packages/design-system/theme.css'] as const;
const stripBlockComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Strip JS comments from a TypeScript source span. A `//` comment is only
 * recognised at line start or after whitespace, so a `//` inside a string (a
 * URL) is left alone.
 */
const stripJsComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const LAYER = loadTokenLayer();

// ── 1 · The registry, as a set ──────────────────────────────────────────────

describe('the fourteen-palette registry', () => {
  it('keeps the shipped ten as its prefix, and appends four distinct new ids', () => {
    expect(PALETTE_IDS).toHaveLength(14);
    expect(PALETTE_IDS.slice(0, SHIPPED_TEN.length)).toEqual([...SHIPPED_TEN]);
    expect(PALETTE_IDS[0]).toBe('motir');
    expect(PALETTE_IDS[9]).toBe('candy');
    expect(NEW_IDS).toHaveLength(4);
    expect(new Set(NEW_IDS).size).toBe(4);
    for (const id of NEW_IDS) expect(SHIPPED_TEN as readonly string[]).not.toContain(id);
  });

  it('keeps the default and base palette ids where they were', () => {
    expect(DEFAULT_PALETTE_ID).toBe('motir');
    expect(BASE_PALETTE_ID).toBe('amethyst');
  });

  it.each(NEW_IDS)('%s carries its copy and a real design doc', (id) => {
    const entry = PALETTE_REGISTRY[id];
    expect(entry.id).toBe(id);
    expect(entry.name.trim()).not.toBe('');
    expect(entry.tagline.trim()).not.toBe('');
    expect(entry.inspiration.trim()).not.toBe('');

    const doc = entry.designDoc;
    expect(doc.split('/').slice(0, -1).join('/')).toBe('docs/palettes');
    expect(doc.endsWith(`/${id}.md`)).toBe(true);
    expect(existsSync(join(ROOT, doc)), `${doc} exists`).toBe(true);
    const body = read(doc).trim();
    expect(body, `${doc} is not empty`).not.toBe('');
    // A stub or zero-byte doc passes an existence check; it does not carry a heading.
    expect(body, `${doc} carries a Markdown heading`).toMatch(/^#{1,6} \S/m);
  });
});

// ── 2 · The palette blocks in the two sheets ────────────────────────────────

/** Every innermost `{ … }` block whose selector names a palette, across both sheets. */
function paletteBlocks(): { sheet: string; prelude: string; body: string }[] {
  const out: { sheet: string; prelude: string; body: string }[] = [];
  for (const sheet of SHEETS) {
    const css = stripBlockComments(read(sheet));
    for (const [, prelude, body] of css.matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
      if (prelude === undefined || body === undefined) continue;
      if (prelude.includes('[data-palette=')) out.push({ sheet, prelude: prelude.trim(), body });
    }
  }
  return out;
}

const SHAPE_TOKEN = /--(radius|spacing|shadow|height|transition)-[\w-]*\s*:/;
/** The type axis's family — the arm `paletteRegistry.test.ts`'s disjointness guard lacks. */
const FONT_TOKEN = /--(font|tracking|leading)-[\w-]*\s*:/;

describe('each new palette ships its blocks, colour only', () => {
  it.each(NEW_IDS)(
    '%s has a light block and a dark companion under both selector spellings',
    (id) => {
      const light = `[data-palette='${id}']`;
      const darkDescendant = `[data-theme='dark'] [data-palette='${id}']:not([data-theme])`;
      const darkCompound = `[data-palette='${id}'][data-theme='dark']`;
      const lightRule = LAYER.rules.find((r) => r.selectors.includes(light));
      expect(lightRule, `${light} block`).toBeDefined();
      expect(Object.keys(lightRule!.declarations).length).toBeGreaterThan(0);
      const darkRule = LAYER.rules.find(
        (r) => r.selectors.includes(darkDescendant) && r.selectors.includes(darkCompound),
      );
      expect(darkRule, `one dark companion selected by both spellings for ${id}`).toBeDefined();
      expect(Object.keys(darkRule!.declarations).length).toBeGreaterThan(0);
    },
  );

  it('declares no shape / feel token in any [data-palette] block of either sheet', () => {
    const blocks = paletteBlocks();
    // Thirteen override palettes, light + dark each: the parse really found them.
    expect(blocks.length).toBeGreaterThanOrEqual((PALETTE_IDS.length - 1) * 2);
    const offending = blocks
      .filter((b) => SHAPE_TOKEN.test(b.body))
      .map((b) => `${b.sheet}: ${b.prelude}`);
    expect(offending).toEqual([]);
  });

  it('declares no font token in any block of a new palette', () => {
    const blocks = paletteBlocks();
    for (const id of NEW_IDS) {
      const own = blocks.filter((b) => b.prelude.includes(`[data-palette='${id}']`));
      expect(own.length, `${id} blocks found`).toBeGreaterThanOrEqual(2);
      const offending = own.filter((b) => FONT_TOKEN.test(b.body)).map((b) => b.prelude);
      expect(offending, `${id} blocks carrying a font token`).toEqual([]);
    }
    // Control: the matcher sees the type axis's own declarations.
    expect(FONT_TOKEN.test(read('packages/design-system/theme.css'))).toBe(true);
  });
});

// ── 3 · Module-local exception declarations ─────────────────────────────────

/**
 * The source span of `const <name> … = <literal>;` — from `const` to the end
 * of the balanced `[…]` / `{…}` literal it is initialised with. `undefined`
 * when the declaration is not there, which every caller asserts against.
 */
function declarationSpan(src: string, name: string): string | undefined {
  const start = src.search(new RegExp(`\\bconst ${name}\\b`));
  if (start === -1) return undefined;
  const eq = src.indexOf('=', start);
  const open = src.slice(eq).search(/[[{]/) + eq;
  const pair: Record<string, string> = { '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '[' || ch === '{') stack.push(pair[ch]!);
    else if (ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return undefined;
      if (stack.length === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** The literal's contents, comments stripped — `''` for an empty `[]` / `{}`. */
function literalBody(span: string): string {
  const literal = span.slice(span.search(/=\s*[[{]/) + 1).trim();
  return stripJsComments(literal.slice(1, -1)).trim();
}

interface Declaration {
  file: string;
  name: string;
  /** Ships empty, and must stay empty. */
  empty: boolean;
}

const EXCEPTION_DECLARATIONS: Declaration[] = [
  {
    file: 'tests/theme/paletteTokenCoverage.test.ts',
    name: 'KNOWN_PALETTE_INVARIANT',
    empty: false,
  },
  {
    file: 'tests/theme/paletteTokenCoverage.test.ts',
    name: 'TIER0_SOURCES_NO_PALETTE_SETS',
    empty: true,
  },
  {
    file: 'tests/theme/paletteTokenCoverage.test.ts',
    name: 'KNOWN_FAMILY_COLLISIONS',
    empty: true,
  },
  { file: 'tests/theme/familyHueSeparation.test.ts', name: 'KNOWN_SUB_BAR', empty: false },
  { file: 'tests/theme/familyHueSeparation.test.ts', name: 'KNOWN_TOO_CLOSE', empty: true },
  { file: 'tests/theme/familyHueSeparation.test.ts', name: 'KNOWN_CHIP_TOO_CLOSE', empty: true },
  { file: 'tests/theme/statusHueSeparation.test.ts', name: 'KNOWN_SUB_BAR', empty: false },
  { file: 'tests/theme/statusHueSeparation.test.ts', name: 'KNOWN_TOO_CLOSE', empty: true },
];

/** Every `const KNOWN_*` a file declares — so a NEW list is read too, not only the pinned ones. */
const knownDeclarationsIn = (src: string) =>
  [...src.matchAll(/\bconst (KNOWN_[A-Z0-9_]+)\b/g)].map((m) => m[1]!);

describe('no known-exception list gained a new-palette entry', () => {
  const files = [...new Set(EXCEPTION_DECLARATIONS.map((d) => d.file))];

  it.each(EXCEPTION_DECLARATIONS)('$file › $name is found, and names no new palette', (decl) => {
    const span = declarationSpan(read(decl.file), decl.name);
    expect(span, `${decl.file} no longer declares ${decl.name} — update this gate`).toBeDefined();
    const body = literalBody(span!);
    for (const id of NEW_IDS) {
      expect(body.includes(id), `${decl.file} › ${decl.name} names the new palette ${id}`).toBe(
        false,
      );
    }
    if (decl.empty) expect(body, `${decl.file} › ${decl.name} ships empty`).toBe('');
    else expect(body, `${decl.file} › ${decl.name} is read, not matched-nothing`).not.toBe('');
  });

  it.each(files)('%s declares no KNOWN_* list this gate does not read', (file) => {
    const pinned = EXCEPTION_DECLARATIONS.filter((d) => d.file === file).map((d) => d.name);
    const declared = knownDeclarationsIn(read(file));
    expect(declared.filter((name) => !pinned.includes(name))).toEqual([]);
  });

  it('the span reader sees an entry the way a real one would be written', () => {
    // Control: a populated list naming a new id is caught, and comments do not count.
    const id = NEW_IDS[0]!;
    const src = `const KNOWN_X: string[] = [\n  // ${id} was considered\n  '${id}/dark --el-text',\n];`;
    expect(literalBody(declarationSpan(src, 'KNOWN_X')!)).toContain(id);
    const commented = `const KNOWN_X: string[] = [\n  // '${id}/dark --el-text',\n];`;
    expect(literalBody(declarationSpan(commented, 'KNOWN_X')!)).toBe('');
  });
});

// ── 4 · The style × palette × mode AA contrast gate ─────────────────────────

/** Locate the gate in the tree it runs against — never by a hard-coded path. */
function locateGate(): string | undefined {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
      return entry.name.endsWith('.test.ts') ? [path] : [];
    });
  return walk('tests').find((path) => {
    const src = read(path);
    return (
      /style × palette × mode AA contrast gate/.test(src) &&
      /\bconst KNOWN_SHIPPED_FAILURES\b/.test(src)
    );
  });
}

/** `style/palette/mode · ink on hook` keys → their palette segment. */
const gatePaletteSegments = (body: string) =>
  [...body.matchAll(/['"]([a-z0-9-]+)\/([a-z0-9-]+)\/(light|dark) · [^'"]+['"]\s*:/g)].map((m) => ({
    style: m[1]!,
    palette: m[2]!,
    theme: m[3]!,
  }));

describe('the style × palette × mode AA contrast gate covers the new palettes', () => {
  const gatePath = locateGate();

  it('is present in the tree', () => {
    expect(
      gatePath,
      'the style × palette × mode AA contrast gate (a tests/**/*.test.ts declaring KNOWN_SHIPPED_FAILURES) is absent from this tree',
    ).toBeDefined();
  });

  const src = gatePath ? read(gatePath) : '';
  const code = stripJsComments(src);

  it('builds its contexts from the registries, so its count is styles × fourteen × two', () => {
    expect(code).toMatch(/import \{[^}]*\bSTYLE_IDS\b[^}]*\} from '@\/lib\/theme\/styles'/);
    expect(code).toMatch(/import \{[^}]*\bPALETTE_IDS\b[^}]*\} from '@\/lib\/theme\/palettes'/);
    expect(code).toMatch(/const THEMES = \['light', 'dark'\] as const;/);
    expect(code).toMatch(
      /const CONTEXTS: Context\[\] = STYLE_IDS\.flatMap\(\(style\) =>\s*PALETTE_IDS\.flatMap\(\(palette\) =>\s*THEMES\.map\(/,
    );
    // ...and the gate asserts that derivation itself, at run time.
    expect(code).toContain(
      'expect(CONTEXTS.length).toBe(STYLE_IDS.length * PALETTE_IDS.length * THEMES.length)',
    );
    // The registry those contexts are derived from holds the fourteen.
    expect(PALETTE_IDS).toHaveLength(SHIPPED_TEN.length + 4);
  });

  it('labels each row by style, palette and mode, and holds every row to 4.5:1', () => {
    expect(code).toContain('const WCAG_TEXT_MIN = 4.5;');
    expect(code).toMatch(
      /const label = \(c: Context\) => `\$\{c\.style\}\/\$\{c\.palette\}\/\$\{c\.theme\}`;/,
    );
    // Every failing row not in the map is a red run, and the map is equality-checked.
    expect(code).toContain('expect(unexplained, `pairs under the floor:');
    expect(code).toContain('.toEqual([]);');
    expect(code).toContain('expect(known).toEqual(KNOWN_SHIPPED_FAILURES);');
  });

  it('records no shipped failure keyed by a new palette', () => {
    const span = declarationSpan(src, 'KNOWN_SHIPPED_FAILURES');
    expect(
      span,
      `${gatePath} no longer declares KNOWN_SHIPPED_FAILURES — update this gate`,
    ).toBeDefined();
    const body = literalBody(span!);
    const keys = gatePaletteSegments(body);
    if (body === '') {
      // The map ships empty (every earlier failure was fixed under its bug), so
      // no key can name a new palette. Prove the key parser on the gate's own
      // row-id shape instead, so an entry that DID name one would be read.
      const probe = `'${STYLE_IDS[0]}/${NEW_IDS[0]}/dark · --el-text on card': { ratio: '4.10', bug: 'X' },`;
      expect(gatePaletteSegments(probe)).toEqual([
        { style: STYLE_IDS[0], palette: NEW_IDS[0], theme: 'dark' },
      ]);
    } else {
      expect(keys.length, 'the map is populated, so its keys must parse').toBeGreaterThan(0);
      // Every entry parses, so none (a new palette's included) slips past the reader.
      const entries = [...body.matchAll(/^\s*['"][^'"]+['"]\s*:/gm)].length;
      expect(keys.length, 'every entry of the map parses as a row key').toBe(entries);
      for (const key of keys) expect(PALETTE_IDS as readonly string[]).toContain(key.palette);
    }
    expect(keys.filter((key) => (NEW_IDS as readonly string[]).includes(key.palette))).toEqual([]);
  });
});

// ── 5 · Round-trip, and the fallback, together ──────────────────────────────

describe('every registered id round-trips; an unregistered one still collapses', () => {
  const UNKNOWN = 'not-a-registered-palette';

  it('keeps every registered id, and only those, through both resolvers', () => {
    expect(PALETTE_IDS as readonly string[]).not.toContain(UNKNOWN);
    for (const id of PALETTE_IDS) {
      expect(resolvePalette(id).id, `resolvePalette(${id})`).toBe(id);
      expect(resolveAxesToApplied({ paletteId: id }).paletteId, `resolveAxesToApplied(${id})`).toBe(
        id,
      );
    }
    expect(resolvePalette(UNKNOWN).id).toBe('motir');
    expect(resolveAxesToApplied({ paletteId: UNKNOWN }).paletteId).toBe('motir');
  });
});

// ── 6 · The shipped ten resolve as they did in a ten-palette tree ───────────

interface Fixture {
  capture: { commit: string; palettes: string[]; regenerations: unknown[] };
  resolved: Record<string, Record<string, string>>;
}

// Captured ONCE from app/globals.css and packages/design-system/theme.css at
// commit 6e80768 — a tree with exactly ten palettes, so the comparison is not
// the changed tree against itself — with the same loadTokenLayer / declaredIn /
// resolveValue the shipped suites resolve with (paletteRename.test.ts's method).
// A difference is either a LEAK, fixed in the new block that caused it, or a
// deliberate RETUNE of a shipped palette, which regenerates this fixture in that
// same change and appends itself to `capture.regenerations`. An unexplained
// difference is a finding, never a reason to re-record.
const FIXTURE = JSON.parse(read('tests/fixtures/paletteShippedTen.before.json')) as Fixture;

describe('the ten shipped palettes resolve exactly as the ten-palette tree did', () => {
  it('was captured from a ten-palette tree, for the shipped ten in both modes', () => {
    expect(FIXTURE.capture.commit).toBe('6e80768');
    expect(FIXTURE.capture.palettes).toEqual([...SHIPPED_TEN]);
    expect(Object.keys(FIXTURE.resolved).sort()).toEqual(
      SHIPPED_TEN.flatMap((p) => THEMES.map((t) => `${p}/${t}`)).sort(),
    );
    for (const id of NEW_IDS) {
      expect(Object.keys(FIXTURE.resolved).some((key) => key.startsWith(`${id}/`))).toBe(false);
    }
  });

  it('keeps every token the fixture names in the element-token list', () => {
    const now = new Set(LAYER.elementTokens);
    const gone = [
      ...new Set(Object.values(FIXTURE.resolved).flatMap((row) => Object.keys(row))),
    ].filter((token) => !now.has(token));
    expect(gone).toEqual([]);
  });

  it.each(Object.keys(FIXTURE.resolved))('%s matches the fixture token for token', (key) => {
    const [palette, theme] = key.split('/') as [string, ThemeContext['theme']];
    const recorded = FIXTURE.resolved[key]!;
    expect(Object.keys(recorded).length).toBeGreaterThan(100);
    const declarations = declaredIn(LAYER.rules, { palette, theme });
    const moved: string[] = [];
    for (const [token, value] of Object.entries(recorded)) {
      const now = resolveValue(declarations[token] ?? '', declarations).value.toLowerCase();
      if (now !== value) moved.push(`${key} ${token}: ${value} → ${now}`);
    }
    expect(moved, `shipped palette moved:\n${moved.join('\n')}`).toEqual([]);
  });
});

// ── 7 · Each new id reaches the shipped resolver ────────────────────────────

const WALKED = ['--el-page-bg', '--el-card', '--el-text'] as const;

const chainFor = (style: string, palette: string, theme: (typeof THEMES)[number]): ScopeChain => [
  {
    'data-style': style,
    'data-palette': palette,
    ...(theme === 'dark' ? { 'data-theme': 'dark' } : {}),
  },
];

describe('each new id walks registry → resolver → token layer under every style and mode', () => {
  it.each(NEW_IDS)('%s', (id) => {
    const applied = resolveAxesToApplied({ paletteId: id });
    expect(applied).toEqual({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: id,
      typeId: defaultTypeForStyle(DEFAULT_STYLE_ID),
      typePinned: false,
    });

    const problems: string[] = [];
    for (const style of STYLE_IDS) {
      for (const theme of THEMES) {
        for (const token of WALKED) {
          const where = `${style}/${id}/${theme} ${token}`;
          const own = resolveTokenInScope(
            LAYER.rules,
            chainFor(style, applied.paletteId, theme),
            token,
          );
          const base = resolveTokenInScope(
            LAYER.rules,
            chainFor(style, BASE_PALETTE_ID, theme),
            token,
          );
          if (own.value === '') problems.push(`${where} is empty`);
          if (own.unresolved.length > 0 || own.value.includes('var(')) {
            problems.push(`${where} leaves ${own.unresolved.join(', ') || 'a var()'} unresolved`);
          }
          if (own.value === base.value)
            problems.push(`${where} equals the base palette (${base.value})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
