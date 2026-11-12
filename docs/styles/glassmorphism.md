# Style — Glassmorphism (`data-style="glassmorphism"`)

> The translucent, frosted-glass alternate. Shipped as the
> `[data-style='glassmorphism']` token block **plus** a palette-derived
> **material layer** in [`app/globals.css`](../../app/globals.css) (Tier 2),
> registered in [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Translucent frosted glass floating over a soft, vibrant gradient.
**Inspiration:** Apple's visionOS / macOS Big Sur "frosted glass" material —
backdrop-blur panels over a sense of depth.
**Wrong moods:** flat, opaque, sharp, structural, mechanical, brutalist.

This is the FIRST **surface-material** style. Swiss and Soft / Playful only
re-shape the silhouette (radius / shadow / spacing); glassmorphism re-shapes the
**surface itself** — the material a panel is made of. That needs more than the
shape-only token block, so it ships in two parts (see the two-axis contract in
[`DESIGN.md`](../DESIGN.md)):

1. **The token block** — shape/feel tokens only (rounded radii, soft layered
   shadows, gentle motion, roomy density) plus palette-**agnostic** material
   _scalars_ (blur radii, surface/border alphas, wash strength). No hue lives
   here, so it stays disjoint from the palette axis.
2. **The palette-derived material layer** — style-scoped component rules
   (`[data-style='glassmorphism'] [data-surface='…'] { … }`) that turn those
   scalars into frosted translucency + a gradient canvas via
   `color-mix()`/alpha **over the active palette tokens**, introducing **no new
   hue**. Surfaces opt in through the `data-surface` hook the shared primitives
   emit (`Card` / `Modal` / `Popover` / `Sidebar` / `Input` / `overlay`).

**Modals are the showcase surface.** A modal floats over real page content, so it
is where glass reads best. The modal/command-palette **backdrop**
(`data-surface="overlay"`) is therefore NOT a dark scrim under glass: it's a
light, palette-derived veil + a page `backdrop-filter: blur`, so the whole page
behind frosts and the (also-frosted) modal panel refracts it. A dark scrim would
make the glass blur darkness — the "flat" failure. The command-palette panel also
carries `data-surface="modal"` so it frosts too.

Because the material is palette-_derived_, the two axes stay orthogonal: pick a
different palette and the glass re-tints automatically; pick a different style
and the palette's hues are untouched. **Colour is still the palette axis's
job** — glassmorphism only borrows the active palette's hues to tint its
material.

## Feel-bearing dimensions

| Dimension             | Glassmorphism                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Soft, rounded glass tiles — 12px buttons/inputs, 18px cards, 22px modals. Friendly, never sharp.                     |
| Border / stroke       | Light 1px hairlines at reduced opacity — a glass edge catching light, not a structural rule.                         |
| Elevation philosophy  | Layered, diffuse, low-opacity shadows — panels float as hovering frosted sheets above the canvas.                    |
| Surface / background  | The identity axis: translucent frosted panels (backdrop-blur) over a soft palette-derived gradient canvas.           |
| Density rhythm        | Comfortable, a touch roomy — 20×11 buttons, 26px card padding, 38px controls; glass tiles want air.                  |
| Motion                | Gentle, smooth — 220ms ease and a light press-scale; glass slides into place, never snaps.                           |
| Typography            | Inherits the base editorial pairing (Source Serif headlines + Inter body); the personality is in the material.       |
| Component silhouettes | Rounded frosted cards / popovers / modals / sidebar / inputs (the `data-surface` material layer); pill status chips. |

## Token overrides (`[data-style='glassmorphism']`)

Shape/feel + palette-agnostic material scalars only — no colour token appears in
the block (the disjoint-axis acceptance criterion; enforced by
`tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** generous, soft corners — `--radius-btn / -input: 12px`,
  `--radius-card: 18px`, `--radius-modal: 22px`, `--radius-control: 10px`, with
  the generic scale rounded up to match. `--radius-badge` stays `9999px` (pill
  chips suit the soft register).
- **Elevation:** bigger, softer, lower-opacity shadows than the base
  (`--shadow-card: 0 8px 32px -8px …`, `--shadow-modal: 0 28px 70px -16px …`) so
  panels read as floating frosted sheets. The rgba literals are neutral shadow
  ink, not a palette hue.
- **Density:** roomy — `--spacing-btn-x/y: 20/11`, `--spacing-card-padding:
26px`, `--spacing-control-x/y: 12/7`, `--height-control: 38px`.
- **Motion:** `--transition-duration: 220ms` (`--transition-slow: 320ms`) and a
  light `--active-scale: 0.98` — smooth, never springy or snappy.
- **Material scalars (palette-agnostic):** `--glass-blur: 18px`,
  `--glass-blur-strong: 30px` (modals), the surface/chrome/input/border opacity
  fractions — kept **low so the canvas shows THROUGH** the glass
  (`--glass-surface-alpha: 50%`, `--glass-modal-alpha: 70%`,
  `--glass-chrome-alpha: 52%`, `--glass-input-alpha: 44%`,
  `--glass-border-alpha: 72%` the lit rim), `--glass-wash: 12%` (the gradient-canvas
  tint, capped by contrast — see Accessibility), `--glass-saturate: 180%`
  (punchier refraction: the blur amplifies the wash's colour behind each panel,
  which is where the vibrancy comes from), and the white specular `--glass-sheen` / `--glass-rim`
  (light is palette-agnostic). These carry no hue, so they live here; the
  material layer consumes them.

**The three things that make it read as glass (not a flat blurred box):** a
**coloured canvas** to refract (`--glass-wash`, saturated by the blur), **genuine translucency**
(low surface alpha, so the colour shows through), and a **lit edge** — the
`linear-gradient` sheen raking across the panel + the inset `--glass-rim`
highlight + a soft drop shadow so the sheet floats.

## The material layer (palette-derived)

The style-scoped rules below the token block are where the glass actually
happens. Every colour is derived from the active palette — never a raw hue:

- **The canvas** (`[data-style='glassmorphism'] body`): the palette's page bg
  plus three soft corner washes built from `color-mix(in srgb, var(--el-…)
var(--glass-wash), transparent)` over the `--el-accent` / `--el-highlight` /
  `--el-link` accent roles. Those are `--el-*` (the layer the `data-palette` axis
  overrides), **not** Tier-0 `--color-*`, so the washes re-tint with the active
  palette — orthogonality, not a hardcoded brand gradient. This gradient is what
  the frosted panels blur — without it, the blur would be invisible.
- **Frosted cards & popovers** (`[data-surface='card' | 'popover']`):
  `background-color: color-mix(in srgb, var(--el-page-bg) var(--glass-surface-alpha),
transparent)` + `backdrop-filter: blur(var(--glass-blur)) saturate(150%)` + a
  light `color-mix(… var(--el-border) …)` border.
- **Modals** (`[data-surface='modal']`): more opaque (`--glass-modal-alpha`) and
  a stronger blur (`--glass-blur-strong`) so body text stays AA-legible and the
  dialog separates cleanly from the page behind it. The frosting — blur, fill,
  sheen and inset rim — is painted on a `[data-surface='modal']::before` layer
  (`z-index: -1` inside the panel, which `isolation: isolate` makes a stacking
  context); the panel itself keeps only its border and drop shadow. A
  `backdrop-filter` on the panel would make it the containing block of every
  `position: fixed` descendant, which cut a `Combobox` menu inside a dialog to
  the panel's height (MOTIR-11105). `tests/theme/modalFixedContainingBlock.test.ts`
  keeps every style's panel rule free of those properties.
- **Sidebar** (`[data-surface='sidebar']`): frosted chrome derived from
  `var(--el-sidebar-bg)`.
- **Inputs** (`[data-surface='input']`): a translucent fill from
  `var(--el-page-bg)` so form controls read as glass too.

## Why this is more than a token swap

Glassmorphism's identity lives in the axes a radius/shadow swap can't reach:

- **Surface** is the whole point — opaque panels become _translucent frosted
  material_. This is the dimension the prior styles deliberately left alone, and
  the reason the surface-material layer (and the `data-surface` hook) had to be
  added to the style contract.
- **Elevation** shifts from "modest low-spread shadows" to large, diffuse,
  floating sheets — depth is real, not implied.
- **Stroke** becomes a light catch of edge-light (reduced-opacity hairline)
  rather than a structural rule.
- **Motion** softens to a gentle slide.

## Accessibility

Text sits on _translucent_ surfaces over a gradient, so contrast is verified
**over the blur/gradient, not just on a solid fill** (the explicit acceptance
criterion). Four things keep it AA:

1. **Panels stay substantially opaque** (cards 64%, modals 82%, derived from the
   near-white / near-black page bg), so the effective surface behind text stays
   close to the base colour the palette already tuned for AA.
2. **The washes are subtle** (`--glass-wash: 12%`), so the gradient never pulls
   a surface far enough toward a hue to threaten contrast. 12% is a ceiling, not
   a taste: text sits straight on the canvas (page headers, empty states), and
   rendered across all ten palettes in both modes the darkest canvas pixel (the
   bottom-right corner, where two washes overlap) holds the four AA inks at
   ≥ 4.60:1. The 42% this once shipped at measured 2.10:1 there (MOTIR-10707).
   `tests/theme/stylePaletteModeContrast.test.ts` gates it.
3. **The AI hero pill is 94% accent**, the floor at which its label clears
   4.5:1 over the page in every palette (evergreen light binds at 4.78:1).
4. **Body-text-dense surfaces use the more opaque modal recipe.** Text continues
   to use the palette's `--el-text*` tokens, whose AA pairings are unchanged.

Verified in light and dark themes against the `/tokens` specimen with the
`--el-*` AA + design-mockup render checklist.
