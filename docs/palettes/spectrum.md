# Palette — Spectrum (`data-palette="spectrum"`)

> A vibrant, playful, energetic **multi-accent** re-skin. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='spectrum']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='spectrum']:not([data-theme])`
> and `[data-palette='spectrum'][data-theme='dark']`.

![Spectrum palette specimen — light and dark](./spectrum.png)

**Tagline:** Vibrant and playful — crisp cool surfaces, a bright violet primary,
a candy-bright multi-hue accent & tint set.
**Inspiration:** Figma's vibrant multi-colour brand and Airtable's colourful,
friendly palette (getdesign.md), mapped onto Motir's `--el-*` roles; the actual
light/dark ramps and UI-state steps are drawn from **Radix Colors** (Violet /
Iris / Pink / Blue / Jade / Amber / Red) — the accessibility-first 12-step
scales designed for UI states.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Spectrum never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

Spectrum is **visibly distinct from Motir**, not just an accent-hue swap: the
surfaces move from warm cream to crisp cool-white (with a faint violet cast),
the muted Notion pastels become a saturated candy-bright rainbow, and a vivid
magenta-pink replaces the warm brand pink — a coordinated re-skin of surfaces,
ink, accent, semantic, and tints.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source
var. So — exactly like the `[data-theme='dark']` block — Spectrum re-skins by
overriding the **`--color-*` source**, and the whole `--el-*` layer (surfaces,
ink, accent, links, semantic, pastel tints, work-item type hues, charts) follows
coherently with no per-token churn. Two `--el-*` tokens are overridden directly:

- `--el-sidebar-item-bg-hover` — a concrete hex in Tier 3, not a `--color-*`
  reference, so there is no source to re-skin.
- `--el-priority-high` — where two chromatic **semantics** land too close for
  the priority CHIP to carry (MOTIR-2107). See _the priority ramp_ below.

### The priority ramp — why `high` is set directly

The same collision Cobalt (MOTIR-2085) and Graphite — now Motir — (MOTIR-2094) each shipped,
found in Spectrum only once the floor was measured on the surface a user
actually sees (MOTIR-2107). `--el-priority-highest` rides `--color-destructive`
(`#d92e2b` light / `#f0555f` dark) and `--el-priority-high` rides
`--color-warning` (`#ea580c` / `#fb8b4c`) — a red-leaning orange next to a
danger red.

Measured on the SOURCE hues the pair looked fine: ΔE2000 **14.5** light /
**21.5** dark, comfortably over the ΔE 10 glyph bar. But the only shipped
consumer of this ramp's chip, `Pill`'s `priority` variant, dilutes the hue to a
**14% wash over `--el-surface`**, and that compresses the ramp roughly 5–8x: the
chip a user sees rendered **ΔE 4.2** (light) / **4.8** (dark) — tighter than the
4.6 Graphite was fixed for. A source number is not a rendered number.

Neither semantic moves: danger stays danger, warning stays warning. The
**priority ramp takes its own step of a hue Spectrum already owns** — **Radix
Amber 11** `#ab6400` in light, from the palette's documented Radix source set,
and the brighter on-dark amber `#fbab4c` in dark. Separation from `highest`:
source ΔE **24.3** / **33.9**, rendered chip ΔE **8.6** / **8.1**; contrast
**4.6:1** card / **4.2:1** surface (light) and **9.8:1** / **9.0:1** (dark),
past the 3:1 icon/UI bar.

Unlike Cobalt and Graphite — whose dark hues were already far enough apart, so
their dark blocks only **re-assert `var(--color-warning)`** — Spectrum needed a
real step in **both** themes. Either way the token must appear in both blocks: a
light-only override keeps its LIGHT value on the dark canvas, where it was never
measured. `tests/theme/familyHueSeparation.test.ts` enforces the source floor,
the rendered-chip floor, and the pairing.

The block overrides **only colour tokens** (`--color-*` / `--el-*`) — never a
shape/feel token (`--radius-*` / `--spacing-*` / `--shadow-*` / `--height-*` /
`--transition-*`). That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices, and
`tests/theme/paletteRegistry.test.ts` enforces it.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Spectrum (light → dark)                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Text scale          | cool violet-neutral ink hierarchy — ink `#1a1626` → `#ece9f6`; secondary `#524d66` → `#aaa3c2`                       |
| Accent (CTA)        | bright violet — on-surface `#6440d6` → `#a78bfa`; fill `#5a37c9` → `#6d4fd6`; candy magenta-pink `--el-highlight`    |
| Surfaces            | crisp cool-white over violet-tinted sections — `#f4f2fb` / `#faf9fe` → violet-navy `#14111f` / `#1d1830` / `#181426` |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#ece8f7` → `#0f0c18`                                  |
| Borders             | cool violet hairlines — `#e6e2f3` → `#2b2440`                                                                        |
| Links               | clean vivid blue, distinct from the violet primary — `#2563eb` → `#8fb8ff`                                           |
| Semantic            | danger `#d92e2b`/`#f0555f` · success `#16a34a`/`#36c977` · warning `#ea580c`/`#fb8b4c` · info `#2563eb`              |
| Priority ramp       | `--el-priority-high` set directly — Radix Amber 11 `#ab6400` (light) / on-dark amber `#fbab4c` — see below           |
| Pastel tints        | candy-bright feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` (a saturated, well-separated set)    |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — code/research read violet/blue, design/epic read magenta     |

## Accessibility

Every text-on-surface, ink-on-fill, link, and chip-tint pairing clears **WCAG
AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed (the `--el-*` AA +
design-mockup render checklist). Notable margins:

- Primary ink on canvas — **17.7:1** (light) / **15.5:1** (dark).
- Secondary `--el-text-secondary` on surface — **~6.5:1** / **~7.0:1**.
- Captions `--el-text-muted` on the soft surface a hovered row paints —
  **~6.6:1** / **~7.1:1**.
- Violet `--el-accent-on-surface` on a surface — **6.5:1** / **6.5:1**; white on
  the `--el-accent` fill — **7.4:1** / **5.6:1**.
- Link on a page surface — **5.2:1** / **9.2:1**.
- Ink on the danger fill — white `#ffffff` **4.80:1** (light) / near-black
  `#14111f` **5.46:1** (dark). ⚠️ **The dark half was `#ffffff` at 3.40:1 until
  MOTIR-3664** — the only one of ten palettes × two themes under AA. Note what
  this bullet said while that was true: it gave the light fill pairing and then,
  in the slot where the dark one belonged, a **different** measurement — _danger
  reads AS text on the dark canvas, ~5.5:1_. Both numbers were correct and the
  claim above ("every ink-on-fill pairing clears AA in both themes") was
  therefore never actually made for the pairing that failed. A substituted
  measurement reads as a discharged one.
- Danger as a border/glyph hue (the 3:1 bar, and the reason the fix moved the INK
  rather than `--color-destructive`) — **3.99–4.80:1** light / **5.03–5.68:1**
  dark, across page / surface / soft surface / canvas. Unmoved by MOTIR-3664.
- `--el-text-strong` on every candy tint — **≥10.9:1** both themes.
