# Type — Humanist (`data-type="humanist"`)

> A new-face pairing registered in
> [`packages/design-system/src/theme/typography.ts`](../../packages/design-system/src/theme/typography.ts);
> its `[data-type='humanist']` block lives in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css).
> It **adds one new face — Fira Sans** — loaded via next/font in
> [`app/fonts.ts`](../../app/fonts.ts) (Story MOTIR-10548 · Subtask MOTIR-10556).

**Tagline:** A warm humanist sans across the whole UI — open and readable.
**Faces:** Fira Sans headlines + body/UI · JetBrains Mono meta.

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Humanist
never changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the
three-axis contract.

## Role mapping (the `--font-*` tokens)

| Role              | `--font-*` token | Humanist face                    |
| ----------------- | ---------------- | -------------------------------- |
| Headlines (xl+)   | `--font-serif`   | **Fira Sans** (humanist UI sans) |
| Body / UI         | `--font-sans`    | **Fira Sans**                    |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono (unchanged)       |

A humanist sans is drawn with calligraphic stroke contrast and open apertures,
so it reads friendly but still professional — between the geometric
[Grotesk](./grotesk.md) and the soft [Rounded](./rounded.md).

**Whole-UI, by the whole-UI rule.** The `typography.ts` header says a pairing
whose signature face reads as a UI sans also re-points the body/UI role
(`--font-sans`), so the whole app — nav, header, buttons, content — re-types, as
Grotesk does. Fira Sans was designed as a screen UI face and holds up at 12–14px,
so it takes both roles. The display-only exception (Editorial, Marker, Slab) is
for faces that are unreadable as UI text.

## Why Fira Sans

The reference typeface is **FF Meta** (Erik Spiekermann, 1985), the classic
humanist UI sans. It is commercial and not served by Google Fonts, so
`next/font/google` cannot load it. **Fira Sans** (Google Fonts, SIL Open Font
License, static weights 100–900) was designed by Spiekermann's studio with
Carrois for Mozilla's Firefox OS and is directly based on FF Meta, so it is the
closest freely served humanist sans. It is loaded `display: 'swap'` and only pays
its weight once a user selects Humanist.

## Token mapping (the override block)

```css
[data-type='humanist'] {
  --font-serif-pairing: var(--font-humanist-source), 'Fira Sans';
  --font-serif-tail: ui-sans-serif, system-ui, sans-serif;
  --font-sans-pairing: var(--font-humanist-source), 'Fira Sans';
  --font-sans-tail: ui-sans-serif, system-ui, sans-serif;
  --font-mono-pairing: var(--font-mono-source, 'SF Mono'), 'SF Mono', Menlo;
  --font-mono-tail: monospace;
}
```

Both the headline and body roles re-point to **`--font-humanist-source`**, the
variable `app/fonts.ts` binds to the Fira Sans next/font load (the type axis's
`-source` indirection, 7.3.53). The mono chain is re-asserted at its base value:
every block is total over the three roles (MOTIR-3933).

The `-pairing` chains name their faces and **no generic keyword**; the generics
live in the `-tail`s, so the FONT SETS rule in `theme.css` slots the page
language's script face (ja, ko, zh-Hans) between Fira Sans and the tail.

The block sets **only** `--font-*` role tokens — never a colour or shape token.
That disjointness is enforced by
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Fira Sans is a text face with a generous x-height and open apertures, so body
copy stays readable at the shared `--font-size-*` scale.

## For consumers (release and adopt)

A consumer that registers this pairing loads one face through its own
`next/font` call. Fira Sans is a static family, so the weights are listed:

| next/font family (`next/font/google`)   | CSS variable             | Weights                    |
| --------------------------------------- | ------------------------ | -------------------------- |
| `Fira_Sans` (Google family "Fira Sans") | `--font-humanist-source` | `400`, `500`, `600`, `700` |

Without that load, `--font-humanist-source` is undefined and the chain falls
back to a locally installed `'Fira Sans'`, then the language's script face, then
the sans-serif tail.
