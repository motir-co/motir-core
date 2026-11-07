import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPE_ID,
  TYPE_IDS,
  TYPE_REGISTRY,
  isTypeId,
  resolveType,
} from '@/lib/theme/typography';
import { STYLE_DEFAULT_TYPE } from '@/lib/theme/styles';
import { THEME_DEFAULTS, THEME_STORAGE_KEYS } from '@/lib/theme/types';
import { themeInitScript } from '@/lib/theme/init-script';

// Subtask 7.3.53 — the named-type registry is the single source of truth for
// the `data-type` axis (the THIRD design axis): the runtime contract, the init
// script's validation list + style-default map, and every later "Type: …"
// subtask read from it. This suite pins the contract the foundation must hold:
// v1 registers the three base-face pairings, the pairing→doc mapping resolves to
// a real file, the default resolves, and the type axis is kept disjoint from the
// colour + shape axes in globals.css.

// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS =
  readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8') +
  readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');
// The next/font declarations moved out of app/layout.tsx into app/fonts.ts, which the
// root layout AND app/global-error.tsx both import (MOTIR-6855).
const FONTS_TS = readFileSync(join(process.cwd(), 'app/fonts.ts'), 'utf8');

// The declaration body of one `[data-type='<id>']` block, comments stripped.
function typeBlockBody(id: string): string {
  const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = css.match(new RegExp(`\\[data-type='${id}'\\]\\s*\\{([^}]*)\\}`));
  const body = m?.[1];
  if (body === undefined) throw new Error(`no [data-type='${id}'] block`);
  return body;
}

// Generic family keywords a `-pairing` chain must not carry (they would pre-empt
// the font set's CJK face — the FONT SETS section of theme.css).
const GENERIC_FAMILY =
  /^(serif|sans-serif|cursive|fantasy|monospace|system-ui|ui-[a-z-]+|math|emoji|fangsong)$/i;

/** A block's `--font-<role>-pairing` / `-tail` declarations, trimmed, in order. */
function roleDeclarations(body: string, role: 'sans' | 'serif' | 'mono'): string[] {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith(`--font-${role}-`));
}

/** Every generic keyword found in a block's three `-pairing` values. */
function pairingGenerics(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/--font-(?:sans|serif|mono)-pairing:([^;]*);/g)) {
    for (const family of (m[1] ?? '').replace(/var\([^)]*\)/g, '').split(',')) {
      const f = family.trim().replace(/^['"]|['"]$/g, '');
      if (f && GENERIC_FAMILY.test(f)) out.push(f);
    }
  }
  return out;
}

describe('typography registry', () => {
  it('registers the v1 base trio + the new-typeface pairings (7.3.54–56, then Marker / Rounded / Slab / Humanist, MOTIR-10548)', () => {
    expect(TYPE_IDS).toEqual([
      'motir',
      'motir-sans',
      'motir-mono',
      'grotesk',
      'editorial',
      'mono-technical',
      'marker',
      'rounded',
      'slab',
      'humanist',
    ]);
    expect(TYPE_REGISTRY['motir'].name).toBe('Motir');
    expect(TYPE_REGISTRY['motir-sans'].name).toBe('Motir Sans');
    expect(TYPE_REGISTRY['motir-mono'].name).toBe('Motir Mono');
    expect(TYPE_REGISTRY['grotesk'].name).toBe('Grotesk');
    expect(TYPE_REGISTRY['editorial'].name).toBe('Editorial');
    expect(TYPE_REGISTRY['mono-technical'].name).toBe('Mono-Technical');
    expect(TYPE_REGISTRY['marker'].name).toBe('Marker');
    expect(TYPE_REGISTRY['rounded'].name).toBe('Rounded');
    expect(TYPE_REGISTRY['slab'].name).toBe('Slab');
    expect(TYPE_REGISTRY['humanist'].name).toBe('Humanist');
  });

  it('keeps every entry self-consistent (key === id) and TYPE_IDS in sync', () => {
    expect(TYPE_IDS).toEqual(Object.keys(TYPE_REGISTRY));
    for (const id of TYPE_IDS) {
      expect(TYPE_REGISTRY[id].id).toBe(id);
    }
  });

  it('resolves the default to a registered pairing', () => {
    expect(TYPE_IDS).toContain(DEFAULT_TYPE_ID);
    expect(DEFAULT_TYPE_ID).toBe('motir');
  });

  it('characterizes every entry (non-empty name / tagline / faces)', () => {
    for (const id of TYPE_IDS) {
      const p = TYPE_REGISTRY[id];
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.tagline.length).toBeGreaterThan(0);
      expect(p.faces.length).toBeGreaterThan(0);
    }
  });

  it('maps every pairing to a doc that exists on disk', () => {
    for (const id of TYPE_IDS) {
      const doc = TYPE_REGISTRY[id].designDoc;
      expect(doc).toBe(`docs/typography/${id}.md`);
      expect(existsSync(join(process.cwd(), doc))).toBe(true);
    }
  });
});

