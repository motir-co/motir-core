# Style — Cybercore / Y2K (`data-style="cybercore-y2k"`)

> The neon-on-dark retro-tech alternate. Shipped as the
> `[data-style='cybercore-y2k']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Neon-on-dark retro-tech — glowing HUD panels, a tech grid, mono
headlines.
**Inspiration:** Y2K / cyberpunk HUDs — neon-on-dark terminals, Tron grids,
glowing edges, monospace displays.
**Wrong moods:** soft, pastel, editorial, calm, paper-like.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis** — Cybercore / Y2K inherits whatever palette is active and
changes no hue. The `[data-style]` block overrides ONLY shape/feel tokens; see
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**Where the "neon" comes from.** A style cannot set a colour, so the neon hue
is supplied by the active palette and the **dark theme** — Cybercore is
**dark-first** and designed to be worn with a dark, saturated palette. What the
style itself contributes is the part that makes neon _read_: every surface
**glows** (an outward `currentColor` halo instead of a drop shadow) and the
canvas wears a faint **tech grid**. Both are built from `currentColor`, so they
amplify whatever hue the palette provides into a halo/grid rather than pinning
one — the style and palette axes stay disjoint, and the palette's AA contrast is
preserved by construction.

**How it differs from Swiss / Minimal-Flat:** both are angular, but Swiss is
**flat and calm** (no shadow, hairline rules, sans, no press feedback), whereas
Cybercore is **lit and electric** — glow rings replace shadows, a grid textures
the canvas, headlines go mono, and the press has a snappy scale. Swiss is the
quiet end of the angular family; Cybercore is the charged end.

## Feel-bearing dimensions

| Dimension             | Cybercore / Y2K                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Hard terminal-frame corners (sharp 2–4px) — chiseled HUD panels, not soft cards.              |
| Border / stroke       | A lit edge — a 1px glow-ring (currentColor halo) on every surface, not a heavier border.      |
| Elevation philosophy  | Neon GLOW instead of drop-shadow — surfaces emit an outward halo, lit rather than lifted.     |
| Surface / background  | A faint tech grid (scanline/grid texture) washes the canvas behind opaque HUD panels.         |
| Density rhythm        | Tight HUD rhythm — compact controls (18×9 buttons, 34px control height) + snug 20px card pad. |
| Motion                | Snappy and electric — very fast 90ms transitions with a crisp press-scale.                    |
| Typography            | Mono/display headlines — the serif headline face swaps to JetBrains Mono; body stays sans.    |
| Component silhouettes | Sharp glow-ringed panels, mono headings, rectangular chips; the lit edge replaces shadows.    |

## Token overrides (`[data-style='cybercore-y2k']`)

Only shape/feel tokens — no colour token appears in the block (the disjoint-axis
acceptance criterion; enforced by `tests/theme/styleRegistry.test.ts`). The glow
and grid use `currentColor`, never a `--color-*` / `--el-*` token:

- **Radius (silhouette):** hard HUD frames — the generic scale tightens
  (`--radius-xs: 1px`, `--radius-sm: 2px`, `--radius-md: 3px`,
  `--radius-lg/xl: 4px`) and the semantic surfaces follow
  (`--radius-btn / -input: 3px`, `--radius-card / -modal: 4px`,
  `--radius-control / -kbd: 2px`), with **`--radius-badge: 2px`** so status
  chips read as rectangular HUD chips, not pills. `--radius-pill` is left
  **untouched** so genuinely-circular affordances (avatars, status dots, the
  spinner) stay round.
- **Elevation (the signature):** every shadow token becomes a **neon glow** — a
  1px `currentColor` ring (the lit edge / "stroke") plus an outward blurred
  halo, scaling up from `--shadow-subtle` (ring only) through `--shadow-card`,
  `--shadow-elevated`, `--shadow-modal`, to `--shadow-hero-mockup` (the
  strongest halo). Surfaces read as _lit_, not lifted. Because the colour is
  `currentColor`, the halo takes the palette's hue and the dark theme makes it
  glow.
- **Typography:** `--font-serif` is re-pointed at the **mono** stack, so every
  `font-serif` headline (page `<h1>`/`<h2>`, card titles, modal titles) renders
  in JetBrains Mono — a terminal/retro-tech read — while body copy stays in
  Inter. This is a type token; the colour axis is untouched.
- **Density:** tight, technical controls — `--spacing-btn-x/y: 18/9`,
  `--spacing-input-x/y: 14/11`, `--spacing-control-x/y: 10/6`,
  `--height-control: 34px`, `--height-input: 42px` — over a snug
  `--spacing-card-padding: 20px` (denser than the base 24px) for a HUD feel.
- **Motion:** `--transition-duration: 90ms` (`--transition-fast: 60ms`,
  `--transition-slow: 140ms`) with `--active-scale: 0.97` — fast and snappy,
  with a crisp press feedback (electric, not calm).

### Surface texture (the grid)

The "surface treatment" axis is carried by a small **component-variant
override** — `[data-style='cybercore-y2k'] body` — rather than a token (a token
can't paint a background-image). Two crossing `currentColor` linear gradients at
**5% alpha** draw a 32px tech grid on the canvas, sitting BEHIND every surface.
Where two lines cross the page takes both tints, so the alpha is held by the
painted canvas AA gate (`tests/theme/stylePaletteModeContrast.test.ts`): at 6%
a crossing took `--el-accent-on-surface` to 4.46:1 in sienna light; at 5% the
worst crossing is 4.63:1 (MOTIR-10746). On the dark theme this reads as a
Tron grid over the near-black canvas. This is the one place a richer style
reaches past the token block (the schema's "+ component-variant overrides"),
and it still pins no hue — `currentColor` keeps it palette-driven.

## Why this is more than a token swap

The feel-bearing axes a pure radius swap would miss are all moved here:

- **Elevation** flips from "modest drop shadows" to an **outward glow** — the
  single biggest visible change and the source of the neon read.
- **Surface** gains a grid texture (via the body override), so the canvas itself
  carries the aesthetic, not just the cards on it.
- **Typography** changes _family_ — mono headlines re-voice the whole page
  toward the terminal/retro-tech register.
- **Motion** adds back a snappy press-scale and the fastest transitions in the
  library, for an electric, responsive feel.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Button` → `--radius-btn` + `--active-scale`, `Card` → `--radius-card` +
`--shadow-card`, `Pill` → `--radius-badge`, `Input` → `--radius-input` +
`--height-input`, `Modal` → `--radius-modal` + `--shadow-modal` + a `font-serif`
title), the token block alone re-shapes the entire UI; the only extra rule is
the body grid (the same component-variant approach the schema sanctions for
richer styles).

## Accessibility

The style changes no colour token, so the active palette's AA contrast is
preserved by construction (text/background pairs are untouched). The two
additions that _do_ paint pixels — the glow halos and the grid — are both
`currentColor` at low alpha and sit on surface edges / behind content, never
under text, so no foreground/background contrast is reduced. Verified on the
dark theme (the dark-first target) via the `/tokens` specimen + the
design-mockup render checklist.
