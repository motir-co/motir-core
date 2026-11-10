import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { contrast, flattenColorMix } from './colorMetrics';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// THE CODE GROUND'S TEXT SELECTION (MOTIR-10856) — the agent terminal's xterm
// selection, focused (`--el-code-selection-bg`) and unfocused
// (`--el-code-selection-inactive-bg`). Two properties, in every palette × theme:
//
// - the selection is SEEN: it stands off `--el-code-bg` (xterm's own default,
//   white at 30%, rendered as rgb(247, 247, 249) on the light ground's
//   rgb(243, 244, 246) — 1.03:1, the bug — and 2.73:1 on the dark one), and
//   the focused selection stands further off than the unfocused one;
// - the selected text is READ: `--el-code-text` stays AA (4.5:1) on both.
//
// The floors are the non-text distinction a code editor's selection gives — VS
// Code's light-theme selection, #add6ff, is ~1.5:1 on its white page — and AA for the ink. A 3:1
// selection is not reachable on a light ground while the ink keeps 4.5:1 on it.

const THEMES = ['light', 'dark'] as const;
const AA = 4.5;
const FOCUSED_FLOOR = 1.4;
const UNFOCUSED_FLOOR = 1.25;
const { rules } = loadTokenLayer();

/** Fold nested `color-mix(in srgb, …)` from the inside out, down to one hex. */
function flatten(value: string): string {
  let out = value;
  for (;;) {
    const next = out.replace(/color-mix\([^()]*\)/g, (inner) => flattenColorMix(inner));
    if (next === out) return out;
    out = next;
  }
}

function resolved(token: string, ctx: ThemeContext): string {
  const declarations = declaredIn(rules, ctx);
  return flatten(resolveValue(declarations[token] ?? '', declarations).value);
}

describe('the code ground’s text selection is seen and its text is read, in every palette and theme', () => {
  for (const palette of PALETTE_IDS) {
    for (const theme of THEMES) {
      it(`${palette}/${theme}`, () => {
        const ctx = { palette, theme };
        const ground = resolved('--el-code-bg', ctx);
        const ink = resolved('--el-code-text', ctx);
        const focused = resolved('--el-code-selection-bg', ctx);
        const unfocused = resolved('--el-code-selection-inactive-bg', ctx);
        for (const [name, hex] of Object.entries({ ground, ink, focused, unfocused })) {
          expect(hex, name).toMatch(/^#[0-9a-f]{6}$/i);
        }
        expect(contrast(focused, ground), 'focused vs ground').toBeGreaterThanOrEqual(
          FOCUSED_FLOOR,
        );
        expect(contrast(unfocused, ground), 'unfocused vs ground').toBeGreaterThanOrEqual(
          UNFOCUSED_FLOOR,
        );
        expect(contrast(focused, ground), 'focused stands further off').toBeGreaterThan(
          contrast(unfocused, ground),
        );
        expect(contrast(ink, focused), 'ink on focused').toBeGreaterThanOrEqual(AA);
        expect(contrast(ink, unfocused), 'ink on unfocused').toBeGreaterThanOrEqual(AA);
      });
    }
  }
});
