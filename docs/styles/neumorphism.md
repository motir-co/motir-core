# Style — Neumorphism (`data-style="neumorphism"`)

> The soft-extruded "soft UI" alternate. Shipped as the
> `[data-style='neumorphism']` token block **plus** a palette-derived **material
> layer** in [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Soft extruded surfaces that swell out of a single monochrome field.
**Inspiration:** Neumorphism / soft-UI — the Dribbble-era "soft shadow"
interfaces where panels are pressed _out of_ (or _into_) one continuous surface
by a paired light + dark shadow.
**Wrong moods:** flat, sharp, structural, brutalist, high-contrast, glassy,
neon.

This is a **surface-material** style (the fourth after Glassmorphism, Cybercore /
Y2K, and Aurora). Like them it re-shapes the **surface itself**, not just the
silhouette — so it ships with the two-part surface-material contract glass
established (see the two-axis contract in [`DESIGN.md`](../DESIGN.md)). But its
identity is its own:

- **Glassmorphism** makes surfaces _translucent_ (frosted backdrop-blur over a
  static gradient).
- **Cybercore** lits surfaces with a _sharp neon ring_ over a dark tech grid.
- **Aurora** keeps surfaces opaque and moves the identity onto _drifting light +
  glow_.
- **Neumorphism** keeps surfaces **opaque and monochrome** and moves the identity
  onto **moulded depth**: the page canvas and every panel share **one** palette
  surface, and a **paired soft shadow** (a light highlight top-left + a dark
  shadow bottom-right) makes a card **swell out** of that field (raised) while a
  form field **sinks into** it (an inset well). The panel looks _moulded out of_
  the background, not placed on top of it.

It ships in two parts:

1. **The token block** — shape/feel tokens only (soft radii, soft _neutral_
   shadows for non-material elements, gentle motion, roomy density) plus
   palette-**agnostic** material _scalars_ (the extrusion distance + blur and the
   two shadow inks). No hue lives here, so it stays disjoint from the palette axis.
2. **The palette-derived material layer** — style-scoped rules
   (`[data-style='neumorphism'] body` and
   `[data-style='neumorphism'] [data-surface='…']`) that paint the monochrome
   field + the dual raised / inset shadows. The **surface fill and border** are
   palette-derived (`var(--el-surface)` + `color-mix(… var(--el-border) …)`); the
   two **shadow inks** are neutral (a white highlight + a near-black shade), the
   same shadow-ink treatment glass / aurora use — they are light, not a hue, so
   the axes stay disjoint.

A neumorphic mould needs a **constant** light/dark pairing — the highlight always
lighter than the surface, the shade always darker — in **both** themes. Deriving
the dark ink from a palette _text_ token would invert it in dark mode (the ink
goes light, and the mould collapses), so the inks stay neutral and a
`[data-style='neumorphism'][data-theme='dark']` block re-balances them (a fainter
highlight, a deeper shade) for dark surfaces.

Because the **surface** is palette-derived, the two axes still stay orthogonal:
pick a different palette and the moulded surface re-tones; pick a different style
and the palette's hues are untouched. **Colour is still the palette axis's job** —
Neumorphism only borrows the active palette's surface for its mould.

## Feel-bearing dimensions

| Dimension             | Neumorphism                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shape / silhouette    | Soft, generously rounded pebbles — 12px buttons/inputs, 18px cards, 22px modals. The rounding lets the paired shadow wrap a surface.                                                 |
| Border / stroke       | Borders nearly vanish — a faint hairline kept ONLY as the accessibility fallback; structure is read from the paired soft shadow, not an outline.                                     |
| Elevation philosophy  | The identity axis: a DUAL soft shadow (light highlight top-left + palette-derived dark bottom-right) extrudes surfaces OUT (raised); inputs invert it to an INSET well (pressed in). |
| Surface / background  | Monochrome + continuous: canvas and every panel share ONE opaque palette surface, so a card looks moulded out of the background. Opaque (text AA preserved).                         |
| Density rhythm        | Comfortable and roomy — 20×11 buttons, 26px card padding, 38px controls; the soft shadows need air to read as extruded.                                                              |
| Motion                | Gentle — 200ms ease and a soft press-scale; nothing snaps, matching the moulded surfaces.                                                                                            |
| Typography            | Inherits the base editorial pairing (Source Serif headlines + Inter body); the personality is in the moulded surfaces, not the type.                                                 |
| Component silhouettes | Raised, soft-shadowed cards / popovers / modals / sidebar (the `data-surface` material layer); concave inset inputs; pill status chips.                                              |

## Token overrides (`[data-style='neumorphism']`)

Shape/feel + palette-agnostic material scalars only — no colour token appears in
the block (the disjoint-axis acceptance criterion; enforced by
`tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** soft, rounded pebbles — `--radius-btn / -input: 12px`,
  `--radius-card: 18px`, `--radius-modal: 22px`, `--radius-control: 10px`.
  `--radius-badge` stays `9999px` (pill chips suit the soft register).
- **Elevation:** soft, diffuse **neutral** shadows (`--shadow-card`, `--shadow-modal`,
  …) for any non-`data-surface` elevated element (a tooltip, a bare dropdown). The
  rgba literals are neutral shadow ink, not a palette hue — the _moulded_ dual
  shadow lives in the material layer below.
- **Density:** roomy — `--spacing-btn-x/y: 20/11`, `--spacing-card-padding: 26px`,
  `--spacing-control-x/y: 12/7`, `--height-control: 38px`.
- **Motion:** `--transition-duration: 200ms` (`--transition-slow: 300ms`) and a
  soft `--active-scale: 0.98`.
- **Material scalars (palette-agnostic):** `--neu-distance: 6px` / `--neu-blur:
16px` (the raised paired-shadow offset + softness), `--neu-distance-sm: 3px` /
  `--neu-blur-sm: 8px` (the tighter inset-well shadow), and the two **neutral
  shadow inks** `--neu-light: rgba(255,255,255,0.6)` (the top-left raised
  highlight) + `--neu-shadow: rgba(20,20,30,0.16)` (the bottom-right dark shade).
  Both are neutral light/shade ink, not a hue (like glass's `--glass-rim`), so they
  live here. The `[data-style='neumorphism'][data-theme='dark']` block re-balances
  the pair for dark surfaces (`--neu-light: …0.05`, `--neu-shadow: rgba(0,0,0,0.44)`).

## The material layer (palette-derived)

The style-scoped rules below the token block are where the mould actually
happens. Every colour is derived from the active palette — never a raw hue:

- **The monochrome field** (`[data-style='neumorphism'] body`): the page canvas
  adopts `var(--el-surface)` — the SAME opaque palette surface the panels use — so
  panels look moulded out of one continuous material. This shared surface is the
  whole illusion.
- **Raised cards & popovers** (`[data-surface='card' | 'popover']`): opaque
  palette-derived `var(--el-surface)` + a faint kept hairline
  (`color-mix(… var(--el-border) …)`) + a `box-shadow` pairing the neutral
  `var(--neu-shadow)` dark shade bottom-right with the `var(--neu-light)` highlight
  top-left. The surface swells out; its colour re-tones with the palette.
- **Modals** (`[data-surface='modal']`): the same raised mould, offset +
  strength bumped a touch so the dialog separates from the field behind it.
- **Sidebar** (`[data-surface='sidebar']`): moulded from the same field, a
  horizontal paired shadow so the rail reads as part of the one surface.
- **Inputs** (`[data-surface='input']`): the **inverse** mould — the paired
  shadow flipped to `inset`, so the control sinks into the field as a **concave
  well** (the soft-UI input look).

Because the surfaces inside the `StyleVignette` preview already sit on a
`bg-(--el-surface)` root, the gallery swatch shows the mould correctly with no
separate `.sv-canvas` rule (unlike glass / aurora, whose canvas is a gradient
the swatch must repaint).

## Why this is more than a token swap

Neumorphism's identity lives in the axes a radius/shadow-token swap can't reach:

- **Surface + elevation fused** — the point is one continuous material out of
  which surfaces are moulded by a _paired_ light/dark shadow (and inverted to an
  inset well for inputs). A single Tier-0 `--shadow-*` can express neither the
  pairing nor the raised↔inset inversion nor the shared-field colour, which is why
  the material layer (and the `data-surface` hook) exists.
- **Colour is borrowed, not owned** — the moulded surface is the palette's own
  `--el-surface`, so it re-tones per palette while the neutral shadow ink (and the
  whole style) stays disjoint from hue.

## Accessibility

Neumorphism is the **accessibility-sensitive** style — the card flags it
"accessibility-hard (low contrast); gate carefully." Soft-UI's classic failures
are (a) borderless same-colour surfaces with no non-shadow structure, and (b)
text washed out on a low-contrast tint. Both are gated **by construction** here:

1. **Surfaces stay opaque at the palette's AA-tuned `--el-surface`.** Text sits
   on the exact colour the palette already tuned for AA — contrast is preserved by
   construction, not balanced against a tint or blur. Text continues to use the
   palette's `--el-text*` tokens, whose AA pairings are unchanged.
2. **A hairline border is KEPT, not removed.** Every moulded surface carries a
   faint `--el-border` hairline, so structure never depends on the soft shadow
   alone (the soft shadow is _additive_ depth, not the only boundary).
3. **The shadow never sits behind text.** Depth is a `box-shadow` outside the
   panel; body copy is on the opaque surface, never over the shadow.
4. **A high-contrast fallback restores hard structure.** Under
   `prefers-contrast: more` the moulded surfaces swap the faint hairline for a
   solid `--el-border-strong` and flatten the paired shadow to a single readable
   lift; under `forced-colors: active` the border becomes solid and the shadow is
   removed entirely (the OS owns contrast). Structure survives with the soft mould
   gone.

Verified in light and dark themes against the `/tokens` specimen with the
`--el-*` AA + design-mockup render checklist. (The
`[data-style='neumorphism'][data-theme='dark']` block re-balances the two inks for
dark surfaces — a faint white top-left lighten + a deeper black bottom-right shade
— so the constant light-above / dark-below mould holds in both themes.)

## Background: the Wave

The Wave (`@motir/design-system`, `wave` in the background registry) redraws per
style. Every style keeps the mark — the deep dip first and the crest later, the
lines gathering around the main content, the sliding band of the palette's wave
hues and the decision squares riding the lines — and changes only shape, stroke,
glow and motion. Under this style:

Shape: 9 soft grooves moulded into the page. Stroke: 4px in the page colour with a light highlight top-left and a soft shade bottom-right, one band line through the middle. Glow: none; decision squares are raised pebbles with a dual soft shadow. Motion: slow drift.

Every ink is a token read off the live theme; "accent" is
`--el-showcase-decision`. Under reduced motion it holds one still frame. The
drawing is `packages/design-system/src/backgrounds/wave.ts` (MOTIR-11606), built
to the approved design in `design/backgrounds/` (MOTIR-11602).
