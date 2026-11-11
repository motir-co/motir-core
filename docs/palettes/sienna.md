# Palette — Sienna (`data-palette="sienna"`)

> Mistral AI's **flame-orange** — the whole Mediterranean palette. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='sienna']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='sienna']:not([data-theme])`
> and `[data-palette='sienna'][data-theme='dark']`.

**Tagline:** Warm and vivid — Mistral flame-orange over the Mediterranean
warm-cream surfaces; dark labels on the flame.
**Inspiration:** **Mistral AI** — transcribed from its documented system
([getdesign.md/mistral.ai](https://getdesign.md/mistral.ai/design-md), corroborated
by oh-my-design.kr + Brandfetch), the whole palette not just the orange: the
**Mistral Orange `#fa520f`** + **Flame `#fb6424`** primary, the **Block gradient**
(yellow→amber→flame→orange), the **Sunshine** family (`#ff8a00`/`#ffa110`/`#ffb83e`),
**Block Gold `#ffe295`**, the **Mediterranean Warm-Ivory creams** (`#fffaeb` →
`#fff0c2`), and **Mistral-Black `#1f1f1f`** ink. Mistral ships **no semantic
colours**, so success/warning/danger/info are added warm-consistent + AA-safe.

This is the COLOUR (palette) axis only — picking Sienna never changes a radius.
See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ Dark ink on the flame, in both themes (the Mistral treatment)

Like Amber's gold, Mistral's bright flame FILL (`#fa520f` light / `#ff7a38` dark)
**cannot carry white at AA** (white-on-`#fa520f` is ~3.3:1). So Sienna follows
Mistral's own dark-on-orange treatment: `--color-primary-foreground` is a **dark
warm ink** (`#2a1205`) in **both** themes — dark-on-flame clears AA at ~5.3:1
(light) / ~6.8:1 (dark). `--color-primary` (the flame used AS text/icon) is a
darkened flame (`#b53b09` / `#ff8a4c`). Per Mistral, **links are the brand
orange** too (a darkened flame, AA-safe), not a cool blue.

## How it re-skins (token mapping)

Sienna re-skins by overriding the Tier-0 `--color-*` source the `--el-*` layer
references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

## Colour roles (the `--el-*` element-token layer)

| Role group          | Sienna / Mistral (light → dark)                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Text scale          | Mistral warm-charcoal ink — `#1f1f1f` → `#f5efe2`; secondary `#4a4a4a` → `#b3a892`                                                   |
| Accent (CTA)        | Mistral-orange fill `#fa520f` → `#ff7a38`, **dark ink labels** `#2a1205` both themes; flame `#b53b09` → `#ff8a4c` text               |
| Surfaces            | Mediterranean Warm-Ivory `#fffaeb` over cream `#fbf1d3` → warm-black `#15120d` / `#1f1d17`                                           |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#f5e9cb` → `#100d08`                                                  |
| Borders             | warm beige hairlines — `#ece0c4` → `#322c1d`                                                                                         |
| Links               | the brand orange (darkened flame) — `#b53b09` → `#ff9a5c`                                                                            |
| Semantic            | added warm-consistent (Mistral ships none) — success/warning/danger/info, AA-safe in both themes                                     |
| Status ramp         | `--el-status-blocked` set directly — the palette's amber accent `#b5660a` (light) / rides `--color-warning` (dark) — see below       |
| Pastel tints        | Mistral's golden washes (`tint-yellow` = Block Gold `#ffe295`) + warm feature hues; `tint-sky` is the palette's own teal — see below |
| Work-item type hues | re-skin via the `--color-*` they map to — review/warning read warm amber; the rest stay distinguishable                              |

### The status ramp — why `blocked` is set directly

Mistral ships **no semantic colours**, so this palette's `--color-warning` was
added warm-consistent (`#b45309`) — which lands it right next to the darkened
Mistral flame `--color-primary` `#b53b09`: the `blocked` / `in_review` pair
measures **ΔE2000 7.1** in light, amber against flame (MOTIR-2075).

Rather than move the brand flame, **`blocked` takes the palette's own amber
accent step** (`var(--color-accent)`, `#b5660a`) — it still reads as a warning
without being the primary. Separation **ΔE 14.2**; contrast **3.8:1** on
`--el-surface` and **4.1:1** on `--el-card`, past the 3:1 icon/UI bar.

Dark needs no change (its amber and flame are already ΔE 11.9 apart) but
**re-asserts `var(--color-warning)`**: a palette's light block and the base
`[data-theme='dark']` block tie on specificity, and the palette block comes later
in the sheet, so an unpaired light override would leak onto the dark canvas.
`tests/theme/statusHueSeparation.test.ts` enforces the pairing.

### The pastel tints — why `sky` is a teal, not another olive

Warming every cool tint is the right instinct for a Mediterranean palette, but
taken to six washes it had walked **two of them onto one colour**: `tint-sky`
and `tint-mint` measured ΔE2000 **1.3** in dark and **3.4** in light — the same
olive doing two jobs (MOTIR-2085). That ramp is not decoration: it is the six
label-chip hues AND the six project-avatar hues (one ramp, two consumers), so a
duplicate means two different labels render as the same chip.

`tint-sky` is now a muted wash of the palette's **own teal accent**
(`--color-accent-teal` `#0e8f86`) rather than a third olive — `#d9e8e4` light /
`#1b2622` dark. Still Mediterranean, just the sea rather than the hillside.
Separation from `mint` is now **ΔE 8.8** light / **5.9** dark, and the
selected-row vs drop-target pair (which draws from `sky` and `lavender`) improves
to **9.5** / **9.3**. Charcoal on the new wash stays **≥11:1**.

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. Notable margins:

- Primary ink on canvas — **15.8:1** (light) / **16.3:1** (dark).
- Secondary `--el-text-secondary` on surface — **7.9:1** / **7.2:1**.
- Captions `--el-text-muted` on surface — **5.7:1** / **6.3:1**.
- Flame `--el-accent-on-surface` — **5.6:1** / **9.0:1**, and **4.7:1** / **7.6:1**
  on `--el-tint-lavender` (MOTIR-3774 deepened the ink from `#c4400a`, which was
  4.13:1 there; sienna's lavender is a warm cream ΔE 4.2 from the ivory page, so
  the tint had no room to move and the ink did); **dark ink** on the
  Mistral-flame fill — **5.3:1** (light) / **6.8:1** (dark) (the yellow-trap
  treatment, same as Amber).
- Link (brand orange) on the soft surface — **4.8:1** / **8.5:1**.
- `--el-text-strong` on every pastel tint — **≥10.4:1** both themes.
