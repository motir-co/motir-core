import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '@/lib/utils/regexp';

// MOTIR-1276 · 1266.5 — the new INTERACTION / AGILE element tokens (selection /
// drop-target / board-column accent / overdue / due-soon / sprint+epic accent /
// archived pill / auth wash / tabnav / card-icon) plus the wired-at-last
// --el-vote-bg. The COMPREHENSIVE per-palette coverage / swap-layer matrix is
// owned by 1266.7; this suite pins THIS card's contract: each token exists in
// the Tier-3 base block mapped to the right Tier-0 --color-* (so every palette
// re-skins it via its --color-* override), and the cited dnd / selection / due
// / tabnav surfaces are migrated OFF the shared --el-tint-lavender / --el-accent
// pool onto the dedicated tokens (un-collapsing the meanings — story MOTIR-1266).
// The due SURFACE (`DueValue`) is gone: its last renderer, the unrendered inline
// due editor, was removed in MOTIR-10591, so only the overdue / due-soon TOKENS
// are still pinned here.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS = read('app/globals.css') + read('packages/design-system/theme.css');

// The Tier-3 base block (the only place a new --el-* is defined; palettes
// override the underlying --color-*, not the --el-*). It's a flat declaration
// block, so it runs from its selector's `{` to the first `}`.
const BASE_BLOCK = (() => {
  const m = GLOBALS_CSS.match(/:root,\s*\[data-appearance-scope\]\s*\{/);
  expect(m?.index).toBeGreaterThanOrEqual(0);
  const open = m!.index! + m![0].length;
  const close = GLOBALS_CSS.indexOf('}', open);
  expect(close).toBeGreaterThan(open);
  return GLOBALS_CSS.slice(open, close);
})();

function mappingOf(token: string): string | null {
  const m = BASE_BLOCK.match(new RegExp(`${escapeRegExp(token)}:\\s*var\\((--color-[a-z-]+)\\)`));
  return m?.[1] ?? null;
}

describe('interaction / agile element tokens map to their Tier-0 --color-* base', () => {
  // Every token maps to a --color-* so a palette swap (which overrides the
  // --color-*, not the --el-*) reaches it (the swap-layer contract). Bases per
  // design/design-system/design-notes.md §G.
  const EXPECTED: Record<string, string> = {
    // Drag · drop · selection — selection is SKY, distinct from the lavender drop.
    '--el-selection-bg': '--color-tint-sky',
    '--el-droptarget-bg': '--color-tint-lavender',
    '--el-board-column-accent': '--color-primary',
    // Due dates — overdue red, due-soon amber (was indistinguishable from future).
    '--el-overdue': '--color-destructive',
    '--el-due-soon': '--color-warning',
    // Agile accents.
    '--el-sprint-accent': '--color-tint-lavender',
    '--el-epic-accent': '--color-accent',
    '--el-archived-pill-bg': '--color-muted',
    '--el-archived-pill-text': '--color-slate',
    // Tab nav · auth wash · card-icon tile.
    '--el-auth-wash': '--color-tint-sky',
    '--el-tabnav-track': '--color-surface',
    '--el-tabnav-active': '--color-primary',
    '--el-card-icon-bg': '--color-muted',
    '--el-card-icon-fg': '--color-primary',
  };

  it('defines every interaction/agile token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token), token).toBe(base);
    }
  });

  it('keeps the active-tab accent a zero-change alias of --el-accent-on-surface', () => {
    // The migrated active-tab glyph went from --el-accent-on-surface to
    // --el-tabnav-active; both map to --color-primary, so the swap is zero-change
    // in the base while making the tab bar independently tunable.
    expect(mappingOf('--el-tabnav-active')).toBe(mappingOf('--el-accent-on-surface'));
  });
});

describe('dnd drop targets route through --el-droptarget-bg / --el-board-column-accent', () => {
  const DROP_FILES = [
    'app/(authed)/boards/_components/BoardColumn.tsx',
    'app/(authed)/boards/_components/LaneCell.tsx',
    'app/(authed)/boards/_components/SwimlaneBoard.tsx',
    'app/(authed)/backlog/_components/BacklogList.tsx',
    'app/(authed)/dashboard/_components/DashboardGrid.tsx',
  ];

  it('every drop surface uses the drop-target fill, none the raw --el-tint-lavender', () => {
    for (const f of DROP_FILES) {
      const src = read(f);
      expect(src, f).toContain('--el-droptarget-bg');
      // the drop-zone fill must no longer be the shared lavender tint
      expect(src, f).not.toMatch(/\b(bg|outline|inset-ring|border)-\(--el-tint-lavender\)/);
    }
  });

  it('the drop ring/border uses --el-board-column-accent', () => {
    for (const f of DROP_FILES) {
      expect(read(f), f).toContain('--el-board-column-accent');
    }
  });
});

describe('selected surfaces use --el-selection-bg (distinct from the drop target)', () => {
  it('BacklogRow + CompleteSprintDialog selected state is the selection token, not lavender', () => {
    for (const f of [
      'app/(authed)/backlog/_components/BacklogRow.tsx',
      'app/(authed)/backlog/_components/CompleteSprintDialog.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('bg-(--el-selection-bg)');
      expect(src, f).not.toContain('bg-(--el-tint-lavender)');
    }
  });
});

describe('agile accents + tabnav + card-icon + vote are wired to their tokens', () => {
  it('SprintHeader emphasis uses --el-sprint-accent', () => {
    expect(read('app/(authed)/boards/_components/SprintHeader.tsx')).toContain(
      'bg-(--el-sprint-accent)',
    );
  });

  it('the Archived pill has a dedicated tone routed to --el-archived-pill-*', () => {
    const pill = read('packages/design-system/src/components/ui/Pill.tsx');
    expect(pill).toContain('bg-(--el-archived-pill-bg)');
    expect(pill).toContain('text-(--el-archived-pill-text)');
    expect(read('app/(authed)/_components/ProjectSwitcher.tsx')).toContain('tone="archived"');
  });

  it('the Segmented primitive routes track + active through --el-tabnav-*', () => {
    // `PublicTabNav` moved to motir-marketing (MOTIR-3951); the token route is
    // now asserted on the surviving Segmented primitive alone.
    const src = read('packages/design-system/src/components/ui/Segmented.tsx');
    expect(src).toContain('bg-(--el-tabnav-track)');
    expect(src).toContain('--el-tabnav-active');
  });

  it('the auth layout paints --el-auth-wash behind the sign-in card', () => {
    expect(read('app/(auth)/layout.tsx')).toContain('bg-(--el-auth-wash)');
  });

  it('the report hub card icon tile uses the --el-card-icon-* pair', () => {
    const src = read('app/(authed)/reports/page.tsx');
    expect(src).toContain('bg-(--el-card-icon-bg)');
    expect(src).toContain('text-(--el-card-icon-fg)');
  });
});
