import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-2306 / MOTIR-8903 — the shape-swap LINT guard: the RADIUS axis, then the
// own-box PADDING / HEIGHT axis.
//
// The sibling of `swapLayerLint.test.ts`, one axis over. That guard enforces
// "colour flows through `--el-*`, never Tier-0 `--color-*`"; this one enforces
// the SHAPE half of the same contract (motir-core/CLAUDE.md, "Shape (radius +
// spacing + sizing) flows through element-semantic shape tokens"): a surface's
// own radius must name one of the seven element-semantic ROLES —
// `--radius-{btn,card,input,modal,badge,control,kbd}` — because a `[data-style]`
// block overrides those and nothing else.
//
// ── Why this needs a guard and not a code review ────────────────────────────
// Measured on packages/design-system/theme.css: NINE of the TEN bare
// `[data-style]` token blocks also override the Tier-0 `--radius-xs/sm/md/lg/xl`
// scale. So a surface that escaped to `rounded-md` still *moves* when the style
// changes — it just moves to the container radius instead of the control radius.
// Only `soft-playful` leaves the generic scale alone, which is the single style
// where the seam is visible to the eye. A reviewer flipping styles sees the
// screen reshape and concludes it works. The escape is mechanically detectable
// and visually not, which is exactly the case a lint owns.
//
// ── THE OWN-BOX CHECK (MOTIR-8903) ─────────────────────────────────────────
// `CLAUDE.md`'s shape rule also covers a surface's own PADDING and HEIGHT, and
// this file guards them too, in the second `describe` block below. They could
// not be guarded while the token set offered ONE value per role (a card's
// `--spacing-card-padding` is 24px while the code pads cards at nine different
// values). MOTIR-2336 decided a density scale and MOTIR-8901 declared its 21
// derived steps (`--spacing-control-x-8`, `--height-control-40`, …), so there is
// now something correct to route a raw `p-3` or `h-7` to.
//
// The check is OFF everywhere until a sweep card turns it on for the area it
// migrated: `OWN_BOX_ENFORCED_PREFIXES` is empty and so is `OWN_BOX_ALLOWED`.
// Those two constants are the only edit points. A sweep card appends its area
// to the first and records any value a reviewer accepted in the second; the
// final sweep card sets the prefixes to the full scanned roots.
//
// ── The own-box / layout distinction the shape rule turns on ────────────────
// A surface's OWN box — its radius, its own padding, its own height — is SHAPE
// and must flow through a token, because a style swap redefines how chrome is
// shaped. Spacing BETWEEN siblings — `gap-2`, a one-off `mb-1`, a page gutter —
// is LAYOUT and correctly stays raw: it describes composition, not the surface.
// Radius is unambiguously the first kind. Padding and height are the first kind
// only when they are the surface's OWN box, and the own-box check applies the
// distinction in code (`ownBoxVerdict`): a raw value is LAYOUT, not flagged, when
// it is zero padding, padding of 32px and over, a height of 24px and under, or it
// sits on a `rounded-full` surface; gaps, `space-*`, margins, `min-h-*`, `max-h-*`
// and `size-*` are never matched at all. A surface is recognised by a literal that
// carries a token-radius utility, because only a shaped surface owes the swap layer
// its box.
//
// ── Why the check strips comments first ────────────────────────────────────
// Same reason as swapLayerLint (notes.html #195): migration comments quote the
// class they replaced ("was a raw `rounded-md`; routes through
// `--radius-control` now"), and a guard that had to be deleted on its first run
// because it matched its own paper trail would be worse than none. The scan
// strips block + line comments and asserts against CODE.

const REPO = process.cwd();

/**
 * Every TRACKED source file that can put a shaped surface on screen. The same
 * set `swapLayerLint` scans, and for the same reason: the contract is not
 * "components are clean", it is "nothing shapes past the layer".
 */
function renderedSources(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      'components/*.tsx',
      'components/**/*.tsx',
      'components/**/*.ts',
      'app/**/*.tsx',
      'app/**/*.ts',
      'lib/**/*.tsx',
      'lib/**/*.ts',
      'packages/design-system/src/**/*.tsx',
      'packages/design-system/src/**/*.ts',
    ],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

