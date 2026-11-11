# Palette — Amber (`data-palette="amber"`)

> Binance's **trading-floor gold** — the whole exchange palette. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='amber']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='amber']:not([data-theme])`
> and `[data-palette='amber'][data-theme='dark']`.

**Tagline:** Warm and electric — Binance trading-floor gold over the exchange's
graphite near-blacks; dark labels on the gold.
**Inspiration:** **Binance** — transcribed from its documented brand + product
system, not just the logo yellow. The warm **gold primary** (`#F0B90B`, brighter
`#FCD535` on dark) is what makes this a "warm" palette; the **neutrals are
Binance's own cool graphite** trading-floor blacks (`#0B0E11` / `#181A20` /
"Shark" `#1E2329` / `#2B3139`) and greys (`#EAECEF` / `#B7BDC6` / `#848E9C` /
`#5E6673` / `#474D57`), and the semantics are Binance's **buy-green `#0ECB81`** /
**sell-red `#F6465D`**. This is the "use the whole palette" directive: a warm
primary carried on the brand's real (here cool) neutral system. (Binance ships no
documented light theme, so the light surfaces are derived from its cool grey
family + the gold; **the dark theme is the authentic trading floor**.)

This is the COLOUR (palette) axis only — picking Amber never changes a radius
(that's the independent `data-style` axis). See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ The yellow-primary trap (why the accent-text is DARK)

A gold FILL **cannot carry white text at AA**. So the accent-text
(`--color-primary-foreground`, the label on the CTA) is **Binance's near-black
`#181A20`**, not `#fff` — which is Binance's own black-on-yellow treatment.
Dark-on-gold clears AA at ~9.6:1 (light) / ~13.6:1 (dark). `--color-primary` (the
gold used AS text/icon on a surface) is a darkened gold (`#7d6000`) chosen to
pass AA on the page **and on the palette's own pastel tints** — it was `#8a6a00`
until MOTIR-3774, which cleared the page by 5.07:1 and failed
`--el-tint-lavender` at 4.00:1.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` token references a Tier-0 `--color-*` source var, so Amber
re-skins by overriding the **`--color-*` source** (exactly how `[data-theme='dark']`
works) — surfaces, ink, accent, links, semantic, tints, type hues, charts all
follow with no per-token churn. Only `--el-sidebar-item-bg-hover` is overridden
directly (a concrete Tier-3 hex). The block sets **only colour tokens**
(`--color-*` / `--el-*`) — never a shape/feel token, the independent `data-style`
axis's job, enforced by `tests/theme/paletteRegistry.test.ts`.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Amber / Binance (light → dark)                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Text scale          | Binance cool-grey ink — `#181a20` → `#eaecef`; secondary `#4a5159` → `#b7bdc6`; signature grey `#848e9c`   |
| Accent (CTA)        | Binance Gold fill `#f0b90b` → `#fcd535` with **dark labels** `#181a20`; gold `#7d6000` → `#fcd535` as text |
| Surfaces            | white over cool graphite (light, derived) → the authentic trading floor `#0b0e11` / "Shark" `#1e2329`      |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#eaecf0` → `#07090c`                        |
| Borders             | cool graphite hairlines — `#e6e8eb` → `#2b3139`                                                            |
| Links               | clear blue, distinct from the gold — `#1366c4` → `#6fb3ff`                                                 |
| Semantic            | Binance buy-green `#0ECB81` + sell-red `#F6465D` (darkened for light AA) · warning amber · info blue       |
| Pastel tints        | gold-leaning warm washes + cool feature hues; `tint-peach` leans orange, not gold — see below              |
| Work-item type hues | re-skin via the `--color-*` they map to — story reads buy-green, bug reads sell-red, code/task read cool   |

### The pastel tints — why `peach` leans orange

Gilding every warm tint toward the Binance gold had collapsed **`tint-peach`
onto `tint-yellow`**: ΔE2000 **1.7** in dark and **4.3** in light, the two
most-used washes reading as one chip (MOTIR-2085). The ramp is the six
label-chip hues AND the six project-avatar hues (one ramp, two consumers), so a
duplicate means two different labels render identically.

`tint-yellow` keeps the gold — it is the palette's signature wash. `tint-peach`
moves to a clearly ORANGE warm wash instead: `#fbdfc0` light / `#331f10` dark.
Separation from `yellow` is now **ΔE 8.8** light / **11.2** dark. Binance ink on
the new wash stays **≥10:1**.

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. Notable margins:

- Primary ink on canvas — **17.4:1** (light) / **16.4:1** (dark).
- Secondary `--el-text-secondary` on surface — **7.4:1** / **8.4:1**.
- Captions `--el-text-muted` on surface — **5.3:1** / **5.1:1**.
- Gold `--el-accent-on-surface` — **5.9:1** (light) / **13.9:1** (dark), and
  **4.7:1** / **11.6:1** on `--el-tint-lavender`; **dark
  ink** on the gold `--el-accent` fill — **9.6:1** / **13.6:1** (the yellow trap).
- Link on the soft surface — **5.4:1** / **7.9:1**.
- White on the (darkened) sell-red danger fill (light) — **5.0:1**; dark ink on
  the bright sell-red (dark) — **5.5:1**.
- `--el-text-strong` on every pastel tint — **≥10.0:1** both themes.
