# Palette — Cobalt (`data-palette="cobalt"`)

> A cool, calm, trustworthy **institutional-blue** re-skin. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='cobalt']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='cobalt']:not([data-theme])`
> and `[data-palette='cobalt'][data-theme='dark']`.

**Tagline:** Cool and institutional — slate-cool surfaces, a confident cobalt
primary, cooled tints.
**Inspiration:** Coinbase's clean institutional blue and IBM's structured blue
(getdesign.md), mapped onto Motir's `--el-*` roles; the actual light/dark ramps
and UI-state steps are drawn from **Radix Colors** (Blue / Indigo / Slate / Red /
Jade / Amber) — the accessibility-first 12-step scales designed for UI states.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Cobalt never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source
var. So — exactly like the `[data-theme='dark']` block — Cobalt re-skins by
overriding the **`--color-*` source**, and the whole `--el-*` layer (surfaces,
ink, accent, links, semantic, pastel tints, work-item type hues, charts) follows
coherently with no per-token churn. The only `--el-*` token overridden directly
is `--el-sidebar-item-bg-hover` — a concrete hex in Tier 3, not a `--color-*`
reference.

The block overrides **only colour tokens** (`--color-*` / `--el-*`) — never a
shape/feel token (`--radius-*` / `--spacing-*` / `--shadow-*` / `--height-*` /
`--transition-*`). That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices, and
`tests/theme/paletteRegistry.test.ts` enforces it.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Cobalt (light → dark)                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Text scale          | cool-slate ink hierarchy — navy ink `#0f1b2e` → `#e7edf6`; secondary `#46556b` → `#a0b1c6`                            |
| Accent (CTA)        | confident cobalt — on-surface `#3a57cf` → `#7e98f2`; fill `#3650c2` → `#4a63cf`; cool-cyan `--el-highlight`           |
| Surfaces            | white canvas over cool-slate sections — `#eef2f8` / `#f7f9fc` → navy `#0b111d` / `#131d2c` / `#0f1825`                |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#e3e9f2` → `#070c16`                                   |
| Borders             | cool slate hairlines — `#d8e0ea` → `#243245`                                                                          |
| Links               | cleaner sky-blue, distinct from primary — `#0d63b8` → `#6fb3ff`                                                       |
| Semantic            | danger `#d3322f`/`#d83847` · success `#18874c`/`#34c578` · warning `#c2410c`/`#f08a4b` · info `#0d63b8`               |
| Status ramp         | `--el-status-in-review` set directly — Radix Indigo 12 `#1f2d5c` (light) / rides `--color-primary` (dark) — see below |
| Priority ramp       | `--el-priority-high` set directly — Radix Amber 11 `#ab6400` (light) / rides `--color-warning` (dark) — see below     |
| Pastel tints        | cooled feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` (sky/lavender lead the cool set)            |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — code/research read cobalt, design/epic read cyan              |

### The status ramp — why `in_review` is set directly

`--el-status-in-progress` rides `--color-info` (Radix **Blue 11** `#0d63b8`) and
`--el-status-in-review` rides `--color-primary` (the **Indigo** accent `#3a57cf`)
— MOTIR-1273 gave each status its own Tier-0 source precisely so the two read
apart. Cobalt is an institutional-BLUE palette, though, so in light those two
sources land ΔE2000 **8.4** apart: different hexes, one dot (MOTIR-2075).

The identity choice is kept. The **status ramp takes its own deeper step of the
same indigo** rather than a new hue family: **Radix Indigo 12** `#1f2d5c`.
Separation from `in_progress` **ΔE 20.9**; contrast **11.8:1** on `--el-surface`
and **13.2:1** on `--el-card`, past the 3:1 icon/UI bar.

Dark needs no change (its two blues are already ΔE 10.4 apart) but **re-asserts
`var(--color-primary)` anyway**: a palette's light block and the base
`[data-theme='dark']` block tie on specificity, and the palette block comes later
in the sheet — so an unpaired light override would leak onto the dark canvas.
`tests/theme/statusHueSeparation.test.ts` enforces the pairing.

### The priority ramp — why `high` is set directly

The same shape one family over (MOTIR-2085). `--el-priority-highest` rides
`--color-destructive` (`#d3322f`) and `--el-priority-high` rides
`--color-warning` (`#c2410c`) — but Cobalt's warning is a **red-leaning burnt
orange**, so in light the two land ΔE2000 **9.9** apart: under the ΔE 10 bar a
coloured priority GLYPH needs (the bar calibrated for the status dot in
MOTIR-2073, and the reason a glyph family is held to a different floor than a
pale tint background).

Neither semantic moves — danger stays danger, warning stays warning. Instead the
**priority ramp takes its own step of a hue Cobalt already owns**: **Radix Amber
11** `#ab6400`, from the palette's documented Radix source set. Separation from
`highest` **ΔE 24.3**; contrast **4.6:1** on `--el-card` and **4.1:1** on
`--el-surface`, past the 3:1 icon/UI bar.

Dark needs no change (its `#d83847` / `#f08a4b` are already ΔE 25.8 apart) but
**re-asserts `var(--color-warning)`** for the same cascade reason as the status
override above. `tests/theme/familyHueSeparation.test.ts` enforces both the floor
and the pairing.

> **The floors moved after this card (MOTIR-2107).** The ΔE 10 quoted above is
> the bar for an UNDILUTED priority glyph, which is now the automation picker's
> direction icon. The `Pill` chip dilutes the same hue to a 14% wash and is
> measured separately on what it renders — where this pair was ΔE 3.8 before the
> amber step and 9.8 after. A palette tuning its priority ramp has to clear
> both; see `docs/palettes/spectrum.md` for the worked example.

## Accessibility

Every text-on-surface, white-on-fill, link, and chip-tint pairing clears **WCAG
AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed (the `--el-*` AA +
design-mockup render checklist). Notable margins:

- Primary ink on canvas — **17.3:1** (light) / **16.0:1** (dark).
- Secondary `--el-text-secondary` on surface — **6.7:1** / **7.7:1**.
- Captions `--el-text-muted` on the soft surface a hovered row paints —
  **5.2:1** / **7.0:1**.
- Cobalt `--el-accent-on-surface` on a surface — **5.4:1** / **6.2:1**; white on
  the `--el-accent` fill — **6.8:1** / **5.3:1**.
- Link on the soft (hovered) surface — **5.7:1** / **8.1:1**.
- White on the danger fill — **4.9:1** / **4.6:1**.
- `--el-text-strong` on every pastel tint — **≥10.9:1** both themes.
