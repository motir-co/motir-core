import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// STORY INTEGRATION GATE (motir-core) — MOTIR-7585, over story MOTIR-7582.
//
// MOTIR-7584 shipped the warm touches with a suite that measures PAIRS
// (`motirWarmTouches.test.ts`). This file measures the WHOLE resolved token layer,
// every palette x theme, against a fixture captured from the commit the story
// branched from — `origin/main` at 047323ba0 — so a source token that moved more
// than the design said, a light-only override, or a new role that shifted another
// palette fails here even when every pair still clears its floor.
//
// The fixture has since gained the `--el-showcase-*` family (motir.co's
// illustration fields) at its resolved values — merged in additively when those
// tokens were born, so this gate keeps measuring the warm-touch change alone.
// Likewise the `--el-live-*` family (motir.co's live header link), merged in
// additively at its resolved values. And the `--el-cta-warm` pair (the onboarding
// screens' warm primary button, MOTIR-8254), the same way. And the `--el-drafting`
// pair (the drafted card's at-work cue, MOTIR-8416), the same way. And the
// `--el-chart-workload-*` pair (the Workload report's Assigned / Unassigned segment
// hues, MOTIR-8919), the same way. And the `--el-mark-wave-*` family (the Motir
// mark's at-work flow, MOTIR-9213), the same way. And `--el-notif-agent-hibernated`
// (the agent-hibernated-by-an-admin notification hue, MOTIR-10368), the same way.
// mark's at-work flow, MOTIR-9213), the same way. And the `--el-notif-review-*` pair
// (the review-path notification hues, MOTIR-10327), the same way.
// And the `--el-code-selection-*` pair (the agent terminal's text selection,
// MOTIR-10856), the same way.
// And `--el-changed` (the planning canvas's changed-card highlight, MOTIR-11185),
// the same way.
// The four palettes MOTIR-10550 added (lagoon, olive, contrast, midnight) joined
// the fixture at their resolved values when they were registered: a palette born
// after the warm touches has no pre-change layer, so its row pins it from birth.

const REPO = process.cwd();
const THEMES = ['light', 'dark'] as const;

const before = JSON.parse(
  readFileSync(join(REPO, 'tests/fixtures/motirWarmTouches7582.before.json'), 'utf8'),
) as Record<string, Record<string, string>>;

const { rules, elementTokens, paletteBlock } = loadTokenLayer();

function resolvedLayer(ctx: ThemeContext): Record<string, string> {
  const declarations = declaredIn(rules, ctx);
  const out: Record<string, string> = {};
  for (const token of elementTokens) {
    out[token] = resolveValue(declarations[token] ?? '', declarations).value.toLowerCase();
  }
  return out;
}

/** The two roles MOTIR-7584 added, and the token each one's consumers painted before. */
const NEW_ROLES = {
  '--el-progress-fill': '--el-accent',
  '--el-editor-focus': '--el-highlight',
} as const;

/**
 * Every motir token that moves, and nothing else. The approved roles (design
 * MOTIR-7583 §8.1) plus the consumers that ride the warmed peach / yellow washes
 * — the design's consumer list keeps them on the tint, so they warm with it.
 * `--el-editor-focus` moves from the old highlight blue to the link blue the
 * design chose for it.
 */
const MOTIR_CHANGES: Record<ThemeContext['theme'], Record<string, string>> = {
  light: {
    '--el-highlight': '#d66000',
    '--el-type-epic': '#d66000',
    '--el-epic-accent': '#d66000',
    '--el-chart-cat-6': '#d66000',
    '--el-progress-fill': '#d66000',
    '--el-type-design': '#746019',
    '--el-editor-focus': '#155bc4',
    '--el-tint-peach': '#fde0c8',
    '--el-warning-surface': '#fde0c8',
    '--el-role-custom': '#fde0c8',
    '--el-label-1': '#fde0c8',
    '--el-avatar-peach': '#fde0c8',
    '--el-roadmap-submitted': '#fde0c8',
    '--el-station-tier-validation': '#fde0c8',
    '--el-tint-yellow': '#fdf0c6',
    '--el-label-6': '#fdf0c6',
    '--el-avatar-yellow': '#fdf0c6',
  },
  dark: {
    '--el-highlight': '#fa5500',
    '--el-type-epic': '#fa5500',
    '--el-epic-accent': '#fa5500',
    '--el-chart-cat-6': '#fa5500',
    '--el-progress-fill': '#fa5500',
    '--el-type-design': '#ffd02f',
    '--el-editor-focus': '#7db1ff',
    '--el-tint-peach': '#36230f',
    '--el-warning-surface': '#36230f',
    '--el-role-custom': '#36230f',
    '--el-label-1': '#36230f',
    '--el-avatar-peach': '#36230f',
    '--el-roadmap-submitted': '#36230f',
    '--el-station-tier-validation': '#36230f',
    '--el-tint-yellow': '#302a12',
    '--el-label-6': '#302a12',
    '--el-avatar-yellow': '#302a12',
  },
};

