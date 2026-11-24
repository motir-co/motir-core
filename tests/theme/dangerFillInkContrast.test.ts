import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, flattenColorMix } from './colorMetrics';
import { BLOCKED_TAB_TONE } from '@/components/planning/cardEdgeTab';

// MOTIR-3664 — the danger BUTTON's own pairing, measured over the whole matrix.
//
// `--el-danger-text` is the ink meant to sit ON a `--el-danger` fill: `Button`'s
// danger variant is `bg-(--el-danger) text-(--el-danger-text)` and that is the
// token's entire intended use. So the pairing is a per-palette CONTRACT, and it
// was never asserted anywhere — which is how `spectrum` shipped its dark block at
// 3.40:1 while the other nineteen ran 4.51–8.81. Nobody complained about the
// button; a palette author moved the fill lighter (#f0555f, so the red would read
// AS text on the violet canvas) and left the ink at #ffffff, and no mechanism was
// looking at the two together.
//
// The durable half of that card is this file. It measures the pairing from
// `theme.css` for every palette in `PALETTE_IDS` x both themes, so the matrix
// grows with the registry rather than with an enumeration somebody remembers to
// extend — a new palette is measured the day it lands.
//
// ── Why this is NOT a case for `inkContrastLint.test.ts` ──
// That guard is an AST scanner over `components/**` / `app/**` / `lib/**` / the
// design-system `src/**`: it attributes a Tailwind class literal to the JSX
// element whose `className` contains it, and judges THAT element. It answers "is
// this call site using an ink its surface cannot carry" — a question about code.
// This file answers "does the palette LAYER hold up where it is used exactly as
// designed" — a question about `theme.css`, with no call site involved at all. A
// defect here is invisible to an AST scan of the components, because every one of
// those components is correct.

const { rules } = loadTokenLayer();

const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

/** WCAG AA for normal-size text. A button label is normal-size text. */
const AA_TEXT = 4.5;
/** WCAG AA for graphics and UI components — a border, a glyph, a focus ring. */
const AA_NON_TEXT = 3;

/**
 * The surfaces `--el-danger` is painted ON when it is a border or glyph rather
 * than a fill (the treatment the danger hue takes wherever a solid destructive
 * button would be too loud). These four are the whole surface ladder the Tier-3
 * layer exposes.
 */
const SURFACE_TOKENS = ['--el-page-bg', '--el-surface', '--el-surface-soft', '--el-canvas'];

function resolved(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(
    unresolved,
    `${token} must resolve to a concrete colour under palette=${ctx.palette} theme=${ctx.theme}`,
  ).toEqual([]);
  return flattenColorMix(value);
}

const label = (ctx: ThemeContext) => `${ctx.palette}/${ctx.theme}`;

describe('the danger fill carries its own ink at AA, in every palette and theme', () => {
  it('covers the whole matrix it claims to — every registered palette, both themes', () => {
    // The assertion above this one is only worth its floor if the matrix is the
    // real one. A registry that grew while this list did not would leave the new
    // palette unmeasured and the suite green, which is the shape that let the
    // defect ship in the first place.
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * THEMES.length);
    expect(new Set(CONTEXTS.map(label)).size).toBe(CONTEXTS.length);
  });

  it('`--el-danger-text` on `--el-danger` clears AA in all palette x theme combinations', () => {
    // Measured as a TABLE, not a loop of independent assertions: a per-context
    // `expect` reports the first failure and hides the rest, and the thing a
    // reader needs when this goes red is which palettes are near the bar and
    // which one moved. The failure message carries all twenty rows.
    const measured = CONTEXTS.map((ctx) => {
      const ink = resolved(ctx, '--el-danger-text');
      const fill = resolved(ctx, '--el-danger');
      return { context: label(ctx), ink, fill, ratio: contrast(ink, fill) };
    });

    const table = measured
      .map((r) => `  ${r.context.padEnd(18)} ${r.ink} on ${r.fill} = ${r.ratio.toFixed(2)}:1`)
      .join('\n');
    const under = measured.filter((r) => r.ratio < AA_TEXT).map((r) => r.context);

    expect(
      under,
      `\`--el-danger-text\` on \`--el-danger\` is the danger button's OWN pairing and must clear ${AA_TEXT}:1 everywhere.\n${table}\n`,
    ).toEqual([]);
  });

  it('the canvas BLOCKED TAB wears exactly the pairing measured above (MOTIR-12158)', () => {
    // The "blocked elsewhere" tab (design MOTIR-12157 § "Colour") is the second
    // carrier of this pairing, at 11px bold — normal-size text, so the same 4.5:1
    // bar — and its floor is thin (amethyst light, 4.51:1 in the design's own
    // table). Pinning its tone to the pair the matrix above measures means a
    // palette edit that drops the pairing under AA fails here for the tab too,
    // and a tab re-toned onto some other pair has to come and add its own arm.
    const classes = BLOCKED_TAB_TONE.split(/\s+/).sort();
    expect(classes).toEqual(['bg-(--el-danger)', 'text-(--el-danger-text)']);
  });

  it('`--el-danger` still clears the 3:1 graphics bar on every surface it borders', () => {
    // The other half of MOTIR-3664's acceptance: the two candidate fixes were
    // "darken the ink" and "darken the fill", and darkening the FILL would have
    // moved `--el-danger` — which is also the border/glyph hue, and the Tier-0
    // source of --el-priority-highest / --el-type-bug / --el-type-deploy /
    // --el-overdue. This pins the property that made the ink the safer lever, so
    // a future palette edit cannot buy the pairing above at this one's expense.
    const failures: string[] = [];
    for (const ctx of CONTEXTS) {
      const fill = resolved(ctx, '--el-danger');
      for (const surface of SURFACE_TOKENS) {
        const ratio = contrast(fill, resolved(ctx, surface));
        if (ratio < AA_NON_TEXT) {
          failures.push(`${label(ctx)} ${surface}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(
      failures,
      `\`--el-danger\` is a border/glyph hue as well as a fill and must clear ${AA_NON_TEXT}:1 on every surface.`,
    ).toEqual([]);
  });
});
