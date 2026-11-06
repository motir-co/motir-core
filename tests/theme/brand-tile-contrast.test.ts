import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { contrast, flattenColorMix } from './colorMetrics';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';

// MOTIR-8932 — the shell brand tile's mark-on-tile contrast
// (`design/shell/design-notes.md` § *The context row* → *The brand tile*).
//
// The top bar's home link draws the mark the way motir.co's header does
// (`motir-marketing` `app/_components/BrandTile.tsx`): the wave in
// `--el-logo-mark`, the palette's primary fill, on a rounded square in
// `--el-logo-tile`, a wash of that hue (or the dark tile a bright palette sets
// in its own block). It replaces MOTIR-2557's neutral tile — an
// `--el-surface` field, an `--el-border` hairline, and the glyph in
// `.brand-glyph`'s `--el-accent-on-surface` — which this file used to pin at
// 6.03:1 light / 4.24:1 dark.
//
// ── WHY THIS TEST EXISTS AT ALL ─────────────────────────────────────────────
// The repo already guards ink contrast — `tests/theme/inkContrastLint.test.ts`
// — and it CANNOT see this pair. That guard reasons about the ink and surface
// tokens it finds named together on one element's `className`; here the two
// colours are SVG fills on two different elements (the `<rect>` and the
// `<path>`), so the lint passes whatever they are, including a pair the mark
// disappears into.
//
// ── AND IT ASSERTS EVERY PALETTE, NOT JUST THE DEFAULT ──────────────────────
// `data-palette` is a shipped axis, and the two logo tokens are not uniform
// across it: the base derives the tile as a `color-mix()` of the mark, and the
// bright palettes (amber, sienna, citrine, candy) re-point the tile to a dark
// one. The pair is resolved through the same cascade model the other
// palette-matrix suites use (`paletteCascade.ts`) — mixes flattened — for every
// palette in `PALETTE_IDS` × both themes, so a new palette is measured the day
// it lands, and one that breaks the pair fails HERE rather than in a screenshot
// nobody takes.
//
// WCAG 1.4.11 (non-text contrast) asks 3:1 for a graphical object that carries
// meaning. All twenty contexts clear it today; the lowest is amethyst dark.

const ROOT = resolve(import.meta.dirname, '../..');
const TOP_NAV = readFileSync(resolve(ROOT, 'app/(authed)/_components/TopNav.tsx'), 'utf8');
const BRAND_CSS = readFileSync(resolve(ROOT, 'packages/brand/brand.css'), 'utf8');

const { rules } = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);
const HEX = /^#[0-9a-f]{6}$/i;
const NON_TEXT_AA = 3;

function resolved(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(
    unresolved,
    `${token} must resolve under palette=${ctx.palette} theme=${ctx.theme}`,
  ).toEqual([]);
  const hex = flattenColorMix(value);
  expect(hex, `${token} under ${ctx.palette}/${ctx.theme} flattens to a hex`).toMatch(HEX);
  return hex;
}

function pair(ctx: ThemeContext): { mark: string; tile: string; ratio: number } {
  const mark = resolved(ctx, '--el-logo-mark');
  const tile = resolved(ctx, '--el-logo-tile');
  return { mark, tile, ratio: contrast(mark, tile) };
}

/** The brand slot's opening tag through to the end of its `<svg>`: the Link
 *  is identified by its ACCESSIBLE NAME, never by its destination (MOTIR-4799 —
 *  three brand-slot referrers have pinned an href that then moved). */
function brandSlot(): { classes: string[]; svg: string } {
  const m =
    /<Link\s+href=\{[^}]+\}\s+aria-label=\{t\('topNav\.brandHome'\)\}[\s\S]*?className="([^"]+)"\s*>\s*(<svg[\s\S]*?<\/svg>)/.exec(
      TOP_NAV,
    );
  expect(m, 'the brand slot is the Link labelled topNav.brandHome, wrapping an svg').toBeTruthy();
  return { classes: m![1]!.split(/\s+/), svg: m![2]! };
}

