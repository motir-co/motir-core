# Style — Retrofuturism (`data-style="retrofuturism"`)

> The chrome-and-sunset retro-future alternate. Shipped as the
> `[data-style='retrofuturism']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Chrome, gradient sweeps and a synthwave horizon — 70s/80s sci-fi.
**Inspiration:** Retrofuturism / Outrun — 70s–80s sci-fi: chrome lettering,
synthwave sunset gradients, airbrushed sci-fi paperbacks, wide geometric display
type.
**Wrong moods:** flat, brutalist, hand-drawn, paper-like, quiet/editorial.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis** — Retrofuturism inherits whatever palette is active and
changes no hue. The `[data-style]` block overrides ONLY shape/feel tokens; see
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**Dark-first.** Like Cybercore, this style is designed to be worn with a **dark**
palette — the neon horizon + grid read strongest on a near-black sky. It stays
usable on a light palette (a softer daytime-Outrun: pastel sky, pink horizon,
faint grid), but the hero is dark.

**Where the "chrome" and the "sunset" come from.** A style cannot set a colour,
so every hue is supplied by the active palette: the sky, the horizon glow, the
grid and the surface glow are all `color-mix()` over the `--el-*` accent roles,
so they re-tint with whatever palette is worn (the horizon glows blue under
Cobalt, green under Evergreen, and so on). What the style itself contributes is
the structure that makes the look _read_ regardless of hue:

- a **synthwave canvas** — a cool upper sky, a bright **horizon glow** band, and
  a **receding neon perspective GRID floor** (a fixed, perspective-tilted
  `body::after`, masked to fade into the horizon, sitting behind all content);
- **chrome surfaces** — a diagonal **specular streak** (a swept `white` light-bar)
  over a **metallic bevel** (a bright `white` top fading to a `black` base). The
  specular/bevel light and shade are the achromatic `white` / `black` keywords
  (pure lightness, no hue), so the chrome is palette-neutral metal while the
  horizon, grid and glow stay palette-derived.

The two axes stay disjoint, and the palette's AA contrast is preserved by
construction (surfaces stay opaque; the streak/bevel sit on `background-image`
over the tuned `background-color`, never under text; the grid sits behind content
at `z-index: -1`).

**How it differs from Cybercore / Y2K:** both are dark-first retro-tech with a
grid, but Cybercore **glows neon** (an outward `currentColor` halo on flat HUD
panels, mono headlines, hard sharp corners, a flat scanline grid). Retrofuturism
is **reflective chrome over a sunset** — specular-streaked bevelled metal panels,
streamlined capsule silhouettes, wide geometric display type, over a **receding
perspective grid** running to a bright horizon. Cybercore is the lit-HUD end;
Retrofuturism is the polished-chrome / Outrun end.

## Feel-bearing dimensions

| Dimension             | Retrofuturism                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shape / silhouette    | Streamlined chrome capsules — fully-rounded pill buttons + chips, 16px cards, 22px modals. Aerodynamic 70s/80s curves, never sharp.                                                                    |
| Border / stroke       | A lit chrome edge — a bright inset highlight + a dark base line over a faint hairline, a polished metal rim not a drawn border.                                                                        |
| Elevation philosophy  | Chrome bevels + a diagonal SPECULAR streak + a palette-derived glow — a bright top highlight fading to a dark base with a swept light-bar; surfaces read as polished reflective metal, not flat cards. |
| Surface / background  | A synthwave SKY + a bright HORIZON GLOW band + a receding neon perspective GRID floor (all palette-derived) behind chrome-bevelled, specular-streaked surfaces. Dark-first.                            |
| Density rhythm        | Confident and roomy — 22×11 chrome-capsule buttons, 24px card padding, 38px controls; the chrome wants room to catch the light.                                                                        |
| Motion                | Smooth and gliding — 200ms eased transitions and a confident press-scale; the synthwave horizon + grid are a STATIC backdrop (no motion to distract the work surface).                                 |
| Typography            | Wide geometric grotesque display (the `grotesk` type pairing) — the retro-futurist sci-fi headline read; body stays a legible sans.                                                                    |
| Component silhouettes | Chrome-capsule buttons with a metallic glint, specular-streaked bevelled cards / popovers / modals / sidebar / inputs (the data-surface material layer), pill chips.                                   |

## Token overrides (`[data-style='retrofuturism']`)

Only shape/feel tokens — no colour token appears in the bare block (the
disjoint-axis acceptance criterion; enforced by
`tests/theme/styleRegistry.test.ts`). The bevel/sheen and glow live in the
material layer below and take their colour from `color-mix()` / `var(--el-*)`
over the active palette (or the achromatic `white`/`black` keywords), never a
`--color-*` / `--el-*` token here and never a raw hue:

- **Radius (silhouette):** streamlined capsules — the generic scale rounds
  (`--radius-xs: 6px` → `--radius-xl: 22px`) and the semantic surfaces follow
  (`--radius-input: 12px`, `--radius-card: 16px`, `--radius-modal: 22px`), with
  **`--radius-btn` and `--radius-badge` set to `9999px`** so buttons and status
  chips read as chrome lozenges / pills. `--radius-pill` is left **untouched** so
  genuinely-circular affordances (avatars, status dots, the spinner) stay round.
- **Elevation:** the token block keeps a soft NEUTRAL lift only
  (`--shadow-subtle` → `--shadow-hero-mockup`, cool near-black `rgba` ink — not a
  hue). The specular streak, the metallic bevel, the inset chrome rim, and the
  palette-derived colour glow are added in the material layer (a token can't
  carry a multi-stop gradient or a hue).
- **Density:** confident and roomy — `--spacing-btn-x/y: 22/11`,
  `--spacing-card-padding: 24px`, `--spacing-control-x/y: 12/7`,
  `--height-control: 38px` — the chrome wants room to catch the light.
- **Motion:** `--transition-duration: 200ms` (`--transition-slow: 320ms`) with
  `--active-scale: 0.97` — smooth, gliding, a confident press (never snappy).
- **Material scalars** — palette-AGNOSTIC percentages consumed only by the
  material rules below: the synthwave `--retro-sky / -horizon / -ground` band
  strengths + the neon `--retro-grid` line alpha and `--retro-grid-size` cell
  (the Outrun floor), the chrome `--retro-spec` specular streak +
  `--retro-bevel-light / -shade` + `--retro-sheen`, and the
  `--retro-glow / -strong` palette glow.

### Surface material (the chrome + the synthwave canvas)

The "surface treatment" axis is carried by **style-scoped component rules** —
the schema's sanctioned "+ component-variant overrides" for a surface-material
style — rather than tokens (a token can't paint a gradient, a grid, or a canvas):

- **The sky** (`[data-style='retrofuturism'] body`) — a cool upper-sky wash, a
  bright **horizon glow** band ~62% down, and a warm ground wash rising from the
  bottom, all `color-mix()` over `--el-*` accent roles. Painted as the body's own
  background so it always sits behind content (the 3D/Immersive atmosphere
  approach).
- **The grid floor** (`[data-style='retrofuturism'] body::after`) — a receding
  neon **perspective grid** below the horizon: a fixed layer, `perspective()` +
  `rotateX()` tilted and masked to fade into the horizon, at `z-index: -1` so it
  textures the floor BEHIND all app content (never covering the UI). Lines are
  `color-mix()` over `--el-*` accents; the mask uses the achromatic `black`
  keyword. Static depth — not motion-gated.
- **Chrome surfaces** (`[data-surface='card' | 'popover']` + every panel via the
  global `.rounded-(--radius-card)` utility, and `[data-surface='modal']`) —
  opaque `var(--el-surface)` carrying a diagonal **specular streak** (a swept
  `white` light-bar) over a vertical **bevel** (`white` top → `black` base), plus
  the neutral lift, inset rim lines, and a palette-derived `--el-accent` /
  `--el-highlight` glow.
- **The sidebar rail** (`[data-surface='sidebar']`) — a quieter specular + bevel
  so the rail reads as part of the polished-metal family.
- **Text inputs** (`[data-surface='input']`) — a RECESSED chrome well: the bevel
  inverts (a dark lip at the top) + an inset shadow, so a TYPING field reads as
  stamped INTO the metal (the one control that sinks; everything you click is
  raised chrome, below).
  **Every button-SHAPED control reads as chrome**, not just the `Button` primitive.
  Buttons render in three shapes — the `Button` primitive (`<button data-variant>`),
  `<a>`/`<Link>` styled via `buttonVariants()` (no `data-variant`), and hand-rolled
  bordered `<button>`/`<a>` — so the rules key on the **utility classes** the design
  system emits (`.rounded-(--radius-btn)` + the fill / `.border` class), which are
  tag- and primitive-agnostic, rather than on `data-variant`. Two families:

- **Filled CTAs** (`.rounded-(--radius-btn).bg-(--el-accent)` and the danger
  `.bg-(--el-danger)`) — a chrome CAPSULE that KEEPS its hue: a diagonal specular
  glint over a vertical metallic sweep (lit top → the fill → shaded base), an inset
  highlight, and a palette glow, so the CTA (and a destructive button) looks
  machined. Keying on the fill class covers the primitive AND `buttonVariants()`
  links.
- **Neutral clickable controls** — every OTHER button-shape: bordered buttons +
  links (`.rounded-(--radius-btn).border` — secondary `Button`s, secondary anchors,
  the `/issues` filter bar's Filter / Advanced / Saved / Tree·List switcher, the
  "View all issues" links), the dropdown / select / picker triggers
  (`button.rounded-(--radius-input)`), and the SEGMENTED control (the board "Group
  by" switch & friends — a `[role='group']` track rendered as a RECESSED gunmetal
  well with the active `aria-pressed` segment raised out of it as a chrome chip).
  All get the same raised retro chrome as the CTA but in **GUNMETAL grey** — the
  surface DARKENED with the achromatic `black` keyword — rather than the accent
  fill, so every clickable control reads as machined chrome and the accent CTA
  stays the one coloured button. The base is darkened (not the bare
  `--el-surface`) on purpose: on a LIGHT palette the surface ≈ the page, so a
  white-highlight bevel over it is invisible (white-on-white, flat) — a mid-grey
  gives both the highlight and the shade something to read against, so the metal
  shows on light AND dark.

Deliberately left subtle (NOT chromed), to preserve hierarchy: `ghost` buttons,
small icon-only buttons / menu rows (`--radius-control`), the tiny header nav
buttons (`--radius-sm`), the `role='switch'` on/off toggle, and underline
`role='tab'` tabs — these are intentionally minimal, not button-shaped CTAs.

Every colour in these rules is `color-mix()` / `var(--el-*)` / the achromatic
`white`/`black` keywords — never a raw hex hue — so a palette swap re-tints the
sky, horizon, grid and glow while a style swap leaves hues untouched (enforced by
the "surface-material layer" test in `styleRegistry.test.ts`).

## Why this is more than a token swap

The feel-bearing axes a pure radius swap would miss are all moved here:

- **Surface** gains a whole synthwave scene — a sky, a bright horizon glow, and a
  receding neon perspective grid floor — AND a specular streak + metallic bevel on
  every panel. The canvas and the surfaces both carry the aesthetic, not just the
  corner radii.
- **Elevation** flips from "modest drop shadow" to **polished reflective metal** —
  a swept specular light-bar + a top-to-bottom bevel + a lit rim + a palette glow.
- **Typography** changes the headline _voice_ to a wide geometric grotesque (via
  the `grotesk` default type pairing) — the retro-futurist sci-fi display read.
- **Motion** glides (200ms eased) with a confident press; the scene itself is a
  static backdrop (no drift to distract the work surface).

Because every `motir-core` primitive consumes the semantic shape tokens and emits
the `data-surface` hook (`Card`/`Popover`/`Modal`/`Sidebar`/`Input`), and the
chrome also lands on every panel via the global `.rounded-(--radius-card)` utility
(the 3D/Immersive coverage approach), the token block + the material rules
re-shape and re-skin the entire UI without per-component edits.

## Accessibility

The style changes no colour token, so the active palette's AA contrast is
preserved by construction (text/background pairs are untouched). The additions
that _do_ paint pixels — the sky, horizon, grid, the chrome specular/bevel, the
glow — sit behind content (the grid at `z-index: -1`) or on surface edges, and
the surfaces stay opaque (the streak/bevel ride `background-image`
over the tuned `background-color`, so they never pull a surface far from its base
tone). The scene is static (no animation), so there is nothing to gate behind
`prefers-reduced-motion`. Verified across light + dark themes via the `/tokens`
specimen + the StyleVignette preview.

**The canvas is under text, so its washes are capped (MOTIR-10708).** The sky,
horizon and ground are a fixed backdrop: every heading, caption and empty state
that is not on a card scrolls across them. They first shipped at
`--retro-sky: 24%` / `--retro-horizon: 72%` / `--retro-ground: 26%`, and
`tests/theme/stylePaletteModeContrast.test.ts` measured the AA inks down to
1.01:1 on the horizon band (in the motir palette the accent is the ink colour, so
a 72% accent band is ink on ink). The ceiling across all 10 palettes × both modes
is 15% for the `--el-link` sky, 16% for the `--el-accent` bands and 17% for the
`--el-highlight` band, set by `--el-accent-on-surface` on the light grounds. The
style now ships **12% / 14% / 14%** (worst row 4.72:1, sienna light), so the
horizon is a tint rather than a stripe; the neon grid floor and the chrome carry
the Outrun read.

**The pill's bevel ends are capped by its label.** The plan-with-AI pill's label
is `--el-accent-text`, which each palette tunes against its bare accent (only
4.99:1 in amethyst dark). The bevel's crown and base therefore move the accent by
4% `white` and 7% `black` (from 18% / 16%), which keeps the worst end at 4.61:1.
