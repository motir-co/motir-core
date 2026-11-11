# Palette — Garnet (`data-palette="garnet"`)

> Pinterest's **Pushpin red** — the whole brand palette. Registered in
> [`packages/design-system/src/theme/palettes.ts`](../../packages/design-system/src/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css) (which
> `app/globals.css` imports) as the `[data-palette='garnet']` light block plus a dark
> companion selected by both `[data-theme='dark'] [data-palette='garnet']:not([data-theme])`
> and `[data-palette='garnet'][data-theme='dark']`.

**Tagline:** Rich and bold — Pinterest Pushpin red over the brand's neutral
greys; white labels on the red.
**Inspiration:** **Pinterest** — transcribed from its documented brand + the
**Gestalt** design system, the whole palette not just the logo red: the **Pushpin
red `#E60023`** (deepened to `#c30021` for white-on AA) / darker `#BD081C`,
**Cod-Gray `#111111`** ink, neutral greys (`#767676` / `#EFEFEF`), and Gestalt's
**"Skycicle" blue** for links/info. The warm **red primary** is what makes this a
"warm" palette; Pinterest's neutrals are **true-neutral greys** (the
whole-palette directive — a warm primary on the brand's real neutral system). The
**danger** hue is kept a distinct orange-red so it never blurs into the red brand.

This is the COLOUR (palette) axis only — picking Garnet never changes a radius.
See [`DESIGN.md`](../DESIGN.md) §2.

## Accent-text — white on the red, in both themes

The deep Pushpin-red FILL (`#c30021`) carries **white** labels at AA in both
themes (~6.3:1). `--color-primary` (the red used AS text/icon on a surface) is the
same deep red in light (`#c30021`, AA ~6.3:1 on white) and a brightened red on
dark (`#ff5a76`, so it reads as text on the Cod-Gray canvas). Links use Gestalt's
Skycicle blue, distinct from the red.

## How it re-skins (token mapping)

Garnet re-skins by overriding the Tier-0 `--color-*` source the `--el-*` layer
references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

## Colour roles (the `--el-*` element-token layer)

| Role group          | Garnet / Pinterest (light → dark)                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Text scale          | Pinterest neutral-grey ink — Cod-Gray `#111111` → `#efefef`; secondary `#444444` → `#b5b5b5`; grey `#767676`       |
| Accent (CTA)        | deep Pushpin-red fill `#c30021` with **white labels** both themes; red `#c30021` → `#ff5a76` as text               |
| Surfaces            | white over neutral grey `#efefef` → Cod-Gray near-black `#0e0e0e` / `#1a1a1a`                                      |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#e7e7e7` → `#090909`                                |
| Borders             | neutral hairlines — `#e0e0e0` → `#2e2e2e`                                                                          |
| Links               | Gestalt "Skycicle" blue, distinct from the red — `#0a66c2` → `#5aa0ff`                                             |
| Semantic            | danger held distinct (orange-red `#e0300f`/`#ff6b6b`) from the red brand · success/warning/info                    |
| Status ramp         | `--el-status-cancelled` set directly — Pinterest grey `#444444` (light) / rides `--color-steel` (dark) — see below |
| Pastel tints        | a Pushpin-red rose wash (`tint-rose`) + clean feature hues                                                         |
| Work-item type hues | re-skin via the `--color-*` they map to — bug/deploy read warm red; design/epic read magenta-plum                  |

### The status ramp — why `cancelled` is set directly

Pinterest's neutrals are true-neutral greys, and its documented ramp puts
`--color-stone` `#767676` and `--color-steel` `#5f5f5f` close together: in light
the `todo` / `cancelled` pair lands at **ΔE2000 8.8**, where the base keeps it
~12 apart (MOTIR-2075). `cancelled` drops to Pinterest's next documented grey,
**`#444444`** — the palette's own `--color-slate`. Separation **ΔE 18.1**;
contrast **8.5:1** on `--el-surface`, **9.7:1** on `--el-card`.

Dark needs no change (its greys are already ΔE 11.6 apart) but **re-asserts
`var(--color-steel)`**: a palette's light block and the base
`[data-theme='dark']` block tie on specificity, and the palette block comes later
in the sheet, so an unpaired light override would leak onto the dark canvas.
`tests/theme/statusHueSeparation.test.ts` enforces the pairing.

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. Notable margins:

- Primary ink on canvas — **18.9:1** (light) / **16.8:1** (dark).
- Secondary `--el-text-secondary` on surface — **8.5:1** / **8.5:1**.
- Captions `--el-text-muted` on surface — **5.6:1** / **6.2:1**.
- Red `--el-accent-on-surface` — **6.3:1** (light) / **6.4:1** (dark); white on
  the Pushpin-red `--el-accent` fill — **6.3:1** both themes.
- Link (Skycicle blue) on the soft surface — **5.3:1** / **6.8:1**.
- White on the (orange-red) danger fill (light) — **4.6:1**; dark ink on the
  bright danger (dark) — **7.0:1**.
- `--el-text-strong` on every pastel tint — **≥11.3:1** both themes.
