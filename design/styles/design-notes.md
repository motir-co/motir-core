# Design notes — the style axis (`data-style`)

This area holds one mock per **style** — a whole-product shape and feel on the
`data-style` axis, not a single screen. A style's full design record (its id,
registry copy, dimension lines, every token value, the derived density steps, the
rail arithmetic and the hero AI-control treatment) lives in its
`docs/styles/<id>.md`, which `STYLE_REGISTRY[id].designDoc` points at and
`tests/theme/styleRegistry.test.ts` requires on disk. This file indexes the
mocks and states what each one draws and from which parts.

| style                       | mock                                                                       | design record                                                                            | card        |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| Dense / Pro                 | [dense-pro.mock.html](./dense-pro.mock.html)                               | [docs/styles/dense-pro.md](../../docs/styles/dense-pro.md)                               | MOTIR-10658 |
| High-Contrast / Accessible  | [high-contrast-accessible.mock.html](./high-contrast-accessible.mock.html) | [docs/styles/high-contrast-accessible.md](../../docs/styles/high-contrast-accessible.md) | MOTIR-10659 |
| Tonal / Elevated            | [tonal-elevated.mock.html](./tonal-elevated.mock.html)                     | [docs/styles/tonal-elevated.md](../../docs/styles/tonal-elevated.md)                     | MOTIR-10660 |
| Claymorphism                | [claymorphism.mock.html](./claymorphism.mock.html)                         | [docs/styles/claymorphism.md](../../docs/styles/claymorphism.md)                         | MOTIR-10661 |
| Bento                       | [bento.mock.html](./bento.mock.html)                                       | [docs/styles/bento.md](../../docs/styles/bento.md)                                       | MOTIR-10662 |
| Editorial Print / Newspaper | [editorial-print.mock.html](./editorial-print.mock.html)                   | [docs/styles/editorial-print.md](../../docs/styles/editorial-print.md)                   | MOTIR-10663 |
| Art Deco                    | [art-deco.mock.html](./art-deco.mock.html)                                 | [docs/styles/art-deco.md](../../docs/styles/art-deco.md)                                 | MOTIR-10664 |
| Memphis                     | [memphis.mock.html](./memphis.mock.html)                                   | [docs/styles/memphis.md](../../docs/styles/memphis.md)                                   | MOTIR-10665 |

## How every mock in this area is built

Each mock is rendered with `renderMock` (`@motir/design-system/mock`) from the
**real shipped parts**, never a redrawn stand-in:

- **`StyleVignette`** (`packages/design-system/src/components/theme/StyleVignette.tsx`)
  — the live specimen the Appearance pane and the onboarding DesignStep already
  render for every style: a nav rail, a work-item card with `Pill` status chips, a
  floating `Modal`-style panel with a `Button` pair, a search `Input` and a button
  row. It is rendered SCOPED (`styleId`, `palette`, `type`), so its wrapper carries
  `data-style`, `data-palette`, `data-type` and `data-appearance-scope`, and the
  style's block applies to that subtree only.
- **`PlanWithAILauncher`** and **`PlanWithAIFab`** (`components/planning/`) — the
  hero AI pill and orb, inside a scoped subtree, so the style's
  `[data-surface='ai-cta']` rules reach them through the shipped seam variables.
  The orb is rendered `relative` instead of `fixed` so it sits in its panel (and its pulse ring stays on it).

The style's own block is **proposed**: the code card writes it into
`packages/design-system/theme.css`. The mock therefore carries it at the end of
its one `<style>`, after the compiled design system and unlayered — exactly where
the shipped block will sit — under a comment naming it as the proposal. It is
the same text as the CSS in the style's design record.

Every mock has the same four panels:

