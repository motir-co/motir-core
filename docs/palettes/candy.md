# Palette — Candy (`data-palette="candy"`)

> A sweet, playful **light-pink** candy re-skin. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='candy']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='candy']:not([data-theme])`
> and `[data-palette='candy'][data-theme='dark']`.

**Tagline:** Sweet and playful — a light bubblegum-pink primary over candy-paper
pinks, with a full pastel-candy rainbow.
**Inspiration:** A **candy concept**, not a single brand — so to avoid inventing
colours, **every value is a documented [Radix Colors](https://www.radix-ui.com/colors)
step** (`@radix-ui/colors@3.0.0`): **Pink** is the primary ramp, **Mauve** the
matched warm neutral (Radix's pink-paired grey), and **Sky / Jade / Violet /
Amber / Crimson** supply the candy rainbow of tints + type hues. **Glossier Pink
`#F5DADF`** is cited as the pastel-pink _mood_ reference; the actual values are
Radix. This is the pink-led, pastel cousin of the vibrant `spectrum` palette.

This is the COLOUR (palette) axis only — picking Candy never changes a
radius (the independent `data-style` axis). See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ The light-pink trap (why the accent-text is DARK)

A light pink FILL **cannot carry white text at AA**. So the CTA is a light
bubblegum pink (`Pink-6 #efbfdd`) with **dark berry-plum labels** (`Pink-12
#651249`, ~7.6:1) — the same dark-on-light pattern Amber/Citrine use for gold.
`--color-primary` (the pink used AS text/icon on a surface) is Radix's AA "text"
step `Pink-11` — deepened by MOTIR-3774 to `#b72682`, Pink-11 mixed 88% toward
the Pink-12 berry ink already used as `--color-primary-foreground`, so it is
still derived from the Radix steps rather than an invented darkening. Pink-11
itself was 5.28:1 on the page and 4.29:1 on `--el-tint-lavender` (Violet-4),
which is the pairing the saved-filter count badge and the active sidebar row
use. Lifting the TINT to Violet-3 would have cleared AA and left the chip at
1.10:1 against the page — a tint that has become the page.

## How it re-skins (token mapping)

Candy re-skins by overriding the Tier-0 `--color-*` source the `--el-*`
layer references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

## Colour roles (the `--el-*` element-token layer)

| Role group          | Candy (light → dark) — all Radix steps                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Text scale          | Mauve ink `#211f26` + a Pink-12 berry emphasis `#651249` → Mauve-dark `#eeeef0` + Pink-dark-12 `#fdd1ea`             |
| Accent (CTA)        | light-pink fill `Pink-6 #efbfdd` → `Pink-dk-11 #ff8dcc` with **dark berry labels**; pink `#b72682` text              |
| Surfaces            | candy-paper pinks `Pink-1 #fffcfe` / `Pink-3 #fee9f5` → pink-tinted black `#191117` / `#37172f`                      |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `Pink-4 #fbdcef` → `#120c11`                           |
| Borders             | soft candy-pink hairlines `Pink-5 #f6cee7` → `Pink-dk-6 #692955`                                                     |
| Accent / links      | berry-plum highlight `Plum-9 #ab4aba`; Sky-11 candy-blue links `#00749e` → `#75c7f0`                                 |
| Semantic            | Radix candy text-steps — Grass success / Amber warning / Crimson danger / Sky info, brightened on dark               |
| Pastel tints        | the candy rainbow — `tint-{peach=Pink-4, rose=Crimson-4, mint=Jade-4, lavender=Violet-4, sky=Sky-4, yellow=Amber-4}` |
| Work-item type hues | re-skin via the `--color-*` they map to — a full pastel-candy rainbow (pink / berry / mint / blue / honey)           |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. All hues are documented Radix steps
(Radix's "text" step 11 for AA text roles, step 12 for dark labels). Notable
margins:

- Primary ink on canvas — **16.0:1** (light) / **16.0:1** (dark).
- Secondary `--el-text-secondary` on surface — **5.1:1** / **7.6:1**.
- Captions `--el-text-muted` on surface — **5.1:1** / **7.6:1**.
- Pink `--el-accent-on-surface` (Pink-11 → Pink-12, 88%) — **5.7:1** (light) /
  **9.7:1** (dark), and **4.7:1** / **7.0:1** on `--el-tint-lavender`;
  **dark berry ink** on the light-pink `--el-accent` fill — **7.6:1** / **8.5:1**
  (the light-pink trap).
- Candy-blue (Sky) link on the soft surface — **5.0:1** / **9.6:1**.
- White on the Crimson danger fill (light) — **5.4:1**; dark ink on the bright
  danger (dark) — **8.8:1**.
- `--el-text-strong` (berry) on every pastel tint — **≥9.2:1** both themes.
