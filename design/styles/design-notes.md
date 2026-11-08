# Design notes — the style axis (`data-style`)

This area holds one mock per **style** — a whole-product shape and feel on the
`data-style` axis, not a single screen. A style's full design record (its id,
registry copy, dimension lines, every token value, the derived density steps, the
rail arithmetic and the hero AI-control treatment) lives in its
`docs/styles/<id>.md`, which `STYLE_REGISTRY[id].designDoc` points at and
`tests/theme/styleRegistry.test.ts` requires on disk. This file indexes the
mocks and states what each one draws and from which parts.

| style                      | mock                                                                       | design record                                                                            | card        |
| -------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| Dense / Pro                | [dense-pro.mock.html](./dense-pro.mock.html)                               | [docs/styles/dense-pro.md](../../docs/styles/dense-pro.md)                               | MOTIR-10658 |
| High-Contrast / Accessible | [high-contrast-accessible.mock.html](./high-contrast-accessible.mock.html) | [docs/styles/high-contrast-accessible.md](../../docs/styles/high-contrast-accessible.md) | MOTIR-10659 |
| Tonal / Elevated           | [tonal-elevated.mock.html](./tonal-elevated.mock.html)                     | [docs/styles/tonal-elevated.md](../../docs/styles/tonal-elevated.md)                     | MOTIR-10660 |
| Claymorphism               | [claymorphism.mock.html](./claymorphism.mock.html)                         | [docs/styles/claymorphism.md](../../docs/styles/claymorphism.md)                         | MOTIR-10661 |
| Bento                      | [bento.mock.html](./bento.mock.html)                                       | [docs/styles/bento.md](../../docs/styles/bento.md)                                       | MOTIR-10662 |

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