/** Drop block comments and line comments, keeping `https://` intact. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A radius utility that does NOT route through the swap layer.
 *
 * Matches `rounded`, `rounded-md`, `rounded-t-lg`, `rounded-(--radius-sm)`,
 * `rounded-[6px]` — anything whose suffix is not an element-semantic role.
 * Two suffixes pass:
 *   • `-full` / `(--radius-pill)` — a genuinely circular thing (spinner, avatar,
 *     status dot, switch track) is not style-dependent; CLAUDE.md says so.
 *   • `(--radius-{btn,card,input,modal,badge,control,kbd})` — the roles a
 *     `[data-style]` block actually overrides.
 * A bare `rounded` (no suffix at all) is Tailwind's 0.25rem default and is
 * flagged: it is the quietest form of the same escape.
 */
const ROLES = ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd', 'pill'];

/**
 * Any radius utility at all, with its corner scope and its value split out:
 * `rounded` · `rounded-md` · `rounded-t-(--radius-card)` · `rounded-[6px]`.
 *
 * The match is deliberately permissive and the VERDICT is taken in code below.
 * Encoding "…but not a semantic role" as a negative lookahead inside the pattern
 * looks equivalent and is not: on `rounded-t-(--radius-card)` the engine
 * backtracks out of the corner group and re-reads the whole tail as an opaque
 * suffix, flagging a correct usage. The negative-control test below is what
 * caught that; keep the split.
 */
const RADIUS_UTIL = new RegExp(
  `(?<=^|[\\s"'\`])rounded(?:-(?:[trbl][lr]?|[se]{1,2}))?(?:-(\\(--radius-[a-z0-9-]+\\)|\\[[^\\]]*\\]|[a-z0-9]+))?(?=$|[\\s"'\`])`,
  'g',
);

/** Does this radius utility's value reach the swap layer? */
function reachesSwapLayer(value: string | undefined): boolean {
  if (value === undefined) return false; // bare `rounded` — Tailwind's 0.25rem default
  if (value === 'full') return true; // a genuine circle is not style-dependent
  const role = /^\(--radius-([a-z-]+)\)$/.exec(value);
  return role !== null && ROLES.includes(role[1]!);
}

/**
 * A line is CLASS CONTEXT when it carries at least one unambiguous utility.
 *
 * Needed because `rounded` is also an English word, and the style registry
 * describes its own styles in prose — "Soft, rounded glass tiles", "Pill buttons
 * (fully rounded)". Those lines carry no utility class, so they are skipped;
 * every real `className` line carries several. Scanning per LINE rather than per
 * string literal also keeps multi-line template literals in view.
 */