describe('isTypeId / resolveType', () => {
  it('accepts registered ids and rejects unknown values', () => {
    expect(isTypeId('motir')).toBe(true);
    expect(isTypeId('motir-sans')).toBe(true);
    expect(isTypeId('grotesk')).toBe(true); // registered in 7.3.54
    expect(isTypeId('editorial')).toBe(true); // registered in 7.3.55
    expect(isTypeId('marker')).toBe(true); // registered in MOTIR-10553
    expect(isTypeId('rounded')).toBe(true); // registered in MOTIR-10554
    expect(isTypeId('slab')).toBe(true); // registered in MOTIR-10555
    expect(isTypeId('humanist')).toBe(true); // registered in MOTIR-10556
    expect(isTypeId('serif-tech')).toBe(false); // not a registered pairing
    expect(isTypeId('')).toBe(false);
    expect(isTypeId(null)).toBe(false);
    expect(isTypeId(undefined)).toBe(false);
  });

  it('resolves a stale / unknown value to the default pairing', () => {
    expect(resolveType('nope').id).toBe(DEFAULT_TYPE_ID);
    expect(resolveType(null).id).toBe(DEFAULT_TYPE_ID);
    expect(resolveType('motir-mono').id).toBe('motir-mono');
  });
});

describe('theme wiring', () => {
  it('exposes a distinct storage key + default for the type axis', () => {
    expect(THEME_STORAGE_KEYS.type).toBe('motir.theme.type');
    expect(THEME_DEFAULTS.type).toBe(DEFAULT_TYPE_ID);
    const keys = [
      THEME_STORAGE_KEYS.pattern,
      THEME_STORAGE_KEYS.style,
      THEME_STORAGE_KEYS.palette,
      THEME_STORAGE_KEYS.type,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies data-type pre-hydration in the FOUC init script, with the style-default map', () => {
    expect(themeInitScript).toContain('data-type');
    expect(themeInitScript).toContain(THEME_STORAGE_KEYS.type);
    expect(themeInitScript).toContain(JSON.stringify(TYPE_IDS));
    // The init script bakes styleId→defaultTypeId so the pre-hydration pass
    // resolves the right pairing for the active style (no flash, no wrong face).
    expect(themeInitScript).toContain(JSON.stringify(STYLE_DEFAULT_TYPE));
  });
});

describe('runtime contract in globals.css', () => {
  it('documents the data-type axis section', () => {
    expect(GLOBALS_CSS).toContain('AXIS 3 (TYPE) — data-type overrides');
  });

  it('ships a [data-type] block for every non-base pairing', () => {
    for (const id of TYPE_IDS) {
      if (id === DEFAULT_TYPE_ID) continue; // the base needs no override block
      expect(GLOBALS_CSS).toContain(`[data-type='${id}']`);
    }
  });

  it('re-points the Editorial serif role at the LOADED Fraunces -source face', () => {
    // The editorial block must drive the serif role off `--font-editorial-source`,
    // the variable next/font binds to Fraunces in app/fonts.ts — so the
    // headline actually renders Fraunces (the -source indirection the type axis
    // requires; a role pointed at an unbacked -source falls back to a system face).
    expect(GLOBALS_CSS).toMatch(
      // Since MOTIR-7845 a pairing sets the role's PAIRING chain; the role token
      // itself is composed once, with the font set's script face behind it.
      /\[data-type='editorial'\][^{}]*\{[^}]*--font-serif-pairing:[^}]*--font-editorial-source/,
    );
    expect(FONTS_TS).toContain("variable: '--font-editorial-source'");
    expect(FONTS_TS).toContain('Fraunces');
  });

  it('re-points the Marker serif role at the LOADED Caveat -source face, headlines only', () => {
    // MOTIR-10553 — the marker block drives the headline role off
    // `--font-marker-source`, the variable next/font binds to Caveat in
    // app/fonts.ts, and keeps the body / meta chains at the Editorial block's
    // values (display-only: a marker hand is unreadable as UI text).
    const body = typeBlockBody('marker');
    expect(body).toMatch(/--font-serif-pairing:[^;]*--font-marker-source/);
    expect(FONTS_TS).toContain("variable: '--font-marker-source'");
    expect(FONTS_TS).toContain('Caveat');
    expect(FONTS_TS).toMatch(/fontVariables = \[[^\]]*caveat\.variable/);
    expect(pairingGenerics(body)).toEqual([]);
    for (const role of ['sans', 'mono'] as const) {
      expect(roleDeclarations(body, role)).toEqual(
        roleDeclarations(typeBlockBody('editorial'), role),
      );
    }
  });

  it('re-points the Rounded headline AND body roles at the LOADED Nunito -source face', () => {
    // MOTIR-10554 — whole-UI, like grotesk: both the serif and sans chains drive
    // off `--font-rounded-source`, the variable next/font binds to Nunito in
    // app/fonts.ts; meta keeps the grotesk block's JetBrains chain.
    const body = typeBlockBody('rounded');
    expect(body).toMatch(/--font-serif-pairing:[^;]*--font-rounded-source/);
    expect(body).toMatch(/--font-sans-pairing:[^;]*--font-rounded-source/);
    expect(FONTS_TS).toContain("variable: '--font-rounded-source'");
    expect(FONTS_TS).toContain('Nunito');
    expect(FONTS_TS).toMatch(/fontVariables = \[[^\]]*nunito\.variable/);
    expect(pairingGenerics(body)).toEqual([]);
    expect(roleDeclarations(body, 'mono')).toEqual(
      roleDeclarations(typeBlockBody('grotesk'), 'mono'),
    );
  });

  it('re-points the Slab serif role at the LOADED Roboto Slab -source face, headlines only', () => {
    // MOTIR-10555 — display-only, like editorial: the headline chain drives off
    // `--font-slab-source` (next/font's Roboto Slab in app/fonts.ts); the body /
    // meta chains equal the Editorial block's (Inter body, JetBrains meta).
    const body = typeBlockBody('slab');
    expect(body).toMatch(/--font-serif-pairing:[^;]*--font-slab-source/);
    expect(FONTS_TS).toContain("variable: '--font-slab-source'");
    expect(FONTS_TS).toContain('Roboto_Slab');
    expect(FONTS_TS).toMatch(/fontVariables = \[[^\]]*robotoSlab\.variable/);
    expect(pairingGenerics(body)).toEqual([]);
    for (const role of ['sans', 'mono'] as const) {
      expect(roleDeclarations(body, role)).toEqual(
        roleDeclarations(typeBlockBody('editorial'), role),
      );
    }
  });

  it('re-points the Humanist headline AND body roles at the LOADED Fira Sans -source face', () => {
    // MOTIR-10556 — whole-UI, like grotesk: both the serif and sans chains drive
    // off `--font-humanist-source`, the variable next/font binds to Fira Sans in
    // app/fonts.ts; meta keeps the grotesk block's JetBrains chain.
    const body = typeBlockBody('humanist');
    expect(body).toMatch(/--font-serif-pairing:[^;]*--font-humanist-source/);
    expect(body).toMatch(/--font-sans-pairing:[^;]*--font-humanist-source/);
    expect(FONTS_TS).toContain("variable: '--font-humanist-source'");
    expect(FONTS_TS).toContain('Fira_Sans');
    expect(FONTS_TS).toMatch(/fontVariables = \[[^\]]*firaSans\.variable/);
    expect(pairingGenerics(body)).toEqual([]);
    expect(roleDeclarations(body, 'mono')).toEqual(
      roleDeclarations(typeBlockBody('grotesk'), 'mono'),
    );
  });

  it('keeps the type axis disjoint — a [data-type] block sets only font tokens, never colour or shape', () => {
    // Strip CSS comments first so documentation's literal `[data-type='<id>']`
    // examples can't be mistaken for real rules; `[^{}]*` can't cross a `}`.
    const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /\[data-type='[^']+'\][^{}]*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    let blocksChecked = 0;
    while ((match = blockRe.exec(css)) !== null) {
      const body = match[1];
      blocksChecked += 1;
      // No colour (palette axis) and no shape/feel (style axis) tokens.
      expect(body).not.toMatch(/--color-|--el-/);
      expect(body).not.toMatch(/--radius-|--spacing-|--shadow-|--height-/);
      // It SHOULD set a font role token (that's the whole point).
      expect(body).toMatch(/--font-/);
    }
    // motir-sans + motir-mono ship blocks (motir is the base); guard the matcher.
    const nonBase = TYPE_IDS.filter((id) => id !== DEFAULT_TYPE_ID).length;
    expect(blocksChecked).toBeGreaterThanOrEqual(nonBase);
  });
});
