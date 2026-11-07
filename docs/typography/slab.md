# Type — Slab (`data-type="slab"`)

> A new-face pairing registered in
> [`packages/design-system/src/theme/typography.ts`](../../packages/design-system/src/theme/typography.ts);
> its `[data-type='slab']` block lives in
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css).
> It **adds one new face — Roboto Slab** — loaded via next/font in
> [`app/fonts.ts`](../../app/fonts.ts) (Story MOTIR-10548 · Subtask MOTIR-10555).

**Tagline:** Sturdy slab-serif headlines over a clean sans body — confident, print-like.
**Faces:** Roboto Slab headlines · Inter body · JetBrains Mono meta.

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Slab never
changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the three-axis
contract.

## Role mapping (the `--font-*` tokens)

| Role              | `--font-*` token | Slab face                              |
| ----------------- | ---------------- | -------------------------------------- |
| Headlines (xl+)   | `--font-serif`   | **Roboto Slab** (geometric slab serif) |
| Body / UI         | `--font-sans`    | Inter (the base sans — unchanged)      |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono (unchanged)             |

Only the headline (serif) role is re-pointed; body and mono keep the base roles.

**Display-only, by the whole-UI rule.** The `typography.ts` header re-points the
body/UI role only for a pairing whose signature face reads as a UI sans or mono
(Grotesk, Motir Mono, Mono-Technical, Rounded, Humanist). A serif display face
keeps the Inter body for legibility, as [Editorial](./editorial.md) does. A slab
serif is a serif, and its heavy rectangular serifs crowd dense UI text — table
cells, nav labels, form controls — at 12–14px. So Slab re-types headlines only.

## Why Roboto Slab

The reference typeface is **Rockwell** (Monotype, 1934), the classic geometric
slab serif of posters and newspaper mastheads. It is commercial and not served
by Google Fonts, so `next/font/google` cannot load it. **Roboto Slab** (Google
Fonts, Apache License 2.0, a variable font with weights 100–900) is the closest
freely served geometric slab, and its full weight range covers every weight the
heading styles ask for. It is loaded `display: 'swap'` and only pays its weight
once a user selects Slab. `Rockwell` stays in the chain as a local fallback for
a system that has it installed.

## Token mapping (the override block)

```css
[data-type='slab'] {
  --font-serif-pairing: var(--font-slab-source), 'Roboto Slab', Rockwell;
  --font-serif-tail: serif;
  --font-sans-pairing: var(--font-sans-source, 'Segoe UI'), 'Segoe UI', Roboto;
  --font-sans-tail: -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono-pairing: var(--font-mono-source, 'SF Mono'), 'SF Mono', Menlo;
  --font-mono-tail: monospace;
}
```

The headline role re-points to **`--font-slab-source`**, the variable
`app/fonts.ts` binds to the Roboto Slab next/font load (the type axis's
`-source` indirection, 7.3.53). The block is **total over the three roles**
(MOTIR-3933): the sans and mono chains are re-asserted at their base values.

The `-pairing` chain names its faces and **no generic keyword**; `serif` lives
in the `-tail`, so the FONT SETS rule in `theme.css` slots the page language's
serif script face (ja, ko, zh-Hans) between Roboto Slab and the tail.

The block sets **only** `--font-*` role tokens — never a colour or shape token.
That disjointness is enforced by
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Roboto Slab is used at headline sizes only (xl+), never for body copy, form
labels or hairline text on a tinted surface. Body copy stays Inter at the shared
`--font-size-*` scale, so reading sizes and weight contrast are unchanged from
the base pairing.

## For consumers (release and adopt)

A consumer that registers this pairing loads one face through its own
`next/font` call:

| next/font family (`next/font/google`)       | CSS variable         | Weights               |
| ------------------------------------------- | -------------------- | --------------------- |
| `Roboto_Slab` (Google family "Roboto Slab") | `--font-slab-source` | variable font 100–900 |

Without that load, `--font-slab-source` is undefined and the chain falls back to
a locally installed `'Roboto Slab'` or `Rockwell`, then the language's script
face, then the `serif` tail.
