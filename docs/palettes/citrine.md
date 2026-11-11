# Palette — Citrine (`data-palette="citrine"`)

> Miro's **Sunglow yellow** — the whole Mirotone palette. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='citrine']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='citrine']:not([data-theme])`
> and `[data-palette='citrine'][data-theme='dark']`.

**Tagline:** Bright and collaborative — Miro's Sunglow yellow over the whiteboard
greys, with the Miro action-blue accent.
**Inspiration:** **Miro** — transcribed verbatim from its **Mirotone** design
system (npm `mirotone@5.3.2`, the `--colors-{hue}-{step}` primitives) plus Miro's
brand sheet. **Every value in the block is a documented Mirotone step or Miro
brand token — nothing is invented or hand-darkened;** where a role needs a darker
shade for AA, a documented deeper ramp step is used (e.g. yellow-700 `#746019`
for on-surface gold text). Miro is a **5-hue system** (yellow / blue / green /
red / gray): the warm **Sunglow yellow `#FFD02F`** (`yellow-500`, the brand/logo
colour) is the primary, the **action-blue `#3859FF`** (`blue-500`) is the accent,
ink is **Stratos `#050038`**, and the semantics are `green-500 #1c8f00` /
`red-500 #d8182c`. The warm yellow primary makes this a "warm" palette; the
neutrals are Mirotone's own cool gray ramp.

This is the COLOUR (palette) axis only — picking Citrine never changes a radius
(the independent `data-style` axis). See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ The yellow-primary trap (why the accent-text is DARK)

A Sunglow FILL **cannot carry white text at AA**. So the accent-text
(`--color-primary-foreground`, the label on the CTA) is **Miro's Stratos ink
`#050038`**, not `#fff` — Miro's own dark-on-yellow treatment (dark-on-Sunglow
~13.5:1). `--color-primary` (the yellow used AS text/icon on a surface) is the
documented dark step `yellow-700 #746019` (AA ~6.1:1 on white), not an invented
darkening.

## How it re-skins (token mapping)

Citrine re-skins by overriding the Tier-0 `--color-*` source the `--el-*` layer
references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

Miro has no orange or teal primitive ramp, so the `--color-accent-orange` /
`-teal` type-hue roles map to documented Mirotone steps from the families Miro
does ship (a dark gold `yellow-650` and a deep `blue-650`) rather than to an
invented hue — keeping the palette a faithful Miro 5-hue system.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Citrine / Miro (light → dark) — all Mirotone steps                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Text scale          | Stratos ink `#050038` + Mirotone gray ramp — secondary `gray-600 #4a4e5e` → `gray-300 #c1c3cd`                                                 |
| Accent (CTA)        | Sunglow fill `#ffd02f` (`yellow-500`) with **dark Stratos labels** `#050038`; gold `#746019` → `#ffd02f` text                                  |
| Surfaces            | white over `gray-100 #f3f4f6` → Miro-black `#090909` / `gray-900 #1a1b1e`                                                                      |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `gray-150 #ebecf0` → `#040404`                                                   |
| Borders             | Mirotone gray hairlines — `gray-200 #e0e1e6` → `gray-750 #2b2e35`                                                                              |
| Accent / links      | Miro action-blue `#3859ff` (`blue-500`) → `blue-400 #7a90fe`                                                                                   |
| Semantic            | Mirotone `green-500 #1c8f00` / `red-500 #d8182c` ramps (brightened one step on dark) · warning gold                                            |
| Status ramp         | `--el-status-in-review` set directly — Mirotone blue-650 `#243797` → blue-200 `#d9dffc`; `--el-status-cancelled` → gray-600 `#4a4e5e` in light |
| Pastel tints        | Mirotone light ramp steps (`tint-yellow` = `yellow-150`, `tint-sky` = `blue-100`, `tint-mint` = `green-150`)                                   |
| Work-item type hues | re-skin via the `--color-*` they map to — Miro's 5-hue set (yellow / blue / green / red + the dark golds)                                      |

### The status ramp — why `in_review` and `cancelled` are set directly

Two collisions, both a consequence of transcribing Mirotone faithfully
(MOTIR-2075):

- **`blocked` vs `in_review`.** `--color-warning` is **yellow-650** `#91771e` and
  `--color-primary` is **yellow-700** `#746019` — _adjacent steps of one gold
  ramp_, **ΔE2000 9.7**. In dark it is far worse: `#ffd850` against `#ffd02f`,
  **ΔE 3.0**, two Sunglow golds one hex apart. Miro is a five-hue system with
  **no orange ramp** (see the block header), and the golds that clear AA on a
  light surface are exactly the two that collide — so the gold cannot separate
  itself. The status ramp therefore takes **Miro's other brand hue at its own
  depth**: the action blue, **blue-650** `#243797` in light and **blue-200**
  `#d9dffc` in dark (blue-650 sits at 1.7:1 on the near-black dark surface and
  would fail the icon bar). `in_progress` rides **blue-500** `#3859ff`, so this
  is one hue family at two depths — the Motir (ex-Graphite) idiom — **ΔE 17.0 / 18.4**
  apart. Contrast **9.2:1 / 13.1:1** on `--el-surface`. `blocked` stays on the
  warning gold, where its semantics belong.
- **`todo` vs `cancelled` (light).** **gray-450** `#7f8497` vs **gray-500**
  `#656b81`, **ΔE 10.0** — again one step apart on Mirotone's ramp. `cancelled`
  drops to **gray-600** `#4a4e5e` (**ΔE 20.6**, contrast 7.5:1). Dark needs no
  change and re-asserts `var(--color-steel)`.

Every value above is a documented Mirotone step — the palette's own rule that
nothing is invented or hand-darkened still holds. Each override is declared in
BOTH themes even where one needs no change, because an unpaired light override
leaks onto the dark canvas (the palette block and `[data-theme='dark']` tie on
specificity, palette wins by source order);
`tests/theme/statusHueSeparation.test.ts` enforces the pairing.

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. All hues are documented Mirotone steps;
where AA required a deeper shade, a documented step was chosen. Notable margins:

- Primary (Stratos) ink on canvas — **19.8:1** (light) / **18.6:1** (dark).
- Secondary `--el-text-secondary` on surface — **7.5:1** / **9.8:1**.
- Captions `--el-text-muted` on surface — **6.0:1** / **8.0:1**.
- Gold `--el-accent-on-surface` (`yellow-700`) — **6.1:1** (light); Sunglow as
  text on dark — **11.7:1**. **Dark Stratos ink** on the Sunglow `--el-accent`
  fill — **13.5:1** both themes (the yellow trap).
- Miro action-blue link on the soft surface — **4.9:1** / **6.1:1**.
- White on the red-500 danger fill (light) — **5.1:1**; dark ink on the bright
  `red-400` danger (dark) — **6.1:1**.
- `--el-text-strong` on every pastel tint — **≥11.8:1** both themes.
