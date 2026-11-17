# Style — Neo-Brutalism (`data-style="neo-brutalism"`)

> The raw, punchy, utilitarian alternate. Shipped as the
> `[data-style='neo-brutalism']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2) plus a style-scoped
> component-variant rule for the heavy border, registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Raw, punchy, utilitarian — 0px corners, thick borders, hard-offset
shadows.
**Inspiration:** Neo-brutalist web design — the Gumroad / Figma-community
brutalism: blocky, unpolished, loud, structure worn on the outside.
**Wrong moods:** soft, glassy, diffuse, decorative, calm, refined.

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Neo-Brutalism inherits whatever palette is active and
changes no hue. The block overrides ONLY shape/feel tokens. See
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**How it differs from the Swiss / Minimal-Flat style:** both are flat-ish and
angular, but Swiss is **refined and calm** — hairline borders, _no_ shadow,
modest 2px corners — whereas Neo-Brutalism is **harsh and loud**: hard 0px
corners, heavy 2px borders, and solid hard-offset drop shadows. Swiss is the
quiet end of the angular family; Neo-Brutalism is the shouting end.

## Feel-bearing dimensions

| Dimension             | Neo-Brutalism                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Shape / silhouette    | Zero radius — hard 0px corners on every surface. Blocky, uncompromising rectangles.        |
| Border / stroke       | Heavy solid 2px outlines do the structural work — borders are LOUD, not hairline.          |
| Elevation philosophy  | Hard-offset drop shadows with ZERO blur (a solid block of shadow), never a soft lift.      |
| Surface / background  | Opaque, flat, untinted panels framed by the thick border + hard shadow; no glass/wash.     |
| Density rhythm        | Tight, utilitarian controls (16×10 buttons, 36px control height) + compact 20px card pad.  |
| Motion                | Snappy, mechanical — near-instant 60ms transitions and NO press-scale; reacts, no ease.    |
| Typography            | Raw monospace headlines — the editorial serif is re-pointed at JetBrains Mono.             |
| Component silhouettes | Square buttons/inputs/cards/modals, rectangular (non-pill) chips, thick-bordered surfaces. |

## Token overrides (`[data-style='neo-brutalism']`)

Only shape/feel tokens — no colour token appears in the block (the disjoint-axis
acceptance criterion; enforced by `tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** the generic scale collapses to hard right angles —
  `--radius-xs / -sm / -md / -lg / -xl: 0` — and every semantic surface follows:
  `--radius-btn / -input / -card / -modal / -control / -kbd: 0`, and crucially
  **`--radius-badge: 0`** so status chips read as hard rectangles, not pills.
  `--radius-pill` is deliberately **left untouched** so genuinely-circular
  affordances (avatars, status dots, the spinner) stay round.
- **Elevation:** `--shadow-{subtle,card,elevated,modal,hero-mockup}` become
  **hard-offset, zero-blur** shadows — `2px 2px 0 0` through `12px 12px 0 0`,
  all `rgba(15, 15, 15, 1)`. A solid offset block, not a diffuse lift; the
  literal near-ink colour matches how the base shadows already hard-code their
  `rgba` (it is NOT a `--color-*` token, so the colour axis stays disjoint).
- **Typography:** `--font-serif` is re-pointed at the **mono** stack, so every
  `font-serif` headline (page `<h1>`/`<h2>`, card titles, modal titles) renders
  in JetBrains Mono — raw and utilitarian — instead of Source Serif 4, over the
  unchanged Inter grotesk body. This is a type token, so the colour axis is
  untouched.
- **Density:** tight, utilitarian controls — `--spacing-btn-x/y: 16/10`,
  `--spacing-input-x/y: 14/11`, `--spacing-control-x/y: 10/6`,
  `--height-control: 36px`, `--height-input: 44px` — against a **compact**
  `--spacing-card-padding: 20px`. No wasted space.
