# Style — Swiss / Minimal-Flat (`data-style="swiss-minimal-flat"`)

> The structural, international-typographic alternate. Shipped as the
> `[data-style='swiss-minimal-flat']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** International-typographic, structural, calm — flat, sharp,
gridded.
**Inspiration:** The Swiss International Typographic Style — Müller-Brockmann
grids, Helvetica/neo-grotesque type, flat surfaces, structure carried by the
rule and the grid rather than ornament.
**Wrong moods:** soft, bubbly, glassy, decorative, playful.

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Swiss / Minimal-Flat inherits whatever palette is active
and changes no hue. The block overrides ONLY shape/feel tokens. See
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**How it differs from the planned Neo-Brutalism style:** both are flat-ish and
angular, but Swiss is **refined and calm** — hairline borders, _no_ shadow,
modest 2px corners — whereas Neo-Brutalism is **harsh** (thick borders, hard
offset shadows, 0px corners). Swiss is the quiet, gridded end of the angular
family.

## Feel-bearing dimensions

| Dimension             | Swiss / Minimal-Flat                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| Shape / silhouette    | Sharp near-square corners (2px) on every surface — hard right angles, structural.      |
| Border / stroke       | Hairline borders do ALL the structural work; with elevation gone, the 1px rule is it.  |
| Elevation philosophy  | Flat — every shadow removed (none). Depth comes from borders + whitespace, not lift.   |
| Surface / background  | Opaque, untinted panels delineated by hairline rules; no floating, glass, or wash.     |
| Density rhythm        | Tight gridded controls (16×9 buttons, 34px control height) + generous 28px card pad.   |
| Motion                | Minimal — fast 100ms transitions and NO press-scale (calm, mechanical, never springy). |
| Typography            | Restrained neo-grotesque sans throughout — headlines drop the serif for Inter.         |
| Component silhouettes | Square buttons/inputs/cards/modals, rectangular (non-pill) status chips, flat rules.   |

## Token overrides (`[data-style='swiss-minimal-flat']`)

Only shape/feel tokens — no colour token appears in the block (the disjoint-axis
acceptance criterion; enforced by `tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** the generic scale tightens to hard right angles —
  `--radius-xs: 1px`, `--radius-sm/md/lg: 2px`, `--radius-xl: 3px` — and every
  semantic surface follows: `--radius-btn / -input / -card / -modal / -control /
-kbd: 2px`, and crucially **`--radius-badge: 2px`** so status chips read as
  rectangles, not pills. `--radius-pill` is deliberately **left untouched** so
  genuinely-circular affordances (avatars, status dots, the spinner) stay round.
- **Elevation:** `--shadow-{subtle,card,elevated,modal,hero-mockup}: none` —
  truly flat. Cards, modals, popovers, and hover states lose their lift; the
  hairline `--el-border` + the scrim/whitespace separate surfaces instead.
- **Typography:** `--font-serif` is re-pointed at the **sans** stack, so every
  `font-serif` headline (page `<h1>`/`<h2>`, card titles, modal titles) renders
  in Inter — tight, strong, neo-grotesque — instead of Source Serif 4. This is a
  type token, so the colour axis is untouched.
- **Density:** crisp, gridded controls — `--spacing-btn-x/y: 16/9`,
  `--spacing-input-x/y: 14/11`, `--spacing-control-x/y: 10/6`,
  `--height-control: 34px`, `--height-input: 42px` — against a **generous**
  `--spacing-card-padding: 28px` for breathing room inside panels (the Swiss
  "tight grid, generous whitespace" tension).
- **Motion:** `--transition-duration: 100ms` (`--transition-fast: 80ms`,
  `--transition-slow: 160ms`) and **`--hover-scale: 1` / `--active-scale: 1`** —
  no transform on press, for a calm, mechanical feel.

## Why this is more than a token swap

The four feel-bearing axes a pure radius swap would miss are all moved here:

- **Elevation** flips from "modest low-spread shadows" to genuinely _flat_ —
  the single biggest visible change, and the reason the hairline border becomes
  load-bearing.
- **Surface** reads as structural panels (flat + sharp + ruled), not soft cards.
- **Typography** changes _family_, not just size — sans headlines re-shape the
  whole page's voice toward the international-typographic register.
- **Motion** removes the press-scale entirely, so the UI feels deliberate and
  calm rather than springy.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Button` → `--radius-btn` + `--active-scale`, `Card` → `--radius-card` +
`--shadow-card`, `Pill` → `--radius-badge`, `Input` → `--radius-input` +
`--height-input`, `Modal` → `--radius-modal` + `--shadow-modal` + a `font-serif`
title), this token block alone re-shapes the entire UI — no per-component CSS
override is needed (the same approach as `soft-playful`).

## Accessibility

The style changes no colour token, so the active palette's AA contrast is
preserved by construction (text/background pairs are untouched). The only
shape-side AA consideration — that structure stays legible once shadows are
removed — is satisfied by the hairline `--el-border` doing the dividing work on
every surface.

## Background: the Wave

The Wave (`@motir/design-system`, `wave` in the background registry) redraws per
style. Every style keeps the mark — the deep dip first and the crest later, the
lines gathering around the main content, the sliding band of the palette's wave
hues and the decision squares riding the lines — and changes only shape, stroke,
glow and motion. Under this style:

Shape: 12 evenly spaced lines, no bunching. Stroke: 1px ink rules, one line in the accent at 1.5px with three 8px accent squares on it. Glow: none. Motion: slow drift.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/wave.ts` (MOTIR-11606), built
to the approved design in `design/backgrounds/` (MOTIR-11602).
