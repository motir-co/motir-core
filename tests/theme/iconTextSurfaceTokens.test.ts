import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '@/lib/utils/regexp';

// MOTIR-1275 · 1266.4 — the ICON + TEXT-role element tokens (--el-icon-*,
// --el-text-{eyebrow,subtitle,helper,identifier}) plus the COMPONENT-SURFACE
// primitives (--el-tooltip-*, --el-switch-*, --el-option-active-bg,
// --el-overlay-scrim, --el-chip-*, --el-card, --el-input-border,
// --el-button-border, --el-count-*). The comprehensive per-palette swap matrix
// is owned by 1266.7; this suite pins THIS card's contract: the tokens exist in
// the Tier-3 base mapped to the right Tier-0 --color-* (so every palette
// re-skins them through its --color-* override), the lone concrete token
// (--el-overlay-scrim) carries an explicit dark companion, and every cited
// consumer is migrated off the overloaded --el-text-muted / --el-surface /
// --el-border(-strong) / --el-text onto its dedicated token.
// design/design-system/design-notes.md §E–F.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS = read('app/globals.css') + read('packages/design-system/theme.css');

// The Tier-3 base block (the only place a new --el-* is defined; palettes
// override the underlying --color-*, not the --el-*). Flat declaration block:
// from its selector's `{` to the first `}`.
const BASE_BLOCK = (() => {
  const m = GLOBALS_CSS.match(/:root,\s*\[data-appearance-scope\]\s*\{/);
  expect(m?.index).toBeGreaterThanOrEqual(0);
  const open = m!.index! + m![0].length;
  const close = GLOBALS_CSS.indexOf('}', open);
  expect(close).toBeGreaterThan(open);
  return GLOBALS_CSS.slice(open, close);
})();

function mappingOf(token: string): string | null {
  const m = BASE_BLOCK.match(
    new RegExp(`${escapeRegExp(token)}:\\s*var\\(\\s*(--color-[a-z-]+)\\s*\\)`),
  );
  return m?.[1] ?? null;
}

describe('icon/text-role + surface-primitive tokens map to their Tier-0 --color-* base', () => {
  // Each token defaults to today's exact value so the motir base is unchanged;
  // mapping to a --color-* is what lets a palette swap reach it. (The two
  // deliberate spec-vs-shipped reconciliations are asserted separately below.)
  const EXPECTED: Record<string, string> = {
    // §E — icon roles
    '--el-icon-muted': '--color-muted-foreground',
    '--el-icon-active': '--color-primary',
    '--el-icon-btn': '--color-foreground',
    '--el-icon-heading': '--color-charcoal',
    '--el-icon-field': '--color-muted-foreground',
    // §E — text roles
    '--el-text-eyebrow': '--color-muted-foreground',
    '--el-text-subtitle': '--color-slate',
    '--el-text-helper': '--color-muted-foreground',
    '--el-text-identifier': '--color-slate',
    // §F — component-surface primitives (--el-overlay-scrim is concrete; below)
    '--el-tooltip-bg': '--color-foreground',
    '--el-tooltip-text': '--color-background',
    '--el-switch-on': '--color-primary-fill',
    // MOTIR-5715 — the ON track's edge is the primary INK, not the fill: the fill
    // is under 3:1 on the page in three light palettes (switchStateContrast.test.ts).
    '--el-switch-on-border': '--color-primary',
    // MOTIR-5725 — the OFF edge was --el-border-strong (1.52-2.41:1 on the page);
    // it takes the OFF knob's own ink, and --el-border-strong keeps its mapping.
    '--el-switch-off-border': '--color-muted-foreground',
    // MOTIR-5711 — the knob is a PAIR with its track: ON is the fill's own ink,
    // OFF the muted grey (switchStateContrast.test.ts measures both at 3:1).
    '--el-switch-knob': '--color-primary-foreground',
    '--el-switch-knob-off': '--color-muted-foreground',
    '--el-option-active-bg': '--color-muted',
    '--el-chip-bg': '--color-surface',
    '--el-chip-border': '--color-border',
    '--el-card': '--color-background',
    '--el-input-border': '--color-hairline-strong',
    // MOTIR-2495 — the non-editable field states, expressed as colour rather
    // than as an opacity filter over the whole subtree.
    '--el-input-disabled-bg': '--color-muted',
    '--el-input-disabled-border': '--color-hairline',
    '--el-input-disabled-text': '--color-slate',
    '--el-input-readonly-bg': '--color-surface',
    '--el-button-border': '--color-hairline-strong',
    '--el-count-text': '--color-slate',
    // count-bg is the documented rung-2 deviation (--color-muted, not the spec's
    // tentative --color-surface — see the dedicated test below).
    '--el-count-bg': '--color-muted',
  };

  it('defines every icon/text/surface token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token), token).toBe(base);
    }
  });

  it('preserves the prior shipped value (zero visual change vs the overloaded token)', () => {
    // Icons kept --el-text-muted's base; field/eyebrow/helper too.
    expect(mappingOf('--el-icon-muted')).toBe(mappingOf('--el-text-muted'));
    expect(mappingOf('--el-icon-field')).toBe(mappingOf('--el-text-muted'));
    expect(mappingOf('--el-text-eyebrow')).toBe(mappingOf('--el-text-muted'));
    expect(mappingOf('--el-text-helper')).toBe(mappingOf('--el-text-muted'));
    // active icon kept --el-accent-on-surface's base (= --color-primary).
    expect(mappingOf('--el-icon-active')).toBe(mappingOf('--el-accent-on-surface'));
    // identifier/subtitle are the secondary-copy weight (= --el-text-secondary).
    expect(mappingOf('--el-text-identifier')).toBe(mappingOf('--el-text-secondary'));
    expect(mappingOf('--el-text-subtitle')).toBe(mappingOf('--el-text-secondary'));
    // tooltip inverts exactly like the prior --el-text / --el-text-inverted pair.
    expect(mappingOf('--el-tooltip-bg')).toBe(mappingOf('--el-text'));
    expect(mappingOf('--el-tooltip-text')).toBe(mappingOf('--el-text-inverted'));
    // switch on kept --el-accent's base. The knob did NOT keep --el-surface's
    // (MOTIR-5711): that value was invisible on the OFF track and under 3:1 on
    // five palettes' ON fill, so it now writes the accent fill's own ink.
    expect(mappingOf('--el-switch-on')).toBe(mappingOf('--el-accent'));
    expect(mappingOf('--el-switch-knob')).toBe(mappingOf('--el-accent-text'));
    // chip kept --el-surface / --el-border; card kept --el-page-bg (= background).
    expect(mappingOf('--el-chip-bg')).toBe(mappingOf('--el-surface'));
    expect(mappingOf('--el-chip-border')).toBe(mappingOf('--el-border'));
    expect(mappingOf('--el-card')).toBe(mappingOf('--el-page-bg'));
    // control borders kept --el-border-strong (= --color-hairline-strong).
    expect(mappingOf('--el-input-border')).toBe(mappingOf('--el-border-strong'));
    expect(mappingOf('--el-button-border')).toBe(mappingOf('--el-border-strong'));
  });

  it('--el-count-bg is the shipped count-badge fill (--color-muted), not surface', () => {
    // rung-2: board count badges render ON an --el-surface column, so a surface
    // fill would erase them — the shipped badge is --el-muted. Documented
    // deviation from the spec's tentative --color-surface (design-notes §F).
    expect(mappingOf('--el-count-bg')).toBe('--color-muted');
    expect(mappingOf('--el-count-bg')).toBe(mappingOf('--el-muted'));
  });

  it('--el-overlay-scrim is the lone concrete token with an explicit dark companion', () => {
    // No --color-* base (palette-independent black scrim); light in :root, dark
    // in the [data-theme="dark"] block, mirroring --el-sidebar-item-bg-hover.
    expect(mappingOf('--el-overlay-scrim')).toBeNull();
    expect(BASE_BLOCK).toMatch(/--el-overlay-scrim:\s*#00000066/);
    const darkBlock = GLOBALS_CSS.slice(GLOBALS_CSS.indexOf('--el-sidebar-item-bg-hover: #222222'));
    expect(darkBlock).toMatch(/--el-overlay-scrim:\s*#000000a6/);
  });
});

describe('every cited consumer is migrated onto its dedicated token', () => {
  it('Tooltip uses --el-tooltip-bg / -text (not --el-text / --el-text-inverted)', () => {
    const src = read('packages/design-system/src/components/ui/Tooltip.tsx');
    expect(src).toContain('bg-(--el-tooltip-bg) text-(--el-tooltip-text)');
    expect(src).toContain('fill-(--el-tooltip-bg)');
    expect(src).not.toMatch(/bg-\(--el-text\)/);
  });

  it('Switch uses --el-switch-on (track) + --el-switch-on-border (edge) + --el-switch-knob (thumb)', () => {
    const src = read('packages/design-system/src/components/ui/Switch.tsx');
    expect(src).toContain('border-(--el-switch-on-border) bg-(--el-switch-on)');
    expect(src).toContain('bg-(--el-switch-knob)');
  });

  it('Modal uses --el-overlay-scrim, --el-text-subtitle (desc), --el-icon-muted (close)', () => {
    const src = read('packages/design-system/src/components/ui/Modal.tsx');
    expect(src).toContain('bg-(--el-overlay-scrim)');
    expect(src).not.toContain('bg-black/40');
    expect(src).toContain('text-(--el-text-subtitle)');
    expect(src).toContain('text-(--el-icon-muted) hover:text-(--el-text)');
  });

  it('Card (untinted) + the bg-card orphans use --el-card', () => {
    expect(read('packages/design-system/src/components/ui/Card.tsx')).toContain(
      "none: 'bg-(--el-card)'",
    );
    const workflow = read('app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx');
    const edit = read('app/(authed)/items/[key]/edit/_components/EditIssueForm.tsx');
    expect(workflow).not.toMatch(/\bbg-card\b/);
    expect(edit).not.toMatch(/\bbg-card\b/);
    expect(workflow).toContain('bg-(--el-card)');
    expect(edit).toContain('bg-(--el-card)');
  });

  it('Button (secondary) + Input use --el-button-border / --el-input-border + --el-icon-field', () => {
    expect(read('packages/design-system/src/components/ui/Button.tsx')).toContain(
      'border border-(--el-button-border)',
    );
    const input = read('packages/design-system/src/components/ui/Input.tsx');
    expect(input).toContain('border-(--el-input-border)');
    expect(input).toContain('text-(--el-icon-field)');
  });

  it('Input draws its non-editable states with --el-input-* colour, never opacity (MOTIR-2495)', () => {
    // The regression this pins: `opacity-50` on the wrapper composited the
    // affixes below AA, and no ink could fix it — so the token layer, not the
    // call site, has to carry the state. A re-introduced opacity filter would
    // re-open the defect on every disabled field with a prefix or suffix.
    //
    // ⚠️ THIS STAYS A PER-FILE PIN, AND MOTIR-4475 IS WHY THAT IS NOW THE RIGHT
    // SCOPE RATHER THAN A GAP. That card met the same class at a second site —
    // `PlanItemNode`'s pending `remove` frame, `opacity-80` on the element that
    // paints the fill — and asked whether this ban should be generalised to
    // every component that dims a text-bearing subtree. It should not, for two
    // reasons. A STATIC `opacity-\d` ban cannot tell a dimmed text subtree from
    // the legitimate uses all over this tree (`hover:opacity-90` on a button, a
    // spinner, a decorative overlay), so widening it by file list buys a growing
    // allowlist and the same blind spot one file over — the shape MOTIR-3693
    // already paid for on `TINTED_SURFACE_TOKENS`. And the general instrument
    // now EXISTS at the tier that can decide it: `tests/helpers/
    // renderedInkContrast.ts` composites every `opacity-<n>` on an element or
    // any ancestor into both ink and surface before measuring, so any component
    // the composed-surface sweep mounts is covered by MEASUREMENT rather than by
    // a string ban, and `--el-text-secondary` joined its default ink set for the
    // same reason.
    //
    // What this pin still buys, and what keeps it here: `Input.tsx` lives in
    // `packages/design-system` and is a PRIMITIVE — the render-time guard rules
    // on the surfaces that mount it, never on the primitive itself, and the
    // token trio below (`--el-input-disabled-bg` / `-border` / `-text`) is the
    // decision this test is really pinning.
    const input = read('packages/design-system/src/components/ui/Input.tsx');
    // Comments stripped first — the doc comment NAMES `opacity-50` to explain
    // why it is gone, and that sentence is the point, not a violation.
    const code = input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/opacity-\d/);
    expect(input).toContain('bg-(--el-input-disabled-bg)');
    expect(input).toContain('border-(--el-input-disabled-border)');
    expect(input).toContain('text-(--el-input-disabled-text)');
    expect(input).toContain('bg-(--el-input-readonly-bg)');
  });

  it('Combobox: eyebrow header, option-active-bg, identifier, icon-muted chevron, accent check', () => {
    const src = read('packages/design-system/src/components/ui/Combobox.tsx');
    expect(src).toContain('text-(--el-text-eyebrow)');
    expect(src).toContain('bg-(--el-option-active-bg)');
    expect(src).toContain('text-(--el-text-identifier)');
    expect(src).toContain('text-(--el-icon-muted)'); // the trigger chevron
    // The selected-row check is unified with MultiSelectPicker on the accent.
    expect(src).toContain('text-(--el-accent-on-surface)');
  });

  it('DatePicker calendar icon uses --el-icon-field', () => {
    expect(read('packages/design-system/src/components/ui/DatePicker.tsx')).toContain(
      'h-4 w-4 shrink-0 text-(--el-icon-field)',
    );
  });

  it('MultiSelectPicker: chip tokens, option-active-bg, icon-muted, text-helper hint, accent check', () => {
    const src = read('packages/design-system/src/components/ui/MultiSelectPicker.tsx');
    expect(src).toContain('bg-(--el-chip-bg)');
    expect(src).toContain('border border-(--el-chip-border)');
    expect(src).toContain('bg-(--el-option-active-bg)');
    expect(src).toContain('text-(--el-icon-muted)');
    expect(src).toContain('text-(--el-text-helper)');
    expect(src).toContain('text-(--el-accent-on-surface)'); // the selected check
  });

  it('Pill neutral tone uses --el-chip-bg / --el-chip-border', () => {
    expect(read('packages/design-system/src/components/ui/Pill.tsx')).toContain(
      'bg-(--el-chip-bg) text-(--el-text-secondary) border-(--el-chip-border)',
    );
  });

  it('SectionLabel + FormField + EmptyState use the text-role tokens', () => {
    expect(read('packages/design-system/src/components/ui/SectionLabel.tsx')).toContain(
      'text-(--el-text-eyebrow)',
    );
    expect(read('packages/design-system/src/components/ui/FormField.tsx')).toContain(
      'text-(--el-text-helper)',
    );
    const empty = read('packages/design-system/src/components/ui/EmptyState.tsx');
    expect(empty).toContain('text-(--el-text-subtitle)'); // description
    expect(empty).toContain('text-(--el-icon-muted)'); // the empty-state glyph
  });

  it('Sidebar nav icons use --el-icon-active / --el-icon-muted', () => {
    const src = read('components/ui/Sidebar.tsx');
    expect(src).toContain('text-(--el-icon-active)');
    expect(src).toContain('text-(--el-icon-muted)');
    // The active nav icon no longer borrows --el-accent-on-surface.
    expect(src).not.toMatch(/isActive \? 'text-\(--el-accent-on-surface\)'/);
  });

  it('board count badges (column / swimlane / WIP / points) use --el-count-bg / -text', () => {
    const files = [
      // The lane header's count badge (flat column + swimlane pinned header)
      // lives in LanePager since MOTIR-10535.
      'app/(authed)/boards/_components/LanePager.tsx',
      'app/(authed)/boards/_components/SwimlaneBoard.tsx',
      'app/(authed)/boards/_components/ColumnWipBadge.tsx',
      'app/(authed)/boards/_components/ColumnPointsBadge.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).toContain('bg-(--el-count-bg)');
      expect(src, f).toContain('text-(--el-count-text)');
    }
  });
});
