# Design notes — the colour axis (`data-palette`)

**Design-system identification.** Files read: `package.json` (it depends on
`"@motir/design-system": "workspace:*"`), `app/globals.css` (line 13,
`@import '@motir/design-system/theme.css';`), `packages/design-system/package.json`
(version `0.21.4`) and `app/layout.tsx` (the root `<html>` carries the person's own
`data-style` / `data-palette` / `data-type`, from their appearance preference).
**Verdict: ON MOTIR DESIGN** — both checks hold. Every mock in this area is drawn
from the installed design system's own components and tokens.

This area holds one mock per **palette** — a whole-product colour scheme on the
`data-palette` axis, not a single screen. A palette's full design record (its id,
registry copy, every value and where it comes from, and its measured contrast)
lives in its `docs/palettes/<id>.md`, which `PALETTE_REGISTRY[id].designDoc` points
at and `tests/theme/paletteRegistry.test.ts` requires on disk. This file indexes the
mocks and states what each one draws and from which parts.

| palette | mock                                   | design record                                            | card        |
| ------- | -------------------------------------- | -------------------------------------------------------- | ----------- |
| Lagoon  | [lagoon.mock.html](./lagoon.mock.html) | [docs/palettes/lagoon.md](../../docs/palettes/lagoon.md) | MOTIR-10713 |
| Olive   | [olive.mock.html](./olive.mock.html)   | [docs/palettes/olive.md](../../docs/palettes/olive.md)   | MOTIR-10714 |

## How every mock in this area is built

Each mock is rendered with `renderMock` (`@motir/design-system/mock`) from the
**real shipped parts**, never a redrawn stand-in:

- **`PalettePicker`** (`packages/design-system/src/components/theme/AppearancePickers.tsx`)
  — the Appearance pane's palette gallery, with the new palette selected, so the
  mock shows the door a person picks it through and its swatch
  (`PALETTE_SWATCH_HEX`).
- **`StyleVignette`** (`packages/design-system/src/components/theme/StyleVignette.tsx`)
  — the live specimen the Appearance pane renders: a nav rail, a work-item card
  with `Pill` status chips, a floating panel with a `Button` pair, a search `Input`
  and a button row. It is rendered SCOPED (`styleId`, `palette`, `type`), so its
  wrapper carries `data-style`, `data-palette`, `data-type` and
  `data-appearance-scope`, and the palette applies to that subtree only.
- **A roles strip** — the shipped `Button` (primary and secondary) and `Pill`, then
  the roles the vignette does not reach, each painted with its own `--el-*` token
  inside the same scoped subtree: `--el-accent-on-surface` text, `--el-link`, the
  four semantic fills with their labels (`--el-success` / `--el-warning` /
  `--el-info` under `--el-text-inverted`, `--el-danger` under `--el-danger-text`),
  the six `--el-tint-*` under `--el-text-strong`, and `--el-text-secondary` on
  `--el-surface`, on `--el-canvas`, and on `--el-card` inside a
  `--el-border-strong` edge.

The palette's own block is shipped by the same commit: it lives in
`packages/design-system/theme.css`, and the mock carries the compiled design
system, so the scoped subtree resolves the real block.

Every mock has the same four panels:

1. **The door** — `PalettePicker` with the new palette selected, light and dark.
2. **Light and dark** — the vignette and the roles strip under the base style, in
   both modes.
3. **Beside its neighbours** — the vignette in the new palette next to the two
   registered palettes nearest it in hue, light.
4. **Under the material styles** — the vignette in the new palette under the
   styles that paint their own surface material (glassmorphism, claymorphism,
   tonal-elevated, memphis, dense-pro, neumorphism), light and dark.

**Colour roles.** The mocks add no colour of their own. Every element paints the
`--el-*` role its shipped part already uses, and the palette changes the Tier-0
`--color-*` sources those roles read. The panel captions are
`--el-text-secondary`, which clears AA on every surface.

**Shape roles.** Every surface reads the element-semantic shape tokens its part
already uses (`--radius-*`, `--spacing-*`, `--height-*`, `--shadow-*`). A palette
changes no shape token; the mock changes no class.

## Lagoon (MOTIR-10713)

[lagoon.mock.html](./lagoon.mock.html) · record:
[docs/palettes/lagoon.md](../../docs/palettes/lagoon.md)

What the panels show, against the record:

- **Panel 1** — Lagoon's tile in the gallery, its swatch the deep lagoon-cyan
  primary `#0f667c`, selected in light and dark.
- **Panel 2** — Cyan-1 page and Cyan-3 surfaces over Slate ink in light; the
  cyan-tinted deep-water dark in dark, with the bright Cyan-dark-11 fill carrying
  a dark label. The coral Tomato highlight and the Blue link sit apart from the
  primary.
- **Panel 3** — beside Cobalt and Evergreen: Lagoon's cyan reads between their
  blue and green (ΔE2000 18.7 and 26.2 between the accent fills in light).
- **Panel 4** — the six material styles keep Lagoon's hues; every text role on
  their composite grounds clears 4.5:1 (the style × palette × mode gate records
  no Lagoon failure).

## Olive (MOTIR-10714)

[olive.mock.html](./olive.mock.html) · record:
[docs/palettes/olive.md](../../docs/palettes/olive.md)

What the panels show, against the record:

- **Panel 1** — Olive's tile in the gallery after Lagoon, its swatch the moss primary
  `#4a5e26`, selected in light and dark.
- **Panel 2** — Olive-1 page and Olive-3 surfaces under Olive ink in light, with the moss
  fill carrying white labels; the warm olive-black in dark, with the bright Lime-dark-11
  fill carrying a dark label. The terracotta Orange highlight and the Blue link sit apart
  from the primary.
- **Panel 3** — beside Evergreen and Sienna: Olive's moss reads about 40° of hue toward
  yellow from Evergreen's emerald (ΔE2000 16.0 between the accent fills in light), and
  its green-grey neutrals read cooler than Sienna's browns.
- **Panel 4** — the six material styles keep Olive's hues; every text role on their
  composite grounds clears 4.5:1 (the style × palette × mode gate records no Olive
  failure).
