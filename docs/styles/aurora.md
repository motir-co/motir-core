# Style — Aurora (`data-style="aurora"`)

> The soft, animated-light alternate. Shipped as the `[data-style='aurora']`
> token block **plus** a palette-derived **material layer** in
> [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Soft, drifting aurora light behind fluid, gently-glowing surfaces.
**Inspiration:** The northern lights — slow ribbons of colour over a night sky —
and the soft animated-gradient "aurora" hero look (Stripe / Vercel ambient
gradients).
**Wrong moods:** flat, sharp, structural, mechanical, brutalist, high-contrast
neon.

This is the **third** surface-material style, after Glassmorphism (7.3.35) and
Cybercore / Y2K (7.3.36). Like them it re-shapes the **surface itself**, not just
the silhouette — so it ships with the two-part surface-material contract glass
established (see the two-axis contract in [`DESIGN.md`](../DESIGN.md)). But its
identity is its own:

- **Glassmorphism** makes surfaces _translucent_ (frosted backdrop-blur over a
  static gradient).
- **Cybercore** lits surfaces with a _sharp neon ring_ over a dark tech grid.
- **Aurora** keeps surfaces **opaque and fluid** and moves the identity onto
  **motion + glow**: a slowly **drifting** aurora gradient canvas, and a
  **gentle, palette-derived colour glow halo** on each panel so surfaces feel
  _lit from within_ rather than lifted by a hard shadow.

It ships in two parts:

1. **The token block** — shape/feel tokens only (fluid radii, soft _neutral_
   shadows, smooth slow motion, roomy density) plus palette-**agnostic** material
   _scalars_ (wash strengths, surface sheen, glow strengths, the drift duration).
   No hue lives here, so it stays disjoint from the palette axis.
2. **The palette-derived material layer** — style-scoped rules
   (`[data-style='aurora'] body` and `[data-style='aurora'] [data-surface='…']`)
   that paint the animated aurora canvas + the per-surface colour glow via
   `color-mix()` **over the active palette tokens** (`--el-*`), introducing **no
   new hue**.

Because the material is palette-_derived_, the two axes stay orthogonal: pick a
different palette and the aurora ribbons + glow re-tint automatically; pick a
different style and the palette's hues are untouched. **Colour is still the
palette axis's job** — Aurora only borrows the active palette's hues for its
moving light.

## Feel-bearing dimensions

| Dimension             | Aurora                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Fluid, soft corners — 14px buttons/inputs, 20px cards, 26px modals. Organic and rounded, a touch softer than glass.   |
| Border / stroke       | Quiet 1px hairlines; structure is implied by the gentle glow + elevation, never drawn by a heavy rule.                |
| Elevation philosophy  | A soft neutral lift PLUS a gentle palette-derived colour glow halo — surfaces feel lit from within, never hard-edged. |
| Surface / background  | The identity axis: opaque fluid surfaces floating over a slowly-drifting, animated aurora gradient canvas.            |
| Density rhythm        | Comfortable and roomy — 20×11 buttons, 26px card padding, 38px controls; the light wants space to breathe.            |
| Motion                | Smooth and slow — 260ms eased transitions, a faint press-scale, and a 28s ambient drift of the aurora canvas.         |
| Typography            | Inherits the base editorial pairing (Source Serif headlines + Inter body); the personality is in the moving light.    |
| Component silhouettes | Fluid, gently-glowing cards / popovers / modals / sidebar (the `data-surface` material layer); pill status chips.     |

## Token overrides (`[data-style='aurora']`)

Shape/feel + palette-agnostic material scalars only — no colour token appears in
the block (the disjoint-axis acceptance criterion; enforced by
`tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** fluid, soft corners — `--radius-btn / -input: 14px`,
  `--radius-card: 20px`, `--radius-modal: 26px`, `--radius-control: 12px`, with
  the generic scale rounded up to match. `--radius-badge` stays `9999px` (pill
  chips suit the soft register).
- **Elevation:** soft, diffuse **neutral** shadows (`--shadow-card: 0 8px 30px
-12px …`, `--shadow-modal: 0 26px 64px -18px …`). The rgba literals are neutral
  shadow ink (a cool near-black), not a palette hue — the _coloured_ glow halo is
  palette-derived and lives in the material layer (a hue may not appear here).
- **Density:** roomy — `--spacing-btn-x/y: 20/11`, `--spacing-card-padding: 26px`,
  `--spacing-control-x/y: 12/7`, `--height-control: 38px`.
- **Motion:** `--transition-duration: 260ms` (`--transition-slow: 380ms`) and a
  faint `--active-scale: 0.985` — smooth and slow, never snappy.
- **Material scalars (palette-agnostic):** `--aurora-wash: 10%` /
  `--aurora-wash-soft: 7%` (ribbon tint strengths), `--aurora-sheen: 7%`
  (lit-from-above surface sheen), `--aurora-glow: 22%` /
  `--aurora-glow-strong: 30%` (colour-glow halo strengths), and
  `--aurora-drift-duration: 28s` (one slow breath of the drifting canvas). These
  carry no hue, so they live here; the material layer consumes them.

## The material layer (palette-derived)

The style-scoped rules below the token block are where the aurora actually
happens. Every colour is derived from the active palette — never a raw hue:

- **The animated canvas** (`[data-style='aurora'] body`): the palette's page bg
  plus **four** soft aurora ribbons built from `color-mix(in srgb, var(--el-…)
var(--aurora-wash | --aurora-wash-soft), transparent)` over the `--el-accent` /
  `--el-highlight` / `--el-link` / `--el-info` roles. Those are `--el-*` (the
  layer the `data-palette` axis overrides), **not** Tier-0 `--color-*`, so the
  ribbons re-tint with the active palette. `background-size: 180%` gives the
  gradient room to move, and the `aurora-drift` keyframes ease the whole field
  back and forth over `--aurora-drift-duration` — the slow northern-lights drift.
- **Reduced motion:** a `@media (prefers-reduced-motion: reduce)` rule sets
  `animation: none`, so the canvas settles to a still gradient (the identity
  holds; only the drift stops).
- **Fluid cards & popovers** (`[data-surface='card' | 'popover']`): an **opaque**
  `var(--el-surface)` base + a faint top sheen (`linear-gradient` from
  `--el-highlight` at `--aurora-sheen`) + a `box-shadow` that layers the neutral
  `--shadow-card` lift **with** a gentle two-tone colour glow halo
  (`color-mix(… var(--el-accent) …)` + `color-mix(… var(--el-link) …)`).
- **Modals** (`[data-surface='modal']`): opaque `var(--el-surface)` with a deeper
  `--aurora-glow-strong` halo so the dialog separates cleanly from the drifting
  canvas behind it.
- **Sidebar** (`[data-surface='sidebar']`): opaque `var(--el-sidebar-bg)` chrome
  carrying the faint aurora sheen so the rail reads as part of the lit surface
  family.
- **The preview swatch** (`.style-vignette[data-style='aurora'] > .sv-canvas`):
  the same four ribbons painted **statically** (the gallery shows many vignettes
  at once, so the swatch holds a still frame; the live drift is reserved for the
  full `body`).

## Why this is more than a token swap

Aurora's identity lives in the axes a radius/shadow swap can't reach:

- **Surface + motion** are the whole point — an opaque panel gains a _drifting
  field of light_ behind it and a _colour glow_ around it. This is the
  surface-material dimension the shape-only token block cannot express, which is
  why the material layer (and the `data-surface` hook) exists.
- **Elevation** shifts from "a modest shadow" to "lit from within" — a soft
  neutral lift fused with a palette-hued halo.
- **Motion** becomes a slow ambient drift, not just a transition timing.

## Accessibility

Unlike glassmorphism, Aurora's surfaces are **opaque**, so text sits on the
palette's own AA-tuned `--el-surface` — contrast is preserved by construction,
not balanced against a translucent blur. Four things keep it AA:

1. **Surfaces stay opaque.** Cards / modals / sidebar set
   `background-color: var(--el-surface | --el-sidebar-bg)`; the sheen rides on
   `background-image` over that opaque base, so the effective surface behind text
   stays the colour the palette already tuned for AA.
2. **The sheen is faint** (`--aurora-sheen: 7%`), far too subtle to pull a
   surface toward a hue enough to threaten contrast.
3. **The glow is a `box-shadow` halo** — it lives _outside_ the panel and never
   sits behind text.
4. **The canvas washes are subtle** (`--aurora-wash: 10%`, the cooler band 7%)
   and only the page-level canvas shows them; body copy lives on opaque surfaces.
   The strength is set by text that sits straight on the canvas, not by body
   copy: where two ribbons overlap they pull the page toward the accent hue, and
   `--el-accent-on-surface` is that same hue. At the original 22% / 15% it fell
   to 3.63:1 rendered in sienna light (3.98:1 on the token gate's single-stop
   read, motir light). 10% / 7% is the strongest pair whose rendered worst case
   clears 4.5:1 for all four hard inks in every palette, both modes, across the
   drift and at phone, laptop and desktop sizes (worst 4.52:1, sienna light) —
   MOTIR-10709. Raise either value only with a fresh rendered sweep.
   Text continues to use the palette's `--el-text*` tokens, whose AA pairings are
   unchanged.

The drift animation is **stilled** under `prefers-reduced-motion: reduce`.
Verified in light and dark themes against the `/tokens` specimen with the
`--el-*` AA + design-mockup render checklist.