1. **The base beside the style** — Warm Editorial (motir palette, motir type)
   beside the new style (motir palette, the style's default type), light.
2. **The style keeps the palette** — three registered palettes, light.
3. **Dark** — the same three palettes under `data-theme="dark"`.
4. **The hero AI control** — the pill and the orb, base beside the style, light
   and dark, then the style under the other two palettes.

**Colour roles.** Nothing in this area adds a colour. Every element paints the
`--el-*` role its shipped part already uses — `--el-surface` / `--el-page-bg`
grounds, `--el-text` / `--el-text-secondary` inks, `--el-accent` /
`--el-accent-text` fills, `--el-border` rules, the `--el-type-*` hue on the
issue-type glyph — and a style's material, where it has one, is `color-mix()`
over those roles. The panel captions are `--el-text-secondary`, which clears AA
on every surface.

**Shape roles.** Every surface reads the element-semantic shape tokens its part
already uses (`--radius-btn` / `--radius-card` / `--radius-input` /
`--radius-badge` / `--radius-control`, `--spacing-btn-x`,
`--spacing-card-padding`, `--spacing-chip-x/y`, `--height-btn-*`,
`--height-input`, `--shadow-*`). The style changes their values; the mock
changes no class.

## Dense / Pro (MOTIR-10658)

[dense-pro.mock.html](./dense-pro.mock.html) · record:
[docs/styles/dense-pro.md](../../docs/styles/dense-pro.md)

What the panels show, against the record:

- **Panel 1** — the same vignette drawn tighter: 4px button and input corners,
  6px card, 3px rectangular status chips instead of pills, near-flat card
  shadow, 32px buttons, and Inter headlines (the `motir-sans` default) where the
  base sets Source Serif.
- **Panels 2–3** — motir, cobalt and evergreen in light and dark: every hue
  follows the palette and every shape stays the same.
- **Panel 4** — the pill becomes a compact 32px chip with a 3px corner, a flat
  accent-dominant fill (every stop at or above 92% accent), a hairline accent rim
  and a 1–2px whisper of shadow; the orb keeps its 56px circle and lit-sphere
  crown, flattened toward the page ground, with the same rim and shadow.

The proposed `[data-style='dense-pro']` block and its `@scope` hero rule are the
record's two CSS listings, verbatim.

## High-Contrast / Accessible (MOTIR-10659)

[high-contrast-accessible.mock.html](./high-contrast-accessible.mock.html) · record:
[docs/styles/high-contrast-accessible.md](../../docs/styles/high-contrast-accessible.md)

- **Panel 1** — the vignette with 44px controls and rows, 48px inputs, 2px
  hairlines, small 4–6px corners and no drop shadow anywhere; status chips are
  4px rectangles.
- **Panels 2–3** — every hue follows the palette; the 2px border and the
  44px floor hold in every palette and in dark.
- **Panel 4** — the pill and the orb wear a flat solid accent fill with no
  gradient, no shadow and no shimmer or pulse animation.

The proposed block and its one-rule `@scope` blocks are the record's CSS
listings, verbatim.

## Tonal / Elevated (MOTIR-10660)

[tonal-elevated.mock.html](./tonal-elevated.mock.html) · record:
[docs/styles/tonal-elevated.md](../../docs/styles/tonal-elevated.md)

- **Panel 1** — the card, sidebar and top bar on rung 1 (`--el-surface`), the
  floating panel two rungs up, the search input recessed onto the page ground
  with an inset seat; 10px buttons, 14px cards, 20px modal.
- **Panels 2–3** — the ladder re-tints with each palette, and in dark the rungs
  lighten instead of darken (the mix is toward `--el-text`).
- **Panel 4** — the pill and orb keep an accent-led fill with a rung-4 tonal rim
  and an accent-tinted seat shadow.
- **Noted for review** — a `Pill` whose fill is `--el-surface` loses its fill on
  a rung-1 card (the vignette's status chips); its ink stays legible. The record
  leaves the remedy to the build.

The proposed blocks and `@scope` rules are the record's CSS listings, verbatim.

## Claymorphism (MOTIR-10661)

[claymorphism.mock.html](./claymorphism.mock.html) · record:
[docs/styles/claymorphism.md](../../docs/styles/claymorphism.md)

- **Panel 1** — the vignette as inflated tiles: 26px cards, a 32px floating
  panel, 16px buttons and input, a light band along every tile's top inner edge
  and a shade band along its bottom, one soft drop beneath, and the search input
  pressed in (the pair inverted). Nunito, the `rounded` default, replaces Source
  Serif.
- **Panels 2–3** — every surface stays the palette's own; in dark the light band
  fades to a whisper and the shade deepens, so the inflation still reads.
- **Panel 4** — the pill and orb keep an accent-led fill (every stop at or above
  90% accent) and wear the same two bands plus an accent-tinted drop.
- **Noted for review** — at the narrow three-up width the `In progress` chip
  wraps, because the style's 12px chip padding is wider than the base's; it does
  not wrap at the full width in panel 1.

The proposed blocks and `@scope` rules are the record's CSS listings, verbatim.

## Bento (MOTIR-10662)

[bento.mock.html](./bento.mock.html) · record:
[docs/styles/bento.md](../../docs/styles/bento.md)

- **Panel 1** — the vignette as calm compartments: every tile (card, floating
  panel) at one 20px radius, 12px buttons and input, 10px rectangular chips, a
  near-flat whisper of shadow and the hairline kept; Inter headlines (the
  `motir-sans` default).
- **Panels 2–3** — Bento paints no colour of its own, so only the palette moves.
- **Panel 4** — the pill and the orb become flat accent plates: no gradient, no
  glow, no animation.
- The gutter widening (`--spacing-lg` / `--spacing-xl`) is a page-layout cadence
  and does not show in the vignette, which uses its own fixed gaps.

The proposed block and its three `@scope` hero rules are the record's CSS
listings, verbatim.

## Editorial Print / Newspaper (MOTIR-10663)

[editorial-print.mock.html](./editorial-print.mock.html) · record:
[docs/styles/editorial-print.md](../../docs/styles/editorial-print.md)

- **Panel 1** — the vignette as a printed page: zero radius on every surface,
  rectangular chips, no shadow anywhere, every framed surface ruled at 2px, the
  tighter print rhythm (36px buttons, 32px rows), Roboto Slab headlines (the
  `slab` default).
- **Panels 2–3** — the rules re-ink with each palette; light and dark change no
  geometry.
- **Panel 4** — the pill becomes a solid ink block with a reversed-out
  page-coloured label; the orb keeps its guarded lit crown with an ink rim; both
  carry a 2px frame and no shadow.

## Art Deco (MOTIR-10664)

[art-deco.mock.html](./art-deco.mock.html) · record:
[docs/styles/art-deco.md](../../docs/styles/art-deco.md)

- **Panel 1** — squared plates: the card wears the 5px double-rule band with a
  lit top-left and shaded bottom-right metal line and a three-step ziggurat in
  each corner; the floating panel (a modal) adds the entablature rule under its
  top edge and 12px steps on its bottom corners; the input carries one 2px rule;
  the rail's edge is an inset double rule. Grotesk headlines.
- **Panels 2–3** — the metal edge is the accent tinted into the border-strong
  role, so it re-tints with each palette and mode.
- **Panel 4** — the pill squares to 2px with a two-tone metal fill split at the
  115° light angle, the band and a hard ink line; the orb keeps its circle with
  an outer ring and a concentric inner ring.
- **Noted for review** — the vignette's cards use a tighter padding step than
  the default 24px, so the stepped corner reaches the first glyph's corner there.

## Memphis (MOTIR-10665)

[memphis.mock.html](./memphis.mock.html) · record:
[docs/styles/memphis.md](../../docs/styles/memphis.md)

- **Panel 1** — the dot-and-hatch canvas behind the vignette, 2px ink outlines,
  the collage corners (6px / 22px alternating), the two hard offset blocks (ink
  plus accent), the sharp 2px input beside the 10px buttons, Nunito type.
- **Panels 2–3** — the canvas and the accent block re-tint with each palette.
- **Noted for review** — in dark the near-black ink block nearly disappears and
  the accent block carries the pasted-on read; the outlines keep every edge.
- **Panel 4** — the pill keeps its accent-dominant fill with a 5px ink block; the
  orb keeps its guarded lit crown with a 4px ink block.
