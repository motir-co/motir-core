import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { contrast, deltaE2000, flattenColorMix } from './colorMetrics';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// THE PLANNER'S CARD CUES READ APART (MOTIR-11362). A card on the planning canvas
// carries one of five live tags — Thinking, Drafting, Editing, Checking, Fixing —
// each drawn in its own role token on its ring, its chip edge and its glyph. Each
// tag also has its own stroke, glyph and word, so no state rests on colour alone,
// but several tags are on the canvas at once (a level authored in parallel, the
// fix writing cards across the plan), so the hues must still tell apart:
//
//   - every PAIR of the five, and each against the changed-card highlight that
//     rides the same ring box (`--el-changed`), is at least ΔE2000 5.5 apart —
//     the floor `familyHueSeparation.test.ts` holds a chip pair that also differs
//     by another channel to, since a tag is never told apart by its hue alone; and
//   - each is a 3:1 graphic (WCAG 1.4.11) on the card it frames and on the canvas
//     its ring sits on,
//
// in every palette × theme context.

const THEMES = ['light', 'dark'] as const;
const CUES = ['--el-thinking', '--el-drafting', '--el-editing', '--el-checking', '--el-fixing'];
const NEIGHBOURS = [...CUES, '--el-changed'];
const BACKDROPS = ['--el-card', '--el-canvas'];
const MIN_DELTA_E = 5.5;
const MIN_CONTRAST = 3;
const { rules, elementTokens } = loadTokenLayer();

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
  return flatten(resolveValue(declarations[token] ?? '', declarations).value.toLowerCase());
}

describe('the planner card cues — five hues that read apart', () => {
  it('declares all five role tokens in the Tier-3 base', () => {
    for (const token of CUES) expect(elementTokens).toContain(token);
  });

  for (const palette of PALETTE_IDS) {
    for (const theme of THEMES) {
      const ctx = { palette, theme };
      it(`${palette}/${theme}: every pair is at least ΔE2000 ${MIN_DELTA_E} apart`, () => {
        const close: string[] = [];
        for (let i = 0; i < NEIGHBOURS.length; i += 1) {
          for (let j = i + 1; j < NEIGHBOURS.length; j += 1) {
            const a = NEIGHBOURS[i]!;
            const b = NEIGHBOURS[j]!;
            if (!CUES.includes(a) && !CUES.includes(b)) continue;
            const e = deltaE2000(resolved(a, ctx), resolved(b, ctx));
            if (e < MIN_DELTA_E) close.push(`${a} ~ ${b}: ${e.toFixed(1)}`);
          }
        }
        expect(close).toEqual([]);
      });

      it(`${palette}/${theme}: each cue is a ${MIN_CONTRAST}:1 graphic on the card and the canvas`, () => {
        const faint: string[] = [];
        for (const cue of CUES) {
          for (const backdrop of BACKDROPS) {
            const ratio = contrast(resolved(cue, ctx), resolved(backdrop, ctx));
            if (ratio < MIN_CONTRAST) faint.push(`${cue} on ${backdrop}: ${ratio.toFixed(2)}`);
          }
        }
        expect(faint).toEqual([]);
      });
    }
  }
});