describe('the shell brand tile (MOTIR-8932)', () => {
  it('drops the neutral field and hairline from the Link, keeping its geometry', () => {
    const { classes } = brandSlot();
    expect(classes).not.toContain('bg-(--el-surface)');
    expect(classes).not.toContain('border');
    expect(classes).not.toContain('border-(--el-border)');
    // the box is untouched — this card repaints, it does not resize
    expect(classes).toContain('h-(--height-control-32)');
    expect(classes).toContain('w-8');
    expect(classes).toContain('hidden');
    expect(classes).toContain('md:flex');
  });

  it('paints the mark with --el-logo-mark on --el-logo-tile, and nothing else', () => {
    const { svg } = brandSlot();
    expect(svg).toMatch(/<rect[^>]*rx="7"[^>]*className="fill-\(--el-logo-tile\)"/);
    expect(svg).toMatch(/<path[^>]*d=\{WAVE_BAND_PATH\}[^>]*className="fill-\(--el-logo-mark\)"/);
    expect(svg).toContain('transform="translate(6.32 6.32) scale(0.8067)"');
    expect(svg).toContain('aria-hidden="true"');
    // colour only from the logo tokens: no hex, no rgb()/hsl(), no other --el-*
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(svg.match(/--el-[\w-]+/g)!.sort()).toEqual(['--el-logo-mark', '--el-logo-tile']);
    // …and not the shared `.brand-glyph`, whose ink would override the fill
    expect(svg).not.toContain('brand-glyph');
  });

  it('leaves the glyph’s GLOBAL rule alone — five other brand surfaces share it', () => {
    // `.brand-glyph` is the colour of the auth card, ExploreTopBar,
    // PublicTopBar, the OG images and the specimen. The top bar no longer uses
    // it, and asserting it here is what stops "match the app's mark to motir.co"
    // from being done by repainting all of them.
    expect(BRAND_CSS).toMatch(/\.brand-glyph\s*\{[^}]*color:\s*var\(--el-accent-on-surface\)/);
  });

  it('drops the divider the tile’s own edge replaced', () => {
    // §7a introduced a hairline to say the brand sits outside the tier
    // hierarchy. The tile says that, and the 9px stays with the row.
    expect(TOP_NAV).not.toMatch(/h-5 w-px[^"]*bg-\(--el-border\)/);
  });

  it('measures the whole matrix it claims to — every registered palette, both themes', () => {
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * THEMES.length);
  });

  it('clears WCAG 1.4.11’s 3:1 for the mark in EVERY palette and theme', () => {
    // A table, not a loop of independent expects: when this goes red the reader
    // needs every context near the bar, not the first one that crossed it.
    const failing = CONTEXTS.map((ctx) => ({ ctx, ...pair(ctx) }))
      .filter((p) => p.ratio < NON_TEXT_AA)
      .map(
        (p) => `${p.ctx.palette}/${p.ctx.theme}: ${p.mark} on ${p.tile} = ${p.ratio.toFixed(2)}:1`,
      );
    expect(failing, 'the brand mark must stay legible on its own tile under every palette').toEqual(
      [],
    );
  });

  it('still measures what the design notes record — default palette 4.07:1 light, 5.18:1 dark', () => {
    // The numbers `design/shell/design-notes.md` § *The brand tile* states,
    // re-derived. Drift is not automatically a failure (the 3:1 check above is
    // the gate), but it means the notes and the app disagree and one of them
    // needs amending ON THE RECORD.
    expect(DEFAULT_PALETTE_ID).toBe('motir');
    expect(pair({ palette: DEFAULT_PALETTE_ID, theme: 'light' }).ratio).toBeCloseTo(4.07, 1);
    expect(pair({ palette: DEFAULT_PALETTE_ID, theme: 'dark' }).ratio).toBeCloseTo(5.18, 1);
    // …and the floor of the matrix, the one context nearest the bar
    expect(pair({ palette: 'amethyst', theme: 'dark' }).ratio).toBeCloseTo(3.86, 1);
    const lowest = Math.min(...CONTEXTS.map((ctx) => pair(ctx).ratio));
    expect(lowest).toBeCloseTo(3.86, 1);
  });
});
