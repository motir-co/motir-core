import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPE_ID,
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  STYLE_DEFAULT_TYPE,
  THEME_STORAGE_KEYS,
  TYPE_IDS,
  buildThemeInitScript,
  resolveAxesToApplied,
  resolveType,
} from '@/lib/theme/init-script';

// MOTIR-10557 — the story gate for MOTIR-10548's four new type pairings
// (marker · rounded · slab · humanist). Each guard reads the SOURCE it checks
// (theme.css, app/fonts.ts, the built init script), not the registry that
// generated it, so a seam a per-pairing test cannot see goes red here:
//   1. theme.css → app/fonts.ts: every `--font-<x>-source` a [data-type] block
//      reads has exactly one next/font loader, joined into fontVariables.
//   2. the type axis contract: one [data-type] block per non-base pairing, each
//      setting exactly the six role pairing / tail tokens (no colour, no shape).
//   3. CJK composition: under every CJK font set, each new pairing's role chain
//      resolves to its own face, then the set's face, then its generic tail.
//   4. the Hand-Drawn default: the resolver and the init script apply Marker to
//      an unpinned Hand-Drawn / Indie, honour a pin, and fall an unknown id back.
// (Per-pairing chains: tests/theme/typographyRegistry.test.ts. Generic-free
//  chains + block totality: packages/design-system/test/fontSetsCss.test.ts.)

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const CSS = read('packages/design-system/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
const FONTS_TS = read('app/fonts.ts');

const ROLES = ['sans', 'serif', 'mono'] as const;
const NEW_TYPE_IDS = ['marker', 'rounded', 'slab', 'humanist'] as const;
const NEW_SOURCES = ['marker', 'rounded', 'slab', 'humanist'].map((x) => `--font-${x}-source`);

// The CSS generic family keywords, plus the vendor system-ui spellings — any of
// them ahead of the font set's face would pre-empt it on a CJK system.
const GENERICS = new Set([
  '-apple-system',
  'blinkmacsystemfont',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

interface Rule {
  selectors: string[];
  decls: [string, string][];
}

/** Every flat rule in theme.css (an at-rule wrapper's own brace is skipped). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = (m[1] ?? '').split(';').pop()?.trim() ?? '';
    const selectors = prelude.split(',').map((s) => s.trim());
    const decls = (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [
          d.slice(0, i).trim(),
          d
            .slice(i + 1)
            .replace(/\s+/g, ' ')
            .trim(),
        ] as [string, string];
      });
    out.push({ selectors, decls });
  }
  return out;
}

const RULES = rules();

/** The rules whose ONLY selector is exactly `[data-type='<id>']`. */
const typeBlocks = RULES.flatMap((r) => {
  if (r.selectors.length !== 1) return [];
  const m = /^\[data-type='([^']+)'\]$/.exec(r.selectors[0] ?? '');
  return m?.[1] ? [{ id: m[1], decls: r.decls }] : [];
});

function typeBlock(id: string): Map<string, string> {
  const found = typeBlocks.filter((b) => b.id === id);
  if (found.length !== 1)
    throw new Error(`expected one [data-type='${id}'] block, found ${found.length}`);
  return new Map(found[0]?.decls ?? []);
}

/** A value's top-level comma-separated items (commas inside var() stay put). */
function items(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const isGeneric = (item: string) => GENERICS.has(item.replace(/['"]/g, '').toLowerCase());

describe('type pairings story gate (MOTIR-10557)', () => {
  it('backs every -source var a [data-type] block reads with one loader in fontVariables', () => {
    const blockCss = typeBlocks.flatMap((b) => b.decls.map(([, v]) => v)).join('\n');
    const read = [
      ...new Set([...blockCss.matchAll(/var\(\s*(--font-[\w-]+-source)/g)].map((m) => m[1] ?? '')),
    ];
    for (const source of NEW_SOURCES) expect(read).toContain(source);

    const loaders = [...FONTS_TS.matchAll(/const (\w+) = \w+\(\{([^}]*)\}\);/g)].map((m) => ({
      name: m[1] ?? '',
      variable: /variable:\s*'([^']+)'/.exec(m[2] ?? '')?.[1],
    }));
    const joined = /export const fontVariables = \[([^\]]*)\]/.exec(FONTS_TS)?.[1] ?? '';
    const inVariables = new Set([...joined.matchAll(/(\w+)\.variable/g)].map((m) => m[1]));

    for (const source of read) {
      const owners = loaders.filter((l) => l.variable === source);
      expect(
        owners.map((o) => o.name),
        source,
      ).toHaveLength(1);
      expect(inVariables.has(owners[0]?.name), `${owners[0]?.name}.variable in fontVariables`).toBe(
        true,
      );
    }
  });

  it('has one [data-type] block per non-base pairing, each setting exactly the six role tokens', () => {
    const expected = TYPE_IDS.filter((id) => id !== DEFAULT_TYPE_ID).sort();
    expect(expected).toHaveLength(9);
    expect(typeBlocks.map((b) => b.id).sort()).toEqual(expected);
    const six = ROLES.flatMap((r) => [`--font-${r}-pairing`, `--font-${r}-tail`]).sort();
    for (const b of typeBlocks) {
      expect(b.decls.map(([n]) => n).sort(), b.id).toEqual(six);
    }
  });

  it('composes each new pairing as its face, then the CJK set face, then its tail', () => {
    const composition = RULES.find(
      (r) =>
        r.selectors.join(', ') ===
        ':root, [data-type], [lang], [data-font-set-sans], [data-font-set-serif], [data-font-set-mono]',
    );
    expect(composition).toBeDefined();
    const roleValue = new Map(composition?.decls ?? []);
    const cjk = FONT_SET_IDS.filter((id) => FONT_SET_REGISTRY[id].cjk);
    expect(cjk).toHaveLength(4);

    let checked = 0;
    for (const id of NEW_TYPE_IDS) {
      const block = typeBlock(id);
      for (const setId of cjk) {
        const langBlock = RULES.find(
          (r) =>
            r.selectors.length === 1 &&
            r.selectors[0] === `[lang]:lang(${FONT_SET_REGISTRY[setId].lang})`,
        );
        const script = new Map(langBlock?.decls ?? []);
        for (const role of ROLES) {
          const pairing = block.get(`--font-${role}-pairing`) ?? '';
          const tail = block.get(`--font-${role}-tail`) ?? '';
          const member = script.get(`--font-script-${role}`) ?? '';
          expect(member, `${setId} ${role}`).toMatch(/^var\(--font-set-/);

          // Substitute the three tokens into the composition rule's own value.
          const [p, s, t, ...rest] = items(roleValue.get(`--font-${role}`) ?? '');
          expect(rest, `--font-${role} has three items`).toEqual([]);
          expect(p).toMatch(new RegExp(`^var\\(--font-${role}-pairing,`));
          expect(s).toMatch(new RegExp(`^var\\(--font-script-${role},`));
          expect(t).toMatch(new RegExp(`^var\\(--font-${role}-tail,`));
          const composed = [...items(pairing), member, ...items(tail)];

          const at = composed.indexOf(member);
          const label = `${id} × ${setId} × ${role}: ${composed.join(', ')}`;
          expect(composed[0], label).toBe(items(pairing)[0]);
          expect(at, label).toBe(items(pairing).length);
          expect(composed.slice(0, at).filter(isGeneric), label).toEqual([]);
          expect(composed.slice(at + 1), label).toEqual(items(tail));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(48);
  });

  it('resolves an unpinned Hand-Drawn / Indie to Marker and honours a pinned type', () => {
    expect(resolveAxesToApplied({ styleId: 'hand-drawn-indie' })).toMatchObject({
      typeId: 'marker',
      typePinned: false,
    });
    expect(resolveAxesToApplied({ styleId: 'hand-drawn-indie', typeId: null })).toMatchObject({
      typeId: 'marker',
      typePinned: false,
    });
    expect(resolveAxesToApplied({ styleId: 'hand-drawn-indie', typeId: 'grotesk' })).toMatchObject({
      typeId: 'grotesk',
      typePinned: true,
    });
    expect(resolveAxesToApplied({ typeId: 'nope' })).toMatchObject({
      typeId: DEFAULT_TYPE_ID,
      typePinned: false,
    });
    expect(resolveType('nope').id).toBe(DEFAULT_TYPE_ID);
  });

  it('names a registered pairing as every style default', () => {
    for (const [style, type] of Object.entries(STYLE_DEFAULT_TYPE)) {
      expect(TYPE_IDS, style).toContain(type);
    }
  });

  describe('the built init script (anonymous visitor)', () => {
    function run(stored: Record<string, string>): Record<string, string> {
      const attrs: Record<string, string> = {};
      const store = new Map(Object.entries(stored));
      const document = {
        documentElement: {
          setAttribute: (n: string, v: string) => {
            attrs[n] = v;
          },
          getAttribute: (n: string) => attrs[n] ?? null,
          removeAttribute: (n: string) => {
            delete attrs[n];
          },
        },
      };
      const window = {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
        matchMedia: () => ({ matches: false }),
      };
      runInNewContext(buildThemeInitScript(null), { document, window });
      return attrs;
    }

    it('applies Marker to a stored Hand-Drawn / Indie with no type', () => {
      const attrs = run({ [THEME_STORAGE_KEYS.style]: 'hand-drawn-indie' });
      expect(attrs['data-style']).toBe('hand-drawn-indie');
      expect(attrs['data-type']).toBe('marker');
    });

    it('keeps a stored pinned type over the style default', () => {
      const attrs = run({
        [THEME_STORAGE_KEYS.style]: 'hand-drawn-indie',
        [THEME_STORAGE_KEYS.type]: 'grotesk',
      });
      expect(attrs['data-type']).toBe('grotesk');
    });

    it('falls an unknown stored type back to the style default, else the base', () => {
      expect(
        run({ [THEME_STORAGE_KEYS.style]: 'hand-drawn-indie', [THEME_STORAGE_KEYS.type]: 'nope' })[
          'data-type'
        ],
      ).toBe('marker');
      expect(run({ [THEME_STORAGE_KEYS.type]: 'nope' })['data-type']).toBe(DEFAULT_TYPE_ID);
    });
  });
});
