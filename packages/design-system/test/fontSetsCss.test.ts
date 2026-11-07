import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FONT_SET_IDS,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  TYPE_IDS,
  fontSetMemberVar,
  type FontSetMember,
} from '../src/index';

// MOTIR-7845 — theme.css composes each role token from the active pairing's
// chain, the language's font-set face and the pairing's generic tail. These
// assertions hold the CASCADE rules that a wrong edit breaks silently: an
// English page looks right either way, so nothing else would notice.

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(PKG_ROOT, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  declarations: [string, string][];
}

/** Every rule whose body is a flat declaration list (at-rule wrappers are skipped). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A statement at-rule (`@custom-variant …;`) can sit before the selector.
    const prelude = (m[1] ?? '').split(';').pop()?.trim() ?? '';
    const selectors = (prelude === '@theme' ? ':root(@theme)' : prelude)
      .split(',')
      .map((s) => s.trim());
    const declarations = (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.startsWith('--'))
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
    out.push({ selectors, declarations });
  }
  return out;
}

const RULES = rules();
const ROLE_GENERIC = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' } as const;

// Every CSS generic family keyword (CSS Fonts 4 §generic families), plus the
// `ui-*` and `system-ui` aliases. A generic maps to ONE system font, which on a
// CJK system covers CJK and would pre-empt the font set's face. The two
// vendor spellings of `system-ui` behave the same way and are listed with it:
// they name the platform UI font together with its own fallback cascade, which
// drew 的 色 直 ahead of Noto Sans SC / JP on a production build (MOTIR-7880).
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

/** The family names a value lists, with `var(--name` wrappers peeled off. */
function families(value: string): string[] {
  return value
    .replace(/var\(\s*--[\w-]+/g, '')
    .replace(/[()]/g, ',')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

const declarationsOf = (name: string) =>
  RULES.flatMap((r) =>
    r.declarations.filter(([n]) => n === name).map(([, v]) => ({ selectors: r.selectors, v })),
  );

const block = (selector: string) => RULES.find((r) => r.selectors.includes(selector));

describe('theme.css font-set composition (MOTIR-7845)', () => {
  it('gives every font-set, script, pairing and tail var() a fallback', () => {
    const refs = [
      ...CSS.matchAll(
        /var\(\s*(--font-(?:set|script)-[\w-]+|--font-(?:sans|serif|mono)-(?:pairing|tail))\s*([,)])/g,
      ),
    ];
    expect(refs.length).toBeGreaterThan(20);
    const bare = refs.filter((m) => m[2] === ')').map((m) => m[1]);
    expect(bare).toEqual([]);
  });

  it('keeps every generic keyword out of every pairing chain', () => {
    let checked = 0;
    for (const role of FONT_SET_ROLES) {
      for (const { selectors, v } of declarationsOf(`--font-${role}-pairing`)) {
        checked += 1;
        const generic = families(v).filter((f) => GENERICS.has(f.toLowerCase()));
        expect(generic, `${selectors.join(', ')} --font-${role}-pairing`).toEqual([]);
      }
    }
    // The `:root` base plus one declaration block per registered pairing (the
    // `motir` base's own is `[data-appearance-scope][data-type='motir']`), three
    // roles each — derived from the registry so a new pairing needs no edit here.
    expect(checked).toBe((TYPE_IDS.length + 1) * 3);
  });

  it('sets the pairing chain and tail in every [data-type] block, never the role itself', () => {
    const typeBlocks = RULES.filter((r) =>
      r.selectors.some((s) => /\[data-type='[^']+'\]$/.test(s)),
    );
    // One block per registered pairing — the regex also matches the `motir`
    // base's `[data-appearance-scope][data-type='motir']` rule.
    expect(typeBlocks.length).toBe(TYPE_IDS.length);
    for (const r of typeBlocks) {
      const names = r.declarations.map(([n]) => n).sort();
      expect(names, r.selectors.join(', ')).toEqual(
        FONT_SET_ROLES.flatMap((role) => [`--font-${role}-pairing`, `--font-${role}-tail`]).sort(),
      );
    }
  });

  it('composes each role as pairing, then script, then tail, and only in the two composition rules', () => {
    for (const role of FONT_SET_ROLES) {
      const found = declarationsOf(`--font-${role}`);
      expect(found.map((f) => f.selectors.join(', '))).toEqual([
        ':root(@theme)',
        ':root, [data-type], [lang], [data-font-set-sans], [data-font-set-serif], [data-font-set-mono]',
      ]);
      const [theme, unlayered] = found.map((f) => f.v);
      expect(theme).toBe(unlayered);
      const v = unlayered ?? '';
      const pairing = v.indexOf(`var(--font-${role}-pairing,`);
      const script = v.indexOf(`var(--font-script-${role},`);
      const tail = v.lastIndexOf(`var(--font-${role}-tail,`);
      expect(pairing).toBe(0);
      expect(script).toBeGreaterThan(pairing);
      expect(tail).toBeGreaterThan(script);
      // An undefined script token falls back to the pairing's own tail, so a
      // Latin page lists the pairing's faces with nothing in between.
      expect(v).toContain(
        `var(--font-script-${role}, var(--font-${role}-tail, ${ROLE_GENERIC[role]}))`,
      );
    }
  });

  it('resets the three script tokens for every Latin locale', () => {
    const latin = Object.entries(LOCALE_FONT_SET)
      .filter(([, set]) => set === 'latin')
      .map(([locale]) => `[lang]:lang(${locale})`);
    const r = RULES.find((x) => latin.every((s) => x.selectors.includes(s)));
    expect(r, 'one block lists every Latin locale').toBeDefined();
    expect(r?.selectors).toEqual(latin);
    expect(Object.fromEntries(r?.declarations ?? [])).toEqual({
      '--font-script-sans': 'initial',
      '--font-script-serif': 'initial',
      '--font-script-mono': 'initial',
    });
  });

  it('gives every CJK set one block setting all three script tokens to its defaults', () => {
    const cjk = FONT_SET_IDS.filter((id) => FONT_SET_REGISTRY[id].cjk);
    expect(cjk.length).toBe(4);
    for (const id of cjk) {
      const set = FONT_SET_REGISTRY[id];
      const r = block(`[lang]:lang(${set.lang})`);
      expect(r, id).toBeDefined();
      expect(r?.selectors).toHaveLength(1);
      expect(Object.fromEntries(r?.declarations ?? [])).toEqual(
        Object.fromEntries(
          FONT_SET_ROLES.map((role) => [
            `--font-script-${role}`,
            `var(${fontSetMemberVar(id, role, set.roles[role].default)}, ${ROLE_GENERIC[role]})`,
          ]),
        ),
      );
    }
  });

  it('gives every non-default member a by-name block, after its set’s block, setting only its role', () => {
    let overrides = 0;
    for (const id of FONT_SET_IDS) {
      const set = FONT_SET_REGISTRY[id];
      if (!set.cjk) continue;
      const setAt = CSS.indexOf(`[lang]:lang(${set.lang}) {`);
      for (const role of FONT_SET_ROLES) {
        const r = set.roles[role];
        for (const m of r.members as readonly FontSetMember[]) {
          if (m.id === r.default) continue;
          overrides += 1;
          const selector = `:lang(${set.lang})[data-font-set-${role}='${m.id}']`;
          const rule = block(selector);
          expect(rule, selector).toBeDefined();
          expect(rule?.declarations).toEqual([
            [
              `--font-script-${role}`,
              `var(${fontSetMemberVar(id, role, m.id)}, ${ROLE_GENERIC[role]})`,
            ],
          ]);
          expect(CSS.indexOf(`${selector} {`)).toBeGreaterThan(setAt);
        }
      }
    }
    expect(overrides).toBe(4);
  });

  it('places each zh-TW block after its zh counterpart, which also matches zh-TW (MOTIR-9239)', () => {
    const pairs = [
      ['[lang]:lang(zh) {', '[lang]:lang(zh-TW) {'],
      [
        ":lang(zh)[data-font-set-serif='lxgw-wenkai-tc'] {",
        ":lang(zh-TW)[data-font-set-serif='lxgw-wenkai-tc'] {",
      ],
    ] as const;
    for (const [zh, zhTw] of pairs) {
      expect(CSS.indexOf(zh), zh).toBeGreaterThan(-1);
      expect(CSS.indexOf(zhTw), zhTw).toBeGreaterThan(CSS.indexOf(zh));
    }
    // Both zh-TW blocks follow BOTH zh blocks, so a zh by-name pick never
    // outranks a zh-TW default on a zh-TW element.
    expect(CSS.indexOf('[lang]:lang(zh-TW) {')).toBeGreaterThan(
      CSS.indexOf(":lang(zh)[data-font-set-serif='lxgw-wenkai-tc'] {"),
    );
  });

  it('sets nothing but --font-* custom properties in the font-set rules, and no colour', () => {
    const fontSetRules = RULES.filter((r) =>
      r.selectors.some((s) => s.includes(':lang(') || s.includes('[data-font-set-')),
    );
    expect(fontSetRules.length).toBeGreaterThan(0);
    for (const r of fontSetRules) {
      for (const [name, value] of r.declarations) {
        expect(name).toMatch(/^--font-/);
        expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|--color-|--el-/i);
      }
    }
    // No non-custom property hides in those rules either.
    for (const m of CSS.matchAll(/([^{}]*(?::lang\(|\[data-font-set-)[^{}]*)\{([^{}]*)\}/g)) {
      const props = (m[2] ?? '')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.slice(0, d.indexOf(':')).trim());
      expect(props.every((p) => p.startsWith('--font-'))).toBe(true);
    }
  });
});
