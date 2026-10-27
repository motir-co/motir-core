# @motir/brand

## 0.4.10

### Patch Changes

- Updated dependencies [bc5db95]
  - @motir/design-system@0.18.0

## 0.4.9

### Patch Changes

- 4bc5737: `repository.url` (and `@motir/cli`'s `bugs.url`) now name `motir-co/motir-core`, the repository's home since the org move. npm refuses a provenance-signed publish whose `repository.url` names a different repository than the one in the provenance, so every CI publish since the move failed with E422 (MOTIR-9320). No code changes.
- Updated dependencies [4bc5737]
  - @motir/design-system@0.17.1

## 0.4.8

### Patch Changes

- Updated dependencies [8c7aacf]
  - @motir/design-system@0.17.0

## 0.4.7

### Patch Changes

- Updated dependencies [853486a]
  - @motir/design-system@0.16.0

## 0.4.6

### Patch Changes

- Updated dependencies [a26f8f7]
  - @motir/design-system@0.15.0

## 0.4.5

### Patch Changes

- Updated dependencies [3a60a61]
  - @motir/design-system@0.14.0

## 0.4.4

### Patch Changes

- Updated dependencies [72e67d2]
  - @motir/design-system@0.13.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @motir/design-system@0.12.0

## 0.4.2

### Patch Changes

- Updated dependencies [9597082]
  - @motir/design-system@0.11.0

## 0.4.1

### Patch Changes

- Updated dependencies [c406df6]
  - @motir/design-system@0.10.0

## 0.4.0

### Minor Changes

- d758ffa: The wordmark is set in Space Grotesk (`--font-grotesk-source`), the face motir.co's type defaults to, instead of Inter, a touch tighter (−0.03em) and larger (0.74 of the lockup size). It stays pinned to the face, so a user's Appearance type pairing never re-letters it, and it falls back to Inter where Space Grotesk is not loaded.

### Patch Changes

- Updated dependencies [d758ffa]
  - @motir/design-system@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [261f7d9]
  - @motir/design-system@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [31a6057]
  - @motir/design-system@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [0edb859]
  - @motir/design-system@0.6.0

## 0.3.0

### Minor Changes

- The brand colours follow the monochrome Motir palette (MOTIR-6474, `design/brand/design-notes.md` §10). Every carrier keeps the token it already named; under Motir the tile and the glyph-on-a-surface are no longer one colour.
  - `BRAND_ACCENT_HEX` (`--el-accent`, the tile / fill): `#5645d4` → `#1a1d21`
  - `BRAND_ACCENT_INK_HEX` (`--el-accent-text`): `#ffffff` → `#ffffff` (unchanged)
  - `BRAND_PAGE_BG_HEX` (`--el-page-bg`): `#ffffff` → `#ffffff` (unchanged)
  - **new** `BRAND_GLYPH_HEX` (`--el-accent-on-surface`, the bare glyph on a surface — email mark, OG cards): `#155bc4`
  - **new** `BRAND_ACCENT_DARK_HEX` (`--el-accent`, dark — the tab icon's `prefers-color-scheme: dark` tile): `#edeef0`
  - **new** `BRAND_ACCENT_INK_DARK_HEX` (`--el-accent-text`, dark): `#0c0d0f`
  - **new** `BRAND_LINK_HEX` (`--el-link` — email links, the Stripe accent): `#155bc4`
- A consumer drawing the glyph on a page (not in a tile) must move from `BRAND_ACCENT_HEX` to `BRAND_GLYPH_HEX`, or it paints the mark ink instead of blue.

## 0.2.4

### Patch Changes

- Updated dependencies [01294f1]
  - @motir/design-system@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [686a872]
  - @motir/design-system@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [570ecd1]
  - @motir/design-system@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [1491e94]
  - @motir/design-system@0.2.0