describe('the gate reads the layer the app consumes', () => {
  it('the consumed design-system sheet is the in-repo source the resolver parses', () => {
    // motir-core's globals.css imports `@motir/design-system/theme.css`; the
    // resolver parses `packages/design-system/theme.css`. Pin that they are one file.
    const consumed = join(REPO, 'node_modules/@motir/design-system/theme.css');
    const source = join(REPO, 'packages/design-system/theme.css');
    expect(realpathSync(consumed)).toBe(realpathSync(source));
    expect(readFileSync(consumed, 'utf8')).toBe(readFileSync(source, 'utf8'));
  });

  it('the fixture covers every palette x theme and every pre-change token', () => {
    const expectedKeys = PALETTE_IDS.flatMap((p) => THEMES.map((t) => `${p}/${t}`)).sort();
    expect(Object.keys(before).sort()).toEqual(expectedKeys);
    const added = Object.keys(NEW_ROLES);
    for (const key of expectedKeys) {
      expect(Object.keys(before[key]!).sort()).toEqual(
        elementTokens.filter((t) => !added.includes(t)).sort(),
      );
    }
  });
});

describe('motir moves exactly the approved roles, and nothing else', () => {
  for (const theme of THEMES) {
    it(`motir/${theme}: resolved layer = pre-change layer + the approved changes`, () => {
      expect(resolvedLayer({ palette: 'motir', theme })).toEqual({
        ...before[`motir/${theme}`],
        ...MOTIR_CHANGES[theme],
      });
    });
  }
});

describe('no other palette moved', () => {
  for (const palette of PALETTE_IDS.filter((id) => id !== 'motir')) {
    for (const theme of THEMES) {
      it(`${palette}/${theme}: resolved layer = pre-change layer, new roles = their old consumers`, () => {
        const prior = before[`${palette}/${theme}`]!;
        const added = Object.fromEntries(
          Object.entries(NEW_ROLES).map(([role, was]) => [role, prior[was]]),
        );
        expect(resolvedLayer({ palette, theme })).toEqual({ ...prior, ...added });
      });
    }
  }
});

describe('the motir block stays on the colour axis, in both themes', () => {
  const light = paletteBlock('motir', 'light');
  const dark = paletteBlock('motir', 'dark');

  it('sets colour tokens only', () => {
    for (const token of [...Object.keys(light), ...Object.keys(dark)]) {
      expect(token, token).toMatch(/^--(color|el)-/);
    }
  });

  it('every warm-touch token it sets is set in both themes', () => {
    const warm = [
      '--color-accent',
      '--color-tint-peach',
      '--color-tint-yellow',
      '--el-type-design',
      '--el-progress-fill',
      '--el-editor-focus',
    ];
    for (const token of warm) {
      expect(light, `light ${token}`).toHaveProperty(token);
      expect(dark, `dark ${token}`).toHaveProperty(token);
    }
  });
});

describe('the consumers the design named read the new roles', () => {
  const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

  it.each([
    'app/(onboarding)/onboarding/import/_components/RunStep.tsx',
    'app/(authed)/items/[key]/_components/AttachmentsPanel.tsx',
  ])('%s fills its progress bar with --el-progress-fill', (path) => {
    expect(read(path)).toContain('bg-(--el-progress-fill)');
  });

  it("MarkdownEditor's focus border and rings read --el-editor-focus, not --el-highlight", () => {
    const src = read('components/ui/MarkdownEditor.tsx');
    expect(src.match(/--el-editor-focus/g)?.length).toBe(3);
    expect(src).not.toMatch(/(ring|border)-\(--el-highlight\)/);
  });
});
