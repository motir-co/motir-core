# Type — Rounded (`data-type="rounded"`)

> A new-face pairing registered in
> [`packages/design-system/src/theme/typography.ts`](../../packages/design-system/src/theme/typography.ts);
> its `[data-type='rounded']` block lives in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css).
> It **adds one new face — Nunito** — loaded via next/font in
> [`app/fonts.ts`](../../app/fonts.ts) (Story MOTIR-10548 · Subtask MOTIR-10554).

**Tagline:** A soft rounded sans across the whole UI — friendly and approachable.
**Faces:** Nunito headlines + body/UI · JetBrains Mono meta.

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Rounded never
changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the three-axis
contract.

## Role mapping (the `--font-*` tokens)

| Role              | `--font-*` token | Rounded face                       |
| ----------------- | ---------------- | ---------------------------------- |
| Headlines (xl+)   | `--font-serif`   | **Nunito** (rounded-terminal sans) |
| Body / UI         | `--font-sans`    | **Nunito**                         |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono (unchanged)         |

**Whole-UI, by the whole-UI rule.** The `typography.ts` header says a pairing
whose signature face reads as a UI sans also re-points the body/UI role
(`--font-sans`), so the whole app — nav, header, buttons, content — re-types, as
[Grotesk](./grotesk.md) does. Nunito was drawn as a rounded-terminal sans for
running text and holds up at 12–14px in table cells, nav labels and form
controls, so it takes both roles. The display-only exception (Editorial, Marker,
Slab) is for faces that are unreadable as UI text, and Nunito is not one.

## Why Nunito

The reference typeface is **VAG Rounded**, the classic rounded grotesque. It is
commercial and not served by Google Fonts, so `next/font/google` cannot load it.
**Nunito** (Google Fonts, SIL Open Font License, a variable font with weights
200–1000) is the closest freely served rounded sans with a full UI weight range:
soft rounded terminals, even stroke, open counters. It is loaded
`display: 'swap'` and only pays its weight once a user selects Rounded.

## Token mapping (the override block)

```css
[data-type='rounded'] {
  --font-serif-pairing: var(--font-rounded-source), 'Nunito';
  --font-serif-tail: ui-sans-serif, system-ui, sans-serif;
  --font-sans-pairing: var(--font-rounded-source), 'Nunito';
  --font-sans-tail: ui-sans-serif, system-ui, sans-serif;
  --font-mono-pairing: var(--font-mono-source, 'SF Mono'), 'SF Mono', Menlo;
  --font-mono-tail: monospace;
}
```

Both the headline and body roles re-point to **`--font-rounded-source`**, the
variable `app/fonts.ts` binds to the Nunito next/font load (the type axis's
`-source` indirection, 7.3.53). The mono chain is re-asserted at its base value:
every block is total over the three roles (MOTIR-3933).

The `-pairing` chains name their faces and **no generic keyword**; the generics
live in the `-tail`s, so the FONT SETS rule in `theme.css` slots the page
language's script face (ja, ko, zh-Hans) between Nunito and the tail.

The block sets **only** `--font-*` role tokens — never a colour or shape token.
That disjointness is enforced by
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Nunito is a text face, so body copy stays readable at the shared
`--font-size-*` scale. Its x-height is a little smaller than Inter's, so small
captions read slightly lighter; the scale itself is unchanged.

## For consumers (release and adopt)

A consumer that registers this pairing loads one face through its own
`next/font` call:

| next/font family (`next/font/google`) | CSS variable            | Weights                |
| ------------------------------------- | ----------------------- | ---------------------- |
| `Nunito`                              | `--font-rounded-source` | variable font 200–1000 |

Without that load, `--font-rounded-source` is undefined and the chain falls back
to a locally installed `'Nunito'`, then the language's script face, then the
sans-serif tail.
