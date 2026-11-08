import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '@/lib/theme/styles';

// MOTIR-10631 — `--spacing-shadow-elevated-drop` is how far the SOLID edge of
// `--shadow-elevated` falls below the box that casts it. The canvas card's
// next-action button lifts itself by it so a hard-offset shadow clears the tag
// row as its box does. The number is a restatement of the shadow, so this suite
// keeps the two from drifting apart: in every style, the drop in effect equals
// the largest Y offset of a non-inset, zero-blur layer of the shadow in effect
// (0 when every layer is blurred, inset, or sits at Y ≤ 0).

const THEME_CSS = readFileSync(
  join(process.cwd(), 'packages/design-system/theme.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one top-level block whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = THEME_CSS.indexOf(`${selector} {`);
  if (start < 0) return new Map();
  const end = THEME_CSS.indexOf('\n}', start);
  const body = THEME_CSS.slice(start, end);
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, n, v]) => [n!, v!.trim()]),
  );
}

/** Split a box-shadow list on its top-level commas (not those inside `rgba(…)`). */
function layers(shadow: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of shadow) {
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

/** The solid drop of a shadow, in px: the max Y of a non-inset zero-blur layer. */
function solidDrop(shadow: string): number {
  if (shadow.trim() === 'none') return 0;
  let drop = 0;
  for (const layer of layers(shadow)) {
    if (/\binset\b/.test(layer)) continue;
    const lengths = layer
      .replace(/[a-z-]+\([^)]*\)/gi, '')
      .trim()
      .split(/\s+/)
      .filter((t) => /^-?\d*\.?\d+(px)?$/.test(t))
      .map((t) => parseFloat(t));
    const [, y = 0, blur = 0] = lengths;
    if (blur === 0 && y > drop) drop = y;
  }
  return drop;
}

const px = (v: string | undefined) => (v === undefined ? undefined : parseFloat(v));

describe('--spacing-shadow-elevated-drop restates --shadow-elevated (MOTIR-10631)', () => {
  const root = block('@theme');
  const tier0 = root.size ? root : block(':root');

  it('the Tier-0 default declares a 0px drop under a blurred shadow', () => {
    expect(tier0.get('--spacing-shadow-elevated-drop')).toBe('0px');
    expect(solidDrop(tier0.get('--shadow-elevated') ?? '')).toBe(0);
  });

  it.each(STYLE_IDS)('%s: the drop in effect matches its elevated shadow', (id) => {
    const own = block(`[data-style='${id}']`);
    const shadow = own.get('--shadow-elevated') ?? tier0.get('--shadow-elevated') ?? 'none';
    const drop =
      px(own.get('--spacing-shadow-elevated-drop')) ??
      px(tier0.get('--spacing-shadow-elevated-drop'));
    expect(drop).toBe(solidDrop(shadow));
  });

  it('Neo-Brutalism, the hard-offset style, drops 6px', () => {
    expect(block("[data-style='neo-brutalism']").get('--spacing-shadow-elevated-drop')).toBe('6px');
  });

  it('reads a shadow list the way the cascade draws it', () => {
    expect(solidDrop('none')).toBe(0);
    expect(solidDrop('6px 6px 0 0 rgba(15, 15, 15, 1)')).toBe(6);
    expect(solidDrop('0 8px 24px rgba(15, 15, 15, 0.12)')).toBe(0);
    expect(solidDrop('inset 0 4px 0 0 #000, 0 2px 0 rgba(0, 0, 0, 0.5)')).toBe(2);
    expect(solidDrop('0 -3px 0 0 rgba(0, 0, 0, 1)')).toBe(0);
    expect(solidDrop('0 0 0 1px color-mix(in srgb, currentColor 16%, transparent)')).toBe(0);
  });
});
