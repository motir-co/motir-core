# Type — Marker (`data-type="marker"`)

> A new-face pairing registered in
> [`packages/design-system/src/theme/typography.ts`](../../packages/design-system/src/theme/typography.ts);
> its `[data-type='marker']` block lives in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css).
> It **adds one new face — Caveat** — loaded via next/font in
> [`app/fonts.ts`](../../app/fonts.ts). It is the default pairing of the
> [Hand-Drawn / Indie](../styles/hand-drawn-indie.md) style (Story MOTIR-10548 ·
> Subtask MOTIR-10553).

**Tagline:** Hand-lettered marker headlines over a clean sans body — sketchy, friendly, human.
**Faces:** Caveat marker headlines · Inter body · JetBrains Mono meta.

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Marker never
changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the three-axis
contract.

## Role mapping (the `--font-*` tokens)

| Role              | `--font-*` token | Marker face                                   |
| ----------------- | ---------------- | --------------------------------------------- |
| Headlines (xl+)   | `--font-serif`   | **Caveat** (casual hand-lettered marker hand) |
| Body / UI         | `--font-sans`    | Inter (the base sans — unchanged)             |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono (unchanged)                    |

Only the headline (serif) role is re-pointed; body and mono keep the base roles.

**Display-only, by the legibility rule.** The whole-UI rule in the
`typography.ts` header re-points the body/UI role only for a pairing whose
signature face reads as a UI sans or mono. A marker hand does not: at 12–14px in
table cells, nav labels and form controls it is unreadable. So, like
[Editorial](./editorial.md), Marker re-types headlines only and keeps the Inter
body.

## Why Caveat

The reference is **Excalidraw's hand-drawn typeface** — Virgil, now succeeded by
Excalifont — the lettering of the sketch tool the Hand-Drawn / Indie style
already names as its inspiration. Neither is served by Google Fonts, so
`next/font/google` cannot load them. **Caveat** (Google Fonts, SIL Open Font
License, a variable font with weights 400–700) is the closest freely served
marker hand: a casual, slightly uneven pen letter rather than a connected
script, so a headline stays readable at display sizes. It is loaded
`display: 'swap'` and only pays its weight once a user selects Marker, or picks
Hand-Drawn / Indie without pinning another type.

## Token mapping (the override block)

```css
[data-type='marker'] {
  --font-serif-pairing: var(--font-marker-source), 'Caveat';
  --font-serif-tail: cursive;
  --font-sans-pairing: var(--font-sans-source, 'Segoe UI'), 'Segoe UI', Roboto;
  --font-sans-tail: -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono-pairing: var(--font-mono-source, 'SF Mono'), 'SF Mono', Menlo;
  --font-mono-tail: monospace;
}
```

The headline role re-points to **`--font-marker-source`**, the variable
`app/fonts.ts` binds to the Caveat next/font load (the type axis's `-source`
indirection, 7.3.53). The block is **total over the three roles** (MOTIR-3933):
the sans and mono chains are re-asserted at their base values, so the pairing
renders the same in a nested scope as on `<html>`.

The `-pairing` chain names its faces and **no generic keyword**. The generic
(`cursive`) lives in the `-tail`, so the FONT SETS rule in `theme.css` can slot
the page language's script face (ja, ko, zh-Hans) between Caveat and the tail:
on a Japanese page Latin letters render in Caveat and kana and kanji in the ja
set's serif face.

The block sets **only** `--font-*` role tokens — never a colour `--el-*` /
`--color-*` or shape `--radius-*` / `--spacing-*` / `--shadow-*` token. That
disjointness is enforced by
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Caveat is used at headline sizes only (xl+), never for body copy, form labels or
hairline text on a tinted surface. Body copy stays Inter at the shared
`--font-size-*` scale, so reading sizes and weight contrast are unchanged from
the base pairing.

## For consumers (release and adopt)

A consumer that registers this pairing loads one face through its own
`next/font` call:

| next/font family (`next/font/google`) | CSS variable           | Weights               |
| ------------------------------------- | ---------------------- | --------------------- |
| `Caveat`                              | `--font-marker-source` | variable font 400–700 |

Without that load, `--font-marker-source` is undefined and the chain falls back
to a locally installed `'Caveat'`, then the language's script face, then the
`cursive` tail.