const CLASS_CONTEXT =
  /(?:^|[\s"'`{])(?:flex|inline-flex|grid|block|inline-block|absolute|relative|fixed|sticky|border|truncate|shadow-|(?:bg|text|border|ring|fill|stroke|divide)-\(--|(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|w|h|size|min-w|max-w|min-h|max-h)-[\d.]|hover:|focus|group|shrink-|grow|items-|justify-|overflow-|animate-|cursor-|select-|transition|rounded-\(--radius-)/;

const SOURCES = renderedSources();

/** Every `file → token` pair whose radius does not reach the swap layer. */
function inertRadiusOffenders(): string[] {
  const found = new Set<string>();
  for (const file of SOURCES) {
    const source = stripComments(readFileSync(join(REPO, file), 'utf8'));
    for (const line of source.split('\n')) {
      if (!CLASS_CONTEXT.test(line)) continue;
      for (const match of line.matchAll(RADIUS_UTIL)) {
        if (!reachesSwapLayer(match[1])) found.add(`${file} → ${match[0]}`);
      }
    }
  }
  return [...found].sort();
}

describe('shape-swap lint — no surface shapes its radius past the token layer', () => {
  it('scans a real, non-empty set of rendered sources', () => {
    // notes.html #195: the guard has to be the search that was actually run.
    expect(SOURCES.length).toBeGreaterThan(1000);
    expect(SOURCES).toContain('components/issues/StatusPicker.tsx');
    expect(SOURCES).toContain('packages/design-system/src/components/ui/Pill.tsx');
    expect(SOURCES).toContain('app/(authed)/items/[key]/_components/ChildList.tsx');
  });

  it('names an element-semantic radius role everywhere outside the documented exceptions', () => {
    // The `/tokens` specimen route is exempt as a DIRECTORY, not file-by-file —
    // the same exemption swapLayerLint grants it for `--color-*`, and for the
    // same reason: its whole job is to render the Tier-0 scale as labelled
    // swatches, inside mock chrome built from Tier-0 utilities. Listing its
    // current radii instead would go stale the day a swatch is added.
    const ALLOWED_PREFIXES = ['app/tokens/'];

    // Entries are `file → token`, not bare filenames, so a NEW escape in a file
    // that already has a documented one cannot hide behind it.
    const ALLOWED = [
      // A PICTOGRAM, not a surface. These are the 4px-wide bars that draw the
      // column-count icon inside the layout picker; the BUTTON around them
      // already uses `--radius-control`. A 1px nub on a 4px bar is icon
      // geometry — routing it to the 6px control radius would round it into a
      // pill and destroy the glyph. Icons do not reshape with the style.
      'app/(authed)/dashboard/_components/DashboardGrid.tsx → rounded-[1px]',
      // Deliberately NO shape: the attachment lightbox passes this to `Modal`
      // to strip the panel's entire chrome (`rounded-none border-0
      // bg-transparent p-0 shadow-none`) so the image floats on a bare overlay.
      // There is no surface left to shape, and `--radius-modal` would put a
      // corner on a transparent stage. The neighbouring `border-0` /
      // `shadow-none` are the same override in the other axes.
      'app/(authed)/items/[key]/_components/AttachmentPreview.tsx → rounded-none',
      // The same case, one surface over (MOTIR-3895): the RUN MODAL is a
      // `size="full"` dialog, so it IS the viewport. `--radius-modal` would draw
      // a corner where the screen's own edge is, and the panel border it pairs
      // with would frame the whole display. `border-0` beside it is that same
      // override in the other axis, exactly as the lightbox's is.
      'app/(authed)/runs/_components/RunModal.tsx → rounded-none',
      // And the same case once more (MOTIR-4729): the planning workspace is a
      // `size="full"` dialog too, and for the same reason — an OVERLAY covers the
      // screen it opens over, so the panel IS the viewport and its corner is the
      // display's own. The design measured it edge to edge (0px radius, 0px
      // border) precisely so nothing draws a frame around the page underneath;
      // `border-0 p-0` beside it are that decision in the other axes.
      'components/planning/PlanningWorkspaceOverlay.tsx → rounded-none',
      // The same case a fourth time (MOTIR-5224): the approval overlay is that
      // pattern's fourth instance — a `size="full"` dialog over the page it opens
      // on, drawn edge to edge by design-notes § 22 so the frame's bands run to
      // the display's own corners. `border-0 p-0` beside it are the same decision.
      'components/approvals/ApprovalOverlay.tsx → rounded-none',
      // A value DERIVED from a semantic token: the inner pill of a segmented
      // control fits its shell only at `--radius-btn` minus the shell's 2px
      // border, and `calc()` over the role token is how that stays true under
      // every style. This SWAPS correctly — it is the rule being followed, not
      // escaped, and there is no role token for "the inside of a segment".
      'packages/design-system/src/components/theme/AppearancePickers.tsx → rounded-[calc(var(--radius-btn)-2px)]',
      'packages/design-system/src/components/ui/Segmented.tsx → rounded-[calc(var(--radius-btn)-2px)]',
      // The planner-findings view switch is the same segmented track, drawn as
      // a radiogroup of LINKS (each view is a URL), which `Segmented` cannot render.
      'app/(admin)/admin/planner-findings/_components/FindingsViewSwitch.tsx → rounded-[calc(var(--radius-btn)-2px)]',
    ];

    const offenders = inertRadiusOffenders().filter(
      (entry) => !ALLOWED_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    );
    expect(offenders).toEqual([...ALLOWED].sort());

    // The prefix must still be earning its keep — if `/tokens` ever stops
    // rendering Tier-0 radii, delete the exemption rather than leave it standing.
    expect(SOURCES.some((file) => file.startsWith('app/tokens/'))).toBe(true);
  });

  it('recognises the semantic roles and rejects the inert forms (the guard, negative-controlled)', () => {
    const flag = (line: string) =>
      CLASS_CONTEXT.test(line)
        ? [...line.matchAll(RADIUS_UTIL)].filter((m) => !reachesSwapLayer(m[1])).map((m) => m[0])
        : [];

    // The seven roles a [data-style] block overrides, plus circles, all pass.
    for (const role of ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd', 'pill']) {
      expect(flag(`flex items-center rounded-(--radius-${role}) px-2`)).toEqual([]);
    }
    expect(flag('flex h-2 w-2 rounded-full bg-(--el-accent)')).toEqual([]);
    expect(flag('flex rounded-t-(--radius-card) border')).toEqual([]);

    // Every inert form is caught, including the bare and the corner-scoped ones.
    expect(flag('flex items-center rounded-md px-2')).toEqual(['rounded-md']);
    expect(flag('flex items-center rounded px-2')).toEqual(['rounded']);
    expect(flag('flex rounded-(--radius-sm) border')).toEqual(['rounded-(--radius-sm)']);
    expect(flag('flex rounded-t-lg border')).toEqual(['rounded-t-lg']);
    expect(flag('flex rounded-[6px] border')).toEqual(['rounded-[6px]']);
    expect(flag('flex rounded-none border')).toEqual(['rounded-none']);

    // Prose is not code: the style registry describes its own styles in English
    // and must not be flagged for saying the word.
    expect(flag('tagline: "More energy — rounded, generous, gently animated."')).toEqual([]);
    expect(flag('silhouette: "Pill buttons (fully rounded) and large 24px card radii."')).toEqual(
      [],
    );
  });
});

describe('shape-swap lint — the roles exist and every style actually flips them', () => {
  const THEME = readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8');
  const ROLE_TOKENS = ['btn', 'card', 'input', 'modal', 'badge', 'control', 'kbd'];

  it('defines every element-semantic radius role in the @theme base', () => {
    for (const role of ROLE_TOKENS) {
      expect(THEME).toMatch(new RegExp(`--radius-${role}\\s*:`));
    }
  });

  it('overrides every role in every bare [data-style] token block', () => {
    // This is the invariant the whole axis rests on: a role a style forgets to
    // redefine does not flip, so a component that obeyed the rule still looks
    // unstyled. Descendant-selector blocks (`[data-style='x'] [data-surface=…]`,
    // the glassmorphism/aurora material layer) are not token blocks and are
    // excluded — see CLAUDE.md's surface-material exception.
    const blocks = [...THEME.matchAll(/\[data-style='([a-z0-9-]+)'\]\s*\{([\s\S]*?)\n\}/g)];
    expect(blocks.length).toBeGreaterThan(5);

    for (const block of blocks) {
      const style = block[1]!;
      const body = block[2]!;
      const missing = ROLE_TOKENS.filter((role) => !new RegExp(`--radius-${role}\\s*:`).test(body));
      expect({ style, missing }).toEqual({ style, missing: [] });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The own-box axis (MOTIR-8903) — padding and height route onto the density steps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The areas the own-box check is ON for. A sweep card appends the area it
 * migrated (`'components/workItems/'`); the final sweep card sets the three
 * scanned roots. Empty is legal only until then: the check ships enforcing
 * NOTHING so it passes on `main` without touching a component.
 */
const OWN_BOX_ENFORCED_PREFIXES: string[] = ['components/', 'app/', 'packages/design-system/src/'];

/**
 * `file → utility` pairs a reviewer accepted as unplaceable, each with the reason.
 * A record rather than an array so a reason cannot be omitted, and keyed by
 * `file → utility` so a NEW escape in a file that already has one cannot hide
 * behind it.
 */
const OWN_BOX_ALLOWED: Record<string, string> = {
  'packages/design-system/src/components/theme/AppearancePickers.tsx → p-[3px]':
    'Nested inset: the segment radius is derived from the track radius minus this 3px inset, and --radius-btn has no padding steps.',
  'packages/design-system/src/components/ui/Segmented.tsx → p-0.5':
    'Nested inset: the segment radius is derived from the track radius minus this 2px inset (see the comment in the file), and --radius-btn has no padding steps.',
  'components/planning/PlanningWorkspaceSkeleton.tsx → h-16':
    'Skeleton placeholder block sized to mimic the content it stands in for; a layout constant, not a control height, so no height step fits.',
  'components/planning/PlanningWorkspaceSkeleton.tsx → h-20':
    'Skeleton placeholder block sized to mimic the content it stands in for; a layout constant, not a control height, so no height step fits.',
  'components/planning/PlanningWorkspaceSkeleton.tsx → h-32':
    'Skeleton placeholder block sized to mimic the content it stands in for; a layout constant, not a control height, so no height step fits.',
  'components/onboarding/howItWorks/HowItWorksArt.tsx → h-14':
    'Illustration frame sized to its artwork; a layout constant, not a control or card height, so no height step fits.',
  'components/onboarding/howItWorks/HowItWorksArt.tsx → h-16':
    'Illustration frame sized to its artwork; a layout constant, not a control or card height, so no height step fits.',
  'components/onboarding/layout/SectionArt.tsx → h-[208px]':
    'Illustration frame sized to its artwork; a layout constant, not a control or card height, so no height step fits.',
  'components/onboarding/layout/SectionArt.tsx → h-[248px]':
    'Illustration frame sized to its artwork; a layout constant, not a control or card height, so no height step fits.',
  'components/onboarding/howItWorks/HowItWorksArt.tsx → h-7':
    'Illustration of a button drawn at 28px; the button role has no height steps and the art is a fixed-size picture, not a control.',
  'components/settings/SettingsPaneFrame.tsx → h-7':
    'Skeleton stand-in for an action button at 28px; the button role has no height steps and the placeholder mimics content, not a control.',
  'app/(admin)/admin/monitoring/_components/FleetSection.tsx → h-11':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(admin)/admin/page.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(admin)/admin/planner-findings/_components/FindingsViewSwitch.tsx → p-0.5':
    'Nested inset: the 2px inset inside the view switch track is concentric with the segment radius derived from --radius-btn, and the button role has no padding steps.',
  'app/(auth)/reset-password/new/page.tsx → px-6':
    'Full-width call-to-action with 24px side padding; the button role has no steps and --spacing-btn-x is 18px.',
  'app/(auth)/reset-password/page.tsx → px-6':
    'Full-width call-to-action with 24px side padding; the button role has no steps and --spacing-btn-x is 18px.',
  'app/(authed)/dashboard/_components/AddWidgetModal.tsx → h-[58px]':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/dashboard/_components/DashboardGrid.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/dashboard/_components/WidgetConfigModal.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/dashboard/_components/WidgetStateView.tsx → h-[120px]':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/filters/_components/SubscribeDialog.tsx → h-24':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/invite/accept/page.tsx → h-11':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/invite/accept/page.tsx → h-15':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/items/[key]/_components/AcceptancePanel.tsx → py-7':
    '28px empty-state padding sits between the 24px card base and the 32px layout line; no step is within tolerance.',
  'app/(authed)/items/[key]/_components/ChildPanel.tsx → h-[28rem]':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/items/_components/IssueFilterBar.tsx → pl-[30px]':
    "Left inset sized to the leading search icon's geometry, not a density value; the input role has no steps.",
  'app/(authed)/my-agents/_components/AgentPanel.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/ready/page.tsx → h-11':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/reports/_components/AverageAgeReport.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/reports/_components/CreatedVsResolvedReport.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/reports/_components/ReportWindowControls.tsx → p-0.5':
    'Nested inset: the 2px inset inside the Period / Days back segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/reports/_components/ResolutionTimeReport.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/reports/_components/VelocityRangeControls.tsx → p-0.5':
    'Nested inset: the 2px inset inside the sprint-count stepper track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/settings/project/_components/ProjectDetailsCard.tsx → h-[52px]':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/settings/project/members/page.tsx → h-12':
    'Fixed-size tile, skeleton placeholder or layout block (not a control height), so no height step fits.',
  'app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/workbench/_components/WorkbenchTabs.tsx → p-0.5':
    'Nested inset: the 2px inset inside a segmented track is concentric with the track radius, and the button/input role has no padding steps.',
  'app/(authed)/settings/organization/_components/DeleteOrganizationDialog.tsx → p-3':
    'Pre-existing @next/next/no-location-assign-relative-destination warning in this file blocks the zero-warning commit hook for any edit to it; migrate to card-padding-12 once that warning is fixed.',
};

/**
 * A surface is a literal carrying a TOKEN-radius utility: `rounded-(--radius-card)`
 * or a corner-scoped `rounded-t-(--radius-card)`. `rounded-full` and `--radius-pill`
 * are circles and exempt; a literal with no token radius is not a shaped surface.
 */
const TOKEN_RADIUS = new RegExp(
  `(?<=^|[\\s"'\`:!])rounded(?:-(?:[trbl][lr]?|[se]{1,2}))?-\\(--radius-(?:btn|card|input|modal|badge|control|kbd)\\)(?=$|[\\s"'\`!])`,
);

/**
 * An own-box utility: padding (`p px py pt pb pl pr`) or height (`h`), with an
 * optional variant prefix and `!`. `min-h-*`, `max-h-*`, `size-*`, `gap-*`,
 * `space-*` and margins never match: the lookbehind demands a boundary (start,
 * whitespace, a quote, `:` or `!`) directly before the utility's first letter, and
 * `-` is not one. Value is a Tailwind step (`3`, `1.5`), an arbitrary length
 * (`[10px]`) or a token (`(--spacing-control-x-8)`).
 */
const OWN_BOX_UTIL =
  /(?<=^|[\s"'`:!])(p[xytblr]?|h)-(\d+(?:\.\d+)?|\[[^\]\s]+\]|\(--[a-z0-9-]+\))(?=$|[\s"'`!])/g;

/** The `--spacing-*` / `--height-*` names declared in theme.css (base and derived). */
const DECLARED_BOX_TOKENS: ReadonlySet<string> = (() => {
  const css = stripComments(readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8'));
  return new Set([...css.matchAll(/(--(?:spacing|height)-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
})();

/** A length in px, or `null` when the value is not a plain px/rem length. */
function pxOf(value: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 4; // Tailwind: 4px per step
  const arbitrary = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(value);
  if (!arbitrary) return null;
  return Number(arbitrary[1]) * (arbitrary[2] === 'rem' ? 16 : 1);
}

/**
 * The own-box ↔ layout verdict for ONE raw (numeric or arbitrary) value. `flag`
 * means the surface's own box escaped the density steps; `layout` means the value
 * is legitimately raw: zero padding, padding of 32px and over, a height of 24px
 * and under. A value that is not a plain length is `layout` (nothing to route).
 */
function ownBoxVerdict(utility: string, value: string): 'flag' | 'layout' {
  const px = pxOf(value);
  if (px === null) return 'layout';
  if (utility === 'h') return px <= 24 ? 'layout' : 'flag';
  return px === 0 || px >= 32 ? 'layout' : 'flag';
}

/** The own-box utilities of ONE string literal that escape the density steps. */
function ownBoxFlags(literal: string): string[] {
  if (!TOKEN_RADIUS.test(literal)) return [];
  const flagged: string[] = [];
  for (const m of literal.matchAll(OWN_BOX_UTIL)) {
    const [whole, utility, value] = [m[0], m[1]!, m[2]!];
    const token = /^\((--[a-z0-9-]+)\)$/.exec(value);
    if (token) {
      // A token must be declared AND belong to the right family: padding names a
      // `--spacing-*` token, a height names a `--height-*` one.
      const family = utility === 'h' ? '--height-' : '--spacing-';
      if (!DECLARED_BOX_TOKENS.has(token[1]!) || !token[1]!.startsWith(family)) flagged.push(whole);
    } else if (ownBoxVerdict(utility, value) === 'flag') {
      flagged.push(whole);
    }
  }
  return flagged;
}

/** Every string literal of a comment-stripped source, template `${}` bodies blanked. */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map(
    (m) => m[0].replace(/\$\{[^}]*\}/g, ' '),
  );
}

/**
 * Every `file → utility` pair in `sources` (a map of file → raw text) under one of
 * `prefixes` whose own box escapes the density steps. Taking the map and prefixes
 * as parameters is what lets a fixture prove the per-area mechanism bites; the
 * real call passes the tracked set.
 */
function ownBoxOffenders(
  sources: ReadonlyMap<string, string>,
  prefixes: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const [file, text] of sources) {
    if (!prefixes.some((prefix) => file.startsWith(prefix))) continue;
    for (const literal of stringLiterals(stripComments(text))) {
      for (const utility of ownBoxFlags(literal)) found.add(`${file} → ${utility}`);
    }
  }
  return [...found].sort();
}

describe('shape-swap lint — own-box padding and height routes onto the density steps', () => {
  // The `/tokens` specimen route is exempt as a DIRECTORY, as in the radius check.
  const trackedUnder = (prefixes: readonly string[]) =>
    new Map(
      SOURCES.filter(
        (file) =>
          !file.startsWith('lib/') &&
          !file.startsWith('app/tokens/') &&
          prefixes.some((prefix) => file.startsWith(prefix)),
      ).map((file) => [file, readFileSync(join(REPO, file), 'utf8')] as const),
    );

  it('names the offenders in the enforced areas exactly equal to the allowlist', () => {
    const offenders = ownBoxOffenders(
      trackedUnder(OWN_BOX_ENFORCED_PREFIXES),
      OWN_BOX_ENFORCED_PREFIXES,
    );
    expect(offenders).toEqual(Object.keys(OWN_BOX_ALLOWED).sort());
  });

  it('keeps the allowlist honest: reasons present, keys under an enforced prefix, prefixes live', () => {
    for (const [key, reason] of Object.entries(OWN_BOX_ALLOWED)) {
      expect({ key, reason: reason.trim().length > 0 }).toEqual({ key, reason: true });
      const file = key.split(' → ')[0]!;
      expect({ key, enforced: OWN_BOX_ENFORCED_PREFIXES.some((p) => file.startsWith(p)) }).toEqual({
        key,
        enforced: true,
      });
    }
    for (const prefix of OWN_BOX_ENFORCED_PREFIXES) {
      expect({ prefix, matches: SOURCES.some((file) => file.startsWith(prefix)) }).toEqual({
        prefix,
        matches: true,
      });
    }
  });

  it('declares the density steps the check reads from theme.css', () => {
    // The check trusts theme.css for what a token IS; pin that the file it reads
    // actually carries the base and the derived names a sweep will route to.
    for (const name of [
      '--spacing-card-padding',
      '--spacing-card-padding-12',
      '--spacing-control-x-8',
      '--spacing-chip-x-4',
      '--height-control',
      '--height-control-40',
    ]) {
      expect(DECLARED_BOX_TOKENS.has(name)).toBe(true);
    }
  });

  it('flags a raw own box on a shaped surface and passes the density steps (the guard, negative-controlled)', () => {
    // Raw numeric and arbitrary values on a token-radius surface are flagged.
    expect(ownBoxFlags('rounded-(--radius-card) p-3')).toEqual(['p-3']);
    expect(ownBoxFlags('rounded-(--radius-control) h-[28px]')).toEqual(['h-[28px]']);
    expect(ownBoxFlags('rounded-(--radius-badge) px-1.5 py-0.5')).toEqual(['px-1.5', 'py-0.5']);
    expect(ownBoxFlags('rounded-t-(--radius-card) hover:p-2')).toEqual(['p-2']);
    expect(ownBoxFlags('flex rounded-(--radius-control) h-7')).toEqual(['h-7']);

    // A declared density step or base, in the right family, passes.
    expect(
      ownBoxFlags('rounded-(--radius-control) px-(--spacing-control-x-8) h-(--height-control-40)'),
    ).toEqual([]);
    expect(ownBoxFlags('rounded-(--radius-card) py-(--spacing-card-padding)')).toEqual([]);

    // An undeclared ladder name and a token from the wrong family are flagged.
    expect(ownBoxFlags('rounded-(--radius-control) px-(--spacing-control-x-99)')).toEqual([
      'px-(--spacing-control-x-99)',
    ]);
    expect(ownBoxFlags('rounded-(--radius-control) px-(--height-control-40)')).toEqual([
      'px-(--height-control-40)',
    ]);
    expect(ownBoxFlags('rounded-(--radius-control) h-(--spacing-control-x-8)')).toEqual([
      'h-(--spacing-control-x-8)',
    ]);
  });

  it('leaves layout raw: zero, large padding, short heights, circles, gaps, spaces and margins', () => {
    expect(ownBoxFlags('rounded-full h-7 px-1.5')).toEqual([]); // a circle
    expect(ownBoxFlags('rounded-(--radius-card) p-0 px-8 h-6')).toEqual([]); // 0 · 32px · 24px
    expect(ownBoxFlags('rounded-(--radius-card) p-8')).toEqual([]); // 32px and over
    expect(ownBoxFlags('rounded-(--radius-card) p-[0px] h-[24px] px-[32px]')).toEqual([]);
    expect(ownBoxFlags('rounded-(--radius-card) h-4 h-5 h-0.5')).toEqual([]); // 24px and under
    expect(ownBoxFlags('rounded-(--radius-card) gap-3 mt-3 space-y-2 mx-4')).toEqual([]);
    expect(ownBoxFlags('rounded-(--radius-card) min-h-7 max-h-9 size-8')).toEqual([]);
    expect(ownBoxFlags('rounded-(--radius-card) h-full w-3 pt-px')).toEqual([]); // not a raw step
    expect(ownBoxFlags('flex p-3 h-7 px-2')).toEqual([]); // no token radius: not a shaped surface

    // The boundaries: 28px height and 4–16px padding ARE the decision's escapes.
    expect(ownBoxFlags('rounded-(--radius-control) h-8')).toEqual(['h-8']); // 32px
    expect(ownBoxFlags('rounded-(--radius-control) h-[25px]')).toEqual(['h-[25px]']);
    expect(ownBoxFlags('rounded-(--radius-card) p-7')).toEqual(['p-7']); // 28px
    expect(ownBoxFlags('rounded-(--radius-card) p-[31px]')).toEqual(['p-[31px]']);
  });

  it('decides each value in one pure function', () => {
    expect(ownBoxVerdict('p', '0')).toBe('layout');
    expect(ownBoxVerdict('px', '8')).toBe('layout');
    expect(ownBoxVerdict('py', '3')).toBe('flag');
    expect(ownBoxVerdict('h', '6')).toBe('layout');
    expect(ownBoxVerdict('h', '7')).toBe('flag');
    expect(ownBoxVerdict('h', '[2rem]')).toBe('flag');
    expect(ownBoxVerdict('h', '[1.5rem]')).toBe('layout');
    expect(ownBoxVerdict('p', '[calc(1px+2px)]')).toBe('layout');
  });

  it('reads a surface split across lines as one literal per class string', () => {
    const source = [
      'const a = cn(',
      "  'rounded-(--radius-card) border',",
      "  'p-3',", // a different literal: the radius is not here, so this is not an own box
      ');',
      'const b = cn(`rounded-(--radius-control) ${open ? "x" : ""} px-2.5 h-9`);',
    ].join('\n');
    const offenders = ownBoxOffenders(new Map([['components/x/Y.tsx', source]]), ['components/']);
    expect(offenders).toEqual(['components/x/Y.tsx → h-9', 'components/x/Y.tsx → px-2.5']);
  });

  it('is enforced per area: a raw value inside an enforced prefix is found, the same value outside is not', () => {
    const raw = "const c = 'rounded-(--radius-card) p-3 h-9';";
    const sources = new Map([
      ['components/workItems/A.tsx', raw],
      ['components/pages/B.tsx', raw],
    ]);
    expect(ownBoxOffenders(sources, ['components/workItems/'])).toEqual([
      'components/workItems/A.tsx → h-9',
      'components/workItems/A.tsx → p-3',
    ]);
    expect(ownBoxOffenders(sources, [])).toEqual([]);
    expect(ownBoxOffenders(sources, ['components/pages/'])).toEqual([
      'components/pages/B.tsx → h-9',
      'components/pages/B.tsx → p-3',
    ]);
  });

  it('ignores a comment that quotes the class it replaced', () => {
    const source = [
      "// was 'rounded-(--radius-card) p-3'",
      '/* rounded-(--radius-card) h-9 */',
      "const ok = 'rounded-(--radius-card) p-(--spacing-card-padding-12)';",
    ].join('\n');
    expect(ownBoxOffenders(new Map([['components/Z.tsx', source]]), ['components/'])).toEqual([]);
  });
});