- **Motion:** `--transition-duration: 60ms` (`--transition-fast: 40ms`,
  `--transition-slow: 100ms`) and **`--hover-scale: 1` / `--active-scale: 1`** —
  no transform on press, for a snappy, mechanical feel.

## The heavy border — a component-variant override

The defining neo-brutalist axis — **thick borders** — has no Tier-0 token:
every primitive draws a 1px Tailwind `.border` coloured by `--el-border*`, so a
token swap alone cannot reach border WIDTH. Neo-Brutalism therefore ships the
one **component-variant override** this style needs (the deliverable's
"component-variant overrides" axis), a single style-scoped rule in
`app/globals.css`:

```css
[data-style='neo-brutalism'] .border {
  border-width: 2px;
}
```

It thickens the full box border on every framed surface (Button outline, Card,
Input, Modal, Pill, Popover, …) to a loud 2px — **without** touching a colour
token or any component file, and **only** when this style is active (no other
style is affected). It is intentionally NOT a `[data-style='…'] { … }` token
block, so the disjoint-axis guard test (which inspects token blocks) leaves it
alone — and it sets no colour, so the two axes stay disjoint regardless.

## Why this is more than a token swap

The four feel-bearing axes a pure radius swap would miss are all moved here:

- **Elevation** flips from "modest low-spread diffuse shadows" to **hard-offset
  zero-blur blocks** — the single most recognisable neo-brutalist signal, and
  the reason every surface reads as a stamped, framed card.
- **Stroke** becomes load-bearing and LOUD: the 2px border (the component-variant
  override) is the structure, not a quiet hairline.
- **Typography** changes _family_, not just size — mono headlines re-shape the
  whole page's voice toward the raw, utilitarian register.
- **Motion** removes the press-scale and slows nothing down, so the UI feels
  mechanical and immediate rather than springy.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Button` → `--radius-btn` + `--active-scale`, `Card` → `--radius-card` +
`--shadow-card`, `Pill` → `--radius-badge`, `Input` → `--radius-input` +
`--height-input`, `Modal` → `--radius-modal` + `--shadow-modal` + a `font-serif`
title) and the full `.border` utility, this token block plus the one
component-variant rule re-shapes the entire UI — no per-component edits are
needed (the same token-driven approach as `soft-playful` and `swiss-minimal-flat`).

## Accessibility

The style changes no colour token, so the active palette's AA contrast is
preserved by construction (text/background pairs are untouched). The shape-side
AA considerations are satisfied too: the hard-offset shadow colour is decorative
(it frames, it carries no text), and structure stays unmistakably legible because
the heavy 2px border on every framed surface does the dividing work loudly.

## Background: the Wave

The Wave (`@motir/design-system`, `wave` in the background registry) redraws per
style. Every style keeps the mark — the deep dip first and the crest later, the
lines gathering around the main content, the sliding band of the palette's wave
hues and the decision squares riding the lines — and changes only shape, stroke,
glow and motion. Under this style:

Shape: 11 polylines with hard miter corners at a coarse knot spacing, three bands filled solid in the palette hues. Stroke: 3px ink with a 4px hard-offset shadow, every fourth line in the accent; 18px squares with hard offset blocks. Glow: none. Motion: steps twice a second.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/wave.ts` (MOTIR-11606), built
to the approved design in `design/backgrounds/` (MOTIR-11602).

## Background: Topography

Topography (`topography` in the background registry) is contour lines over a
slowly moving height map, redrawn per style. Every style keeps one seeded height
field drifting slowly, contoured by marching squares, and the feathered clear area
behind the main content. Under this style:

Shape: 5 un-interpolated levels on a coarse 22px grid, with solid hue blocks in the peaks, valleys and the mid band. Stroke: 3px square-capped ink on a 4px hard offset. Glow: none. Motion: steps once a second.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/topography.ts` (MOTIR-11617),
built to the approved design in `design/backgrounds/` (MOTIR-11602).
